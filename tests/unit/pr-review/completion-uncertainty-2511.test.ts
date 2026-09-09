/**
 * Issue #2511 — PR-review completion coverage vs delegation-read uncertainty.
 *
 * Three surfaces are pinned here:
 *
 * 1. `derivePrReviewDimensionSettlement` over an uncertain batch store. With
 *    the production gate helpers bound (this file imports the gate module,
 *    whose init performs the binding), the composed path fails closed: the
 *    bound `recordsPassingBatchIntegrity` guard throws its BLOCKED
 *    unreadable error before any settlement is produced, so an unreadable
 *    store can never admit a NOT_LAUNCHED/NO_COVERAGE terminal. The healthy
 *    control proves a readable store keeps the pre-#2511 behavior: the
 *    dispatched-but-pending dimension rides `liveDimensions` and is never
 *    labeled NOT_LAUNCHED, and no `delegationReadUncertain` is carried.
 *
 * 2. `findDelegationForCompletion` (pending-delegations): the typed lookup an
 *    uncertain store returns is `source: 'uncertain'` with the bounded
 *    `uncertain` reason string — never a null that reads as "no owner".
 *
 * 3. The completion observer's #2511 defer branch: an uncertain store leaves
 *    the terminal ingestion deferred (bounded warn, record untouched), so the
 *    source record stays pending and visible for the next healthy event.
 *
 * Fixture note: records are written raw. `recordPendingDelegation` creates
 * the SQLite coordination authority, which then masks the torn legacy
 * manifest that produces the uncertain read.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import '../../../src/hooks/pr-workflow-gate.js';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer.js';
import {
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	findByCorrelationIdDetailed,
	findDelegationForCompletion,
} from '../../../src/background/pending-delegations.js';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import { derivePrReviewDimensionSettlement } from '../../../src/pr-review/completion.js';
import * as logger from '../../../src/utils/logger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';
import { freezeClock } from '../../helpers/test-clock.js';

const SESSION_ID = 'sess_controller';
const CORRELATION_ID = 'ses_open_lane';
const BATCH_ID = 'batch-1';
const LANE_ID = 'lane-1';
const [DISPATCHED_DIMENSION] = PR_REVIEW_BASE_DIMENSION_IDS;

interface StoreFixture {
	dir: string;
	cleanup: () => void;
}

function createStore(tornManifest: boolean): StoreFixture {
	const safe = createSafeTestDir('pr-review-completion-uncertain-');
	fs.mkdirSync(path.join(safe.dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(safe.dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		`${JSON.stringify({
			schemaVersion: 1,
			correlationId: CORRELATION_ID,
			jobId: null,
			subagentSessionId: CORRELATION_ID,
			parentSessionId: SESSION_ID,
			callID: 'call_open_lane',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			status: 'pending',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			batchId: BATCH_ID,
			laneId: LANE_ID,
			mode: 'swarm-pr-review:base',
			workflowLane: DISPATCHED_DIMENSION,
			promptHash: 'x'.repeat(24),
		})}\n`,
		'utf-8',
	);
	if (tornManifest) {
		fs.writeFileSync(
			path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			'{"schemaVersion": 1, "sequence": ',
			'utf-8',
		);
	}
	return safe;
}

/** Minimal completion-state slice naming the dispatched base batch. */
function completionState(dir: string) {
	return {
		schemaVersion: 1,
		revision: 1,
		sessionID: SESSION_ID,
		mode: 'PR_REVIEW',
		prHeadSha: 'abc123',
		prReviewBaseDispatches: [
			{
				batchId: BATCH_ID,
				lanes: [{ laneId: LANE_ID, workflowLane: DISPATCHED_DIMENSION }],
				validatedAt: '2026-01-01T00:00:00.000Z',
			},
		],
		// Structural context the gate normally supplies.
		workspace: { directory: dir },
	};
}

describe('PR-review completion — delegation-read uncertainty (issue #2511)', () => {
	let store: StoreFixture;

	let restoreClock: (() => void) | null = null;

	beforeEach(() => {
		// Shared frozen instant: fixture timestamps and any staleness reads in
		// the modules under test must agree for the fresh-lane semantics.
		restoreClock = freezeClock({ fixedNow: Date.now() });
		store = createStore(true);
	});

	afterEach(() => {
		mock.restore();
		store.cleanup();
		restoreClock?.();
	});

	test('an uncertain batch store fails settlement closed instead of deriving NOT_LAUNCHED labels', () => {
		expect(() =>
			derivePrReviewDimensionSettlement(
				store.dir,
				completionState(store.dir),
				'revision-1',
			),
		).toThrow(/delegation store is unreadable/i);
	});

	test('healthy control: no delegationReadUncertain, dispatched dimension is live and never NOT_LAUNCHED', () => {
		const healthy = createStore(false);
		try {
			const settlement = derivePrReviewDimensionSettlement(
				healthy.dir,
				completionState(healthy.dir),
				'revision-1',
			);
			expect(settlement.delegationReadUncertain).toBeUndefined();
			// The dispatched-but-pending lane blocks settlement as a live
			// dimension (pre-#2511 semantics for a readable store).
			expect(settlement.liveDimensions).toEqual([DISPATCHED_DIMENSION]);
			const dispatchedEntry = settlement.unresolvedDimensions.find(
				(entry) => entry.dimension === DISPATCHED_DIMENSION,
			);
			expect(dispatchedEntry).toBeUndefined();
			// Undispatched dimensions keep their unchanged NOT_LAUNCHED labels.
			const notLaunched = settlement.unresolvedDimensions.filter(
				(entry) => entry.terminalState === 'NOT_LAUNCHED',
			);
			expect(notLaunched.map((entry) => entry.dimension).sort()).toEqual(
				PR_REVIEW_BASE_DIMENSION_IDS.filter(
					(dimension) => dimension !== DISPATCHED_DIMENSION,
				).sort(),
			);
		} finally {
			healthy.cleanup();
		}
	});

	test('findDelegationForCompletion returns the typed uncertain result, never a null "no owner"', async () => {
		const lookup = await findDelegationForCompletion(store.dir, CORRELATION_ID);
		expect(lookup).not.toBeNull();
		expect(lookup?.source).toBe('uncertain');
		expect(lookup?.record).toBeNull();
		expect(lookup?.uncertain).toMatch(/unreadable after 2 attempts/);
	});

	test('findDelegationForCompletion healthy control resolves the primary owner', async () => {
		const healthy = createStore(false);
		try {
			const lookup = await findDelegationForCompletion(
				healthy.dir,
				CORRELATION_ID,
			);
			expect(lookup?.source).toBe('primary');
			expect(lookup?.record?.correlationId).toBe(CORRELATION_ID);
		} finally {
			healthy.cleanup();
		}
	});

	test('completion observer defers terminal ingestion on an uncertain store and leaves the record pending', async () => {
		const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
		const observer = createBackgroundCompletionObserver(
			// The observer is disabled unless the background config enables it.
			{ config: { enabled: true }, directory: store.dir },
		);
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: SESSION_ID,
						text: `<task id="${CORRELATION_ID}" state="completed">\n<task_result>reviewer finished</task_result>\n</task>`,
					},
				},
			},
		});
		expect(
			warnSpy.mock.calls.some((call) =>
				String(call[0]).includes('deferring terminal ingestion'),
			),
		).toBe(true);

		// Heal the store: the deferred observation must have left the source
		// record untouched (still pending, no ingestion state recorded).
		fs.rmSync(
			path.join(store.dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
		);
		const healed = findByCorrelationIdDetailed(store.dir, CORRELATION_ID);
		expect(healed.status).toBe('ok');
		if (healed.status === 'ok') {
			expect(healed.value?.status).toBe('pending');
			expect(healed.value?.ingestion).toBeUndefined();
		}
	});
});

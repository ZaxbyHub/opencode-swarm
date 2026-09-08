/**
 * Issue #2511 — PR workflow gate consumers of the typed delegation-read
 * uncertainty.
 *
 * `settlePresumedStalePrWorkflowLanes` carries `uncertainty` when the
 * advisory store read stays uncertain after its bounded retry, and every
 * `openLanes`-gated consumer must fail closed on that field instead of
 * reading `openLanes === 0` as an all-clear:
 *
 * - `completePrWorkflow` refuses and does NOT clear the gate,
 * - `abortPrWorkflow` refuses (open lanes are UNKNOWN, not absent),
 * - `rebindPrFeedbackHead` refuses (in-flight lanes cannot be verified),
 * - `submitPrReviewResult` rejects with the typed unreadable reason instead
 *   of the misleading "found 0".
 *
 * Fixture: an active gate session plus a raw pending `swarm-pr-review:base`
 * lane and a torn compaction manifest. Records are written raw (not through
 * `recordPendingDelegation`) because that writer creates the SQLite
 * coordination authority, which then masks the torn legacy manifest.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
} from '../../../src/background/pending-delegations.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	completePrWorkflow,
	readPrWorkflowGateState,
	rebindPrFeedbackHead,
	settlePresumedStalePrWorkflowLanes,
	submitPrReviewResult,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';
import { freezeClock } from '../../helpers/test-clock.js';

/** Raw pending open-lane record (fresh `updatedAt` => fresh-open, not stale). */
function writeOpenLaneStore(tornManifest: boolean): void {
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		`${JSON.stringify({
			schemaVersion: 1,
			correlationId: 'ses_open_lane',
			jobId: null,
			subagentSessionId: 'ses_open_lane',
			parentSessionId: SESSION_ID,
			callID: 'call_open_lane',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			status: 'pending',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			batchId: 'batch-1',
			laneId: 'lane-1',
			mode: 'swarm-pr-review:base',
			workflowLane: 'tests-falsifiability',
			promptHash: 'x'.repeat(24),
		})}\n`,
		'utf-8',
	);
	if (tornManifest) {
		fs.writeFileSync(
			path.join(tempDir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
			'{"schemaVersion": 1, "sequence": ',
			'utf-8',
		);
	}
}

describe('PR workflow gate — delegation-read uncertainty fail-closed paths (issue #2511)', () => {
	let restoreClock: (() => void) | null = null;

	beforeEach(() => {
		// Shared frozen instant: fixture `updatedAt` and the gate's staleness
		// reads must agree, so fresh-seeded lanes stay fresh deterministically.
		restoreClock = freezeClock({ fixedNow: Date.now() });
		setupPrWorkflowGateFixtures();
	});

	afterEach(async () => {
		await teardownPrWorkflowGateFixtures();
		restoreClock?.();
	});

	test('settlement on an uncertain store reports uncertainty, never a zero-lane all-clear', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		writeOpenLaneStore(true);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			tempDir,
			SESSION_ID,
		);
		expect(settlement.uncertainty).toBeDefined();
		expect(settlement.uncertainty?.attempts).toBe(2);
		expect(settlement.uncertainty?.reason.length).toBeGreaterThan(0);
		// The zero counts ride ONLY alongside the typed uncertainty field.
		expect(settlement.openLanes).toBe(0);
		expect(settlement.openLaneIds).toEqual([]);
	});

	test('settlement on a healthy store still counts the fresh-open lane (control)', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		writeOpenLaneStore(false);

		const settlement = await settlePresumedStalePrWorkflowLanes(
			tempDir,
			SESSION_ID,
		);
		expect(settlement.uncertainty).toBeUndefined();
		expect(settlement.openLanes).toBe(1);
		expect(settlement.openLaneIds).toEqual(['lane-1']);
	});

	test('completePrWorkflow refuses on an uncertain store and keeps the gate state', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		writeOpenLaneStore(true);

		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow(/BLOCKED: PR_FEEDBACK completion refused .* unreadable/i);

		// The gate was NOT cleared: state remains readable and active.
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state).not.toBeNull();
		expect(state?.mode).toBe('PR_FEEDBACK');
		expect(state?.prHeadSha).toBe(HEAD_SHA);
	});

	test('abortPrWorkflow refuses on an uncertain store (lanes are UNKNOWN, not absent)', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		writeOpenLaneStore(true);

		await expect(
			abortPrWorkflow(tempDir, SESSION_ID, {
				kind: 'recovery',
				reason: 'recover after store repair',
			}),
		).rejects.toThrow(
			/abort refused while the delegation store is unreadable/i,
		);

		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(state?.mode).toBe('PR_FEEDBACK');
	});

	test('submitPrReviewResult rejects with the typed unreadable reason, not "found 0"', async () => {
		writeOpenLaneStore(true);

		const outcome = await submitPrReviewResult(tempDir, 'ses_open_lane', {
			revisionDigest: 'revision-1',
			result: {
				schemaVersion: 1,
				outcome: 'CLEAN',
				creditedLanes: ['tests-falsifiability'],
				findings: [],
				cleanAttestations: [
					{
						workflowLane: 'tests-falsifiability',
						coverageScope: 'the exact reviewed diff for the lane',
						evidence:
							'reviewed the complete diff and found no actionable defect',
					},
				],
				unresolved: [],
			},
		});
		expect(outcome.status).toBe('rejected');
		if (outcome.status === 'rejected') {
			expect(outcome.reason).toMatch(/unreadable|uncertain/i);
			expect(outcome.reason).not.toMatch(/found 0/);
		}
	});

	test('rebindPrFeedbackHead refuses on an uncertain store (rebind guard fail-closed)', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		writeOpenLaneStore(true);

		await expect(
			rebindPrFeedbackHead(tempDir, SESSION_ID, 'def4567890abcdef'),
		).rejects.toThrow(
			/PR_FEEDBACK rebind refused while the delegation store is unreadable/i,
		);
	});
});

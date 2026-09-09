/**
 * FIX-6 / issue #2511 — tool-surface classification of delegation-store read
 * uncertainty (PR #2652 review findings).
 *
 * A torn `.swarm/background-delegations.manifest.json` makes the advisory
 * delegation store reader uncertain. The lane tools must propagate that typed
 * uncertainty instead of collapsing it to absence:
 *
 * - `collect_lane_results` reports failure_class 'store_unreadable' with the
 *   batch named UNKNOWN — never 'not_found', which is reserved for provable
 *   absence.
 * - `dispatch_lanes_async` cannot verify batch-id uniqueness against an
 *   unreadable store and fails closed with the invalid-args duplicate-batch
 *   rejection instead of treating the batch id as fresh and dispatching.
 *
 * Fixture recipe mirrors
 * tests/unit/background/pending-delegations-read-uncertainty-2511.test.ts: a
 * raw ledger line plus a torn manifest. Records are written raw on purpose —
 * `recordPendingDelegation` would create the SQLite coordination authority,
 * which masks a torn legacy manifest. Session ops follow the dispatch-lanes
 * sibling fixture style (see dispatch-lanes-create-retry.test.ts).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
} from '../../../src/background/pending-delegations';
import {
	_internals as dispatchInternals,
	executeCollectLaneResults,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const originalInternals = { ...dispatchInternals };

interface StoreFixture {
	dir: string;
	cleanup: () => void;
}

/** The verified open-lane record line (schema-valid under `RecordSchema`). */
function openLaneLine(batchId: string): string {
	const correlationId = 'ses_open_lane';
	return `${JSON.stringify({
		schemaVersion: 1,
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_controller',
		callID: 'call_open_lane',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: 'lane-open',
		status: 'pending',
		createdAt: 1,
		updatedAt: 2,
		promptHash: 'x'.repeat(24),
	})}\n`;
}

/**
 * Builds a torn store root: raw open-lane ledger line plus an unparseable
 * manifest (the compaction publication point), so the fold reader is uncertain.
 * `.git` marks the temp root as a project root for path policy.
 */
function createTornStore(batchId: string): StoreFixture {
	const safe = createSafeTestDir('swarm-dispatch-torn-');
	fs.mkdirSync(path.join(safe.dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(safe.dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		openLaneLine(batchId),
		'utf-8',
	);
	fs.writeFileSync(
		path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE),
		'{"schemaVersion": 1, "sequence": ',
		'utf-8',
	);
	return safe;
}

/** Minimal async-capable host client; every op is a mock so no lane work runs. */
function asyncSessionOps(): SessionOps {
	return {
		create: mock(async () => ({ data: { id: 'never-created' } })),
		prompt: mock(async () => ({ data: { parts: [] } })),
		promptAsync: mock(async () => ({})),
		messages: mock(async () => ({
			data: [
				{
					info: { role: 'assistant' },
					parts: [{ type: 'text', text: 'done' }],
				},
			],
		})),
		delete: mock(async () => undefined),
	};
}

afterEach(() => {
	Object.assign(dispatchInternals, originalInternals);
	mock.restore();
});

describe('dispatch lanes — delegation store unreadable (FIX-6, issue #2511)', () => {
	test('collect_lane_results classifies an uncertain store read as store_unreadable UNKNOWN, not not_found', async () => {
		// FIX-6: before the typed initial read, an unreadable store collapsed to
		// an empty batch and reported 'not_found' — asserting absence the reader
		// could not prove. The store gate fires before any host-client need, so
		// no session ops are installed for this test.
		const store = createTornStore('batch-torn-store');
		try {
			const result = await executeCollectLaneResults(
				{ batch_id: 'batch-torn-store' },
				store.dir,
			);

			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('store_unreadable');
			expect(result.batch_id).toBe('batch-torn-store');
			expect(result.message).toContain('UNKNOWN');
			expect(result.message).toContain('after 2 attempts');
			expect(result.message).toContain('batch-torn-store');
		} finally {
			store.cleanup();
		}
	});

	test('dispatch_lanes_async fails closed with the duplicate-batch rejection when uniqueness cannot be verified', async () => {
		// FIX-6: before the fail-closed branch, an uncertain duplicate read was
		// treated as "no duplicates found" — the batch id was accepted as fresh
		// and lanes were dispatched under an id whose uniqueness was never
		// established.
		const store = createTornStore('batch-verify-fails');
		const ops = asyncSessionOps();
		dispatchInternals.getSessionOps = () => ops;
		try {
			const result = await executeDispatchLanesAsync(
				{
					batch_id: 'batch-verify-fails',
					lanes: [{ id: 'lane', agent: 'reviewer', prompt: 'inspect' }],
				},
				store.dir,
			);

			expect(result.success).toBe(false);
			expect(result.failure_class).toBe('invalid_args');
			expect(result.batch_id).toBe(null);
			expect(result.dispatched).toBe(0);
			expect(result.lane_results).toEqual([]);
			expect(result.message).toContain(
				'batch uniqueness unverifiable: delegation store unreadable',
			);
			expect(result.message).toContain('after 2 attempts');
			expect(result.errors?.[0]).toBe(
				'batch_id uniqueness could not be verified: batch-verify-fails; retry once the delegation store is readable',
			);
			// Fail-closed means no lane was ever admitted.
			expect(ops.promptAsync).not.toHaveBeenCalled();
			expect(ops.create).not.toHaveBeenCalled();
		} finally {
			store.cleanup();
		}
	});
});

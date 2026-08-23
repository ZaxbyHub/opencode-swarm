import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	createPrWorkflowResponseGate,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';
const originalReadPrWorkflowGateState = _internals.readPrWorkflowGateState;

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-postwake-read-');
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	_internals.readPrWorkflowGateState = originalReadPrWorkflowGateState;
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Regression: F-003. The `finally` block in the idle handler re-reads durable
 * gate state AFTER the wake prompt to detect mid-wake progress. That re-read
 * can throw for two distinct reasons (a transient fs error, or a durable
 * schema-validation failure) — neither of which is a confirmed gate-clear.
 * The fix falls back to the PRE-WAKE state snapshot on that throw, so the
 * wake still counts as an attempted (unproductive) wake. The bug this guards
 * against: falling back to `null` instead, which is the sentinel this same
 * finally block uses for a CONFIRMED gate-clear — and a `null` postWakeState
 * routes into `resetBudget(sessionID)`, silently WIPING the just-incremented
 * `totalWakes` counter (and the whole budget entry) even though the gate is
 * still active.
 */
describe('idle handler post-wake read — regression: read failure must not wipe totalWakes (F-003)', () => {
	test('a post-wake readPrWorkflowGateState rejection preserves the pre-wake state snapshot; totalWakes still increments and the budget is not reset', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999_999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { L: 999_999 },
		});

		await writeStateWithRevision(directory, 'flaky-read-session', 3, 'L');

		let callCount = 0;
		_internals.readPrWorkflowGateState = mock(async (dir, sessionID) => {
			callCount += 1;
			// Each wake now performs initial, post-status, and pre-prompt durable
			// reads before the post-wake re-read in the finally block. Only the
			// fourth read should fail so this continues to exercise bookkeeping,
			// not the fail-closed cancellation guards added before promptAsync.
			if (callCount % 4 !== 0) {
				return originalReadPrWorkflowGateState(dir, sessionID);
			}
			// Post-wake read: simulate a transient/validation read failure.
			throw new Error('simulated post-wake read failure');
		});

		// Must resolve WITHOUT throwing — the failure is caught internally and
		// does not propagate out of the idle handler.
		await expect(
			gate.event(idleEventFor('flaky-read-session')),
		).resolves.toBeUndefined();

		expect(callCount).toBe(4);

		const budget = gate._inspectWakeBudget('flaky-read-session');
		// If the fallback were `null` (the gate-clear sentinel) instead of the
		// pre-wake snapshot, this branch would have called `resetBudget`,
		// deleting the entry entirely — this assertion would fail with
		// `undefined`.
		expect(budget).toBeDefined();
		// The wake must still count against the total-wake budget: a read
		// failure that silently drops the counter would let a session whose
		// gate-state file is corrupt (or a transient fs hiccup recurs on every
		// wake) auto-resume forever, exactly the unbounded-loop hazard this
		// module exists to prevent.
		expect(budget?.totalWakes).toBe(1);
		// The pre-wake revision (3) must be preserved as lastSeenRevision —
		// proof that the fallback used the PRE-WAKE snapshot (revision 3), not
		// a `null`/zeroed budget that would leave lastSeenRevision undefined.
		expect(budget?.lastSeenRevision).toBe(3);
		expect(budget?.suspended).toBe(false);

		// A second wake on the same (still-flaky) session must accumulate,
		// not reset — proving the entry truly survived rather than being torn
		// down and silently rebuilt with totalWakes back at 1.
		await writeStateWithRevision(directory, 'flaky-read-session', 3, 'L');
		await gate.event(idleEventFor('flaky-read-session'));
		const budgetAfterSecondWake = gate._inspectWakeBudget('flaky-read-session');
		expect(budgetAfterSecondWake?.totalWakes).toBe(2);
	});
});

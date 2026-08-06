import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	DEFAULT_TOTAL_WAKE_CEILINGS,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithoutTier,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-tier-fallback-');
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Regression: F-012. `prReviewDepthTier` is absent on gate state for modes
 * (e.g. PR_FEEDBACK) that never compute a diff-stats-derived tier. The idle
 * handler resolves the total-wake ceiling via `postWakeState.prReviewDepthTier
 * ?? 'L'`. Before the fix, a missing tier could resolve to `undefined`
 * (looking up `DEFAULT_TOTAL_WAKE_CEILINGS[undefined]`, which is `undefined`
 * and makes `totalWakes >= undefined` always `false` — the total brake never
 * fires for these sessions).
 */
describe('idle handler tier resolution — regression: absent prReviewDepthTier falls back to the L ceiling (F-012)', () => {
	test('a gate-state record with no prReviewDepthTier is governed by the tier-L ceiling (102)', async () => {
		expect(DEFAULT_TOTAL_WAKE_CEILINGS.L).toBe(102);

		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999_999,
			wakeCooldownMs: 0,
			// No totalWakeCeiling override: exercise the real DEFAULT_TOTAL_WAKE_CEILINGS.
		});

		// Never write prReviewDepthTier at all (not even `undefined`).
		await writeStateWithoutTier(directory, 'no-tier-session', 0);

		const idle = idleEventFor('no-tier-session');
		// Drive 101 productive wakes (revision advances every time so the
		// consecutive counter never fires) — must NOT be suspended yet, proving
		// the ceiling in force is 102 (the L default), not some smaller/absent
		// value.
		for (let i = 0; i < 101; i++) {
			await writeStateWithoutTier(directory, 'no-tier-session', i + 1);
			await gate.event(idle);
		}
		let budget = gate._inspectWakeBudget('no-tier-session');
		expect(budget?.suspended).toBe(false);
		expect(budget?.totalWakes).toBe(101);

		// The 102nd wake must hit the ceiling and suspend with reason 'total'.
		await writeStateWithoutTier(directory, 'no-tier-session', 102);
		await gate.event(idle);
		budget = gate._inspectWakeBudget('no-tier-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');
		expect(budget?.totalWakes).toBe(102);
	});
});

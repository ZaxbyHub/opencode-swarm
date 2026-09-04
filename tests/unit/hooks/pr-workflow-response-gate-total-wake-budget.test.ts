import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports as autoWakeInternals,
	isPrWorkflowAutoWakeSuppressed,
} from '../../../src/hooks/pr-workflow-auto-wake.js';
import type { PrReviewDepthTier } from '../../../src/hooks/pr-workflow-gate.js';
import {
	activatePrWorkflow,
	clearPrWorkflowGateState,
	type PrWorkflowGateState,
	readPrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	DEFAULT_TOTAL_WAKE_CEILINGS,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-response-gate-total-')),
	);
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write a raw gate-state record with a specific revision and optional depth tier. */
async function writeStateWithRevision(
	sessionID: string,
	revision: number,
	tier?: PrReviewDepthTier,
): Promise<void> {
	const existing =
		(await readPrWorkflowGateState(directory, sessionID)) ??
		(await activatePrWorkflow(directory, sessionID, 'PR_REVIEW'));
	await withSessionStateMutation(directory, sessionID, async () => {
		const current = await readPrWorkflowGateState(directory, sessionID);
		if (!current) throw new Error('missing active workflow state');
		await writeStateWhileLocked(directory, {
			...current,
			updatedAt: new Date(
				Date.parse(existing.activatedAt) + Math.max(revision, 0),
			).toISOString(),
			...(tier !== undefined ? { prReviewDepthTier: tier } : {}),
		} satisfies PrWorkflowGateState);
	});
}

/**
 * Drive N wakes for a session where revision advances every time
 * (so the consecutive counter always resets to 0). Uses tier-S ceiling
 * (12) by default for compact tests.
 */
async function driveProductiveWakes(
	gate: ReturnType<typeof createPrWorkflowResponseGate>,
	sessionID: string,
	count: number,
): Promise<void> {
	const idle = {
		event: {
			type: 'session.idle',
			properties: { sessionID },
		},
	};
	for (let i = 0; i < count; i++) {
		// Advance revision so every wake is "productive"
		await writeStateWithRevision(sessionID, i + 1, 'S');
		await gate.event(idle);
	}
}

describe('PR workflow total wake budget', () => {
	test('total cap suspends under continuous revision progress (consecutive stays 0)', async () => {
		// Tier-S ceiling is 12. Drive 12 productive wakes; the consecutive
		// counter resets to 0 each time, but totalWakes hits the ceiling.
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 12 },
		});
		await writeStateWithRevision('total-cap-session', 0, 'S');

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'total-cap-session' },
			},
		};
		// Drive 12 productive wakes — each advances revision so consecutiveUnproductive
		// never climbs. totalWakes reaches 12 (= ceiling for S) → suspend.
		for (let i = 0; i < 12; i++) {
			await writeStateWithRevision('total-cap-session', i + 1, 'S');
			await gate.event(idle);
		}

		const budget = gate._inspectWakeBudget('total-cap-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');
		// Consecutive counter stayed 0 because revision advanced every time.
		expect(budget?.consecutiveUnproductive).toBe(0);
		expect(budget?.totalWakes).toBe(12);

		// A 13th idle must NOT re-wake (already suspended).
		await gate.event(idle);
		expect(promptAsync).toHaveBeenCalledTimes(12);
	});

	test('total-cap suspension notice carries total-cap wording and names all three recovery paths', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 5 },
		});
		await writeStateWithRevision('notice-session', 0, 'S');

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'notice-session' },
			},
		};
		// Drive 5 productive wakes to hit total cap.
		for (let i = 0; i < 5; i++) {
			await writeStateWithRevision('notice-session', i + 1, 'S');
			await gate.event(idle);
		}

		const budget = gate._inspectWakeBudget('notice-session');
		expect(budget?.suspendedReason).toBe('total');

		// textComplete must emit the TOTAL-CAP wording (not consecutive wording)
		// and name all three recovery paths.
		const output = { text: 'still working' };
		await gate.textComplete({ sessionID: 'notice-session' }, output);

		// Total-cap wording: "total wake budget for this workflow"
		// (corrected from the earlier "total per-session wake budget" wording,
		// which overclaimed the counter's scope — WakeBudget.totalWakes is
		// scoped to one process lifetime, until the durable gate clears, not the
		// whole session).
		expect(output.text).toContain('total wake budget for this workflow');
		// Must NOT contain the consecutive-unproductive wording.
		expect(output.text).not.toContain('consecutive unproductive retries');
		// All three recovery paths must be named.
		expect(output.text).toContain('/swarm abort-pr-workflow');
		expect(output.text).toContain('abort_pr_workflow');
		expect(output.text).toContain('complete_pr_workflow');
		// Model text preserved.
		expect(output.text).toContain('still working');
	});

	test('failed and timed-out wakes count toward total budget', async () => {
		// Use a very small total ceiling to test the counting behavior.
		const promptAsync = mock(async () => ({
			error: 'upstream rate limited',
		}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 3 },
		});
		await writeStateWithRevision('fail-total-session', 0, 'S');

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'fail-total-session' },
			},
		};
		// 3 failing wakes → totalWakes reaches ceiling → suspended.
		for (let i = 0; i < 3; i++) {
			await gate.event(idle).catch(() => {});
		}
		const budget = gate._inspectWakeBudget('fail-total-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');
		expect(budget?.totalWakes).toBe(3);
	});

	test('per-tier ceilings scale correctly (L > S) and healthy tier-M is not falsely suspended', async () => {
		// Verify the exported defaults scale correctly.
		expect(DEFAULT_TOTAL_WAKE_CEILINGS.S).toBeLessThan(
			DEFAULT_TOTAL_WAKE_CEILINGS.M,
		);
		expect(DEFAULT_TOTAL_WAKE_CEILINGS.M).toBeLessThan(
			DEFAULT_TOTAL_WAKE_CEILINGS.L,
		);
		expect(DEFAULT_TOTAL_WAKE_CEILINGS.L).toBeGreaterThanOrEqual(100);

		// Drive 54 productive wakes for a tier-M session (ceiling = 54).
		// At wake 54, totalWakes == ceiling → suspend. Wake 53 must NOT suspend.
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 12, M: 54, L: 102 },
		});
		await writeStateWithRevision('tier-m-session', 0, 'M');

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'tier-m-session' },
			},
		};
		// Drive 53 productive wakes — must NOT be suspended.
		for (let i = 0; i < 53; i++) {
			await writeStateWithRevision('tier-m-session', i + 1, 'M');
			await gate.event(idle);
		}
		let budget = gate._inspectWakeBudget('tier-m-session');
		expect(budget?.suspended).toBe(false);
		expect(budget?.totalWakes).toBe(53);

		// Wake 54 hits the ceiling → suspended.
		await writeStateWithRevision('tier-m-session', 54, 'M');
		await gate.event(idle);
		budget = gate._inspectWakeBudget('tier-m-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');
		expect(budget?.totalWakes).toBe(54);
	});

	test('timed-out wakes (resume prompt never resolves) count toward total and cause suspension', async () => {
		// Simulate a timeout: promptAsync returns a promise that NEVER resolves.
		// With wakeTimeoutMs=1ms the Promise.race in the gate rejects quickly.
		const promptAsync = mock(async () => new Promise<never>(() => {}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			wakeTimeoutMs: 1,
			totalWakeCeiling: { S: 4 },
		});
		await writeStateWithRevision('timeout-session', 0, 'S');

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'timeout-session' },
			},
		};
		// 4 timed-out wakes → totalWakes reaches ceiling → suspended.
		for (let i = 0; i < 4; i++) {
			await gate.event(idle).catch(() => {});
		}
		const budget = gate._inspectWakeBudget('timeout-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.suspendedReason).toBe('total');
		expect(budget?.totalWakes).toBe(4);
	});

	test('SC-001.3: healthy tier-L session driving ~55 productive wakes is NOT suspended', async () => {
		// The tier-L default ceiling is 102. A healthy session doing 55 productive
		// wakes (within the observed ~40-55 range) must NOT be falsely suspended.
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			// Use defaults (no totalWakeCeiling override) so the actual
			// DEFAULT_TOTAL_WAKE_CEILINGS are exercised.
		});
		await writeStateWithRevision('healthy-l-session', 0, 'L');

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'healthy-l-session' },
			},
		};
		// Drive 55 productive wakes with revision advancing each time.
		for (let i = 0; i < 55; i++) {
			await writeStateWithRevision('healthy-l-session', i + 1, 'L');
			await gate.event(idle);
		}

		const budget = gate._inspectWakeBudget('healthy-l-session');
		expect(budget?.suspended).toBe(false);
		expect(budget?.totalWakes).toBe(55);
		expect(budget?.consecutiveUnproductive).toBe(0);
		// All 55 wakes actually fired.
		expect(promptAsync).toHaveBeenCalledTimes(55);
	});

	test('partial totalWakeCeiling override: specified tier uses override, unspecified tier uses default', async () => {
		// Only tier-S is overridden to 5; tier-L falls back to the default 102.
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 999,
			wakeCooldownMs: 0,
			totalWakeCeiling: { S: 5 },
		});

		// Tier-S session with ceiling=5 should suspend at wake 5.
		await writeStateWithRevision('partial-s', 0, 'S');
		const idleS = {
			event: { type: 'session.idle', properties: { sessionID: 'partial-s' } },
		};
		for (let i = 0; i < 5; i++) {
			await writeStateWithRevision('partial-s', i + 1, 'S');
			await gate.event(idleS);
		}
		const budgetS = gate._inspectWakeBudget('partial-s');
		expect(budgetS?.suspended).toBe(true);
		expect(budgetS?.suspendedReason).toBe('total');
		expect(budgetS?.totalWakes).toBe(5);

		// Tier-L session should use the DEFAULT ceiling (102), not 5.
		// Drive 55 productive wakes — well under 102, must NOT be suspended.
		await writeStateWithRevision('partial-l', 0, 'L');
		const idleL = {
			event: { type: 'session.idle', properties: { sessionID: 'partial-l' } },
		};
		for (let i = 0; i < 55; i++) {
			await writeStateWithRevision('partial-l', i + 1, 'L');
			await gate.event(idleL);
		}
		const budgetL = gate._inspectWakeBudget('partial-l');
		expect(budgetL?.suspended).toBe(false);
		expect(budgetL?.totalWakes).toBe(55);
	});
});

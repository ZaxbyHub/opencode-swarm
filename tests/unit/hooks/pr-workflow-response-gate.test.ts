import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	clearPrWorkflowGateState,
	type PrWorkflowGateState,
	_test_exports as workflowInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { createPrWorkflowResponseGate } from '../../../src/hooks/pr-workflow-response-gate.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-response-gate-')),
	);
	workflowInternals.resetTrackedStateCache();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write a raw gate-state record with a specific revision so tests can
 * simulate the durable gate advancing (or NOT advancing) across idle cycles. */
async function writeStateWithRevision(
	sessionID: string,
	revision: number,
): Promise<void> {
	const relative = workflowInternals.workflowGateStateRelativePath(sessionID);
	const absolute = path.join(directory, '.swarm', relative);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	const state: PrWorkflowGateState = {
		schemaVersion: 1,
		revision,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	};
	await fs.writeFile(absolute, JSON.stringify(state, null, 2), 'utf-8');
}

describe('PR workflow response-level gate', () => {
	test('replaces architect text until complete_pr_workflow clears durable state', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'review-session', 'PR_REVIEW');
		const blocked = { text: 'Looks good. APPROVE.' };
		await gate.textComplete({ sessionID: 'review-session' }, blocked);
		expect(blocked.text).toContain('FINAL RESPONSE BLOCKED');
		expect(blocked.text).not.toContain('Looks good');

		await clearPrWorkflowGateState(directory, 'review-session');
		const completed = { text: 'Verified completion.' };
		await gate.textComplete({ sessionID: 'review-session' }, completed);
		expect(completed.text).toBe('Verified completion.');
	});

	test('session idle mechanically resumes an active workflow', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'feedback-session', 'PR_FEEDBACK');
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'feedback-session' },
			},
		});
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
			path: { id: 'feedback-session' },
		});
		expect(JSON.stringify(promptAsync.mock.calls[0]?.[0])).toContain(
			'Do not stop or summarize',
		);
	});

	test('does not rewrite or wake sessions without an active gate', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		const output = { text: 'ordinary response' };
		await gate.textComplete({ sessionID: 'ordinary-session' }, output);
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'ordinary-session' },
			},
		});
		expect(output.text).toBe('ordinary response');
		expect(promptAsync).not.toHaveBeenCalled();
	});

	test('keeps text enforcement but skips resume when the host has no session API', async () => {
		const gate = createPrWorkflowResponseGate({ directory });
		await activatePrWorkflow(directory, 'limited-host-session', 'PR_REVIEW');
		const output = { text: 'ordinary response' };
		await gate.textComplete({ sessionID: 'limited-host-session' }, output);
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'limited-host-session' },
			},
		});
		expect(output.text).toContain('FINAL RESPONSE BLOCKED');
	});
});

describe('PR workflow response-gate wake budget', () => {
	test('block text names abort_pr_workflow and /swarm abort-pr-workflow', async () => {
		await activatePrWorkflow(directory, 'discoverable-session', 'PR_REVIEW');
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: mock(async () => ({})) } },
		});
		const output = { text: 'original' };
		await gate.textComplete({ sessionID: 'discoverable-session' }, output);
		expect(output.text).toContain('abort_pr_workflow');
		expect(output.text).toContain('/swarm abort-pr-workflow');
	});

	test('suspends auto-resume after the configured consecutive unproductive wakes', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 2,
			wakeCooldownMs: 0,
		});
		// Hold revision constant → every wake is "unproductive".
		await writeStateWithRevision('stuck-session', 0);

		const idleEvent = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'stuck-session' },
			},
		};
		// Wake 1 (first probe — counts as progress), wake 2 (unproductive, counter→1),
		// wake 3 (unproductive, counter→2 → suspend).
		await gate.event(idleEvent);
		await gate.event(idleEvent);
		await gate.event(idleEvent);
		// The 2 unproductive wakes (after the probe) hit the budget; a 4th idle
		// must NOT re-wake.
		await gate.event(idleEvent);
		expect(promptAsync).toHaveBeenCalledTimes(3);

		// textComplete still rewrites text so the user-visible surface is
		// preserved and now carries the suspend notice.
		const output = { text: 'x' };
		await gate.textComplete({ sessionID: 'stuck-session' }, output);
		expect(output.text).toContain('Auto-resume is suspended');
		expect(output.text).toContain('/swarm abort-pr-workflow');
	});

	test('resets the consecutive counter when state.revision advances (progress)', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 2,
			wakeCooldownMs: 0,
		});
		await writeStateWithRevision('healthy-session', 0);

		const idle = (sid: string) => ({
			event: { type: 'session.idle', properties: { sessionID: sid } },
		});

		// Wake 1 (probe, revision 0), wake 2 (unproductive, revision still 0).
		await gate.event(idle('healthy-session'));
		await gate.event(idle('healthy-session'));
		// Now the controller makes progress — revision bumps to 5.
		await writeStateWithRevision('healthy-session', 5);
		// Wake 3 sees revision 5 > lastSeenRevision 0 → progress → counter resets.
		await gate.event(idle('healthy-session'));
		// Wake 4 (revision unchanged at 5 → unproductive again, counter→1).
		await gate.event(idle('healthy-session'));
		// Wake 5 (unproductive, counter→2 → suspend).
		await gate.event(idle('healthy-session'));
		// Wake 6 must be skipped.
		await gate.event(idle('healthy-session'));
		expect(promptAsync).toHaveBeenCalledTimes(5);
	});

	test('evicts the wake budget when the gate clears (state → null)', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 1,
			wakeCooldownMs: 0,
		});
		await writeStateWithRevision('cleared-session', 0);

		// Wake once, then hit the budget on the next.
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'cleared-session' },
			},
		});
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'cleared-session' },
			},
		});
		// Now suspended.
		const budgetBeforeClear = gate._inspectWakeBudget('cleared-session');
		expect(budgetBeforeClear?.suspended).toBe(true);

		// Clear the gate (e.g. via abort or complete).
		await clearPrWorkflowGateState(directory, 'cleared-session');
		await gate.event({
			event: {
				type: 'session.idle',
				properties: { sessionID: 'cleared-session' },
			},
		});
		// Budget must be evicted — a future activation of the same sessionID
		// starts fresh, not stuck in the old suspended state.
		expect(gate._inspectWakeBudget('cleared-session')).toBeUndefined();

		// And textComplete stops rewriting once the gate is gone.
		const output = { text: 'final real text' };
		await gate.textComplete({ sessionID: 'cleared-session' }, output);
		expect(output.text).toBe('final real text');
	});

	test('counts a failed resume prompt toward the budget (no unbounded loop)', async () => {
		// Regression: if the host resume API keeps returning {error: ...} (rate
		// limit, context length, model error), the budget MUST still advance so
		// the session suspends. Otherwise the failing host recreates the exact
		// unbounded auto-resume loop this module exists to prevent.
		const promptAsync = mock(async () => ({
			error: 'upstream rate limited',
		}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 2,
			wakeCooldownMs: 0,
		});
		await writeStateWithRevision('failing-host-session', 0);

		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'failing-host-session' },
			},
		};
		// Each wake throws because promptAsync returns {error}; the throw must
		// NOT skip budget bookkeeping. After the configured budget of
		// unproductive wakes, further idles stop calling promptAsync.
		// Wake 1 (probe), wake 2 (unproductive, counter→1), wake 3
		// (unproductive, counter→2 → suspend). Wake 4 must be skipped.
		for (let i = 0; i < 3; i++) {
			await gate.event(idle).catch(() => {
				/* expected throw from the failing resume prompt */
			});
		}
		await gate.event(idle).catch(() => {
			/* the suspended path returns early, no throw */
		});
		expect(promptAsync).toHaveBeenCalledTimes(3);
		const budget = gate._inspectWakeBudget('failing-host-session');
		expect(budget?.suspended).toBe(true);
		expect(budget?.consecutiveUnproductive).toBe(2);
	});

	test('does not falsely suspend when revision advances mid-wake (PRR-005)', async () => {
		// Regression: madeProgress was computed from a snapshot read BEFORE the
		// promptAsync await. If a concurrent controller tool bumped state.revision
		// during the await and the counter was at MAX-1, the stale madeProgress
		// (false) would wrongly increment to MAX and suspend a healthy session.
		// Fix: re-read state.revision AFTER the await and treat the wake as
		// productive if the revision advanced.
		await writeStateWithRevision('race-session', 0);
		// Drive the counter to MAX-1 (4 with max=5) by holding revision at 0.
		// Sequence: wake1 (probe, counter stays 0), wake2 (unproductive, counter→1),
		// wake3 (→2), wake4 (→3), wake5 (→4 = MAX-1).
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 5,
			wakeCooldownMs: 0,
		});
		const idle = (sid: string) => ({
			event: { type: 'session.idle', properties: { sessionID: sid } },
		});
		for (let i = 0; i < 5; i++) {
			await gate.event(idle('race-session'));
		}
		let budget = gate._inspectWakeBudget('race-session');
		expect(budget?.consecutiveUnproductive).toBe(4);
		expect(budget?.suspended).toBe(false);

		// Now bump revision to 10 AFTER the pre-await snapshot read but BEFORE
		// the finally block re-reads. Simulate a concurrent controller mutation.
		// The promptAsync mock itself bumps the on-disk revision mid-wake.
		promptAsync.mockImplementation(async () => {
			await writeStateWithRevision('race-session', 10);
			return {};
		});
		// wake6: pre-await snapshot sees revision 0 (stale madeProgress=false),
		// but during the await the revision bumps to 10. The fix's post-await
		// re-read must detect this and treat the wake as productive.
		await gate.event(idle('race-session'));

		budget = gate._inspectWakeBudget('race-session');
		// The bug would set suspended=true here. The fix keeps the session alive.
		expect(budget?.suspended).toBe(false);
		expect(budget?.consecutiveUnproductive).toBe(0);
		expect(budget?.lastSeenRevision).toBe(10);
	});
});

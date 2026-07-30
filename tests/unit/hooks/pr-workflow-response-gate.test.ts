import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports as autoWakeInternals,
	isPrWorkflowAutoWakeSuppressed,
} from '../../../src/hooks/pr-workflow-auto-wake.js';
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
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
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
	test('prepends workflow banner to architect text until complete_pr_workflow clears durable state', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
		});
		await activatePrWorkflow(directory, 'review-session', 'PR_REVIEW');
		const blocked = { text: 'Looks good. APPROVE.' };
		await gate.textComplete({ sessionID: 'review-session' }, blocked);
		expect(blocked.text).toContain('WORKFLOW ACTIVE');
		// The model's original text is preserved below the banner, not erased.
		expect(blocked.text).toContain('Looks good');
		// Banner appears BEFORE the model's text (F-004: ordering guard).
		const bannerIdx = blocked.text.indexOf('WORKFLOW ACTIVE');
		const textIdx = blocked.text.indexOf('Looks good');
		expect(bannerIdx).toBeLessThan(textIdx);

		await clearPrWorkflowGateState(directory, 'review-session');
		const completed = { text: 'Verified completion.' };
		await gate.textComplete({ sessionID: 'review-session' }, completed);
		expect(completed.text).toBe('Verified completion.');
	});

	test('preserves intermediate reasoning text below the workflow banner', async () => {
		const gate = createPrWorkflowResponseGate({ directory });
		await activatePrWorkflow(directory, 'working-session', 'PR_REVIEW');
		const output = {
			text: 'Let me fetch the PR head and verify the merge base before dispatching lanes.',
		};
		await gate.textComplete({ sessionID: 'working-session' }, output);
		// Banner present at the top.
		expect(output.text).toContain('WORKFLOW ACTIVE');
		expect(output.text).toContain('not a terminal verdict');
		// The model's full reasoning text survives below the banner.
		expect(output.text).toContain('Let me fetch the PR head');
		expect(output.text).toContain('verify the merge base');
	});

	test('banner is mode-aware for PR_FEEDBACK as well as PR_REVIEW', async () => {
		const gate = createPrWorkflowResponseGate({ directory });
		await activatePrWorkflow(directory, 'feedback-mode-session', 'PR_FEEDBACK');
		const output = { text: 'Stage A checks passing.' };
		await gate.textComplete({ sessionID: 'feedback-mode-session' }, output);
		expect(output.text).toContain('PR_FEEDBACK WORKFLOW ACTIVE');
		expect(output.text).toContain('Stage A checks passing.');
	});

	// REVERSAL (deliberate): this previously asserted "banner appears even on
	// empty text". That behavior was the dominant term in a measured production
	// flood — 968 of ~1015 injections in a real `/swarm pr-review` transcript
	// were marker-only lines carrying no model prose (one unbroken run of 95),
	// making injected text 55.3% of all non-blank lines. A banner labelling no
	// content communicates nothing and violates AGENTS.md invariant 10 ("Do not
	// emit diagnostic noise into chat-visible streams"). The banner's purpose —
	// marking model output as non-terminal — is meaningless with no output to
	// mark, so a blank part is now left exactly as-is.
	test('blank text parts are left untouched — a banner labelling no content is noise', async () => {
		const gate = createPrWorkflowResponseGate({ directory });
		await activatePrWorkflow(directory, 'empty-text-session', 'PR_REVIEW');

		const empty = { text: '' };
		await gate.textComplete({ sessionID: 'empty-text-session' }, empty);
		expect(empty.text).toBe('');

		// Whitespace-only parts are equally contentless.
		const blank = { text: '  \n\t \n ' };
		await gate.textComplete({ sessionID: 'empty-text-session' }, blank);
		expect(blank.text).toBe('  \n\t \n ');

		// A substantive part in the same session still gets the banner, proving
		// the blank parts were skipped rather than the gate being inert.
		const real = { text: 'Dispatching the base lanes.' };
		await gate.textComplete({ sessionID: 'empty-text-session' }, real);
		expect(real.text).toContain('WORKFLOW ACTIVE');
		expect(real.text).toContain('Dispatching the base lanes.');
	});

	test('banner carries both suspension and interruption notices when both are active (F-003)', async () => {
		// Drive the wake budget to suspension (max=1 for quick exhaustion),
		// then trigger a MessageAbortedError to set the interruption pause.
		// textComplete must produce a banner containing BOTH recovery notices.
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 1,
			wakeCooldownMs: 0,
		});
		await writeStateWithRevision('combined-session', 0);
		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'combined-session' },
			},
		};
		// Wake 1 (probe), wake 2 (unproductive → suspend at max=1).
		await gate.event(idle);
		await gate.event(idle);
		expect(gate._inspectWakeBudget('combined-session')?.suspended).toBe(true);

		// Now trigger a user interruption.
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'combined-session',
					error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
				},
			},
		});
		expect(isPrWorkflowAutoWakeSuppressed(directory, 'combined-session')).toBe(
			true,
		);

		// textComplete must show BOTH the suspension notice and the interruption notice.
		const output = { text: 'still working' };
		await gate.textComplete({ sessionID: 'combined-session' }, output);
		expect(output.text).toContain('Auto-resume is suspended');
		expect(output.text).toContain('user interruption');
		// Model text preserved below both notices.
		expect(output.text).toContain('still working');
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

	test('prepends workflow banner but skips resume when the host has no session API', async () => {
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
		expect(output.text).toContain('WORKFLOW ACTIVE');
		// Original text preserved below banner.
		expect(output.text).toContain('ordinary response');
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

		// textComplete still prepends the banner so the user-visible surface
		// is preserved and now carries the suspend notice.
		const output = { text: 'x' };
		await gate.textComplete({ sessionID: 'stuck-session' }, output);
		expect(output.text).toContain('Auto-resume is suspended');
		expect(output.text).toContain('/swarm abort-pr-workflow');
		// The model's text is preserved below the banner even when suspended.
		expect(output.text).toContain('x');
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

		// And textComplete stops prepending the banner once the gate is gone.
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

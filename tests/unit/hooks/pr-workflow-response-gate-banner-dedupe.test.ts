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
import {
	createPrWorkflowResponseGate,
	DEFAULT_BANNER_COOLDOWN_MS,
	MAX_FALLBACK_BANNER_INJECTIONS_PER_SESSION,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

// Substrings that appear ONLY in the full multi-line banner, never in the
// short cooldown marker `--- [<mode> WORKFLOW ACTIVE] ---`. Asserting these
// distinguishes a full banner from a deduped short marker.
const FULL_BANNER_MARKER = 'not a terminal verdict';
const SHORT_MARKER = '--- [PR_REVIEW WORKFLOW ACTIVE] ---';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-banner-dedupe-')),
	);
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write a raw gate-state record so the wake-budget path can be driven to a
 * suspended state without a live controller. Mirrors the helper in
 * pr-workflow-response-gate.test.ts. */
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

describe('PR workflow response-gate banner dedupe (C7)', () => {
	test('exports a positive default banner cooldown (~20s)', () => {
		expect(typeof DEFAULT_BANNER_COOLDOWN_MS).toBe('number');
		expect(DEFAULT_BANNER_COOLDOWN_MS).toBeGreaterThan(0);
		// ~20s per spec; guard against an accidental zero/tiny value that would
		// disable dedupe or a huge value that would suppress the full banner.
		expect(DEFAULT_BANNER_COOLDOWN_MS).toBeGreaterThanOrEqual(10_000);
		expect(DEFAULT_BANNER_COOLDOWN_MS).toBeLessThanOrEqual(60_000);
	});

	test('first part gets the FULL banner; an immediate second part within the cooldown gets only the SHORT marker with model text preserved', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 20_000,
		});
		await activatePrWorkflow(directory, 'dedupe-session', 'PR_REVIEW');

		// First completed part → full banner (no prior stamp for this session).
		const first = { text: 'Let me inspect the merge base.' };
		await gate.textComplete({ sessionID: 'dedupe-session' }, first);
		expect(first.text).toContain(FULL_BANNER_MARKER);
		expect(first.text).toContain('Let me inspect the merge base.');

		// Immediate second part — real elapsed time is far below the 20s cooldown
		// → short marker only, NOT the full banner. Model text still preserved.
		const second = { text: 'Now dispatching the review lanes.' };
		await gate.textComplete({ sessionID: 'dedupe-session' }, second);
		expect(second.text).not.toContain(FULL_BANNER_MARKER);
		expect(second.text).toContain(SHORT_MARKER);
		expect(second.text).toContain('Now dispatching the review lanes.');
		// Marker sits above the model text (ordering preserved).
		expect(second.text.indexOf(SHORT_MARKER)).toBeLessThan(
			second.text.indexOf('Now dispatching'),
		);
	});

	test('after the cooldown elapses the FULL banner returns; a short marker does NOT refresh the cooldown window', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 20_000,
		});
		await activatePrWorkflow(directory, 'cooldown-session', 'PR_REVIEW');

		// t0: full banner, stamps the instant at 1_000_000.
		const first = { text: 'first' };
		await withFrozenClockAsync(
			() => gate.textComplete({ sessionID: 'cooldown-session' }, first),
			{ fixedNow: 1_000_000 },
		);
		expect(first.text).toContain(FULL_BANNER_MARKER);

		// t0 + 19s (within the 20s cooldown) → short marker. Crucially this must
		// NOT re-stamp the cooldown; the window is measured from the last FULL
		// banner (1_000_000), not from this marker.
		const second = { text: 'second' };
		await withFrozenClockAsync(
			() => gate.textComplete({ sessionID: 'cooldown-session' }, second),
			{ fixedNow: 1_019_000 },
		);
		expect(second.text).not.toContain(FULL_BANNER_MARKER);
		expect(second.text).toContain(SHORT_MARKER);

		// t0 + 30s: 30s since the last FULL banner (> 20s) → full banner again.
		// If the short marker had wrongly refreshed the stamp to 1_019_000, this
		// call would be only 11s later and would still be a short marker — so
		// this assertion also guards the "marker does not refresh" behavior.
		const third = { text: 'third' };
		await withFrozenClockAsync(
			() => gate.textComplete({ sessionID: 'cooldown-session' }, third),
			{ fixedNow: 1_030_000 },
		);
		expect(third.text).toContain(FULL_BANNER_MARKER);
		expect(third.text).toContain('third');
	});

	test('a suspended session gets the FULL banner on every part, even within the cooldown (invariant-10 operational notice)', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 1,
			wakeCooldownMs: 0,
			// Large banner cooldown: a non-suspended session WOULD be deduped to a
			// short marker on the second part; suspended must override that.
			bannerCooldownMs: 60_000,
		});
		await writeStateWithRevision('suspended-session', 0);
		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'suspended-session' },
			},
		};
		// Wake 1 (probe), wake 2 (unproductive → suspend at max=1).
		await gate.event(idle);
		await gate.event(idle);
		expect(gate._inspectWakeBudget('suspended-session')?.suspended).toBe(true);

		const first = { text: 'part one' };
		await gate.textComplete({ sessionID: 'suspended-session' }, first);
		expect(first.text).toContain('Auto-resume is suspended');
		expect(first.text).toContain(FULL_BANNER_MARKER);
		expect(first.text).toContain('part one');

		// Immediate second part (well within the 60s cooldown) must STILL be the
		// full banner with the suspension notice — never deduped to the marker.
		const second = { text: 'part two' };
		await gate.textComplete({ sessionID: 'suspended-session' }, second);
		expect(second.text).toContain('Auto-resume is suspended');
		expect(second.text).toContain(FULL_BANNER_MARKER);
		expect(second.text).toContain('part two');
	});

	test('a user-interrupted session gets the FULL banner on every part, even within the cooldown (invariant-10 operational notice)', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			bannerCooldownMs: 60_000,
		});
		await activatePrWorkflow(directory, 'interrupted-session', 'PR_REVIEW');
		await gate.event({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 'interrupted-session',
					error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
				},
			},
		});
		expect(
			isPrWorkflowAutoWakeSuppressed(directory, 'interrupted-session'),
		).toBe(true);

		const first = { text: 'thinking one' };
		await gate.textComplete({ sessionID: 'interrupted-session' }, first);
		expect(first.text).toContain('user interruption');
		expect(first.text).toContain(FULL_BANNER_MARKER);
		expect(first.text).toContain('thinking one');

		// Immediate second part within the 60s cooldown — the interruption notice
		// must remain on every part, so the full banner is emitted again.
		const second = { text: 'thinking two' };
		await gate.textComplete({ sessionID: 'interrupted-session' }, second);
		expect(second.text).toContain('user interruption');
		expect(second.text).toContain(FULL_BANNER_MARKER);
		expect(second.text).toContain('thinking two');
	});

	// --- GUARDRAIL (recurrence prevention) --------------------------------
	//
	// Defect class: "a user-visible injection hook that is THROTTLED (choosing
	// which text to inject) but never GATED (choosing whether to inject at all)".
	// The 20s cooldown shipped in 845cc4b was a throttle; it reduced full banners
	// to short markers and left the injection count at 100% of parts.
	//
	// This test is deliberately written against the OBSERVABLE OUTCOME — total
	// injections across a realistic turn shape — rather than against any
	// particular internal mechanism, so it keeps biting if the per-message map,
	// the blank-text guard, or the cooldown is later refactored or replaced.
	// It fails on the pre-fix implementation, which injected 300/300.
	test('GUARDRAIL: a realistic gated turn cannot exceed a small bounded number of injections', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			// Deliberately tiny, so a throttle-only implementation would emit full
			// banners freely and still be caught by the ceiling below.
			bannerCooldownMs: 1,
		});
		await activatePrWorkflow(directory, 'flood-guard', 'PR_REVIEW');

		const MESSAGES = 10;
		const PARTS_PER_MESSAGE = 30;
		let injections = 0;
		for (let m = 0; m < MESSAGES; m++) {
			for (let p = 0; p < PARTS_PER_MESSAGE; p++) {
				// Every third part is blank — the shape OpenCode produces between
				// tool calls, and the shape that generated the field report's
				// 95-line unbroken run of marker-only lines.
				const original = p % 3 === 0 ? '' : `m${m} p${p} reasoning`;
				const part = { text: original };
				await gate.textComplete(
					{
						sessionID: 'flood-guard',
						messageID: `msg-${m}`,
						partID: `msg-${m}-part-${p}`,
					},
					part,
				);
				if (part.text !== original) injections++;
				// A blank part must never be turned into a marker-only part.
				if (original === '') expect(part.text).toBe('');
			}
		}

		// One notice per user-facing turn. Pre-fix this was 300.
		expect(injections).toBe(MESSAGES);
		// Restated as a hard ceiling so the intent survives a refactor: injections
		// must scale with MESSAGES, never with total parts.
		expect(injections).toBeLessThanOrEqual(MESSAGES);
		expect(injections).toBeLessThan((MESSAGES * PARTS_PER_MESSAGE) / 10);
	});

	// --- per-message injection bound (the actual flood fix) ---------------
	//
	// Field measurement that motivated these tests: in a real `/swarm pr-review`
	// transcript the gate injected ~1015 banners, 968 of them marker-only lines
	// with no model prose, reaching 55.3% of all non-blank lines and ~39.9% of
	// transcript characters. The 20s cooldown was working exactly as designed
	// (47 full : 968 short) — it only ever chose WHICH string to inject, never
	// whether to inject. These tests pin the suppression path.

	test('a burst of parts in ONE assistant message produces exactly ONE injection', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 20_000,
		});
		await activatePrWorkflow(directory, 'burst-session', 'PR_REVIEW');

		const first = { text: 'Binding the PR head.' };
		await gate.textComplete(
			{ sessionID: 'burst-session', messageID: 'msg-1', partID: 'part-1' },
			first,
		);
		expect(first.text).toContain(FULL_BANNER_MARKER);
		expect(first.text).toContain('Binding the PR head.');

		// 40 further parts of the SAME message — the shape that produced the
		// 95-line contiguous run in the field. None may be decorated.
		for (let i = 2; i <= 41; i++) {
			const part = { text: `reasoning step ${i}` };
			await gate.textComplete(
				{
					sessionID: 'burst-session',
					messageID: 'msg-1',
					partID: `part-${i}`,
				},
				part,
			);
			expect(part.text).toBe(`reasoning step ${i}`);
		}

		// A NEW message re-arms the notice, so the user still sees it every turn.
		const nextTurn = { text: 'Collecting lane results.' };
		await gate.textComplete(
			{ sessionID: 'burst-session', messageID: 'msg-2', partID: 'part-42' },
			nextTurn,
		);
		expect(nextTurn.text).toContain(SHORT_MARKER);
		expect(nextTurn.text).toContain('Collecting lane results.');
	});

	test('per-message dedupe also bounds SUSPENDED sessions — the notice is re-armed per message, not repeated per part', async () => {
		const promptAsync = mock(async () => ({}));
		const gate = createPrWorkflowResponseGate({
			directory,
			client: { session: { prompt: promptAsync, promptAsync } },
			maxConsecutiveUnproductiveWakes: 1,
			wakeCooldownMs: 0,
			bannerCooldownMs: 60_000,
		});
		await writeStateWithRevision('suspended-burst', 0);
		const idle = {
			event: {
				type: 'session.idle',
				properties: { sessionID: 'suspended-burst' },
			},
		};
		await gate.event(idle);
		await gate.event(idle);
		expect(gate._inspectWakeBudget('suspended-burst')?.suspended).toBe(true);

		// First part of the message: FULL banner with the suspension notice,
		// never downgraded to the short marker even inside the 60s cooldown.
		const first = { text: 'part one' };
		await gate.textComplete(
			{ sessionID: 'suspended-burst', messageID: 'm1', partID: 'p1' },
			first,
		);
		expect(first.text).toContain('Auto-resume is suspended');
		expect(first.text).toContain(FULL_BANNER_MARKER);

		// Later parts of the SAME message are NOT re-decorated. Invariant 10
		// requires the operational notice to be visible, which it is — once per
		// user-facing turn.
		const second = { text: 'part two' };
		await gate.textComplete(
			{ sessionID: 'suspended-burst', messageID: 'm1', partID: 'p2' },
			second,
		);
		expect(second.text).toBe('part two');

		// The next message carries the suspension notice again.
		const nextTurn = { text: 'part three' };
		await gate.textComplete(
			{ sessionID: 'suspended-burst', messageID: 'm2', partID: 'p3' },
			nextTurn,
		);
		expect(nextTurn.text).toContain('Auto-resume is suspended');
		expect(nextTurn.text).toContain(FULL_BANNER_MARKER);
	});

	test('text that already opens with a banner is never re-decorated, but a quoted banner mid-part is left alone', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 20_000,
		});
		await activatePrWorkflow(directory, 'idempotent-session', 'PR_REVIEW');

		// Host hands back an already-bannered buffer (or the model opened its
		// turn by echoing the marker) → no second banner is stacked on top.
		const alreadyShort = { text: `${SHORT_MARKER}\n\nsome analysis` };
		await gate.textComplete(
			{ sessionID: 'idempotent-session', messageID: 'a1', partID: 'a-p1' },
			alreadyShort,
		);
		expect(alreadyShort.text).toBe(`${SHORT_MARKER}\n\nsome analysis`);

		// A reviewer lane quoting this repo's own banner literal MID-part is
		// legitimate review evidence — the guard is anchored at the start of the
		// part, so this text is still decorated normally and the quote survives.
		const quoting = {
			text: [
				'Reviewing `pr-workflow-response-gate.ts`. The emitter produces:',
				'```',
				SHORT_MARKER,
				'```',
				'which is prepended to the part.',
			].join('\n'),
		};
		await gate.textComplete(
			{ sessionID: 'idempotent-session', messageID: 'a2', partID: 'a-p2' },
			quoting,
		);
		expect(quoting.text).toContain(FULL_BANNER_MARKER);
		expect(quoting.text).toContain('which is prepended to the part.');
		// The quoted literal is preserved verbatim inside the fenced block.
		expect(quoting.text).toContain(`\`\`\`\n${SHORT_MARKER}\n\`\`\``);
	});

	test('when the host omits messageID, an absolute per-session ceiling bounds injections', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 20_000,
		});
		await activatePrWorkflow(directory, 'no-message-id', 'PR_REVIEW');

		let decorated = 0;
		// Far more parts than the ceiling, all without a messageID.
		for (let i = 0; i < MAX_FALLBACK_BANNER_INJECTIONS_PER_SESSION * 5; i++) {
			const part = { text: `thought ${i}` };
			await gate.textComplete({ sessionID: 'no-message-id' }, part);
			if (part.text !== `thought ${i}`) decorated++;
		}
		// Bounded — the pre-fix behavior would have decorated all 100.
		expect(decorated).toBe(MAX_FALLBACK_BANNER_INJECTIONS_PER_SESSION);
	});

	test('clearing the gate resets the per-message dedupe and the fallback ceiling', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 60_000,
		});
		await activatePrWorkflow(directory, 'reset-msg-session', 'PR_REVIEW');

		const first = { text: 'alpha' };
		await gate.textComplete(
			{ sessionID: 'reset-msg-session', messageID: 'same-msg', partID: 'p1' },
			first,
		);
		expect(first.text).toContain(FULL_BANNER_MARKER);

		const second = { text: 'beta' };
		await gate.textComplete(
			{ sessionID: 'reset-msg-session', messageID: 'same-msg', partID: 'p2' },
			second,
		);
		expect(second.text).toBe('beta');

		await clearPrWorkflowGateState(directory, 'reset-msg-session');
		const cleared = { text: 'gamma' };
		await gate.textComplete(
			{ sessionID: 'reset-msg-session', messageID: 'same-msg', partID: 'p3' },
			cleared,
		);
		expect(cleared.text).toBe('gamma');

		// Re-activate. Even though the SAME messageID is reused, the dedupe state
		// was dropped with the gate, so the notice returns in full.
		await activatePrWorkflow(directory, 'reset-msg-session', 'PR_REVIEW');
		const reactivated = { text: 'delta' };
		await gate.textComplete(
			{ sessionID: 'reset-msg-session', messageID: 'same-msg', partID: 'p4' },
			reactivated,
		);
		expect(reactivated.text).toContain(FULL_BANNER_MARKER);
		expect(reactivated.text).toContain('delta');
	});

	test('clearing the gate resets the banner cooldown so a re-activated session starts with a FULL banner', async () => {
		const gate = createPrWorkflowResponseGate({
			directory,
			bannerCooldownMs: 60_000,
		});
		await activatePrWorkflow(directory, 'reset-session', 'PR_REVIEW');

		// First part → full banner + stamp.
		const first = { text: 'alpha' };
		await gate.textComplete({ sessionID: 'reset-session' }, first);
		expect(first.text).toContain(FULL_BANNER_MARKER);

		// Second part within the (large) cooldown → short marker, confirming a
		// stamp exists that would otherwise persist.
		const second = { text: 'beta' };
		await gate.textComplete({ sessionID: 'reset-session' }, second);
		expect(second.text).toContain(SHORT_MARKER);
		expect(second.text).not.toContain(FULL_BANNER_MARKER);

		// Clear the gate (complete/abort). textComplete with no gate leaves the
		// text untouched AND drops the banner stamp via resetBudget.
		await clearPrWorkflowGateState(directory, 'reset-session');
		const cleared = { text: 'gamma' };
		await gate.textComplete({ sessionID: 'reset-session' }, cleared);
		expect(cleared.text).toBe('gamma');

		// Re-activate the SAME sessionID. Because the stamp was reset, the next
		// part is a FULL banner again — not a short marker inherited from the
		// pre-clear cooldown window (which is still open in wall-clock terms).
		await activatePrWorkflow(directory, 'reset-session', 'PR_REVIEW');
		const reactivated = { text: 'delta' };
		await gate.textComplete({ sessionID: 'reset-session' }, reactivated);
		expect(reactivated.text).toContain(FULL_BANNER_MARKER);
		expect(reactivated.text).toContain('delta');
	});
});

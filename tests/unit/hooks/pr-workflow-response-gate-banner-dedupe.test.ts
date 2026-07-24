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

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { _test_exports as autoWakeInternals } from '../../../src/hooks/pr-workflow-auto-wake.js';
import { _test_exports as workflowInternals } from '../../../src/hooks/pr-workflow-gate.js';
import {
	createPrWorkflowResponseGate,
	MAX_TRACKED_WAKE_SESSIONS,
} from '../../../src/hooks/pr-workflow-response-gate.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import {
	idleEventFor,
	makeTempDir,
	writeStateWithRevision,
} from './pr-workflow-response-gate-test-helpers.js';

let directory = '';

beforeEach(() => {
	directory = makeTempDir('pr-response-gate-eviction-');
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
});

afterEach(async () => {
	workflowInternals.resetTrackedStateCache();
	autoWakeInternals.reset();
	await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Regression: F-002. `evictIfOverBound` used to be plain insertion-order FIFO
 * — the oldest inserted entry was always the eviction victim, with no regard
 * for suspension state or whether the entry belonged to the session currently
 * being processed. That meant a live session's own budget could be evicted
 * and silently recreated (zeroed) on its very next idle wake, once enough
 * OTHER sessions had been tracked. The rewrite makes eviction LRU-by-
 * `lastWakeAt`, and it categorically excludes (1) suspended budgets and
 * (2) the session whose idle handler is currently running.
 */
describe('evictIfOverBound — regression: LRU eviction must not delete a live or suspended budget (F-002)', () => {
	test('a live session survives eviction across its own repeated idle events, even when the bound is saturated entirely by suspended entries', async () => {
		await withFrozenClockAsync(
			async () => {
				const promptAsync = mock(async () => ({}));
				const gate = createPrWorkflowResponseGate({
					directory,
					client: { session: { prompt: promptAsync, promptAsync } },
					maxConsecutiveUnproductiveWakes: 999_999,
					wakeCooldownMs: 0,
					// Tier S suspends after exactly one wake (cheap to saturate the
					// bound); tier L never suspends across the handful of wakes this
					// test drives.
					totalWakeCeiling: { S: 1, L: 999_999 },
				});

				// 1. Wake the "live" session once first, so it is the OLDEST entry by
				// insertion order — under the old FIFO eviction this made it the
				// canonical first victim.
				await writeStateWithRevision(directory, 'live-session', 1, 'L');
				await gate.event(idleEventFor('live-session'));
				const afterFirstWake = gate._inspectWakeBudget('live-session');
				expect(afterFirstWake?.suspended).toBe(false);
				expect(afterFirstWake?.totalWakes).toBe(1);

				// 2. Saturate the bound with MAX_TRACKED_WAKE_SESSIONS suspended
				// sessions (tier S, ceiling 1 — each suspends on its own first wake).
				for (let i = 0; i < MAX_TRACKED_WAKE_SESSIONS; i++) {
					const sessionID = `suspended-filler-${i}`;
					await writeStateWithRevision(directory, sessionID, 1, 'S');
					await gate.event(idleEventFor(sessionID));
					expect(gate._inspectWakeBudget(sessionID)?.suspended).toBe(true);
				}

				// 3. Wake the live session several more times. Each call triggers
				// evictIfOverBound with the map at or over the bound (1 live +
				// MAX_TRACKED_WAKE_SESSIONS suspended = MAX+1). Every other tracked
				// entry is suspended, so there is no evictable candidate other than
				// the live session itself — which must be categorically excluded.
				for (let i = 0; i < 5; i++) {
					await writeStateWithRevision(directory, 'live-session', i + 2, 'L');
					await gate.event(idleEventFor('live-session'));
				}

				const finalBudget = gate._inspectWakeBudget('live-session');
				// The live session's budget must have SURVIVED — it was never
				// evicted-and-recreated. Its totalWakes counter reflects the full
				// history of 1 + 5 = 6 wakes, not a reset-to-1 that would result
				// from recreation on any of the later idle events.
				expect(finalBudget).toBeDefined();
				expect(finalBudget?.suspended).toBe(false);
				expect(finalBudget?.totalWakes).toBe(6);
				// lastSeenRevision must reflect the latest wake's revision (6), which
				// is only possible if the SAME budget object accumulated state across
				// every call rather than being torn down and rebuilt.
				expect(finalBudget?.lastSeenRevision).toBe(6);
				// Positive lastWakeAt (see the fixedNow note on the sibling test):
				// keeps the live session on the ordinary LRU path rather than the
				// never-woken last-resort branch, so its survival is attributable to
				// the current-session/suspended rules under test.
				expect(finalBudget?.lastWakeAt).toBeGreaterThan(0);
			},
			{ fixedNow: 1_000, tickMs: 1 },
		);
	});

	test('among evictable (non-suspended, non-current) entries, the least-recently-woken one is evicted first, and a suspended entry is never the victim even when it has the smallest lastWakeAt', async () => {
		await withFrozenClockAsync(
			async () => {
				const promptAsync = mock(async () => ({}));
				const gate = createPrWorkflowResponseGate({
					directory,
					client: { session: { prompt: promptAsync, promptAsync } },
					maxConsecutiveUnproductiveWakes: 999_999,
					wakeCooldownMs: 0,
					totalWakeCeiling: { S: 1, L: 999_999 },
				});

				// Wake a tier-S session FIRST so it has the smallest lastWakeAt of
				// the entire population — and it suspends immediately (ceiling 1).
				await writeStateWithRevision(directory, 'suspended-oldest', 1, 'S');
				await gate.event(idleEventFor('suspended-oldest'));
				expect(gate._inspectWakeBudget('suspended-oldest')?.suspended).toBe(
					true,
				);

				// Fill the rest of the bound with non-suspended tier-L fillers,
				// each woken once, with strictly increasing lastWakeAt (the frozen
				// clock advances by 1ms per Date.now() call, and each event() call
				// reads Date.now() exactly once).
				const fillerCount = MAX_TRACKED_WAKE_SESSIONS - 1;
				for (let i = 0; i < fillerCount; i++) {
					const sessionID = `filler-${String(i).padStart(4, '0')}`;
					await writeStateWithRevision(directory, sessionID, 1, 'L');
					await gate.event(idleEventFor(sessionID));
					expect(gate._inspectWakeBudget(sessionID)?.suspended).toBe(false);
				}

				// Map size is now exactly MAX_TRACKED_WAKE_SESSIONS (1 suspended +
				// fillerCount non-suspended). Wake a brand-new session: eviction
				// runs first (size not yet over bound, no-op), then its entry is
				// inserted, pushing size to MAX+1.
				await writeStateWithRevision(directory, 'newcomer', 1, 'L');
				await gate.event(idleEventFor('newcomer'));

				// Wake ANOTHER brand-new session: this time eviction runs with the
				// map strictly over bound, so it must evict exactly one entry — the
				// least-recently-woken NON-SUSPENDED one, i.e. filler-0000 (the
				// oldest filler), never suspended-oldest (which has a smaller
				// lastWakeAt but is suspended).
				await writeStateWithRevision(directory, 'trigger', 1, 'L');
				await gate.event(idleEventFor('trigger'));

				expect(gate._inspectWakeBudget('suspended-oldest')).toBeDefined();
				expect(gate._inspectWakeBudget('filler-0000')).toBeUndefined();
				expect(gate._inspectWakeBudget('filler-0001')).toBeDefined();

				// The suspended entry must be spared by the SUSPENDED check, not
				// incidentally by the never-woken (`lastWakeAt <= 0`) last-resort
				// branch. `fixedNow` starts the frozen clock above zero precisely
				// so that every budget in this test carries a positive lastWakeAt
				// — without it the assertion above would pass for the wrong
				// reason and the suspended rule would be untested.
				expect(
					gate._inspectWakeBudget('suspended-oldest')?.lastWakeAt,
				).toBeGreaterThan(0);
			},
			{ fixedNow: 1_000, tickMs: 1 },
		);
	});
});

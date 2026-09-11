import { beforeEach, describe, expect, test, vi } from 'bun:test';

vi.mock('../../telemetry', () => ({
	telemetry: {
		prmEscalationTriggered: vi.fn(),
		prmHardStop: vi.fn(),
		prmHardStopTerminal: vi.fn(),
	},
}));

import { telemetry } from '../../telemetry';
import {
	createDefaultEscalationState,
	EscalationTracker,
	PRM_HARD_STOP_TERMINAL_EVENT,
	resolveLadderKey,
} from '../escalation';
import type { PatternMatch, PrmEpisodeState } from '../types';

/**
 * Issue #2678 — the bounded hard-stop episode: one trigger per false-to-true
 * transition, terminal/handoff after the bound, cooldown, action-local and
 * owner-checked clears, distinct counters.
 */

function match(overrides: Partial<PatternMatch> = {}): PatternMatch {
	return {
		pattern: 'repetition_loop',
		severity: 'medium',
		category: 'coordination_error',
		stepRange: [1, 3],
		description: 'issue-2678 test',
		affectedAgents: ['agent-a'],
		affectedTargets: ['src/foo.ts'],
		occurrenceCount: 1,
		...overrides,
	};
}

function otherLadderMatch(): PatternMatch {
	return match({ affectedTargets: ['src/bar.ts'] });
}

describe('issue #2678 — bounded PRM hard-stop episode', () => {
	const terminalEvent = telemetry.prmHardStopTerminal as ReturnType<
		typeof vi.fn
	>;
	const triggerEvent = telemetry.prmHardStop as ReturnType<typeof vi.fn>;

	beforeEach(() => {
		triggerEvent.mockClear();
		terminalEvent.mockClear();
		(telemetry.prmEscalationTriggered as ReturnType<typeof vi.fn>).mockClear();
	});

	test('PRM_HARD_STOP_TERMINAL_EVENT names the distinct terminal telemetry event', () => {
		expect(PRM_HARD_STOP_TERMINAL_EVENT).toBe('prm_hard_stop_terminal');
		expect(PRM_HARD_STOP_TERMINAL_EVENT).not.toBe('prm_hard_stop');
		expect(PRM_HARD_STOP_TERMINAL_EVENT).not.toBe('prm_hard_stop_delivered');
	});

	test('trigger telemetry fires exactly once per false-to-true transition across 7 same-ladder detections', () => {
		const tracker = new EscalationTracker('sess-2678');
		for (let i = 0; i < 7; i += 1) {
			tracker.recordDetection(match());
		}
		expect(triggerEvent).toHaveBeenCalledTimes(1);
		expect(terminalEvent).toHaveBeenCalledTimes(1);
	});

	test('the episode state machine: stop -> terminal -> stable cooldown absorption', () => {
		const tracker = new EscalationTracker('sess-2678');

		tracker.recordDetection(match()); // count 1 — level 1
		tracker.recordDetection(match()); // count 2 — level 2
		const r3 = tracker.recordDetection(match()); // count 3 — first stop
		expect(r3.hardStop).toBe(true);
		expect(r3.terminal).toBe(false);

		const r4 = tracker.recordDetection(match()); // first repeat — TERMINAL
		expect(r4.level).toBe(3);
		expect(r4.hardStop).toBe(false);
		expect(r4.terminal).toBe(true);
		expect(r4.correction?.alert).toContain('TERMINAL');

		const state4 = tracker.getState();
		const episode4 = state4.episodes.get(resolveLadderKey(match()));
		expect(episode4?.terminal).toBe(true);
		expect(episode4?.cooldownUntil).toBeGreaterThan(Date.now());
		expect(episode4?.hardStopTriggered).toBe(true);

		// Post-terminal detections inside the cooldown: stable, no re-arm,
		// no further telemetry.
		const r5 = tracker.recordDetection(match());
		const r6 = tracker.recordDetection(match());
		expect(r5.hardStop).toBe(false);
		expect(r5.terminal).toBe(true);
		expect(r6.hardStop).toBe(false);
		expect(r6.terminal).toBe(true);
		expect(triggerEvent).toHaveBeenCalledTimes(1);
		expect(terminalEvent).toHaveBeenCalledTimes(1);
		// The episode marker stays present and stable (key set does not
		// oscillate).
		expect(
			tracker.getState().episodes.get(resolveLadderKey(match()))?.terminal,
		).toBe(true);
	});

	test('cooldown lapse reinitializes the episode while preserving the ladder count; a fresh episode re-fires the trigger', () => {
		const tracker = new EscalationTracker('sess-2678');
		const seedState = createDefaultEscalationState();
		// Drive to terminal, then backdate the cooldown so the next detection
		// lapses it.
		for (let i = 0; i < 4; i += 1) tracker.recordDetection(match());
		const internal = tracker.getState();
		const lapsed: typeof internal = {
			...internal,
			episodes: new Map(
				[...internal.episodes].map(([key, ep]) => [
					key,
					{ ...ep, cooldownUntil: Date.now() - 1 },
				]),
			),
		};
		const lapsedTracker = new EscalationTracker('sess-2678', lapsed);
		triggerEvent.mockClear();
		terminalEvent.mockClear();

		const r = lapsedTracker.recordDetection(match());
		// Fresh episode at count 5 (>=3): a NEW false-to-true transition fires
		// the trigger again and re-arms the stop.
		expect(r.hardStop).toBe(true);
		expect(r.terminal).toBe(false);
		expect(triggerEvent).toHaveBeenCalledTimes(1);
		expect(
			lapsedTracker.getState().patternCounts.get(resolveLadderKey(match())),
		).toBe(5);
	});

	test('clearAction is action-local: the cleared ladder recovers, the unrelated ladder is untouched', () => {
		const tracker = new EscalationTracker('sess-2678');
		// Ladder A to terminal.
		for (let i = 0; i < 4; i += 1) tracker.recordDetection(match());
		// Ladder B to level 2.
		tracker.recordDetection(otherLadderMatch());
		tracker.recordDetection(otherLadderMatch());
		expect(tracker.getState().escalationLevel).toBe(2);

		const cleared = tracker.clearAction(match());
		expect(cleared).toBe(true);

		const rA = tracker.recordDetection(match());
		expect(rA.level).toBe(1); // cleared ladder starts over
		const rB = tracker.recordDetection(otherLadderMatch());
		expect(rB.level).toBe(3); // unrelated ladder escalates independently
		expect(rB.hardStop).toBe(true);
		// A's episode was cleared with its ladder; B now owns its own
		// (first-stop, not terminal) episode.
		expect(tracker.getState().episodes.has(resolveLadderKey(match()))).toBe(
			false,
		);
		const episodeB = tracker
			.getState()
			.episodes.get(resolveLadderKey(otherLadderMatch()));
		expect(episodeB?.hardStopTriggered).toBe(true);
		expect(episodeB?.terminal).toBe(false);
	});

	test('owner-checked clears: stale generation and foreign session fail closed; exact owner clears and advances generation', () => {
		const SESSION = 'sess-2678';
		const tracker = new EscalationTracker(SESSION);
		for (let i = 0; i < 4; i += 1) tracker.recordDetection(match());
		const generation = tracker.getGeneration();
		expect(generation).toBeGreaterThanOrEqual(2); // trigger + terminal

		const before = tracker.getState();
		const stale = tracker.clearAction(match(), {
			sessionId: SESSION,
			generation: generation - 1,
		});
		expect(stale).toBe(false);
		expect(tracker.getState().patternCounts).toEqual(before.patternCounts);

		const foreign = tracker.clearAction(match(), {
			sessionId: 'sess-other',
			generation,
		});
		expect(foreign).toBe(false);
		expect(tracker.getState().episodes.size).toBe(before.episodes.size);

		const exact = tracker.clearAction(match(), {
			sessionId: SESSION,
			generation,
		});
		expect(exact).toBe(true);
		expect(tracker.getGeneration()).toBe(generation + 1);
		expect(
			tracker.getState().patternCounts.has(resolveLadderKey(match())),
		).toBe(false);
		// The terminal state is gone — the ladder can re-escalate.
		const r = tracker.recordDetection(match());
		expect(r.level).toBe(1);
	});

	test('ownerless clearAction leaves the generation untouched (in-session corrected success)', () => {
		const tracker = new EscalationTracker('sess-2678');
		for (let i = 0; i < 4; i += 1) tracker.recordDetection(match());
		const generation = tracker.getGeneration();
		expect(tracker.clearAction(match())).toBe(true);
		expect(tracker.getGeneration()).toBe(generation);
	});

	test('episode map is bounded and evicted together with the ladder counts', () => {
		const tracker = new EscalationTracker('sess-2678');
		const many: PatternMatch[] = [];
		for (let i = 0; i < 300; i += 1) {
			const m = match({ affectedTargets: [`src/file-${i}.ts`] });
			many.push(m);
			tracker.recordDetection(m);
		}
		const state = tracker.getState();
		expect(state.patternCounts.size).toBeLessThanOrEqual(256);
		expect(state.episodes.size).toBeLessThanOrEqual(256);
		// Episode keys are a subset of ladder keys — no orphaned episodes.
		for (const key of state.episodes.keys()) {
			expect(state.patternCounts.has(key)).toBe(true);
		}
	});

	test('getEpisodes returns a defensive copy', () => {
		const tracker = new EscalationTracker('sess-2678');
		for (let i = 0; i < 4; i += 1) tracker.recordDetection(match());
		const snapshot: Map<string, PrmEpisodeState> = tracker.getEpisodes();
		snapshot.get(resolveLadderKey(match()))!.terminal = false;
		expect(
			tracker.getState().episodes.get(resolveLadderKey(match()))?.terminal,
		).toBe(true);
	});

	test('reset() clears the whole tracker including episodes and generation (delegation boundary)', () => {
		const tracker = new EscalationTracker('sess-2678');
		for (let i = 0; i < 4; i += 1) tracker.recordDetection(match());
		tracker.reset();
		const state = tracker.getState();
		expect(state.episodes.size).toBe(0);
		expect(state.generation).toBe(0);
		expect(state.hardStopPending).toBe(false);
		expect(state.patternCounts.size).toBe(0);
	});
});

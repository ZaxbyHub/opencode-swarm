/**
 * Escalation Tracker Module
 * Implements a 3-strike protocol for pattern detection escalation
 */

import { telemetry } from '../telemetry';
import type {
	CourseCorrection,
	EscalationState,
	PatternMatch,
	PatternType,
	PrmEpisodeState,
} from './types';

/**
 * Issue #2678 — telemetry event name for the TERMINAL/handoff transition of a
 * PRM hard-stop episode. Distinct from `prm_hard_stop` (the TRIGGER, fired
 * once per false-to-true transition) and `prm_hard_stop_delivered` (the
 * DELIVERY, emitted by the guardrails deny consumer): the three counters are
 * noninterchangeable.
 */
export const PRM_HARD_STOP_TERMINAL_EVENT = 'prm_hard_stop_terminal';

/**
 * Issue #2678 — hard-stop detections after the first one (within one episode)
 * before the episode escalates to its bounded TERMINAL/handoff state.
 */
export const PRM_HARD_STOP_TERMINAL_REPEATS = 1;

/**
 * Issue #2678 — after a terminal handoff, re-escalation of the SAME ladder is
 * suppressed for this window unless an owner-verified `clearAction` clears the
 * episode first. 15 minutes mirrors the pattern-persistence cooldown budget.
 */
export const PRM_TERMINAL_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Upper bound on distinct escalation ladders tracked per session (issue #2134).
 *
 * The ladder is keyed per `(pattern, target)` for a single-target pattern, and
 * targets are unbounded, so this map would otherwise grow without limit on a
 * long-running session. Matches `MAX_TRACKED_EPISODES` in `index.ts`, which
 * bounds the episode ledger for the same reason.
 */
const MAX_TRACKED_LADDERS = 256;

/**
 * Resolves the LADDER key for a match — the identity whose 1→2→3 strike count
 * this detection belongs to (issue #2134 follow-up).
 *
 * The ladder used to be keyed by pattern TYPE alone, so unrelated occurrences
 * accumulated into one count: a coder that read-then-re-read three different
 * files produced three `repetition_loop` strikes on three different targets and
 * hit the hard stop, even though it had not repeated itself even twice on any
 * one of them. "Three strikes" has to mean "the same behaviour three times".
 *
 * A pattern reporting exactly ONE affected target gets a per-target ladder —
 * `repetition_loop`, `ping_pong` and `stuck_on_test` all name the single file or
 * target they are about, so that target IS the behaviour's identity.
 *
 * A pattern reporting a SET of targets keeps the per-pattern-type ladder.
 * `context_thrash` and `expansion_drift` describe one ongoing episode over a
 * growing collection of targets; keying those by target would mint a fresh
 * ladder on every tool call and they could never escalate at all — the exact
 * fail-open shape that the per-detector containment review caught the first time.
 *
 * Agents are deliberately not in the key. Escalation is about the work, not who
 * did it, and `ping_pong` names two agents by construction.
 */
export function resolveLadderKey(match: PatternMatch): string {
	return match.affectedTargets.length === 1
		? `${match.pattern}|${match.affectedTargets[0]}`
		: match.pattern;
}

/**
 * Creates a default EscalationState with all counters reset and flags cleared.
 * Exported for testing purposes.
 *
 * @returns A fresh EscalationState with default values
 */
export function createDefaultEscalationState(): EscalationState {
	return {
		patternCounts: new Map<PatternType, number>(),
		escalationLevel: 0,
		lastPatternDetected: null,
		hardStopPending: false,
		episodes: new Map<string, PrmEpisodeState>(),
		generation: 0,
	};
}

function cloneEscalationState(state: EscalationState): EscalationState {
	return {
		patternCounts: new Map(state.patternCounts),
		escalationLevel: state.escalationLevel,
		lastPatternDetected: state.lastPatternDetected
			? {
					...state.lastPatternDetected,
					stepRange: [...state.lastPatternDetected.stepRange] as [
						number,
						number,
					],
					affectedAgents: [...state.lastPatternDetected.affectedAgents],
					affectedTargets: [...state.lastPatternDetected.affectedTargets],
				}
			: null,
		hardStopPending: state.hardStopPending,
		// Issue #2678: one-level clone per entry is sufficient — each
		// PrmEpisodeState is a flat literal (no nested maps/arrays).
		episodes: new Map(
			[...state.episodes].map(([key, episode]) => [key, { ...episode }]) as [
				string,
				PrmEpisodeState,
			][],
		),
		generation: state.generation,
	};
}

/**
 * Generates a CourseCorrection from a PatternMatch.
 * Uses simple templates based on pattern type and escalation level.
 *
 * @param match - The pattern match to generate a correction for
 * @param level - The escalation level (1, 2, or 3)
 * @returns A CourseCorrection object
 */
function generateCorrection(
	match: PatternMatch,
	level: number,
	terminal = false,
): CourseCorrection {
	const levelPrefix =
		level === 1
			? 'GUIDANCE'
			: level === 2
				? 'STRONG GUIDANCE'
				: terminal
					? 'HARD STOP (TERMINAL — HAND OFF)'
					: 'HARD STOP';

	const alertTemplates: Record<PatternType, string> = {
		repetition_loop: `${levelPrefix}: Repetitive action loop detected`,
		ping_pong: `${levelPrefix}: Delegation ping-pong detected`,
		expansion_drift: `${levelPrefix}: Scope expansion drift detected`,
		stuck_on_test: `${levelPrefix}: Stuck in edit-test cycle`,
		context_thrash: `${levelPrefix}: Excessive context requests detected`,
	};

	const guidanceTemplates: Record<PatternType, string> = {
		repetition_loop:
			'Stop the repetitive loop. Consolidate changes and take a different approach.',
		ping_pong:
			'Interrupt the delegation cycle. Architect should take direct control.',
		expansion_drift:
			'Freeze scope expansion. Complete current task before adding more work.',
		stuck_on_test:
			'Pause edit-test cycle. Review test expectations and verify environment.',
		context_thrash:
			'Restrict file access. Use targeted selection instead of broad context requests.',
	};

	const actionTemplates: Record<PatternType, string> = {
		repetition_loop: 'Consolidate changes and change approach immediately.',
		ping_pong:
			'Architect take direct control or redefine agent task boundaries.',
		expansion_drift:
			'Document progress and create follow-up issue for additional work.',
		stuck_on_test:
			'Review test expectations, verify environment, consult SME if needed.',
		context_thrash:
			'Restrict to only the specific files needed for the current task.',
	};

	return {
		alert: alertTemplates[match.pattern],
		category: match.category,
		guidance: guidanceTemplates[match.pattern],
		action: actionTemplates[match.pattern],
		pattern: match.pattern,
		stepRange: match.stepRange,
	};
}

/**
 * EscalationTracker
 *
 * Tracks pattern detection counts per session and implements a 3-strike escalation protocol:
 * - Level 1 (1st detection): Guidance via pendingAdvisoryMessages
 * - Level 2 (2nd detection): Stronger guidance + architect alert via telemetry
 * - Level 3 (3rd+ detection): Hard stop flag that is read by messagesTransform
 *
 * All methods are safe and never throw errors.
 */
export class EscalationTracker {
	private readonly _sessionId: string;
	private _state: EscalationState;

	/**
	 * Creates a new EscalationTracker for the given session.
	 *
	 * @param sessionId - The session identifier
	 * @param initialState - Optional initial state to restore (for session resumption)
	 */
	constructor(sessionId: string, initialState?: EscalationState) {
		this._sessionId = sessionId;
		const seed = initialState ?? createDefaultEscalationState();
		// Issue #2678: partial/legacy seed objects (and tests) may predate the
		// episode fields — normalize instead of crashing on the first read.
		this._state = {
			...seed,
			episodes: seed.episodes ?? new Map(),
			generation: seed.generation ?? 0,
		};
	}

	/**
	 * Records a pattern detection and determines the escalation level.
	 * Updates internal state based on the 3-strike protocol.
	 *
	 * @param match - The pattern match to record
	 * @returns An object containing the escalation level, correction (if any), and hard stop flag
	 */
	recordDetection(match: PatternMatch): {
		level: number;
		correction: CourseCorrection | null;
		hardStop: boolean;
		/** Issue #2678 — this detection is the (or is inside the) bounded
		 * TERMINAL/handoff state of the ladder's episode. */
		terminal: boolean;
	} {
		// Get the current count for this match's LADDER identity — not for its
		// pattern type. See `resolveLadderKey`: a single-target pattern gets a
		// ladder per target, so repeating yourself once each on three different
		// files is three level-1 advisories rather than a hard stop.
		const ladderKey = resolveLadderKey(match);

		// Issue #2678: the bounded episode. A terminal episode inside its
		// cooldown absorbs further detections — no count advance, no telemetry,
		// no stop re-arming (the unbounded stop loop ends here). After the
		// cooldown lapses the episode reinitializes (count preserved) so a
		// genuinely continuing pattern may re-escalate through a FRESH episode,
		// firing the trigger again on the new false-to-true transition.
		const episode = this._state.episodes.get(ladderKey);
		if (episode?.terminal) {
			if (Date.now() < episode.cooldownUntil) {
				this._state.lastPatternDetected = match;
				this._state.escalationLevel = 3;
				return {
					level: 3,
					correction: generateCorrection(match, 3, true),
					hardStop: false,
					terminal: true,
				};
			}
			// Cooldown lapsed: fresh episode, ladder count continues.
			this._state.episodes.set(ladderKey, {
				hardStopTriggered: false,
				repeats: 0,
				terminal: false,
				cooldownUntil: 0,
			});
		}

		const currentCount = this._state.patternCounts.get(ladderKey) ?? 0;
		const newCount = currentCount + 1;

		// Bound the map. A per-target ladder mints a key per (pattern, target) and
		// targets are unbounded — a long architect session with no tool-call budget
		// would otherwise grow this without limit on a hot, per-tool-call object,
		// with each key carrying a target string up to 200 chars. Map preserves
		// insertion order, so dropping from the front evicts the least recently
		// FIRST-SEEN ladder. Mirrors `MAX_TRACKED_EPISODES` in `index.ts`, which
		// bounds the episode ledger for exactly this reason.
		//
		// Re-inserting the key just updated keeps a still-active ladder at the back
		// of the eviction order, so the ladder an agent is actively tripping is the
		// last thing evicted rather than the first.
		this._state.patternCounts.delete(ladderKey);
		this._state.patternCounts.set(ladderKey, newCount);
		while (this._state.patternCounts.size > MAX_TRACKED_LADDERS) {
			const oldest = this._state.patternCounts.keys().next().value;
			if (oldest === undefined) break;
			this._state.patternCounts.delete(oldest);
			// Issue #2678: the episode record shares the ladder keyspace — evict
			// together so neither map outlives its counterpart's identity.
			this._state.episodes.delete(oldest);
		}

		// Update last pattern detected
		this._state.lastPatternDetected = match;

		// Determine escalation level based on detection count
		if (newCount === 1) {
			// Level 1: First detection - guidance via pendingAdvisoryMessages
			const correction = generateCorrection(match, 1);
			this._state.escalationLevel = 1;

			return {
				level: 1,
				correction,
				hardStop: false,
				terminal: false,
			};
		} else if (newCount === 2) {
			// Level 2: Second detection - stronger guidance
			const correction = generateCorrection(match, 2);
			this._state.escalationLevel = 2;

			// Emit escalation event to telemetry
			telemetry.prmEscalationTriggered(
				this._sessionId,
				match.pattern,
				2,
				newCount,
			);

			return {
				level: 2,
				correction,
				hardStop: false,
				terminal: false,
			};
		} else {
			// Level 3: Third or more detection — the bounded hard-stop EPISODE
			// (issue #2678). The trigger telemetry fires ONCE per episode, on the
			// false-to-true transition; a repeated stop escalates the episode to
			// TERMINAL/handoff (emitting the distinct terminal event once) after
			// which no further stop re-arming happens for this ladder until the
			// cooldown lapses or an owner-verified clear resets it.
			const ladderEpisode =
				this._state.episodes.get(ladderKey) ??
				({
					hardStopTriggered: false,
					repeats: 0,
					terminal: false,
					cooldownUntil: 0,
				} satisfies PrmEpisodeState);
			this._state.escalationLevel = 3;

			if (!ladderEpisode.hardStopTriggered) {
				// First hard stop of this episode: the false-to-true transition.
				ladderEpisode.hardStopTriggered = true;
				this._state.generation += 1;
				this._state.hardStopPending = true;
				this._state.episodes.set(ladderKey, ladderEpisode);
				telemetry.prmHardStop(this._sessionId, match.pattern, 3, newCount);

				return {
					level: 3,
					correction: generateCorrection(match, 3),
					hardStop: true,
					terminal: false,
				};
			}

			ladderEpisode.repeats += 1;
			if (ladderEpisode.repeats >= PRM_HARD_STOP_TERMINAL_REPEATS) {
				// The bounded terminal transition: escalate to handoff, emit the
				// distinct terminal event ONCE, arm the cooldown, and STOP
				// re-arming the stop tokens for this ladder.
				ladderEpisode.terminal = true;
				ladderEpisode.cooldownUntil = Date.now() + PRM_TERMINAL_COOLDOWN_MS;
				this._state.generation += 1;
				this._state.episodes.set(ladderKey, ladderEpisode);
				telemetry.prmHardStopTerminal(
					this._sessionId,
					match.pattern,
					3,
					newCount,
				);

				return {
					level: 3,
					correction: generateCorrection(match, 3, true),
					hardStop: false,
					terminal: true,
				};
			}

			// Between the first stop and the terminal bound: the stop holds
			// (re-armed) but the trigger does not re-fire — one advisory per
			// transition.
			this._state.episodes.set(ladderKey, ladderEpisode);
			this._state.hardStopPending = true;
			return {
				level: 3,
				correction: generateCorrection(match, 3),
				hardStop: true,
				terminal: false,
			};
		}
	}

	/**
	 * Returns a defensive copy of the current escalation state.
	 *
	 * @returns The current EscalationState copy
	 */
	getState(): EscalationState {
		return cloneEscalationState(this._state);
	}

	/**
	 * Returns a defensive copy of just the ladder counts (issue #2134 follow-up).
	 *
	 * `src/prm/index.ts` mirrors these onto the session after every strike so a
	 * tracker rebuilt mid-session restores the same keyspace it counts in. Using
	 * `getState()` there deep-cloned the whole state — including `stepRange`,
	 * `affectedAgents` and `affectedTargets` of the last match — on the
	 * per-tool-call hot path, for one field.
	 */
	getLadderCounts(): Map<string, number> {
		return new Map(this._state.patternCounts);
	}

	/**
	 * Defensive copy of the per-ladder episode state (issue #2678) — the
	 * `getLadderCounts` precedent: producers mirror this onto the session so a
	 * tracker rebuilt mid-session restores the same episode keyspace.
	 */
	getEpisodes(): Map<string, PrmEpisodeState> {
		return new Map(
			[...this._state.episodes].map(([key, episode]) => [
				key,
				{ ...episode },
			]) as [string, PrmEpisodeState][],
		);
	}

	/** Current generation (issue #2678) — advances on every episode-state
	 * transition; owner-checked resets must match it exactly. */
	getGeneration(): number {
		return this._state.generation;
	}

	/**
	 * Action-local corrected-success clear (issue #2678): clears ONLY the
	 * matching ladder (its strike count and its episode record — the next
	 * detection starts at level 1) and leaves every unrelated ladder touched.
	 *
	 * Owner semantics: an ownerless call (in-session corrected success —
	 * possession of the tracker IS the session binding) proceeds. When an
	 * `owner` is provided it must match this tracker's exact `sessionId` AND
	 * the current `generation`, else the clear fails closed (returns false,
	 * state untouched) — a stale-generation or foreign-session reset can never
	 * clear current recovery state. Generation advances only on an
	 * owner-provided, matching clear.
	 */
	clearAction(
		matchOrKey: PatternMatch | string,
		owner?: { sessionId: string; generation: number },
	): boolean {
		if (
			owner !== undefined &&
			(owner.sessionId !== this._sessionId ||
				owner.generation !== this._state.generation)
		) {
			return false;
		}
		const ladderKey =
			typeof matchOrKey === 'string'
				? matchOrKey
				: resolveLadderKey(matchOrKey);
		this._state.patternCounts.delete(ladderKey);
		this._state.episodes.delete(ladderKey);
		// A successful clear retires the one-shot stop token: the corrected
		// action's stop was its source, and the producer re-arms the token on
		// any further qualifying detection anyway. Without this, an
		// owner-verified corrected success could still be denied once by the
		// stop it just cleared (issue #2678: "a corrected successful execution
		// may clear only its matching action circuits").
		this._state.hardStopPending = false;
		if (owner !== undefined) {
			this._state.generation += 1;
		}
		return true;
	}

	/**
	 * Resets all escalation counts and flags to their default values.
	 * Clears pattern counts and all flags.
	 */
	reset(): void {
		this._state = createDefaultEscalationState();
	}

	/**
	 * Returns whether a hard stop is pending.
	 * This flag is read by messagesTransform to halt agent execution.
	 *
	 * @returns true if hard stop is pending, false otherwise
	 */
	isHardStopPending(): boolean {
		return this._state.hardStopPending;
	}
}

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
} from './types';

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
): CourseCorrection {
	const levelPrefix =
		level === 1 ? 'GUIDANCE' : level === 2 ? 'STRONG GUIDANCE' : 'HARD STOP';

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
		this._state = initialState ?? createDefaultEscalationState();
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
	} {
		// Get the current count for this match's LADDER identity — not for its
		// pattern type. See `resolveLadderKey`: a single-target pattern gets a
		// ladder per target, so repeating yourself once each on three different
		// files is three level-1 advisories rather than a hard stop.
		const ladderKey = resolveLadderKey(match);
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
			};
		} else {
			// Level 3: Third or more detection - hard stop
			const correction = generateCorrection(match, 3);
			this._state.escalationLevel = 3;
			this._state.hardStopPending = true;

			// Emit hard stop event to telemetry
			telemetry.prmHardStop(this._sessionId, match.pattern, 3, newCount);

			return {
				level: 3,
				correction,
				hardStop: true,
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

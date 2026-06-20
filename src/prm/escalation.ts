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
		correctionsPending: [],
	};
}

function cloneCourseCorrection(correction: CourseCorrection): CourseCorrection {
	return {
		...correction,
		stepRange: [...correction.stepRange] as [number, number],
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
		correctionsPending: state.correctionsPending.map(cloneCourseCorrection),
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
		// Get current count for this pattern type
		const currentCount = this._state.patternCounts.get(match.pattern) ?? 0;
		const newCount = currentCount + 1;

		// Update the pattern count
		this._state.patternCounts.set(match.pattern, newCount);

		// Update last pattern detected
		this._state.lastPatternDetected = match;

		// Determine escalation level based on detection count
		if (newCount === 1) {
			// Level 1: First detection - guidance via pendingAdvisoryMessages
			const correction = generateCorrection(match, 1);
			this._state.correctionsPending.push(correction);
			this._state.escalationLevel = 1;

			return {
				level: 1,
				correction,
				hardStop: false,
			};
		} else if (newCount === 2) {
			// Level 2: Second detection - stronger guidance
			const correction = generateCorrection(match, 2);
			this._state.correctionsPending.push(correction);
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
			this._state.correctionsPending.push(correction);
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
	 * Resets all escalation counts and flags to their default values.
	 * Clears pattern counts, corrections pending, and all flags.
	 */
	reset(): void {
		this._state = createDefaultEscalationState();
	}

	/**
	 * Returns defensive copies of all pending course corrections.
	 *
	 * @returns Array of pending CourseCorrection objects
	 */
	getPendingCorrections(): CourseCorrection[] {
		return this._state.correctionsPending.map(cloneCourseCorrection);
	}

	/**
	 * Clears all pending course corrections.
	 */
	clearPendingCorrections(): void {
		this._state.correctionsPending = [];
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

/**
 * Execution-episode seam (issue #2063 B3/B5).
 *
 * An "execution episode" is the window in which a session has actually
 * attempted execution work — a `Task` dispatch to a mutating/verifying role, or
 * an `update_task_status(..., in_progress)` that succeeded. Containment levers
 * that would produce false positives during ordinary conversation, planning, or
 * read-only review are gated on the episode being ARMED.
 *
 * This module is deliberately narrow: it owns nothing but the read/write of the
 * `executionEpisodeArmed` session field, so that
 *
 *   - the CONSUMER side (B3's medium-band runaway counting in
 *     `messages-transform.ts`) has a single, testable predicate, and
 *   - the PRODUCER side (B5's arming/lapse policy in `execution-stall.ts`)
 *     has a single, testable mutator to call.
 *
 * Keeping the field access behind these two functions is what prevents the
 * arming policy from being duplicated at each call site as it grows.
 *
 * Defaults are fail-open toward "not armed": an unknown session, a session with
 * no state, and a session whose field was never initialised all read `false`,
 * so a lever gated on this seam stays silent rather than firing on a session it
 * knows nothing about.
 */

import { swarmState } from '../../state';

/**
 * Whether an execution episode is currently armed for `sessionID`.
 *
 * Returns `false` for unknown sessions.
 */
export function isExecutionEpisodeArmed(sessionID: string): boolean {
	return (
		swarmState.agentSessions.get(sessionID)?.executionEpisodeArmed === true
	);
}

/**
 * Arm or disarm the execution episode for `sessionID`.
 *
 * No-ops for an unknown session: arming state is meaningless without a session
 * to hang it on, and creating one here would let a containment lever
 * materialise session state as a side effect.
 *
 * @returns `true` when the field was written, `false` when the session is unknown.
 */
export function setExecutionEpisodeArmed(
	sessionID: string,
	armed: boolean,
): boolean {
	const session = swarmState.agentSessions.get(sessionID);
	if (!session) return false;
	session.executionEpisodeArmed = armed;
	return true;
}

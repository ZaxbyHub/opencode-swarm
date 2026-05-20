/**
 * General Council Mode — advisory routing helper.
 *
 * Sibling to ./council-advisory.ts (which is hard-typed to CouncilSynthesis
 * for the verdict-based Work Complete Council). This helper accepts a
 * GeneralCouncilResult and renders an advisory body the architect will see
 * on its next turn via the standard pendingAdvisoryMessages → ADVISORIES
 * messagesTransform flow.
 *
 * Design choices:
 *   - No dedup. The general council is user-triggered (`/swarm council ...`);
 *     a user asking the same question twice expects two advisories. The
 *     QA-council dedup-by-taskId-and-round semantic doesn't apply here —
 *     general council has no taskId.
 *   - No "blocking" header. The general council is advisory by definition.
 *     Use a clear visual marker so the architect distinguishes it from the
 *     QA council's blocking advisories.
 */

import type { AgentSessionState } from '../state';
import type { GeneralCouncilResult } from './general-council-types.js';

const ADVISORY_HEADER = '[general_council] (advisory; not blocking)';

/**
 * Push a GeneralCouncilResult into the architect's advisory queue. The body
 * is the structural synthesis markdown returned by `convene_general_council`.
 *
 * Safe to call: missing session or empty advisory body silently skips.
 * Always idempotent at the architect-prompt level (no duplicate-suppression
 * here — see header comment for rationale).
 */
export function pushGeneralCouncilAdvisory(
	session: Pick<AgentSessionState, 'pendingAdvisoryMessages'>,
	result: GeneralCouncilResult,
): void {
	if (!session) return;
	const body = renderAdvisoryBody(result);
	if (!body) return;

	session.pendingAdvisoryMessages ??= [];
	session.pendingAdvisoryMessages.push(`${ADVISORY_HEADER}\n${body}`);
}

function renderAdvisoryBody(result: GeneralCouncilResult): string {
	// Post-refactor the architect synthesizes the final user-facing answer
	// directly from `result.synthesis` using inline output rules, so there
	// is no separate moderator output to append. The deprecated
	// `moderatorOutput` field on the type is intentionally not read here —
	// it is never populated at runtime, and surfacing it would only matter
	// for stale evidence files which are out of scope for live advisories.
	return result.synthesis.trim();
}

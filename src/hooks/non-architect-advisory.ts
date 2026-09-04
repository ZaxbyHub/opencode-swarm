import { stripKnownSwarmPrefix } from '../config/schema';
import { ensureAgentSession, swarmState } from '../state';
import { pushAdvisory } from '../utils/advisory-queue';

/**
 * Issue #2493 (K3 UX-3): one-time first-run advisory when a session runs on a
 * non-architect agent. The OpenCode plugin v1 shape has no session-start hook,
 * so "session starts on a non-architect agent" is operationalized as the first
 * user message observed on a non-architect agent (the chat.message hook calls
 * this on every message; the one-shot flag makes it fire once per sessionID).
 *
 * Invariant 8: the guard lives on AgentSessionState (session-keyed, bounded by
 * the existing session-state eviction) — no new module-level session map.
 */
export const NON_ARCHITECT_ADVISORY_KEY = '[non-architect-advisory]';

// Host-internal OpenCode agents that never carry user chat (the
// user-selectable built-ins are build/plan/general/explore). The advisory must
// not fire for internal housekeeping agents.
const HOST_INTERNAL_AGENTS = new Set(['compaction', 'title', 'summary']);

/**
 * Emit the one-time non-architect advisory for `sessionID` when `agentName`
 * identifies a user-facing, non-architect agent. Returns true when the
 * advisory was enqueued this call. Fail-open by contract: callers wrap in
 * try/catch so an advisory failure can never block message processing.
 */
export function maybeEmitNonArchitectAdvisory(
	sessionID: string,
	agentName: string,
): boolean {
	if (!sessionID || !agentName.trim()) return false;
	const role = stripKnownSwarmPrefix(agentName);
	if (role === 'architect') return false;
	if (HOST_INTERNAL_AGENTS.has(role)) return false;

	const session =
		swarmState.agentSessions.get(sessionID) ?? ensureAgentSession(sessionID);
	if (!session || session.nonArchitectAdvisoryDone) return false;

	const enqueued = pushAdvisory(
		session,
		`[swarm] This session is running on "${agentName}", not a swarm architect. The gated pipeline (plan approval, delegation gates, scoped writes) is only active on architect sessions. Switch to an architect agent or set auto_select_architect in opencode-swarm.json. ${NON_ARCHITECT_ADVISORY_KEY}`,
		{ dedupeKey: NON_ARCHITECT_ADVISORY_KEY },
	);
	if (enqueued) {
		session.nonArchitectAdvisoryDone = true;
	}
	return enqueued;
}

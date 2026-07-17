/**
 * Cohort-id cache helpers (issue #1849).
 *
 * `resolveCohortId` (#1846) canonicalizes repo identity but spawns git (up to
 * 3 subprocesses). Calling it per-turn from `experimental.chat.system.transform`
 * or per-receipt from the PromotionEvidenceRecord writer would violate the
 * bounded-init / no-hot-path-subprocess invariants. These helpers resolve the
 * cohort id ONCE, cache it on the per-session state, and let every hot-path
 * caller read the cached value.
 *
 * Primary population path: `chat.message` (fires turn 1 with sessionID + agent).
 * Fallback: callers that observe a cache miss (pre-existing session, restored
 * old snapshot, first-turn race) call {@link ensureCohortIdCached}, which
 * resolves once-bounded and caches — never per-turn.
 */

import type { CohortIdentity } from '../knowledge/cohort-identity.js';
import { resolveCohortId } from '../knowledge/cohort-identity.js';
import { ensureAgentSession, swarmState } from '../state.js';
import { log } from '../utils/logger.js';

/**
 * Resolve the cohort id for `directory` and cache it on the session at
 * `sessionID`. Fail-open + bounded: `resolveCohortId` never throws, and the
 * call is wrapped so any unexpected error logs and returns undefined without
 * caching a bad value. Idempotent — if the cache is already populated, returns
 * immediately without re-running git.
 *
 * Intended call sites (NOT per-turn):
 *  - `chat.message` (primary; fires turn 1).
 *  - `ensureCohortIdCached` fallback (only on cache miss).
 */
export async function cacheCohortIdAtMessage(
	directory: string,
	sessionID: string,
): Promise<string | undefined> {
	const existing = swarmState.agentSessions.get(sessionID)?.cachedCohortId;
	if (existing) return existing;
	return ensureCohortIdCached(directory, sessionID);
}

/**
 * Resolve the cohort id for `directory` once-bounded and cache it on the
 * session at `sessionID`. Returns the cached value if present; otherwise
 * resolves, caches, and returns. Returns `undefined` when resolution fails or
 * the identity is degraded in a way that yields no usable cohort id.
 *
 * This is the fallback for hot-path callers (system-enhancer,
 * PromotionEvidenceRecord writer) that observe a cache miss. It MUST stay
 * off the per-turn critical path: callers should read the cached value first
 * and only invoke this on miss.
 */
export async function ensureCohortIdCached(
	directory: string,
	sessionID: string | undefined,
): Promise<string | undefined> {
	if (!sessionID) return undefined;
	const session = swarmState.agentSessions.get(sessionID);
	if (session?.cachedCohortId) return session.cachedCohortId;
	let identity: CohortIdentity | undefined;
	try {
		identity = await resolveCohortId(directory);
	} catch (err) {
		log('[cohort-cache] resolveCohortId failed (fail-open)', {
			sessionID,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
	const cohortId = identity?.cohortId;
	if (cohortId) {
		// ensureAgentSession creates the session if absent (it may not exist yet
		// when the fallback fires from system-enhancer on turn 1).
		const s = ensureAgentSession(
			sessionID,
			swarmState.activeAgent.get(sessionID) ?? 'architect',
		);
		s.cachedCohortId = cohortId;
	}
	return cohortId;
}

/**
 * Read the cached cohort id for `sessionID` WITHOUT resolving. Returns
 * `undefined` when not cached. This is the hot-path read (no git, no I/O).
 */
export function readCachedCohortId(
	sessionID: string | undefined,
): string | undefined {
	if (!sessionID) return undefined;
	return swarmState.agentSessions.get(sessionID)?.cachedCohortId;
}

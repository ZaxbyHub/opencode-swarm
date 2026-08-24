/**
 * Per-session model fallback override store (issue #2103 workstream E).
 *
 * Replaces the old mutation of the module-global `swarmAgents[role].model`,
 * which (a) leaked across sessions/swarms and (b) was never read by any real
 * dispatch path. This store is keyed by exact (sessionID, swarmId, baseRole)
 * and is consulted by the shared dispatch resolver so the override reaches the
 * ACTUAL per-call SDK `model` argument.
 *
 * Lifetime: an override lives until a successful provider response for that
 * role in that session resets it to primary (single reset surface). Exhaustion
 * is explicit and never wraps back to primary indefinitely.
 *
 * Bound: LRU by `lastTouchedAt`, max 64 sessions (AGENTS.md invariant 8).
 */

const MAX_TRACKED_SESSIONS = 64;

interface RoleOverride {
	fallbackIndex: number;
	lastTouchedAt: number;
}

const store = new Map<string, Map<string, RoleOverride>>();

function sessionKey(sessionID: string): string {
	return sessionID;
}

function roleKey(swarmId: string, baseRole: string): string {
	return `${swarmId}::${baseRole}`;
}

function ensureSessionMap(sessionID: string): Map<string, RoleOverride> {
	let map = store.get(sessionKey(sessionID));
	if (!map) {
		if (store.size >= MAX_TRACKED_SESSIONS) {
			// LRU eviction: drop the least-recently-touched session.
			let oldestKey: string | undefined;
			let oldestTime = Number.POSITIVE_INFINITY;
			for (const [key, roleMap] of store) {
				let newest = Number.NEGATIVE_INFINITY;
				for (const entry of roleMap.values()) {
					if (entry.lastTouchedAt > newest) newest = entry.lastTouchedAt;
				}
				if (newest < oldestTime) {
					oldestTime = newest;
					oldestKey = key;
				}
			}
			if (oldestKey) store.delete(oldestKey);
		}
		map = new Map();
		store.set(sessionKey(sessionID), map);
	}
	return map;
}

/**
 * Advance the fallback index for (sessionID, swarmId, baseRole) after a
 * provider retry/fallback-eligible error. Returns the NEW 1-based index, or
 * `null` when the chain has no entry at the next index (exhaustion —
 * explicit, no wrap-around).
 */
export function advanceModelFallback(
	sessionID: string,
	swarmId: string,
	baseRole: string,
	chainLength: number,
): number | null {
	const next = (peekModelFallbackIndex(sessionID, swarmId, baseRole) ?? 0) + 1;
	if (next > chainLength) return null;
	const map = ensureSessionMap(sessionID);
	const key = roleKey(swarmId, baseRole);
	map.delete(key);
	map.set(key, { fallbackIndex: next, lastTouchedAt: Date.now() });
	return next;
}

/** Current 1-based fallback index for the role, or 0 (primary). */
export function peekModelFallbackIndex(
	sessionID: string,
	swarmId: string,
	baseRole: string,
): number {
	return (
		store.get(sessionKey(sessionID))?.get(roleKey(swarmId, baseRole))
			?.fallbackIndex ?? 0
	);
}

/**
 * Resolve the model to actually dispatch for a role: the configured fallback
 * chain entry at the current override index, or `undefined` for primary.
 * This is the SHARED resolver every real dispatch path consults so the
 * override reaches the SDK request's per-call `model` argument.
 */
export function peekModelOverride(
	sessionID: string,
	swarmId: string,
	baseRole: string,
	chain: readonly string[] | undefined,
): string | undefined {
	const index = peekModelFallbackIndex(sessionID, swarmId, baseRole);
	if (index <= 0 || !chain || chain.length === 0) return undefined;
	const model = chain[index - 1];
	return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/**
 * Reset to primary after a successful provider response for the role (the
 * documented reset boundary: current session, per role).
 */
export function resetModelFallback(
	sessionID: string,
	swarmId: string,
	baseRole: string,
): void {
	store.get(sessionKey(sessionID))?.delete(roleKey(swarmId, baseRole));
}

/** Clear everything for a session (session close / test reset). */
export function clearModelFallbacksForSession(sessionID: string): void {
	store.delete(sessionKey(sessionID));
}

/** Test seam (AGENTS.md invariant 7). */
export const _internals = {
	store,
	MAX_TRACKED_SESSIONS,
	advanceModelFallback,
	peekModelFallbackIndex,
	peekModelOverride,
	resetModelFallback,
	clearModelFallbacksForSession,
};

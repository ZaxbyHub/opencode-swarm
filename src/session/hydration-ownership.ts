/**
 * Project-owned, authority-fenced hydration state (issues #2667/#2668).
 *
 * The live maps on `swarmState` are process-resident and keyed by sessionID;
 * hydration is a per-PROJECT operation. This module owns the per-project
 * registries that scope a hydration's blast radius to the project that
 * initiated it and fence stale generations from publishing over newer state:
 *
 * - `projectHydrationAuthorities` — bounded records containing a per-project
 *   generation and a process-monotonic authority epoch. The generation is
 *   bumped ONLY when a hydration is initiated (`beginHydrationScope`), while
 *   the epoch changes whenever an evicted/reset project is reintroduced.
 *   Session creation NEVER bumps it; new sessions stamp `current + 1` so a
 *   session created while generation `g` is latest survives any later apply
 *   at `g`.
 * - `rehydrationCaches` — the plan/evidence rehydration cache, keyed per
 *   project (replaces the former process-singleton `_rehydrationCache`).
 * - `hydratedAggregateKeys` — the toolAggregates keys each project's last
 *   hydration published, so a re-hydration replaces only its own keys.
 *
 * Fence rule: a hydration is current only while both its generation and its
 * authority epoch match the bounded record for its project. This prevents an
 * evicted project entry from being reintroduced with a numerically reused
 * generation and accidentally reviving an old scope (ABA). Session stamp
 * rule: an accepted hydration at `{ generation: g, authorityEpoch: e }`
 * evicts owned sessions from an older epoch, or sessions in epoch `e` with
 * `hydrationStamp <= g`.
 *
 * All maps are bounded (FIFO) with an explicit reset path
 * (`clearHydrationOwnershipState`, called by `resetSwarmState`) per
 * AGENTS.md invariant 8.
 */

import { canonicalProjectKey } from '../db/canonical-project.js';
import { canonicalRootKeyLexical } from '../utils/canonical-root.js';

/** Upper bound for tracked per-project registries (matches MAX_READY_ROOTS). */
export const MAX_TRACKED_PROJECTS = 32;

/** Upper bound for the raw-spelling → canonical-key memo. */
export const MAX_DIRECTORY_KEY_MEMO = 64;

/** Opaque cache payload owned by state.ts; opaque here by design. */
export type ProjectRehydrationCache = unknown;

interface ProjectRehydrationCacheEntry {
	cache: ProjectRehydrationCache;
	authorityEpoch: number;
}

interface HydratedAggregateKeysEntry {
	keys: Set<string>;
	authorityEpoch: number;
}

/** Opaque process-local authority token for a project's current record. */
export interface HydrationAuthorityToken {
	projectKey: string;
	generation: number;
	authorityEpoch: number;
}

/** Fence token captured when a hydration is initiated; see beginHydrationScope. */
export interface HydrationScope {
	projectKey: string;
	generation: number;
	authorityEpoch: number;
}

interface HydrationAuthorityRecord {
	generation: number;
	authorityEpoch: number;
}

const projectHydrationAuthorities = new Map<string, HydrationAuthorityRecord>();
// Deliberately process-monotonic: clearHydrationOwnershipState() clears the
// bounded records but MUST NOT reset this scalar, or old tokens could become
// valid again after a reset.
let hydrationAuthorityEpoch = 0;
const rehydrationCaches = new Map<string, ProjectRehydrationCacheEntry>();
const hydratedAggregateKeys = new Map<string, HydratedAggregateKeysEntry>();
const directoryKeyMemo = new Map<string, string>();

function evictOldest(map: Map<string, unknown>, cap: number): void {
	while (map.size >= cap) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/**
 * Resolve the canonical project key for a directory spelling through a
 * module-owned bounded memo: exactly ONE realpath-equivalent resolution per
 * distinct spelling per process; every later call is a pure Map hit.
 *
 * The memo is keyed by `canonicalRootKeyLexical` (the shared filesystem-free
 * lexical alias key, per the path-identity ratchet — raw resolved paths must
 * not key project maps) so distinct spellings memoize independently while
 * lexically-identical spellings share one entry — whose canonical resolution
 * is identical anyway.
 *
 * `canonicalProjectKey` itself is intentionally NOT memoized (it calls
 * `canonicalRootKeyFresh`, bypassing the shared `canonicalRootMemo`), which
 * is why this memo exists — `beginHydrationScope`/`startAgentSession` sit on
 * the plugin-init and chat.message hot paths. A symlink retargeted
 * mid-process yields a second key: fail-safe isolation (separate ownership
 * buckets), never corruption. `canonicalProjectKey` never throws (lexical
 * `path.resolve` fallback on realpath failure) — that fallback is accepted.
 */
export function hydrationProjectKey(directory: string): string {
	const memoKey = canonicalRootKeyLexical(directory);
	const memoized = directoryKeyMemo.get(memoKey);
	if (memoized !== undefined) return memoized;
	const key = canonicalProjectKey(directory);
	if (!directoryKeyMemo.has(memoKey)) {
		evictOldest(directoryKeyMemo, MAX_DIRECTORY_KEY_MEMO);
	}
	directoryKeyMemo.set(memoKey, key);
	return key;
}

/**
 * Begin a hydration scope: bump the project's generation, mint a non-reusable
 * authority, and return the fence token. The token must be captured when the hydration is
 * INITIATED (e.g. at `loadSnapshot` entry) and carried into
 * `rehydrateState`, which refuses to apply it once any newer generation has
 * begun.
 */
export function beginHydrationScope(directory: string): HydrationScope {
	const projectKey = hydrationProjectKey(directory);
	const current = projectHydrationAuthorities.get(projectKey);
	const generation = (current?.generation ?? 0) + 1;
	// Update-in-place must not evict a DIFFERENT project's entry at the cap:
	// only make room when this project is not already tracked (otherwise a
	// bump for a tracked project would reset an unrelated project's counter).
	if (!current) {
		evictOldest(projectHydrationAuthorities, MAX_TRACKED_PROJECTS);
	}
	// The epoch identifies the project's authority incarnation, not an
	// individual generation.  A normal rehydration only advances generation;
	// minting a new epoch here would invalidate the prior aggregate-key owner
	// and cache before the replacement build can publish.  An evicted or reset
	// project has no current record and therefore receives a fresh epoch.
	const authorityEpoch =
		current?.authorityEpoch ?? nextHydrationAuthorityEpoch();
	projectHydrationAuthorities.set(projectKey, { generation, authorityEpoch });
	return { projectKey, generation, authorityEpoch };
}

/** Latest initiated hydration generation for a project (0 when never). */
export function currentHydrationGeneration(projectKey: string): number {
	return projectHydrationAuthorities.get(projectKey)?.generation ?? 0;
}

/**
 * Capture the current project authority without beginning a hydration. This
 * is used by direct session rehydration, which needs an exact record to fence
 * across awaits but must preserve the session-creation/no-generation-bump
 * contract.
 */
export function captureCurrentHydrationAuthority(
	projectKey: string,
): HydrationAuthorityToken {
	const current = projectHydrationAuthorities.get(projectKey);
	if (current) {
		return { projectKey, ...current };
	}
	const authorityEpoch = nextHydrationAuthorityEpoch();
	evictOldest(projectHydrationAuthorities, MAX_TRACKED_PROJECTS);
	const record = { generation: 0, authorityEpoch };
	projectHydrationAuthorities.set(projectKey, record);
	return { projectKey, ...record };
}

function nextHydrationAuthorityEpoch(): number {
	if (hydrationAuthorityEpoch >= Number.MAX_SAFE_INTEGER) {
		throw new Error('hydration authority epoch exhausted');
	}
	hydrationAuthorityEpoch += 1;
	return hydrationAuthorityEpoch;
}

/** Return whether an exact authority token still names the current record. */
export function isHydrationAuthorityCurrent(
	authority: HydrationAuthorityToken,
): boolean {
	const current = projectHydrationAuthorities.get(authority.projectKey);
	return (
		current?.generation === authority.generation &&
		current.authorityEpoch === authority.authorityEpoch
	);
}

/**
 * Return whether a captured hydration scope is still the latest initiated
 * scope for its project. Exact generation+epoch equality is intentional: a
 * scope whose project registry entry was evicted or reset is no longer current
 * either, even if a numerically equal generation is visible at the check.
 */
export function isHydrationScopeCurrent(scope: HydrationScope): boolean {
	return isHydrationAuthorityCurrent(scope);
}

/**
 * Stamp value for a session created NOW under `projectKey`:
 * `current + 1`, i.e. newer than any already-initiated hydration, so an
 * in-flight or late apply at the current generation can never evict it.
 */
export function nextSessionHydrationStamp(projectKey: string): number {
	return currentHydrationGeneration(projectKey) + 1;
}

export function getRehydrationCache(
	projectKey: string,
): ProjectRehydrationCache | undefined {
	const entry = rehydrationCaches.get(projectKey);
	const authority = projectHydrationAuthorities.get(projectKey);
	// A cache is valid only for the exact authority incarnation that published
	// it.  FIFO eviction removes the authority record but leaves this bounded
	// cache entry addressable by key; requiring an exact epoch prevents that old
	// entry from becoming visible after the project is reintroduced (ABA).
	if (
		!entry ||
		!authority ||
		entry.authorityEpoch !== authority.authorityEpoch
	) {
		return undefined;
	}
	return entry.cache;
}

export function setRehydrationCache(
	projectKey: string,
	cache: ProjectRehydrationCache,
	authority?: HydrationAuthorityToken,
): boolean {
	// Direct cache rebuilds (for example after compaction) may run before any
	// hydration scope exists.  Give them the same current authority identity
	// that startAgentSession will capture, without bumping its generation.  A
	// rebuild that captured a token at entry must pass that exact token here so
	// delayed work cannot be retagged as current after an ABA reintroduction.
	const cacheAuthority =
		authority ?? captureCurrentHydrationAuthority(projectKey);
	if (
		cacheAuthority.projectKey !== projectKey ||
		!isHydrationAuthorityCurrent(cacheAuthority)
	) {
		return false;
	}
	if (!rehydrationCaches.has(projectKey)) {
		evictOldest(rehydrationCaches, MAX_TRACKED_PROJECTS);
	}
	rehydrationCaches.set(projectKey, {
		cache,
		authorityEpoch: cacheAuthority.authorityEpoch,
	});
	return true;
}

/** Record the aggregate keys a project's hydration published (replace set). */
export function recordHydratedAggregateKeys(
	projectKey: string,
	keys: Set<string>,
	authority?: HydrationAuthorityToken,
): boolean {
	const aggregateAuthority =
		authority ?? captureCurrentHydrationAuthority(projectKey);
	if (
		aggregateAuthority.projectKey !== projectKey ||
		!isHydrationAuthorityCurrent(aggregateAuthority)
	) {
		return false;
	}
	if (!hydratedAggregateKeys.has(projectKey)) {
		evictOldest(hydratedAggregateKeys, MAX_TRACKED_PROJECTS);
	}
	hydratedAggregateKeys.set(projectKey, {
		keys: new Set(keys),
		authorityEpoch: aggregateAuthority.authorityEpoch,
	});
	return true;
}

/** The aggregate keys the project's last hydration published (empty if none). */
export function hydratedAggregateKeysFor(
	projectKey: string,
	authority?: HydrationAuthorityToken,
): Set<string> {
	const entry = hydratedAggregateKeys.get(projectKey);
	const current = authority ?? projectHydrationAuthorities.get(projectKey);
	if (!entry || !current || entry.authorityEpoch !== current.authorityEpoch) {
		return new Set<string>();
	}
	return entry.keys;
}

/** Reset every registry (invariant 8: bounded state with an explicit reset). */
export function clearHydrationOwnershipState(): void {
	projectHydrationAuthorities.clear();
	rehydrationCaches.clear();
	hydratedAggregateKeys.clear();
	directoryKeyMemo.clear();
}

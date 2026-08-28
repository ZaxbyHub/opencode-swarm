/**
 * Canonical project-root keying for session-scoped module state (issue #2041).
 *
 * The trajectory cache (src/prm/trajectory-store.ts), the step counters
 * (src/hooks/trajectory-step-state.ts), and the logger's restart-seed gate
 * (src/hooks/trajectory-logger.ts) are all process-global maps that a
 * multi-root host can share through one plugin module instance. They must key
 * by canonical root + session id, and they must agree on what "canonical"
 * means: realpath resolves junction/symlink aliases (linked worktrees on
 * Windows are junctions), `path.resolve` is the fallback for a root that does
 * not exist yet, and Windows roots are case-folded because the filesystem is.
 * A symlinked `.swarm` directory itself is already rejected by
 * `validateSwarmPath`, so the aliasing this resolves lives strictly ABOVE
 * `.swarm`. One shared implementation so the three maps cannot drift.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';

/**
 * Separator between canonical root and session id in composite keys.
 * `String.fromCharCode(0)` rather than an escape literal so the source stays
 * clean text (a literal NUL byte in source makes tooling treat the file as
 * binary); NUL cannot appear in a path on any supported platform.
 */
export const SESSION_KEY_SEPARATOR = String.fromCharCode(0);

const canonicalRootMemo = new Map<string, string>();

/** Bound on the memoized canonical-root map (Invariant 8). */
const MAX_CANONICAL_ROOT_CACHE = 128;

function resolveCanonicalRootKey(directory: string): string {
	let resolved = path.resolve(directory);
	try {
		resolved = fsSync.realpathSync(resolved);
	} catch {
		/* root missing / inaccessible — resolve() is the best identity we have */
	}
	const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	return key;
}

export function canonicalRootKey(directory: string): string {
	const memoized = canonicalRootMemo.get(directory);
	if (memoized !== undefined) return memoized;

	const key = resolveCanonicalRootKey(directory);

	if (!canonicalRootMemo.has(directory)) {
		while (canonicalRootMemo.size >= MAX_CANONICAL_ROOT_CACHE) {
			const oldest = canonicalRootMemo.keys().next().value;
			if (oldest === undefined) break;
			canonicalRootMemo.delete(oldest);
		}
	}
	canonicalRootMemo.set(directory, key);
	return key;
}

/** Resolve a root without consulting the bounded memoized cache. */
export function canonicalRootKeyFresh(directory: string): string {
	return resolveCanonicalRootKey(directory);
}

/** Composite map key: canonical root + NUL + session id. */
export function compositeSessionKey(
	directory: string,
	sessionId: string,
): string {
	return `${canonicalRootKey(directory)}${SESSION_KEY_SEPARATOR}${sessionId}`;
}

/**
 * Suffix every root's key for a session ends with. Suffix-scan clear paths
 * that legitimately lack a directory (the `/swarm reset` entry points) match
 * all roots with this.
 */
export function sessionKeySuffix(sessionId: string): string {
	return `${SESSION_KEY_SEPARATOR}${sessionId}`;
}

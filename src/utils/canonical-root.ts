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

/** Keep filesystem and platform access behind a narrow test seam. */
export const _internals: {
	realpathSyncNative: (path: fsSync.PathLike) => string;
	realpathSync: typeof fsSync.realpathSync;
	lstatSync: typeof fsSync.lstatSync;
	platform: () => NodeJS.Platform;
} = {
	realpathSyncNative: fsSync.realpathSync.native,
	realpathSync: fsSync.realpathSync,
	lstatSync: fsSync.lstatSync,
	platform: () => process.platform,
};

function normalizeIdentityPath(resolved: string): string {
	const normalized =
		_internals.platform() === 'win32'
			? path.win32.normalize(resolved)
			: path.posix.normalize(resolved);
	return _internals.platform() === 'win32'
		? normalized.toLowerCase()
		: normalized;
}

/**
 * Normalize only the caller's lexical spelling of a root.
 *
 * This is deliberately not physical project identity. It exists solely for
 * bounded resource-lifecycle alias tables that must remember how a caller
 * spelled a root after that path is deleted or becomes inaccessible. New
 * equality, cache, authority, or persistence decisions must use
 * {@link canonicalRootKeyFresh} instead.
 */
export function lexicalRootAliasKey(directory: string): string {
	return normalizeIdentityPath(path.resolve(directory));
}

/**
 * Return a bounded, filesystem-free key for a caller's lexical root spelling.
 *
 * This is intentionally separate from `canonicalRootKeyFresh*`: dispatch uses
 * it for a synchronous input-alias table immediately after an async lookup has
 * populated the real cache. It is not a physical project-root identity.
 */
export function canonicalRootKeyLexical(directory: string): string {
	return lexicalRootAliasKey(directory);
}

function resolveCanonicalRootKey(directory: string): string {
	let resolved = path.resolve(directory);
	try {
		resolved = _internals.realpathSyncNative(resolved);
	} catch {
		try {
			resolved = _internals.realpathSync(resolved);
		} catch {
			/* root missing / inaccessible — resolve() is the best identity we have */
		}
	}
	return normalizeIdentityPath(resolved);
}

/**
 * Resolve a physical root identity without blocking the event loop.
 *
 * Init-path callers must use this form when their work is governed by an
 * AbortSignal deadline. `fs.promises.realpath` lets the timeout race settle
 * while slow network filesystems, antivirus hooks, or junction resolution are
 * still pending; a later caller-side abort check prevents the late result from
 * publishing cache state. The synchronous helpers above remain necessary for
 * existing synchronous authority and persistence call sites.
 */
export async function canonicalRootKeyFreshAsync(
	directory: string,
): Promise<string> {
	let resolved = path.resolve(directory);
	try {
		resolved = await fsSync.promises.realpath(resolved);
	} catch {
		// A missing or inaccessible path has no physical identity available.
		// Preserve the same lexical fallback as canonicalRootKeyFresh.
	}
	return normalizeIdentityPath(resolved);
}

export function canonicalRootKey(directory: string): string {
	const memoized = canonicalRootMemo.get(directory);
	if (memoized !== undefined) {
		// Symlink/junction targets may be retargeted without changing the
		// caller's spelling. Refresh only those alias paths; ordinary project
		// roots retain the bounded memoized hot path.
		try {
			if (!_internals.lstatSync(directory).isSymbolicLink()) return memoized;
		} catch {
			return memoized;
		}
		const fresh = resolveCanonicalRootKey(directory);
		if (fresh !== memoized) canonicalRootMemo.set(directory, fresh);
		return fresh;
	}

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

/** Compare current physical project-root identity, bypassing the memo. */
export function sameProjectRoot(a: string, b: string): boolean {
	return canonicalRootKeyFresh(a) === canonicalRootKeyFresh(b);
}

/** Composite map key: current physical root + NUL + session id. */
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

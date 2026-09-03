/**
 * Backward-compatible name for the shared canonical project-root identity
 * helper (issue #2480 / #2474).
 *
 * Policy (docs/sqlite-durable-state.md §Identity):
 * - This helper answers ONE question: "are these two directory spellings the same project
 *   root, so they must share ONE `.swarm/swarm.db` connection?" It is project-root
 *   IDENTITY, not security-sensitive file equivalence — those are different threat models
 *   and deliberately different helpers (issue #2474 / Workstream B1 owns the repo-wide
 *   identity rollout; this is the DB-layer-scoped implementation D1 builds on).
 * - Resolution: `path.resolve` (lexical cleanup) → best-effort `fs.realpathSync`
 *   (collapses symlinks/junctions and, on Windows, expands 8.3 short names) →
 *   case-fold the WHOLE key on win32 only. On POSIX, case is significant: `/a/B` and
 *   `/a/b` are different roots and must stay isolated.
 * - Never throws: if `realpathSync` fails (broken symlink, permission, race), the
 *   lexically-resolved path is used as-is. A canonicalization failure must not prevent
 *   the project DB from opening; it only risks a duplicate handle for exotic spellings,
 *   which is the pre-existing behavior.
 */

import type { realpathSync } from 'node:fs';
import {
	_internals as canonicalRootInternals,
	canonicalRootKeyFresh,
} from '../utils/canonical-root.js';

/** DI seam for tests (fault-injected realpath failures). */
const defaultCanonicalRootRealpath = canonicalRootInternals.realpathSync;
const defaultCanonicalRootNativeRealpath =
	canonicalRootInternals.realpathSyncNative;

/**
 * Keep the historical DB-layer seam wired to the shared resolver.  A few
 * callers/tests inject a `realpathSync` failure through this compatibility
 * export; forwarding that override to both shared resolver entry points keeps
 * the fault-injection contract intact without reintroducing a second path
 * canonicalization implementation here.
 */
export const _internals: { realpathSync: typeof realpathSync } = {
	get realpathSync() {
		return canonicalRootInternals.realpathSync;
	},
	set realpathSync(value) {
		canonicalRootInternals.realpathSync = value;
		canonicalRootInternals.realpathSyncNative =
			value === defaultCanonicalRootRealpath
				? defaultCanonicalRootNativeRealpath
				: (value as unknown as typeof canonicalRootInternals.realpathSyncNative);
	},
};

/**
 * Return the canonical cache key for a project directory.
 *
 * - `C:\Proj` and `c:\proj\` map to one key on Windows (one DB handle).
 * - A symlink or junction to the same directory maps to one key on every platform.
 * - Distinct POSIX casings remain distinct roots.
 */
export function canonicalProjectKey(directory: string): string {
	return canonicalRootKeyFresh(directory);
}

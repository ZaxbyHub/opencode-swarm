/**
 * Canonical project identity for the SQLite durable-state foundation (issue #2480).
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

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/** DI seam for tests (fault-injected realpath failures). */
export const _internals: { realpathSync: typeof realpathSync } = {
	realpathSync,
};

/**
 * Return the canonical cache key for a project directory.
 *
 * - `C:\Proj` and `c:\proj\` map to one key on Windows (one DB handle).
 * - A symlink or junction to the same directory maps to one key on every platform.
 * - Distinct POSIX casings remain distinct roots.
 */
export function canonicalProjectKey(directory: string): string {
	const lexical = resolve(directory);
	let canonical: string;
	try {
		canonical = _internals.realpathSync(lexical);
	} catch {
		// Broken symlink, permission error, or a race that removed the directory:
		// fall back to the lexical spelling rather than failing to open the DB.
		canonical = lexical;
	}
	return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Faithful transcription of OpenCode's path-canonicalisation helpers.
 *
 * ## Why this must exist
 *
 * The host asks for `external_directory` permission with a pattern it has run
 * through `Filesystem.normalizePathPattern` — for example
 * `src/tools/…` (offset 100715012):
 *
 * ```js
 * let u = G.normalizePathPattern(Hr.join(y, "*"));
 * yield* o.ask({ permission: "external_directory", patterns: [u], always: [u], … });
 * ```
 *
 * Rule patterns from config get NO such treatment: `Permission.fromConfig`
 * applies only `~` / `$HOME` expansion. So for a rule to match, its text must
 * already equal what the host will produce for the asked path.
 *
 * That matters because `normalizePathPattern` resolves symlinks via
 * `realpathSync.native`. A lane reached through a Windows junction (or a macOS
 * `/var` → `/private/var` symlink) is asked for under its REAL path, while an
 * un-canonicalised rule names the link path — so the lane is denied access to
 * its own granted directory.
 *
 * Verbatim host source (`C:\OpenCode\opencode.exe`, opencode 1.18.10,
 * offsets 107196170-107196420; the minified names resolve via the chunk's own
 * imports at offset 107192671: `ky`=`path.resolve`, `yy`=`path.join`,
 * `ek`=`fs.realpathSync`):
 *
 * ```js
 * function j(F){ let z=ky(X(F)); try{ return ek.native(z) }catch{ return z } }
 * YW.normalizePath = j;
 *
 * function J(F){
 *   if(F==="*") return F;
 *   let z=F.match(/^(.*)[\\/]\*$/);
 *   if(!z) return j(F);
 *   let Z=/^[A-Za-z]:$/.test(z[1]) ? z[1]+"\\" : z[1];
 *   return yy(j(Z),"*");
 * }
 * YW.normalizePathPattern = J;
 *
 * function X(F){ return F
 *   .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/,(z,Z)=>`${Z.toUpperCase()}:/`)
 *   .replace(/^\/([a-zA-Z])(?:\/|$)/,(z,Z)=>`${Z.toUpperCase()}:/`)
 *   .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/,(z,Z)=>`${Z.toUpperCase()}:/`)
 *   .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/,(z,Z)=>`${Z.toUpperCase()}:/`) }
 * YW.windowsPath = X;
 * ```
 *
 * If a future OpenCode release changes these, lane rules stop matching. The
 * shared-normaliser tests in `tests/unit/config/lane-permissions.test.ts` are
 * the tripwire — re-extract before "fixing" them.
 *
 * @module config/host-path
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Test-only DI seam (AGENTS.md invariant 7). Lets tests simulate a symlink /
 * junction without creating one, and assert the ENOENT degradation.
 */
export const _internals = {
	realpathSyncNative: fs.realpathSync.native as (p: string) => string,
};

/** Host `Filesystem.windowsPath`. */
function hostWindowsPath(input: string): string {
	return input
		.replace(
			/^\/([a-zA-Z]):(?:[\\/]|$)/,
			(_m, d: string) => `${d.toUpperCase()}:/`,
		)
		.replace(/^\/([a-zA-Z])(?:\/|$)/, (_m, d: string) => `${d.toUpperCase()}:/`)
		.replace(
			/^\/cygdrive\/([a-zA-Z])(?:\/|$)/,
			(_m, d: string) => `${d.toUpperCase()}:/`,
		)
		.replace(
			/^\/mnt\/([a-zA-Z])(?:\/|$)/,
			(_m, d: string) => `${d.toUpperCase()}:/`,
		);
}

/**
 * Host `Filesystem.normalizePath`: `realpathSync.native(path.resolve(windowsPath(p)))`,
 * degrading to the un-realpath'd resolved form on ANY realpath failure.
 *
 * The host uses a bare `catch` here (not an ENOENT check), so a permission
 * error degrades identically to a missing path. Transcribed as-is: diverging
 * would make our rule text disagree with the host's asked text in exactly the
 * cases where a lane is already having filesystem trouble.
 */
function hostNormalizePath(input: string): string {
	const resolved = path.resolve(hostWindowsPath(input));
	try {
		return _internals.realpathSyncNative(resolved);
	} catch {
		// Bare catch, matching the host. The common case is a path that does not
		// exist yet (e.g. a skill root the user has not created), but a
		// permission error degrades the same way — deliberately, so both sides
		// of the comparison stay in step.
		return resolved;
	}
}

/**
 * Host `Filesystem.normalizePathPattern`.
 *
 * Canonicalises the DIRECTORY part of a `<dir>/*` pattern and re-appends the
 * wildcard, leaving the bare `*` catch-all untouched. Note the drive-root
 * special case: for `C:/*` the captured directory is `C:` which
 * `path.resolve` would turn into the process's current directory on that
 * drive, so the host appends a separator first.
 */
export function hostNormalizePathPattern(pattern: string): string {
	if (pattern === '*') return pattern;
	const match = /^(.*)[\\/]\*$/.exec(pattern);
	if (!match) return hostNormalizePath(pattern);
	const dir = /^[A-Za-z]:$/.test(match[1]) ? `${match[1]}\\` : match[1];
	return path.join(hostNormalizePath(dir), '*');
}

/**
 * Tier-0 test seam (writing-tests skill): pure transcriptions with no external
 * dependency beyond the DI'd realpath. Only {@link hostNormalizePathPattern} is
 * consumed by production code, so these stay internal.
 */
export const _test_exports = { hostWindowsPath, hostNormalizePath };

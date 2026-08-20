/**
 * Spawn-failure classification for git (and any other external binary).
 *
 * Issue #2236: a spawn that fails with `ENOENT` was previously read as
 * "the git binary is not on PATH". That is only one of the reasons a spawn
 * can produce `ENOENT`. When the `cwd` handed to the spawn no longer exists,
 * libuv reports the *same* code — `ENOENT: no such file or directory,
 * posix_spawn 'git'` (`uv_spawn` on Windows) — and the misclassification sent
 * the reported bug down a four-day PATH investigation while git was present
 * the whole time.
 *
 * The discriminator is the `cwd` the caller already holds. Classification is
 * three-way, never two-way: "I cannot tell" gets its own state and is never
 * folded into either definite bucket.
 *
 * The `cwd` probe itself (`inspectSpawnCwd`, `SpawnCwdMissingError`) lives in
 * `bun-compat.ts` — that file must stay loadable by bare Node, so it cannot
 * import from here. It is re-exported below so callers still have one
 * classification surface.
 */

import { classifySpawnFailure } from './bun-compat.js';

export {
	classifySpawnFailure,
	describeSpawnCwdFailure,
	inspectSpawnCwd,
	type SpawnCwdFailureReason,
	SpawnCwdMissingError,
	type SpawnCwdState,
	type SpawnFailureClass,
} from './bun-compat.js';

export class GitBinaryMissingError extends Error {
	override readonly name = 'GitBinaryMissingError';

	constructor(
		message = 'git binary is not available',
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

/**
 * True when the spawn failed because the executable itself could not be
 * resolved. Passing the `cwd` the caller already holds is what makes this
 * answer trustworthy; omitting it preserves the pre-#2236 ENOENT-only
 * behaviour for call sites that have no cwd to offer.
 */
export function isGitBinaryMissing(
	err: unknown,
	cwd?: string,
): err is { code?: string } {
	return classifySpawnFailure(err, cwd) === 'binary-missing';
}

/**
 * True when the spawn failed because `cwd` is gone, or exists but is not a
 * directory. This is the #2236 failure shape.
 */
export function isSpawnCwdMissing(
	err: unknown,
	cwd: string,
): err is { code?: string } {
	return classifySpawnFailure(err, cwd) === 'cwd-missing';
}

/**
 * True when `cwd` could not be inspected (`EACCES`/`EPERM`, or an unexpected
 * stat failure). Never folded into either definite bucket — callers must fail
 * closed on it rather than assume the directory is gone.
 */
export function isSpawnCwdUnreadable(
	err: unknown,
	cwd: string,
): err is { code?: string } {
	return classifySpawnFailure(err, cwd) === 'cwd-unreadable';
}

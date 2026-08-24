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

/**
 * Base type for "git never ran".
 *
 * Both subclasses mean the child process was never created, so **nothing may
 * be inferred from its absence of output**. That distinction is the whole
 * point: a caller that reads "git produced no result" as a fact about the
 * repository (for example "this path is not in HEAD") is only entitled to do
 * so when git actually executed and reported. Callers therefore discriminate
 * on this base, not on either subclass — a two-way `instanceof` check against
 * a three-way classification is what re-introduces the #2236 misdiagnosis one
 * state at a time.
 */
export class GitUnavailableError extends Error {}

export class GitBinaryMissingError extends GitUnavailableError {
	override readonly name = 'GitBinaryMissingError';

	constructor(
		message = 'git binary is not available',
		options?: { cause?: unknown },
	) {
		super(message, options);
	}
}

/** Which of the two `cwd` fault states produced a {@link GitSpawnCwdError}. */
export type GitSpawnCwdFault = 'missing' | 'unreadable';

/**
 * git could not start because its `cwd` was unusable — the #2236 shape.
 *
 * Deliberately a *sibling* of {@link GitBinaryMissingError}, never a subclass:
 * "the working directory is gone" and "git is not installed" are different
 * facts with different remediations, and the #2236 regression suites assert
 * that a cwd fault is `not.toBeInstanceOf(GitBinaryMissingError)`.
 *
 * The message text is rendered here rather than at each throw site so all four
 * `execGit`-style call sites (`git/branch.ts`, `tools/checkpoint.ts`,
 * `hooks/semantic-diff-injection.ts`, `tools/diff-summary.ts`) cannot drift.
 */
export class GitSpawnCwdError extends GitUnavailableError {
	override readonly name = 'GitSpawnCwdError';
	readonly cwd: string;
	readonly fault: GitSpawnCwdFault;

	constructor(
		cwd: string,
		fault: GitSpawnCwdFault,
		options?: { cause?: unknown },
	) {
		super(
			fault === 'missing'
				? `git could not start: working directory no longer exists: ${cwd}`
				: `git could not start: working directory could not be inspected (permission denied): ${cwd}`,
			options,
		);
		this.cwd = cwd;
		this.fault = fault;
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

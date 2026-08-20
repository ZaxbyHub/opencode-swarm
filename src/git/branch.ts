import * as child_process from 'node:child_process';
import * as fsSync from 'node:fs';
import path from 'node:path';
import { isValidEnvKey } from '../sandbox/executor';
import { mergeEnvForChild } from '../utils/bun-compat';
import {
	GitBinaryMissingError,
	GitSpawnCwdError,
	isGitBinaryMissing,
	isSpawnCwdMissing,
	isSpawnCwdUnreadable,
} from '../utils/git-binary-missing-error.js';
import {
	describeGitResolution,
	GIT_BINARY_ENV_VAR,
	resolveGitExecutable,
} from '../utils/git-executable.js';
import { warn } from '../utils/logger.js';
import {
	isTransientSpawnError,
	MAX_TRANSIENT_RETRIES,
	transientBackoff,
} from '../utils/transient-retry.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

/**
 * Issue #2236 NB-1: cap on candidate lines rendered by
 * {@link gitBinaryMissingMessage}. The resolver probes one candidate per PATH
 * entry (times three filename extensions on Windows), so an uncapped list is
 * unbounded in the host's PATH length — measured at 209 lines on a real host.
 * `src/tools/update-task-status.ts` surfaces `error.message` verbatim, so that
 * is a 210-line error at the exact tool #2236 blocked. Same "... and N more"
 * bounding as `boundZodIssues` in `src/tools/dispatch-lanes.ts`.
 */
const MAX_RENDERED_GIT_CANDIDATES = 10;

export type GitRepositoryStatus =
	| { isRepo: true }
	| {
			isRepo: false;
			reason: 'not_git_repo' | 'git_unavailable' | 'git_error';
			message: string;
	  };

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isNotGitRepositoryMessage(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes('not a git repository') || lower.includes('not a git repo')
	);
}

/**
 * File-scoped indirection seam for spawnSync.
 * Supports envOverrides so lane runtime profiles can inject env.
 */
/**
 * Get child_process.spawnSync at call time (not captured at module load).
 * This allows tests to mock child_process.spawnSync before gitExec runs.
 */
function getChildProcessSpawnSync() {
	return child_process.spawnSync;
}

/**
 * Seam that calls child_process.spawnSync dynamically.
 * Uses getChildProcessSpawnSync() to resolve at call time, allowing
 * tests to mock child_process.spawnSync before gitExec runs.
 */
const __spawnSyncSeam = {
	spawnSync: (
		cmd: string,
		args: string[],
		options?: {
			cwd?: string;
			encoding?: BufferEncoding;
			timeout?: number;
			maxBuffer?: number;
			windowsHide?: boolean;
			stdio?:
				| 'pipe'
				| 'ignore'
				| 'inherit'
				| Array<'pipe' | 'ignore' | 'inherit'>;
			env?: Record<string, string | undefined>;
			envOverrides?: Record<string, string | null>;
		},
	): child_process.SpawnSyncReturns<string | Buffer> => {
		const mergedEnv = mergeEnvForChild(options?.env, options?.envOverrides);
		return getChildProcessSpawnSync()(cmd, args, {
			...options,
			env: mergedEnv as NodeJS.ProcessEnv | undefined,
		});
	},
};

/**
 * Execute git command safely.
 *
 * Non-interactive enforcement (AGENTS.md #3): three defenses ensure git
 * cannot block on a TTY prompt — GPG passphrase, credential helper,
 * "are you sure?" rebase confirmation, etc.
 *
 *  1. `stdio: ['ignore', ...]` closes the child's stdin. A prompt has
 *     no input source, so git/GPG/credential-helper sees EOF.
 *  2. `GIT_TERMINAL_PROMPT=0` tells git itself to refuse any prompt
 *     attempt outright rather than falling back to the controlling
 *     terminal (some prompts route through git, not the child).
 *  3. `-c commit.gpgsign=false -c tag.gpgsign=false` prepended to every
 *     command. Closes the SILENT-failure path where a developer/CI host
 *     has `commit.gpgsign=true` globally and no GPG agent — without (3),
 *     defenses (1)+(2) merely turn the prompt-hang into an immediate
 *     non-zero exit, which `commitTaskCompletion` catches as
 *     `commit-failed` non-fatally. Result: every Epic Rule 2 commit
 *     silently fails, predecessor-evidence never accumulates, every
 *     phase demotes. (3) forces the underlying git subcommand to skip
 *     signing entirely. This is the single source of truth for
 *     non-interactive git, so the hardening covers every caller
 *     (current and future) uniformly.
 *
 * Transient retry: transient spawn errors (e.g. ETIMEDOUT) are retried
 * with exponential backoff up to MAX_TRANSIENT_RETRIES before throwing.
 * Permanent errors — non-zero exit, missing git binary, non-transient
 * spawn errors — throw immediately with no retry.
 *
 * Lane env fallback (FR-201): when `laneEnv` is not provided but `laneIndex`
 * is, reads the lane env file from disk synchronously.
 */

/**
 * Synchronously read and parse a lane runtime profile from disk.
 * Mirrors the logic of `readLaneEnvFileFromDisk` but uses sync fs.
 * Returns an empty record when the file does not exist or cannot be read.
 */
export function readLaneEnvFileFromDiskSync(
	worktreePath: string,
	laneIndex: number,
): Record<string, string> {
	const envPath = path.join(
		worktreePath,
		'.swarm',
		'lanes',
		`${laneIndex}.env`,
	);
	let content: string;
	try {
		content = fsSync.readFileSync(envPath, 'utf-8');
	} catch {
		// ENOENT / ENOTDIR — file absent; return empty
		return {};
	}

	const result: Record<string, string> = {};
	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const eqIdx = line.indexOf('=');
		if (eqIdx < 0) continue;
		const k = line.slice(0, eqIdx);
		const v = line.slice(eqIdx + 1);
		if (!isValidEnvKey(k)) continue; // reject shell-injection vectors
		result[k] = v;
	}
	return result;
}

/**
 * Issue #2236 F5: builds the *actionable* "git is not available" message.
 *
 * `describeGitResolution()` (src/utils/git-executable.ts) is the production
 * source of truth for what the resolver actually tried — every candidate path,
 * its source (`override`/`platform`/`path`), and why each was rejected. A bare
 * "git executable is not available on PATH" is what sent the original report
 * down a four-day PATH investigation while git was present the whole time, so
 * the thrown message names the candidates and the override escape hatch.
 *
 * `cwd` is named too: reaching this function means the cwd was positively
 * classified as present-and-a-directory, which is the fact that rules the
 * #2236 misdiagnosis out rather than leaving it implied.
 */
function gitBinaryMissingMessage(cwd: string): string {
	const resolution = describeGitResolution();
	const lines = [
		`git executable is not available: spawning "${
			resolution.resolvedPath ?? 'git'
		}" failed, and the working directory ${cwd} exists and is a directory.`,
	];
	if (resolution.attempts.length > 0) {
		lines.push('Candidates tried:');
		// Bounded (NB-1). The override is always candidate #1
		// (`buildCandidates` in src/utils/git-executable.ts), so a configured
		// override's own rejection reason is never the thing that gets truncated.
		const shown = resolution.attempts.slice(0, MAX_RENDERED_GIT_CANDIDATES);
		for (const attempt of shown) {
			lines.push(
				`  - [${attempt.source}] ${attempt.candidate}: ${
					attempt.accepted ? 'accepted' : (attempt.reason ?? 'rejected')
				}`,
			);
		}
		const omitted = resolution.attempts.length - shown.length;
		if (omitted > 0) lines.push(`  ... and ${omitted} more`);
	} else {
		lines.push(
			'No candidate probe results are recorded for this process (the resolver was pre-seeded or has not probed yet).',
		);
	}
	lines.push(
		resolution.overrideValue
			? `The configured override (${resolution.overrideSource ?? 'unknown'}) "${resolution.overrideValue}" did not work — point the ${GIT_BINARY_ENV_VAR} environment variable, or the "git.binary" value in your USER config (a project .opencode config is ignored for this key), at a working git executable.`
			: `No override is configured. Set the ${GIT_BINARY_ENV_VAR} environment variable, or the "git.binary" value in your USER config (a project .opencode config is ignored for this key), to point at a working git executable.`,
	);
	return lines.join('\n');
}

function gitExec(
	args: string[],
	cwd: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): string {
	// FR-201: fall back to sync disk read if laneEnv not provided but laneIndex is.
	const resolvedLaneEnv =
		laneEnv ??
		(laneIndex !== undefined
			? readLaneEnvFileFromDiskSync(cwd, laneIndex)
			: undefined);

	// Scope the `gpgsign=false` overrides to the only subcommands they
	// affect — `commit` and `tag`. Applying them to `branch`/`reset`/`log`
	// would be a harmless no-op but would perturb callers (and tests) that
	// assert on exact positional args. `GIT_TERMINAL_PROMPT=0` and the
	// closed stdin (defenses 1 + 2) stay global since they are env/stdio,
	// not argv. Defense 3 covers Epic Rule 2's `commit --allow-empty`.
	const subcommand = args[0];
	const hardenedArgs =
		subcommand === 'commit' || subcommand === 'tag'
			? ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args]
			: args;

	// Issue #2236 hardening (F2): the git binary is resolved ONCE via
	// `git-executable.ts`'s bounded, memoized, platform-aware resolver
	// (which already covers the Windows install-location candidates
	// previously enumerated by the deleted local `windowsGitCandidates()`).
	// Only the transient-retry loop over spawn ATTEMPTS remains here.
	const command = _internals.resolveGitExecutable();

	for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
		const result = _internals.spawnSync(command, hardenedArgs, {
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: GIT_MAX_BUFFER_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			envOverrides: resolvedLaneEnv,
		});

		if (!result.error && result.status === 0) {
			return result.stdout as string;
		}

		if (result.error) {
			// Issue #2236: an ENOENT here is ambiguous — libuv reports the same
			// code when the *binary* cannot be found and when the *cwd* is gone
			// (or is a file). Classifying without the `cwd` we already hold is
			// exactly the misdiagnosis this change exists to eliminate, so the
			// split is three-way and a cwd fault names the offending directory
			// instead of blaming PATH. Mirrors src/tools/checkpoint.ts.
			if (isSpawnCwdMissing(result.error, cwd)) {
				throw new GitSpawnCwdError(cwd, 'missing', { cause: result.error });
			}

			if (isSpawnCwdUnreadable(result.error, cwd)) {
				throw new GitSpawnCwdError(cwd, 'unreadable', {
					cause: result.error,
				});
			}

			if (isGitBinaryMissing(result.error, cwd)) {
				throw new GitBinaryMissingError(gitBinaryMissingMessage(cwd), {
					cause: result.error,
				});
			}

			if (
				isTransientSpawnError(result.error) &&
				attempt < MAX_TRANSIENT_RETRIES - 1
			) {
				transientBackoff(attempt);
				continue;
			}

			throw new Error(errorMessage(result.error));
		}

		if (result.status !== 0) {
			throw new Error(
				(result.stderr as string) ||
					(result.stdout as string) ||
					`git exited with ${result.status}`,
			);
		}
	}

	// Unreachable in practice — every loop iteration above either returns or
	// throws. Kept only so TypeScript's control-flow analysis (which cannot
	// prove `MAX_TRANSIENT_RETRIES > 0`) accepts `gitExec`'s `string` return
	// type.
	throw new GitBinaryMissingError(
		process.platform === 'win32'
			? 'git executable is not available on PATH or common Windows install locations'
			: 'git executable is not available on PATH',
	);
}

export function getGitRepositoryStatus(cwd: string): GitRepositoryStatus {
	try {
		gitExec(['rev-parse', '--git-dir'], cwd);
		return { isRepo: true };
	} catch (err) {
		if (err instanceof GitBinaryMissingError) {
			return {
				isRepo: false,
				reason: 'git_unavailable',
				message: err.message,
			};
		}
		const message = errorMessage(err);
		return {
			isRepo: false,
			reason: isNotGitRepositoryMessage(message) ? 'not_git_repo' : 'git_error',
			message,
		};
	}
}

/**
 * Check if we're in a git repository
 */
export function isGitRepo(cwd: string): boolean {
	return getGitRepositoryStatus(cwd).isRepo;
}

/**
 * Get current branch name
 * @param cwd - Working directory
 * @param laneEnv - Optional lane env overrides for git spawn
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export function getCurrentBranch(
	cwd: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): string {
	const output = gitExec(
		['rev-parse', '--abbrev-ref', 'HEAD'],
		cwd,
		laneEnv,
		laneIndex,
	);
	return output.trim();
}

/**
 * Create a new branch
 * @param cwd - Working directory
 * @param branchName - Name of the branch to create
 * @param remote - Remote name (default: 'origin')
 * @param laneEnv - Optional lane env overrides for git spawn
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export function createBranch(
	cwd: string,
	branchName: string,
	remote: string = 'origin',
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): void {
	// Check if branch already exists
	try {
		gitExec(
			['rev-parse', '--verify', `${remote}/${branchName}`],
			cwd,
			laneEnv,
			laneIndex,
		);
		// Branch exists remotely, check if we have it locally
		try {
			gitExec(['rev-parse', '--verify', branchName], cwd, laneEnv, laneIndex);
			// Already exists locally, just checkout
			gitExec(['checkout', branchName], cwd, laneEnv, laneIndex);
		} catch {
			// Checkout from remote
			gitExec(
				['checkout', '-b', branchName, `${remote}/${branchName}`],
				cwd,
				laneEnv,
				laneIndex,
			);
		}
	} catch {
		// Branch doesn't exist, create new
		gitExec(['checkout', '-b', branchName], cwd, laneEnv, laneIndex);
	}
}

/**
 * Get list of changed files compared to main/master
 * @param cwd - Working directory
 * @param branch - Base branch to compare against (optional, auto-detected if not provided)
 * @returns Array of changed file paths, or empty array if error occurs
 */
export function getChangedFiles(cwd: string, branch?: string): string[] {
	const baseBranch = branch || _internals.getDefaultBaseBranch(cwd);

	try {
		const output = gitExec(['diff', '--name-only', baseBranch, 'HEAD'], cwd);
		return output.trim().split('\n').filter(Boolean);
	} catch (err) {
		warn(
			'Failed to get changed files',
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Get default base branch (main or master)
 */
export function getDefaultBaseBranch(cwd: string): string {
	try {
		// Check if main exists
		gitExec(['rev-parse', '--verify', 'origin/main'], cwd);
		return 'origin/main';
	} catch {
		try {
			gitExec(['rev-parse', '--verify', 'origin/master'], cwd);
			return 'origin/master';
		} catch {
			return 'origin/main'; // fallback
		}
	}
}

/**
 * Stage specific files for commit
 * @param cwd - Working directory
 * @param files - Array of file paths to stage (must not be empty)
 * @throws Error if files array is empty
 */
export function stageFiles(cwd: string, files: string[]): void {
	if (files.length === 0) {
		throw new Error(
			'files array cannot be empty. Use stageAll() to stage all files.',
		);
	}
	gitExec(['add', ...files], cwd);
}

/**
 * Stage all files in the working directory
 * @param cwd - Working directory
 * @param laneEnv - Optional lane env overrides for git spawn
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export function stageAll(
	cwd: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): void {
	gitExec(['add', '.'], cwd, laneEnv, laneIndex);
}

/**
 * Commit changes
 * @param cwd - Working directory
 * @param message - Commit message
 * @param laneEnv - Optional lane env overrides for git spawn
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export function commitChanges(
	cwd: string,
	message: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): void {
	gitExec(['commit', '-m', message], cwd, laneEnv, laneIndex);
}

/**
 * Get current commit SHA
 * @param cwd - Working directory
 * @param laneEnv - Optional lane env overrides for git spawn
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export function getCurrentSha(
	cwd: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): string {
	const output = gitExec(['rev-parse', 'HEAD'], cwd, laneEnv, laneIndex);
	return output.trim();
}

/**
 * Check if there are uncommitted changes
 * @param cwd - Working directory
 * @param laneEnv - Optional lane env overrides for git spawn
 * @param laneIndex - Optional lane index; if laneEnv not provided, reads env file from disk
 */
export function hasUncommittedChanges(
	cwd: string,
	laneEnv?: Record<string, string>,
	laneIndex?: number,
): boolean {
	const status = gitExec(['status', '--porcelain'], cwd, laneEnv, laneIndex);
	return status.trim().length > 0;
}

export interface ResetToRemoteBranchResult {
	success: boolean;
	targetBranch: string;
	localBranch: string;
	message: string;
	alreadyAligned: boolean;
	prunedBranches: string[];
	warnings: string[];
}

/**
 * Detect the default remote branch using multiple fallback methods
 */
export function detectDefaultRemoteBranch(cwd: string): string | null {
	// Method 1: git symbolic-ref refs/remotes/origin/HEAD
	try {
		const output = gitExec(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd);
		const trimmed = output.trim();
		// Parse "refs/remotes/origin/main" -> "main"
		if (trimmed.startsWith('refs/remotes/origin/')) {
			return trimmed.slice('refs/remotes/origin/'.length);
		}
	} catch {
		// Fall through to next method
	}

	// Method 2: git config init.defaultBranch
	try {
		const output = gitExec(['config', 'init.defaultBranch'], cwd);
		const branch = output.trim();
		if (branch) {
			return branch;
		}
	} catch {
		// Fall through to next method
	}

	// Method 3: Verify origin/main exists
	try {
		gitExec(['rev-parse', '--verify', 'origin/main'], cwd);
		return 'main';
	} catch {
		// Fall through to next method
	}

	// Method 4: Verify origin/master exists
	try {
		gitExec(['rev-parse', '--verify', 'origin/master'], cwd);
		return 'master';
	} catch {
		return null;
	}
}

/**
 * Reset local branch to align with its remote counterpart.
 * Safely handles uncommitted changes, unpushed commits, and detached HEAD states.
 *
 * @param cwd - Working directory
 * @param options - Options including pruneBranches flag
 * @returns Result object with success status and details
 */
export async function resetToRemoteBranch(
	cwd: string,
	options?: { pruneBranches?: boolean },
): Promise<ResetToRemoteBranchResult> {
	const warnings: string[] = [];
	const prunedBranches: string[] = [];

	try {
		// Get current branch
		const currentBranch = getCurrentBranch(cwd);

		// Detect default remote branch
		const defaultRemoteBranch = _internals.detectDefaultRemoteBranch(cwd);
		if (!defaultRemoteBranch) {
			return {
				success: false,
				targetBranch: '',
				localBranch: currentBranch,
				message: 'Could not detect default remote branch',
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		}

		const targetBranch = `origin/${defaultRemoteBranch}`;

		// Safety check: Detached HEAD
		if (currentBranch === 'HEAD') {
			return {
				success: false,
				targetBranch,
				localBranch: 'HEAD',
				message: 'Cannot reset: detached HEAD state',
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		}

		// Safety check: Uncommitted changes
		if (hasUncommittedChanges(cwd)) {
			return {
				success: false,
				targetBranch,
				localBranch: currentBranch,
				message: 'Cannot reset: uncommitted changes in working tree',
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		}

		// Safety check: Unpushed commits
		try {
			const logOutput = gitExec(
				['log', `${targetBranch}..HEAD`, '--oneline'],
				cwd,
			);
			if (logOutput.trim().length > 0) {
				return {
					success: false,
					targetBranch,
					localBranch: currentBranch,
					message: 'Cannot reset: unpushed commits',
					alreadyAligned: false,
					prunedBranches: [],
					warnings: [],
				};
			}
		} catch {
			// If log fails, branch might not exist upstream, continue
		}

		// Fetch and refresh remote refs
		try {
			gitExec(['fetch', '--prune', 'origin'], cwd);
		} catch (err) {
			return {
				success: false,
				targetBranch,
				localBranch: currentBranch,
				message: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		}

		// Check if already aligned
		const headSha = gitExec(['rev-parse', 'HEAD'], cwd).trim();
		const remoteSha = gitExec(['rev-parse', `${targetBranch}`], cwd).trim();

		if (headSha === remoteSha) {
			return {
				success: true,
				targetBranch,
				localBranch: currentBranch,
				message: 'Already aligned with remote',
				alreadyAligned: true,
				prunedBranches: [],
				warnings: [],
			};
		}

		// Checkout the local branch first (in case we're on a different branch)
		try {
			gitExec(['checkout', currentBranch], cwd);
		} catch (err) {
			return {
				success: false,
				targetBranch,
				localBranch: currentBranch,
				message: `Checkout failed: ${err instanceof Error ? err.message : String(err)}`,
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		}

		// Reset hard to remote branch with Windows retry
		let resetSucceeded = false;
		let lastError: unknown;
		for (let retry = 0; retry < 4; retry++) {
			if (retry > 0 && process.platform === 'win32') {
				// Async wait for Windows file-locking (FR-018) — yields the event loop
				// instead of a synchronous spin loop that blocks it.
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			try {
				gitExec(['reset', '--hard', targetBranch], cwd);
				resetSucceeded = true;
				break;
			} catch (err) {
				lastError = err;
			}
		}

		if (!resetSucceeded) {
			return {
				success: false,
				targetBranch,
				localBranch: currentBranch,
				message: `Reset failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		}

		// Prune branches if requested
		if (options?.pruneBranches) {
			// Get merged branches and prune them
			try {
				const mergedOutput = gitExec(['branch', '--merged', targetBranch], cwd);
				const mergedLines = mergedOutput.split('\n');
				for (const line of mergedLines) {
					const trimmedLine = line.trim();
					if (!trimmedLine || trimmedLine.startsWith('*')) {
						continue;
					}
					try {
						gitExec(['branch', '-d', trimmedLine], cwd);
						prunedBranches.push(trimmedLine);
					} catch {
						warnings.push(`Could not safely delete branch: ${trimmedLine}`);
					}
				}
			} catch (err) {
				warnings.push(
					`Failed to get merged branches: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// Prune gone upstream branches
			try {
				const branchVvOutput = gitExec(['branch', '-vv'], cwd);
				const vvLines = branchVvOutput.split('\n');
				for (const line of vvLines) {
					const trimmedLine = line.trim();
					if (!trimmedLine || trimmedLine.startsWith('*')) {
						continue;
					}
					// Format: "  branch-name abc123 [origin/branch: gone] message"
					if (trimmedLine.includes(': gone]')) {
						const parts = trimmedLine.split(/\s+/);
						const branchName = parts[0];
						try {
							gitExec(['branch', '-d', branchName], cwd);
							prunedBranches.push(branchName);
						} catch {
							warnings.push(`Could not delete gone branch: ${branchName}`);
						}
					}
				}
			} catch (err) {
				warnings.push(
					`Failed to prune gone branches: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return {
			success: true,
			targetBranch,
			localBranch: currentBranch,
			message: 'Successfully reset to remote branch',
			alreadyAligned: false,
			prunedBranches,
			warnings,
		};
	} catch (err) {
		return {
			success: false,
			targetBranch: '',
			localBranch: '',
			message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
			alreadyAligned: false,
			prunedBranches: [],
			warnings: [],
		};
	}
}

export interface ResetToMainAfterMergeResult {
	success: boolean;
	targetBranch: string;
	previousBranch: string;
	message: string;
	branchDeleted: boolean;
	changesDiscarded: boolean;
	warnings: string[];
}

/**
 * Gitignored build-artifact paths the post-merge alignment (`/swarm finalize`) is
 * allowed to delete. Scoped to an explicit allowlist on purpose: `git clean -fdX`
 * removes EVERY gitignored path under cwd — which in this repo also includes
 * `.swarm/` (the cumulative runtime knowledge store), the gitignored
 * `.claude/issue-traces/` directory (investigation traces), the gitignored files
 * inside `.opencode/` (its `node_modules/`, `package.json`, lockfiles — via a
 * nested `.opencode/.gitignore`), and root `node_modules/` (dependencies). A
 * blanket `git clean -fdX` therefore silently destroyed `.swarm/knowledge.jsonl` —
 * the exact file the finalize clean stage (`runCleanStage`) deliberately preserves.
 * Restricting removal to this allowlist clears stale build output across the
 * reset while leaving runtime/durable state and dependencies untouched.
 * `dist/` is the repo's only committed build output (see the `clean`/`build`
 * scripts in package.json); extend this list only with regenerable build output.
 */
export const GITIGNORED_BUILD_ARTIFACTS: readonly string[] = ['dist'];

/**
 * Aggressive git reset for post-merge cleanup.
 * Handles the common scenario: feature branch PR merged, local has uncommitted artifacts.
 * Steps: detect default branch → safety check → fetch → checkout → discard changes → reset → delete branch.
 * Safety guard: refuses if current branch has commits not on any remote tracking branch.
 */
export async function resetToMainAfterMerge(
	cwd: string,
	options?: { pruneBranches?: boolean },
): Promise<ResetToMainAfterMergeResult> {
	const warnings: string[] = [];

	try {
		// Step 1: Detect default remote branch
		const defaultBranch = _internals.detectDefaultRemoteBranch(cwd);
		if (!defaultBranch) {
			return {
				success: false,
				targetBranch: '',
				previousBranch: '',
				message: 'Could not detect default remote branch',
				branchDeleted: false,
				changesDiscarded: false,
				warnings,
			};
		}

		const currentBranch = getCurrentBranch(cwd);
		const targetBranch = `origin/${defaultBranch}`;

		// Step 2: Safety guard — detached HEAD
		if (currentBranch === 'HEAD') {
			return {
				success: false,
				targetBranch,
				previousBranch: 'HEAD',
				message: 'Cannot reset: detached HEAD state',
				branchDeleted: false,
				changesDiscarded: false,
				warnings,
			};
		}

		// Step 3: Safety guard — check for unpushed commits
		if (currentBranch === defaultBranch) {
			// On default branch — check if there are unpushed commits
			try {
				const logOutput = _internals.gitExec(
					['log', `${targetBranch}..HEAD`, '--oneline'],
					cwd,
				);
				if (logOutput.trim().length > 0) {
					return {
						success: false,
						targetBranch,
						previousBranch: currentBranch,
						message: `Cannot reset: ${defaultBranch} has unpushed commits. Push them first.`,
						branchDeleted: false,
						changesDiscarded: false,
						warnings,
					};
				}
			} catch {
				// No upstream tracking — safe to proceed
			}
		} else {
			// On non-default branch — the primary post-merge scenario.
			// The feature branch typically has commits not on origin/main (the merge
			// happened remotely). Don't block on unpushed commits — we're about to
			// delete this branch. Only block if it's a local-only branch that diverged
			// from the default (could be unpushed work the user still needs).
			try {
				_internals.gitExec(
					['rev-parse', '--abbrev-ref', `${currentBranch}@{upstream}`],
					cwd,
				);
				// Branch has an upstream — it was pushed before, safe to discard
			} catch {
				// No upstream — local-only branch. Check if it diverged from default.
				try {
					const localSha = _internals
						.gitExec(['rev-parse', 'HEAD'], cwd)
						.trim();
					const remoteSha = _internals
						.gitExec(['rev-parse', targetBranch], cwd)
						.trim();
					if (localSha !== remoteSha) {
						return {
							success: false,
							targetBranch,
							previousBranch: currentBranch,
							message: `Cannot reset: branch ${currentBranch} is local-only and diverges from ${defaultBranch}. Push or check manually.`,
							branchDeleted: false,
							changesDiscarded: false,
							warnings,
						};
					}
				} catch {
					return {
						success: false,
						targetBranch,
						previousBranch: currentBranch,
						message: `Cannot reset: unable to compare ${currentBranch} with ${defaultBranch}`,
						branchDeleted: false,
						changesDiscarded: false,
						warnings,
					};
				}
			}
		}

		// Step 4: Fetch latest (hard gate — must succeed to avoid stale refs)
		try {
			_internals.gitExec(['fetch', '--prune', 'origin'], cwd);
		} catch (err) {
			return {
				success: false,
				targetBranch,
				previousBranch: currentBranch,
				message: `Cannot reset: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
				branchDeleted: false,
				changesDiscarded: false,
				warnings,
			};
		}

		// Step 5: Checkout default branch
		const previousBranch = currentBranch;
		let switchedBranch = false;
		if (currentBranch !== defaultBranch) {
			try {
				_internals.gitExec(['checkout', defaultBranch], cwd);
				switchedBranch = true;
			} catch (err) {
				return {
					success: false,
					targetBranch,
					previousBranch,
					message: `Checkout to ${defaultBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
					branchDeleted: false,
					changesDiscarded: false,
					warnings,
				};
			}
		}

		// Step 6: Hard reset to origin/{default}
		// Run BEFORE discard so that if reset fails, the user still has their
		// uncommitted changes (checked out to default branch but not yet discarded).
		try {
			_internals.gitExec(['reset', '--hard', targetBranch], cwd);
		} catch (err) {
			return {
				success: false,
				targetBranch,
				previousBranch,
				message: `Reset to ${targetBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
				branchDeleted: false,
				changesDiscarded: false,
				warnings,
			};
		}

		// Step 7: Discard remaining uncommitted/untracked changes
		// This runs AFTER reset succeeds so that if reset fails, the user still
		// has their changes (checked out to default branch but not yet discarded).
		let changesDiscarded = false;
		if (hasUncommittedChanges(cwd)) {
			let discardSucceeded = false;
			for (let retry = 0; retry < 4; retry++) {
				if (retry > 0 && process.platform === 'win32') {
					// Async wait for Windows file-locking (FR-018) — yields the event loop
					// instead of a synchronous spin loop that blocks it.
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				try {
					_internals.gitExec(['checkout', '--', '.'], cwd);
					discardSucceeded = true;
					break;
				} catch {
					// retry
				}
			}
			if (!discardSucceeded) {
				// Could not discard changes — this is a soft failure
				// Don't abort, but track it
				warnings.push('Could not discard all uncommitted changes after reset');
			}
			changesDiscarded = discardSucceeded;
		}

		// Step 7b: Remove stale gitignored BUILD ARTIFACTS left over from the feature
		// branch, restricted to an explicit allowlist (GITIGNORED_BUILD_ARTIFACTS).
		// `-X` limits removal to gitignored paths; the trailing pathspec limits it
		// further to the allowlist. This pathspec is REQUIRED, not cosmetic: a bare
		// `git clean -fdX` also deletes `.swarm/` (gitignored runtime knowledge store),
		// `.claude/issue-traces/`, gitignored files under `.opencode/`, and
		// `node_modules/` — destroying cumulative knowledge that the finalize clean
		// stage deliberately preserves (FR-013 only guarded non-ignored user files;
		// ignored runtime state was still wiped).
		// git checkout -- . only resets tracked files; git clean removes untracked.
		try {
			_internals.gitExec(
				['clean', '-fdX', '--', ...GITIGNORED_BUILD_ARTIFACTS],
				cwd,
			);
		} catch {
			warnings.push('Could not clean build artifacts');
		}

		// Step 8: Delete previous branch if it's not the default
		// Only delete if the branch was merged into the default branch.
		let branchDeleted = false;
		if (switchedBranch && previousBranch !== defaultBranch) {
			try {
				// Check if the previous branch was merged into default
				const mergedOutput = _internals.gitExec(
					['branch', '--merged', defaultBranch],
					cwd,
				);
				const isMerged = mergedOutput
					.split('\n')
					.some(
						(line) =>
							line.trim() === previousBranch ||
							line.trim() === `* ${previousBranch}`,
					);
				if (isMerged) {
					_internals.gitExec(['branch', '-d', previousBranch], cwd);
					branchDeleted = true;
				} else {
					warnings.push(
						`Branch ${previousBranch} is not merged into ${defaultBranch} — keeping it`,
					);
				}
			} catch {
				warnings.push(`Could not delete branch ${previousBranch}`);
			}
		}

		// Step 9: Prune branches if requested
		if (options?.pruneBranches) {
			try {
				const mergedOutput = _internals.gitExec(
					['branch', '--merged', defaultBranch],
					cwd,
				);
				const mergedLines = mergedOutput.split('\n');
				for (const line of mergedLines) {
					const trimmedLine = line.trim();
					if (
						!trimmedLine ||
						trimmedLine.startsWith('*') ||
						trimmedLine === defaultBranch
					) {
						continue;
					}
					try {
						_internals.gitExec(['branch', '-d', trimmedLine], cwd);
					} catch {
						warnings.push(`Could not prune branch: ${trimmedLine}`);
					}
				}
			} catch (err) {
				warnings.push(
					`Prune failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return {
			success: true,
			targetBranch,
			previousBranch,
			message: branchDeleted
				? `Reset to ${defaultBranch} and deleted branch ${previousBranch}`
				: `Reset to ${defaultBranch}`,
			branchDeleted,
			changesDiscarded,
			warnings,
		};
	} catch (err) {
		return {
			success: false,
			targetBranch: '',
			previousBranch: '',
			message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
			branchDeleted: false,
			changesDiscarded: false,
			warnings,
		};
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	gitExec: typeof gitExec;
	detectDefaultRemoteBranch: typeof detectDefaultRemoteBranch;
	getDefaultBaseBranch: typeof getDefaultBaseBranch;
	getGitRepositoryStatus: typeof getGitRepositoryStatus;
	resetToRemoteBranch: typeof resetToRemoteBranch;
	resetToMainAfterMerge: typeof resetToMainAfterMerge;
	spawnSync: typeof __spawnSyncSeam.spawnSync;
	readLaneEnvFileFromDiskSync: typeof readLaneEnvFileFromDiskSync;
	resolveGitExecutable: typeof resolveGitExecutable;
} = {
	gitExec,
	detectDefaultRemoteBranch,
	getDefaultBaseBranch,
	getGitRepositoryStatus,
	resetToRemoteBranch,
	resetToMainAfterMerge,
	spawnSync: __spawnSyncSeam.spawnSync,
	readLaneEnvFileFromDiskSync,
	resolveGitExecutable,
} as const;

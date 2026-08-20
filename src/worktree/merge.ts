/**
 * Merge-back operations for lean turbo parallel lanes.
 *
 * Provides four public functions for merging lane branches back into
 * the primary worktree, cleaning up lane branches, and handling merge
 * conflicts. All subprocess calls go through the `_internals` DI seam
 * so tests can replace the real `bunSpawn` without leaking across Bun's
 * shared test-runner process.
 *
 * @module merge-back
 */

import * as fs from 'node:fs';
import { advisoryWarn } from '../services/warning-buffer';
import {
	hasRecoveryRecordForBranch,
	recoveryReadErrored,
} from '../turbo/lean/recovery';
import { log } from '../utils';
import { type BunCompatSubprocess, bunSpawn } from '../utils/bun-compat';
import {
	isSpawnCwdMissing,
	isSpawnCwdUnreadable,
} from '../utils/git-binary-missing-error';
import { resolveGitExecutable } from '../utils/git-executable.js';
import { autoCommitDirty, cleanUntrackedFiles } from './core';
import type { MergeStrategy } from './types';

// ---------------------------------------------------------------------------
// _internals DI seam
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.bunSpawn(...)` so tests can replace the function on this object
 * without touching the real `../../utils/bun-compat` module — `mock.module`
 * from `bun:test` leaks across files in Bun's shared test-runner process,
 * which would corrupt unrelated suites that import `bun-compat`. Mutating this
 * local object is file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	bunSpawn: typeof bunSpawn;
	/** Test seam for process.platform — allows non-Windows CIs to exercise Windows paths. */
	platform: string;
	/** Test seam for sleep — allows tests to skip real delays. */
	sleep: (ms: number) => Promise<void>;
	/** Test seam for cleanupOrphanedBranches — allows tests to intercept the cleanup call. */
	cleanupOrphanedBranches: typeof cleanupOrphanedBranches;
	/** Test seam for startupOrphanRecovery — allows tests to intercept the recovery call. */
	startupOrphanRecovery: typeof startupOrphanRecovery;
	/** FR-001b: exposes extractSessionId for lane ownership validation. */
	extractSessionId: typeof extractSessionId;
	/**
	 * Issue #2236 hardening (F1/F4/F5) — resolves the absolute git executable
	 * path instead of spawning the bare `'git'` name. Exposed for test
	 * injection following the `src/worktree/core.ts` convention.
	 */
	resolveGitExecutable: typeof resolveGitExecutable;
} = {
	bunSpawn,
	platform: process.platform,
	sleep: (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
	cleanupOrphanedBranches,
	startupOrphanRecovery,
	extractSessionId,
	resolveGitExecutable,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Why a git child process never started (issue #2236).
 *
 * `cwd-missing` is the reported bug: a lane worktree path read from durable
 * WAL state whose directory has already been torn down. `cwd-unreadable` is
 * the deliberate third state — "cannot tell" must never be treated as "gone",
 * because the recovery path decides whether to discard a branch on it.
 */
export type GitSpawnFailureKind =
	| 'cwd-missing'
	| 'cwd-unreadable'
	| 'spawn-failed';

export interface GitSpawnFailure {
	kind: GitSpawnFailureKind;
	cwd: string;
	message: string;
}

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/**
	 * Present only when the child never started. `exitCode` is a synthetic
	 * non-zero value in that case — it is NOT git's exit status.
	 */
	spawnFailure?: GitSpawnFailure;
}

/** Default timeout for git merge-back operations (30 seconds). */
const MERGE_TIMEOUT_MS = 30_000;

/**
 * Synthetic exit code for a git process that was never created. Non-zero so
 * every existing `exitCode === 0` gate treats it as a failure; `spawnFailure`
 * is the field that says the process never ran.
 */
const GIT_SPAWN_FAILURE_EXIT_CODE = 1;

/**
 * Stage reported when the lane worktree directory is gone AND the lane branch
 * no longer exists — nothing is recoverable. The coder-settlement recovery
 * path keys its self-heal on this stage, then re-verifies branch absence
 * itself before touching the WAL.
 */
export const SOURCE_WORKTREE_GONE_STAGE = 'source-worktree-gone';

/**
 * Stage reported when the lane worktree directory is gone but branch existence
 * could not be determined. Fails closed: callers must never self-heal on it.
 */
export const SOURCE_WORKTREE_UNCERTAIN_STAGE = 'source-worktree-uncertain';

/**
 * Converts a spawn-time failure into `runGit`'s typed failure result.
 *
 * Never throws and never returns a success shape: before #2236 a synchronous
 * spawn throw escaped `runGit` entirely and its raw
 * `ENOENT ... posix_spawn 'git'` reached the user looking like a missing git
 * binary. git was never missing — the `cwd` was.
 */
function gitSpawnFailureResult(
	error: unknown,
	cwd: string,
	args: string[],
): GitResult {
	const operation = args[0] ?? 'command';
	let kind: GitSpawnFailureKind;
	let message: string;
	if (isSpawnCwdMissing(error, cwd)) {
		kind = 'cwd-missing';
		message = `git ${operation} could not start: working directory no longer exists: ${cwd}`;
	} else if (isSpawnCwdUnreadable(error, cwd)) {
		kind = 'cwd-unreadable';
		message = `git ${operation} could not start: working directory could not be inspected: ${cwd}`;
	} else {
		kind = 'spawn-failed';
		message = `git ${operation} could not start in ${cwd}: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
	return {
		exitCode: GIT_SPAWN_FAILURE_EXIT_CODE,
		stdout: '',
		stderr: message,
		spawnFailure: { kind, cwd, message },
	};
}

/**
 * Runs a git command via `_internals.bunSpawn` and returns the exit code,
 * captured stdout, and captured stderr.
 *
 * Every call uses:
 * - Array-form command (never shell-string)
 * - Explicit `cwd`
 * - `stdin: 'ignore'` (prevents Bun/Windows pipe hangs)
 * - `env: { LC_ALL: 'C' }` (ensures locale-independent English output)
 * - Bounded `timeout`
 * - Best-effort `proc.kill()` in `finally`
 *
 * #2236 F0a: the spawn call itself sits INSIDE the `try`. It used to sit
 * outside, so a synchronous spawn throw bypassed both the `try` and the
 * `finally`'s `proc.kill()`. `proc` is therefore declared before the `try`
 * and killed with `proc?.kill()`, or the timeout-kill guarantee would
 * silently regress for every caller.
 */
async function runGit(
	args: string[],
	cwd: string,
	timeoutMs = MERGE_TIMEOUT_MS,
): Promise<GitResult> {
	let proc: BunCompatSubprocess | undefined;
	try {
		proc = _internals.bunSpawn([_internals.resolveGitExecutable(), ...args], {
			cwd,
			timeout: timeoutMs,
			stdin: 'ignore' as const,
			stdout: 'pipe' as const,
			stderr: 'pipe' as const,
			env: { ...process.env, LC_ALL: 'C' },
		});
		// The Bun path reports process-creation failure synchronously (now as a
		// value, not a throw); the Node path reports it asynchronously via the
		// `error` event. Check both sides of the await, and return before
		// touching the streams of a process that never existed.
		if (proc.spawnError) {
			return gitSpawnFailureResult(proc.spawnError, cwd, args);
		}
		const exitCode = await proc.exited;
		if (proc.spawnError) {
			return gitSpawnFailureResult(proc.spawnError, cwd, args);
		}
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} catch (error) {
		// Defense in depth behind the chokepoint in `bunSpawn`: even if a future
		// spawn path throws again, the raw error is contained here and converted
		// into the typed failure result rather than escaping to a tool boundary.
		return gitSpawnFailureResult(error, cwd, args);
	} finally {
		try {
			proc?.kill();
		} catch {
			// best-effort — process may already be exited
		}
	}
}

/**
 * Parses conflicted file names from git merge/rebase/cherry-pick output.
 * Looks for lines matching "CONFLICT (content) Merge conflict in <path>"
 * and extracts the file path.
 */
function parseConflictFiles(output: string): string[] {
	const files: string[] = [];
	const lines = output.split('\n');
	for (const line of lines) {
		const match = line.match(/CONFLICT\b.*(?:Merge conflict in |in )(.+)/);
		if (match?.[1]) {
			files.push(match[1].trim());
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Return-type interfaces
// ---------------------------------------------------------------------------

export interface MergeSuccess {
	merged: true;
	strategy: string;
}

export interface MergeConflict {
	conflict: true;
	files: string[];
	message: string;
}

export interface MergeFailure {
	error: string;
}

export interface CleanupSuccess {
	cleaned: true;
}

export interface CleanupFailure {
	error: string;
	partial?: boolean;
}

export interface ConflictInfo {
	files: string[];
	message: string;
	aborted: true;
}

export interface ConflictHandlingError {
	error: string;
	aborted: boolean;
}

// ---------------------------------------------------------------------------
// Progressive dirty-cleanup merge-back return types (DD-7)
// ---------------------------------------------------------------------------

export interface DirtyMergeSuccess {
	merged: true;
	strategy: string;
	autoCommitted: boolean;
	cleaned: boolean;
	/** True when a resumed operation was already present on the target. */
	reconciled?: boolean;
	/** Durable identity for the Git operation, when settlement tracking is enabled. */
	provenance?: MergeOperationProvenance;
}

export interface DirtyMergePartial {
	partial: true;
	stage: string;
	autoCommitted: boolean;
	cleaned: boolean;
	message: string;
	conflictFiles?: string[];
	provenance?: MergeOperationProvenance;
}

export interface DirtyMergeFailure {
	failed: true;
	stage: string;
	message: string;
	provenance?: MergeOperationProvenance;
}

/**
 * Durable identity for a standard-worktree merge-back operation.
 *
 * `sourceHead` is captured after the lane's dirty state is auto-committed and
 * `targetHeadBefore` immediately before the merge starts. The stable
 * `operationId` is supplied by the durable background-delegation record.
 */
export interface MergeOperationProvenance {
	operationId: string;
	sourceHead: string;
	targetHeadBefore: string;
	branchName: string;
	strategy: MergeStrategy;
}

/**
 * Git object ids as written by `git rev-parse HEAD`: sha1 (40) today, sha256 (64)
 * under the sha256 object format. Abbreviated ids are deliberately rejected —
 * nothing in this codebase persists them. Constraining the shape also makes a
 * leading `-` structurally impossible for values later passed to git as
 * revisions, which matters because neither sink below passes a separator that
 * would protect one today: the `git log` call's `--` sits after the range and
 * separates pathspecs rather than options, and the
 * `git merge-base --is-ancestor` call passes the revision bare. (Both commands
 * would accept `--`/`--end-of-options` before the operand, so sink-side
 * hardening is also available; this pattern guards the value itself.)
 *
 * Owned here beside `MergeOperationProvenance` because this module defines the
 * struct whose head fields reach git argv; `workflow-wal-schema.ts` re-imports
 * it so the two validation surfaces for the same values cannot drift apart.
 */
export const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export type MergeReconciliationResult =
	| {
			landed: true;
			method: 'ancestry' | 'cherry-pick-trailer';
	  }
	| {
			landed: false;
			error?: string;
	  };

export interface DirtyMergeOptions {
	/** Stable identifier allocated before the merge-back begins. */
	operationId?: string;
	/** Previously persisted provenance when resuming a `settling` operation. */
	resume?: MergeOperationProvenance;
	/**
	 * Awaited after auto-commit and HEAD capture, but before the Git merge.
	 * A rejection fails closed without invoking the merge.
	 */
	onBeforeMerge?: (provenance: MergeOperationProvenance) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Orphaned branch cleanup return types
// ---------------------------------------------------------------------------

export interface OrphanCleanupResult {
	removed: string[];
	skipped: string[];
	errors: Array<{ branch: string; error: string }>;
	/** #1657: lane branches skipped because a recovery record references them. */
	skippedRecoveryBranches: string[];
	/** #1657: set when the recovery-directory read errored and ALL lane-branch
	 * deletions were skipped this pass (fail-safe). */
	recoveryReadError?: boolean;
}

export interface OrphanCleanupOptions {
	/**
	 * Preserve branches that are not merged into HEAD. Interactive reset flows
	 * retain the historical force-delete default; unattended startup recovery
	 * sets this to true so a missing worktree cannot erase its only commits.
	 */
	preserveUnmerged?: boolean;
}

export interface StartupRecoveryResult {
	prunedWorktrees: boolean;
	remainingBranches: string[];
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Reads the merge strategy from the lean turbo configuration.
 *
 * Returns `config.merge_strategy` if set, otherwise defaults to `'merge'`.
 * This is a pure function — no subprocess calls.
 *
 * @param config - Lean turbo configuration.
 * @returns The merge strategy to use: `'merge'`, `'rebase'`, or `'cherry-pick'`.
 */
export function getMergeStrategy(config: {
	mergeStrategy?: MergeStrategy;
	merge_strategy?: MergeStrategy;
}): MergeStrategy {
	return config.mergeStrategy ?? config.merge_strategy ?? 'merge';
}

/**
 * Merges a lane branch back into the primary worktree using the specified
 * strategy.
 *
 * On conflict, automatically aborts the in-progress merge/rebase/cherry-pick
 * to restore the working tree to a clean state, then returns conflict details.
 *
 * @param primaryDir - The main project root (cwd for all git commands).
 * @param branchName - The lane branch name (e.g. `swarm-lane/<sessionId>/<laneId>`).
 * @param strategy   - Merge strategy to use.
 * @returns Discriminated union: success, conflict, or failure.
 */
export async function mergeLaneBranch(
	primaryDir: string,
	branchName: string,
	strategy: MergeStrategy,
): Promise<MergeSuccess | MergeConflict | MergeFailure> {
	let result: GitResult;

	switch (strategy) {
		case 'merge':
			result = await runGit(['merge', '--no-edit', branchName], primaryDir);
			break;
		case 'rebase':
			result = await runGit(['rebase', branchName], primaryDir);
			break;
		case 'cherry-pick': {
			// Cherry-pick the full commit range, not just the tip.
			// Find the merge-base between HEAD and the lane branch so we can
			// replay every commit on the lane since it diverged.
			const mergeBaseResult = await runGit(
				['merge-base', 'HEAD', branchName],
				primaryDir,
			);
			if (mergeBaseResult.exitCode === 0 && mergeBaseResult.stdout.trim()) {
				const mergeBase = mergeBaseResult.stdout.trim();
				result = await runGit(
					['cherry-pick', `${mergeBase}..${branchName}`, '-x'],
					primaryDir,
				);
			} else {
				// No common ancestor (e.g. unrelated histories) — fall back
				// to cherry-picking just the branch tip with a warning.
				advisoryWarn(
					'[worktree] mergeLaneBranch: git merge-base failed for cherry-pick; falling back to tip-only cherry-pick',
				);
				result = await runGit(['cherry-pick', branchName, '-x'], primaryDir);
			}
			break;
		}
	}

	if (result.exitCode === 0) {
		return { merged: true, strategy };
	}

	const combinedOutput = `${result.stderr}\n${result.stdout}`;
	const hasConflict =
		/CONFLICT/i.test(combinedOutput) || /conflict/i.test(combinedOutput);

	if (hasConflict) {
		// Parse conflicted files from output
		const files = parseConflictFiles(combinedOutput);

		// Abort the in-progress merge/rebase/cherry-pick to restore clean state
		const abortArgs =
			strategy === 'rebase'
				? ['rebase', '--abort']
				: strategy === 'cherry-pick'
					? ['cherry-pick', '--abort']
					: ['merge', '--abort'];
		await runGit(abortArgs, primaryDir);

		return {
			conflict: true,
			files,
			message: result.stderr.trim(),
		};
	}

	return {
		error: result.stderr.trim() || result.stdout.trim(),
	};
}

/**
 * Detect whether a previously-started merge-back already landed on the target.
 *
 * Merge and rebase settlement uses ancestry. Cherry-pick settlement uses the
 * exact provenance trailer emitted by Git's `cherry-pick -x`; patch identity or
 * subject matching is intentionally insufficient.
 */
export async function reconcileLandedMerge(
	primaryDir: string,
	provenance: MergeOperationProvenance,
): Promise<MergeReconciliationResult> {
	if (
		!provenance.operationId ||
		!provenance.sourceHead ||
		!provenance.targetHeadBefore
	) {
		return { landed: false, error: 'Incomplete merge operation provenance' };
	}

	// Both heads reach `git` argv below (a revision operand and a revision range).
	// They round-trip through the on-disk delegation ledger, so re-validate their
	// shape here — the single chokepoint every argv path passes through — rather
	// than trusting whichever caller rebuilt the struct.
	if (
		!GIT_OBJECT_ID_PATTERN.test(provenance.sourceHead) ||
		!GIT_OBJECT_ID_PATTERN.test(provenance.targetHeadBefore)
	) {
		return { landed: false, error: 'Malformed merge operation provenance' };
	}

	if (provenance.strategy !== 'cherry-pick') {
		const ancestry = await runGit(
			['merge-base', '--is-ancestor', provenance.sourceHead, 'HEAD'],
			primaryDir,
		);
		if (ancestry.exitCode === 0) {
			return { landed: true, method: 'ancestry' };
		}
		if (ancestry.exitCode === 1) {
			return { landed: false };
		}
		return {
			landed: false,
			error:
				ancestry.stderr.trim() ||
				ancestry.stdout.trim() ||
				`git merge-base exited ${ancestry.exitCode}`,
		};
	}

	const exactTrailer = `(cherry picked from commit ${provenance.sourceHead})`;
	const escapedTrailer = exactTrailer.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
	const trailerSearch = await runGit(
		[
			'log',
			'--format=%H',
			'--extended-regexp',
			`--grep=^${escapedTrailer}$`,
			'--max-count=1',
			`${provenance.targetHeadBefore}..HEAD`,
			// Trailing `--` (after the revision range, never before it) so the range can
			// never be reinterpreted as a pathspec. `git merge-base --is-ancestor` above
			// takes no pathspec operand, so it deliberately does not get the same guard.
			'--',
		],
		primaryDir,
	);
	if (trailerSearch.exitCode !== 0) {
		return {
			landed: false,
			error:
				trailerSearch.stderr.trim() ||
				trailerSearch.stdout.trim() ||
				`git log exited ${trailerSearch.exitCode}`,
		};
	}
	return trailerSearch.stdout.trim()
		? { landed: true, method: 'cherry-pick-trailer' }
		: { landed: false };
}

/**
 * Cleans up a lane branch after a successful merge.
 *
 * Deletes the lane branch and prunes stale worktree metadata (DD-9).
 * Reports partial success if branch deletion fails but worktree prune succeeds.
 *
 * @param directory  - The project root (cwd for git commands).
 * @param branchName - The lane branch name to delete.
 * @returns Discriminated union: success, partial failure, or full failure.
 */
export async function postMergeCleanup(
	directory: string,
	branchName: string,
): Promise<CleanupSuccess | CleanupFailure> {
	// Prune stale worktree metadata FIRST (DD-9, #2236 BR-2).
	//
	// Order is load-bearing, not cosmetic: git refuses `branch -d/-D` for a
	// branch that a *registered* worktree still claims — including a worktree
	// whose directory has already been deleted — with
	// `error: cannot delete branch 'X' used by worktree at ...`. Pruning after
	// the delete leaves the branch alive, which then trips
	// CODER_SETTLEMENT_WORKTREE_CLEANUP_UNVERIFIED and reproduces the #2236
	// deadlock under a different message. Verified empirically on git 2.54.
	const pruneResult = await runGit(['worktree', 'prune'], directory);
	const pruneOk = pruneResult.exitCode === 0;

	// Delete the lane branch (DD-9)
	const deleteResult = await runGit(['branch', '-D', branchName], directory);
	const deleteOk = deleteResult.exitCode === 0;

	if (deleteOk && pruneOk) {
		return { cleaned: true };
	}

	if (!deleteOk && pruneOk) {
		return {
			error: `Branch delete failed: ${deleteResult.stderr.trim() || deleteResult.stdout.trim()}`,
			partial: true,
		};
	}

	return {
		error: deleteOk
			? `Worktree prune failed: ${pruneResult.stderr.trim() || pruneResult.stdout.trim()}`
			: `Branch delete failed: ${deleteResult.stderr.trim() || deleteResult.stdout.trim()}; worktree prune failed: ${pruneResult.stderr.trim() || pruneResult.stdout.trim()}`,
	};
}

/**
 * Remove only stale Git worktree registration metadata. This deliberately does
 * not delete a lane branch; callers hand branch reconciliation to
 * `provisionWorktree`, which refuses branches with unmerged commits and uses
 * non-forced `git branch -d` for proven-merged stale branches.
 */
export async function pruneStaleWorktreeMetadata(
	directory: string,
): Promise<{ pruned: true } | { error: string }> {
	const result = await runGit(['worktree', 'prune'], directory);
	if (result.exitCode === 0) return { pruned: true };
	return {
		error:
			result.stderr.trim() ||
			result.stdout.trim() ||
			`git worktree prune exited ${result.exitCode}`,
	};
}

export type RegisteredWorktreeLivenessScan =
	| { status: 'ok'; liveBranches: string[] }
	| { status: 'uncertain'; reason: string };

/**
 * Enumerate branches whose registered worktree paths still exist. Stale Git
 * metadata with a missing path is deliberately excluded so an expired
 * provisional owner cannot become permanent ownership after a crash.
 */
export async function scanRegisteredWorktreeLiveness(
	directory: string,
): Promise<RegisteredWorktreeLivenessScan> {
	const result = await runGit(
		['-c', 'core.quotepath=false', 'worktree', 'list', '--porcelain'],
		directory,
	);
	if (result.exitCode !== 0) {
		const raw =
			result.stderr.trim() ||
			result.stdout.trim() ||
			`git worktree list exited ${result.exitCode}`;
		return {
			status: 'uncertain',
			reason: raw.length > 500 ? `${raw.slice(0, 500)}... (truncated)` : raw,
		};
	}

	const liveBranches: string[] = [];
	let worktreePath: string | undefined;
	for (const rawLine of `${result.stdout}\n`.split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.startsWith('worktree ')) {
			worktreePath = line.slice('worktree '.length);
			continue;
		}
		if (!line.startsWith('branch ') || !worktreePath) continue;
		try {
			fs.statSync(worktreePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') continue;
			return {
				status: 'uncertain',
				reason: `registered worktree path "${worktreePath}" is unreadable: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
		const branch = line.slice('branch '.length);
		liveBranches.push(
			branch.startsWith('refs/heads/')
				? branch.slice('refs/heads/'.length)
				: branch,
		);
	}
	return { status: 'ok', liveBranches };
}

/**
 * Handles a merge conflict by listing conflicted files and aborting the
 * in-progress operation to restore the working tree to a clean state.
 *
 * Uses a strategy-specific abort command so the correct git sub-command
 * is invoked (`merge --abort`, `rebase --abort`, or `cherry-pick --abort`).
 * Using the wrong abort command would leave the repository in a dirty state.
 *
 * @param primaryDir - The main project root (cwd for all git commands).
 * @param branchName - The lane branch name that caused the conflict.
 *   Retained for logging and future conflict-reporting use.
 * @param strategy - The merge strategy that is currently in progress.
 * @returns Discriminated union: conflict info or handling error.
 */
export async function handleMergeConflict(
	primaryDir: string,
	_branchName: string,
	strategy: MergeStrategy,
): Promise<ConflictInfo | ConflictHandlingError> {
	const abortArgs =
		strategy === 'rebase'
			? ['rebase', '--abort']
			: strategy === 'cherry-pick'
				? ['cherry-pick', '--abort']
				: ['merge', '--abort'];

	// List conflicted files
	const diffResult = await runGit(
		['diff', '--name-only', '--diff-filter=U'],
		primaryDir,
	);

	if (diffResult.exitCode !== 0) {
		// Attempt abort anyway using the correct strategy
		const abortResult = await runGit(abortArgs, primaryDir);
		return {
			error: `Failed to list conflicted files: ${diffResult.stderr.trim() || diffResult.stdout.trim()}`,
			aborted: abortResult.exitCode === 0,
		};
	}

	const files = diffResult.stdout
		.trim()
		.split('\n')
		.filter((f) => f.length > 0);

	// Abort the in-progress operation using the correct strategy
	const abortResult = await runGit(abortArgs, primaryDir);

	if (abortResult.exitCode === 0) {
		return {
			files,
			message: `Conflicts detected in ${files.length} file(s): ${files.join(', ')}`,
			aborted: true,
		};
	}

	return {
		error: `${strategy} abort failed: ${abortResult.stderr.trim() || abortResult.stdout.trim()}`,
		aborted: false,
	};
}

/**
 * Reads the lane branch tip from the PRIMARY repository.
 *
 * `--verify --quiet` gives a clean three-way answer, verified on git 2.54:
 * exit 0 with the object id on stdout when the branch exists, exit 1 with
 * empty stdout when it does not, anything else means git itself failed and
 * the answer is indeterminate. `refs/heads/` is spelled out so the revision
 * can never be reinterpreted (a lane branch name is repo-derived, and a bare
 * name is ambiguous between a ref and a path).
 */
async function readLaneBranchHead(
	branchName: string,
	primaryDir: string,
): Promise<GitResult> {
	return runGit(
		['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
		primaryDir,
	);
}

/**
 * Captures the lane's source HEAD (#2236 BR-1).
 *
 * The provenance guard this feeds is a merge-SAFETY check, not a convenience:
 * it refuses to proceed when the lane branch or the target has moved since
 * provenance was written, and the recovery path is the only path carrying it.
 * So when the worktree directory is gone the capture is RELOCATED to the
 * primary repository — never dropped. Everything the coder committed lives on
 * the lane branch in the primary object store and stays fully reachable
 * (verified on git 2.54 with the worktree directory deleted and its
 * registration left stale).
 *
 * Detection is reactive rather than a proactive `fs` probe: we only conclude
 * "gone" from an actual `cwd-missing` spawn failure, so a live worktree takes
 * exactly the pre-#2236 code path.
 */
async function captureLaneSourceHead(
	worktreePath: string,
	branchName: string,
	primaryDir: string,
	knownMissing: boolean,
): Promise<{ result: GitResult; sourceWorktreeMissing: boolean }> {
	if (!knownMissing) {
		const fromWorktree = await runGit(['rev-parse', 'HEAD'], worktreePath);
		if (fromWorktree.spawnFailure?.kind !== 'cwd-missing') {
			return { result: fromWorktree, sourceWorktreeMissing: false };
		}
	}
	return {
		result: await readLaneBranchHead(branchName, primaryDir),
		sourceWorktreeMissing: true,
	};
}

/**
 * "Source worktree is gone" mode (#2236 F0b).
 *
 * Returns `null` when the merge can still be recovered from the branch, or a
 * typed failure when it cannot. Decides on BRANCH existence, never on
 * directory existence alone — marking a settlement terminal while the branch
 * survives would strand the coder's commits on an orphan branch the user has
 * no pointer to.
 */
async function handleSourceWorktreeGone(
	branchHead: GitResult,
	worktreePath: string,
	branchName: string,
	primaryDir: string,
	provenance: MergeOperationProvenance | undefined,
): Promise<DirtyMergeFailure | null> {
	const branchResolved =
		branchHead.spawnFailure === undefined &&
		branchHead.exitCode === 0 &&
		branchHead.stdout.trim().length > 0;
	if (!branchResolved) {
		// Branch definitely absent (clean exit 1, empty stdout) vs. "cannot
		// tell". Only the first is recoverable-as-nothing; the second must fail
		// closed so no caller discards state on an uncertain answer.
		const definitelyAbsent =
			branchHead.spawnFailure === undefined && branchHead.exitCode === 1;
		return {
			failed: true,
			stage: definitelyAbsent
				? SOURCE_WORKTREE_GONE_STAGE
				: SOURCE_WORKTREE_UNCERTAIN_STAGE,
			message: definitelyAbsent
				? `Lane worktree "${worktreePath}" is gone and branch "${branchName}" no longer exists; nothing is recoverable`
				: `Lane worktree "${worktreePath}" is gone and branch "${branchName}" existence could not be determined: ${
						branchHead.stderr.trim() || `git exited ${branchHead.exitCode}`
					}`,
			...(provenance ? { provenance } : {}),
		};
	}
	// #2236 BR-2: drop the stale registration BEFORE anything tries to delete
	// the branch. `git branch -d/-D` refuses while a registered worktree still
	// claims it, even when that worktree's directory is already gone. Do not
	// rely on `git worktree remove` returning 0 for a missing directory — that
	// was only verified on one git version, and CI spans three.
	const prune = await runGit(['worktree', 'prune'], primaryDir);
	if (prune.exitCode !== 0) {
		log(
			`[worktree] attemptMergeBackFromDirty: worktree prune failed for "${worktreePath}": ${
				prune.stderr.trim() || prune.stdout.trim()
			}`,
		);
	}
	// Deliberately states what was DONE, not what will succeed: this runs
	// before the provenance guard below, which can still refuse the merge.
	advisoryWarn(
		`STALE_LANE_WORKTREE_DETECTED: lane worktree "${worktreePath}" no longer exists. ` +
			`Its stale git registration was pruned, and the merge-back for branch "${branchName}" ` +
			`is being taken from "${primaryDir}" instead. Any uncommitted work in that worktree is ` +
			'unrecoverable; every commit on the branch is preserved.',
	);
	return null;
}

/**
 * Attempts to merge a lane branch back from a potentially dirty worktree
 * using progressive cleanup (DD-7).
 *
 * Pipeline:
 * 1. Auto-commit dirty state in the worktree
 * 2. Clean untracked files
 * 3. Attempt the merge-back
 *
 * Each step is fault-tolerant: failures log a warning and continue.
 * Only when both auto-commit AND clean fail (not just skip) does the
 * pipeline abandon early with `{ failed: true, stage: 'cleanup' }`.
 *
 * @param worktreePath - Absolute path to the lane worktree directory.
 * @param branchName   - The lane branch name (e.g. `swarm-lane/<sessionId>/<laneId>`).
 * @param primaryDir   - The main project root (cwd for merge commands).
 * @param strategy     - Merge strategy to use.
 * @returns Discriminated union: success, partial, or failure.
 */
export async function attemptMergeBackFromDirty(
	worktreePath: string,
	branchName: string,
	primaryDir: string,
	strategy: MergeStrategy,
	options: DirtyMergeOptions = {},
): Promise<DirtyMergeSuccess | DirtyMergePartial | DirtyMergeFailure> {
	let autoCommitted = false;
	let cleaned = false;
	let autoCommitFailed = false;
	let cleanFailed = false;
	let provenance = options.resume;
	/**
	 * #2236 F0b: set once the lane worktree directory is proven gone. Drives
	 * the "dirty state is unrecoverable-and-empty" path — an added path, never
	 * an abort — and is only ever set from a definite `cwd-missing` spawn
	 * failure, so an unreadable directory keeps today's behaviour.
	 */
	let sourceWorktreeMissing = false;

	if (provenance) {
		if (
			provenance.branchName !== branchName ||
			provenance.strategy !== strategy ||
			(options.operationId !== undefined &&
				provenance.operationId !== options.operationId)
		) {
			return {
				failed: true,
				stage: 'reconciliation',
				message: 'Stored merge operation identity does not match this dispatch',
				provenance,
			};
		}

		const reconciliation = await reconcileLandedMerge(primaryDir, provenance);
		if ('error' in reconciliation && reconciliation.error) {
			return {
				failed: true,
				stage: 'reconciliation',
				message: `Unable to reconcile prior merge-back: ${reconciliation.error}`,
				provenance,
			};
		}
		if (reconciliation.landed) {
			return {
				merged: true,
				strategy,
				autoCommitted: false,
				cleaned: false,
				reconciled: true,
				provenance,
			};
		}

		// #2236 BR-1: the guard below is RELOCATED, not skipped, when the lane
		// worktree is gone — its `sourceHead`/`targetHead` comparison is the
		// only thing stopping a stale-provenance merge, and this is the only
		// path that carries it.
		const source = await captureLaneSourceHead(
			worktreePath,
			branchName,
			primaryDir,
			false,
		);
		if (source.sourceWorktreeMissing) {
			const unrecoverable = await handleSourceWorktreeGone(
				source.result,
				worktreePath,
				branchName,
				primaryDir,
				provenance,
			);
			if (unrecoverable) return unrecoverable;
			sourceWorktreeMissing = true;
		}
		const sourceHead = source.result;
		const targetHead = await runGit(['rev-parse', 'HEAD'], primaryDir);
		if (
			sourceHead.exitCode !== 0 ||
			targetHead.exitCode !== 0 ||
			sourceHead.stdout.trim() !== provenance.sourceHead ||
			targetHead.stdout.trim() !== provenance.targetHeadBefore
		) {
			return {
				failed: true,
				stage: 'reconciliation',
				message:
					'Stored merge operation did not land and its source or target HEAD has changed',
				provenance,
			};
		}
	}

	// Step 1: Auto-commit dirty state.
	// Skipped when the worktree directory is gone: there is no working tree
	// left to commit, and nothing is lost by not trying.
	if (!provenance && !sourceWorktreeMissing) {
		const commitResult = await autoCommitDirty(worktreePath);
		if (commitResult.committed) {
			autoCommitted = true;
		} else if (commitResult.reason !== 'Nothing to commit') {
			autoCommitFailed = true;
			log(
				`[worktree] attemptMergeBackFromDirty: auto-commit failed for worktree "${worktreePath}" branch "${branchName}": ${commitResult.reason}`,
			);
		}
	}

	// Step 2: Clean untracked files. Skipped for the same reason as step 1 —
	// no directory means no untracked files to clean.
	if (!sourceWorktreeMissing) {
		const cleanResult = await cleanUntrackedFiles(worktreePath);
		if (cleanResult.cleaned) {
			cleaned = true;
		} else {
			cleanFailed = true;
			log(
				`[worktree] attemptMergeBackFromDirty: clean untracked failed for worktree "${worktreePath}" branch "${branchName}": ${cleanResult.error}`,
			);
		}
	}

	// Step 3a: Abandon if both auto-commit AND clean truly failed
	if (autoCommitFailed && cleanFailed) {
		// #2236 F0b: both steps also fail when the worktree DIRECTORY is gone,
		// which is recoverable rather than fatal. Ask git directly — a
		// `cwd-missing` spawn failure is the only accepted proof, so a live
		// worktree whose git commands merely failed still abandons as before.
		const probe = await runGit(['rev-parse', '--git-dir'], worktreePath);
		if (probe.spawnFailure?.kind === 'cwd-missing') {
			const unrecoverable = await handleSourceWorktreeGone(
				await readLaneBranchHead(branchName, primaryDir),
				worktreePath,
				branchName,
				primaryDir,
				provenance,
			);
			if (unrecoverable) return unrecoverable;
			sourceWorktreeMissing = true;
			// Neither step could have lost anything: there was no working tree.
			autoCommitFailed = false;
			cleanFailed = false;
			cleaned = false;
		} else {
			return {
				failed: true,
				stage: 'cleanup',
				message: 'Auto-commit and clean both failed; abandoning worktree',
				...(provenance ? { provenance } : {}),
			};
		}
	}

	if (!provenance && (options.operationId || options.onBeforeMerge)) {
		if (!options.operationId) {
			return {
				failed: true,
				stage: 'pre-merge',
				message: 'A pre-merge callback requires a stable operationId',
			};
		}
		// #2236 BR-1: same relocation as the provenance branch above.
		const source = await captureLaneSourceHead(
			worktreePath,
			branchName,
			primaryDir,
			sourceWorktreeMissing,
		);
		if (source.sourceWorktreeMissing && !sourceWorktreeMissing) {
			const unrecoverable = await handleSourceWorktreeGone(
				source.result,
				worktreePath,
				branchName,
				primaryDir,
				provenance,
			);
			if (unrecoverable) return unrecoverable;
			sourceWorktreeMissing = true;
		}
		const sourceHead = source.result;
		const targetHead = await runGit(['rev-parse', 'HEAD'], primaryDir);
		if (
			sourceHead.exitCode !== 0 ||
			targetHead.exitCode !== 0 ||
			!sourceHead.stdout.trim() ||
			!targetHead.stdout.trim()
		) {
			return {
				failed: true,
				stage: 'pre-merge',
				message: 'Unable to capture source and target HEAD before merge-back',
			};
		}
		provenance = {
			operationId: options.operationId,
			sourceHead: sourceHead.stdout.trim(),
			targetHeadBefore: targetHead.stdout.trim(),
			branchName,
			strategy,
		};
		if (options.onBeforeMerge) {
			try {
				await options.onBeforeMerge(provenance);
			} catch (error) {
				return {
					failed: true,
					stage: 'pre-merge',
					message: `Unable to persist merge operation provenance: ${String(error)}`,
					provenance,
				};
			}
		}
	}

	// Step 3b: Attempt merge-back
	const mergeResult = await mergeLaneBranch(primaryDir, branchName, strategy);

	if ('merged' in mergeResult && mergeResult.merged) {
		return {
			merged: true,
			strategy,
			autoCommitted,
			cleaned,
			...(provenance ? { reconciled: false, provenance } : {}),
		};
	}

	if ('conflict' in mergeResult) {
		return {
			partial: true,
			stage: 'merge',
			autoCommitted,
			cleaned,
			message: mergeResult.message,
			conflictFiles: mergeResult.files,
			...(provenance ? { provenance } : {}),
		};
	}

	// MergeFailure case — narrowed from the union by eliminating success and conflict
	if ('error' in mergeResult) {
		return {
			failed: true,
			stage: 'merge',
			message: mergeResult.error,
			...(provenance ? { provenance } : {}),
		};
	}

	// Fallback (should not reach here)
	return {
		failed: true,
		stage: 'merge',
		message: 'Merge failed with unexpected result',
		...(provenance ? { provenance } : {}),
	};
}

// ---------------------------------------------------------------------------
// Orphaned branch cleanup
// ---------------------------------------------------------------------------

/**
 * Extracts the session ID from a swarm-lane branch name.
 *
 * Branch format: `swarm-lane/<sessionId>/<laneId>` or
 * `swarm/lane/<sessionId>/<laneId>`.
 * Returns the sessionId (second segment), or `null` if the name does not
 * match the expected pattern.
 */
function extractSessionId(branchName: string): string | null {
	const segments = branchName.trim().split('/');
	// Expected legacy: ['swarm-lane', '<sessionId>', '<laneId>']
	if (segments.length >= 3 && segments[0] === 'swarm-lane') {
		return segments[1];
	}
	// Expected purpose-based: ['swarm', 'lane', '<sessionId>', '<laneId>']
	if (
		segments.length >= 4 &&
		segments[0] === 'swarm' &&
		segments[1] === 'lane'
	) {
		return segments[2];
	}
	return null;
}

async function listLaneBranches(directory: string): Promise<string[]> {
	const branches = new Set<string>();
	// List all branches without a --list pattern. Using `--list 'swarm-lane/*'`
	// is unreliable cross-platform: git's wildmatch uses WM_PATHNAME on Linux,
	// where `*` does not match `/`, missing nested branches like
	// `swarm-lane/session/lane`. Filtering in code is portable.
	const result = await runGit(
		['branch', '--format=%(refname:short)'],
		directory,
	);
	if (result.exitCode === 0) {
		for (const line of result.stdout.split('\n')) {
			const branch = line.trim();
			if (
				branch.length > 0 &&
				(branch.startsWith('swarm-lane/') || branch.startsWith('swarm/lane/'))
			) {
				branches.add(branch);
			}
		}
	}
	return [...branches];
}

/**
 * Cleans up orphaned swarm-lane branches that do not belong to any active session.
 *
 * Lists all swarm-lane/ and swarm/lane/ branches, identifies orphans (branches whose
 * session ID is not in `activeSessionIds`), deletes them according to the
 * requested preservation policy, and prunes stale worktree metadata.
 *
 * @param directory        - The project root (cwd for all git commands).
 * @param activeSessionIds - Session IDs that are still active; their branches are skipped.
 * @param options          - Branch preservation policy for unattended recovery.
 * @returns Result with arrays of removed, skipped, and errored branch names.
 */
export async function cleanupOrphanedBranches(
	directory: string,
	activeSessionIds: string[] = [],
	options: OrphanCleanupOptions = {},
): Promise<OrphanCleanupResult> {
	const removed: string[] = [];
	const skipped: string[] = [];
	const skippedRecoveryBranches: string[] = [];
	const errors: Array<{ branch: string; error: string }> = [];

	// #1657 fail-safe: if the recovery directory exists but is unreadable, we
	// cannot tell which branches are preserved for manual recovery. Skip ALL
	// lane-branch deletions this pass (recovery safety trumps orphan
	// cleanliness). The caller's advisory surfaces this; repairing
	// `.swarm/recovery/` (clearing corrupt records) restores normal cleanup.
	const recoveryReadError = recoveryReadErrored(directory);
	if (recoveryReadError) {
		log(
			'[worktree] cleanupOrphanedBranches: .swarm/recovery/ read error — skipping all ' +
				'lane-branch deletions this pass (fail-safe for preserved recovery branches).',
		);
		const branches = await listLaneBranches(directory);
		return {
			removed,
			skipped: branches,
			skippedRecoveryBranches,
			errors,
			recoveryReadError: true,
		};
	}

	const branches = await listLaneBranches(directory);

	for (const branch of branches) {
		const sessionId = extractSessionId(branch);

		if (sessionId !== null && activeSessionIds.includes(sessionId)) {
			skipped.push(branch);
			continue;
		}

		// #1657: exempt branches with an unresolved recovery record — these are
		// preserved for manual recovery and must not be force-deleted by routine
		// orphan cleanup. (A record is auto-cleared on successful merge-back, so
		// this exemption ends when the lane recovers.)
		if (hasRecoveryRecordForBranch(directory, branch)) {
			skippedRecoveryBranches.push(branch);
			continue;
		}

		// Startup recovery is unattended: use non-forced deletion so Git preserves
		// a branch with commits not reachable from HEAD. Explicit reset flows keep
		// the historical force-delete behavior unless they opt into preservation.
		const deleteResult = await runGit(
			['branch', options.preserveUnmerged ? '-d' : '-D', branch],
			directory,
		);

		if (deleteResult.exitCode === 0) {
			removed.push(branch);
		} else {
			errors.push({
				branch,
				error: deleteResult.stderr.trim() || deleteResult.stdout.trim(),
			});
		}
	}

	// Prune stale worktree metadata after cleanup
	await runGit(['worktree', 'prune'], directory);

	return {
		removed,
		skipped,
		skippedRecoveryBranches,
		errors,
	};
}

/**
 * Performs startup orphan recovery: prunes stale worktrees, then identifies
 * any remaining orphaned swarm-lane branches for warning.
 *
 * This is designed to run at session startup (DD-3). It does NOT delete branches —
 * it reports them as warnings so the caller can decide on further action.
 *
 * @param directory        - The project root (cwd for all git commands).
 * @param activeSessionIds - Session IDs that are still active; their branches are expected.
 * @returns Result indicating whether pruning happened, orphaned branches, and warnings.
 */
export async function startupOrphanRecovery(
	directory: string,
	activeSessionIds: string[] = [],
): Promise<StartupRecoveryResult> {
	const warnings: string[] = [];

	// Step 1: Prune stale worktree metadata (DD-3)
	const pruneResult = await runGit(['worktree', 'prune'], directory);

	if (pruneResult.exitCode !== 0) {
		warnings.push(
			`git worktree prune failed: ${pruneResult.stderr.trim() || pruneResult.stdout.trim()}`,
		);
	}

	// Step 2: List remaining lane branches (--format avoids
	// the `* ` prefix that `git branch --list` adds to the current branch)
	const allBranches = await listLaneBranches(directory);

	// Step 3: Filter out active-session branches; remaining are orphans
	const orphanBranches: string[] = [];
	for (const branch of allBranches) {
		const sessionId = extractSessionId(branch);
		if (sessionId === null || !activeSessionIds.includes(sessionId)) {
			orphanBranches.push(branch);
			warnings.push(
				`Orphaned swarm-lane branch "${branch}" detected in "${directory}"`,
			);
		}
	}

	for (const warning of warnings) {
		log(warning);
	}

	return {
		prunedWorktrees: pruneResult.exitCode === 0,
		remainingBranches: orphanBranches,
		warnings,
	};
}

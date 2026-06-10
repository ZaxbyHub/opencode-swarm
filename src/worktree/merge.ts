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

import { bunSpawn } from '../utils/bun-compat';
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
} = {
	bunSpawn,
	platform: process.platform,
	sleep: (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Default timeout for git merge-back operations (30 seconds). */
const MERGE_TIMEOUT_MS = 30_000;

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
 */
async function runGit(
	args: string[],
	cwd: string,
	timeoutMs = MERGE_TIMEOUT_MS,
): Promise<GitResult> {
	const proc = _internals.bunSpawn(['git', ...args], {
		cwd,
		timeout: timeoutMs,
		stdin: 'ignore' as const,
		stdout: 'pipe' as const,
		stderr: 'pipe' as const,
		env: { ...process.env, LC_ALL: 'C' },
	});
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
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
}

export interface DirtyMergePartial {
	partial: true;
	stage: string;
	autoCommitted: boolean;
	cleaned: boolean;
	message: string;
}

export interface DirtyMergeFailure {
	failed: true;
	stage: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Orphaned branch cleanup return types
// ---------------------------------------------------------------------------

export interface OrphanCleanupResult {
	removed: string[];
	skipped: string[];
	errors: Array<{ branch: string; error: string }>;
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
					['cherry-pick', `${mergeBase}..${branchName}`],
					primaryDir,
				);
			} else {
				// No common ancestor (e.g. unrelated histories) — fall back
				// to cherry-picking just the branch tip with a warning.
				console.warn(
					'[worktree] mergeLaneBranch: git merge-base failed for cherry-pick; falling back to tip-only cherry-pick',
				);
				result = await runGit(['cherry-pick', branchName], primaryDir);
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
	// Delete the lane branch (DD-9)
	const deleteResult = await runGit(['branch', '-D', branchName], directory);
	const deleteOk = deleteResult.exitCode === 0;

	// Prune stale worktree metadata (DD-9)
	const pruneResult = await runGit(['worktree', 'prune'], directory);
	const pruneOk = pruneResult.exitCode === 0;

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
): Promise<DirtyMergeSuccess | DirtyMergePartial | DirtyMergeFailure> {
	let autoCommitted = false;
	let cleaned = false;
	let autoCommitFailed = false;
	let cleanFailed = false;

	// Step 1: Auto-commit dirty state
	const commitResult = await autoCommitDirty(worktreePath);
	if (commitResult.committed) {
		autoCommitted = true;
	} else if (commitResult.reason !== 'Nothing to commit') {
		autoCommitFailed = true;
		console.warn(
			`[worktree] attemptMergeBackFromDirty: auto-commit failed for worktree "${worktreePath}" branch "${branchName}": ${commitResult.reason}`,
		);
	}

	// Step 2: Clean untracked files
	const cleanResult = await cleanUntrackedFiles(worktreePath);
	if (cleanResult.cleaned) {
		cleaned = true;
	} else {
		cleanFailed = true;
		console.warn(
			`[worktree] attemptMergeBackFromDirty: clean untracked failed for worktree "${worktreePath}" branch "${branchName}": ${cleanResult.error}`,
		);
	}

	// Step 3a: Abandon if both auto-commit AND clean truly failed
	if (autoCommitFailed && cleanFailed) {
		return {
			failed: true,
			stage: 'cleanup',
			message: 'Auto-commit and clean both failed; abandoning worktree',
		};
	}

	// Step 3b: Attempt merge-back
	const mergeResult = await mergeLaneBranch(primaryDir, branchName, strategy);

	if ('merged' in mergeResult && mergeResult.merged) {
		return { merged: true, strategy, autoCommitted, cleaned };
	}

	if ('conflict' in mergeResult) {
		return {
			partial: true,
			stage: 'merge',
			autoCommitted,
			cleaned,
			message: mergeResult.message,
		};
	}

	// MergeFailure case — narrowed from the union by eliminating success and conflict
	if ('error' in mergeResult) {
		return {
			failed: true,
			stage: 'merge',
			message: mergeResult.error,
		};
	}

	// Fallback (should not reach here)
	return {
		failed: true,
		stage: 'merge',
		message: 'Merge failed with unexpected result',
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
	for (const pattern of ['swarm-lane/*', 'swarm/lane/*']) {
		const result = await runGit(
			['branch', '--format=%(refname:short)', '--list', pattern],
			directory,
		);
		if (result.exitCode !== 0) continue;
		for (const line of result.stdout.split('\n')) {
			const branch = line.trim();
			if (branch.length > 0) branches.add(branch);
		}
	}
	return [...branches];
}

/**
 * Cleans up orphaned swarm-lane branches that do not belong to any active session.
 *
 * Lists all branches matching `swarm-lane/*`, identifies orphans (branches whose
 * session ID is not in `activeSessionIds`), force-deletes them, and prunes stale
 * worktree metadata.
 *
 * @param directory        - The project root (cwd for all git commands).
 * @param activeSessionIds - Session IDs that are still active; their branches are skipped.
 * @returns Result with arrays of removed, skipped, and errored branch names.
 */
export async function cleanupOrphanedBranches(
	directory: string,
	activeSessionIds: string[] = [],
): Promise<OrphanCleanupResult> {
	const removed: string[] = [];
	const skipped: string[] = [];
	const errors: Array<{ branch: string; error: string }> = [];

	const branches = await listLaneBranches(directory);

	for (const branch of branches) {
		const sessionId = extractSessionId(branch);

		if (sessionId !== null && activeSessionIds.includes(sessionId)) {
			skipped.push(branch);
			continue;
		}

		// Orphaned branch — attempt force deletion
		const deleteResult = await runGit(['branch', '-D', branch], directory);

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

	return { removed, skipped, errors };
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
		console.warn(warning);
	}

	return {
		prunedWorktrees: pruneResult.exitCode === 0,
		remainingBranches: orphanBranches,
		warnings,
	};
}

import * as child_process from 'node:child_process';
import path from 'node:path';
import { warn } from '../utils/logger.js';
import { GitBinaryMissingError } from '../utils/git-binary-missing-error.js';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

export type GitRepositoryStatus =
	| { isRepo: true }
	| {
			isRepo: false;
			reason: 'not_git_repo' | 'git_unavailable' | 'git_error';
			message: string;
	  };

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function windowsGitCandidates(): string[] {
	if (process.platform !== 'win32') return ['git'];

	const roots = unique([
		process.env.ProgramFiles ?? '',
		process.env['ProgramFiles(x86)'] ?? '',
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
	]);
	const installed = roots.flatMap((root) => [
		path.join(root, 'Git', 'cmd', 'git.exe'),
		path.join(root, 'Git', 'bin', 'git.exe'),
	]);
	return unique(['git', ...installed]);
}

function isSpawnMissingGit(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isNotGitRepositoryMessage(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes('not a git repository') ||
		lower.includes('not a git repo')
	);
}

/**
 * Execute git command safely
 */
function gitExec(args: string[], cwd: string): string {
	let missingGitError: unknown;

	for (const command of windowsGitCandidates()) {
		const result = child_process.spawnSync(command, args, {
			cwd,
			encoding: 'utf-8',
			timeout: GIT_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: GIT_MAX_BUFFER_BYTES,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		if (result.error) {
			if (isSpawnMissingGit(result.error)) {
				missingGitError ??= result.error;
				continue;
			}
			throw new Error(errorMessage(result.error));
		}
		if (result.status !== 0) {
			throw new Error(
				result.stderr || result.stdout || `git exited with ${result.status}`,
			);
		}
		return result.stdout;
	}

	throw new GitBinaryMissingError(
		process.platform === 'win32'
			? 'git executable is not available on PATH or common Windows install locations'
			: 'git executable is not available on PATH',
		{ cause: missingGitError },
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
 */
export function getCurrentBranch(cwd: string): string {
	const output = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
	return output.trim();
}

/**
 * Create a new branch
 * @param cwd - Working directory
 * @param branchName - Name of the branch to create
 * @param remote - Remote name (default: 'origin')
 */
export function createBranch(
	cwd: string,
	branchName: string,
	remote: string = 'origin',
): void {
	// Check if branch already exists
	try {
		gitExec(['rev-parse', '--verify', `${remote}/${branchName}`], cwd);
		// Branch exists remotely, check if we have it locally
		try {
			gitExec(['rev-parse', '--verify', branchName], cwd);
			// Already exists locally, just checkout
			gitExec(['checkout', branchName], cwd);
		} catch {
			// Checkout from remote
			gitExec(['checkout', '-b', branchName, `${remote}/${branchName}`], cwd);
		}
	} catch {
		// Branch doesn't exist, create new
		gitExec(['checkout', '-b', branchName], cwd);
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
 */
export function stageAll(cwd: string): void {
	gitExec(['add', '.'], cwd);
}

/**
 * Commit changes
 */
export function commitChanges(cwd: string, message: string): void {
	gitExec(['commit', '-m', message], cwd);
}

/**
 * Get current commit SHA
 */
export function getCurrentSha(cwd: string): string {
	return gitExec(['rev-parse', 'HEAD'], cwd).trim();
}

/**
 * Check if there are uncommitted changes
 */
export function hasUncommittedChanges(cwd: string): boolean {
	const status = gitExec(['status', '--porcelain'], cwd);
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
function detectDefaultRemoteBranch(cwd: string): string | null {
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
export function resetToRemoteBranch(
	cwd: string,
	options?: { pruneBranches?: boolean },
): ResetToRemoteBranchResult {
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
				// Synchronous delay for Windows — git file-locking race on Windows
				// requires a brief pause between retries. On Linux/macOS the retry
				// is immediate since the file-locking issue is Windows-specific.
				const endTime = Date.now() + 500;
				while (Date.now() < endTime) {
					// busy wait
				}
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
 * Aggressive git reset for post-merge cleanup.
 * Handles the common scenario: feature branch PR merged, local has uncommitted artifacts.
 * Steps: detect default branch → safety check → fetch → checkout → discard changes → reset → delete branch.
 * Safety guard: refuses if current branch has commits not on any remote tracking branch.
 */
export function resetToMainAfterMerge(
	cwd: string,
	options?: { pruneBranches?: boolean },
): ResetToMainAfterMergeResult {
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
			// delete this branch. Only block if it's a local-only branch that diverges
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
					const endTime = Date.now() + 500;
					while (Date.now() < endTime) {
						// busy wait for Windows file-locking
					}
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

		// Step 7b: Remove untracked files/directories
		// git checkout -- . only resets tracked files; git clean removes untracked.
		try {
			_internals.gitExec(['clean', '-fd'], cwd);
		} catch {
			warnings.push('Could not clean untracked files');
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
	resetToRemoteBranch: typeof resetToRemoteBranch;
	resetToMainAfterMerge: typeof resetToMainAfterMerge;
} = {
	gitExec,
	detectDefaultRemoteBranch,
	getDefaultBaseBranch,
	resetToRemoteBranch,
	resetToMainAfterMerge,
} as const;

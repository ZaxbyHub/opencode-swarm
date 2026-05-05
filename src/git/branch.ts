import * as child_process from 'node:child_process';
import { warn } from '../utils/logger.js';

const GIT_TIMEOUT_MS = 30_000;

/**
 * Execute git command safely
 */
function gitExec(args: string[], cwd: string): string {
	const result = child_process.spawnSync('git', args, {
		cwd,
		encoding: 'utf-8',
		timeout: GIT_TIMEOUT_MS,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git exited with ${result.status}`);
	}
	return result.stdout;
}

/**
 * Check if we're in a git repository
 */
export function isGitRepo(cwd: string): boolean {
	try {
		gitExec(['rev-parse', '--git-dir'], cwd);
		return true;
	} catch {
		return false;
	}
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

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	gitExec: typeof gitExec;
	detectDefaultRemoteBranch: typeof detectDefaultRemoteBranch;
	getDefaultBaseBranch: typeof getDefaultBaseBranch;
	resetToRemoteBranch: typeof resetToRemoteBranch;
} = {
	gitExec,
	detectDefaultRemoteBranch,
	getDefaultBaseBranch,
	resetToRemoteBranch,
} as const;

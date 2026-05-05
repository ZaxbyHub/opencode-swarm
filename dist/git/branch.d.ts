/**
 * Execute git command safely
 */
declare function gitExec(args: string[], cwd: string): string;
/**
 * Check if we're in a git repository
 */
export declare function isGitRepo(cwd: string): boolean;
/**
 * Get current branch name
 */
export declare function getCurrentBranch(cwd: string): string;
/**
 * Create a new branch
 * @param cwd - Working directory
 * @param branchName - Name of the branch to create
 * @param remote - Remote name (default: 'origin')
 */
export declare function createBranch(cwd: string, branchName: string, remote?: string): void;
/**
 * Get list of changed files compared to main/master
 * @param cwd - Working directory
 * @param branch - Base branch to compare against (optional, auto-detected if not provided)
 * @returns Array of changed file paths, or empty array if error occurs
 */
export declare function getChangedFiles(cwd: string, branch?: string): string[];
/**
 * Get default base branch (main or master)
 */
export declare function getDefaultBaseBranch(cwd: string): string;
/**
 * Stage specific files for commit
 * @param cwd - Working directory
 * @param files - Array of file paths to stage (must not be empty)
 * @throws Error if files array is empty
 */
export declare function stageFiles(cwd: string, files: string[]): void;
/**
 * Stage all files in the working directory
 * @param cwd - Working directory
 */
export declare function stageAll(cwd: string): void;
/**
 * Commit changes
 */
export declare function commitChanges(cwd: string, message: string): void;
/**
 * Get current commit SHA
 */
export declare function getCurrentSha(cwd: string): string;
/**
 * Check if there are uncommitted changes
 */
export declare function hasUncommittedChanges(cwd: string): boolean;
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
declare function detectDefaultRemoteBranch(cwd: string): string | null;
/**
 * Reset local branch to align with its remote counterpart.
 * Safely handles uncommitted changes, unpushed commits, and detached HEAD states.
 *
 * @param cwd - Working directory
 * @param options - Options including pruneBranches flag
 * @returns Result object with success status and details
 */
export declare function resetToRemoteBranch(cwd: string, options?: {
    pruneBranches?: boolean;
}): ResetToRemoteBranchResult;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    gitExec: typeof gitExec;
    detectDefaultRemoteBranch: typeof detectDefaultRemoteBranch;
    getDefaultBaseBranch: typeof getDefaultBaseBranch;
    resetToRemoteBranch: typeof resetToRemoteBranch;
};
export {};

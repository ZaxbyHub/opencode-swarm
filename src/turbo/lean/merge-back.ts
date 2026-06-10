import type { LeanTurboConfig } from '../../config/schema';
import {
	_internals,
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	getMergeStrategy as getSharedMergeStrategy,
	handleMergeConflict,
	mergeLaneBranch,
	postMergeCleanup,
	startupOrphanRecovery,
} from '../../worktree/merge';

export {
	_internals,
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	handleMergeConflict,
	mergeLaneBranch,
	postMergeCleanup,
	startupOrphanRecovery,
};
export type {
	CleanupFailure,
	CleanupSuccess,
	ConflictHandlingError,
	ConflictInfo,
	DirtyMergeFailure,
	DirtyMergePartial,
	DirtyMergeSuccess,
	MergeConflict,
	MergeFailure,
	MergeSuccess,
	OrphanCleanupResult,
	StartupRecoveryResult,
} from '../../worktree/merge';

export function getMergeStrategy(config: LeanTurboConfig) {
	return getSharedMergeStrategy({ merge_strategy: config.merge_strategy });
}

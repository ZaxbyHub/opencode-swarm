export type {
	AutoCommitSkip,
	AutoCommitSuccess,
	CleanCheckFailure,
	CleanCheckSuccess,
	CleanFailure,
	CleanSuccess,
	ProvisionFailure,
	ProvisionSuccess,
	RemoveFailure,
	RemoveSuccess,
} from './core';
export {
	_internals as coreInternals,
	assertCleanWorkingTree,
	autoCommitDirty,
	checkPathBudget,
	cleanUntrackedFiles,
	isCleanWorktree,
	makeWorktreeBranchName,
	provisionWorktree,
	removeWorktree,
	shortenWorktreePath,
} from './core';
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
} from './merge';
export {
	_internals as mergeInternals,
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	getMergeStrategy,
	handleMergeConflict,
	mergeLaneBranch,
	postMergeCleanup,
	startupOrphanRecovery,
} from './merge';
export * from './types';

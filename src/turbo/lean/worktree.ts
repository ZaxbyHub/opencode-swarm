import type { LeanTurboConfig } from '../../config/schema';
import {
	_internals,
	assertCleanWorkingTree,
	autoCommitDirty,
	checkPathBudget,
	cleanUntrackedFiles,
	isCleanWorktree,
	provisionWorktree as provisionSharedWorktree,
	removeWorktree,
	shortenWorktreePath,
} from '../../worktree/core';

export {
	_internals,
	assertCleanWorkingTree,
	autoCommitDirty,
	checkPathBudget,
	cleanUntrackedFiles,
	isCleanWorktree,
	removeWorktree,
	shortenWorktreePath,
};
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
} from '../../worktree/core';

export async function provisionWorktree(
	directory: string,
	laneId: string,
	sessionId: string,
	config: LeanTurboConfig,
) {
	const result = await provisionSharedWorktree(directory, laneId, sessionId, {
		purpose: 'lane',
		branchStyle: 'legacy-lane',
		worktreeDir: config.worktree_dir,
		mergeStrategy: config.merge_strategy,
	});
	if ('error' in result) return result;
	return {
		worktreePath: result.worktreePath,
		branchName: result.branchName,
	};
}

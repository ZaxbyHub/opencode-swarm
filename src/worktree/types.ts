export type WorktreePurpose = 'lane' | 'session';

export type MergeStrategy = 'merge' | 'rebase' | 'cherry-pick';

export type DependencyPreparationStrategy = 'skip' | 'copy' | 'link';

export interface WorktreeOptions {
	worktreeDir?: string;
	mergeStrategy?: MergeStrategy;
	purpose: WorktreePurpose;
	depsStrategy?: DependencyPreparationStrategy;
	/**
	 * `purpose` uses `swarm/<purpose>/<sessionId>/<id>`.
	 * `legacy-lane` preserves the PR #1188 Lean Turbo branch contract.
	 */
	branchStyle?: 'purpose' | 'legacy-lane';
}

export interface WorktreeHandle {
	worktreePath: string;
	branchName: string;
	purpose: WorktreePurpose;
	id: string;
	sessionId: string;
}

export interface WorktreeFailure {
	error: string;
}

export type WorktreeProvisionResult = WorktreeHandle | WorktreeFailure;

export interface WorktreePolicyConfig {
	policy: 'auto' | 'required' | 'disabled';
	merge_strategy: MergeStrategy;
	worktree_dir?: string;
	deps_strategy: DependencyPreparationStrategy;
}

export interface ConflictReport {
	branchName: string;
	files: string[];
	message: string;
}

export type MergeBackResult =
	| { merged: true; strategy: MergeStrategy }
	| { conflict: true; files: string[]; message: string }
	| { error: string };

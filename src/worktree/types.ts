export type WorktreePurpose = 'lane' | 'session';

export type MergeStrategy = 'merge' | 'rebase' | 'cherry-pick';

export type DependencyPreparationStrategy = 'skip' | 'copy' | 'link';

/**
 * FR-201: Per-lane runtime profile injected into spawned child processes.
 *
 * Produced at lane provisioning time and written as `.swarm/lanes/{laneIndex}.env`
 * (KEY=VAL format, one per line) so any child process spawned inside the lane
 * can source it to get lane-specific PORT, TMPDIR, cache redirects, etc.
 *
 * The profile is computed from the resolved WorktreeIsolationConfig.runtime_isolation:
 * - PORT = (port_base ?? 0) + laneIndex * port_stride
 * - env_overrides merged verbatim
 * - cache_redirects mapped to env vars
 */
export interface LaneRuntimeProfile {
	/** 0-based lane index used for port and env derivation. */
	laneIndex: number;
	/** Absolute path to the provisioned worktree. */
	worktreePath: string;
	/** Env var overrides for this lane (includes PORT after derivation). */
	envOverrides: Record<string, string>;
}

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
	/**
	 * Optional scope to materialize into the lane's `.swarm/scopes/scope-{taskId}.json`.
	 * Enables scope durability for worktree lanes (FR-102 / SC-105, SC-106).
	 * When provided, provisionWorktree will write the scope file into the lane
	 * after `git worktree add` so that resolveScopeWithFallbacks called with
	 * the worktree path as `directory` can recover it after plugin restart.
	 */
	scope?: { taskId: string; files: string[] };
	/**
	 * FR-201 SC-124: Optional runtime profile to materialize into the lane.
	 * When provided, provisionWorktree will write `.swarm/lanes/{laneIndex}.env`
	 * (KEY=VAL format, one per line) into the worktree root after creation,
	 * so any child process spawned inside the lane can source it.
	 */
	laneProfile?: LaneRuntimeProfile;
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

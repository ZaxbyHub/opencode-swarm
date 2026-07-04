import * as path from 'node:path';
import type { LeanTurboConfig } from '../../config/schema';
import { parseLeanLaneIndex } from '../../hooks/delegation-gate/worktree-isolation';
import type { LaneRuntimeProfile } from '../../worktree';
import {
	_internals,
	assertCleanWorkingTree,
	autoCommitDirty,
	checkPathBudget,
	cleanUntrackedFiles,
	isCleanWorktree,
	provisionWorktree as provisionSharedWorktree,
	removeLaneProfileFromDiskReal,
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
	parseLeanLaneIndex,
	removeLaneProfileFromDiskReal,
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

/**
 * FR-201 SC-122: Computes the per-lane runtime profile from the resolved runtime_isolation config.
 */
function computeLaneRuntimeProfile(
	runtime: LeanTurboConfig['runtime_isolation'],
	laneIndex: number,
	worktreePath: string,
): LaneRuntimeProfile | undefined {
	if (!runtime?.enabled) return undefined;

	const portStride = runtime.port_stride ?? 1;

	// Precedence (last write wins):
	//  1. Derive PORT if port_base is set
	//  2. env_overrides — explicit caller values win over derived PORT
	//  3. cache_redirects — explicit cache redirect wins (last write wins)

	// Start with derived PORT (lowest priority)
	const envOverrides: Record<string, string> = {};

	// 1. Derive PORT when port_base is explicitly defined.
	// Schema comment: "If omitted, no PORT variable is set."
	if (runtime.port_base !== undefined) {
		const portBase = runtime.port_base;
		const port = portBase + laneIndex * portStride;
		envOverrides.PORT = String(port);
	}

	// 2. env_overrides — explicit caller wins over derived PORT
	if (runtime.env_overrides) {
		Object.assign(envOverrides, runtime.env_overrides);
	}

	// 3. cache_redirects — explicit cache redirect wins (last write wins)
	if (runtime.cache_redirects) {
		for (const [envName, basePath] of Object.entries(runtime.cache_redirects)) {
			envOverrides[envName] = path.join(basePath, `lane-${laneIndex}`);
		}
	}

	return { laneIndex, worktreePath, envOverrides };
}

export async function provisionWorktree(
	directory: string,
	laneId: string,
	sessionId: string,
	config: LeanTurboConfig,
	scope?: { taskId: string; files: string[] },
): Promise<{ worktreePath: string; branchName: string } | { error: string }> {
	const laneIndex = parseLeanLaneIndex(laneId);

	const result = await provisionSharedWorktree(directory, laneId, sessionId, {
		purpose: 'lane',
		branchStyle: 'legacy-lane',
		worktreeDir: config.worktree_dir,
		mergeStrategy: config.merge_strategy,
		depsStrategy: config.deps_strategy,
		scope,
	});
	if ('error' in result) return result;

	// FR-201 SC-124: Compute and materialize the lane runtime profile after
	// provisioning so we have the real worktreePath. Materialization is best-effort
	// (defense-in-depth); failure is non-fatal.
	const laneProfile = computeLaneRuntimeProfile(
		config.runtime_isolation,
		laneIndex,
		result.worktreePath,
	);
	if (laneProfile) {
		try {
			const { writeLaneProfileToDiskReal } = await import(
				'../../worktree/core'
			);
			await writeLaneProfileToDiskReal(
				result.worktreePath,
				laneProfile.laneIndex,
				laneProfile.envOverrides,
			);
		} catch {
			/* non-fatal — profile materialization is defense-in-depth */
		}
	}

	return {
		worktreePath: result.worktreePath,
		branchName: result.branchName,
	};
}

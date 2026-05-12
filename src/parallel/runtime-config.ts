import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../config';
import {
	type ExecutionProfile,
	ExecutionProfileSchema,
} from '../config/plan-schema';

type LockedProfileCacheEntry = {
	mtimeMs: number;
	profile: ExecutionProfile | null;
};

export type StandardParallelizationRuntimeConfig = {
	stageBParallelEnabled: boolean;
	taskFanoutEnabled: boolean;
	maxConcurrentTasks: number;
	maxConcurrentCoders: number;
	maxConcurrentStageBGroups: number;
	evidenceLockTimeoutMs: number;
	source: 'current-default' | 'global-config' | 'locked-profile';
};

const DEFAULT_EVIDENCE_LOCK_TIMEOUT_MS = 60000;
const lockedProfileCache = new Map<string, LockedProfileCacheEntry>();

function readLockedExecutionProfile(
	directory: string,
): ExecutionProfile | null {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const stat = fs.statSync(planPath);
		const cached = lockedProfileCache.get(planPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) {
			return cached.profile;
		}

		const planRaw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(planRaw) as { execution_profile?: unknown };
		const parsed = ExecutionProfileSchema.safeParse(plan.execution_profile);
		const profile = parsed.success && parsed.data.locked ? parsed.data : null;
		lockedProfileCache.set(planPath, { mtimeMs: stat.mtimeMs, profile });
		return profile;
	} catch {
		return null;
	}
}

export function resolveStandardParallelizationConfig(
	config: PluginConfig | undefined,
	directory: string,
): StandardParallelizationRuntimeConfig {
	const globalConfig = config?.parallelization;
	const lockedProfile = readLockedExecutionProfile(directory);
	const evidenceLockTimeoutMs =
		globalConfig?.evidenceLockTimeoutMs ?? DEFAULT_EVIDENCE_LOCK_TIMEOUT_MS;

	if (lockedProfile) {
		if (globalConfig?.enabled === false) {
			return {
				stageBParallelEnabled: false,
				taskFanoutEnabled: false,
				maxConcurrentTasks: 1,
				maxConcurrentCoders: 1,
				maxConcurrentStageBGroups: 1,
				evidenceLockTimeoutMs,
				source: 'global-config',
			};
		}

		if (lockedProfile.parallelization_enabled === false) {
			return {
				stageBParallelEnabled: false,
				taskFanoutEnabled: false,
				maxConcurrentTasks: 1,
				maxConcurrentCoders: 1,
				maxConcurrentStageBGroups: 1,
				evidenceLockTimeoutMs,
				source: 'locked-profile',
			};
		}

		const profileMax = lockedProfile.max_concurrent_tasks;
		const globalMax =
			globalConfig?.enabled === true
				? globalConfig.maxConcurrentTasks
				: Number.POSITIVE_INFINITY;
		const maxConcurrentTasks = Math.max(1, Math.min(profileMax, globalMax));
		return {
			stageBParallelEnabled: maxConcurrentTasks > 1,
			taskFanoutEnabled: maxConcurrentTasks > 1,
			maxConcurrentTasks,
			maxConcurrentCoders: Math.min(
				maxConcurrentTasks,
				globalConfig?.max_coders ?? maxConcurrentTasks,
			),
			maxConcurrentStageBGroups: Math.min(
				maxConcurrentTasks,
				globalConfig?.max_reviewers ?? maxConcurrentTasks,
			),
			evidenceLockTimeoutMs,
			source: 'locked-profile',
		};
	}

	if (globalConfig) {
		const maxConcurrentTasks = globalConfig.enabled
			? globalConfig.maxConcurrentTasks
			: 1;
		return {
			stageBParallelEnabled: globalConfig.enabled && maxConcurrentTasks > 1,
			taskFanoutEnabled: globalConfig.enabled && maxConcurrentTasks > 1,
			maxConcurrentTasks,
			maxConcurrentCoders: Math.min(
				maxConcurrentTasks,
				globalConfig.max_coders,
			),
			maxConcurrentStageBGroups: Math.min(
				maxConcurrentTasks,
				globalConfig.max_reviewers,
			),
			evidenceLockTimeoutMs,
			source: 'global-config',
		};
	}

	// Preserve existing behavior for users who have no parallelization block:
	// Stage B completion remains order-independent, but coder fan-out is not
	// enabled by default.
	return {
		stageBParallelEnabled: true,
		taskFanoutEnabled: false,
		maxConcurrentTasks: 1,
		maxConcurrentCoders: 1,
		maxConcurrentStageBGroups: 1,
		evidenceLockTimeoutMs,
		source: 'current-default',
	};
}

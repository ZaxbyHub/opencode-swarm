import { loadPluginConfig } from '../config/loader';
import type { ExecutionProfile, Plan } from '../config/plan-schema';
import type { PluginConfig } from '../config/schema';

export type PlanningProfile = NonNullable<
	NonNullable<ExecutionProfile['planning_profile']>
>;

export interface ResolvedPlanningProfile {
	effective: PlanningProfile;
	persisted: PlanningProfile | undefined;
	source:
		| 'incoming'
		| 'persisted'
		| 'repository_default'
		| 'legacy_locked_default';
}

export type PlanningProfileDirectiveContext = 'repository_default' | 'runtime';

/**
 * Render the authoritative planning ceremony for the architect prompt.
 *
 * Keep this policy next to the resolver so static agent construction and
 * per-turn persisted-plan injection cannot drift into different meanings for
 * the same resolved profile.
 */
export function renderPlanningProfileDirective(
	resolution: ResolvedPlanningProfile,
	context: PlanningProfileDirectiveContext = 'runtime',
): string {
	const header =
		context === 'repository_default'
			? `[PLANNING PROFILE DEFAULT — USE ONLY WHEN NO RUNTIME RESOLUTION EXISTS] effective=${resolution.effective} source=${resolution.source}`
			: `[PLANNING PROFILE — CURRENT RUNTIME AUTHORITY] effective=${resolution.effective} source=${resolution.source}`;
	const precedence =
		context === 'runtime'
			? '\nThis runtime resolution supersedes any planning-profile default in the base prompt.'
			: '';
	if (resolution.effective === 'balanced') {
		return `${header}${precedence}
BALANCED ceremony: use durable QA and execution defaults without pausing for the full questionnaire. Do not require a spec solely as ceremony. Ask the user only about unresolved material ambiguity, destructive or high-risk authorization, or another decision only they can make. save_plan exact-binds the default QA profile; persist planning_profile: "balanced" in the execution profile. Follow persisted QA gates after save.`;
	}

	return `${header}${precedence}
STRICT ceremony: require an effective spec, run the complete clarification funnel, present the unified QA/execution questionnaire, wait for the user's answers, exact-bind those choices, and persist planning_profile: "strict". A locked legacy profile with no field uses this ceremony without materializing a new hash field.`;
}

interface ResolvePlanningProfileOptions {
	directory: string;
	incomingExecutionProfile?: Partial<ExecutionProfile>;
	existingExecutionProfile?: Plan['execution_profile'];
	resetStatuses?: boolean;
	config?: Pick<PluginConfig, 'execution_mode'>;
}

function resolveRepositoryDefaultPlanningProfile(
	config: Pick<PluginConfig, 'execution_mode'>,
): PlanningProfile {
	return config.execution_mode === 'strict' ? 'strict' : 'balanced';
}

export function resolvePlanningProfile({
	directory,
	incomingExecutionProfile,
	existingExecutionProfile,
	resetStatuses,
	config,
}: ResolvePlanningProfileOptions): ResolvedPlanningProfile {
	if (incomingExecutionProfile?.planning_profile) {
		return {
			effective: incomingExecutionProfile.planning_profile,
			persisted: incomingExecutionProfile.planning_profile,
			source: 'incoming',
		};
	}

	const existingProfile = resetStatuses ? undefined : existingExecutionProfile;
	if (existingProfile?.planning_profile) {
		return {
			effective: existingProfile.planning_profile,
			persisted: existingProfile.planning_profile,
			source: 'persisted',
		};
	}

	if (existingProfile?.locked === true) {
		return {
			effective: 'strict',
			persisted: undefined,
			source: 'legacy_locked_default',
		};
	}

	const loadedConfig = config ?? loadPluginConfig(directory);
	const repositoryDefault =
		resolveRepositoryDefaultPlanningProfile(loadedConfig);
	return {
		effective: repositoryDefault,
		persisted: repositoryDefault,
		source: 'repository_default',
	};
}

export function normalizeExecutionProfileForHash(
	profile: Plan['execution_profile'],
): Record<string, unknown> | undefined {
	if (!profile) {
		return undefined;
	}
	return {
		...profile,
		commit_after_each_completed_task:
			profile.commit_after_each_completed_task === true ? true : undefined,
	};
}

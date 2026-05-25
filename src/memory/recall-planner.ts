import {
	type MemoryRecallProfile,
	resolveMemoryRecallProfile,
} from './role-profiles';
import type { MemoryKind, MemoryScopeRef } from './types';

export interface MemoryRecallPlannerInput {
	userGoal: string;
	runId: string;
	agentRole: string;
	agentId: string;
	agentTask: string;
	projectId?: string;
	repoId?: string;
	repoRoot?: string;
	touchedFiles?: string[];
	currentPlanSummary?: string;
}

export interface MemoryRecallPlan {
	query: string;
	scopes: MemoryScopeRef[];
	kinds: MemoryKind[];
	maxItems: number;
	tokenBudget: number;
}

export interface BuildMemoryRecallPlanOptions {
	scopes?: MemoryScopeRef[];
	profile?: MemoryRecallProfile;
}

export function buildMemoryRecallPlan(
	input: MemoryRecallPlannerInput,
	options: BuildMemoryRecallPlanOptions = {},
): MemoryRecallPlan {
	const profile =
		options.profile ?? resolveMemoryRecallProfile(input.agentRole);
	const scopes = options.scopes ?? buildScopesFromInput(input);
	return {
		query: buildRecallQuery(input),
		scopes,
		kinds: [...profile.kinds],
		maxItems: profile.maxItems,
		tokenBudget: profile.tokenBudget,
	};
}

function buildRecallQuery(input: MemoryRecallPlannerInput): string {
	const lines = [
		`${input.agentRole} task: ${input.agentTask}`,
		`user goal: ${input.userGoal}`,
	];
	const repoProject = [input.projectId, input.repoId, input.repoRoot]
		.filter((value): value is string => Boolean(value?.trim()))
		.join(' ');
	if (repoProject) lines.push(`repo/project: ${repoProject}`);
	if (input.touchedFiles && input.touchedFiles.length > 0) {
		lines.push(`touched files: ${input.touchedFiles.join(', ')}`);
	}
	if (input.currentPlanSummary?.trim()) {
		lines.push(`current plan: ${input.currentPlanSummary.trim()}`);
	}
	return lines.join('\n');
}

function buildScopesFromInput(
	input: MemoryRecallPlannerInput,
): MemoryScopeRef[] {
	const scopes: MemoryScopeRef[] = [];
	if (input.projectId) {
		scopes.push({ type: 'project', projectId: input.projectId });
	}
	if (input.repoId || input.repoRoot) {
		scopes.push({
			type: 'repository',
			repoId: input.repoId,
			repoRoot: input.repoRoot,
		});
	}
	if (input.runId) scopes.push({ type: 'run', runId: input.runId });
	if (input.agentId) {
		scopes.push({
			type: 'agent',
			agentId: input.agentId,
			runId: input.runId,
		});
	}
	return scopes;
}

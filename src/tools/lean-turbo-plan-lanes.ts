/**
 * Lean Turbo Plan Lanes Tool.
 * Wraps planLeanTurboLanes from src/turbo/lean/planner.
 * Partitions phase tasks into parallel lanes based on file-scope conflicts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../config/constants';
import type { LeanTurboLanePlan } from '../turbo/lean/planner';
import { type PlanPhase, planLeanTurboLanes } from '../turbo/lean/planner';
import { resolveLeanRule3Predicate } from '../turbo/lean/upstream-committed';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_plan_lanes tool
 */
export interface LeanTurboPlanLanesArgs {
	directory: string;
	phase: number;
	scopes?: Record<string, string[]>;
}

/**
 * Result from executing lean_turbo_plan_lanes
 */
export interface LeanTurboPlanLanesResult {
	success: boolean;
	plan?: LeanTurboLanePlan;
	lanes?: LeanTurboLanePlan['lanes'];
	degradedTasks?: LeanTurboLanePlan['degradedTasks'];
	serializedTasks?: LeanTurboLanePlan['serializedTasks'];
	errors?: string[];
}

/**
 * Read the plan.json file for a project.
 */
function readPlanJson(directory: string): { phases: PlanPhase[] } | null {
	const planPath = path.join(directory, '.swarm', 'plan.json');
	if (!fs.existsSync(planPath)) {
		return null;
	}
	try {
		return JSON.parse(fs.readFileSync(planPath, 'utf-8'));
	} catch {
		return null;
	}
}

/**
 * Execute the lean_turbo_plan_lanes tool.
 * Partitions phase tasks into parallel lanes based on file-scope conflicts.
 */
export async function executeLeanTurboPlanLanes(
	args: LeanTurboPlanLanesArgs,
): Promise<LeanTurboPlanLanesResult> {
	const { directory, phase, scopes } = args;

	// Read plan.json
	const plan = readPlanJson(directory);
	if (!plan) {
		return {
			success: false,
			errors: ['plan.json not found in .swarm directory'],
		};
	}

	// Default Lean Turbo config when not provided.
	// Sourced from DEFAULT_LEAN_TURBO_CONFIG to prevent config drift.
	const defaultConfig = { ...DEFAULT_LEAN_TURBO_CONFIG };

	try {
		// Rule 3 (issue #2962): supply the epic-gated upstream-commit predicate.
		// undefined when no Epic is open for the project keeps placement
		// byte-identical to the legacy pure-lean behavior. Ids are filtered to
		// strings: this tool parses plan.json without the schema gate, and a
		// non-string id would throw inside the marker read and be misread as a
		// git failure (#2962 review PRR-007).
		const isUpstreamCommitted = resolveLeanRule3Predicate(
			directory,
			plan.phases
				.flatMap((p) => p.tasks.map((t) => t.id))
				.filter((id): id is string => typeof id === 'string'),
		);
		const lanePlan = planLeanTurboLanes(
			directory,
			phase,
			plan,
			defaultConfig,
			scopes,
			isUpstreamCommitted,
		);

		return {
			success: true,
			plan: lanePlan,
			lanes: lanePlan.lanes,
			degradedTasks: lanePlan.degradedTasks,
			serializedTasks: lanePlan.serializedTasks,
		};
	} catch (error) {
		return {
			success: false,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

/**
 * Tool definition for lean_turbo_plan_lanes
 */
export const lean_turbo_plan_lanes: ToolDefinition = createSwarmTool({
	description:
		'Partition phase tasks into parallel lanes based on file-scope conflicts. ' +
		'Wraps planLeanTurboLanes for Lean Turbo lane planning.',
	args: {
		directory: z
			.string()
			.describe('Project root directory where .swarm/plan.json is located'),
		phase: z.number().int().positive().describe('Phase number to plan'),
		scopes: z
			.record(z.string(), z.array(z.string()))
			.optional()
			.describe('Optional pre-loaded scopes map (taskId -> file paths)'),
	},
	execute: async (args: unknown, _directory: string) => {
		const parsed = args as LeanTurboPlanLanesArgs;
		// Use _directory from tool context for .swarm containment (invariant #4)
		return JSON.stringify(
			await executeLeanTurboPlanLanes({ ...parsed, directory: _directory }),
			null,
			2,
		);
	},
});

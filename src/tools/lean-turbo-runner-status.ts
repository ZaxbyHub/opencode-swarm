/**
 * Lean Turbo Runner Status Tool.
 * Reads Lean Turbo run state from .swarm/turbo-state.json.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	type LeanTurboRunState,
	loadLeanTurboRunState,
} from '../turbo/lean/state';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_runner_status tool
 */
export interface LeanTurboRunnerStatusArgs {
	directory: string;
	sessionID: string;
}

/**
 * Result from executing lean_turbo_runner_status
 */
export interface LeanTurboRunnerStatusResult {
	success: boolean;
	status?: LeanTurboRunState['status'];
	phase?: number;
	lanes?: LeanTurboRunState['lanes'];
	degradedTasks?: LeanTurboRunState['degradedTasks'];
	maxParallelCoders?: number;
	sessionID?: string;
	strategy?: 'lean';
	errors?: string[];
}

/**
 * Execute the lean_turbo_runner_status tool.
 * Reads Lean Turbo run state from .swarm/turbo-state.json.
 */
export async function executeLeanTurboRunnerStatus(
	args: LeanTurboRunnerStatusArgs,
): Promise<LeanTurboRunnerStatusResult> {
	const { directory, sessionID } = args;

	try {
		const runState = loadLeanTurboRunState(directory, sessionID);

		if (!runState) {
			return {
				success: false,
				errors: ['No Lean Turbo run state found for this session'],
			};
		}

		return {
			success: true,
			status: runState.status,
			phase: runState.phase,
			lanes: runState.lanes,
			degradedTasks: runState.degradedTasks,
			maxParallelCoders: runState.maxParallelCoders,
			sessionID: runState.sessionID,
			strategy: runState.strategy,
		};
	} catch (error) {
		return {
			success: false,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

/**
 * Tool definition for lean_turbo_runner_status
 */
export const lean_turbo_runner_status: ToolDefinition = createSwarmTool({
	description:
		'Read Lean Turbo run state from .swarm/turbo-state.json. ' +
		'Returns status, phase, lanes, degraded tasks, and max parallel coders.',
	args: {
		directory: z
			.string()
			.describe(
				'Project root directory where .swarm/turbo-state.json is located',
			),
		sessionID: z.string().describe('Session ID for the Lean Turbo run'),
	},
	execute: async (args: unknown, _directory: string) => {
		const parsed = args as LeanTurboRunnerStatusArgs;
		// Use _directory from tool context for .swarm containment (invariant #4)
		return JSON.stringify(
			await executeLeanTurboRunnerStatus({ ...parsed, directory: _directory }),
			null,
			2,
		);
	},
});

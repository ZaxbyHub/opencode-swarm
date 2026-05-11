/**
 * Lean Turbo Status Tool.
 * Returns Lean Turbo configuration and active status for the current session.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../config/constants';
import { loadLeanTurboRunState } from '../turbo/lean/state';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_status tool
 */
export interface LeanTurboStatusArgs {
	directory: string;
	sessionID: string;
}

/**
 * Lean Turbo configuration that would be active
 */
export interface LeanTurboStatusConfig {
	max_parallel_coders: number;
	require_declared_scope: boolean;
	degrade_on_risk: boolean;
	conflict_policy: 'degrade' | 'serialize';
}

/**
 * Result from executing lean_turbo_status
 */
export interface LeanTurboStatusResult {
	success: boolean;
	strategy?: 'lean';
	leanActive?: boolean;
	config?: LeanTurboStatusConfig;
	status?: string;
	phase?: number;
	lanes?: number;
	degradedTasks?: number;
	errors?: string[];
}

/**
 * Execute the lean_turbo_status tool.
 * Returns Lean Turbo configuration and active status.
 */
export async function executeLeanTurboStatus(
	args: LeanTurboStatusArgs,
): Promise<LeanTurboStatusResult> {
	const { directory, sessionID } = args;

	try {
		// Try to load existing run state
		const runState = loadLeanTurboRunState(directory, sessionID);

		// Default config values (derived from canonical DEFAULT_LEAN_TURBO_CONFIG)
		const defaultConfig: LeanTurboStatusConfig = {
			max_parallel_coders: DEFAULT_LEAN_TURBO_CONFIG.max_parallel_coders,
			require_declared_scope: DEFAULT_LEAN_TURBO_CONFIG.require_declared_scope,
			degrade_on_risk: DEFAULT_LEAN_TURBO_CONFIG.degrade_on_risk,
			conflict_policy: DEFAULT_LEAN_TURBO_CONFIG.conflict_policy,
		};

		if (runState) {
			return {
				success: true,
				strategy: 'lean',
				leanActive: runState.status === 'running',
				config: defaultConfig,
				status: runState.status,
				phase: runState.phase,
				lanes: runState.lanes.length,
				degradedTasks: runState.degradedTasks.length,
			};
		}

		// No active run state - report idle status
		return {
			success: true,
			strategy: 'lean',
			leanActive: false,
			config: defaultConfig,
			status: 'idle',
			phase: undefined,
			lanes: 0,
			degradedTasks: 0,
		};
	} catch (error) {
		return {
			success: false,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

/**
 * Tool definition for lean_turbo_status
 */
export const lean_turbo_status: ToolDefinition = createSwarmTool({
	description:
		'Returns Lean Turbo configuration and active status for the current session. ' +
		'Shows whether lean turbo is active, current status, and configuration values.',
	args: {
		directory: z.string().describe('Project root directory'),
		sessionID: z.string().describe('Session ID to check status for'),
	},
	execute: async (args: unknown, _directory: string) => {
		const parsed = args as LeanTurboStatusArgs;
		// Use _directory from tool context for .swarm containment (invariant #4)
		return JSON.stringify(
			await executeLeanTurboStatus({ ...parsed, directory: _directory }),
			null,
			2,
		);
	},
});

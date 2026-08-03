/**
 * Lean Turbo Run Phase Tool.
 * Wraps LeanTurboRunner to execute a phase using Lean Turbo parallel lane execution.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config';
import { swarmState } from '../state';
import type { LaneResult, MergeBackFailureInfo } from '../turbo/lean/runner';
import { LeanTurboRunner as LeanTurboRunner_import } from '../turbo/lean/runner';
import type { LeanTurboDegradedTask } from '../turbo/lean/state';
import * as logger from '../utils/logger.js';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_run_phase tool
 */
export interface LeanTurboRunPhaseArgs {
	directory: string;
	phase: number;
	sessionID: string;
}

/**
 * Result from executing lean_turbo_run_phase
 */
export interface LeanTurboRunPhaseResult {
	success: boolean;
	lanes?: LaneResult[];
	degradedTasks?: string[];
	/**
	 * #1657: full degraded-task details (reason/files/requiredMode), additive
	 * alongside `degradedTasks`. Lets the architect see per-task degradation
	 * reasons in the tool result without reading /swarm status separately.
	 */
	degradedDetails?: LeanTurboDegradedTask[];
	serializedTasks?: string[];
	mergeBackFailures?: MergeBackFailureInfo[];
	reason?: string;
	errors?: string[];
}

/**
 * Test-only dependency-injection seam.
 * Allows tests to inject mocks without mock.module leakage.
 * @tool-opt-out Test-only dependency-injection seam; not a public tool.
 */
export const _internals = {
	LeanTurboRunner: LeanTurboRunner_import as typeof LeanTurboRunner_import,
	loadPluginConfigWithMeta:
		loadPluginConfigWithMeta_import as typeof loadPluginConfigWithMeta_import,
};

/**
 * Execute the lean_turbo_run_phase tool.
 * Creates a LeanTurboRunner and executes the specified phase.
 */
export async function executeLeanTurboRunPhase(
	args: LeanTurboRunPhaseArgs,
	generatedAgentNames?: readonly string[],
): Promise<LeanTurboRunPhaseResult> {
	const { directory, phase, sessionID } = args;

	let runResult: {
		ok: boolean;
		lanes?: LaneResult[];
		degradedTasks?: string[];
		degradedDetails?: LeanTurboDegradedTask[];
		serializedTasks?: string[];
		mergeBackFailures?: MergeBackFailureInfo[];
		reason?: string;
	} | null = null;
	let runError: Error | null = null;
	let runner: InstanceType<typeof _internals.LeanTurboRunner> | null = null;

	try {
		// Load plugin config to extract lean configuration
		const { config } = _internals.loadPluginConfigWithMeta(directory);
		const leanConfig =
			config.turbo?.strategy === 'lean' ? config.turbo.lean : undefined;

		// Create runner with swarm state and lean config
		runner = new _internals.LeanTurboRunner({
			directory,
			sessionID,
			opencodeClient: swarmState.opencodeClient ?? null,
			generatedAgentNames:
				generatedAgentNames ?? swarmState.generatedAgentNames,
			leanConfig,
		});

		// Execute the phase
		runResult = await runner.runPhase(phase);
	} catch (error) {
		runError = error instanceof Error ? error : new Error(String(error));
	}

	// Best-effort cleanup — use appropriate cleanup based on result
	// Bug #1 fix: success-path cleanup must not corrupt running lanes
	if (runner) {
		try {
			if (runError || !runResult?.ok) {
				await runner.cleanupAfterFailure();
			} else {
				await runner.cleanupAfterSuccess();
			}
		} catch (cleanupError) {
			// Log cleanup error but do not throw
			logger.log('[lean_turbo_run_phase] Cleanup failed:', cleanupError);
		}
	}

	if (runError) {
		return {
			success: false,
			errors: [runError.message],
		};
	}

	// Build success response from runResult
	return {
		success: runResult!.ok,
		lanes: runResult!.lanes,
		degradedTasks: runResult!.degradedTasks,
		// #1657: pass through full degraded-task details (reason/files/requiredMode).
		degradedDetails: runResult!.degradedDetails,
		serializedTasks: runResult!.serializedTasks,
		mergeBackFailures: runResult!.mergeBackFailures,
		reason: runResult!.reason,
	};
}

/**
 * Tool definition for lean_turbo_run_phase
 */
export function createLeanTurboRunPhaseTool(
	generatedAgentNames?: readonly string[],
): ToolDefinition {
	return createSwarmTool({
		description:
			'Execute a phase using Lean Turbo parallel lane execution. ' +
			'Plans lanes, acquires file locks, and dispatches coder agents concurrently. ' +
			'Use when Lean Turbo is active and you want to execute all tasks in a phase in parallel lanes.',
		args: {
			directory: z.string().describe('Project root directory'),
			phase: z.number().int().positive().describe('Phase number to execute'),
			sessionID: z.string().describe('Lean Turbo session ID'),
		},
		execute: async (args: unknown, _directory: string) => {
			const { phase, sessionID } = args as LeanTurboRunPhaseArgs;
			// Use _directory from tool context for .swarm containment (invariant #4)
			return JSON.stringify(
				await executeLeanTurboRunPhase(
					{
						phase,
						sessionID,
						directory: _directory,
					},
					generatedAgentNames,
				),
				null,
				2,
			);
		},
	});
}

export const lean_turbo_run_phase: ToolDefinition =
	createLeanTurboRunPhaseTool();

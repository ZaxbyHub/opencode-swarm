/**
 * Lean Turbo Critic Tool (issue #2470 / #2007).
 * Wraps dispatchPhaseCritic from src/turbo/lean/integration.
 * Dispatches a read-only critic agent to evaluate boundary conditions for a
 * completed Lean Turbo phase and persists the verdict to
 * .swarm/evidence/{phase}/lean-turbo-critic.json — the evidence file the
 * phase_critic gate reads at phase_complete. Registering this tool gives the
 * default-true turbo.lean.phase_critic gate a production producer.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import {
	dispatchPhaseCritic,
	type PhaseCriticResult,
} from '../turbo/lean/integration';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_critic tool
 */
export interface LeanTurboCriticArgs {
	directory: string;
	phase: number;
	sessionID: string;
}

/**
 * Result from executing lean_turbo_critic
 */
export interface LeanTurboCriticResult {
	success: boolean;
	verdict?: PhaseCriticResult['verdict'];
	reason?: string;
	evidencePath?: string;
	errors?: string[];
}

/**
 * Execute the lean_turbo_critic tool.
 * Dispatches a read-only critic agent to evaluate a completed Lean Turbo phase.
 */
export async function executeLeanTurboCritic(
	args: LeanTurboCriticArgs,
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	activeAgentName?: string,
): Promise<LeanTurboCriticResult> {
	const { directory, phase, sessionID } = args;

	try {
		const result = await _internals.dispatchPhaseCritic(
			directory,
			phase,
			sessionID,
			{
				dispatcher,
				generatedAgentNames,
				agentModelRegistry,
				activeAgentName,
			},
		);

		return {
			success: true,
			verdict: result.verdict,
			reason: result.reason,
			evidencePath: result.evidencePath,
		};
	} catch (error) {
		return {
			success: false,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
}

/**
 * Tool definition for lean_turbo_critic
 */
export function createLeanTurboCriticTool(
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	getActiveAgentName?: (sessionID: string) => string | undefined,
): ToolDefinition {
	return createSwarmTool({
		description:
			'Dispatch a read-only critic agent to evaluate boundary conditions for a completed Lean Turbo phase. ' +
			'Wraps dispatchPhaseCritic from src/turbo/lean/integration. ' +
			'Returns verdict (APPROVED/NEEDS_REVISION/REJECTED/ESCALATE_TO_HUMAN), reason, and evidence path. ' +
			'Satisfies the turbo.lean.phase_critic gate at phase_complete.',
		args: {
			directory: z.string().describe('Project root directory'),
			phase: z
				.number()
				.int()
				.positive()
				.describe('Phase number being critiqued'),
			sessionID: z.string().describe('Lean Turbo session ID'),
		},
		execute: async (args: unknown, _directory: string, ctx) => {
			const parsed = args as LeanTurboCriticArgs;
			// Use _directory from tool context for .swarm containment (invariant #4)
			return JSON.stringify(
				await executeLeanTurboCritic(
					{ ...parsed, directory: _directory },
					dispatcher,
					generatedAgentNames,
					agentModelRegistry,
					ctx?.agent !== undefined
						? String(ctx.agent)
						: getActiveAgentName?.(ctx?.sessionID ?? parsed.sessionID),
				),
				null,
				2,
			);
		},
	});
}

export const lean_turbo_critic: ToolDefinition = createLeanTurboCriticTool();

/**
 * DI seam for testability (invariant 7). Also lets the registration
 * reachability-guard test prove this module routes to dispatchPhaseCritic
 * without a live agent dispatch.
 */
export const _internals: {
	dispatchPhaseCritic: typeof dispatchPhaseCritic;
} = {
	dispatchPhaseCritic,
};

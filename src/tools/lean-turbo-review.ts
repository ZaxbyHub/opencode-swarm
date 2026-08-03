/**
 * Lean Turbo Review Tool.
 * Wraps dispatchPhaseReviewer from src/turbo/lean/reviewer.
 * Dispatches a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import {
	dispatchPhaseReviewer,
	type PhaseReviewerResult,
} from '../turbo/lean/reviewer';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the lean_turbo_review tool
 */
export interface LeanTurboReviewArgs {
	directory: string;
	phase: number;
	sessionID: string;
}

/**
 * Result from executing lean_turbo_review
 */
export interface LeanTurboReviewResult {
	success: boolean;
	verdict?: PhaseReviewerResult['verdict'];
	reason?: string;
	evidencePath?: string;
	errors?: string[];
}

/**
 * Execute the lean_turbo_review tool.
 * Dispatches a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 */
export async function executeLeanTurboReview(
	args: LeanTurboReviewArgs,
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	activeAgentName?: string,
): Promise<LeanTurboReviewResult> {
	const { directory, phase, sessionID } = args;

	// Read plugin config to get integrated_diff_required → requireDiffSummary
	let requireDiffSummary = true; // default
	try {
		const { config } = loadPluginConfigWithMeta(directory);
		if (config?.turbo?.lean?.integrated_diff_required !== undefined) {
			requireDiffSummary = config.turbo.lean.integrated_diff_required;
		}
	} catch {
		// Config load failure → use default
	}

	try {
		const result = await dispatchPhaseReviewer(directory, phase, sessionID, {
			requireDiffSummary,
			dispatcher,
			generatedAgentNames,
			agentModelRegistry,
			activeAgentName,
		});

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
 * Tool definition for lean_turbo_review
 */
export function createLeanTurboReviewTool(
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	getActiveAgentName?: (sessionID: string) => string | undefined,
): ToolDefinition {
	return createSwarmTool({
		description:
			'Dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase. ' +
			'Wraps dispatchPhaseReviewer from src/turbo/lean/reviewer. ' +
			'Returns verdict (APPROVED/NEEDS_REVISION/REJECTED), reason, and evidence path.',
		args: {
			directory: z.string().describe('Project root directory'),
			phase: z
				.number()
				.int()
				.positive()
				.describe('Phase number being reviewed'),
			sessionID: z.string().describe('Lean Turbo session ID'),
		},
		execute: async (args: unknown, _directory: string, ctx) => {
			const parsed = args as LeanTurboReviewArgs;
			// Use _directory from tool context for .swarm containment (invariant #4)
			return JSON.stringify(
				await executeLeanTurboReview(
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

export const lean_turbo_review: ToolDefinition = createLeanTurboReviewTool();

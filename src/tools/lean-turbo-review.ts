/**
 * Lean Turbo Review Tool.
 * Wraps dispatchPhaseReviewer from src/turbo/lean/reviewer.
 * Dispatches a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
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
export const lean_turbo_review: ToolDefinition = createSwarmTool({
	description:
		'Dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase. ' +
		'Wraps dispatchPhaseReviewer from src/turbo/lean/reviewer. ' +
		'Returns verdict (APPROVED/NEEDS_REVISION/REJECTED), reason, and evidence path.',
	args: {
		directory: z.string().describe('Project root directory'),
		phase: z.number().int().positive().describe('Phase number being reviewed'),
		sessionID: z.string().describe('Lean Turbo session ID'),
	},
	execute: async (args: unknown, _directory: string) => {
		const parsed = args as LeanTurboReviewArgs;
		// Use _directory from tool context for .swarm containment (invariant #4)
		return JSON.stringify(
			await executeLeanTurboReview({ ...parsed, directory: _directory }),
			null,
			2,
		);
	},
});

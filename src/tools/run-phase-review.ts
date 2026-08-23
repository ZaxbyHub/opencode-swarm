import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config/index.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import { runReviewEngine } from '../review/engine.js';
import { mayRunPhaseAutoReview } from '../review/phase-runner.js';
import {
	optionalModelOverride,
	type ReviewAgentModelRegistry,
	resolveReviewAgentNames,
	resolveReviewFallbackModels,
} from '../review/runtime.js';
import { createSwarmTool } from './create-tool.js';

export interface RunPhaseReviewArgs {
	phase: number;
	sessionID: string;
	is_final_plan_phase?: boolean;
}

export interface RunPhaseReviewResult {
	success: boolean;
	trigger?: 'phase_completion' | 'plan_completion';
	status?: 'completed' | 'clean' | 'error';
	blocked?: boolean;
	blockReason?: string;
	scopeHash?: string;
	manifestHash?: string;
	scopeComplete?: boolean;
	evidencePath?: string;
	receiptPath?: string;
	message: string;
}

/**
 * Test-only dependency-injection seam.
 * @tool-opt-out Test-only dependency-injection seam; not a public tool.
 */
export const _internals = {
	loadPluginConfigWithMeta:
		loadPluginConfigWithMeta_import as typeof loadPluginConfigWithMeta_import,
};

export async function executeRunPhaseReview(
	directory: string,
	args: RunPhaseReviewArgs,
	options: {
		dispatcher?: ReviewModelDispatcher;
		generatedAgentNames?: readonly string[];
		agentModelRegistry?: ReviewAgentModelRegistry;
		activeAgentName?: string;
	} = {},
): Promise<RunPhaseReviewResult> {
	const { config } = _internals.loadPluginConfigWithMeta(directory);
	const autoReview = config?.auto_review;
	if (!autoReview || !mayRunPhaseAutoReview(autoReview)) {
		return {
			success: false,
			message:
				'Phase review is disabled for this workspace; enable auto_review phase-boundary final review first.',
		};
	}
	const plan = await loadPlanJsonOnly(directory).catch(() => null);
	const isFinalPlanPhase = plan
		? plan.phases.at(-1)?.id === args.phase
		: args.is_final_plan_phase === true;
	const trigger =
		isFinalPlanPhase && autoReview.final_review.on_plan_complete
			? ('plan_completion' as const)
			: autoReview.final_review.on_phase_complete
				? ('phase_completion' as const)
				: undefined;
	if (!trigger) {
		return {
			success: false,
			message:
				'Phase review is not configured for the requested phase boundary.',
		};
	}
	if (!options.dispatcher) {
		return {
			success: false,
			trigger,
			message: 'Phase review runtime is unavailable in this process.',
		};
	}

	const names = resolveReviewAgentNames(
		options.generatedAgentNames ?? [],
		options.activeAgentName,
	);
	const result = await runReviewEngine({
		directory,
		sessionID: args.sessionID,
		trigger,
		phase: args.phase,
		config: autoReview,
		dispatcher: options.dispatcher,
		reviewerAgent: names.reviewer,
		validatorAgent: names.validator,
		reviewerModel: optionalModelOverride(autoReview.final_review.model),
		reviewerFallbackModels: resolveReviewFallbackModels(
			names.reviewer,
			options.agentModelRegistry,
		),
		validatorModel: optionalModelOverride(autoReview.validation_model),
		validatorFallbackModels: resolveReviewFallbackModels(
			names.validator,
			options.agentModelRegistry,
		),
	});
	return {
		success: result.status !== 'error' || Boolean(result.evidencePath),
		trigger,
		status: result.status,
		blocked: result.blocked,
		blockReason: result.blockReason,
		scopeHash: result.scopeHash,
		manifestHash: result.manifestHash,
		scopeComplete: result.scopeComplete,
		evidencePath: result.evidencePath,
		receiptPath: result.receiptPath,
		message: result.message,
	};
}

export function createRunPhaseReviewTool(
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	getActiveAgentName?: (sessionID: string) => string | undefined,
): ToolDefinition {
	return createSwarmTool({
		description:
			'Run the bounded phase-final auto-review engine for a specific phase and persist phase review evidence.',
		args: {
			phase: z.number().int().positive().describe('Phase number to review'),
			sessionID: z.string().describe('Session ID owning the phase review'),
			is_final_plan_phase: z
				.boolean()
				.optional()
				.describe('Set true when this is the final plan phase'),
		},
		execute: async (args: unknown, directory: string, ctx) => {
			const parsed = args as RunPhaseReviewArgs;
			if (ctx?.sessionID && parsed.sessionID !== ctx.sessionID) {
				return JSON.stringify(
					{
						success: false,
						message:
							'run_phase_review sessionID must match the invoking tool context.',
					},
					null,
					2,
				);
			}
			return JSON.stringify(
				await executeRunPhaseReview(directory, parsed, {
					dispatcher,
					generatedAgentNames,
					agentModelRegistry,
					activeAgentName:
						ctx?.agent !== undefined
							? String(ctx.agent)
							: getActiveAgentName?.(ctx?.sessionID ?? parsed.sessionID),
				}),
				null,
				2,
			);
		},
	});
}

export const run_phase_review: ToolDefinition = createRunPhaseReviewTool();

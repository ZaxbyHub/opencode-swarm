import type { AutoReviewConfig } from '../config/schema.js';
import type { ReviewModelDispatcher } from './contracts.js';
import { type ReviewEngineResult, runReviewEngine } from './engine.js';
import {
	optionalModelOverride,
	type ReviewAgentModelRegistry,
	resolveReviewAgentNames,
	resolveReviewFallbackModels,
} from './runtime.js';

export interface RunPhaseAutoReviewInput {
	directory: string;
	sessionID: string;
	phase: number;
	isFinalPlanPhase: boolean;
	activeLeanTurbo: boolean;
	config: AutoReviewConfig;
	dispatcher?: ReviewModelDispatcher;
	generatedAgentNames: Iterable<string>;
	activeAgentName?: string;
	agentModelRegistry?: ReviewAgentModelRegistry;
	injectAdvisory: (sessionID: string, message: string) => void;
}

export interface PhaseAutoReviewResult {
	trigger?: 'phase_completion' | 'plan_completion';
	scopeHash?: string;
	manifestHash?: string;
	scopeComplete?: boolean;
	blocked?: boolean;
	blockReason?: ReviewEngineResult['blockReason'];
	warnings: string[];
}

/**
 * Return whether phase completion needs plan context to select a phase or
 * final-plan review trigger.
 *
 * Keep this preflight free of I/O so the phase_complete path does not replay
 * the plan ledger when auto-review is disabled or task-only.
 */
export function mayRunPhaseAutoReview(config: AutoReviewConfig): boolean {
	return (
		config.enabled &&
		(config.trigger === 'phase_boundary' || config.trigger === 'both') &&
		(config.final_review.on_phase_complete ||
			config.final_review.on_plan_complete)
	);
}

export async function runPhaseAutoReview(
	input: RunPhaseAutoReviewInput,
): Promise<PhaseAutoReviewResult> {
	const wantsPhaseTrigger = mayRunPhaseAutoReview(input.config);
	const trigger =
		wantsPhaseTrigger &&
		input.isFinalPlanPhase &&
		input.config.final_review.on_plan_complete
			? ('plan_completion' as const)
			: wantsPhaseTrigger && input.config.final_review.on_phase_complete
				? ('phase_completion' as const)
				: undefined;
	if (!trigger) return { warnings: [] };

	if (input.activeLeanTurbo && input.config.final_review.mode === 'advisory') {
		return {
			warnings: [
				'Lean Turbo phase reviewer owns advisory review for this phase; skipped duplicate generic auto-review.',
			],
		};
	}
	if (!input.dispatcher) {
		return {
			trigger,
			warnings: [
				'Auto-review runtime is unavailable; no phase review evidence was produced.',
			],
		};
	}

	const names = resolveReviewAgentNames(
		input.generatedAgentNames,
		input.activeAgentName,
	);
	const result = await _internals.runReviewEngine({
		directory: input.directory,
		sessionID: input.sessionID,
		trigger,
		phase: input.phase,
		config: input.config,
		dispatcher: input.dispatcher,
		reviewerAgent: names.reviewer,
		validatorAgent: names.validator,
		reviewerModel: optionalModelOverride(input.config.final_review.model),
		reviewerFallbackModels: resolveReviewFallbackModels(
			names.reviewer,
			input.agentModelRegistry,
		),
		validatorModel: optionalModelOverride(input.config.validation_model),
		validatorFallbackModels: resolveReviewFallbackModels(
			names.validator,
			input.agentModelRegistry,
		),
		injectAdvisory: input.injectAdvisory,
	});
	return {
		trigger,
		scopeHash: result.scopeHash,
		manifestHash: result.manifestHash,
		scopeComplete: result.scopeComplete,
		blocked: result.blocked,
		blockReason: result.blockReason,
		warnings: result.status === 'error' ? [result.message] : [],
	};
}

export const _internals: {
	runReviewEngine: typeof runReviewEngine;
} = {
	runReviewEngine,
};

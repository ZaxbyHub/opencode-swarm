import type {
	EvaluationRunV1,
	PromotionDecisionV1,
	PromotionPolicyV1,
} from './contracts.js';
import { recordTestImpactGateGroundTruth } from './gate-ground-truth.js';
import {
	computeCandidateInputContentHash,
	computeTaskInputContentHash,
} from './hashing.js';
import { evaluatePrReviewRecoveryV1 } from './pr-review-recovery.js';
import { type RunEvaluationOptions, runEvaluation } from './runner.js';
import { type DecidePromotionInput, decidePromotion } from './statistics.js';
import { savePromotionDecision } from './store.js';

export type EvaluateCandidateV1Options = RunEvaluationOptions & {
	historicalBest?: EvaluationRunV1;
	policy?: Partial<PromotionPolicyV1>;
	decidedAt?: string;
};

export type EvaluateCandidateV1Result = {
	run: EvaluationRunV1;
	decision: PromotionDecisionV1;
};

/**
 * Stable package-level evaluation boundary for SkillOpt/HarnessOpt consumers.
 * It freezes and executes the run, decides against baseline and historical-best,
 * and durably persists the immutable promotion decision before returning.
 */
export async function evaluateCandidateV1(
	options: EvaluateCandidateV1Options,
): Promise<EvaluateCandidateV1Result> {
	const run = await runEvaluation(options);
	const decision = decidePromotion({
		run,
		historicalBest: options.historicalBest,
		policy: options.policy,
		decidedAt: options.decidedAt,
	});
	const storedDecision = await savePromotionDecision(
		options.projectRoot,
		decision,
	);
	return { run, decision: storedDecision };
}

/**
 * Callable function namespace: OpenCode's legacy plugin loader permits named
 * function exports but rejects plain-object named exports. The attached methods
 * retain the cohesive versioned API without jeopardizing plugin discovery.
 */
export const evaluationV1 = Object.freeze(
	Object.assign(
		(options: EvaluateCandidateV1Options) => evaluateCandidateV1(options),
		{
			evaluateCandidate: evaluateCandidateV1,
			evaluatePrReviewRecovery: evaluatePrReviewRecoveryV1,
			runEvaluation,
			decidePromotion: (input: DecidePromotionInput) => decidePromotion(input),
			hashTaskInput: computeTaskInputContentHash,
			hashCandidateInput: computeCandidateInputContentHash,
			recordTestImpactGroundTruth: recordTestImpactGateGroundTruth,
		},
	),
);

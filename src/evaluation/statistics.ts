import {
	type EvaluationResultV1,
	type EvaluationRunV1,
	type PromotionDecisionV1,
	PromotionDecisionV1Schema,
	type PromotionPolicyV1,
	PromotionPolicyV1Schema,
} from './contracts.js';
import { canonicalHash, sha256 } from './hashing.js';

interface Pair {
	key: string;
	category: string;
	protected: boolean;
	reference: number;
	candidate: number;
	referenceResult: EvaluationResultV1;
	candidateResult: EvaluationResultV1;
}

export interface DecidePromotionInput {
	run: EvaluationRunV1;
	historicalBest?: EvaluationRunV1;
	policy?: Partial<PromotionPolicyV1>;
	decidedAt?: string;
}

function normalize(result: EvaluationResultV1): number | undefined {
	if (result.outcome !== 'scored' || result.score === undefined)
		return undefined;
	const [minimum, maximum] = result.scoreRange;
	if (maximum <= minimum || result.score < minimum || result.score > maximum)
		return undefined;
	return (result.score - minimum) / (maximum - minimum);
}

function resultKey(result: EvaluationResultV1): string {
	return `${result.taskId}\u0000${result.repetition}`;
}

function collectPairs(
	candidateResults: readonly EvaluationResultV1[],
	referenceResults: readonly EvaluationResultV1[],
): Pair[] {
	const references = new Map(
		referenceResults.map((result) => [resultKey(result), result] as const),
	);
	const pairs: Pair[] = [];
	for (const candidateResult of candidateResults) {
		const referenceResult = references.get(resultKey(candidateResult));
		if (!referenceResult) continue;
		const candidate = normalize(candidateResult);
		const reference = normalize(referenceResult);
		if (candidate === undefined || reference === undefined) continue;
		pairs.push({
			key: resultKey(candidateResult),
			category: candidateResult.category,
			protected: candidateResult.protected || referenceResult.protected,
			reference,
			candidate,
			referenceResult,
			candidateResult,
		});
	}
	return pairs.sort((left, right) => left.key.localeCompare(right.key));
}

function mean(values: readonly number[]): number {
	return values.length === 0
		? 0
		: values.reduce((total, value) => total + value, 0) / values.length;
}

function seededRandom(seedHash: string): () => number {
	let state = Number.parseInt(seedHash.slice(0, 8), 16) >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function percentile(sorted: readonly number[], probability: number): number {
	if (sorted.length === 0) return 0;
	const position = (sorted.length - 1) * probability;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	if (lower === upper) return sorted[lower] ?? 0;
	const fraction = position - lower;
	return (
		(sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction
	);
}

export function pairedBootstrapConfidenceInterval(
	deltas: readonly number[],
	seedHash: string,
	resamples = 10_000,
): [number, number] {
	if (deltas.length === 0) return [0, 0];
	const random = seededRandom(seedHash);
	const estimates = new Array<number>(resamples);
	for (let sample = 0; sample < resamples; sample++) {
		let total = 0;
		for (let index = 0; index < deltas.length; index++) {
			total += deltas[Math.floor(random() * deltas.length)] ?? 0;
		}
		estimates[sample] = total / deltas.length;
	}
	estimates.sort((left, right) => left - right);
	return [percentile(estimates, 0.025), percentile(estimates, 0.975)];
}

function availableCosts(pairs: readonly Pair[]): boolean {
	return pairs.every(
		(pair) =>
			pair.candidateResult.cost.source !== 'unavailable' &&
			pair.referenceResult.cost.source !== 'unavailable',
	);
}

function makeComparison(
	pairs: readonly Pair[],
	scheduledPairs: number,
	referenceRunId: string,
	referenceCandidateId: string,
	seedHash: string,
) {
	const deltas = pairs.map((pair) => pair.candidate - pair.reference);
	return {
		baselineRunId: referenceRunId,
		baselineCandidateId: referenceCandidateId,
		baselineMean: mean(pairs.map((pair) => pair.reference)),
		candidateMean: mean(pairs.map((pair) => pair.candidate)),
		pairedDelta: mean(deltas),
		confidenceInterval: pairedBootstrapConfidenceInterval(deltas, seedHash),
		validPairs: pairs.length,
		missingPairs: Math.max(0, scheduledPairs - pairs.length),
		coverage:
			scheduledPairs === 0 ? 0 : Math.min(1, pairs.length / scheduledPairs),
	};
}

export function decidePromotion(
	input: DecidePromotionInput,
): PromotionDecisionV1 {
	const run = input.run;
	const policy = PromotionPolicyV1Schema.parse({
		v: 1,
		...(input.policy ?? {}),
	});
	const policyHash = canonicalHash(policy);
	const seedHash = sha256(
		`${run.seed}${run.taskSet.contentHash}${run.baseline.contentHash}${run.candidate.contentHash}${policyHash}`,
	);
	const scheduledPairs =
		run.taskSet.taskIds.length * run.budgets.maxRepetitions;
	const candidateResults = run.results.filter(
		(result) => result.candidateId === run.candidate.id,
	);
	const baselineResults = run.results.filter(
		(result) => result.candidateId === run.baseline.id,
	);
	const baselinePairs = collectPairs(candidateResults, baselineResults);
	const historicalCompatible =
		input.historicalBest !== undefined &&
		input.historicalBest.taskSet.contentHash === run.taskSet.contentHash &&
		input.historicalBest.split === run.split;
	const historicalResults = historicalCompatible
		? input.historicalBest?.results.filter(
				(result) => result.candidateId === input.historicalBest?.candidate.id,
			)
		: [];
	const historicalPairs = collectPairs(
		candidateResults,
		historicalResults ?? [],
	);
	const historicalSeed = sha256(`${seedHash}:historical-best`);
	const baseline = makeComparison(
		baselinePairs,
		scheduledPairs,
		run.runId,
		run.baseline.id,
		seedHash,
	);
	const historicalBest = makeComparison(
		historicalPairs,
		scheduledPairs,
		input.historicalBest?.runId ?? 'unavailable',
		input.historicalBest?.candidate.id ?? 'unavailable',
		historicalSeed,
	);

	const categories = [...new Set(baselinePairs.map((pair) => pair.category))]
		.sort()
		.map((category) => {
			const pairs = baselinePairs.filter((pair) => pair.category === category);
			const categoryProtected = pairs.some((pair) => pair.protected);
			const tolerance = policy.protectedCategoryTolerances[category] ?? 0;
			const baselineMean = mean(pairs.map((pair) => pair.reference));
			const candidateMean = mean(pairs.map((pair) => pair.candidate));
			const pairedDelta = candidateMean - baselineMean;
			return {
				category,
				protected: categoryProtected,
				tolerance,
				baselineMean,
				candidateMean,
				pairedDelta,
				regression: categoryProtected && pairedDelta < -tolerance,
			};
		});

	const reasons: string[] = [];
	let status: 'accept' | 'reject' | 'inconclusive' = 'inconclusive';
	if (!historicalCompatible)
		reasons.push('historical_best_incompatible_or_missing');
	if (baseline.validPairs < policy.minValidPairs)
		reasons.push('baseline_insufficient_valid_pairs');
	if (historicalBest.validPairs < policy.minValidPairs)
		reasons.push('historical_best_insufficient_valid_pairs');
	if (baseline.coverage < policy.minCoverage)
		reasons.push('baseline_insufficient_coverage');
	if (historicalBest.coverage < policy.minCoverage)
		reasons.push('historical_best_insufficient_coverage');
	if (
		policy.requireAvailableCosts &&
		(!availableCosts(baselinePairs) ||
			!availableCosts(historicalPairs) ||
			run.cost.source === 'unavailable' ||
			input.historicalBest?.cost.source === 'unavailable')
	) {
		reasons.push('promotion_cost_unavailable');
	}
	const evidenceSufficient = reasons.length === 0;
	const protectedRegressions = categories.filter(
		(category) => category.regression,
	);
	for (const category of protectedRegressions) {
		reasons.push(`protected_category_regression:${category.category}`);
	}
	const baselineDecisiveRegression =
		baseline.confidenceInterval[1] < -policy.deadband;
	const historicalDecisiveRegression =
		historicalBest.confidenceInterval[1] < -policy.deadband;
	if (
		evidenceSufficient &&
		(baselineDecisiveRegression || historicalDecisiveRegression)
	) {
		status = 'reject';
		if (baselineDecisiveRegression)
			reasons.push('decisive_regression:baseline');
		if (historicalDecisiveRegression)
			reasons.push('decisive_regression:historical_best');
	} else if (evidenceSufficient && protectedRegressions.length > 0) {
		status = 'reject';
	} else if (
		evidenceSufficient &&
		baseline.confidenceInterval[0] > policy.deadband &&
		historicalBest.confidenceInterval[0] > policy.deadband
	) {
		status = 'accept';
		reasons.push(
			'improvement_exceeds_deadband_for_baseline_and_historical_best',
		);
	} else if (evidenceSufficient) {
		reasons.push('confidence_interval_overlaps_deadband');
	}

	const historicalRun = input.historicalBest;
	const decisionCore = {
		runId: run.runId,
		status,
		reasons,
		baseline,
		historicalBest,
		deadband: policy.deadband,
		bootstrap: {
			resamples: 10_000 as const,
			confidence: 0.95 as const,
			seedHash,
		},
		categories,
		lineage: {
			baselineRunId: run.runId,
			historicalBestRunId: historicalRun?.runId ?? 'unavailable',
			taskSetHash: run.taskSet.contentHash,
			baselineHash: run.baseline.contentHash,
			candidateHash: run.candidate.contentHash,
			historicalBestHash:
				historicalRun?.candidate.contentHash ?? '0'.repeat(64),
		},
		policyHash,
		unavailableQualityMetrics: [
			'complexity_delta',
			'public_api_delta',
		] as const,
	};
	return PromotionDecisionV1Schema.parse({
		v: 1,
		decisionId: `promotion-${canonicalHash(decisionCore)}`,
		decidedAt: input.decidedAt ?? new Date().toISOString(),
		...decisionCore,
	});
}

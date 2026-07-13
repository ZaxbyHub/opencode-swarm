import { describe, expect, test } from 'bun:test';
import type {
	EvaluationCandidateV1,
	EvaluationResultV1,
	EvaluationRunV1,
} from '../../../src/evaluation/contracts.js';
import {
	decidePromotion,
	pairedBootstrapConfidenceInterval,
} from '../../../src/evaluation/statistics.js';

const baseline: EvaluationCandidateV1 = {
	v: 1,
	id: 'baseline',
	kind: 'baseline',
	payloadPath: 'candidates/baseline.md',
	model: 'model-a',
	contentHash: 'a'.repeat(64),
};
const candidate: EvaluationCandidateV1 = {
	v: 1,
	id: 'candidate',
	kind: 'skill',
	payloadPath: 'candidates/candidate.md',
	model: 'model-a',
	contentHash: 'b'.repeat(64),
};

function result(
	taskIndex: number,
	candidateId: string,
	score: number,
	protectedCategory = false,
): EvaluationResultV1 {
	return {
		v: 1,
		taskId: `task-${taskIndex}`,
		category: protectedCategory ? 'security' : 'correctness',
		protected: protectedCategory,
		repetition: 0,
		candidateId,
		seed: `seed-${taskIndex}`,
		outcome: 'scored',
		score,
		scoreRange: [0, 1],
		cost: { source: 'reported', usd: 0.01 },
		durationMs: 1,
	};
}

function run(options: {
	runId: string;
	baselineScore: number;
	candidateScore: number;
	candidateValue?: EvaluationCandidateV1;
	taskSetHash?: string;
	protectedRegression?: boolean;
}): EvaluationRunV1 {
	const runCandidate = options.candidateValue ?? candidate;
	const taskIds = Array.from({ length: 6 }, (_, index) => `task-${index}`);
	const results: EvaluationResultV1[] = [];
	for (let index = 0; index < taskIds.length; index++) {
		const isProtected = options.protectedRegression === true && index === 0;
		results.push(
			result(
				index,
				baseline.id,
				isProtected ? 0.9 : options.baselineScore,
				isProtected,
			),
			result(
				index,
				runCandidate.id,
				isProtected ? 0.1 : options.candidateScore,
				isProtected,
			),
		);
	}
	const taskSetHash = options.taskSetHash ?? 'c'.repeat(64);
	return {
		v: 1,
		runId: options.runId,
		createdAt: '2026-07-13T12:00:00.000Z',
		status: 'complete',
		baseline,
		candidate: runCandidate,
		taskSet: { id: 'validation-v1', contentHash: taskSetHash, taskIds },
		split: 'validation',
		seed: 'stable-seed',
		models: ['model-a'],
		environment: {
			platform: 'test',
			arch: 'test',
			runtime: 'bun-test',
			baseSha: 'd'.repeat(40),
			activeTreeHash: 'e'.repeat(64),
			taskSetHash,
		},
		budgets: {
			maxTasks: 6,
			maxRepetitions: 1,
			maxConcurrency: 1,
			maxTaskTimeMs: 1_000,
			maxRetries: 0,
			maxOutputBytes: 1_024,
		},
		results,
		cost: { source: 'reported', usd: 0.12 },
		integrityHash: 'f'.repeat(64),
	};
}

describe('deterministic paired promotion statistics', () => {
	test('produces the same 10,000-resample interval for the same seed', () => {
		const first = pairedBootstrapConfidenceInterval(
			[0.1, 0.2, 0.3],
			'1'.repeat(64),
		);
		const second = pairedBootstrapConfidenceInterval(
			[0.1, 0.2, 0.3],
			'1'.repeat(64),
		);
		expect(first).toEqual(second);
		expect(first[0]).toBeGreaterThanOrEqual(0.1);
		expect(first[1]).toBeLessThanOrEqual(0.3);
	});

	test('accepts only a decisive improvement over baseline and historical best', () => {
		const current = run({
			runId: 'current',
			baselineScore: 0.4,
			candidateScore: 0.8,
		});
		const historicalCandidate = {
			...candidate,
			id: 'historical',
			contentHash: '9'.repeat(64),
		};
		const historical = run({
			runId: 'historical-run',
			baselineScore: 0.4,
			candidateScore: 0.5,
			candidateValue: historicalCandidate,
		});
		const decision = decidePromotion({
			run: current,
			historicalBest: historical,
			policy: { deadband: 0.1 },
			decidedAt: '2026-07-13T13:00:00.000Z',
		});
		expect(decision.status).toBe('accept');
		expect(decision.baseline.validPairs).toBe(6);
		expect(decision.historicalBest.validPairs).toBe(6);
		expect(decision.unavailableQualityMetrics).toEqual([
			'complexity_delta',
			'public_api_delta',
		]);
		expect(
			decidePromotion({
				run: current,
				historicalBest: historical,
				policy: { deadband: 0.1 },
				decidedAt: '2026-07-13T13:00:00.000Z',
			}),
		).toEqual(decision);
	});

	test('rejects a protected-category regression even when the overall mean improves', () => {
		const current = run({
			runId: 'protected-current',
			baselineScore: 0.2,
			candidateScore: 1,
			protectedRegression: true,
		});
		const historical = run({
			runId: 'protected-history',
			baselineScore: 0.2,
			candidateScore: 0.1,
			candidateValue: {
				...candidate,
				id: 'prior',
				contentHash: '8'.repeat(64),
			},
		});
		const decision = decidePromotion({
			run: current,
			historicalBest: historical,
		});
		expect(decision.status).toBe('reject');
		expect(decision.reasons).toContain(
			'protected_category_regression:security',
		);
	});

	test('is inconclusive for missing or incompatible historical evidence', () => {
		const current = run({
			runId: 'no-history',
			baselineScore: 0.4,
			candidateScore: 0.8,
		});
		const incompatible = run({
			runId: 'other-set',
			baselineScore: 0.4,
			candidateScore: 0.5,
			taskSetHash: '7'.repeat(64),
		});
		const decision = decidePromotion({
			run: current,
			historicalBest: incompatible,
		});
		expect(decision.status).toBe('inconclusive');
		expect(decision.reasons).toContain(
			'historical_best_incompatible_or_missing',
		);
	});

	test('is inconclusive for insufficient pairs or unavailable promotion cost', () => {
		const current = run({
			runId: 'unavailable-cost',
			baselineScore: 0.4,
			candidateScore: 0.8,
		});
		current.cost = { source: 'unavailable' };
		const historical = run({
			runId: 'cost-history',
			baselineScore: 0.4,
			candidateScore: 0.5,
			candidateValue: {
				...candidate,
				id: 'cost-prior',
				contentHash: '6'.repeat(64),
			},
		});
		const unavailable = decidePromotion({
			run: current,
			historicalBest: historical,
		});
		expect(unavailable.status).toBe('inconclusive');
		expect(unavailable.reasons).toContain('promotion_cost_unavailable');

		const onePair = run({
			runId: 'one-pair',
			baselineScore: 0.4,
			candidateScore: 0.8,
		});
		onePair.results = onePair.results.filter(
			(result) => result.taskId === 'task-0',
		);
		const insufficient = decidePromotion({
			run: onePair,
			historicalBest: historical,
		});
		expect(insufficient.status).toBe('inconclusive');
		expect(insufficient.reasons).toContain('baseline_insufficient_valid_pairs');
	});
});

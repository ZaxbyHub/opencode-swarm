import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const reviewedRows = (
	ids: readonly string[],
	classification: 'CONFIRMED' | 'DISPROVED' = 'CONFIRMED',
	severity: 'HIGH' | 'LOW' | 'NONE' = classification === 'DISPROVED'
		? 'NONE'
		: 'HIGH',
	rationale = 'rationale',
): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | ${rationale} ${id} | probe ${id} | reviewer`,
		)
		.join('\n');

const criticisedRows = (
	ids: readonly string[],
	status: 'UPHELD' | 'DOWNGRADED' | 'DISPROVED' = 'UPHELD',
	severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' = 'HIGH',
	reason = 'reason',
	requiredChange = 'required change',
): string =>
	ids
		.map(
			(id) =>
				`[CRITIC] | ${id} | ${status} | ${severity} | ${reason} ${id} | ${requiredChange} ${id}`,
		)
		.join('\n');

async function establishTwentyItemInventory(): Promise<string[]> {
	await establishReviewPrerequisites();
	const [dimension] = PR_REVIEW_BASE_DIMENSION_IDS;
	const lane = { laneId: 'twenty-items', workflowLane: dimension };
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
		batchId: 'twenty-items',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('twenty-items', 'swarm-pr-review:base', [lane], {
		textOverride: [
			CANDIDATE_HEADER,
			...Array.from({ length: 15 }, (_value, index) => {
				const id = `I-${String(index + 1).padStart(2, '0')}`;
				return `${id} | ${dimension} | HIGH | correctness | file.ts:${index + 1} | claim ${id} | evidence ${id} | impact ${id} | HIGH`;
			}),
		].join('\n'),
	});
	const composed = await gateInternals.composePrReviewPhaseVerdicts(
		tempDir,
		SESSION_ID,
		'reviewer',
	);
	expect(composed.requiredInventory).toHaveLength(20);
	return composed.requiredInventory;
}

async function recordReviewerBatch(args: {
	batchId: string;
	lanes: readonly {
		laneId: string;
		workflowLane: string;
		reviewItemIds: string[];
	}[];
	successfulLaneId?: string;
	rows?: string;
}): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		args.lanes,
		{ batchId: args.batchId, prHeadSha: HEAD_SHA },
	);
	if (args.successfulLaneId && args.rows) {
		await persistBatch(
			args.batchId,
			'swarm-pr-review:reviewer',
			[
				{
					laneId: args.successfulLaneId,
					workflowLane: args.successfulLaneId,
				},
			],
			{ textOverride: args.rows },
		);
	}
}

async function recordCriticBatch(args: {
	batchId: string;
	lanes: readonly {
		laneId: string;
		workflowLane: string;
		reviewItemIds: string[];
	}[];
	successfulLaneId?: string;
	rows?: string;
}): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'critic',
		args.lanes,
		{ batchId: args.batchId, prHeadSha: HEAD_SHA },
	);
	if (args.successfulLaneId && args.rows) {
		await persistBatch(
			args.batchId,
			'swarm-pr-review:critic',
			[
				{
					laneId: args.successfulLaneId,
					workflowLane: args.successfulLaneId,
				},
			],
			{ textOverride: args.rows },
		);
	}
}

describe('PR-review verdict settlement — regression: partial batches compose item-by-item (#2278)', () => {
	test('a 12-only reviewer retry batch settles after an 8-item healthy lane and a 12-item failed lane', async () => {
		const items = await establishTwentyItemInventory();
		const healthy = items.slice(0, 8);
		const failed = items.slice(8);

		await recordReviewerBatch({
			batchId: 'review-wave-1',
			lanes: [
				{
					laneId: 'review-wave-healthy',
					workflowLane: 'review-wave-healthy',
					reviewItemIds: healthy,
				},
				{
					laneId: 'review-wave-failed',
					workflowLane: 'review-wave-failed',
					reviewItemIds: failed,
				},
			],
			successfulLaneId: 'review-wave-healthy',
			rows: reviewedRows(healthy),
		});

		await expect(
			recordReviewerBatch({
				batchId: 'review-wave-2',
				lanes: [
					{
						laneId: 'review-wave-retry',
						workflowLane: 'review-wave-retry',
						reviewItemIds: failed,
					},
				],
				successfulLaneId: 'review-wave-retry',
				rows: reviewedRows(failed),
			}),
		).resolves.toBeUndefined();

		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual([]);
		expect(composed.claims.get(healthy[0])?.batchId).toBe('review-wave-1');
		expect(composed.claims.get(failed[0])?.batchId).toBe('review-wave-2');
	});

	test('critic complementary partial batches settle and newest successful supersession wins', async () => {
		const items = await establishTwentyItemInventory();
		const reviewerWinning = items.slice(0, 12);
		const reviewerNonCritic = items.slice(12);
		const criticFirst = reviewerWinning.slice(0, 8);
		const criticRetry = [criticFirst[0]!, ...reviewerWinning.slice(8, 12)];

		await recordReviewerBatch({
			batchId: 'review-for-critic',
			lanes: [
				{
					laneId: 'review-for-critic',
					workflowLane: 'review-for-critic',
					reviewItemIds: items,
				},
			],
			successfulLaneId: 'review-for-critic',
			rows: `${reviewedRows(reviewerWinning)}\n${reviewedRows(
				reviewerNonCritic,
				'DISPROVED',
				'NONE',
			)}`,
		});
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		await recordCriticBatch({
			batchId: 'critic-wave-1',
			lanes: [
				{
					laneId: 'critic-wave-healthy',
					workflowLane: 'critic-wave-healthy',
					reviewItemIds: criticFirst,
				},
				{
					laneId: 'critic-wave-failed',
					workflowLane: 'critic-wave-failed',
					reviewItemIds: reviewerWinning.slice(8, 12),
				},
			],
			successfulLaneId: 'critic-wave-healthy',
			rows: criticisedRows(criticFirst),
		});

		await expect(
			recordCriticBatch({
				batchId: 'critic-wave-2',
				lanes: [
					{
						laneId: 'critic-wave-retry',
						workflowLane: 'critic-wave-retry',
						reviewItemIds: criticRetry,
					},
				],
				successfulLaneId: 'critic-wave-retry',
				rows: criticisedRows(criticRetry),
			}),
		).resolves.toBeUndefined();

		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'critic',
		);
		expect(composed.unclaimed).toEqual([]);
		expect(composed.claims.get(criticFirst[0]!)?.batchId).toBe('critic-wave-2');
		expect(composed.claims.get(criticFirst[1]!)?.batchId).toBe('critic-wave-1');
		expect(composed.claims.get(criticRetry[3]!)?.batchId).toBe('critic-wave-2');
	});

	test('critic claims rebind when the authoritative reviewer row changes', async () => {
		const items = await establishTwentyItemInventory();
		const reviewerWinning = items.slice(0, 12);
		const reviewerNonCritic = items.slice(12);
		const bindingTarget = reviewerWinning[0]!;

		await recordReviewerBatch({
			batchId: 'review-bind-1',
			lanes: [
				{
					laneId: 'review-bind-1',
					workflowLane: 'review-bind-1',
					reviewItemIds: items,
				},
			],
			successfulLaneId: 'review-bind-1',
			rows: `${reviewedRows(reviewerWinning)}\n${reviewedRows(
				reviewerNonCritic,
				'DISPROVED',
				'NONE',
			)}`,
		});
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		await recordCriticBatch({
			batchId: 'critic-bind-old',
			lanes: [
				{
					laneId: 'critic-bind-old',
					workflowLane: 'critic-bind-old',
					reviewItemIds: [bindingTarget],
				},
			],
			successfulLaneId: 'critic-bind-old',
			rows: criticisedRows([bindingTarget]),
		});

		await recordReviewerBatch({
			batchId: 'review-bind-2',
			lanes: [
				{
					laneId: 'review-bind-2',
					workflowLane: 'review-bind-2',
					reviewItemIds: items,
				},
			],
			successfulLaneId: 'review-bind-2',
			rows: `${reviewedRows(
				[bindingTarget],
				'CONFIRMED',
				'HIGH',
				'revised root cause',
			)}\n${reviewedRows(reviewerWinning.slice(1))}\n${reviewedRows(
				reviewerNonCritic,
				'DISPROVED',
				'NONE',
			)}`,
		});
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		await expect(
			recordCriticBatch({
				batchId: 'critic-bind-new',
				lanes: [
					{
						laneId: 'critic-bind-new',
						workflowLane: 'critic-bind-new',
						reviewItemIds: [bindingTarget],
					},
				],
				successfulLaneId: 'critic-bind-new',
				rows: criticisedRows([bindingTarget], 'UPHELD', 'HIGH', 'new reason'),
			}),
		).resolves.toBeUndefined();

		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'critic',
		);
		expect(composed.claims.get(bindingTarget)).toMatchObject({
			batchId: 'critic-bind-new',
		});
	});

	test('an invented item in a partial batch still fails closed', async () => {
		const items = await establishTwentyItemInventory();
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'invented-lane',
						workflowLane: 'invented-lane',
						reviewItemIds: [items[0]!, 'INVENTED'],
					},
				],
				{ batchId: 'invented', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('extra: INVENTED');
	});
});

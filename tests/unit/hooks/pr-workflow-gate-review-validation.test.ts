import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	assertPrReviewValidationSettled,
	completePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
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

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('pr-workflow-gate review validation', () => {
	test('PR review completion cannot clear with zero reviewer obligations', async () => {
		await establishReviewPrerequisites();
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		).rejects.toThrow('at least one reviewer batch');
	});

	test('reviewer dispatch rejects a trigger artifact with any micro-lane waiver', async () => {
		await establishReviewPrerequisites();
		const triggerPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			'test-run',
			'trigger-eval.json',
		);
		const artifact = JSON.parse(await fs.readFile(triggerPath, 'utf-8')) as {
			rows: Array<{ result: string }>;
		};
		artifact.rows[0].result = 'NO-MATCH';
		await fs.writeFile(triggerPath, JSON.stringify(artifact), 'utf-8');

		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'waived-review',
						workflowLane: 'waived-review',
						reviewItemIds: ['C-0'],
					},
				],
				{ batchId: 'waived-review', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('exact all-MATCHED');
	});

	test('reviewer dispatch independently rejects missing micro-lane provenance', async () => {
		await establishReviewPrerequisites();
		const triggerPath = path.join(
			tempDir,
			'.swarm',
			'pr-review',
			'test-run',
			'trigger-eval.json',
		);
		const artifact = JSON.parse(await fs.readFile(triggerPath, 'utf-8')) as {
			rows: Array<{ source_batch_id?: string }>;
		};
		delete artifact.rows[0].source_batch_id;
		await fs.writeFile(triggerPath, JSON.stringify(artifact), 'utf-8');

		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'missing-provenance-review',
						workflowLane: 'missing-provenance-review',
						reviewItemIds: ['C-0'],
					},
				],
				{ batchId: 'missing-provenance-review', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('complete source provenance');
	});

	test('reviewer ownership is derived from discovery artifacts and critic routing is mandatory', async () => {
		await establishReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'review-missing',
						workflowLane: 'review-missing',
						reviewItemIds: candidateIds.slice(0, -1),
					},
				],
				{ batchId: 'review-missing', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('mechanically derived inventory');
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'review-invented',
						workflowLane: 'review-invented',
						reviewItemIds: [...candidateIds, 'INVENTED'],
					},
				],
				{ batchId: 'review-invented', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('extra: INVENTED');

		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-all',
					workflowLane: 'review-all',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-all', prHeadSha: HEAD_SHA },
		);
		const reviewerRows = candidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-all',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-all', workflowLane: 'review-all' }],
			{ textOverride: reviewerRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-degraded-late',
					workflowLane: 'review-all',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-degraded-late', prHeadSha: HEAD_SHA },
		);
		const suppressedCriticRows = candidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | LOW | NO | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-degraded-late',
			'swarm-pr-review:reviewer',
			[
				{
					laneId: 'review-degraded-late',
					workflowLane: 'review-all',
				},
			],
			{
				textOverride: suppressedCriticRows,
				transcriptIncomplete: true,
			},
		);
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		).rejects.toThrow('require critic coverage');
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'critic',
				[
					{
						laneId: 'critic-partial',
						workflowLane: 'critic-partial',
						reviewItemIds: candidateIds.slice(0, -1),
					},
				],
				{ batchId: 'critic-partial', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('mechanically derived inventory');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-invalid',
					workflowLane: 'critic-invalid',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'critic-invalid', prHeadSha: HEAD_SHA },
		);
		const criticRows = candidateIds
			.map(
				(id) => `[CRITIC] | ${id} | BANANA | HIGH | reason | required change`,
			)
			.join('\n');
		await persistBatch(
			'critic-invalid',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-invalid', workflowLane: 'critic-invalid' }],
			{ textOverride: criticRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).rejects.toThrow('one fully successful exact batch');
	});

	test('semantic verdict enums reject structurally populated nonsense', async () => {
		await establishReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-invalid',
					workflowLane: 'review-invalid',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-invalid', prHeadSha: HEAD_SHA },
		);
		const invalidRows = candidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | BANANA | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-invalid',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-invalid', workflowLane: 'review-invalid' }],
			{ textOverride: invalidRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow('one fully successful exact batch');
	});

	test('critic verdicts reject unresolved and incoherent terminal rows', () => {
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | NEEDS_MORE_EVIDENCE | HIGH | missing proof | gather trace',
				'C-1',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | UPHELD | NONE | valid reason | report change',
				'C-1',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | DISPROVED | HIGH | valid reason | remove finding',
				'C-1',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | DISPROVED | NONE | valid reason | remove finding',
				'C-1',
				'HIGH',
			),
		).toEqual({ status: 'DISPROVED', severity: 'NONE' });
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | DOWNGRADED | HIGH | valid reason | revise report',
				'C-1',
				'MEDIUM',
			),
		).toBeNull();
		expect(
			gateInternals.parseCriticVerdict(
				'[CRITIC] | C-1 | UPHELD | MEDIUM | valid reason | keep finding',
				'C-1',
				'HIGH',
			),
		).toBeNull();
	});

	test('a new reviewer batch invalidates every older critic batch', async () => {
		await establishReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const reviewerRows = candidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-before-critic',
					workflowLane: 'review-all',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-before-critic', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'review-before-critic',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-before-critic', workflowLane: 'review-all' }],
			{ textOverride: reviewerRows },
		);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-old',
					workflowLane: 'critic-all',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'critic-old', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'critic-old',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-old', workflowLane: 'critic-all' }],
			{
				textOverride: candidateIds
					.map(
						(id) =>
							`[CRITIC] | ${id} | UPHELD | HIGH | reason | required change`,
					)
					.join('\n'),
			},
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-after-critic',
					workflowLane: 'review-all',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-after-critic', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'review-after-critic',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-after-critic', workflowLane: 'review-all' }],
			{ textOverride: reviewerRows },
		);
		const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(
			state?.prReviewValidationBatches?.some(
				(batch) => batch.phase === 'critic',
			),
		).toBe(false);
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA),
		).rejects.toThrow('require critic coverage');
	});

	test('reviewer settlement rejects complementary partial retry batches', async () => {
		await establishReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		const halves = [candidateIds.slice(0, 3), candidateIds.slice(3)];
		for (const [index, successfulHalf] of halves.entries()) {
			const lanes = [
				{
					laneId: `retry-${index}-a`,
					workflowLane: 'review-half-a',
					reviewItemIds: halves[0],
				},
				{
					laneId: `retry-${index}-b`,
					workflowLane: 'review-half-b',
					reviewItemIds: halves[1],
				},
			];
			const batchId = `complementary-${index}`;
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				lanes,
				{ batchId, prHeadSha: HEAD_SHA },
			);
			const successfulLane = lanes[index];
			const rows = successfulHalf
				.map(
					(id) =>
						`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
				)
				.join('\n');
			await persistBatch(
				batchId,
				'swarm-pr-review:reviewer',
				[
					{
						laneId: successfulLane.laneId,
						workflowLane: successfulLane.workflowLane,
					},
				],
				{ textOverride: rows },
			);
		}

		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow('one fully successful exact batch');
	});

	test('workflow artifacts must match the exact delegation role identity', async () => {
		await establishReviewPrerequisites();
		const candidateIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-wrong-role',
					workflowLane: 'review-wrong-role',
					reviewItemIds: candidateIds,
				},
			],
			{ batchId: 'review-wrong-role', prHeadSha: HEAD_SHA },
		);
		const rows = candidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-wrong-role',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-wrong-role', workflowLane: 'review-wrong-role' }],
			{ textOverride: rows, artifactRole: 'critic' },
		);

		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow('one fully successful exact batch');
	});
});

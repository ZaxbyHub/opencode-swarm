import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisitesWithConsolidatedMicroLane,
	establishReviewPrerequisitesWithOverlappingBaseRetry,
	HEAD_SHA,
	PR_REVIEW_SCOPE,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('pr-workflow-gate candidate inventory deduplication', () => {
	test('a consolidated micro lane cited by two trigger rows contributes its candidates exactly once', async () => {
		const { consolidatedCandidateId, baseCandidateIds } =
			await establishReviewPrerequisitesWithConsolidatedMicroLane();
		const allCandidateIds = [...baseCandidateIds, consolidatedCandidateId];

		// Before the fix, deriving the inventory extracted the consolidated
		// lane's artifact once per citing trigger row, duplicating
		// consolidatedCandidateId and permanently BLOCKing reviewer dispatch.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-consolidated',
					workflowLane: 'review-consolidated',
					reviewItemIds: allCandidateIds,
				},
			],
			{ batchId: 'review-consolidated', prHeadSha: HEAD_SHA },
		);
		const reviewerRows = allCandidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-consolidated',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-consolidated', workflowLane: 'review-consolidated' }],
			{ textOverride: reviewerRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});

	test('a consolidated micro lane cited by three or more trigger rows still contributes its candidates exactly once', async () => {
		const { consolidatedCandidateId, baseCandidateIds } =
			await establishReviewPrerequisitesWithConsolidatedMicroLane(3);
		const allCandidateIds = [...baseCandidateIds, consolidatedCandidateId];

		// The two-row case alone does not prove the dedup generalizes past a
		// single pair; a third citing row exercises the same extractedLaneKeys
		// dedup path with an odd, non-pairwise citation count.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-consolidated-triple',
					workflowLane: 'review-consolidated-triple',
					reviewItemIds: allCandidateIds,
				},
			],
			{ batchId: 'review-consolidated-triple', prHeadSha: HEAD_SHA },
		);
		const reviewerRows = allCandidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-consolidated-triple',
			'swarm-pr-review:reviewer',
			[
				{
					laneId: 'review-consolidated-triple',
					workflowLane: 'review-consolidated-triple',
				},
			],
			{ textOverride: reviewerRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});

	test('a base retry that re-claims an already-covered dimension supersedes only that dimension, not the whole superseded lane', async () => {
		const {
			onlyDimACandidateId,
			freshDimBCandidateId,
			staleDimBCandidateId,
			remainingBaseCandidateIds,
		} = await establishReviewPrerequisitesWithOverlappingBaseRetry();
		const correctCandidateIds = [
			onlyDimACandidateId,
			freshDimBCandidateId,
			...remainingBaseCandidateIds,
		];

		// Before the fix, the initial consolidated lane stayed admitted for its
		// still-unique dimA ownership, and its full (unscoped) artifact text was
		// re-extracted wholesale — resurrecting the dimB candidate the retry
		// batch had already superseded.
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'review-with-stale',
						workflowLane: 'review-with-stale',
						reviewItemIds: [...correctCandidateIds, staleDimBCandidateId],
					},
				],
				{ batchId: 'review-with-stale', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow(`extra: ${staleDimBCandidateId}`);

		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-correct',
					workflowLane: 'review-correct',
					reviewItemIds: correctCandidateIds,
				},
			],
			{ batchId: 'review-correct', prHeadSha: HEAD_SHA },
		);
		const reviewerRows = correctCandidateIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-correct',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-correct', workflowLane: 'review-correct' }],
			{ textOverride: reviewerRows, scope: PR_REVIEW_SCOPE },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});
});

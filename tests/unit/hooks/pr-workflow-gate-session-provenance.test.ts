import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
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

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('pr-workflow-gate independent session provenance', () => {
	test('critic settlement rejects reuse of a reviewer child session', async () => {
		await establishReviewPrerequisites();
		const ids = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_value, index) => `C-${index}`,
		);
		const shared = { subagentSessionId: 'shared-review-critic' };
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-shared',
					workflowLane: 'review-shared',
					reviewItemIds: ids,
				},
			],
			{ batchId: 'review-shared', prHeadSha: HEAD_SHA },
		);
		const reviewerRows = ids
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
			)
			.join('\n');
		await persistBatch(
			'review-shared',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-shared', workflowLane: 'review-shared' }],
			{ ...shared, textOverride: reviewerRows },
		);
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-shared',
					workflowLane: 'critic-shared',
					reviewItemIds: ids,
				},
			],
			{ batchId: 'critic-shared', prHeadSha: HEAD_SHA },
		);
		const criticRows = ids
			.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`)
			.join('\n');
		await persistBatch(
			'critic-shared',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-shared', workflowLane: 'critic-shared' }],
			{ ...shared, textOverride: criticRows },
		);

		// Every critic row parses and the batch covers the whole inventory; the
		// ONLY defect is the reused child session, so no item may be claimed.
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).rejects.toThrow(
			`critic items lack an authenticated verdict from any successful lane: ${ids.join(', ')}`,
		);

		// Positive control: the identical critic batch from an independent child
		// session settles, proving the rejection above isolates session reuse.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-independent',
					workflowLane: 'critic-independent',
					reviewItemIds: ids,
				},
			],
			{ batchId: 'critic-independent', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'critic-independent',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-independent', workflowLane: 'critic-independent' }],
			{ subagentSessionId: 'independent-critic', textOverride: criticRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});
});

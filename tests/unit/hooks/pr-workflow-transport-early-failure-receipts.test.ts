import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	readLaneOutput,
	storeLaneOutput,
} from '../../../src/background/lane-output-store.js';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import {
	encodePrReviewCollectionReceiptShedMarker,
	parsePrReviewCollectionReceiptFooter,
} from '../../../src/background/pr-review-collection-receipt.js';
import {
	recordPrReviewValidationBatch,
	validatePrWorkflowTransportRecovery,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _test_exports as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	PR_REVIEW_SCOPE,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

const BATCH_ID = 'early-failure-batch';
const LANE_ID = 'early-failure-lane';
const CORRELATION_ID = 'early-failure-correlation';
const REVIEW_ITEM_IDS = ['C-0', 'C-1'] as const;

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

async function prepareValidationInput() {
	await establishReviewPrerequisites();
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: LANE_ID,
				workflowLane: LANE_ID,
				reviewItemIds: [...REVIEW_ITEM_IDS],
			},
		],
		{ batchId: BATCH_ID, prHeadSha: HEAD_SHA },
	);
	const record = await recordPendingDelegation(tempDir, {
		correlationId: CORRELATION_ID,
		jobId: null,
		subagentSessionId: CORRELATION_ID,
		parentSessionId: SESSION_ID,
		callID: BATCH_ID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH_ID,
		laneId: LANE_ID,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: LANE_ID,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: PR_REVIEW_SCOPE,
		},
	});
	expect(record).not.toBeNull();
	const text = REVIEW_ITEM_IDS.map(
		(itemId, index) =>
			`[REVIEWED] | ${itemId} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:${index + 1} | rationale | probe | notes`,
	).join('\n');
	const stored = storeLaneOutput(tempDir, {
		batchId: BATCH_ID,
		laneId: LANE_ID,
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: CORRELATION_ID,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: LANE_ID,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: PR_REVIEW_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	const artifact = readLaneOutput(tempDir, stored.ref!)?.artifact;
	expect(artifact).toBeDefined();
	return {
		record: record!,
		result: {
			text,
			chars: text.length,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
		artifact: artifact!,
	};
}

describe('PR-review transport early-failure retry receipts', () => {
	test.each([
		{
			name: 'artifact digest mismatch',
			mutate: (
				artifact: Awaited<
					ReturnType<typeof prepareValidationInput>
				>['artifact'],
			) => ({
				...artifact,
				digest: 'f'.repeat(64),
			}),
		},
		{
			name: 'artifact parent identity mismatch',
			mutate: (
				artifact: Awaited<
					ReturnType<typeof prepareValidationInput>
				>['artifact'],
			) => ({
				...artifact,
				parentSessionId: 'wrong-parent',
			}),
		},
	])('rejects every assigned item on $name', async ({ mutate }) => {
		const input = await prepareValidationInput();
		const validation = await validatePrWorkflowTransportRecovery({
			directory: tempDir,
			record: input.record,
			result: input.result,
			artifact: mutate(input.artifact),
			revisionDigest: REVISION_DIGEST,
		});

		expect(validation.ok).toBe(false);
		expect(validation.receipt).toEqual({
			assignedReviewItemIds: [...REVIEW_ITEM_IDS],
			acceptedReviewItemIds: [],
			rejectedReviewItemIds: [...REVIEW_ITEM_IDS],
		});
	});

	test('reconstructs a shed receipt from active authenticated lane ownership', async () => {
		const input = await prepareValidationInput();
		const resultWithReceipt = dispatchInternals.appendPrReviewCollectionReceipt(
			input.record,
			input.result,
			{
				assignedReviewItemIds: [...REVIEW_ITEM_IDS],
				acceptedReviewItemIds: [],
				rejectedReviewItemIds: [...REVIEW_ITEM_IDS],
			},
		)!;
		const payload = parsePrReviewCollectionReceiptFooter(
			input.record,
			resultWithReceipt,
		)!;
		const shedResult = {
			...resultWithReceipt,
			text: encodePrReviewCollectionReceiptShedMarker(payload),
		};
		const receipts = await dispatchInternals.resolvePrReviewReceiptFallbacks(
			tempDir,
			SESSION_ID,
			[{ ...input.record, status: 'error', result: shedResult }],
		);

		expect(receipts.get(CORRELATION_ID)).toEqual({
			assignedReviewItemIds: [...REVIEW_ITEM_IDS],
			acceptedReviewItemIds: [],
			rejectedReviewItemIds: [...REVIEW_ITEM_IDS],
		});
	});

	test('does not trust a legacy completed record without an authenticated marker', async () => {
		const input = await prepareValidationInput();
		const receipts = await dispatchInternals.resolvePrReviewReceiptFallbacks(
			tempDir,
			SESSION_ID,
			[{ ...input.record, status: 'completed', result: input.result }],
		);

		expect(receipts.get(CORRELATION_ID)).toBeUndefined();
	});
});

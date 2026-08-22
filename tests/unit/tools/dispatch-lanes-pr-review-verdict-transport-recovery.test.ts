import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	PR_REVIEW_SCOPE,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalInternals = { ..._internals };
const originalGateInternals = {
	resolvePrWorkflowRevisionDigest:
		gateInternals.resolvePrWorkflowRevisionDigest,
	resolvePrWorkflowRevisionDigestDetailed:
		gateInternals.resolvePrWorkflowRevisionDigestDetailed,
};
const BASE_REVIEW_ITEM_IDS = [
	'C-0',
	'C-1',
	'C-2',
	'C-3',
	'C-4',
	'C-5',
] as const;

function assistantMessage(text: string) {
	return {
		info: {
			role: 'assistant',
			time: { completed: 2 },
			finish: 'stop',
		},
		parts: [{ type: 'text', text }],
	};
}

function baseOps(): Pick<
	SessionOps,
	'create' | 'prompt' | 'delete' | 'messages' | 'status'
> {
	return {
		create: mock(async () => ({ data: { id: 'unused' } })),
		prompt: mock(async () => ({ data: null })),
		delete: mock(async () => undefined),
		status: mock(async () => ({ data: {} })),
		messages: mock(async () => ({ data: [] })),
	};
}

async function recordCollectedLane(args: {
	batchId: string;
	laneId: string;
	mode: 'swarm-pr-review:reviewer' | 'swarm-pr-review:critic';
	workflowLane: string;
	role: 'reviewer' | 'critic';
}): Promise<string> {
	const correlationId = `${args.batchId}--${args.laneId}`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: args.batchId,
		normalizedAgent: args.role,
		swarmPrefixedAgent: args.role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: args.mode,
		workflowLane: args.workflowLane,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: PR_REVIEW_SCOPE,
		},
		promptHash: `${args.batchId}-hash`,
		generation: 1,
	});
	return correlationId;
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalGateInternals.resolvePrWorkflowRevisionDigest;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed =
		originalGateInternals.resolvePrWorkflowRevisionDigestDetailed;
	await teardownPrWorkflowGateFixtures();
});

describe('collect_lane_results — regression: PR-review verdict transport recovery persists dual provenance', () => {
	test('persists reviewer truncated-preview recovery and the gate still settles the batch', async () => {
		// Prior bug: truncated reviewer verdict artifacts settled later but collection never wrote durable recovery provenance.
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'reviewer-lane',
					workflowLane: 'reviewer-lane',
					reviewItemIds: [...BASE_REVIEW_ITEM_IDS],
				},
			],
			{ batchId: 'reviewer-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'reviewer-batch',
			laneId: 'reviewer-lane',
			mode: 'swarm-pr-review:reviewer',
			workflowLane: 'reviewer-lane',
			role: 'reviewer',
		});
		const text = BASE_REVIEW_ITEM_IDS.map(
			(itemId, index) =>
				`[REVIEWED] | ${itemId} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:${index + 1} | rationale ${itemId} | probe ${itemId} | reviewer notes ${itemId}`,
		)
			.join('\n')
			.concat(' ')
			.concat('x'.repeat(21_000));
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'reviewer-batch', wait: false },
			tempDir,
		);

		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('completed');
		expect(result.lane_results[0]?.output_truncated).toBe(true);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLanes,
		).toEqual(['reviewer-lane']);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toEqual([
			{
				workflowLane: 'reviewer-lane',
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lanes).toEqual([
			'reviewer-lane',
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lane_recoveries).toEqual([
			{
				workflow_lane: 'reviewer-lane',
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({
			mode: 'PR_REVIEW',
			sessionID: SESSION_ID,
		});
	});

	test('persists critic truncated-preview recovery and the gate still settles the batch', async () => {
		// Prior bug: critic verdict transport recovery was accepted by later gate semantics without collection-time durable disclosure.
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'seed-reviewer-lane',
					workflowLane: 'seed-reviewer-lane',
					reviewItemIds: [...BASE_REVIEW_ITEM_IDS],
				},
			],
			{ batchId: 'seed-reviewer-batch', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'seed-reviewer-batch',
			'swarm-pr-review:reviewer',
			[{ laneId: 'seed-reviewer-lane', workflowLane: 'seed-reviewer-lane' }],
			{
				textOverride: [
					'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer',
					...BASE_REVIEW_ITEM_IDS.slice(1).map(
						(itemId, index) =>
							`[REVIEWED] | ${itemId} | DISPROVED | STRUCTURALLY_PROVEN | NONE | NO | file.ts:${index + 2} | rationale ${itemId} | probe ${itemId} | reviewer`,
					),
				].join('\n'),
				scope: PR_REVIEW_SCOPE,
			},
		);
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-lane',
					workflowLane: 'critic-lane',
					reviewItemIds: ['C-0'],
				},
			],
			{ batchId: 'critic-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'critic-batch',
			laneId: 'critic-lane',
			mode: 'swarm-pr-review:critic',
			workflowLane: 'critic-lane',
			role: 'critic',
		});
		const text =
			`[CRITIC] | C-0 | UPHELD | HIGH | reason | required change ` +
			'x'.repeat(21_000);
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			tempDir,
		);

		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('completed');
		expect(result.lane_results[0]?.output_truncated).toBe(true);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLanes,
		).toEqual(['critic-lane']);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toEqual([
			{
				workflowLane: 'critic-lane',
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lanes).toEqual([
			'critic-lane',
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lane_recoveries).toEqual([
			{
				workflow_lane: 'critic-lane',
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({
			mode: 'PR_REVIEW',
			sessionID: SESSION_ID,
		});
	});

	test('reuses the collection revision digest for critic transport recovery without a second gate resolver call', async () => {
		// Prior bug: critic transport recovery re-entered the PR-review gate digest resolver even though collection had already proven artifact integrity against one revision digest.
		await establishReviewPrerequisites();
		let collectionDigestCalls = 0;
		_internals.resolvePrWorkflowRevisionDigestAsync = mock(async () => {
			collectionDigestCalls++;
			return REVISION_DIGEST;
		});
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'seed-reviewer-lane',
					workflowLane: 'seed-reviewer-lane',
					reviewItemIds: [...BASE_REVIEW_ITEM_IDS],
				},
			],
			{ batchId: 'seed-reviewer-batch', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'seed-reviewer-batch',
			'swarm-pr-review:reviewer',
			[{ laneId: 'seed-reviewer-lane', workflowLane: 'seed-reviewer-lane' }],
			{
				textOverride: [
					'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer',
					...BASE_REVIEW_ITEM_IDS.slice(1).map(
						(itemId, index) =>
							`[REVIEWED] | ${itemId} | DISPROVED | STRUCTURALLY_PROVEN | NONE | NO | file.ts:${index + 2} | rationale ${itemId} | probe ${itemId} | reviewer`,
					),
				].join('\n'),
				scope: PR_REVIEW_SCOPE,
			},
		);
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-lane',
					workflowLane: 'critic-lane',
					reviewItemIds: ['C-0'],
				},
			],
			{ batchId: 'critic-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'critic-batch',
			laneId: 'critic-lane',
			mode: 'swarm-pr-review:critic',
			workflowLane: 'critic-lane',
			role: 'critic',
		});
		gateInternals.resolvePrWorkflowRevisionDigest = () => {
			throw new Error('unexpected sync gate digest resolver call');
		};
		gateInternals.resolvePrWorkflowRevisionDigestDetailed = () => {
			throw new Error('unexpected detailed gate digest resolver call');
		};
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({
				data: [
					assistantMessage(
						`[CRITIC] | C-0 | UPHELD | HIGH | reason | required change ${'x'.repeat(21_000)}`,
					),
				],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			tempDir,
		);

		expect(collectionDigestCalls).toBe(1);
		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('completed');
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLanes,
		).toEqual(['critic-lane']);
	});

	test.each([
		{
			name: 'UPHELD changed severity',
			row: '[CRITIC] | C-0 | UPHELD | MEDIUM | reason | required change ',
			expected:
				'every assigned reviewer/critic item requires one parseable verdict row',
		},
		{
			name: 'DOWNGRADED no-op severity',
			row: '[CRITIC] | C-0 | DOWNGRADED | HIGH | reason | required change ',
			expected:
				'every assigned reviewer/critic item requires one parseable verdict row',
		},
	])('fails closed for critic transport recovery with $name', async ({
		row,
		expected,
	}) => {
		// Prior bug: transport recovery parsed critic rows without authoritative reviewer severity semantics, so stale/no-op verdicts slipped through collection.
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'seed-reviewer-lane',
					workflowLane: 'seed-reviewer-lane',
					reviewItemIds: [...BASE_REVIEW_ITEM_IDS],
				},
			],
			{ batchId: 'seed-reviewer-batch', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'seed-reviewer-batch',
			'swarm-pr-review:reviewer',
			[{ laneId: 'seed-reviewer-lane', workflowLane: 'seed-reviewer-lane' }],
			{
				textOverride: [
					'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale C-0 | probe C-0 | reviewer',
					...BASE_REVIEW_ITEM_IDS.slice(1).map(
						(itemId, index) =>
							`[REVIEWED] | ${itemId} | DISPROVED | STRUCTURALLY_PROVEN | NONE | NO | file.ts:${index + 2} | rationale ${itemId} | probe ${itemId} | reviewer`,
					),
				].join('\n'),
				scope: PR_REVIEW_SCOPE,
			},
		);
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-lane',
					workflowLane: 'critic-lane',
					reviewItemIds: ['C-0'],
				},
			],
			{ batchId: 'critic-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'critic-batch',
			laneId: 'critic-lane',
			mode: 'swarm-pr-review:critic',
			workflowLane: 'critic-lane',
			role: 'critic',
		});
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({
				data: [assistantMessage(`${row}${'x'.repeat(21_000)}`)],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			tempDir,
		);

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'PR_WORKFLOW_CONTRACT_INVALID',
		);
		expect(result.lane_results[0]?.error).toContain(expected);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toBeUndefined();
	});
});

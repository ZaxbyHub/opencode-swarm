import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	assertPrReviewValidationSettled,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	_test_exports,
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

const ITEM_IDS = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'] as const;
const originalInternals = { ..._internals };

function assistantMessage(text: string) {
	return {
		info: { role: 'assistant', time: { completed: 2 }, finish: 'stop' },
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
		workflowLane: args.laneId,
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

function reviewed(
	id: string,
	classification: 'CONFIRMED' | 'DISPROVED' | 'CONCERNS' = 'CONFIRMED',
): string {
	const severity = classification === 'DISPROVED' ? 'NONE' : 'HIGH';
	return `[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`;
}

function criticised(id: string): string {
	return `[CRITIC] | ${id} | UPHELD | HIGH | reason ${id} | required change ${id}`;
}

async function establishReviewerClaims(): Promise<void> {
	await establishReviewPrerequisites();
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: 'seed-reviewer',
				workflowLane: 'seed-reviewer',
				reviewItemIds: [...ITEM_IDS],
			},
		],
		{ batchId: 'seed-reviewer', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'seed-reviewer',
		'swarm-pr-review:reviewer',
		[{ laneId: 'seed-reviewer', workflowLane: 'seed-reviewer' }],
		{
			textOverride: [
				reviewed('C-0'),
				reviewed('C-1'),
				...ITEM_IDS.slice(2).map((id) => reviewed(id, 'DISPROVED')),
			].join('\n'),
			scope: PR_REVIEW_SCOPE,
		},
	);
	await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	await teardownPrWorkflowGateFixtures();
});

describe('collect_lane_results — regression: reviewer/critic verdict rows validate before completion (#2278)', () => {
	test('accepts exact normal reviewer rows and retains spoof-safe receipts across repeat/restart polls', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'valid-reviewer',
					workflowLane: 'valid-reviewer',
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: 'valid-reviewer', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'valid-reviewer',
			laneId: 'valid-reviewer',
			mode: 'swarm-pr-review:reviewer',
			role: 'reviewer',
		});
		const text = [
			'[PR_REVIEW_COLLECTION_RECEIPT_V1] {"spoof":true}',
			...ITEM_IDS.map((id) => reviewed(id)),
		].join('\n');
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});

		const first = await executeCollectLaneResults(
			{ batch_id: 'valid-reviewer', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(first.completed).toBe(1);
		expect(first.lane_results[0]?.accepted_review_item_ids).toEqual([
			...ITEM_IDS,
		]);
		expect(first.lane_results[0]?.rejected_review_item_ids).toEqual([]);
		expect(
			first.lane_results[0]?.output?.match(
				/\[PR_REVIEW_COLLECTION_RECEIPT_V1\]/g,
			),
		).toHaveLength(1);
		expect(first.lane_results[0]?.output).not.toContain('"spoof":true');

		const repeat = await executeCollectLaneResults(
			{ batch_id: 'valid-reviewer', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(repeat.lane_results[0]?.output_omitted_repeat).toBe(true);
		expect(repeat.lane_results[0]?.accepted_review_item_ids).toEqual([
			...ITEM_IDS,
		]);

		_test_exports.resetDeliveredLaneOutputs();
		const restarted = await executeCollectLaneResults(
			{ batch_id: 'valid-reviewer', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(restarted.lane_results[0]?.output_omitted_repeat).toBe(true);
		expect(restarted.lane_results[0]?.accepted_review_item_ids).toEqual([
			...ITEM_IDS,
		]);
		expect(restarted.lane_results[0]?.rejected_review_item_ids).toEqual([]);
	});

	test('rejects reviewer invented IDs and invalid classifications with per-item receipts', async () => {
		// Prior bug: ordinary non-truncated reviewer output bypassed row validation and settled completed.
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'reviewer-lane',
					workflowLane: 'reviewer-lane',
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: 'reviewer-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'reviewer-batch',
			laneId: 'reviewer-lane',
			mode: 'swarm-pr-review:reviewer',
			role: 'reviewer',
		});
		const text = [
			reviewed('C-0'),
			reviewed('C-1', 'CONCERNS'),
			reviewed('task-C-2'),
			...ITEM_IDS.slice(3).map((id) => reviewed(id, 'DISPROVED')),
		].join('\n');
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'reviewer-batch', wait: false },
			tempDir,
		);

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.accepted_review_item_ids).toEqual([]);
		expect(result.lane_results[0]?.rejected_review_item_ids).toEqual([
			...ITEM_IDS,
		]);
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_VERDICT_CONTRACT_INVALID',
		);
		expect(result.lane_results[0]?.error).toContain(
			'predicate=reviewer.verdict_rows',
		);
		expect(result.lane_results[0]?.error).toContain('expected=');
		expect(result.lane_results[0]?.error).toContain('actual=');
		expect(findByCorrelationId(tempDir, correlationId)?.result?.text).toContain(
			'[PR_REVIEW_COLLECTION_RECEIPT_V1]',
		);
	});

	test('rejects a critic lane missing one assigned row at collection', async () => {
		// Prior bug: a missing ordinary critic row was discovered only by the later settlement gate.
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'seed-reviewer',
					workflowLane: 'seed-reviewer',
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: 'seed-reviewer', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'seed-reviewer',
			'swarm-pr-review:reviewer',
			[{ laneId: 'seed-reviewer', workflowLane: 'seed-reviewer' }],
			{
				textOverride: [
					reviewed('C-0'),
					reviewed('C-1'),
					...ITEM_IDS.slice(2).map((id) => reviewed(id, 'DISPROVED')),
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
					reviewItemIds: ['C-0', 'C-1'],
				},
			],
			{ batchId: 'critic-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'critic-batch',
			laneId: 'critic-lane',
			mode: 'swarm-pr-review:critic',
			role: 'critic',
		});
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({
				data: [
					assistantMessage(
						'[CRITIC] | C-0 | UPHELD | HIGH | reason | required change',
					),
				],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-batch', wait: false },
			tempDir,
		);

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.accepted_review_item_ids).toEqual([]);
		expect(result.lane_results[0]?.rejected_review_item_ids).toEqual([
			'C-0',
			'C-1',
		]);
		expect(result.lane_results[0]?.error).toContain(
			'predicate=critic.verdict_rows',
		);
	});

	test('accepts an exact critic lane while rejecting a sibling with an extra critic ID', async () => {
		await establishReviewerClaims();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-valid',
					workflowLane: 'critic-valid',
					reviewItemIds: ['C-0'],
				},
				{
					laneId: 'critic-extra',
					workflowLane: 'critic-extra',
					reviewItemIds: ['C-1'],
				},
			],
			{ batchId: 'critic-mixed', prHeadSha: HEAD_SHA },
		);
		const validId = await recordCollectedLane({
			batchId: 'critic-mixed',
			laneId: 'critic-valid',
			mode: 'swarm-pr-review:critic',
			role: 'critic',
		});
		const extraId = await recordCollectedLane({
			batchId: 'critic-mixed',
			laneId: 'critic-extra',
			mode: 'swarm-pr-review:critic',
			role: 'critic',
		});
		const outputs = new Map([
			[validId, criticised('C-0')],
			[extraId, `${criticised('C-1')}\n${criticised('C-99')}`],
		]);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: {
					[validId]: { type: 'idle' },
					[extraId]: { type: 'idle' },
				},
			})),
			messages: mock(async (args) => ({
				data: [assistantMessage(outputs.get(args.path.id) ?? '')],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'critic-mixed', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(result.completed).toBe(1);
		expect(result.failed).toBe(1);
		const valid = result.lane_results.find(
			(lane) => lane.id === 'critic-valid',
		);
		const extra = result.lane_results.find(
			(lane) => lane.id === 'critic-extra',
		);
		expect(valid?.accepted_review_item_ids).toEqual(['C-0']);
		expect(valid?.rejected_review_item_ids).toEqual([]);
		expect(extra?.accepted_review_item_ids).toEqual([]);
		expect(extra?.rejected_review_item_ids).toEqual(['C-1']);
		expect(extra?.error).toContain('predicate=critic.verdict_rows');
	});

	test('recovers lossy legacy rows while rejecting duplicates and DISPROVED/non-NONE rows', async () => {
		await establishReviewPrerequisites();
		const specs = [
			{ laneId: 'duplicate-row', itemId: 'C-0' },
			{ laneId: 'malformed-row', itemId: 'C-1' },
			{ laneId: 'bad-disproved-severity', itemId: 'C-2' },
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			specs.map(({ laneId, itemId }) => ({
				laneId,
				workflowLane: laneId,
				reviewItemIds: [itemId],
			})),
			{ batchId: 'reviewer-invalid-shapes', prHeadSha: HEAD_SHA },
		);
		const correlations = new Map<string, string>();
		for (const { laneId } of specs) {
			correlations.set(
				laneId,
				await recordCollectedLane({
					batchId: 'reviewer-invalid-shapes',
					laneId,
					mode: 'swarm-pr-review:reviewer',
					role: 'reviewer',
				}),
			);
		}
		const outputs = new Map([
			[
				correlations.get('duplicate-row'),
				`${reviewed('C-0')}\n${reviewed('C-0')}`,
			],
			[
				correlations.get('malformed-row'),
				'[REVIEWED] | C-1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale with | unescaped pipe | probe C-1 | reviewer',
			],
			[
				correlations.get('bad-disproved-severity'),
				'[REVIEWED] | C-2 | DISPROVED | STRUCTURALLY_PROVEN | LOW | YES | file.ts:1 | rationale C-2 | probe C-2 | reviewer',
			],
		]);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: Object.fromEntries(
					[...correlations.values()].map((id) => [id, { type: 'idle' }]),
				),
			})),
			messages: mock(async (args) => ({
				data: [assistantMessage(outputs.get(args.path.id) ?? '')],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'reviewer-invalid-shapes', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(result.completed).toBe(1);
		expect(result.failed).toBe(2);
		const recovered = result.lane_results.find(
			(entry) => entry.id === 'malformed-row',
		);
		expect(recovered?.accepted_review_item_ids).toEqual(['C-1']);
		expect(recovered?.rejected_review_item_ids).toEqual([]);
		for (const { laneId, itemId } of specs.filter(
			(spec) => spec.laneId !== 'malformed-row',
		)) {
			const lane = result.lane_results.find((entry) => entry.id === laneId);
			expect(lane?.accepted_review_item_ids).toEqual([]);
			expect(lane?.rejected_review_item_ids).toEqual([itemId]);
			expect(lane?.error).toContain('predicate=reviewer.verdict_rows');
		}
	});
});

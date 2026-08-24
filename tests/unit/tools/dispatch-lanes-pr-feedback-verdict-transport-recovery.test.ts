import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	assertPrFeedbackGatePhaseSettled,
	assertPrFeedbackVerificationSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	type PrFeedbackGatePhase,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import {
	HEAD_SHA,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalInternals = { ..._internals };
const ITEM_IDS = ['FB-001', 'FB-002'] as const;

type FeedbackModeCase =
	| {
			name: 'verification';
			mode: 'swarm-pr-feedback:verification';
			workflowLane: 'verification-lane';
			role: 'reviewer';
			marker: '[FEEDBACK-VERIFIED]';
			verdict: 'CONFIRMED';
	  }
	| {
			name:
				| 'stage-b-reviewer'
				| 'stage-b-test'
				| 'closeout-reviewer'
				| 'closeout-critic';
			mode:
				| 'swarm-pr-feedback:stage-b-reviewer'
				| 'swarm-pr-feedback:stage-b-test'
				| 'swarm-pr-feedback:closeout-reviewer'
				| 'swarm-pr-feedback:closeout-critic';
			workflowLane: PrFeedbackGatePhase;
			role: 'reviewer' | 'test_engineer' | 'critic';
			marker:
				| '[STAGE-B-REVIEW]'
				| '[STAGE-B-TEST]'
				| '[CLOSEOUT-REVIEW]'
				| '[CLOSEOUT-CRITIC]';
			verdict: 'APPROVE' | 'PASS';
	  };

const FEEDBACK_CASES: readonly FeedbackModeCase[] = [
	{
		name: 'verification',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verification-lane',
		role: 'reviewer',
		marker: '[FEEDBACK-VERIFIED]',
		verdict: 'CONFIRMED',
	},
	{
		name: 'stage-b-reviewer',
		mode: 'swarm-pr-feedback:stage-b-reviewer',
		workflowLane: 'stage-b-reviewer',
		role: 'reviewer',
		marker: '[STAGE-B-REVIEW]',
		verdict: 'APPROVE',
	},
	{
		name: 'stage-b-test',
		mode: 'swarm-pr-feedback:stage-b-test',
		workflowLane: 'stage-b-test',
		role: 'test_engineer',
		marker: '[STAGE-B-TEST]',
		verdict: 'PASS',
	},
	{
		name: 'closeout-reviewer',
		mode: 'swarm-pr-feedback:closeout-reviewer',
		workflowLane: 'closeout-reviewer',
		role: 'reviewer',
		marker: '[CLOSEOUT-REVIEW]',
		verdict: 'APPROVE',
	},
	{
		name: 'closeout-critic',
		mode: 'swarm-pr-feedback:closeout-critic',
		workflowLane: 'closeout-critic',
		role: 'critic',
		marker: '[CLOSEOUT-CRITIC]',
		verdict: 'APPROVE',
	},
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

async function prepareFeedbackWorkflow(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
	await declarePrFeedbackInventory(tempDir, SESSION_ID, [...ITEM_IDS], {
		prHeadSha: HEAD_SHA,
	});
}

async function persistFeedbackArtifact(args: {
	batchId: string;
	laneId: string;
	mode: string;
	workflowLane: string;
	role: string;
	text: string;
}): Promise<void> {
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
			dirtyHash: REVISION_DIGEST,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
		promptHash: `${args.batchId}-seed-hash`,
		generation: 1,
	});
	const stored = storeLaneOutput(tempDir, {
		batchId: args.batchId,
		laneId: args.laneId,
		agent: args.role,
		role: args.role,
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: args.mode,
		workflowLane: args.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text: args.text,
	});
	await appendDelegationTransition(tempDir, correlationId, {
		status: 'completed',
		result: {
			text: args.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

async function seedVerificationAndStageA(): Promise<void> {
	await enforcePrFeedbackVerificationOwnership(
		tempDir,
		SESSION_ID,
		[{ laneId: 'seed-verify-lane', ownedItemIds: [...ITEM_IDS] }],
		{ batchId: 'seed-verify-batch', prHeadSha: HEAD_SHA },
	);
	await persistFeedbackArtifact({
		batchId: 'seed-verify-batch',
		laneId: 'seed-verify-lane',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'seed-verify-lane',
		role: 'reviewer',
		text: ITEM_IDS.map(
			(itemId) =>
				`[FEEDBACK-VERIFIED] | ${itemId} | CONFIRMED | evidence ${itemId}`,
		).join('\n'),
	});
	await assertPrFeedbackVerificationSettled(tempDir, SESSION_ID);
	await recordPrFeedbackStageA(tempDir, SESSION_ID, REVISION_DIGEST, [
		{
			category: 'diff-check',
			command: ['git', 'diff', '--check'],
			durationMs: 1,
		},
		{
			category: 'reproduction',
			command: ['test', 'feedback'],
			targets: ['feedback'],
			feedbackTargets: ITEM_IDS.map((itemId) => ({
				feedbackItemId: itemId,
				target: 'feedback',
				expectedBehavior: `fixed ${itemId}`,
			})),
			durationMs: 1,
		},
	]);
}

async function settleGatePhasePrerequisites(
	target: Extract<
		FeedbackModeCase,
		{ name: Exclude<FeedbackModeCase['name'], 'verification'> }
	>,
): Promise<void> {
	const phaseOrder = FEEDBACK_CASES.filter(
		(
			entry,
		): entry is Extract<
			FeedbackModeCase,
			{ workflowLane: PrFeedbackGatePhase }
		> => entry.name !== 'verification',
	);
	const targetIndex = phaseOrder.findIndex(
		(entry) => entry.name === target.name,
	);
	for (const entry of phaseOrder.slice(0, targetIndex)) {
		await recordPrFeedbackGateBatch(
			tempDir,
			SESSION_ID,
			entry.workflowLane,
			{ laneId: `${entry.name}-seed-lane`, ownedItemIds: [...ITEM_IDS] },
			{
				batchId: `${entry.name}-seed-batch`,
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION_DIGEST,
			},
		);
		await persistFeedbackArtifact({
			batchId: `${entry.name}-seed-batch`,
			laneId: `${entry.name}-seed-lane`,
			mode: entry.mode,
			workflowLane: entry.workflowLane,
			role: entry.role,
			text: ITEM_IDS.map(
				(itemId) =>
					`${entry.marker} | ${itemId} | ${entry.verdict} | evidence ${itemId}`,
			).join('\n'),
		});
		await assertPrFeedbackGatePhaseSettled(
			tempDir,
			SESSION_ID,
			entry.workflowLane,
		);
	}
}

async function declareCollectedBatch(
	entry: FeedbackModeCase,
	batchId: string,
	laneId: string,
): Promise<string> {
	const workflowLane =
		entry.name === 'verification' ? laneId : entry.workflowLane;
	if (entry.name === 'verification') {
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId, ownedItemIds: [...ITEM_IDS] }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
	} else {
		await recordPrFeedbackGateBatch(
			tempDir,
			SESSION_ID,
			entry.workflowLane,
			{ laneId, ownedItemIds: [...ITEM_IDS] },
			{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION_DIGEST },
		);
	}
	const correlationId = `${batchId}--${laneId}`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: batchId,
		normalizedAgent: entry.role,
		swarmPrefixedAgent: entry.role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: entry.mode,
		workflowLane,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: REVISION_DIGEST,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
		promptHash: `${batchId}-collect-hash`,
		generation: 1,
	});
	return correlationId;
}

function buildTruncatedArtifactText(
	entry: FeedbackModeCase,
	itemIds: readonly string[],
): string {
	const rows = itemIds.map(
		(itemId) =>
			`${entry.marker} | ${itemId} | ${entry.verdict} | evidence ${itemId}`,
	);
	rows[rows.length - 1] = `${rows[rows.length - 1]} ${'x'.repeat(21_000)}`;
	return rows.join('\n');
}

async function assertSettled(entry: FeedbackModeCase): Promise<void> {
	if (entry.name === 'verification') {
		await expect(
			assertPrFeedbackVerificationSettled(tempDir, SESSION_ID),
		).resolves.toMatchObject({
			mode: 'PR_FEEDBACK',
			sessionID: SESSION_ID,
		});
		return;
	}
	await expect(
		assertPrFeedbackGatePhaseSettled(tempDir, SESSION_ID, entry.workflowLane),
	).resolves.toMatchObject({
		mode: 'PR_FEEDBACK',
		sessionID: SESSION_ID,
	});
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

describe('collect_lane_results — regression: PR-feedback verdict transport recovery persists dual provenance', () => {
	test.each(
		FEEDBACK_CASES,
	)('persists exact-row truncated-preview recovery for $name', async (entry) => {
		// Prior bug: feedback verification and ordered gates accepted durable recovered rows later, but collection omitted the dual recovery disclosure.
		await prepareFeedbackWorkflow();
		if (entry.name !== 'verification') {
			await seedVerificationAndStageA();
			await settleGatePhasePrerequisites(entry);
		}
		const batchId = `${entry.name}-collect-batch`;
		const laneId = `${entry.name}-collect-lane`;
		const expectedWorkflowLane =
			entry.name === 'verification' ? laneId : entry.workflowLane;
		const correlationId = await declareCollectedBatch(entry, batchId, laneId);
		const text = buildTruncatedArtifactText(entry, ITEM_IDS);
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			tempDir,
		);

		expect(result.completed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('completed');
		expect(result.lane_results[0]?.output_truncated).toBe(true);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLanes,
		).toEqual([expectedWorkflowLane]);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toEqual([
			{
				workflowLane: expectedWorkflowLane,
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lanes).toEqual([
			expectedWorkflowLane,
		]);
		expect(result.lane_results[0]?.salvaged_workflow_lane_recoveries).toEqual([
			{
				workflow_lane: expectedWorkflowLane,
				kind: 'truncated-preview-durable-artifact',
				reason:
					'inline preview truncated; durable artifact retained exact coverage',
			},
		]);
		await assertSettled(entry);
	});

	test.each(
		FEEDBACK_CASES,
	)('fails closed for missing assigned durable rows in $name', async (entry) => {
		// Prior bug: feedback transport recovery had no collection-time exact-row proof, so malformed durable rows could ride through until a later gate.
		await prepareFeedbackWorkflow();
		if (entry.name !== 'verification') {
			await seedVerificationAndStageA();
			await settleGatePhasePrerequisites(entry);
		}
		const batchId = `${entry.name}-invalid-batch`;
		const laneId = `${entry.name}-invalid-lane`;
		const correlationId = await declareCollectedBatch(entry, batchId, laneId);
		const text = buildTruncatedArtifactText(entry, ITEM_IDS.slice(0, 1));
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: batchId, wait: false },
			tempDir,
		);

		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.status).toBe('failed');
		expect(result.lane_results[0]?.error).toContain(
			'PR_WORKFLOW_CONTRACT_INVALID',
		);
		expect(result.lane_results[0]?.error).toMatch(/requires one exact/i);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLanes,
		).toBeUndefined();
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toBeUndefined();
	});
});

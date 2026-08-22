import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	assertPrFeedbackVerificationSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
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

async function seedStageA(): Promise<void> {
	await enforcePrFeedbackVerificationOwnership(
		tempDir,
		SESSION_ID,
		[{ laneId: 'seed-verify-lane', ownedItemIds: [...ITEM_IDS] }],
		{ batchId: 'seed-verify-batch', prHeadSha: HEAD_SHA },
	);
	const correlationId = 'seed-verify-batch--seed-verify-lane';
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: 'seed-verify-batch',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'seed-verify-batch',
		laneId: 'seed-verify-lane',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'seed-verify-lane',
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: REVISION_DIGEST,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
		promptHash: 'seed-verify-hash',
		generation: 1,
	});
	const verificationText = ITEM_IDS.map(
		(itemId) =>
			`[FEEDBACK-VERIFIED] | ${itemId} | CONFIRMED | evidence ${itemId}`,
	).join('\n');
	const stored = storeLaneOutput(tempDir, {
		batchId: 'seed-verify-batch',
		laneId: 'seed-verify-lane',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'seed-verify-lane',
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text: verificationText,
	});
	await appendDelegationTransition(tempDir, correlationId, {
		status: 'completed',
		result: {
			text: verificationText,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
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

async function recordCollectedLane(args: {
	batchId: string;
	laneId: string;
	mode: 'swarm-pr-feedback:verification' | 'swarm-pr-feedback:stage-b-reviewer';
	workflowLane: string;
	role: 'reviewer';
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
			dirtyHash: REVISION_DIGEST,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
		promptHash: `${args.batchId}-collect-hash`,
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
	await teardownPrWorkflowGateFixtures();
});

describe('collect_lane_results — regression: PR-feedback transport recovery binds workflow lanes exactly', () => {
	test('fails closed when verification recovery forges a non-canonical workflow lane', async () => {
		// Prior bug: verification recovery only matched lane ownership by laneId, so a forged workflow_lane bypassed the canonical laneId binding.
		await prepareFeedbackWorkflow();
		const batchId = 'verification-batch';
		const laneId = 'verification-lane-id';
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId, ownedItemIds: [...ITEM_IDS] }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId,
			laneId,
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'forged-verification-lane',
			role: 'reviewer',
		});
		const text = `${ITEM_IDS.map(
			(itemId) =>
				`[FEEDBACK-VERIFIED] | ${itemId} | CONFIRMED | evidence ${itemId}`,
		).join('\n')} ${'x'.repeat(21_000)}`;
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
			'no matching declared PR_FEEDBACK verification ownership',
		);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toBeUndefined();
	});

	test('fails closed when ordered recovery forges a workflow lane outside the declared phase', async () => {
		// Prior bug: ordered PR-feedback recovery trusted mode + batch + laneId alone, so a forged workflow_lane could misstate the durable provenance.
		await prepareFeedbackWorkflow();
		await seedStageA();
		const batchId = 'stage-b-reviewer-batch';
		const laneId = 'stage-b-reviewer-lane';
		await recordPrFeedbackGateBatch(
			tempDir,
			SESSION_ID,
			'stage-b-reviewer',
			{ laneId, ownedItemIds: [...ITEM_IDS] },
			{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION_DIGEST },
		);
		const correlationId = await recordCollectedLane({
			batchId,
			laneId,
			mode: 'swarm-pr-feedback:stage-b-reviewer',
			workflowLane: 'closeout-reviewer',
			role: 'reviewer',
		});
		const text = `${ITEM_IDS.map(
			(itemId) => `[STAGE-B-REVIEW] | ${itemId} | APPROVE | evidence ${itemId}`,
		).join('\n')} ${'x'.repeat(21_000)}`;
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
			'no matching declared ordered PR_FEEDBACK lane provenance',
		);
		expect(
			findByCorrelationId(tempDir, correlationId)?.result
				?.salvagedWorkflowLaneRecoveries,
		).toBeUndefined();
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	activatePrWorkflow,
	assertPrFeedbackVerificationSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
	type PrFeedbackLaneOwnership,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('pr-workflow-gate feedback verification', () => {
	test('PR_FEEDBACK verification requires a declared inventory and exact non-overlapping ownership', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');

		const ownership: PrFeedbackLaneOwnership[] = [
			{ laneId: 'lane-a', ownedItemIds: ['FB-001', 'FB-002'] },
			{ laneId: 'lane-b', ownedItemIds: ['CI-001'] },
		];

		await expect(
			enforcePrFeedbackVerificationOwnership(tempDir, SESSION_ID, ownership, {
				batchId: 'before-inventory',
				prHeadSha: HEAD_SHA,
			}),
		).rejects.toThrow('requires a declared feedback inventory');

		await declarePrFeedbackInventory(
			tempDir,
			SESSION_ID,
			['FB-001', 'FB-002', 'CI-001'],
			{ prHeadSha: HEAD_SHA },
		);

		const state = await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			ownership,
			{ batchId: 'verify-1', prHeadSha: HEAD_SHA },
		);
		expect(state.prFeedbackInventory).toEqual(['CI-001', 'FB-001', 'FB-002']);
		expect(state.prFeedbackVerification).toEqual({
			batchId: 'verify-1',
			ownership,
			validatedAt: expect.any(String),
		});
	});

	test('PR_FEEDBACK permits direct coder tasks only after exact verification settles', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-001'], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId: 'verify-coder', ownedItemIds: ['FB-001'] }],
			{ batchId: 'feedback-coder-ready', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'feedback-coder-ready',
			'swarm-pr-feedback:verification',
			[{ laneId: 'verify-coder', workflowLane: 'verify-coder' }],
			{
				textOverride: '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence',
			},
		);

		for (const [toolName, args] of [
			['Task', { subagent_type: 'paid_coder' }],
			['run_agent', { agent: 'paid_coder' }],
			['run_agent', { subagent_type: 'paid_coder', agent: 'paid_coder' }],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, SESSION_ID, toolName, args, [
					'paid_coder',
				]),
			).resolves.toBeUndefined();
		}
		await expect(
			enforcePrWorkflowToolBefore(
				tempDir,
				SESSION_ID,
				'run_agent',
				{ subagent_type: 'paid_coder', agent: 'reviewer' },
				['paid_coder'],
			),
		).rejects.toThrow('structured dispatch_lanes_async');
		for (const [toolName, args] of [
			['Task', { subagent_type: 'paid_coder', agent: '' }],
			['Task', { subagent_type: 'paid_coder', agent: null }],
			['run_agent', { agent: 42, subagent_type: 'paid_coder' }],
			['run_agent', {}],
		] as const) {
			await expect(
				enforcePrWorkflowToolBefore(tempDir, SESSION_ID, toolName, args, [
					'paid_coder',
				]),
			).rejects.toThrow('structured dispatch_lanes_async');
		}
	});

	test('PR_FEEDBACK verification rejects overlapping and incomplete ownership', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(
			tempDir,
			SESSION_ID,
			['FB-001', 'FB-002', 'FB-003'],
			{ prHeadSha: HEAD_SHA },
		);

		await expect(
			enforcePrFeedbackVerificationOwnership(
				tempDir,
				SESSION_ID,
				[
					{ laneId: 'lane-a', ownedItemIds: ['FB-001', 'FB-002'] },
					{ laneId: 'lane-b', ownedItemIds: ['FB-002', 'FB-003'] },
				],
				{ batchId: 'overlap', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('owned by both "lane-a" and "lane-b"');

		await expect(
			enforcePrFeedbackVerificationOwnership(
				tempDir,
				SESSION_ID,
				[
					{ laneId: 'lane-a', ownedItemIds: ['FB-001'] },
					{ laneId: 'lane-b', ownedItemIds: ['FB-002'] },
				],
				{ batchId: 'partial', prHeadSha: HEAD_SHA },
			),
		).resolves.toMatchObject({ prFeedbackVerifications: expect.any(Array) });
	});

	test('PR_FEEDBACK inventory is immutable and sequential batches require successful exact union', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(
			tempDir,
			SESSION_ID,
			['FB-002', 'FB-001'],
			{ prHeadSha: HEAD_SHA },
		);
		await expect(
			declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-001'], {
				prHeadSha: HEAD_SHA,
			}),
		).rejects.toThrow('inventory is immutable');

		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId: 'verify-a', ownedItemIds: ['FB-001'] }],
			{ batchId: 'feedback-a', prHeadSha: HEAD_SHA },
		);
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId: 'verify-b', ownedItemIds: ['FB-002'] }],
			{ batchId: 'feedback-b', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'feedback-a',
			'swarm-pr-feedback:verification',
			[{ laneId: 'verify-a', workflowLane: 'verify-a' }],
			{
				textOverride: '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence',
			},
		);
		await persistBatch(
			'feedback-b',
			'swarm-pr-feedback:verification',
			[{ laneId: 'verify-b', workflowLane: 'verify-b' }],
			{ head: 'wrong-head' },
		);
		await expect(
			assertPrFeedbackVerificationSettled(tempDir, SESSION_ID),
		).rejects.toThrow('missing inventory items: FB-002');
	});

	test('PR_FEEDBACK verification rejects duplicate item rows', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-001'], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
			{ batchId: 'duplicate-feedback', prHeadSha: HEAD_SHA },
		);
		const row = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';
		await persistBatch(
			'duplicate-feedback',
			'swarm-pr-feedback:verification',
			[{ laneId: 'verify', workflowLane: 'verify' }],
			{ textOverride: `${row}\n${row}` },
		);
		await expect(
			assertPrFeedbackVerificationSettled(tempDir, SESSION_ID),
		).rejects.toThrow('missing inventory items: FB-001');
	});

	test('PR_FEEDBACK verification rejects unknown classification enums', async () => {
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(tempDir, SESSION_ID, ['FB-001'], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
			{ batchId: 'invalid-feedback-enum', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'invalid-feedback-enum',
			'swarm-pr-feedback:verification',
			[{ laneId: 'verify', workflowLane: 'verify' }],
			{ textOverride: '[FEEDBACK-VERIFIED] | FB-001 | BANANA | evidence' },
		);
		await expect(
			assertPrFeedbackVerificationSettled(tempDir, SESSION_ID),
		).rejects.toThrow('missing inventory items: FB-001');
	});
});

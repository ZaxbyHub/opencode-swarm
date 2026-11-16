/**
 * AC3 (verdict-lane failure-class typing — scope preservation): the new
 * 'verdict_contract' failure class is scoped to swarm-pr-review reviewer/critic
 * verdict lanes ONLY.
 *
 * Contract for both ends: GREEN at base and head.
 * (a) A swarm-pr-feedback:verification lane failing collection validation
 *     keeps NO verdict_contract class — it still fails with the generic
 *     PR_WORKFLOW_CONTRACT_INVALID code, exactly as today.
 * (b) A base/micro discovery contract failure keeps its existing
 *     `workflowLaneFailureClass: 'contract'` stamp.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import {
	HEAD_SHA,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const FEEDBACK_ITEM_IDS = ['FB-001', 'FB-002'] as const;
const originalInternals = { ..._internals };
let discoveryDir = '';

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

/** Bounded hang-guard for the budgeted discovery collection call. */
async function withTestDeadline<T>(promise: Promise<T>): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error('test deadline exceeded')),
					5_000,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
	discoveryDir = canonicalMkdtemp('ac3-discovery-contract-');
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	await teardownPrWorkflowGateFixtures();
	fs.rmSync(discoveryDir, { recursive: true, force: true });
});

describe('collect_lane_results — failure-class scope preservation (AC3)', () => {
	test('a swarm-pr-feedback:verification validation failure is never typed verdict_contract', async () => {
		// Same shape as the PR-feedback transport-recovery fail-closed suite: a
		// declared verification lane whose truncated durable artifact covers only
		// one of its two assigned feedback items.
		const batchId = 'ac3-verify-batch';
		const laneId = 'ac3-verify-lane';
		await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(
			tempDir,
			SESSION_ID,
			[...FEEDBACK_ITEM_IDS],
			{ prHeadSha: HEAD_SHA },
		);
		await enforcePrFeedbackVerificationOwnership(
			tempDir,
			SESSION_ID,
			[{ laneId, ownedItemIds: [...FEEDBACK_ITEM_IDS] }],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		const correlationId = `${batchId}--${laneId}`;
		await recordPendingDelegation(tempDir, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: SESSION_ID,
			callID: batchId,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId,
			mode: 'swarm-pr-feedback:verification',
			workflowLane: laneId,
			workspace: {
				directory: tempDir,
				gitHead: HEAD_SHA,
				dirtyHash: REVISION_DIGEST,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
			promptHash: `${batchId}-hash`,
			generation: 1,
		});
		// One valid row for FB-001 only, padded past the preview budget so the
		// truncated-preview recovery branch engages and then fails closed for the
		// missing FB-002 row.
		const text = `[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence FB-001 ${'x'.repeat(21_000)}`;
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

		// Green at base: the feedback lane fails with the generic workflow
		// contract code, exactly as today.
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.error).toContain(
			'PR_WORKFLOW_CONTRACT_INVALID',
		);
		const record = findByCorrelationId(tempDir, correlationId);
		expect(record?.status).toBe('error');

		// PRESERVING assertion (green at base and head): the new class is scoped
		// to PR-review reviewer/critic verdict lanes only — a PR-feedback
		// validation failure must never be typed verdict_contract.
		expect(record?.result?.workflowLaneFailureClass).not.toBe(
			'verdict_contract',
		);
	});

	test('a base discovery contract failure keeps its contract class', async () => {
		// Same shape as the collect host-timeout suite: a base-mode lane with
		// terminal assistant proof whose output carries no discovery rows at all.
		const batchId = 'ac3-discovery-batch';
		const correlationId = `${batchId}-session`;
		await recordPendingDelegation(discoveryDir, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: `${batchId}-parent`,
			callID: batchId,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId: `${batchId}-lane`,
			mode: 'swarm-pr-review:base',
			workflowLane: 'correctness-state',
			prReviewLegacyTranscriptCompatibility: true,
			workspace: {
				directory: discoveryDir,
				gitHead: 'head-1',
				dirtyHash: null,
				prHeadSha: 'head-1',
				scope: 'complete PR diff base-1...head-1',
			},
			promptHash: `${batchId}-hash`,
			generation: 1,
		});
		_internals.getSessionOps = () => ({
			...baseOps(),
			messages: mock(async () => ({
				data: [assistantMessage('plain prose with no review contract rows')],
			})),
		});

		const result = await withTestDeadline(
			executeCollectLaneResults(
				{
					batch_id: batchId,
					wait: false,
					include_pending: true,
					timeout_ms: 90,
				},
				discoveryDir,
			),
		);

		// Green at base: the discovery lane settles as a contract violation with
		// its existing typed class.
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_DISCOVERY_CONTRACT_INVALID',
		);
		const record = findByCorrelationId(discoveryDir, correlationId);
		expect(record?.status).toBe('error');
		expect(record?.result?.error).toContain(
			'PR_REVIEW_DISCOVERY_CONTRACT_INVALID',
		);
		// PRESERVING assertion (green at base and head): the discovery-lane
		// contract stamp is unchanged by the verdict-class scoping.
		expect(record?.result?.workflowLaneFailureClass).toBe('contract');
	});
});

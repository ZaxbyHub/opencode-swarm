/**
 * AC1 (verdict-lane failure-class typing): a swarm-pr-review:reviewer lane
 * whose collected output fails the collection validation must settle as an
 * error that carries a typed `workflowLaneFailureClass: 'verdict_contract'`
 * — for BOTH the verdict-row contract predicate (PR_REVIEW_VERDICT_CONTRACT_
 * INVALID) and any non-verdict predicate the transport-recovery validator
 * fails on (PR_WORKFLOW_CONTRACT_INVALID, e.g. result.transcript_incomplete).
 *
 * Contract for both ends: RED at base, GREEN after the fix. At base the
 * `!validation.ok` branch in settleCollectedLane stamps the error code only —
 * no workflowLaneFailureClass — so the class assertions below receive
 * `undefined`. After the fix, reviewer/critic verdict-lane contract failures
 * are typed 'verdict_contract'.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { recordPrReviewValidationBatch } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executeCollectLaneResults,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	PR_REVIEW_SCOPE,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const ITEM_IDS = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'] as const;
const originalInternals = { ..._internals };

function assistantMessage(text: string, finish = 'stop') {
	return {
		info: { role: 'assistant', time: { completed: 2 }, finish },
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
}): Promise<string> {
	const correlationId = `${args.batchId}--${args.laneId}`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: args.batchId,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: 'swarm-pr-review:reviewer',
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
	classification: 'CONFIRMED' | 'DISPROVED' = 'CONFIRMED',
): string {
	const severity = classification === 'DISPROVED' ? 'NONE' : 'HIGH';
	return `[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`;
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

describe('collect_lane_results — verdict-lane contract failures carry the verdict_contract class (AC1)', () => {
	test('a reviewer lane with an invented row id settles error with class verdict_contract', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'reviewer-invented',
					workflowLane: 'reviewer-invented',
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: 'ac1-invented-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'ac1-invented-batch',
			laneId: 'reviewer-invented',
		});
		// One invented id ("task-C-2") — the same verdict-row violation shape the
		// #2278 regression suite drives, now asserting the durable class.
		const text = [
			reviewed('C-0'),
			reviewed('C-1'),
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
			{ batch_id: 'ac1-invented-batch', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		// Harness proof (green at base): the verdict-row contract failure
		// settles as an error with the verdict error code.
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.error).toContain(
			'PR_REVIEW_VERDICT_CONTRACT_INVALID',
		);
		const record = findByCorrelationId(tempDir, correlationId);
		expect(record?.status).toBe('error');
		expect(record?.result?.error).toContain(
			'PR_REVIEW_VERDICT_CONTRACT_INVALID',
		);

		// DISCRIMINATING assertion (red at base: undefined): the settled result
		// is typed as a verdict-contract failure.
		expect(record?.result?.workflowLaneFailureClass).toBe('verdict_contract');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'verdict_contract',
		);
	});

	test('a reviewer lane failing a non-verdict predicate still carries class verdict_contract', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'reviewer-incomplete',
					workflowLane: 'reviewer-incomplete',
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: 'ac1-incomplete-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedLane({
			batchId: 'ac1-incomplete-batch',
			laneId: 'reviewer-incomplete',
		});
		// finish: 'length' marks the transcript incomplete; the transport
		// validator rejects it via the result.transcript_incomplete predicate —
		// a NON-verdict-row predicate that still fails a reviewer lane's
		// collection contract.
		const text = ITEM_IDS.map((id) => reviewed(id)).join('\n');
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({
				data: [assistantMessage(text, 'length')],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: 'ac1-incomplete-batch', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		// Harness proof (green at base): the non-verdict predicate settles as an
		// error under the generic workflow contract code, not the verdict code.
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.error).toContain(
			'PR_WORKFLOW_CONTRACT_INVALID',
		);
		expect(result.lane_results[0]?.error).toContain(
			'result.transcript_incomplete',
		);
		const record = findByCorrelationId(tempDir, correlationId);
		expect(record?.status).toBe('error');
		expect(record?.result?.error).toContain('PR_WORKFLOW_CONTRACT_INVALID');

		// DISCRIMINATING assertion (red at base: undefined): ANY reviewer-lane
		// collection-contract failure — not only verdict-row predicates — is
		// typed 'verdict_contract'.
		expect(record?.result?.workflowLaneFailureClass).toBe('verdict_contract');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'verdict_contract',
		);
	});
});

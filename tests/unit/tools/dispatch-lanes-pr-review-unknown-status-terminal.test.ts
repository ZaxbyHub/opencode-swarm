import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
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

const originalInternals = { ..._internals };

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	await teardownPrWorkflowGateFixtures();
});

async function arrangeMalformedTerminalLane(
	status: SessionOps['status'],
): Promise<void> {
	await establishReviewPrerequisites();
	const batchId = 'unknown-status-reviewer';
	const laneId = 'unknown-status-lane';
	const correlationId = `${batchId}--${laneId}`;
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[{ laneId, workflowLane: laneId, reviewItemIds: ['C-0'] }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
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
		mode: 'swarm-pr-review:reviewer',
		workflowLane: laneId,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: PR_REVIEW_SCOPE,
		},
	});
	_internals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'unused' } })),
		prompt: mock(async () => ({ data: null })),
		delete: mock(async () => undefined),
		...(status ? { status } : {}),
		messages: mock(async () => ({
			data: [
				{
					info: {
						role: 'assistant',
						time: { completed: 2 },
						finish: 'stop',
					},
					parts: [
						{
							type: 'text',
							text: '[REVIEWED] | C-0 | CONCERNS',
						},
					],
				},
			],
		})),
	});
}

describe('PR-review terminal proof with unknown status', () => {
	for (const [label, status] of [
		['status API unavailable', undefined],
		['status response omits the lane', mock(async () => ({ data: {} }))],
	] as const) {
		test(`persists rejected IDs when ${label}`, async () => {
			await arrangeMalformedTerminalLane(status);
			const result = await executeCollectLaneResults(
				{ batch_id: 'unknown-status-reviewer', wait: false },
				tempDir,
				{ sessionID: SESSION_ID },
			);
			expect(result.failed).toBe(1);
			expect(result.pending).toBe(0);
			expect(result.lane_results[0]?.rejected_review_item_ids).toEqual(['C-0']);
			expect(result.lane_results[0]?.error).toContain(
				'predicate=reviewer.verdict_rows',
			);
		});
	}
});

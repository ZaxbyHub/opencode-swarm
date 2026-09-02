import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
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
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalInternals = { ..._internals };

function baseOps(): Pick<
	SessionOps,
	'create' | 'prompt' | 'delete' | 'messages' | 'status'
> {
	return {
		create: mock(async () => ({ data: { id: 'unused' } })),
		prompt: mock(async () => ({ data: null })),
		delete: mock(async () => undefined),
		messages: mock(async () => ({ data: [] })),
		status: mock(async () => ({ data: {} })),
	};
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	Object.assign(_internals, originalInternals);
	_internals.resolvePrWorkflowRevisionDigestAsync = async () => REVISION_DIGEST;
});

afterEach(async () => {
	Object.assign(_internals, originalInternals);
	gateInternals.resetTrackedStateCache();
	await teardownPrWorkflowGateFixtures();
});

test('no longer persists lossy verdict-row recovery for unescaped pipes under the typed contract', async () => {
	// INTENT CHANGE (issue #2383): the twelve-field REVIEWED row contract ends
	// trailing-field pipe recovery for reviewer verdicts — the merged overflow
	// tail lands in the enum-constrained risk_tags field and can never
	// re-validate — so the unescaped-pipe row is a fail-closed lane failure and
	// NO recovery entry is persisted to the durable lane result.
	await establishReviewPrerequisites();
	const batchId = 'legacy-reviewer-batch';
	const laneId = 'legacy-reviewer-lane';
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
		promptHash: `${batchId}-hash`,
		generation: 1,
	});
	_internals.getSessionOps = () => ({
		...baseOps(),
		messages: mock(async () => ({
			data: [
				{
					info: { role: 'assistant', time: { completed: 2 }, finish: 'stop' },
					parts: [
						{
							type: 'text',
							text: '[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | with pipe | probe | reviewer',
						},
					],
				},
			],
		})),
	});

	const result = await executeCollectLaneResults(
		{ batch_id: batchId, wait: false },
		tempDir,
	);
	const recoveries = findByCorrelationId(tempDir, correlationId)?.result
		?.salvagedWorkflowLaneRecoveries;
	expect(result.completed).toBe(0);
	expect(result.failed).toBe(1);
	expect(result.lane_results[0]?.error).toContain(
		'predicate=reviewer.verdict_rows',
	);
	expect(recoveries).toBeUndefined();
});

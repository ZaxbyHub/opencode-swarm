/**
 * AC2 (verdict-lane failure-class typing): when the transport-recovery
 * validation STEP ITSELF throws (validator crash, not a validation verdict)
 * for a swarm-pr-review:reviewer lane, the catch-path settlement must carry
 * `workflowLaneFailureClass: 'verdict_contract'` beside the
 * PR_WORKFLOW_CONTRACT_INVALID error.
 *
 * Contract for both ends: RED at base, GREEN after the fix. At base the catch
 * around the transport-validation call stamps the classless
 * PR_WORKFLOW_CONTRACT_INVALID error and settles; after the fix reviewer-lane
 * transport-validation crashes are typed 'verdict_contract'. The throw is
 * injected through the module's `_internals.validatePrWorkflowTransportRecovery`
 * seam — the exact function the production catch wraps.
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
const INJECTED_CRASH = 'injected transport validator crash (AC2)';

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

async function recordCollectedReviewerLane(args: {
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

function reviewed(id: string): string {
	return `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`;
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

describe('collect_lane_results — reviewer transport-validator crash settles with the verdict_contract class (AC2)', () => {
	test('a throwing validatePrWorkflowTransportRecovery settles error with class verdict_contract', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'reviewer-crash',
					workflowLane: 'reviewer-crash',
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: 'ac2-crash-batch', prHeadSha: HEAD_SHA },
		);
		const correlationId = await recordCollectedReviewerLane({
			batchId: 'ac2-crash-batch',
			laneId: 'reviewer-crash',
		});
		const text = ITEM_IDS.map((id) => reviewed(id)).join('\n');
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [correlationId]: { type: 'idle' } },
			})),
			messages: mock(async () => ({ data: [assistantMessage(text)] })),
		});
		// Make the transport-validation step itself throw. The message deliberately
		// does NOT start with the deadline diagnostic prefix, so the production
		// catch treats it as a validator crash (not a budget expiry) and settles.
		_internals.validatePrWorkflowTransportRecovery = async () => {
			throw new Error(INJECTED_CRASH);
		};

		const result = await executeCollectLaneResults(
			{ batch_id: 'ac2-crash-batch', wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		// Harness proof (green at base): the crash settles as a classless-looking
		// PR_WORKFLOW_CONTRACT_INVALID error carrying the injected cause.
		expect(result.failed).toBe(1);
		expect(result.lane_results[0]?.error).toContain(
			'PR_WORKFLOW_CONTRACT_INVALID',
		);
		expect(result.lane_results[0]?.error).toContain(INJECTED_CRASH);
		const record = findByCorrelationId(tempDir, correlationId);
		expect(record?.status).toBe('error');
		expect(record?.result?.error).toContain('PR_WORKFLOW_CONTRACT_INVALID');

		// DISCRIMINATING assertion (red at base: undefined): the catch-path
		// settlement is typed as a verdict-contract failure for the reviewer lane.
		expect(record?.result?.workflowLaneFailureClass).toBe('verdict_contract');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'verdict_contract',
		);
	});
});

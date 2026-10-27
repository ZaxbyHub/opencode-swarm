/**
 * Issue #3397 RC-03: a host-aborted verdict lane WITH partial text must never
 * be typed `workflowLaneFailureClass: 'verdict_contract'` on EITHER stamp site
 * (the ordinary !validation.ok leg and the transport-validation throw catch).
 * Such lanes settle as classless `error` terminals and BLOCK typed-dead
 * N-of-M admission even after the retry budget is exhausted — the abort
 * evidence cannot authenticate a contract failure (AC26: aborted terminals
 * never typed).
 *
 * Frozen trace check C4 pins the same contract pre-merge; this is the
 * CI-tracked twin plus the settlement-admission rejection leg.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { recordPrReviewValidationBatch } from '../../../src/hooks/pr-workflow-gate.js';
import { deriveVerdictSettlementAdmission } from '../../../src/pr-review/verdict-settlement.js';
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
import { seedLivenessDeadLane } from '../pr-review/n-of-m-verdict-settlement.fixtures.js';

const NOW = 1_750_000_000_000;
const BATCH_ID = 'aborted-partial-batch';
const LANE_ID = 'aborted-partial-lane';

const originalInternals = { ..._internals };

interface AssistantArgs {
	text?: string;
	aborted: boolean;
}

function assistantMessage({ text, aborted }: AssistantArgs) {
	return {
		info: {
			role: 'assistant' as const,
			time: { completed: NOW },
			...(aborted
				? {
						finish: 'stop',
						error: {
							name: 'MessageAbortedError',
							message: 'aborted by operator',
						},
					}
				: { finish: 'stop' }),
		},
		parts: text === undefined ? [] : [{ type: 'text' as const, text }],
	};
}

function hostFor(args: AssistantArgs, sessionId: string): SessionOps {
	return {
		create: mock(async () => ({ data: { id: sessionId } })),
		prompt: mock(async () => ({ data: null })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
		abort: mock(async () => undefined),
		status: mock(async () => ({
			data: { [sessionId]: { type: 'idle' as const } },
		})),
		messages: mock(async () => ({
			data: [
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'p' }] },
				assistantMessage(args),
			],
		})),
	} as never;
}

async function prepareLane(): Promise<string> {
	await establishReviewPrerequisites();
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[{ laneId: LANE_ID, workflowLane: LANE_ID, reviewItemIds: ['C-0'] }],
		{ batchId: BATCH_ID, prHeadSha: HEAD_SHA },
	);
	const correlationId = `${BATCH_ID}--${LANE_ID}`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: BATCH_ID,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH_ID,
		laneId: LANE_ID,
		mode: 'swarm-pr-review:reviewer',
		workflowLane: LANE_ID,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: PR_REVIEW_SCOPE,
		},
		promptHash: `${BATCH_ID}-hash`,
		generation: 1,
	});
	return correlationId;
}

async function settleWith(
	args: AssistantArgs,
	correlationId: string,
	options?: { crashTransportValidation?: boolean },
) {
	_internals.getSessionOps = () => hostFor(args, correlationId);
	if (options?.crashTransportValidation) {
		_internals.validatePrWorkflowTransportRecovery = (() => {
			throw new Error('aborted-partial suite: transport validation crashed');
		}) as never;
	}
	await executeCollectLaneResults({ batch_id: BATCH_ID, wait: false }, tempDir);
	return findByCorrelationId(tempDir, correlationId);
}

describe('aborted-with-partial-text verdict lanes are never typed (#3397 RC-03)', () => {
	beforeEach(() => {
		setupPrWorkflowGateFixtures();
		Object.assign(_internals, originalInternals);
		_internals.resolvePrWorkflowRevisionDigestAsync = async () =>
			REVISION_DIGEST;
	});

	afterEach(async () => {
		Object.assign(_internals, originalInternals);
		await teardownPrWorkflowGateFixtures();
	});

	test('ordinary !ok leg: settles error with NO workflowLaneFailureClass', async () => {
		const correlationId = await prepareLane();
		const record = await settleWith(
			{
				aborted: true,
				text: 'partial assistant output before the operator abort; no verdict rows were emitted',
			},
			correlationId,
		);

		expect(record).toBeDefined();
		expect(record?.status).toBe('error');
		expect(record?.result?.workflowLaneFailureClass).toBeUndefined();
		expect(
			record?.terminalResult?.result.workflowLaneFailureClass,
		).toBeUndefined();
	}, 120000);

	test('transport-validation throw leg: settles error with NO workflowLaneFailureClass', async () => {
		const correlationId = await prepareLane();
		const record = await settleWith(
			{
				aborted: true,
				text: 'partial output; validation will crash',
			},
			correlationId,
			{ crashTransportValidation: true },
		);

		expect(record).toBeDefined();
		expect(record?.status).toBe('error');
		expect(record?.result?.workflowLaneFailureClass).toBeUndefined();
	}, 120000);

	test('contrast: non-aborted validation failure KEEPS verdict_contract', async () => {
		const correlationId = await prepareLane();
		const record = await settleWith(
			{
				aborted: false,
				text: 'finished output with no [REVIEWED] rows',
			},
			correlationId,
		);

		expect(record?.status).toBe('error');
		expect(record?.result?.workflowLaneFailureClass).toBe('verdict_contract');
	}, 120000);

	test('settlement admission: a classless aborted-shape owner is rejected even at exhausted budget', async () => {
		// Three distinct batches (1 + PR_REVIEW_VERDICT_RETRY_BUDGET = 3) each
		// own C-0 with a classless error terminal — the shape a host-aborted
		// partial-text lane settles into. Admission must refuse: classless
		// owners are rejected before the budget arm by design.
		await establishReviewPrerequisites();
		const window: Array<{
			batchId: string;
			lanes: Array<{
				laneId: string;
				workflowLane: string;
				reviewItemIds?: string[];
			}>;
		}> = [];
		for (const suffix of ['1', '2', '3']) {
			const batchId = `aborted-classless-batch-${suffix}`;
			const laneId = `aborted-classless-lane-${suffix}`;
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[{ laneId, workflowLane: laneId, reviewItemIds: ['C-0'] }],
				{ batchId, prHeadSha: HEAD_SHA },
			);
			await seedLivenessDeadLane({
				batchId,
				laneId,
				phase: 'reviewer',
				terminalStatus: 'error',
				omitFailureClass: true,
			});
			window.push({
				batchId,
				lanes: [{ laneId, workflowLane: laneId, reviewItemIds: ['C-0'] }],
			});
		}
		const admission = await deriveVerdictSettlementAdmission({
			directory: tempDir,
			prHeadSha: HEAD_SHA,
			phase: 'reviewer',
			window,
			unclaimed: ['C-0'],
		});

		expect(admission.admitted).toBe(false);
	}, 120000);
});

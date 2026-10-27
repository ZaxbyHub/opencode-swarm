/**
 * Issue #3312 acceptance (AC44) — PRESERVING.
 *
 * When a persisted verdict-settlement receipt CITES the liveness-terminal
 * record (a receipt row names the record's sourceBatchId/sourceLaneId — the
 * shape `persistVerdictSettlementReceipt` writes under
 * `.swarm/pr-review/<runId>/verdict-settlement.<phase>.json` per
 * src/pr-review/verdict-settlement.ts), the AC32 supersession is REFUSED:
 * the N-of-M settlement already disclosed this lane as dead evidence, so a
 * later transcript can no longer flip the record to completed underneath the
 * disclosure. The record stays stale/liveness.
 *
 * PASS at base (6c68fc7af): collectOnce skips terminal records, so the
 * stale/liveness record is untouched — the invariant holds trivially.
 * PASS after the fix: the supersession path checks for a citing receipt
 * before superseding and refuses.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { recordPrReviewValidationBatch } from '../../../src/hooks/pr-workflow-gate.js';
import {
	buildVerdictSettlementReceipt,
	persistVerdictSettlementReceipt,
	readVerdictSettlementReceipt,
} from '../../../src/pr-review/verdict-settlement.js';
import {
	_internals,
	_test_exports,
	executeCollectLaneResults,
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
const BATCH_ID = 'ac44-receipt-cited-batch';
const LANE_ID = 'ac44-reviewer-lane';
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
/** Run id the gate fixtures stamp their trigger evaluation under. */
const RUN_ID = 'test-run';
const originalInternals = { ..._internals };

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

async function seedLivenessTerminalLane(): Promise<void> {
	const recorded = await recordPendingDelegation(tempDir, {
		correlationId: CORRELATION_ID,
		jobId: null,
		subagentSessionId: CORRELATION_ID,
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
	expect(recorded).not.toBeNull();
	const reason = `lane ${LANE_ID} presumed stale: idle host session past the stale horizon`;
	const settled = await appendDelegationTransition(tempDir, CORRELATION_ID, {
		status: 'stale',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: digestText(reason),
			workflowLaneFailureClass: 'liveness',
		},
		expectedCurrentStatuses: ['pending', 'running', 'ingestion_error'],
	});
	expect(settled?.status).toBe('stale');
	expect(settled?.terminalResult?.result.workflowLaneFailureClass).toBe(
		'liveness',
	);
}

function reviewed(
	id: string,
	classification: 'CONFIRMED' | 'DISPROVED' = 'CONFIRMED',
): string {
	const severity = classification === 'DISPROVED' ? 'NONE' : 'HIGH';
	return `[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`;
}

function installCompletedSession(transcriptText: string): void {
	_test_exports.resetDeliveredLaneOutputs();
	_internals.getSessionOps = () => ({
		create: async () => ({ data: { id: 'unused' }, error: undefined }),
		prompt: async () => ({ data: null, error: undefined }),
		delete: async () => undefined,
		status: async () => ({
			data: { [CORRELATION_ID]: { type: 'idle' } },
			error: undefined,
		}),
		messages: async () => ({
			data: [
				{
					info: { role: 'assistant', time: { completed: 2 }, finish: 'stop' },
					parts: [{ type: 'text', text: transcriptText }],
				},
			],
			error: undefined,
		}),
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

describe('AC44 — a verdict-settlement receipt citing the record blocks supersession (#3312)', () => {
	test('a citing receipt keeps the stale/liveness reviewer record stale despite valid later rows', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: LANE_ID,
					workflowLane: LANE_ID,
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: BATCH_ID, prHeadSha: HEAD_SHA },
		);
		await seedLivenessTerminalLane();
		// Persist the N-of-M verdict-settlement receipt that CITES this exact
		// record (its sourceBatchId/sourceLaneId name the lane) as disclosed
		// liveness-dead evidence for item C-0.
		await persistVerdictSettlementReceipt(
			tempDir,
			buildVerdictSettlementReceipt({
				runId: RUN_ID,
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION_DIGEST,
				phase: 'reviewer',
				items: [
					{
						itemId: 'C-0',
						sourceBatchId: BATCH_ID,
						sourceLaneId: LANE_ID,
						disposition: 'liveness_dead',
						evidenceClass: 'liveness',
						terminalStatus: 'stale',
					},
				],
			}),
		);
		const receiptRead = readVerdictSettlementReceipt(
			tempDir,
			RUN_ID,
			'reviewer',
		);
		expect(receiptRead.status).toBe('ok');
		if (receiptRead.status === 'ok') {
			expect(receiptRead.receipt.items[0]?.sourceBatchId).toBe(BATCH_ID);
			expect(receiptRead.receipt.items[0]?.sourceLaneId).toBe(LANE_ID);
		}
		const transcript = [
			reviewed('C-0'),
			reviewed('C-1'),
			...ITEM_IDS.slice(2).map((id) => reviewed(id, 'DISPROVED')),
		].join('\n');
		installCompletedSession(transcript);

		await executeCollectLaneResults(
			{ batch_id: BATCH_ID, wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		const record = findByCorrelationId(tempDir, CORRELATION_ID);
		expect(record).not.toBeNull();
		// The citation refuses supersession: the record keeps its disclosed
		// terminal liveness disposition and gains no validated output.
		expect(record?.status).toBe('stale');
		expect(record?.status).not.toBe('completed');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'liveness',
		);
		expect(record?.result?.text).toBeUndefined();
	});
});

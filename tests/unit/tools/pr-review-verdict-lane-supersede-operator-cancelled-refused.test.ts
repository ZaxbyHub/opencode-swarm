/**
 * Issue #3312 acceptance (AC34) — PRESERVING.
 *
 * The AC32 supersession transition (stale+liveness → completed for
 * reviewer/critic verdict lanes) is reserved for the typed `liveness` class.
 * A record terminal `cancelled` carrying the `operator_cancelled` failure
 * class is an explicitly authorized operator cancellation and must NEVER be
 * superseded by a later completed transcript, however valid its rows are.
 *
 * PASS at base (6c68fc7af): collectOnce skips terminal records, so the
 * cancelled record is untouched — the invariant holds trivially.
 * PASS after the fix: the narrow transition matches only stale/liveness
 * records; an operator_cancelled terminal stays cancelled with its typed
 * class intact.
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
const BATCH_ID = 'ac34-operator-cancelled-batch';
const LANE_ID = 'ac34-reviewer-lane';
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
const originalInternals = { ..._internals };

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** The durable shape cancel_lane_batch writes (#2971): cancelled + typed class. */
async function seedOperatorCancelledLane(): Promise<void> {
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
	const reason = `lane ${LANE_ID} cancelled by operator via cancel_lane_batch`;
	const settled = await appendDelegationTransition(tempDir, CORRELATION_ID, {
		status: 'cancelled',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: digestText(reason),
			workflowLaneFailureClass: 'operator_cancelled',
		},
		expectedCurrentStatuses: ['pending', 'running', 'ingestion_error'],
	});
	expect(settled?.status).toBe('cancelled');
	expect(settled?.terminalResult?.result.workflowLaneFailureClass).toBe(
		'operator_cancelled',
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

describe('AC34 — operator_cancelled terminal is never superseded by a later valid transcript (#3312)', () => {
	test('a cancelled/operator_cancelled reviewer record stays cancelled despite valid later rows', async () => {
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
		await seedOperatorCancelledLane();
		// The later transcript is fully valid for the assigned items — the
		// refusal must come from the operator_cancelled class, not the rows.
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
		expect(record?.status).toBe('cancelled');
		expect(record?.status).not.toBe('completed');
		expect(record?.status).not.toBe('stale');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'operator_cancelled',
		);
		expect(record?.result?.text).toBeUndefined();
	});
});

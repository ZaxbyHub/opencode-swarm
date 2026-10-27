/**
 * Issue #3312 acceptance (AC33) — PRESERVING.
 *
 * Supersession of a terminal stale/liveness reviewer lane (AC32's narrow
 * stale+liveness → completed transition) is gated on the legacy-transcript
 * adapter ACCEPTING the later transcript's rows against the lane's assigned
 * items. When the later transcript rows are INVALID for the assigned items
 * (here: one assigned item's `[REVIEWED]` row violates the row schema — a
 * DISPROVED classification carrying a non-NONE severity, so the row can never
 * claim), supersession is REFUSED: the durable record stays terminal `stale`
 * with its typed `liveness` failure class and gains no validated output.
 *
 * PASS at base (6c68fc7af): collectOnce skips terminal records entirely, so
 * the record stays stale/liveness — the invariant holds trivially.
 * PASS after the fix: the supersession path re-validates the transcript via
 * the adapter and refuses on the invalid row (the gate is the adapter's
 * verdict, not transcript presence).
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
const BATCH_ID = 'ac33-invalid-rows-batch';
const LANE_ID = 'ac33-reviewer-lane';
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
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

describe('AC33 — invalid later rows refuse stale/liveness verdict-lane supersession (#3312)', () => {
	test('an adapter-invalid transcript leaves the stale/liveness record untouched', async () => {
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
		// Host session finished, but the transcript is INVALID for the assigned
		// items: C-5's row pairs a DISPROVED classification with a HIGH severity,
		// a schema-invalid row that can never claim the item.
		const transcript = [
			reviewed('C-0'),
			reviewed('C-1'),
			reviewed('C-2'),
			reviewed('C-3'),
			reviewed('C-4'),
			'[REVIEWED] | C-5 | DISPROVED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale C-5 | probe C-5 | reviewer',
		].join('\n');
		installCompletedSession(transcript);

		await executeCollectLaneResults(
			{ batch_id: BATCH_ID, wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		const record = findByCorrelationId(tempDir, CORRELATION_ID);
		expect(record).not.toBeNull();
		// No supersession: the record keeps its terminal liveness disposition.
		expect(record?.status).toBe('stale');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'liveness',
		);
		// Nothing about the invalid transcript was promoted onto the record.
		expect(record?.result?.text).toBeUndefined();
		expect(record?.status).not.toBe('completed');
	});
});

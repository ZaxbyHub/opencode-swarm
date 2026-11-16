/**
 * Issue #3312 acceptance (AC35) — PRESERVING.
 *
 * The AC32 supersession transition (terminal stale/liveness → completed) is
 * scoped to `swarm-pr-review:reviewer|critic` verdict lanes ONLY. A discovery
 * lane record (mode `swarm-pr-review:base`, or a micro lane) that went
 * terminal stale/liveness is NOT superseded through this path — it stays
 * stale even when a later collection finds a finished session whose rows
 * would satisfy the reviewer verdict-row contract.
 *
 * The test deliberately plants the strongest variant of the trap: a declared
 * reviewer validation batch naming this lane and its item ids exists (so a
 * fix that forgot the mode gate would find everything else it needs), and the
 * later transcript is a fully valid reviewer-row set. Only the record's
 * discovery MODE blocks supersession.
 *
 * PASS at base (6c68fc7af): collectOnce skips terminal records, so the
 * stale/liveness base-mode record is untouched — the invariant holds
 * trivially.
 * PASS after the fix: the narrow transition matches only
 * swarm-pr-review:reviewer|critic records; the base-mode record stays stale.
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
const BATCH_ID = 'ac35-discovery-lane-batch';
const LANE_ID = 'ac35-base-lane';
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
const originalInternals = { ..._internals };

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** A base-mode (discovery) lane record already terminal stale/liveness. */
async function seedLivenessTerminalDiscoveryLane(): Promise<void> {
	const recorded = await recordPendingDelegation(tempDir, {
		correlationId: CORRELATION_ID,
		jobId: null,
		subagentSessionId: CORRELATION_ID,
		parentSessionId: SESSION_ID,
		callID: BATCH_ID,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: BATCH_ID,
		laneId: LANE_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: LANE_ID,
		prReviewLegacyTranscriptCompatibility: true,
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

describe('AC35 — a discovery-lane stale/liveness terminal is not superseded through the verdict-lane path (#3312)', () => {
	test('a base-mode stale/liveness record stays stale even with a declared reviewer batch and valid rows', async () => {
		await establishReviewPrerequisites();
		// Trap: a declared reviewer validation batch naming this exact lane and
		// item ids exists, so only the record's discovery mode can gate the
		// refusal once the fix lands.
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
		await seedLivenessTerminalDiscoveryLane();
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
		expect(record?.mode).toBe('swarm-pr-review:base');
		expect(record?.status).toBe('stale');
		expect(record?.status).not.toBe('completed');
		expect(record?.terminalResult?.result.workflowLaneFailureClass).toBe(
			'liveness',
		);
		expect(record?.result?.text).toBeUndefined();
	});
});

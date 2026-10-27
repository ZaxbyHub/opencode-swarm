/**
 * Issue #3312 acceptance (AC32) — DISCRIMINATING.
 *
 * A reviewer verdict-lane record that already went terminal `stale` with the
 * typed `liveness` failure class must be superseded to `completed` when a
 * LATER collection pass finds the host session finished (idle) and its
 * transcript carries valid `[REVIEWED]` rows covering the lane's assigned
 * items (accepted by the legacy-transcript adapter). The supersession happens
 * under the delegation store lock and leaves the validated rows claimable on
 * the durable record (result text carrying the validated output, status
 * `completed`, no lingering liveness error verdict).
 *
 * RED at base (6c68fc7af): `collectOnce` only processes pending/running
 * records (src/tools/dispatch-lanes.ts `activeRecords` filter), and the
 * delegation store's terminal records are immutable for this shape — the
 * transition guard in `appendDelegationTransition`
 * (src/background/pending-delegations.ts) keeps a terminal `stale` record
 * unless the next status is consumed/ingestion_error. The collect pass is a
 * no-op for the stale record and `expect(record?.status).toBe('completed')`
 * fails with received "stale".
 * GREEN after the fix: the narrow stale+liveness → completed transition for
 * `swarm-pr-review:reviewer|critic` lanes, invoked from the dispatch-lanes
 * collection path and gated on the adapter accepting the rows, supersedes the
 * record with the validated output.
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
const BATCH_ID = 'ac32-supersede-batch';
const LANE_ID = 'ac32-reviewer-lane';
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
const originalInternals = { ..._internals };

function digestText(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/**
 * Seed a reviewer-lane delegation record that already reached the terminal
 * `stale` status carrying the typed `liveness` failure class — the exact
 * durable shape the production idle-host stale sweep writes (mirror of the
 * `idleLivenessResult` + `appendDelegationTransition` sequence in
 * src/tools/dispatch-lanes.ts).
 */
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
	// The seeded record must genuinely be the terminal liveness shape before
	// the later collection runs, including its typed terminal evidence.
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

/** Install a fake session client whose transcript is a COMPLETED, valid run. */
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

describe('AC32 — stale/liveness reviewer lane superseded by a later completed transcript (#3312)', () => {
	test('a terminal stale/liveness reviewer record flips to completed with validated rows claimable', async () => {
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
		// DISCRIMINATING: at base the record stays `stale` (collectOnce skips
		// terminal records; the store keeps terminal records immutable).
		expect(record?.status).toBe('completed');
		// The supersession must leave the validated rows claimable on the
		// durable record (result text carrying the validated [REVIEWED] rows).
		expect(record?.result?.text).toContain('[REVIEWED] | C-0 | CONFIRMED');
		expect(record?.result?.text).toContain(
			'[REVIEWED] | C-5 | DISPROVED | STRUCTURALLY_PROVEN | NONE',
		);
		// A superseded-to-completed record must not keep its liveness error
		// verdict next to the completed receipt (same sanitization rule the
		// claim-first receipt admission applies).
		expect(record?.result?.error).toBeUndefined();
		expect(record?.result?.workflowLaneFailureClass).not.toBe('liveness');
	});
});

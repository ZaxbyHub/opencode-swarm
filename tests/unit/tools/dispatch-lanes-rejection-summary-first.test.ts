/**
 * Issue #3313 acceptance (AC36) — DISCRIMINATING.
 *
 * When a reviewer (or critic) verdict lane is rejected at collection for a
 * verdict-row violation whose composed rejection detail is far longer than
 * the 200-char summary window, the recorded AND returned error's FIRST 200
 * characters must name the offending row id and the violated predicate — the
 * discriminating summary leads (`... <CODE>: <row id> <predicate> ...; detail
 * in artifact <ref>` shape); the long tail belongs in the lane's durable
 * artifact (AC37).
 *
 * Fixture calibration: the batch id and lane/workflow-lane ids are maximal
 * (119 chars — the collect schema caps batch_id at 120 and the
 * [PR_REVIEW_COLLECTION_RECEIPT_V1] payload schema caps batchId/laneId/
 * workflowLane at 120, so longer ids would make the receipt footer
 * unbuildable and silently withhold the terminal), and the offending row
 * carries an invented id placed LAST in the transcript. At base the error is
 * the raw header-first concatenation
 * (`PR_REVIEW_VERDICT_CONTRACT_INVALID: batch=… lane=… workflow_lane=…
 * predicate=reviewer.verdict_rows expected=… actual={…}` — the same string
 * the settle path clips at 1_024 chars): with these id lengths the composed
 * detail runs well past 800 chars, and the offending row id lands around
 * char ~650 — present in the string but far outside the first 200
 * characters, which the batch/lane/workflow-lane header alone exhausts.
 *
 * RED at base (6c68fc7af): `expect(first200).toContain(BAD_ROW_ID)` fails —
 * the first 200 chars hold only the code prefix and the long
 * batch/lane/workflow-lane header.
 * GREEN after the fix: the summary is composed row-id/predicate-first within
 * the first 200 characters.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { recordPrReviewValidationBatch } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	_test_exports,
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
/** 119 chars — inside both the collect schema's and the receipt schema's cap. */
const BATCH_ID = `ac36-batch-${'p'.repeat(109)}`;
/** 119 chars — the receipt payload schema's laneId/workflowLane cap. */
const LANE_ID = `ac36-lane-${'w'.repeat(109)}`;
const WORKFLOW_LANE = LANE_ID;
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
/** 39 chars, verdict-row-identifier charset ([A-Za-z0-9._:-]) safe. */
const BAD_ROW_ID = `AC36-bad-row-${'z'.repeat(27)}`;
const originalInternals = { ..._internals };

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

async function recordCollectedLane(): Promise<void> {
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
		workflowLane: WORKFLOW_LANE,
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

describe('AC36 — verdict-row rejection summary leads with the offending row id and predicate (#3313)', () => {
	test('the first 200 chars of the recorded/returned error name the offending row id and predicate', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: LANE_ID,
					workflowLane: WORKFLOW_LANE,
					reviewItemIds: [...ITEM_IDS],
				},
			],
			{ batchId: BATCH_ID, prHeadSha: HEAD_SHA },
		);
		await recordCollectedLane();
		// Valid rows for every assigned item PLUS one invented-id row placed
		// LAST, so the offending id renders late in today's failure detail.
		const transcript = [
			...ITEM_IDS.map((id) => reviewed(id)),
			`[REVIEWED] | ${BAD_ROW_ID} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale bad | probe bad | reviewer`,
		].join('\n');
		_test_exports.resetDeliveredLaneOutputs();
		_internals.getSessionOps = () => ({
			...baseOps(),
			status: mock(async () => ({
				data: { [CORRELATION_ID]: { type: 'idle' } },
			})),
			messages: mock(async () => ({
				data: [
					{
						info: { role: 'assistant', time: { completed: 2 }, finish: 'stop' },
						parts: [{ type: 'text', text: transcript }],
					},
				],
			})),
		});

		const result = await executeCollectLaneResults(
			{ batch_id: BATCH_ID, wait: false },
			tempDir,
			{ sessionID: SESSION_ID },
		);

		// The lane is rejected at both ends — only the error's SHAPE changes.
		expect(result.failed).toBe(1);
		const laneError = result.lane_results[0]?.error ?? '';
		expect(laneError).toContain('PR_REVIEW_VERDICT_CONTRACT_INVALID');

		const first200 = laneError.slice(0, 200);
		// Sanity at both ends: the composed error is long (the header alone
		// exceeds 400 chars with these fixture ids), so the discriminating
		// content MUST lead within the summary window.
		expect(laneError.length).toBeGreaterThan(200);
		// DISCRIMINATING: the offending row id is named inside the first 200
		// characters. At base the first 200 chars are exhausted by the code
		// prefix plus the batch/lane/workflow-lane header; the row id sits
		// several hundred characters deeper.
		expect(first200).toContain(BAD_ROW_ID);
		// DISCRIMINATING: the violated predicate is named alongside it.
		expect(first200).toContain('reviewer.verdict_rows');

		// The DURABLE record's error carries the same leading summary.
		const record = findByCorrelationId(tempDir, CORRELATION_ID);
		expect(record?.status).toBe('error');
		expect(record?.result?.workflowLaneFailureClass).toBe('verdict_contract');
		const recordedFirst200 = (record?.result?.error ?? '').slice(0, 200);
		expect(recordedFirst200).toContain(BAD_ROW_ID);
		expect(recordedFirst200).toContain('reviewer.verdict_rows');
	});
});

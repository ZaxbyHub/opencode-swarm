/**
 * Issue #3313 acceptance (AC37) — DISCRIMINATING.
 *
 * When a reviewer verdict lane is rejected at collection for a verdict-row
 * violation, the COMPLETE untruncated rejection detail must be recorded in
 * the lane's artifact through the lane-output store
 * (src/background/lane-output.ts `storeLaneOutput`) and be resolvable via
 * the retrieve-lane-output path (src/tools/retrieve-lane-output.ts — the
 * `retrieve_lane_output` tool execute, backed by the store's `readLaneOutput`).
 *
 * At base the rejection detail exists only as the bounded `result.error`
 * string on the delegation record (composed header-first and sliced at the
 * settle site); NO lane-output artifact carries it — the only artifact the
 * collect path stores for the lane is the raw transcript text. The test scans
 * the lane-results store for this lane's artifacts and requires one whose
 * text IS the full rejection detail (code + offending row id + the failure
 * JSON's tail), then resolves it back through the store read AND the
 * retrieve_lane_output tool execute.
 *
 * RED at base (6c68fc7af): the artifact scan finds only the transcript
 * artifact(s) — none contains 'PR_REVIEW_VERDICT_CONTRACT_INVALID', so the
 * detail-artifact existence assertion fails with an empty received list.
 * GREEN after the fix: the rejection detail is persisted through
 * storeLaneOutput and resolvable by ref.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { readLaneOutput } from '../../../src/background/lane-output-store.js';
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
import { retrieve_lane_output } from '../../../src/tools/retrieve-lane-output.js';
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
const BATCH_ID = `ac37-batch-${'p'.repeat(109)}`;
/** 119 chars — the receipt payload schema's laneId/workflowLane cap. */
const LANE_ID = `ac37-lane-${'w'.repeat(109)}`;
const WORKFLOW_LANE = LANE_ID;
const CORRELATION_ID = `${BATCH_ID}--${LANE_ID}`;
/** 39 chars, verdict-row-identifier charset ([A-Za-z0-9._:-]) safe. */
const BAD_ROW_ID = `AC37-bad-row-${'z'.repeat(27)}`;
const REJECTION_CODE = 'PR_REVIEW_VERDICT_CONTRACT_INVALID';
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

function reviewed(id: string): string {
	return `[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`;
}

interface LaneArtifactDraft {
	ref: string;
	batchId?: unknown;
	laneId?: unknown;
	text?: unknown;
}

/** Every stored lane-output artifact for this exact batch/lane pair. */
function scanLaneArtifacts(): LaneArtifactDraft[] {
	const root = path.join(tempDir, '.swarm', 'lane-results');
	if (!fs.existsSync(root)) return [];
	const files = fs
		.readdirSync(root, { recursive: true })
		.filter(
			(entry) =>
				typeof entry === 'string' &&
				entry.endsWith('.json') &&
				!entry.includes('.tmp-'),
		);
	const artifacts: LaneArtifactDraft[] = [];
	for (const entry of files) {
		let parsed: LaneArtifactDraft | undefined;
		try {
			parsed = JSON.parse(
				fs.readFileSync(path.join(root, entry), 'utf-8'),
			) as LaneArtifactDraft;
		} catch {
			continue;
		}
		if (parsed?.batchId === BATCH_ID && parsed?.laneId === LANE_ID) {
			artifacts.push(parsed);
		}
	}
	return artifacts;
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

describe('AC37 — the complete rejection detail is stored in the lane artifact and resolvable via retrieve-lane-output (#3313)', () => {
	test('a verdict-row rejection persists its full detail artifact, readable through the retrieve path', async () => {
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

		// The lane is rejected and carries the bounded error at both ends.
		expect(result.failed).toBe(1);
		const record = findByCorrelationId(tempDir, CORRELATION_ID);
		expect(record?.status).toBe('error');
		expect(record?.result?.workflowLaneFailureClass).toBe('verdict_contract');

		// The collect path stored the lane's TRANSCRIPT artifact — proves the
		// scan below actually sees this lane's artifact directory.
		const artifacts = scanLaneArtifacts();
		expect(artifacts.length).toBeGreaterThanOrEqual(1);
		// Harness mechanics (passes at both ends): the store read AND the
		// retrieve_lane_output tool execute resolve an artifact that does
		// exist — the transcript artifact — through the same ref the detail
		// artifact will carry after the fix.
		const transcriptArtifact = artifacts[0]!;
		expect(readLaneOutput(tempDir, transcriptArtifact.ref)).not.toBeNull();
		const transcriptRetrieved = await retrieve_lane_output.execute(
			{ ref: transcriptArtifact.ref, offset: 0, limit: 500 },
			{ directory: tempDir } as ToolContext,
		);
		expect(transcriptRetrieved).toContain('--- Lane output');

		// DISCRIMINATING: at base NO artifact holds the rejection detail — the
		// only stored artifact is the raw transcript, which never contains the
		// rejection code.
		const detailArtifacts = artifacts.filter((artifact) =>
			typeof artifact.text === 'string'
				? artifact.text.includes(REJECTION_CODE)
				: false,
		);
		expect(detailArtifacts.length).toBeGreaterThanOrEqual(1);

		const detail = detailArtifacts[0]!;
		const detailText = detail.text as string;
		// COMPLETE and untruncated: the artifact text carries the offending
		// row id AND the failure detail's tail (the analysis JSON's closing
		// members), not just a clipped prefix.
		expect(detailText).toContain(BAD_ROW_ID);
		expect(detailText).toContain('reviewer.verdict_rows');
		expect(detailText).toContain('quarantinedArities');
		expect(detailText.length).toBeGreaterThan(200);

		// Resolvable through the store read the retrieve tool routes through.
		const readBack = readLaneOutput(tempDir, detail.ref);
		expect(readBack).not.toBeNull();
		expect(readBack?.artifact.text).toContain(REJECTION_CODE);
		expect(readBack?.artifact.text).toContain(BAD_ROW_ID);

		// Resolvable through the retrieve_lane_output tool path itself.
		const retrieved = await retrieve_lane_output.execute(
			{ ref: detail.ref, offset: 0, limit: 500 },
			{ directory: tempDir } as ToolContext,
		);
		expect(typeof retrieved).toBe('string');
		expect(retrieved).toContain(REJECTION_CODE);
		expect(retrieved).toContain(BAD_ROW_ID);
	});
});

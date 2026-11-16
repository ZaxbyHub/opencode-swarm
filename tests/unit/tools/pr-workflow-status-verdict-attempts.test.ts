import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { recordPrReviewValidationBatch } from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';
import {
	DEAD_LANE,
	establishFullInventory,
	LIVE_LANE,
	reviewedRows,
	seedLivenessDeadLane,
} from '../pr-review/n-of-m-verdict-settlement.fixtures.js';
import {
	installProjectionTestEnv,
	restoreProjectionTestEnv,
	runProjectionTool,
} from './pr-workflow-status-projection.fixtures.js';

// ACCEPTANCE CHECK AC24 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test (FROZEN PROJECTION SHAPE): the pr_workflow_status
// PR_REVIEW projection exposes per-item verdict attempt accounting equal to
// what the N-of-M verdict-settlement admission would compute, as a new array
// field on the projection:
//
//   gate.prReviewProjection.verdictAttempts: Array<{
//     itemId: string;          // the unclaimed review item
//     attemptsUsed: number;    // distinct reviewer-phase-window batches whose lanes declare the item
//     attemptsRequired: number; // 1 + PR_REVIEW_VERDICT_RETRY_BUDGET (= 3)
//     remaining: number;       // attemptsRequired - attemptsUsed
//   }>
//
// Seeded world: the full derived inventory with a live lane covering the live
// half (successful artifact persisted) and ONE liveness-dead batch whose lane
// declares the dead half — every dead item therefore has attemptsUsed 1,
// attemptsRequired 3, remaining 2.
//
// RED at base: no per-item attempt field exists anywhere on the projection
// (verdictAttempts is undefined). GREEN after the fix: the rows above are
// exposed for the dead items.

interface VerdictAttemptRow {
	itemId: string;
	attemptsUsed: number;
	attemptsRequired: number;
	remaining: number;
}

beforeEach(() => {
	installProjectionTestEnv();
});

afterEach(async () => {
	await restoreProjectionTestEnv();
});

describe('AC24: prReviewProjection exposes per-item verdict attempt counts and remaining budget', () => {
	test('dead verdict items project attemptsUsed 1 of attemptsRequired 3 with remaining 2', async () => {
		const ids = await establishFullInventory();
		const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
		const dead = ids.slice(live.length);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{ laneId: LIVE_LANE, workflowLane: LIVE_LANE, reviewItemIds: live },
				{ laneId: DEAD_LANE, workflowLane: DEAD_LANE, reviewItemIds: dead },
			],
			{ batchId: 'ac24-batch-1', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'ac24-batch-1',
			'swarm-pr-review:reviewer',
			[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
			{ textOverride: reviewedRows(live) },
		);
		await seedLivenessDeadLane({
			batchId: 'ac24-batch-1',
			laneId: DEAD_LANE,
			phase: 'reviewer',
		});

		const parsed = await runProjectionTool(tempDir, SESSION_ID);
		const projection = (parsed.gate as Record<string, unknown>)
			.prReviewProjection as Record<string, unknown> | undefined;
		// Sanity (green at base too): the PR_REVIEW projection itself is present.
		expect(projection).toBeDefined();
		expect(Array.isArray(projection?.laneCoverage)).toBe(true);

		// RED at base: the field does not exist on the projection.
		const rows = projection?.verdictAttempts as VerdictAttemptRow[] | undefined;
		expect(
			Array.isArray(rows),
			'projection.verdictAttempts must be an array',
		).toBe(true);
		for (const itemId of dead) {
			const row = rows?.find((candidate) => candidate.itemId === itemId);
			expect(
				row,
				`verdictAttempts must carry a row for dead item ${itemId}; got ${JSON.stringify(rows)}`,
			).toBeDefined();
			expect(row).toMatchObject({
				itemId,
				attemptsUsed: 1,
				attemptsRequired: 3,
				remaining: 2,
			});
		}
	});
});

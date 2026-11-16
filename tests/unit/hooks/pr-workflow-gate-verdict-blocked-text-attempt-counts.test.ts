import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	DEAD_LANE,
	establishFullInventory,
	LIVE_LANE,
	reviewedRows,
	seedLivenessDeadLane,
} from '../pr-review/n-of-m-verdict-settlement.fixtures.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// ACCEPTANCE CHECK AC22 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test (FROZEN MESSAGE WORDING): when the PR_REVIEW N-of-M
// verdict settlement BLOCKS because an unclaimed item's per-item retry budget
// is not exhausted, the thrown BLOCKED message must carry, PER NAMED ITEM, the
// attempts used out of the required total and the remaining budget, in exactly
// this shape:
//
//   `attempts: <used> of <required>` and `remaining: <required - used>`
//
// where <required> = 1 + PR_REVIEW_VERDICT_RETRY_BUDGET = 3. Both the
// 1-of-3 case and the 2-of-3 case are pinned. This test freezes that wording;
// the fix must emit it (the base message only says "(N of 3 required
// attempts)" inside the aggregate admission reason, with no per-item counts
// and no remaining figure).
//
// RED at base: the thrown message contains no "attempts: 1 of 3" (nor
// "attempts: 2 of 3") and no "remaining:" figure. GREEN after the fix: the
// per-item counts above appear for every named unclaimed item.

async function captureBlockedMessage(): Promise<string> {
	let message = '';
	try {
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	return message;
}

async function seedSingleAttemptWorld(): Promise<string[]> {
	const ids = await establishFullInventory();
	const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
	const dead = ids.slice(live.length);
	// Exactly ONE attempt batch for the dead items' owner lane.
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{ laneId: LIVE_LANE, workflowLane: LIVE_LANE, reviewItemIds: live },
			{ laneId: DEAD_LANE, workflowLane: DEAD_LANE, reviewItemIds: dead },
		],
		{ batchId: 'ac22-batch-1', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'ac22-batch-1',
		'swarm-pr-review:reviewer',
		[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
		{ textOverride: reviewedRows(live) },
	);
	await seedLivenessDeadLane({
		batchId: 'ac22-batch-1',
		laneId: DEAD_LANE,
		phase: 'reviewer',
	});
	return dead;
}

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('AC22: verdict-settlement BLOCKED text carries per-item attempt counts', () => {
	test('1 of 3 attempt batches: message names attempts: 1 of 3 and remaining: 2 for the dead items', async () => {
		const dead = await seedSingleAttemptWorld();
		const message = await captureBlockedMessage();
		expect(message).not.toBe('');
		for (const itemId of dead) {
			expect(message).toContain(itemId);
		}
		expect(message).toMatch(/attempts: 1 of 3/);
		expect(message).toMatch(/remaining: 2/);
	});

	test('2 of 3 attempt batches: message names attempts: 2 of 3 and remaining: 1 for the dead items', async () => {
		const dead = await seedSingleAttemptWorld();
		// A second retry batch re-declares the dead lane's items; the lane is
		// liveness-dead there too, so the budget arm still refuses at 2 of 3.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: DEAD_LANE,
					workflowLane: DEAD_LANE,
					reviewItemIds: dead,
				},
			],
			{ batchId: 'ac22-batch-2', prHeadSha: HEAD_SHA },
		);
		await seedLivenessDeadLane({
			batchId: 'ac22-batch-2',
			laneId: DEAD_LANE,
			phase: 'reviewer',
		});
		const message = await captureBlockedMessage();
		expect(message).not.toBe('');
		for (const itemId of dead) {
			expect(message).toContain(itemId);
		}
		expect(message).toMatch(/attempts: 2 of 3/);
		expect(message).toMatch(/remaining: 1/);
	});
});

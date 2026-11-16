// Issue #2906 (review F-08 LOW arm) — the gate-side order-unstable item
// derivations:
// - `derivePrReviewOrderUnstableItems` (public, critic-dispatch prompt): every
//   currently-composed reviewer item labeled 'disagree', sorted.
// - `derivePrReviewOrderUnstableItemsForState` (pr-workflow-gate.ts, the
//   assigned-items filter at the orderUnstableItemIds coherence stamp): the
//   disagree items INTERSECTED with the batch's assigned review items, sorted
//   — a disagree item the critic batch does not own must not be flagged into
//   that batch's prompt snapshot.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	derivePrReviewOrderUnstableItems,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

/** Six base candidates C-0..C-5; micro lanes are all CLEAN in this world. */
const INVENTORY = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];

/** One CONFIRMED reviewer row at ORDINARY risk with no tags. */
const reviewedRow = (id: string, severity: string): string =>
	`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `;

/**
 * Reviewer rows for one counterbalanced pass. `severities` overrides per item;
 * everything is CONFIRMED at ORDINARY risk with no tags, so critic routing is
 * purely severity-driven: CRITICAL/HIGH route, LOW does not.
 */
const passRows = (severities: Record<string, string>): string[] =>
	INVENTORY.map((id) => reviewedRow(id, severities[id] ?? 'HIGH'));

async function reviewerPass(
	batchId: string,
	severities: Record<string, string>,
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: `${batchId}-lane`,
				reviewItemIds: [...INVENTORY],
			},
		],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{ textOverride: passRows(severities).join('\n') },
	);
}

describe('order-unstable item derivations (issue #2906)', () => {
	test('critic-batch coherence stamps only the assigned disagree items', async () => {
		await establishReviewPrerequisites();
		// Pass A (order A): everything HIGH.
		await reviewerPass('ou-a', {});
		// Pass B (order B): C-0 flips to LOW (disagree, not critic-routed), C-1
		// flips to CRITICAL (disagree, critic-routed), C-2..C-5 stay HIGH (agree).
		// The main loop settles on the newest pass (B), so the composed winners
		// are C-0 LOW / C-1 CRITICAL / rest HIGH and the critic inventory is
		// exactly C-1..C-5.
		await reviewerPass('ou-b', { 'C-0': 'LOW', 'C-1': 'CRITICAL' });

		// Public derivation: every composed disagree item, no assigned scoping.
		const unstable = await derivePrReviewOrderUnstableItems(
			tempDir,
			SESSION_ID,
		);
		expect(unstable).toEqual(['C-0', 'C-1']);

		// Critic-batch stamp: the assigned intersection only. C-0 is
		// order-unstable but NOT in this batch's assigned items (LOW never
		// routes to the critic), so it must stay out of the prompt snapshot.
		const criticItems = INVENTORY.slice(1);
		const state = await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'ou-critic-lane',
					agent: 'critic',
					workflowLane: 'ou-critic-lane',
					reviewItemIds: criticItems,
				},
			],
			{ batchId: 'ou-critic', prHeadSha: HEAD_SHA },
		);
		expect(
			state.prReviewBatchCoherence?.['ou-critic']?.orderUnstableItemIds,
		).toEqual(['C-1']);
	});
});

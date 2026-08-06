import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
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

/**
 * Issue #1968 — the three "abandon the prune" branches of the capacity GC.
 *
 * Each ledger carries a fail-closed control across a prune that would otherwise
 * loosen it (the critic reuse ban, the tier-L cumulative consolidation floor,
 * the feedback re-claim rejection). When retiring a batch would push a ledger
 * past its schema bound, the GC must keep EVERY batch and let the pre-existing
 * cap error stand: losing the control is a fail-open, losing the reclaim is
 * only a dead end. Every one of the three branches was reachable but unproven —
 * raising all three constants to `Number.MAX_SAFE_INTEGER` left the GC suite
 * green.
 *
 * No production constant is injected. Each ledger is a top-level optional key
 * whose own schema admits arbitrary strings up to its bound, so seeding a state
 * file to exactly that bound and then triggering a prune that must add at least
 * one entry reaches the branch through the real code path.
 */

const CAP_TEST_TIMEOUT_MS = 120_000;
const {
	MAX_WORKFLOW_BATCHES,
	MAX_RETIRED_REVIEWER_SESSION_IDS,
	MAX_RETIRED_CONSOLIDATED_LANES,
	MAX_RETIRED_FEEDBACK_ITEM_OWNERS,
} = gateInternals;
const [DIM_A, DIM_B] = PR_REVIEW_BASE_DIMENSION_IDS;
const REVIEW_ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const REVIEWED_ROWS = REVIEW_ITEM_IDS.map(
	(id) =>
		`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
).join('\n');
const COVERED_ITEM = 'FB-001';
const ORPHAN_ITEM = 'FB-002';

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

function gateStatePath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

/** Edit the persisted gate state in place and drop the in-memory cache. */
async function patchPersistedState(
	mutate: (state: Record<string, unknown>) => void,
): Promise<void> {
	const persisted = JSON.parse(await fs.readFile(gateStatePath(), 'utf-8'));
	mutate(persisted);
	await fs.writeFile(gateStatePath(), JSON.stringify(persisted), 'utf-8');
	gateInternals.resetTrackedStateCache();
}

/** `count` filler entries that can never collide with a real ledger key. */
function fillerEntries(count: number, prefix: string): string[] {
	return Array.from({ length: count }, (_value, index) => `${prefix}-${index}`);
}

async function currentState() {
	gateInternals.resetTrackedStateCache();
	return readPrWorkflowGateState(tempDir, SESSION_ID);
}

describe('pr-workflow-gate capacity GC ledger overflow', () => {
	test(
		'a reviewer-session ledger overflow keeps every validation batch',
		async () => {
			await establishReviewPrerequisites();
			// The exact scenario the reclaim test proves succeeds: `rv-first` becomes
			// inert once `rv-winner` lands the same rows, so the GC wants to drop it —
			// and dropping it means retiring its child session for the critic ban.
			for (const batchId of ['rv-first', 'rv-winner']) {
				await recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'reviewer',
					[
						{
							laneId: `${batchId}-lane`,
							workflowLane: `${batchId}-lane`,
							reviewItemIds: REVIEW_ITEM_IDS,
						},
					],
					{ batchId, prHeadSha: HEAD_SHA },
				);
			}
			for (let index = 2; index < MAX_WORKFLOW_BATCHES; index += 1) {
				await recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'reviewer',
					[
						{
							laneId: `rv-${index}-lane`,
							workflowLane: `rv-${index}-lane`,
							reviewItemIds: REVIEW_ITEM_IDS,
						},
					],
					{ batchId: `rv-${index}`, prHeadSha: HEAD_SHA },
				);
			}
			for (const batchId of ['rv-first', 'rv-winner']) {
				await persistBatch(
					batchId,
					'swarm-pr-review:reviewer',
					[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
					{
						textOverride: REVIEWED_ROWS,
						subagentSessionId: `${batchId}-session`,
					},
				);
			}
			await patchPersistedState((state) => {
				state.prReviewRetiredReviewerSessionIds = fillerEntries(
					MAX_RETIRED_REVIEWER_SESSION_IDS,
					'retired-session',
				);
			});

			// Retiring `rv-first` would add a 1025th forbidden session id.
			await expect(
				recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'reviewer',
					[
						{
							laneId: 'blocked-lane',
							workflowLane: 'blocked-lane',
							reviewItemIds: REVIEW_ITEM_IDS,
						},
					],
					{ batchId: 'blocked', prHeadSha: HEAD_SHA },
				),
			).rejects.toThrow('PR_REVIEW validation batch limit reached');
			const state = await currentState();
			expect(state?.prReviewValidationBatches).toHaveLength(
				MAX_WORKFLOW_BATCHES,
			);
			// Kept whole: not one batch dropped, and the ledger untouched.
			expect(state?.prReviewRetiredReviewerSessionIds).toHaveLength(
				MAX_RETIRED_REVIEWER_SESSION_IDS,
			);
			expect(state?.prReviewRetiredReviewerSessionIds).not.toContain(
				'rv-first-session',
			);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'a consolidated-lane ledger overflow keeps every base batch',
		async () => {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			const sourceLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
				laneId: workflowLane,
				workflowLane,
			}));
			await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, sourceLanes, {
				batchId: 'base-source',
				prHeadSha: HEAD_SHA,
			});
			await persistBatch('base-source', 'swarm-pr-review:base', sourceLanes);
			for (let index = 0; index < MAX_WORKFLOW_BATCHES - 1; index += 1) {
				await enforcePrReviewBaseDimensions(
					tempDir,
					SESSION_ID,
					[{ laneId: `inert-${index}-lane`, workflowLane: DIM_A }],
					{ batchId: `inert-${index}`, prHeadSha: HEAD_SHA },
				);
			}
			await patchPersistedState((state) => {
				// `inert-0` is prunable (no delegation record, not the newest), and now
				// carries a consolidated lane, so retiring it must spend a ledger slot.
				const batches = state.prReviewBaseDispatches as Array<{
					batchId: string;
					lanes: Array<Record<string, unknown>>;
				}>;
				const target = batches.find((batch) => batch.batchId === 'inert-0');
				expect(target).toBeDefined();
				(
					target as { lanes: Array<Record<string, unknown>> }
				).lanes[0].ownedWorkflowLanes = [DIM_A, DIM_B];
				state.prReviewRetiredConsolidatedLanes = fillerEntries(
					MAX_RETIRED_CONSOLIDATED_LANES,
					'retired-lane',
				);
			});

			await expect(
				enforcePrReviewBaseDimensions(
					tempDir,
					SESSION_ID,
					[{ laneId: 'blocked-lane', workflowLane: DIM_A }],
					{ batchId: 'blocked', prHeadSha: HEAD_SHA },
				),
			).rejects.toThrow('PR_REVIEW base batch limit reached');
			const state = await currentState();
			expect(state?.prReviewBaseDispatches).toHaveLength(MAX_WORKFLOW_BATCHES);
			expect(state?.prReviewRetiredConsolidatedLanes).toHaveLength(
				MAX_RETIRED_CONSOLIDATED_LANES,
			);
			expect(state?.prReviewRetiredConsolidatedLanes).not.toContain(
				[DIM_A, DIM_B].sort().join('|'),
			);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'a feedback item-ownership ledger overflow keeps every verification batch',
		async () => {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_FEEDBACK');
			await declarePrFeedbackInventory(
				tempDir,
				SESSION_ID,
				[COVERED_ITEM, ORPHAN_ITEM],
				{ prHeadSha: HEAD_SHA },
			);
			await enforcePrFeedbackVerificationOwnership(
				tempDir,
				SESSION_ID,
				[{ laneId: 'verify-a', ownedItemIds: [COVERED_ITEM] }],
				{ batchId: 'covering', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'covering',
				'swarm-pr-feedback:verification',
				[{ laneId: 'verify-a', workflowLane: 'verify-a' }],
				{
					textOverride: `[FEEDBACK-VERIFIED] | ${COVERED_ITEM} | CONFIRMED | evidence`,
				},
			);
			await enforcePrFeedbackVerificationOwnership(
				tempDir,
				SESSION_ID,
				[{ laneId: 'verify-b', ownedItemIds: [ORPHAN_ITEM] }],
				{ batchId: 'orphan-owner', prHeadSha: HEAD_SHA },
			);
			for (let index = 2; index < MAX_WORKFLOW_BATCHES; index += 1) {
				await enforcePrFeedbackVerificationOwnership(
					tempDir,
					SESSION_ID,
					[{ laneId: 'verify-a', ownedItemIds: [COVERED_ITEM] }],
					{ batchId: `retry-${index}`, prHeadSha: HEAD_SHA },
				);
			}
			await patchPersistedState((state) => {
				state.prFeedbackRetiredItemOwnership = Object.fromEntries(
					fillerEntries(MAX_RETIRED_FEEDBACK_ITEM_OWNERS, 'retired-item').map(
						(itemId) => [itemId, 'retired-lane'],
					),
				);
			});

			await expect(
				enforcePrFeedbackVerificationOwnership(
					tempDir,
					SESSION_ID,
					[{ laneId: 'verify-b', ownedItemIds: [ORPHAN_ITEM] }],
					{ batchId: 'blocked', prHeadSha: HEAD_SHA },
				),
			).rejects.toThrow('PR_FEEDBACK verification batch limit reached');
			const state = await currentState();
			expect(state?.prFeedbackVerifications).toHaveLength(MAX_WORKFLOW_BATCHES);
			expect(
				Object.keys(state?.prFeedbackRetiredItemOwnership ?? {}),
			).toHaveLength(MAX_RETIRED_FEEDBACK_ITEM_OWNERS);
			// The binding the prune would have retired is still nowhere but its batch.
			expect(
				state?.prFeedbackRetiredItemOwnership?.[ORPHAN_ITEM],
			).toBeUndefined();
		},
		CAP_TEST_TIMEOUT_MS,
	);
});

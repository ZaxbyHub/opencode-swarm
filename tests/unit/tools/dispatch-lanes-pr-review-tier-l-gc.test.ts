import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	attemptBaseBatch,
	attemptConsolidatedRetry,
	failEntireInitialWave,
	persistBaseLane,
	recordInitialWave,
	SESSION_ID,
	setupTierLFixtures,
	singleton,
	TIER_L_MESSAGE,
	teardownTierLFixtures,
	tierLDirectory,
} from './dispatch-lanes-pr-review-tier-l.test-fixtures.js';

/**
 * Issue #1968 review round 2, FIX D — the tier-L cumulative consolidation
 * floor must be invariant under the capacity GC.
 *
 * `tierLBackingLaneCount` computes a MINIMUM SET COVER of every consolidated
 * lane a wave has ever declared. Before `prReviewRetiredConsolidatedLanes`
 * existed, that cover could only see LIVE `prReviewBaseDispatches` — so once
 * the capacity GC dropped a failed consolidated base batch (which it is
 * entitled to: the batch never produced a successful lane, so it is
 * provably inert by the GC's own inventory-equality proof), the cover's
 * universe shrank and the wave got back consolidation budget it had already
 * spent. This suite drives that exact sequence end-to-end: fill the base
 * batch array to `MAX_WORKFLOW_BATCHES` with a consolidated retry already
 * declared, force a real prune that drops it, and prove the ledger — not the
 * live array — still backs the floor afterwards.
 */

const [DIM_A, DIM_B, DIM_C, DIM_D, DIM_E, DIM_F] = PR_REVIEW_BASE_DIMENSION_IDS;
const { MAX_WORKFLOW_BATCHES } = gateInternals;

/** Mirrors the production `encodeConsolidatedLaneKey` contract exactly: sort
 * the owned dimensions and join with `|`. Computed independently here rather
 * than imported so the assertion pins the durable on-disk key SHAPE, not an
 * implementation dependency the production module happens to expose. */
function expectedConsolidatedLaneKey(owned: readonly string[]): string {
	return [...new Set(owned)].sort().join('|');
}

beforeEach(setupTierLFixtures);
afterEach(teardownTierLFixtures);

describe('PR_REVIEW tier-L consolidation floor survives the capacity GC', () => {
	test('a pruned consolidated batch still counts against the cumulative floor via the retired-lane ledger', async () => {
		await recordInitialWave();
		await failEntireInitialWave();

		// Declare and accept a consolidated retry owning {A, B}. Per-batch this
		// is legal: A and B are both terminally failed with no successful
		// source, and the wave (six dedicated dims minus two consolidated, plus
		// one covering lane = five backing lanes) clears the floor.
		expect(
			await attemptConsolidatedRetry([DIM_A, DIM_B], 'retry-ab'),
		).toBeNull();

		// Fill the base batch array to one below the cap with cheap inert
		// singleton filler batches — never persisted, so none ever supplies a
		// successful lane and every one of them is prunable.
		const fillerCount = MAX_WORKFLOW_BATCHES - 3;
		for (let index = 0; index < fillerCount; index += 1) {
			expect(
				await attemptBaseBatch(
					[{ laneId: `filler-${index}-lane`, workflowLane: DIM_A }],
					`filler-${index}`,
				),
			).toBeNull();
		}

		// The batch that lands exactly at the cap re-establishes terminal
		// failure for C, D, E, F under a NEW batch id. It is the newest base
		// batch when the GC runs moments from now, so the "newest batch is
		// never pruned" rule keeps it alive — which is exactly what lets the
		// {C,D} and {E,F} attempts below still see C/D/E/F as terminally
		// failed even though `base-initial` (their original failure evidence)
		// is about to be pruned out from under them.
		expect(
			await attemptBaseBatch(
				[DIM_C, DIM_D, DIM_E, DIM_F].map((dimension) =>
					singleton(dimension, 'final'),
				),
				'final-cdef',
			),
		).toBeNull();
		for (const dimension of [DIM_C, DIM_D, DIM_E, DIM_F]) {
			await persistBaseLane({
				batchId: 'final-cdef',
				laneId: `final-${dimension}`,
				workflowLane: dimension,
				status: 'error',
			});
		}

		const beforeGc = await readPrWorkflowGateState(
			tierLDirectory(),
			SESSION_ID,
		);
		expect(beforeGc?.prReviewBaseDispatches).toHaveLength(MAX_WORKFLOW_BATCHES);
		expect(
			beforeGc?.prReviewBaseDispatches?.some(
				(batch) => batch.batchId === 'retry-ab',
			),
		).toBe(true);
		expect(beforeGc?.prReviewRetiredConsolidatedLanes ?? []).toEqual([]);

		// One more base dispatch pushes the array to `previous.length >=
		// MAX_WORKFLOW_BATCHES`, which is the ONLY thing that makes
		// `enforcePrReviewBaseDimensions` invoke the capacity GC.
		expect(
			await attemptBaseBatch([singleton(DIM_A, 'trigger')], 'trigger-gc'),
		).toBeNull();

		// EMPIRICAL PROOF the prune actually ran and actually dropped the
		// consolidated batch — never assumed.
		const afterGc = await readPrWorkflowGateState(tierLDirectory(), SESSION_ID);
		const survivingIds = (afterGc?.prReviewBaseDispatches ?? []).map(
			(batch) => batch.batchId,
		);
		expect(survivingIds.length).toBeLessThan(MAX_WORKFLOW_BATCHES);
		expect(survivingIds).not.toContain('retry-ab');
		expect(survivingIds).not.toContain('base-initial');
		expect(survivingIds).toContain('final-cdef');
		expect(survivingIds).toContain('trigger-gc');
		const expectedKey = expectedConsolidatedLaneKey([DIM_A, DIM_B]);
		expect(afterGc?.prReviewRetiredConsolidatedLanes).toEqual([expectedKey]);

		// Rollback: this optional top-level key is written only by the GC, so this
		// is a file a v2 plugin actually produced that carries it. A rolled-back
		// plugin's non-strict reader must still parse it, which is the release
		// note's compatibility claim for every key this change adds.
		const persisted = JSON.parse(
			await fs.readFile(
				path.join(
					tierLDirectory(),
					'.swarm',
					'pr-workflow-gates',
					`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
				),
				'utf-8',
			),
		);
		expect(persisted.prReviewRetiredConsolidatedLanes).toEqual([expectedKey]);
		expect(
			z
				.object({
					schemaVersion: z.literal(1),
					sessionID: z.string().min(1),
					mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
				})
				.passthrough()
				.safeParse(persisted).success,
		).toBe(true);

		// {C, D}: with the retired {A,B} lane still counted, the cover is
		// {A,B} + {C,D} = 2, dedicated E/F = 2, backing = 4 — exactly the
		// floor. Accepted.
		expect(
			await attemptConsolidatedRetry([DIM_C, DIM_D], 'retry-cd'),
		).toBeNull();

		// {E, F}: now the cover is {A,B} + {C,D} + {E,F} = 3 disjoint sets,
		// backing = 0 dedicated + 3 = 3, one short of the floor. THIS is the
		// assertion the retired-lane ledger exists for: without it, the
		// pruned {A,B} batch would be invisible and the cover would be only
		// {C,D} + {E,F} = 2, dedicated A/B = 2, backing = 4 — accepted, and
		// the wave would have quietly regained the consolidation budget it
		// spent on the pruned batch.
		const rejection = await attemptConsolidatedRetry(
			[DIM_E, DIM_F],
			'retry-ef',
		);
		expect(rejection).not.toBeNull();
		expect(rejection?.message).toContain(TIER_L_MESSAGE);
		expect(rejection?.message).toContain(
			'this wave would be backed by only 3 distinct lanes',
		);
		expect(rejection?.message).toContain(
			`at least ${PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR} distinct`,
		);
	}, 60_000);
});

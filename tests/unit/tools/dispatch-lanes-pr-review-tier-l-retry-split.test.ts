import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewBaseCoverageSettled,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR,
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
 * Issue #1968 MUST-FIX 1 — the tier-L lane floor must be CUMULATIVE over the
 * base wave, not per batch.
 *
 * The per-batch clause ("a batch claiming all six dimensions needs at least six
 * lanes") is defeated by splitting one consolidation across two batches: claim
 * five dimensions in a consolidated batch, then the sixth in a *singleton*
 * batch. The singleton batch never reaches the tier-L predicate at all — the
 * predicate only runs when a batch contains a consolidated lane — so every
 * rejection has to happen at the consolidated batch, before the split can
 * complete. That is what these tests pin.
 */

const [DIM_A, DIM_B, DIM_C, DIM_D, DIM_E, DIM_F] = PR_REVIEW_BASE_DIMENSION_IDS;

beforeEach(setupTierLFixtures);
afterEach(teardownTierLFixtures);

describe('PR_REVIEW tier-L cumulative consolidation floor', () => {
	test('the 5-then-1 split is blocked at the consolidated batch', async () => {
		await recordInitialWave();
		await failEntireInitialWave();

		// Batch A claims five of six dimensions across two lanes. Per batch this
		// is legal (five < six, so the all-six clause never fires) and every
		// consolidated dimension is terminally failed with no successful source —
		// the shape that used to be ACCEPTED and left the wave with three
		// producing lanes once a trivial singleton batch B covered the sixth.
		const error = await attemptBaseBatch(
			[
				{
					laneId: 'retry-abc',
					workflowLane: DIM_A,
					ownedWorkflowLanes: [DIM_A, DIM_B, DIM_C],
				},
				{
					laneId: 'retry-de',
					workflowLane: DIM_D,
					ownedWorkflowLanes: [DIM_D, DIM_E],
				},
			],
			'base-retry-five',
		);

		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			'this wave would be backed by only 3 distinct lanes',
		);
		expect(error?.message).toContain(
			`at least ${PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR} distinct`,
		);
		// The dead end is real: with batch A rejected, the split cannot complete.
		await expect(
			assertPrReviewBaseCoverageSettled(tierLDirectory(), SESSION_ID),
		).rejects.toThrow('base coverage is incomplete');
	});

	test('splitting the consolidation across separate batches is still blocked', async () => {
		await recordInitialWave();
		await failEntireInitialWave();

		// Two dimensions per consolidated batch: the first two are accepted, and
		// the third — which would drop the wave to three backing lanes — is not.
		// The floor is measured over DECLARED consolidated lanes, so declaring all
		// three before any of them lands does not evade it.
		expect(
			await attemptConsolidatedRetry([DIM_A, DIM_B], 'retry-ab'),
		).toBeNull();
		expect(
			await attemptBaseBatch(
				[
					{
						laneId: 'retry-cd',
						workflowLane: DIM_C,
						ownedWorkflowLanes: [DIM_C, DIM_D],
					},
				],
				'retry-cd-batch',
			),
		).toBeNull();
		const error = await attemptBaseBatch(
			[
				{
					laneId: 'retry-ef',
					workflowLane: DIM_E,
					ownedWorkflowLanes: [DIM_E, DIM_F],
				},
			],
			'retry-ef-batch',
		);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			'this wave would be backed by only 3 distinct lanes',
		);
	});

	test('singleton re-dispatch is always available after a rejected consolidation', async () => {
		await recordInitialWave();
		await failEntireInitialWave();
		expect(
			await attemptBaseBatch(
				[
					{
						laneId: 'retry-abc',
						workflowLane: DIM_A,
						ownedWorkflowLanes: [DIM_A, DIM_B, DIM_C],
					},
					{
						laneId: 'retry-de',
						workflowLane: DIM_D,
						ownedWorkflowLanes: [DIM_D, DIM_E],
					},
				],
				'base-retry-five',
			),
		).not.toBeNull();

		// The cumulative floor never blocks a full-depth recovery: a batch with no
		// consolidated lane does not reach the tier-L predicate, so re-running the
		// whole wave at one lane per dimension is always allowed and settles.
		expect(
			await attemptBaseBatch(
				PR_REVIEW_BASE_DIMENSION_IDS.map((dimension) =>
					singleton(dimension, 'redo'),
				),
				'base-redo',
			),
		).toBeNull();
		for (const dimension of PR_REVIEW_BASE_DIMENSION_IDS) {
			await persistBaseLane({
				batchId: 'base-redo',
				laneId: `redo-${dimension}`,
				workflowLane: dimension,
			});
		}
		await expect(
			assertPrReviewBaseCoverageSettled(tierLDirectory(), SESSION_ID),
		).resolves.toMatchObject({ sessionID: SESSION_ID });
	});

	test('a consolidated lane superseded by dedicated lanes stops spending budget', async () => {
		await recordInitialWave();
		await failEntireInitialWave();
		// One consolidated retry is declared and then fails outright.
		expect(
			await attemptConsolidatedRetry([DIM_A, DIM_B], 'retry-ab'),
		).toBeNull();
		await persistBaseLane({
			batchId: 'retry-ab',
			laneId: 'retry-consolidated',
			workflowLane: DIM_A,
			ownedWorkflowLanes: [DIM_A, DIM_B],
			status: 'error',
		});
		// Dedicated lanes then cover both of its dimensions successfully.
		expect(
			await attemptBaseBatch(
				[singleton(DIM_A, 'fix'), singleton(DIM_B, 'fix')],
				'base-fix-ab',
			),
		).toBeNull();
		for (const dimension of [DIM_A, DIM_B]) {
			await persistBaseLane({
				batchId: 'base-fix-ab',
				laneId: `fix-${dimension}`,
				workflowLane: dimension,
			});
		}
		// The dead consolidated lane no longer counts against the wave, so a fresh
		// two-dimension consolidation still has budget: four dedicated dimensions
		// (A, B from singletons plus the two the new lane does not claim) plus one
		// consolidated lane = five backing lanes.
		expect(
			await attemptConsolidatedRetry([DIM_C, DIM_D], 'retry-cd'),
		).toBeNull();

		// A THIRD consolidation is what actually discriminates the supersession
		// rule. Counting the superseded {A,B} lane the wave is {A,B} {C,D} {E,F} —
		// a minimum cover of 3 over all six dimensions, no dedicated dimension
		// left, so 3 < 4 and this would be rejected. Dropping it leaves {C,D}
		// {E,F} covering four dimensions plus dedicated A and B = 4, exactly the
		// floor. Without this step both counts (4 vs 5) clear the floor and the
		// supersession branch is invisible.
		expect(
			await attemptConsolidatedRetry([DIM_E, DIM_F], 'retry-ef'),
		).toBeNull();
	});
});

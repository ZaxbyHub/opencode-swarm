import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	attemptBaseBatch,
	attemptConsolidatedRetry,
	HEAD_SHA,
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	persistBaseLane,
	recordInitialWave,
	SESSION_ID,
	setTierLRevisionDigest,
	setupTierLFixtures,
	singleton,
	TIER_L_MESSAGE,
	teardownTierLFixtures,
	tierLDirectory,
} from './dispatch-lanes-pr-review-tier-l.test-fixtures.js';

/**
 * Issue #1968 P3: a tier-L base RETRY batch may consolidate dimensions into one
 * lane only when every consolidated dimension already ran to a terminal,
 * non-successful end, none of them currently has a successful source, and the
 * batch keeps the tier-L lane floors.
 *
 * `dispatch-lanes-pr-workflow-gate.test.ts` is over the FR-006 500-line cap and
 * may not grow, so this sibling hosts the accept/reject matrix. The cumulative
 * (whole-wave) floor added by MUST-FIX 1 lives in
 * `dispatch-lanes-pr-review-tier-l-retry-split.test.ts`.
 */

const [DIM_A, DIM_B, DIM_C, DIM_D, DIM_E, DIM_F] = PR_REVIEW_BASE_DIMENSION_IDS;

beforeEach(setupTierLFixtures);
afterEach(teardownTierLFixtures);

describe('PR_REVIEW tier-L consolidated retry batches', () => {
	test('(a) an initial wave that never completed still rejects a consolidated retry', async () => {
		await recordInitialWave();
		// No delegation records at all: the six lanes were declared and never ran.
		// "No successful source" is trivially true here, which is precisely why the
		// predicate requires a recorded TERMINAL failure instead.
		const error = await attemptConsolidatedRetry([DIM_A, DIM_B]);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			'no recorded lane that reached a terminal non-successful state',
		);
	});

	test('(a2) lanes still in flight reject a consolidated retry', async () => {
		await recordInitialWave();
		// A pending record is a record — but not a terminal one.
		await recordPendingDelegation(tierLDirectory(), {
			correlationId: 'in-flight',
			jobId: null,
			subagentSessionId: 'in-flight',
			parentSessionId: SESSION_ID,
			callID: 'call-in-flight',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'base-initial',
			laneId: `lane-${DIM_A}`,
			mode: 'swarm-pr-review:base',
			workflowLane: DIM_A,
			workspace: {
				directory: tierLDirectory(),
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
		});
		const error = await attemptConsolidatedRetry([DIM_A, DIM_B]);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain('still in flight');
	});

	test('(b) dimensions whose lanes ran and failed accept a consolidated retry', async () => {
		await recordInitialWave();
		await persistBaseLane({
			batchId: 'base-initial',
			laneId: `lane-${DIM_A}`,
			workflowLane: DIM_A,
			status: 'error',
		});
		await persistBaseLane({
			batchId: 'base-initial',
			laneId: `lane-${DIM_B}`,
			workflowLane: DIM_B,
			status: 'error',
		});
		const error = await attemptConsolidatedRetry([DIM_A, DIM_B]);
		expect(error).toBeNull();
		const state = await enforcePrReviewBaseDimensions(
			tierLDirectory(),
			SESSION_ID,
			[singleton(DIM_C, 'later')],
			{ batchId: 'base-later', prHeadSha: HEAD_SHA },
		);
		expect(state.prReviewBaseDispatches?.map((batch) => batch.batchId)).toEqual(
			['base-initial', 'base-retry-consolidated', 'base-later'],
		);
	});

	test('(b3) a consolidated retry actually settles tier-L base coverage', async () => {
		// The point of the exception: re-run only the failed dimensions and still
		// finish, instead of re-dispatching a full six-lane singleton fan-out.
		await recordInitialWave();
		for (const dimension of [DIM_A, DIM_B]) {
			await persistBaseLane({
				batchId: 'base-initial',
				laneId: `lane-${dimension}`,
				workflowLane: dimension,
				status: 'error',
			});
		}
		for (const dimension of [DIM_C, DIM_D, DIM_E, DIM_F]) {
			await persistBaseLane({
				batchId: 'base-initial',
				laneId: `lane-${dimension}`,
				workflowLane: dimension,
			});
		}
		expect(await attemptConsolidatedRetry([DIM_A, DIM_B])).toBeNull();
		await persistBaseLane({
			batchId: 'base-retry-consolidated',
			laneId: 'retry-consolidated',
			workflowLane: DIM_A,
			ownedWorkflowLanes: [DIM_A, DIM_B],
		});
		await expect(
			assertPrReviewBaseCoverageSettled(tierLDirectory(), SESSION_ID),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });
	});

	test('(b2) a completed-but-degraded lane counts as a terminal failure', async () => {
		await recordInitialWave();
		// Status `completed`, but the artifact never reaches the store, so the
		// record fails the integrity chain. Completion alone is not success.
		for (const dimension of [DIM_A, DIM_B]) {
			const correlationId = `degraded-${dimension}`;
			await recordPendingDelegation(tierLDirectory(), {
				correlationId,
				jobId: null,
				subagentSessionId: correlationId,
				parentSessionId: SESSION_ID,
				callID: `call-${correlationId}`,
				normalizedAgent: 'explorer',
				swarmPrefixedAgent: 'explorer',
				planTaskId: null,
				evidenceTaskId: null,
				batchId: 'base-initial',
				laneId: `lane-${dimension}`,
				mode: 'swarm-pr-review:base',
				workflowLane: dimension,
				workspace: {
					directory: tierLDirectory(),
					gitHead: HEAD_SHA,
					dirtyHash: null,
					prHeadSha: HEAD_SHA,
					scope: null,
				},
			});
			await appendDelegationTransition(tierLDirectory(), correlationId, {
				status: 'completed',
				result: { text: '', chars: 0, truncated: true, digest: '' },
			});
		}
		expect(await attemptConsolidatedRetry([DIM_A, DIM_B])).toBeNull();
	});

	test('(c) a dimension with a successful singleton rejects a consolidated retry', async () => {
		await recordInitialWave();
		await persistBaseLane({
			batchId: 'base-initial',
			laneId: `lane-${DIM_A}`,
			workflowLane: DIM_A,
		});
		await persistBaseLane({
			batchId: 'base-initial',
			laneId: `lane-${DIM_B}`,
			workflowLane: DIM_B,
			status: 'error',
		});
		const error = await attemptConsolidatedRetry([DIM_A, DIM_B]);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain('already have a successful source');
		expect(error?.message).toContain(DIM_A);
	});

	test('a worktree edit alone never unlocks consolidation', async () => {
		await recordInitialWave();
		for (const dimension of PR_REVIEW_BASE_DIMENSION_IDS) {
			await persistBaseLane({
				batchId: 'base-initial',
				laneId: `lane-${dimension}`,
				workflowLane: dimension,
			});
		}
		// Every artifact is now stale against the current revision, so nothing has
		// a *successful* source any more. Failure is deliberately derived from the
		// revision-independent record integrity chain, so the six lanes are still
		// not failed and consolidation stays closed.
		setTierLRevisionDigest('revision-after-a-whitespace-edit');
		const error = await attemptConsolidatedRetry([DIM_A, DIM_B]);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			'no recorded lane that reached a terminal non-successful state',
		);
	});

	test('the tier-L lane floor survives: one lane may never own all six', async () => {
		await recordInitialWave();
		for (const dimension of PR_REVIEW_BASE_DIMENSION_IDS) {
			await persistBaseLane({
				batchId: 'base-initial',
				laneId: `lane-${dimension}`,
				workflowLane: dimension,
				status: 'error',
			});
		}
		const error = await attemptConsolidatedRetry([
			...PR_REVIEW_BASE_DIMENSION_IDS,
		]);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain('owns all 6 dimensions on its own');
	});

	test('the tier-L lane floor survives: a full-coverage retry needs six lanes', async () => {
		await recordInitialWave();
		for (const dimension of PR_REVIEW_BASE_DIMENSION_IDS) {
			await persistBaseLane({
				batchId: 'base-initial',
				laneId: `lane-${dimension}`,
				workflowLane: dimension,
				status: 'error',
			});
		}
		const error = await attemptBaseBatch(
			[
				{
					laneId: 'retry-abc',
					workflowLane: DIM_A,
					ownedWorkflowLanes: [DIM_A, DIM_B, DIM_C],
				},
				{
					laneId: 'retry-def',
					workflowLane: DIM_D,
					ownedWorkflowLanes: [DIM_D, DIM_E, DIM_F],
				},
			],
			'base-retry-two-lanes',
		);
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			'claims all 6 dimensions with only 2 lanes',
		);
	});

	test('P3.2: at tier L a successful singleton outranks a consolidated source', async () => {
		await activatePrWorkflow(tierLDirectory(), SESSION_ID, 'PR_REVIEW');
		// 1. Both dimensions run and fail, unlocking a consolidated retry.
		await enforcePrReviewBaseDimensions(
			tierLDirectory(),
			SESSION_ID,
			[singleton(DIM_A, 'fail'), singleton(DIM_B, 'fail')],
			{
				batchId: 'base-failed',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistBaseLane({
			batchId: 'base-failed',
			laneId: `fail-${DIM_A}`,
			workflowLane: DIM_A,
			status: 'error',
		});
		await persistBaseLane({
			batchId: 'base-failed',
			laneId: `fail-${DIM_B}`,
			workflowLane: DIM_B,
			status: 'error',
		});
		// 2. A singleton retry for DIM_A is declared but has not landed yet — the
		//    only order in which both source classes can coexist, because a
		//    dimension with a live successful source may not be consolidated over.
		await enforcePrReviewBaseDimensions(
			tierLDirectory(),
			SESSION_ID,
			[singleton(DIM_A, 'single')],
			{ batchId: 'base-singleton-a', prHeadSha: HEAD_SHA },
		);
		// 3. The consolidated retry is declared and lands first.
		expect(await attemptConsolidatedRetry([DIM_A, DIM_B])).toBeNull();
		await persistBaseLane({
			batchId: 'base-retry-consolidated',
			laneId: 'retry-consolidated',
			workflowLane: DIM_A,
			ownedWorkflowLanes: [DIM_A, DIM_B],
			candidateIds: ['CONSOLIDATED-A', 'CONSOLIDATED-B'],
		});
		// 4. The older singleton's record completes late.
		await persistBaseLane({
			batchId: 'base-singleton-a',
			laneId: `single-${DIM_A}`,
			workflowLane: DIM_A,
			candidateIds: ['SINGLETON-A'],
		});

		const inventory = await gateInternals.derivePrReviewCandidateInventory(
			tierLDirectory(),
			SESSION_ID,
		);
		// Most-recent-wins alone would have credited the consolidated lane for
		// DIM_A. Tier L prefers the singleton, which is the lane that actually
		// satisfied the tier's per-dimension depth contract; the consolidated lane
		// is still the source for the dimension nothing else covers.
		expect(inventory).toContain('SINGLETON-A');
		expect(inventory).toContain('CONSOLIDATED-B');
		expect(inventory).not.toContain('CONSOLIDATED-A');
	});
});

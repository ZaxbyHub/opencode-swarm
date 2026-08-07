import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
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
 * Issue #1968, the headline fail-closed guarantee of the composable accounting:
 * "a batch can only contribute verdicts for the exact inventory it was validated
 * against". Item-keyed composition means a reviewer batch's rows are matched by
 * candidate id, so without the inventory-equality clause in
 * `batchMayContributeClaims` a reviewer wave that reviewed a WIDER inventory
 * would silently keep settling a narrower one — the reviewer never saw the
 * narrowing, and per-item matching alone cannot notice, because every surviving
 * item does have a row.
 *
 * The narrowing here is driven entirely through real gate entry points: a base
 * retry re-claims one dimension and emits fresh candidates, then a second retry
 * on the same dimension comes back clean and withdraws them.
 */

const [DIM_0] = PR_REVIEW_BASE_DIMENSION_IDS;
const CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
/** The five candidates `base-all` contributes for dimensions 1..5. */
const SURVIVING_IDS = PR_REVIEW_BASE_DIMENSION_IDS.slice(1).map(
	(_dimension, index) => `C-${index + 1}`,
);
const WITHDRAWN_IDS = ['X-1', 'X-2', 'X-3'];

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const reviewed = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe | reviewer`,
		)
		.join('\n');

/** Re-dispatch dimension 0 alone, superseding whatever claimed it before. */
async function retryDimensionZero(
	batchId: string,
	text: string,
): Promise<void> {
	const lane = { laneId: `${batchId}-lane`, workflowLane: DIM_0 };
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
		batchId,
		prHeadSha: HEAD_SHA,
	});
	await persistBatch(batchId, 'swarm-pr-review:base', [lane], {
		textOverride: text,
	});
}

async function reviewerInventory(): Promise<string[]> {
	const composed = await gateInternals.composePrReviewPhaseVerdicts(
		tempDir,
		SESSION_ID,
		'reviewer',
	);
	return composed.requiredInventory;
}

describe('pr-workflow-gate reviewer batch inventory binding', () => {
	test('a reviewer batch stops contributing once the inventory it was validated against shrinks', async () => {
		await establishReviewPrerequisites();

		// Widen: dimension 0 comes back with three fresh candidates, superseding
		// `base-all`'s dimension-0 lane (and so its C-0).
		await retryDimensionZero(
			'base-widen',
			[
				CANDIDATE_HEADER,
				...WITHDRAWN_IDS.map(
					(id, index) =>
						`${id} | ${DIM_0} | HIGH | correctness | file.ts:${index + 1} | claim ${id} | evidence ${id} | impact ${id} | HIGH`,
				),
			].join('\n'),
		);
		const wide = await reviewerInventory();
		expect([...wide].sort()).toEqual(
			[...SURVIVING_IDS, ...WITHDRAWN_IDS].sort(),
		);

		// One reviewer lane reviews all eight and fully succeeds.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[{ laneId: 'rv-wide-a', workflowLane: 'rv-wide-a', reviewItemIds: wide }],
			{ batchId: 'rv-wide', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'rv-wide',
			'swarm-pr-review:reviewer',
			[{ laneId: 'rv-wide-a', workflowLane: 'rv-wide-a' }],
			{ textOverride: reviewed(wide), subagentSessionId: 'rv-wide-session' },
		);
		// Positive control: against the inventory it WAS validated against, this
		// same batch settles. Everything that changes below is the inventory.
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		// Narrow: dimension 0 is re-dispatched once more and comes back clean, so
		// X-1..X-3 leave the candidate inventory. `rv-wide` still holds a
		// byte-identical [REVIEWED] row for every one of the five survivors, so
		// per-item matching alone cannot tell that anything changed.
		await retryDimensionZero(
			'base-narrow',
			[
				CANDIDATE_HEADER,
				`[CLEAN] | ${DIM_0} | exact reviewed diff | no finding after focused invariant review`,
			].join('\n'),
		);
		expect([...(await reviewerInventory())].sort()).toEqual(
			[...SURVIVING_IDS].sort(),
		);

		const error = await assertPrReviewValidationSettled(
			tempDir,
			SESSION_ID,
			'reviewer',
		).then(
			() => null,
			(reason: unknown) => reason as Error,
		);
		// Named explicitly so a regression that lets `rv-wide` keep contributing
		// reports "settled against the narrowed inventory" rather than an opaque
		// undefined-message mismatch.
		expect(
			error?.message ?? 'settled against the narrowed inventory',
		).toContain(
			`reviewer items lack an authenticated verdict from any successful lane: ${SURVIVING_IDS.join(', ')}`,
		);
		expect(error?.message ?? '').toContain(
			'reviewer batch "rv-wide" was validated against a different inventory',
		);
		// And the batch really is excluded from the composition, not merely
		// reported: no surviving item may carry a claim from it.
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.contributingBatchIds).toEqual([]);
		for (const id of SURVIVING_IDS) {
			expect(composed.claims.get(id)).toBeUndefined();
		}
	});

	test('a reviewer batch re-validated against the narrowed inventory contributes again', async () => {
		await establishReviewPrerequisites();
		await retryDimensionZero(
			'base-widen',
			[
				CANDIDATE_HEADER,
				...WITHDRAWN_IDS.map(
					(id, index) =>
						`${id} | ${DIM_0} | HIGH | correctness | file.ts:${index + 1} | claim ${id} | evidence ${id} | impact ${id} | HIGH`,
				),
			].join('\n'),
		);
		const wide = await reviewerInventory();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[{ laneId: 'rv-wide-a', workflowLane: 'rv-wide-a', reviewItemIds: wide }],
			{ batchId: 'rv-wide', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'rv-wide',
			'swarm-pr-review:reviewer',
			[{ laneId: 'rv-wide-a', workflowLane: 'rv-wide-a' }],
			{ textOverride: reviewed(wide), subagentSessionId: 'rv-wide-session' },
		);
		await retryDimensionZero(
			'base-narrow',
			[
				CANDIDATE_HEADER,
				`[CLEAN] | ${DIM_0} | exact reviewed diff | no finding after focused invariant review`,
			].join('\n'),
		);

		// The recovery path the clause leaves open: re-declare a reviewer batch
		// against the inventory in force now. Nothing about the artifact content
		// changes — only what the batch was validated against — so this isolates
		// the inventory binding from every other admission rule.
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'rv-narrow-a',
					workflowLane: 'rv-narrow-a',
					reviewItemIds: SURVIVING_IDS,
				},
			],
			{ batchId: 'rv-narrow', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'rv-narrow',
			'swarm-pr-review:reviewer',
			[{ laneId: 'rv-narrow-a', workflowLane: 'rv-narrow-a' }],
			{
				textOverride: reviewed(SURVIVING_IDS),
				subagentSessionId: 'rv-narrow-session',
			},
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.contributingBatchIds).toEqual(['rv-narrow']);
	});
});

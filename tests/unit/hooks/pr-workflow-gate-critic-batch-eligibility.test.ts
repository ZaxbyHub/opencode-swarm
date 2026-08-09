import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	assertPrReviewValidationSettled,
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
 * Issue #1968 MUST-FIX 2 — `batchMayContributeClaims` exempts critic batches
 * from batch-level `validatedInventory` set-equality on purpose, because a
 * critic batch is filtered per item by `reviewerItemBindings` instead.
 *
 * That exemption had zero discriminating coverage: deleting `phase === 'critic'
 * ||` left every PR-workflow test green. The discriminating state is a critic
 * batch whose `validatedInventory` is a strict SUPERSET of the live critic
 * inventory — one item left the inventory while its siblings' reviewer rows
 * stayed byte-identical. Batch-level equality discards the whole batch there,
 * which is precisely the batch-granularity failure the item-keyed composition
 * exists to remove.
 */

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

const BASE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

const reviewed = (
	ids: readonly string[],
	classification = 'CONFIRMED',
	severity = 'HIGH',
	rationale = 'rationale',
): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | ${classification} | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | ${rationale} | probe | reviewer`,
		)
		.join('\n');

const criticised = (ids: readonly string[]): string =>
	ids
		.map((id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | required change`)
		.join('\n');

/** Declare a single-lane reviewer batch owning every item and land its rows. */
async function reviewerBatch(batchId: string, rows: string): Promise<void> {
	const laneId = `${batchId}-a`;
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[{ laneId, workflowLane: laneId, reviewItemIds: BASE_IDS }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId, workflowLane: laneId }],
		{ textOverride: rows, subagentSessionId: `${batchId}-${laneId}` },
	);
}

/**
 * Reviewer settles all six CONFIRMED/HIGH, a critic batch covers all six and
 * settles. Leaves the critic batch's `validatedInventory` equal to all six.
 */
async function settleSixThenCritic(): Promise<void> {
	await establishReviewPrerequisites();
	await reviewerBatch('rv-1', reviewed(BASE_IDS));
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'critic',
		[
			{
				laneId: 'critic-all',
				workflowLane: 'critic-all',
				reviewItemIds: BASE_IDS,
			},
		],
		{ batchId: 'critic-all', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'critic-all',
		'swarm-pr-review:critic',
		[{ laneId: 'critic-all', workflowLane: 'critic-all' }],
		{ textOverride: criticised(BASE_IDS) },
	);
	await expect(
		assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
	).resolves.toMatchObject({ mode: 'PR_REVIEW' });
}

function gateStatePath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

/**
 * Strip a batch's coherence entry so it is indistinguishable from state an
 * older plugin wrote: no `validatedInventory`, and — the part that matters
 * here — no `reviewerItemBindings`, so nothing can decide per item whether its
 * critic claims went stale.
 */
async function makeBatchLegacy(batchId: string): Promise<void> {
	const persisted = JSON.parse(await fs.readFile(gateStatePath(), 'utf-8'));
	delete (persisted.prReviewBatchCoherence as Record<string, unknown>)[batchId];
	await fs.writeFile(gateStatePath(), JSON.stringify(persisted), 'utf-8');
	gateInternals.resetTrackedStateCache();
}

/** Declare a single-lane critic batch owning every item and land its rows. */
async function criticBatch(batchId: string): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'critic',
		[{ laneId: batchId, workflowLane: batchId, reviewItemIds: BASE_IDS }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		batchId,
		'swarm-pr-review:critic',
		[{ laneId: batchId, workflowLane: batchId }],
		{ textOverride: criticised(BASE_IDS), subagentSessionId: batchId },
	);
}

async function validationBatchIds(): Promise<string[]> {
	gateInternals.resetTrackedStateCache();
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	return (state?.prReviewValidationBatches ?? []).map((batch) => batch.batchId);
}

describe('pr-workflow-gate critic batch eligibility', () => {
	test('a critic batch survives an item leaving the critic inventory', async () => {
		await settleSixThenCritic();

		// Re-review: C-0 drops to DISPROVED/LOW and therefore leaves the critic
		// inventory; C-1..C-5 rows are re-emitted BYTE-IDENTICALLY, so their row
		// digests still match the critic batch's bindings.
		await reviewerBatch(
			'rv-2',
			`${reviewed([BASE_IDS[0]], 'DISPROVED', 'LOW')}\n${reviewed(BASE_IDS.slice(1))}`,
		);
		// The critic batch was validated against all six, so its recorded
		// `validatedInventory` is now a strict superset of the live inventory.
		// Batch-level set-equality would discard the whole batch and block the
		// critic phase; the per-item bindings admit the five survivors.
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'critic',
		);
		expect(composed.requiredInventory).toEqual(BASE_IDS.slice(1));
		expect([...composed.claims.keys()].sort()).toEqual(BASE_IDS.slice(1));
		expect(composed.contributingBatchIds).toEqual(['critic-all']);
	});

	test('a sibling whose reviewer row changed is still rejected', async () => {
		await settleSixThenCritic();

		// The negative twin of the case above, in the same superset-inventory
		// state: C-0 leaves the inventory AND C-1's reviewer row changes (same
		// classification and severity, revised rationale — so `parseCriticVerdict`
		// alone would still accept the stale critic row). Only the full-row digest
		// distinguishes it.
		await reviewerBatch(
			'rv-2',
			[
				reviewed([BASE_IDS[0]], 'DISPROVED', 'LOW'),
				reviewed([BASE_IDS[1]], 'CONFIRMED', 'HIGH', 'revised root cause'),
				reviewed(BASE_IDS.slice(2)),
			].join('\n'),
		);
		const error = await assertPrReviewValidationSettled(
			tempDir,
			SESSION_ID,
			'critic',
		).then(
			() => null,
			(reason: unknown) => reason as Error,
		);
		expect(error?.message).toContain(
			`critic items lack an authenticated verdict from any successful lane: ${BASE_IDS[1]}`,
		);
		for (const survivor of BASE_IDS.slice(2)) {
			expect(error?.message).not.toContain(survivor);
		}
	});

	test('a newer reviewer batch invalidates legacy critic batches and keeps bound ones', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch('rv-1', reviewed(BASE_IDS));
		await criticBatch('critic-bound');
		await criticBatch('critic-legacy');
		await makeBatchLegacy('critic-legacy');
		expect(await validationBatchIds()).toEqual([
			'rv-1',
			'critic-bound',
			'critic-legacy',
		]);

		// Byte-identical re-review, so the BOUND batch's per-item row digests all
		// still match and it stays authoritative. The LEGACY batch carries no
		// bindings, so nothing could decide that per item — the pre-existing
		// blanket rule (any new reviewer batch invalidates it) is the only thing
		// standing between it and the binding-free legacy admission path.
		await reviewerBatch('rv-2', reviewed(BASE_IDS));
		expect(await validationBatchIds()).toEqual([
			'rv-1',
			'critic-bound',
			'rv-2',
		]);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'critic',
		);
		expect(composed.contributingBatchIds).toEqual(['critic-bound']);
	});

	test('a retained legacy critic batch would survive reviewer rows it never challenged', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch('rv-1', reviewed(BASE_IDS));
		await criticBatch('critic-legacy');
		await makeBatchLegacy('critic-legacy');
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		// Every reviewer row is re-emitted with a revised rationale — same
		// classification and severity, so `parseCriticVerdict` alone still accepts
		// the stale critic rows, and the legacy admission path has no row digest to
		// notice with. Only dropping the batch outright keeps this fail-closed.
		await reviewerBatch(
			'rv-2',
			reviewed(BASE_IDS, 'CONFIRMED', 'HIGH', 'revised root cause'),
		);
		const error = await assertPrReviewValidationSettled(
			tempDir,
			SESSION_ID,
			'critic',
		).then(
			() => null,
			(reason: unknown) => reason as Error,
		);
		expect(error?.message ?? 'settled on unchallenged reviewer rows').toContain(
			'BLOCKED: PR_REVIEW requires at least one critic batch',
		);
		expect(await validationBatchIds()).not.toContain('critic-legacy');
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts,
	assertPrReviewValidationSettled,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	prWorkflowSessionFileStem,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
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

const BASE_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

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

function gateStatePath(): string {
	return path.join(
		tempDir,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
	);
}

async function readPersistedState(): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(gateStatePath(), 'utf-8'));
}

/** Strip coherence entries so the batch is indistinguishable from v1 state. */
async function makeBatchesLegacy(...batchIds: string[]): Promise<void> {
	const state = await readPersistedState();
	const entries = state.prReviewBatchCoherence as Record<string, unknown>;
	for (const batchId of batchIds) delete entries[batchId];
	await writeAuthoritativePrWorkflowState(
		tempDir,
		state as {
			sessionID: string;
			revision: number;
			mode: string;
			[key: string]: unknown;
		},
	);
	gateInternals.resetTrackedStateCache();
}

/** Declare a reviewer batch and persist only the named lanes' artifacts. */
async function reviewerBatch(
	batchId: string,
	lanes: ReadonlyArray<{ laneId: string; reviewItemIds: string[] }>,
	successful: ReadonlyArray<{ laneId: string; rows: string }>,
): Promise<void> {
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		lanes.map((lane) => ({ ...lane, workflowLane: lane.laneId })),
		{ batchId, prHeadSha: HEAD_SHA },
	);
	for (const { laneId, rows } of successful) {
		await persistBatch(
			batchId,
			'swarm-pr-review:reviewer',
			[{ laneId, workflowLane: laneId }],
			{ textOverride: rows, subagentSessionId: `${batchId}-${laneId}` },
		);
	}
}

/**
 * Fifty candidates. A base retry re-claims dimension 0 with 45 fresh
 * candidates, superseding `base-all`'s dimension-0 lane — which therefore loses
 * its authoritative source and its `C-0` — leaving C-1..C-5 plus I-01..I-45.
 */
async function establishFiftyItemInventory(): Promise<string[]> {
	await establishReviewPrerequisites();
	const [dimension] = PR_REVIEW_BASE_DIMENSION_IDS;
	const lane = { laneId: 'retry-dim0', workflowLane: dimension };
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
		batchId: 'base-retry-dim0',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('base-retry-dim0', 'swarm-pr-review:base', [lane], {
		textOverride: [
			CANDIDATE_HEADER,
			...Array.from({ length: 45 }, (_value, index) => {
				const id = `I-${String(index + 1).padStart(2, '0')}`;
				return `${id} | ${dimension} | HIGH | correctness | file.ts:${index + 1} | claim ${id} | evidence ${id} | impact ${id} | HIGH | ORDINARY | `;
			}),
		].join('\n'),
	});
	const composed = await gateInternals.composePrReviewPhaseVerdicts(
		tempDir,
		SESSION_ID,
		'reviewer',
	);
	expect(composed.requiredInventory).toHaveLength(50);
	// Falsifies the supersession claim above rather than trusting it.
	expect(composed.requiredInventory).not.toContain('C-0');
	expect(composed.requiredInventory).toContain('C-1');
	expect(composed.requiredInventory).toContain('I-45');
	return composed.requiredInventory;
}

describe('pr-workflow-gate item-keyed reviewer/critic coherence', () => {
	test('composition blocks on the admitted gap two partial batches leave', async () => {
		const items = await establishFiftyItemInventory();
		const first = items.slice(0, 25);
		const gap = items.slice(25, 45);
		const last = items.slice(45);
		await reviewerBatch(
			'rv-1',
			[
				{ laneId: 'rv-1-a', reviewItemIds: first },
				{ laneId: 'rv-1-b', reviewItemIds: [...gap, ...last] },
			],
			[{ laneId: 'rv-1-a', rows: reviewed(first) }],
		);
		await reviewerBatch(
			'rv-2',
			[
				{ laneId: 'rv-2-a', reviewItemIds: [...first, ...gap] },
				{ laneId: 'rv-2-b', reviewItemIds: last },
			],
			[{ laneId: 'rv-2-b', rows: reviewed(last) }],
		);
		const error = await assertPrReviewValidationSettled(
			tempDir,
			SESSION_ID,
			'reviewer',
		).then(
			() => null,
			(reason: unknown) => reason as Error,
		);
		expect(error?.message).toContain(
			`reviewer items lack an authenticated verdict from any successful lane: ${gap.join(', ')}`,
		);
		for (const claimed of [...first, ...last]) {
			expect(error?.message).not.toContain(`${claimed},`);
		}
	});

	test('the most recent successful lane wins, and derivation agrees', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch(
			'rv-old',
			[{ laneId: 'rv-old-a', reviewItemIds: BASE_IDS }],
			[{ laneId: 'rv-old-a', rows: reviewed(BASE_IDS) }],
		);
		// A later batch re-reviews everything but only its C-0 lane succeeds.
		await reviewerBatch(
			'rv-new',
			[
				{ laneId: 'rv-new-a', reviewItemIds: [BASE_IDS[0]] },
				{ laneId: 'rv-new-b', reviewItemIds: BASE_IDS.slice(1) },
			],
			[
				{
					laneId: 'rv-new-a',
					rows: reviewed([BASE_IDS[0]], 'DISPROVED', 'NONE'),
				},
			],
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// Provenance names the exact winning lane, not just the batch.
		expect(composed.claims.get(BASE_IDS[0])).toMatchObject({
			batchId: 'rv-new',
			laneId: 'rv-new-a',
			workflowLane: 'rv-new-a',
			classification: 'DISPROVED',
			severity: 'NONE',
		});
		expect(composed.claims.get(BASE_IDS[1])).toMatchObject({
			batchId: 'rv-old',
			laneId: 'rv-old-a',
			workflowLane: 'rv-old-a',
			classification: 'CONFIRMED',
		});
		// Derivation must pick the same winner: C-0 is DISPROVED/NONE, so it is
		// out of the critic inventory while its five siblings stay in.
		await expect(
			recordPrReviewValidationBatch(
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
			),
		).rejects.toThrow(`extra: ${BASE_IDS[0]}`);
		await expect(
			recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'critic',
				[
					{
						laneId: 'critic-rest',
						workflowLane: 'critic-rest',
						reviewItemIds: BASE_IDS.slice(1),
					},
				],
				{ batchId: 'critic-rest', prHeadSha: HEAD_SHA },
			),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});

	test('a composed reviewer phase can never settle with an empty critic inventory', async () => {
		await establishReviewPrerequisites();
		const halves = [BASE_IDS.slice(0, 3), BASE_IDS.slice(3)];
		for (const [index, half] of halves.entries()) {
			await reviewerBatch(
				`rv-${index}`,
				[
					{ laneId: `rv-${index}-a`, reviewItemIds: halves[0] },
					{ laneId: `rv-${index}-b`, reviewItemIds: halves[1] },
				],
				[
					{
						laneId: `rv-${index}-${index === 0 ? 'a' : 'b'}`,
						rows: reviewed(half),
					},
				],
			);
		}
		// Neither batch is wholly successful, so the pre-fix derivation returned
		// an empty map while settlement blocked. Settlement is now the same
		// computation, so it cannot pass without CONFIRMED/HIGH verdicts being
		// visible to the critic-inventory derivation.
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		await expect(
			completePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'APPROVE',
			}),
		).rejects.toThrow(`require critic coverage for: ${BASE_IDS.join(', ')}`);
	});

	test('one item losing its reviewer row leaves its critic lane siblings intact', async () => {
		await establishReviewPrerequisites();
		const challenged = BASE_IDS.slice(0, 3);
		const suppressed = BASE_IDS.slice(3);
		const rows = (rationale: string) =>
			`${reviewed(challenged, 'CONFIRMED', 'HIGH', rationale)}\n${reviewed(suppressed, 'DISPROVED', 'NONE')}`;
		await reviewerBatch(
			'rv-1',
			[{ laneId: 'rv-1-a', reviewItemIds: BASE_IDS }],
			[{ laneId: 'rv-1-a', rows: rows('rationale') }],
		);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-three',
					workflowLane: 'critic-three',
					reviewItemIds: challenged,
				},
			],
			{ batchId: 'critic-three', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'critic-three',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-three', workflowLane: 'critic-three' }],
			{ textOverride: criticised(challenged) },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });

		// Re-review: only C-0's row changes, and only in its rationale — same
		// classification, same severity, so parseCriticVerdict still accepts the
		// old critic row and a CLASSIFICATION|SEVERITY tuple would still match.
		await reviewerBatch(
			'rv-2',
			[{ laneId: 'rv-2-a', reviewItemIds: BASE_IDS }],
			[
				{
					laneId: 'rv-2-a',
					rows: `${reviewed([challenged[0]], 'CONFIRMED', 'HIGH', 'revised root cause')}\n${reviewed(challenged.slice(1))}\n${reviewed(suppressed, 'DISPROVED', 'NONE')}`,
				},
			],
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
			`critic items lack an authenticated verdict from any successful lane: ${challenged[0]}`,
		);
		for (const survivor of challenged.slice(1)) {
			expect(error?.message).not.toContain(survivor);
		}
	});

	test('an abandoned declared lane is a diagnostic, not a block', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch(
			'rv-covered',
			[{ laneId: 'rv-covered-a', reviewItemIds: BASE_IDS }],
			[{ laneId: 'rv-covered-a', rows: reviewed(BASE_IDS) }],
		);
		// A later batch declares a second lane over the whole inventory and never
		// completes it. Every item is already covered, so settlement passes.
		await reviewerBatch(
			'rv-abandoned',
			[{ laneId: 'rv-abandoned-a', reviewItemIds: BASE_IDS }],
			[],
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		const composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual([]);
		expect(composed.diagnostics).toContain(
			'declared reviewer lane "rv-abandoned-a" produced no successful exact artifact',
		);
		expect(composed.contributingBatchIds).toEqual(['rv-covered']);
	});

	test('an unclaimed item blocks settlement and empties every derivation', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch(
			'rv-short',
			[{ laneId: 'rv-short-a', reviewItemIds: BASE_IDS }],
			[{ laneId: 'rv-short-a', rows: reviewed(BASE_IDS.slice(0, -1)) }],
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow(
			`reviewer items lack an authenticated verdict from any successful lane: ${BASE_IDS.at(-1)}`,
		);
		// This gate is exported and does NOT settle first, so the derivation
		// itself must stay empty rather than project the five claims that did
		// parse onto artifact records.
		await expect(
			assertPrReviewArtifactRecordsMatchAuthoritativeVerdicts(
				tempDir,
				SESSION_ID,
				'post_reviewer',
				[
					{
						finding_id: BASE_IDS[0],
						status: 'CONFIRMED',
						next_action: 'route_to_critic',
					},
				],
			),
		).rejects.toThrow(
			`${BASE_IDS[0]}: no authoritative reviewer verdict (absent from the settled reviewer map)`,
		);
	});

	test('legacy batches without coherence keys stay on the stricter old rule', async () => {
		await establishReviewPrerequisites();
		const halves = [BASE_IDS.slice(0, 3), BASE_IDS.slice(3)];
		await reviewerBatch(
			'rv-legacy',
			[{ laneId: 'rv-legacy-a', reviewItemIds: BASE_IDS }],
			[{ laneId: 'rv-legacy-a', rows: reviewed(BASE_IDS) }],
		);
		await reviewerBatch(
			'rv-modern',
			[
				{ laneId: 'rv-modern-a', reviewItemIds: halves[0] },
				{ laneId: 'rv-modern-b', reviewItemIds: halves[1] },
			],
			[
				{
					laneId: 'rv-modern-a',
					rows: reviewed(halves[0], 'DISPROVED', 'NONE'),
				},
			],
		);
		// Mixed state: the legacy batch is wholly successful over the exact
		// inventory, so it stays eligible; the modern partial batch contributes
		// its one successful lane and wins those items.
		await makeBatchesLegacy('rv-legacy');
		let composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual([]);
		expect(composed.claims.get(halves[0][0])?.batchId).toBe('rv-modern');
		expect(composed.claims.get(halves[1][0])?.batchId).toBe('rv-legacy');

		// Demote the modern partial batch to legacy too: it is no longer wholly
		// successful, so the legacy predicate refuses it entirely and the legacy
		// full batch wins every item. Legacy state can never loosen.
		await makeBatchesLegacy('rv-modern');
		composed = await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.unclaimed).toEqual([]);
		expect(composed.contributingBatchIds).toEqual(['rv-legacy']);
		expect(composed.claims.get(halves[0][0])?.classification).toBe('CONFIRMED');
	});

	test('a v1 plugin still parses state a v2 plugin wrote', async () => {
		await establishReviewPrerequisites();
		await reviewerBatch(
			'rv-1',
			[{ laneId: 'rv-1-a', reviewItemIds: BASE_IDS }],
			[{ laneId: 'rv-1-a', rows: reviewed(BASE_IDS) }],
		);
		const persisted = await readPersistedState();
		expect(persisted.prReviewBatchCoherence).toBeDefined();
		// Exactly the pre-change shape: a .strict() batch record under a
		// .passthrough() parent. A rolled-back plugin reads this file on every
		// gate call, including the abort escape hatch.
		const v1Lane = z
			.object({
				laneId: z.string().min(1),
				workflowLane: z.string().min(1),
				reviewItemIds: z.array(z.string().min(1)).min(1).optional(),
			})
			.strict();
		const v1Batch = z
			.object({
				batchId: z.string().min(1),
				phase: z.enum(['council', 'reviewer', 'critic']),
				lanes: z.array(v1Lane).min(1),
				validatedAt: z.string().min(1),
			})
			.strict();
		const v1Schema = z
			.object({
				schemaVersion: z.literal(1),
				revision: z.number().int().nonnegative().default(0),
				sessionID: z.string().min(1),
				mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
				activatedAt: z.string().min(1),
				updatedAt: z.string().min(1),
				prReviewValidationBatches: z.array(v1Batch).optional(),
			})
			.passthrough();
		const parsed = v1Schema.safeParse(persisted);
		expect(parsed.success).toBe(true);
		expect(
			(parsed.data as Record<string, unknown>).prReviewBatchCoherence,
		).toBeDefined();
	});
});

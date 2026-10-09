import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
	readPrReviewVerdictSettlementEffectiveIds,
	readPrReviewVerdictSettlementReceiptItems,
	recordPrReviewValidationBatch,
	resolvePrReviewWriterRunId,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	deriveVerdictSettlementAdmission,
	PR_REVIEW_VERDICT_RETRY_BUDGET,
} from '../../../src/pr-review/verdict-settlement.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

// Issue #3101 acceptance checks C1/C3/C4 (frozen -t filters: "N-of-M exit",
// "downgrade-only", "per-item disclosure").

const CANDIDATE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

const LIVE_LANE = 'n-of-m-live';
const DEAD_LANE = 'n-of-m-dead';

const reviewedRows = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `,
		)
		.join('\n');

const criticisedRows = (ids: readonly string[]): string =>
	ids
		.map(
			(id) =>
				`[CRITIC] | ${id} | UPHELD | HIGH | reason ${id} | required change ${id}`,
		)
		.join('\n');

interface SeedDeadLaneArgs {
	batchId: string;
	laneId: string;
	phase: 'reviewer' | 'critic';
}

async function seedLivenessDeadLane({
	batchId,
	laneId,
	phase,
}: SeedDeadLaneArgs): Promise<void> {
	const correlationId = `${batchId}-${laneId}-session`;
	const staleReason = `lane ${laneId} presumed stale: idle host session past the stale horizon`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-${laneId}-call`,
		normalizedAgent: phase,
		swarmPrefixedAgent: phase,
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: `swarm-pr-review:${phase}`,
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: 'complete PR diff def456...abc123',
		},
	});
	await appendDelegationTransition(tempDir, correlationId, {
		status: 'stale',
		result: {
			error: staleReason,
			chars: staleReason.length,
			truncated: false,
			digest: createHash('sha256').update(staleReason).digest('hex'),
			workflowLaneFailureClass: 'liveness',
		},
	});
}

/**
 * The full candidate inventory after the standard prerequisites (their own
 * base candidates plus this suite's six). Every declaration below partitions
 * ALL of it so no item is left ownerless by accident.
 */
async function establishFullInventory(): Promise<string[]> {
	await establishReviewPrerequisites();
	const { PR_REVIEW_BASE_DIMENSION_IDS, enforcePrReviewBaseDimensions } =
		await import('../../../src/hooks/pr-workflow-gate.js');
	const [dimension] = PR_REVIEW_BASE_DIMENSION_IDS;
	const lane = { laneId: 'inv-lane', workflowLane: dimension };
	const ids = Array.from({ length: 6 }, (_v, i) => `I-${i + 1}`);
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, [lane], {
		batchId: 'inv-batch',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('inv-batch', 'swarm-pr-review:base', [lane], {
		textOverride: [
			CANDIDATE_HEADER,
			...ids.map(
				(id) =>
					`${id} | ${dimension} | HIGH | correctness | file.ts:1 | claim ${id} | evidence ${id} | impact ${id} | HIGH | ORDINARY | `,
			),
		].join('\n'),
	});
	const composed = (await gateInternals.composePrReviewPhaseVerdicts(
		tempDir,
		SESSION_ID,
		'reviewer',
	)) as unknown as { requiredInventory: string[] };
	return [...composed.requiredInventory].sort();
}

interface DeadReviewerWorld {
	liveItems: string[];
	deadItems: string[];
}

async function establishDeadReviewerWorld(): Promise<DeadReviewerWorld> {
	const ids = await establishFullInventory();
	const liveItems = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
	const deadItems = ids.slice(liveItems.length);
	// Initial batch: live lane covers liveItems; dead lane covers deadItems.
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: LIVE_LANE,
				workflowLane: LIVE_LANE,
				reviewItemIds: liveItems,
			},
			{
				laneId: DEAD_LANE,
				workflowLane: DEAD_LANE,
				reviewItemIds: deadItems,
			},
		],
		{ batchId: 'n-of-m-batch-1', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'n-of-m-batch-1',
		'swarm-pr-review:reviewer',
		[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
		{ textOverride: reviewedRows(liveItems) },
	);
	await seedLivenessDeadLane({
		batchId: 'n-of-m-batch-1',
		laneId: DEAD_LANE,
		phase: 'reviewer',
	});
	// Reserve the run id the disclosure receipt persists under (the artifact
	// flow normally reserves it; the fixture harness bypasses that path).
	await resolvePrReviewWriterRunId(tempDir, SESSION_ID);
	// Retry batches 2 and 3 re-declare the dead lane's items; the lane is
	// liveness-dead in each (controller-observed, per-batch records).
	for (const suffix of ['2', '3']) {
		const batchId = `n-of-m-batch-${suffix}`;
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: DEAD_LANE,
					workflowLane: DEAD_LANE,
					reviewItemIds: deadItems,
				},
			],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		await seedLivenessDeadLane({
			batchId,
			laneId: DEAD_LANE,
			phase: 'reviewer',
		});
	}
	return { liveItems, deadItems };
}

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('issue #3101 N-of-M verdict settlement', () => {
	describe('N-of-M exit', () => {
		test('N-of-M exit settles a liveness-dead reviewer lane after budget exhaustion and preserves surviving critic coverage', async () => {
			const { liveItems, deadItems } = await establishDeadReviewerWorld();
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
			const effective = await readPrReviewVerdictSettlementEffectiveIds(
				tempDir,
				SESSION_ID,
				'reviewer',
			);
			expect([...effective].sort()).toEqual([...deadItems].sort());
			// Surviving items keep critic coverage: the critic inventory equals
			// exactly the surviving reviewer-confirmed items (all CONFIRMED/HIGH
			// rows require critic under the shared routing predicate).
			expect([...effective]).not.toContain(liveItems[0]);
			const criticInventory =
				(await gateInternals.derivePrReviewCriticInventoryForCoverageGate(
					tempDir,
					SESSION_ID,
					'test:n-of-m',
				)) as string[];
			expect([...criticInventory].sort()).toEqual([...liveItems].sort());
		});

		test('N-of-M exit requires liveness evidence: budget exhausted without a dead lane still blocks', async () => {
			const ids = await establishFullInventory();
			const liveItems = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
			const deadItems = ids.slice(liveItems.length);
			for (const suffix of ['1', '2', '3']) {
				const batchId = `no-evidence-batch-${suffix}`;
				await recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'reviewer',
					[
						{
							laneId: LIVE_LANE,
							workflowLane: LIVE_LANE,
							reviewItemIds: liveItems,
						},
						{
							laneId: DEAD_LANE,
							workflowLane: DEAD_LANE,
							reviewItemIds: deadItems,
						},
					],
					{ batchId, prHeadSha: HEAD_SHA },
				);
				if (suffix === '1') {
					await persistBatch(
						batchId,
						'swarm-pr-review:reviewer',
						[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
						{ textOverride: reviewedRows(liveItems) },
					);
				}
				// No delegation records at all for the dead lane: pure absence.
			}
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			).rejects.toThrow(/items lack an authenticated verdict/);
		});

		test('N-of-M exit requires budget exhaustion: fewer than 1+budget attempts still blocks', async () => {
			const ids = await establishFullInventory();
			const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
			const dead = ids.slice(live.length);
			// Batch 1 + ONE retry only (2 attempts < 1 + budget = 3): the
			// liveness evidence is present, but the budget arm must refuse.
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: LIVE_LANE,
						workflowLane: LIVE_LANE,
						reviewItemIds: live,
					},
					{
						laneId: DEAD_LANE,
						workflowLane: DEAD_LANE,
						reviewItemIds: dead,
					},
				],
				{ batchId: 'budget-batch-1', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'budget-batch-1',
				'swarm-pr-review:reviewer',
				[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
				{ textOverride: reviewedRows(live) },
			);
			await seedLivenessDeadLane({
				batchId: 'budget-batch-1',
				laneId: DEAD_LANE,
				phase: 'reviewer',
			});
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
				{ batchId: 'budget-batch-2', prHeadSha: HEAD_SHA },
			);
			await seedLivenessDeadLane({
				batchId: 'budget-batch-2',
				laneId: DEAD_LANE,
				phase: 'reviewer',
			});
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			).rejects.toThrow(/verdict retry budget not exhausted/);
		});

		test('N-of-M exit drops an item claimed after the receipt was written (effective set shrinks)', async () => {
			const { liveItems, deadItems } = await establishDeadReviewerWorld();
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
			// A post-receipt batch claims one formerly-dead item with a
			// successful live lane artifact.
			const reclaimed = deadItems[0]!;
			const stillDead = deadItems.slice(1);
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'reclaim-lane',
						workflowLane: 'reclaim-lane',
						reviewItemIds: [reclaimed],
					},
				],
				{ batchId: 'reclaim-batch', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'reclaim-batch',
				'swarm-pr-review:reviewer',
				[{ laneId: 'reclaim-lane', workflowLane: 'reclaim-lane' }],
				{ textOverride: reviewedRows([reclaimed]) },
			);
			const effective = await readPrReviewVerdictSettlementEffectiveIds(
				tempDir,
				SESSION_ID,
				'reviewer',
			);
			expect([...effective].sort()).toEqual([...stillDead].sort());
			expect([...effective]).not.toContain(reclaimed);
			void liveItems;
		});

		test('N-of-M exit fails closed for an unclaimed item with an empty owner set', async () => {
			const ids = await establishFullInventory();
			const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 3)));
			const dead = ids.slice(live.length, ids.length - 1);
			// The final item is deliberately NEVER declared by any batch.
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: LIVE_LANE,
						workflowLane: LIVE_LANE,
						reviewItemIds: live,
					},
					{
						laneId: DEAD_LANE,
						workflowLane: DEAD_LANE,
						reviewItemIds: dead,
					},
				],
				{ batchId: 'empty-owner-batch-1', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'empty-owner-batch-1',
				'swarm-pr-review:reviewer',
				[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
				{ textOverride: reviewedRows(live) },
			);
			await seedLivenessDeadLane({
				batchId: 'empty-owner-batch-1',
				laneId: DEAD_LANE,
				phase: 'reviewer',
			});
			for (const suffix of ['2', '3']) {
				const batchId = `empty-owner-batch-${suffix}`;
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
					{ batchId, prHeadSha: HEAD_SHA },
				);
				await seedLivenessDeadLane({
					batchId,
					laneId: DEAD_LANE,
					phase: 'reviewer',
				});
			}
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			).rejects.toThrow(/items lack an authenticated verdict/);
		});

		test('N-of-M exit admits a dead critic lane with a disclosed CRITIC_UNAVAILABLE disposition', async () => {
			const { liveItems } = await establishDeadReviewerWorld();
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
			const criticLive = liveItems.slice(0, Math.max(1, liveItems.length - 1));
			const criticDead = liveItems.slice(criticLive.length);
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'critic',
				[
					{
						laneId: 'critic-live',
						workflowLane: 'critic-live',
						reviewItemIds: criticLive,
					},
					{
						laneId: 'critic-dead',
						workflowLane: 'critic-dead',
						reviewItemIds: criticDead,
					},
				],
				{ batchId: 'critic-batch-1', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'critic-batch-1',
				'swarm-pr-review:critic',
				[{ laneId: 'critic-live', workflowLane: 'critic-live' }],
				{ textOverride: criticisedRows(criticLive) },
			);
			await seedLivenessDeadLane({
				batchId: 'critic-batch-1',
				laneId: 'critic-dead',
				phase: 'critic',
			});
			for (const suffix of ['2', '3']) {
				const batchId = `critic-batch-${suffix}`;
				await recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'critic',
					[
						{
							laneId: 'critic-dead',
							workflowLane: 'critic-dead',
							reviewItemIds: criticDead,
						},
					],
					{ batchId, prHeadSha: HEAD_SHA },
				);
				await seedLivenessDeadLane({
					batchId,
					laneId: 'critic-dead',
					phase: 'critic',
				});
			}
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic');
			const effective = await readPrReviewVerdictSettlementEffectiveIds(
				tempDir,
				SESSION_ID,
				'critic',
			);
			expect([...effective]).toEqual(criticDead);
		});
	});

	describe('downgrade-only', () => {
		test('downgrade-only: an admitted settlement never permits APPROVE in the report projection', async () => {
			await establishDeadReviewerWorld();
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
			const { readPrReviewTerminalCoverageForReport } = await import(
				'../../../src/pr-review/completion.js'
			);
			const report = await readPrReviewTerminalCoverageForReport(
				tempDir,
				SESSION_ID,
			);
			expect(report).not.toBeNull();
			expect(report?.allowedVerdicts).not.toContain('APPROVE');
			expect(report?.allowedVerdicts).toContain('REQUEST_CHANGES');
			expect(report?.allowedVerdicts).toContain('INCOMPLETE');
		});

		test('downgrade-only: CRITIC_UNAVAILABLE settlement keeps the reviewer verdict and is terminal', async () => {
			const { settleCriticFinding } = await import(
				'../../../src/pr-review/finding-policy.js'
			);
			const settled = settleCriticFinding({
				finding: {
					id: 'F-1',
					status: 'CONFIRMED',
					severity: 'HIGH',
					action: 'route_to_critic',
				},
				outcome: 'CRITIC_UNAVAILABLE',
			});
			expect(settled.terminal).toBe(true);
			expect(settled.status).toBe('CRITIC_UNAVAILABLE');
			expect(settled.finalFinding.status).toBe('CONFIRMED');
			expect(settled.finalFinding.severity).toBe('HIGH');
			expect(settled.handoffFindingIds).toEqual([]);
		});
	});

	describe('per-item disclosure', () => {
		test('per-item disclosure receipt carries lane, disposition, and evidence class for exactly the dead set', async () => {
			const { deadItems } = await establishDeadReviewerWorld();
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
			const items = await readPrReviewVerdictSettlementReceiptItems(
				tempDir,
				SESSION_ID,
			);
			const reviewerItems = items.filter(
				(item) => item.disposition === 'liveness_dead',
			);
			expect(reviewerItems.map((item) => item.itemId).sort()).toEqual(
				[...deadItems].sort(),
			);
			for (const item of reviewerItems) {
				expect(item.disposition).toBe('liveness_dead');
				expect(item.evidenceClass).toBe('liveness');
				expect(item.terminalStatus).toBe('stale');
				expect(item.sourceBatchId.startsWith('n-of-m-batch')).toBe(true);
				expect(item.sourceLaneId).toBe(DEAD_LANE);
			}
			// Idempotent: returns the already-reserved run id.
			const runId = await resolvePrReviewWriterRunId(tempDir, SESSION_ID);
			expect(runId).not.toBe('');
			const receiptPath = join(
				tempDir,
				'.swarm',
				'pr-review',
				runId,
				'verdict-settlement.reviewer.json',
			);
			expect(existsSync(receiptPath)).toBe(true);
			const raw = JSON.parse(readFileSync(receiptPath, 'utf-8')) as {
				phase: string;
				prHeadSha: string;
			};
			expect(raw.phase).toBe('reviewer');
			expect(raw.prHeadSha).toBe(HEAD_SHA);
		});

		test('per-item disclosure budget arithmetic mirrors the micro-family budget', () => {
			expect(PR_REVIEW_VERDICT_RETRY_BUDGET).toBe(2);
			expect(
				deriveVerdictSettlementAdmission({
					directory: tempDir,
					prHeadSha: HEAD_SHA,
					phase: 'reviewer',
					window: [],
					unclaimed: ['X'],
				}).admitted,
			).toBe(false);
		});
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
	readPrReviewVerdictSettlementEffectiveIds,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';
import {
	DEAD_LANE,
	type DeadReviewerWorld,
	establishDeadReviewerWorld,
	establishFullInventory,
	seedLivenessDeadLane,
} from './n-of-m-verdict-settlement.fixtures.js';

// Issue #3101 acceptance checks C1/C3/C4 (frozen -t filters: "N-of-M exit",
// "downgrade-only"; "per-item disclosure" lives in the -disclosure suite).

const LIVE_LANE = 'n-of-m-live';

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
			const { deadItems } = await establishDeadReviewerWorld();
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

		test('N-of-M exit refuses a lane self-report: liveness-shaped error text without the typed controller class still blocks', async () => {
			// Issue #3101 constraint 1 (review PRR-028): the typed
			// `workflowLaneFailureClass: 'liveness'` on the controller-written
			// record is the ONLY admissible terminality evidence. A lane whose
			// error TEXT says "stale/liveness" but whose transition carries no
			// class must never settle — committed negative coverage for the
			// discriminator that previously existed only in a git-excluded repro
			// probe.
			const ids = await establishFullInventory();
			const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
			const dead = ids.slice(live.length);
			for (const suffix of ['1', '2', '3']) {
				const batchId = `self-report-batch-${suffix}`;
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
					{ batchId, prHeadSha: HEAD_SHA },
				);
				if (suffix === '1') {
					await persistBatch(
						batchId,
						'swarm-pr-review:reviewer',
						[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
						{ textOverride: reviewedRows(live) },
					);
				}
				await seedLivenessDeadLane({
					batchId,
					laneId: DEAD_LANE,
					phase: 'reviewer',
					omitFailureClass: true,
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
						agent: 'critic',
						workflowLane: 'critic-live',
						reviewItemIds: criticLive,
					},
					{
						laneId: 'critic-dead',
						agent: 'critic',
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
							agent: 'critic',
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
});

export type { DeadReviewerWorld };

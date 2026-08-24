import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	activatePrWorkflow,
	assertPrReviewValidationSettled,
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
	LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

/**
 * Issue #1968 P4: `MAX_WORKFLOW_BATCHES` used to be a permanent dead end — once
 * a session accumulated 128 batches of a kind, every further dispatch was
 * blocked with no recovery path. The GC reclaims capacity by dropping provably
 * inert batches inside the same read-prune-append transaction, and fails closed
 * (keeping every batch) whenever it cannot prove the derived inventory is
 * unchanged.
 */

/**
 * Every test here builds a full cap's worth of batches, which is inherently
 * slow: ~4s against bun's 5000ms default, i.e. flaky by construction, and a
 * timeout mid-transaction poisons the *next* test (its continuation writes into
 * a temp directory teardown already replaced, surfacing as "PR workflow state
 * mutation lock changed or escaped .swarm"). A generous explicit budget is the
 * fix; the work itself cannot be shrunk without making the cap injectable.
 */
const CAP_TEST_TIMEOUT_MS = 60_000;
const { MAX_WORKFLOW_BATCHES } = gateInternals;
const [DIM_A] = PR_REVIEW_BASE_DIMENSION_IDS;
const REVIEW_ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const REVIEWED_ROWS = REVIEW_ITEM_IDS.map(
	(id) =>
		`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer`,
).join('\n');

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

/** Declare one reviewer batch owning the whole candidate inventory. */
async function recordReviewerBatch(batchId: string): Promise<void> {
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

/** Land a full, successful reviewer artifact for an already-declared batch. */
async function landReviewerArtifact(batchId: string): Promise<void> {
	await persistBatch(
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{ textOverride: REVIEWED_ROWS, subagentSessionId: `${batchId}-session` },
	);
}

async function validationBatchIds(): Promise<string[]> {
	gateInternals.resetTrackedStateCache();
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	return (state?.prReviewValidationBatches ?? []).map((batch) => batch.batchId);
}

/** Declare `count` base batches that never produce a delegation record. */
async function recordInertBaseBatches(
	count: number,
	prefix = 'inert',
): Promise<string[]> {
	const batchIds: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const batchId = `${prefix}-${index}`;
		await enforcePrReviewBaseDimensions(
			tempDir,
			SESSION_ID,
			[{ laneId: `${batchId}-lane`, workflowLane: DIM_A }],
			{
				batchId,
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		batchIds.push(batchId);
	}
	return batchIds;
}

async function baseBatchIds(): Promise<string[]> {
	gateInternals.resetTrackedStateCache();
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	return (state?.prReviewBaseDispatches ?? []).map((batch) => batch.batchId);
}

describe('pr-workflow-gate workflow batch GC', () => {
	test(
		'the base batch cap is no longer a dead end',
		async () => {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			const sourceLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
				laneId: workflowLane,
				workflowLane,
			}));
			await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, sourceLanes, {
				batchId: 'base-source',
				prHeadSha: HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			});
			await persistBatch('base-source', 'swarm-pr-review:base', sourceLanes);
			await recordInertBaseBatches(MAX_WORKFLOW_BATCHES - 1);
			expect(await baseBatchIds()).toHaveLength(MAX_WORKFLOW_BATCHES);

			// Pre-fix this threw `PR_REVIEW base batch limit reached` forever.
			await enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				[{ laneId: 'after-gc-lane', workflowLane: DIM_A }],
				{ batchId: 'after-gc', prHeadSha: HEAD_SHA },
			);

			// Survivors, in their original relative order: the one batch carrying a
			// fully-successful lane, the newest pre-existing batch, and the append.
			expect(await baseBatchIds()).toEqual([
				'base-source',
				`inert-${MAX_WORKFLOW_BATCHES - 2}`,
				'after-gc',
			]);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'the singular latest-dispatch pointer survives the prune',
		async () => {
			await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
			await recordInertBaseBatches(MAX_WORKFLOW_BATCHES);
			const state = await enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				[{ laneId: 'pointer-lane', workflowLane: DIM_A }],
				{ batchId: 'pointer-batch', prHeadSha: HEAD_SHA },
			);
			expect(state.prReviewBaseDispatch?.batchId).toBe('pointer-batch');
			expect(
				state.prReviewBaseDispatches?.some(
					(batch) => batch.batchId === state.prReviewBaseDispatch?.batchId,
				),
			).toBe(true);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'pruning never changes the derived candidate inventory',
		async () => {
			await establishReviewPrerequisites();
			const before = await gateInternals.derivePrReviewCandidateInventory(
				tempDir,
				SESSION_ID,
			);
			expect(before.length).toBeGreaterThan(0);
			await recordInertBaseBatches(MAX_WORKFLOW_BATCHES - 1);
			await enforcePrReviewBaseDimensions(
				tempDir,
				SESSION_ID,
				[{ laneId: 'post-gc-lane', workflowLane: DIM_A }],
				{ batchId: 'post-gc', prHeadSha: HEAD_SHA },
			);
			const surviving = await baseBatchIds();
			expect(surviving).toContain('base-all');
			expect(surviving.length).toBeLessThan(MAX_WORKFLOW_BATCHES);
			expect(
				await gateInternals.derivePrReviewCandidateInventory(
					tempDir,
					SESSION_ID,
				),
			).toEqual(before);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'the GC aborts and keeps every batch when the inventory cannot be derived',
		async () => {
			await establishReviewPrerequisites();
			await recordInertBaseBatches(MAX_WORKFLOW_BATCHES - 1);
			// The trigger receipt is an input to derivePrReviewCandidateInventory; with
			// it gone the equality proof cannot be computed at all, so the GC must keep
			// every batch and let the pre-existing cap error stand.
			await fs.rm(
				path.join(
					tempDir,
					'.swarm',
					'pr-review',
					'test-run',
					'trigger-eval.json',
				),
			);
			await expect(
				enforcePrReviewBaseDimensions(
					tempDir,
					SESSION_ID,
					[{ laneId: 'blocked-lane', workflowLane: DIM_A }],
					{ batchId: 'blocked', prHeadSha: HEAD_SHA },
				),
			).rejects.toThrow('PR_REVIEW base batch limit reached');
			expect(await baseBatchIds()).toHaveLength(MAX_WORKFLOW_BATCHES);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'council batches are never pruned, so the validation cap stays closed',
		async () => {
			await establishReviewPrerequisites();
			for (let index = 0; index < MAX_WORKFLOW_BATCHES; index += 1) {
				await recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'council',
					[{ laneId: `council-lane-${index}`, workflowLane: 'council-sweep' }],
					{ batchId: `council-${index}`, prHeadSha: HEAD_SHA },
				);
			}
			await expect(
				recordPrReviewValidationBatch(
					tempDir,
					SESSION_ID,
					'council',
					[{ laneId: 'council-lane-extra', workflowLane: 'council-sweep' }],
					{ batchId: 'council-extra', prHeadSha: HEAD_SHA },
				),
			).rejects.toThrow('PR_REVIEW validation batch limit reached');
			gateInternals.resetTrackedStateCache();
			const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
			expect(state?.prReviewValidationBatches).toHaveLength(
				MAX_WORKFLOW_BATCHES,
			);
			expect(
				state?.prReviewValidationBatches?.every(
					(batch) => batch.phase === 'council',
				),
			).toBe(true);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'the validation batch cap is reclaimed in a reviewer retry loop',
		async () => {
			await establishReviewPrerequisites();
			// The issue's own scenario: one session, a FIXED candidate inventory, and
			// reviewer retries piling up. Pre-fix the validation GC kept every batch
			// with `index > latestCouncilIndex` — and with no council batch at all
			// `latestCouncilIndex` is -1, so it kept everything and the cap was a
			// permanent dead end no matter how many batches were provably inert.
			await recordReviewerBatch('rv-first');
			await landReviewerArtifact('rv-first');
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			).resolves.toMatchObject({ mode: 'PR_REVIEW' });

			for (let index = 1; index < MAX_WORKFLOW_BATCHES - 1; index += 1) {
				await recordReviewerBatch(`rv-${index}`);
			}
			// A later batch lands the same rows, so it — not `rv-first` — is the
			// first-write-wins source for every item, and `rv-first` becomes inert
			// while still holding a delegation record.
			await recordReviewerBatch('rv-winner');
			await landReviewerArtifact('rv-winner');
			expect(await validationBatchIds()).toHaveLength(MAX_WORKFLOW_BATCHES);
			const before = await gateInternals.derivePrReviewCandidateInventory(
				tempDir,
				SESSION_ID,
			);

			// Pre-fix this threw `PR_REVIEW validation batch limit reached`.
			await recordReviewerBatch('rv-after-gc');

			const surviving = await validationBatchIds();
			expect(surviving).toEqual(['rv-winner', 'rv-after-gc']);
			expect(
				await gateInternals.derivePrReviewCandidateInventory(
					tempDir,
					SESSION_ID,
				),
			).toEqual(before);
			// The verdicts the surviving batch carries still settle the phase.
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
			).resolves.toMatchObject({ mode: 'PR_REVIEW' });

			// Pruning a reviewer batch must not un-forbid its child session for the
			// critic reuse ban: the ids move to the retired ledger instead.
			gateInternals.resetTrackedStateCache();
			const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
			expect(state?.prReviewRetiredReviewerSessionIds).toContain(
				'rv-first-session',
			);

			// Rollback: the ledger is a second optional TOP-LEVEL key, and only a GC
			// ever writes it, so this is the one place the rolled-back-plugin claim
			// can be asserted against a file a v2 plugin actually produced.
			const persisted = JSON.parse(
				await fs.readFile(
					path.join(
						tempDir,
						'.swarm',
						'pr-workflow-gates',
						`${prWorkflowSessionFileStem(SESSION_ID)}.json`,
					),
					'utf-8',
				),
			);
			expect(persisted.prReviewRetiredReviewerSessionIds).toBeDefined();
			const v1Schema = z
				.object({
					schemaVersion: z.literal(1),
					sessionID: z.string().min(1),
					mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
				})
				.passthrough();
			expect(v1Schema.safeParse(persisted).success).toBe(true);

			// The ledger is only worth writing if it is still ENFORCED, so drive the
			// ban through settlement rather than through the state field: a critic
			// lane run from the RETIRED reviewer's child session may not claim any
			// item, exactly as if its reviewer batch had never been pruned. Asserting
			// the field alone leaves `reviewerSubagentSessionIds`' seed free to be
			// deleted with every suite still green — a fail-OPEN the new GC would
			// introduce (issue #1968 review round 2, MUST-FIX B).
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'critic',
				[
					{
						laneId: 'critic-retired',
						workflowLane: 'critic-retired',
						reviewItemIds: REVIEW_ITEM_IDS,
					},
				],
				{ batchId: 'critic-retired', prHeadSha: HEAD_SHA },
			);
			const criticRows = REVIEW_ITEM_IDS.map(
				(id) => `[CRITIC] | ${id} | UPHELD | HIGH | reason | no change`,
			).join('\n');
			await persistBatch(
				'critic-retired',
				'swarm-pr-review:critic',
				[{ laneId: 'critic-retired', workflowLane: 'critic-retired' }],
				{ subagentSessionId: 'rv-first-session', textOverride: criticRows },
			);
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
			).rejects.toThrow(
				`critic items lack an authenticated verdict from any successful lane: ${REVIEW_ITEM_IDS.join(', ')}`,
			);

			// Positive control: the identical critic batch from a child session that
			// never produced a reviewer artifact settles, so the rejection above
			// isolates the retired-session ban and nothing else about this state.
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'critic',
				[
					{
						laneId: 'critic-independent',
						workflowLane: 'critic-independent',
						reviewItemIds: REVIEW_ITEM_IDS,
					},
				],
				{ batchId: 'critic-independent', prHeadSha: HEAD_SHA },
			);
			await persistBatch(
				'critic-independent',
				'swarm-pr-review:critic',
				[{ laneId: 'critic-independent', workflowLane: 'critic-independent' }],
				{ subagentSessionId: 'independent-critic', textOverride: criticRows },
			);
			await expect(
				assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
			).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		},
		CAP_TEST_TIMEOUT_MS,
	);
});

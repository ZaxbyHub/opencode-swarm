import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import {
	activatePrWorkflow,
	assertPrFeedbackVerificationSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

/**
 * Issue #1968 review round 2, MUST-FIX C — `MAX_WORKFLOW_BATCHES` was a
 * permanent dead end for `prFeedbackVerifications`.
 *
 * The shipped justification was that no verification batch is inert because
 * every one claims an inventory item. That confused the two things a batch
 * holds. Coverage comes only from lanes that passed batch integrity AND produced
 * an artifact covering their items, so an all-failed verification batch
 * contributes nothing to settlement; what it does hold is its item->lane
 * ownership binding. Moving those bindings to `prFeedbackRetiredItemOwnership`
 * makes the non-contributing batches genuinely inert, and
 * `src/tools/dispatch-lanes.ts` appends one on every verification dispatch
 * including retries, so this accumulation is retry-driven exactly like the
 * PR_REVIEW arrays.
 */

const CAP_TEST_TIMEOUT_MS = 120_000;
const { MAX_WORKFLOW_BATCHES } = gateInternals;
const COVERED_ITEM = 'FB-001';
const ORPHAN_ITEM = 'FB-002';
/** What a rolled-back plugin's non-strict reader accepts. */
const V1_PASSTHROUGH_SCHEMA = z
	.object({
		schemaVersion: z.literal(1),
		sessionID: z.string().min(1),
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
	})
	.passthrough();

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

async function verificationBatchIds(): Promise<string[]> {
	gateInternals.resetTrackedStateCache();
	const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
	return (state?.prFeedbackVerifications ?? []).map((batch) => batch.batchId);
}

/**
 * A full cap of verification batches: one that settles `COVERED_ITEM`, one that
 * is the sole owner of `ORPHAN_ITEM` and never produces an artifact, and filler
 * retries of the covered lane. Only the first contributes coverage.
 */
async function fillVerificationCap(): Promise<void> {
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
	// The only batch that ever binds ORPHAN_ITEM -> verify-b, and it dies without
	// an artifact. Post-prune this binding exists nowhere but the retired ledger.
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
	expect(await verificationBatchIds()).toHaveLength(MAX_WORKFLOW_BATCHES);
}

describe('pr-workflow-gate feedback verification batch GC', () => {
	test(
		'the feedback verification cap is no longer a dead end',
		async () => {
			await fillVerificationCap();
			// Coverage that already settled must be untouched by the reclaim, so
			// pin it on both sides of the prune rather than only after.
			await expect(
				assertPrFeedbackVerificationSettled(tempDir, SESSION_ID),
			).rejects.toThrow(`missing inventory items: ${ORPHAN_ITEM}`);

			// Pre-fix this threw `PR_FEEDBACK verification batch limit reached` with
			// no recovery path for the rest of the session.
			await enforcePrFeedbackVerificationOwnership(
				tempDir,
				SESSION_ID,
				[{ laneId: 'verify-b', ownedItemIds: [ORPHAN_ITEM] }],
				{ batchId: 'after-gc', prHeadSha: HEAD_SHA },
			);

			// Survivors in original order: the one batch carrying settled coverage,
			// the newest pre-existing batch, and the append.
			expect(await verificationBatchIds()).toEqual([
				'covering',
				`retry-${MAX_WORKFLOW_BATCHES - 1}`,
				'after-gc',
			]);

			// The reclaim is real progress, not just a shorter array: the dispatch
			// that was previously impossible now lands an artifact and settles the
			// whole inventory.
			await persistBatch(
				'after-gc',
				'swarm-pr-feedback:verification',
				[{ laneId: 'verify-b', workflowLane: 'verify-b' }],
				{
					textOverride: `[FEEDBACK-VERIFIED] | ${ORPHAN_ITEM} | CONFIRMED | evidence`,
				},
			);
			await expect(
				assertPrFeedbackVerificationSettled(tempDir, SESSION_ID),
			).resolves.toMatchObject({ mode: 'PR_FEEDBACK' });
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'the cumulative ownership re-claim rejection survives the prune',
		async () => {
			await fillVerificationCap();
			// This dispatch trips the cap, so the GC runs and drops `orphan-owner` —
			// the only live batch binding ORPHAN_ITEM to `verify-b`. The re-claim by a
			// different lane must still be rejected, from the retired ledger alone.
			await expect(
				enforcePrFeedbackVerificationOwnership(
					tempDir,
					SESSION_ID,
					[{ laneId: 'verify-c', ownedItemIds: [ORPHAN_ITEM] }],
					{ batchId: 'reclaim-attempt', prHeadSha: HEAD_SHA },
				),
			).rejects.toThrow(
				`PR_FEEDBACK verification item "${ORPHAN_ITEM}" is owned by both "verify-b" and "verify-c"`,
			);
			// A rejected dispatch persists nothing, cap included.
			expect(await verificationBatchIds()).toHaveLength(MAX_WORKFLOW_BATCHES);

			// Positive control: the ledger rejects a DIFFERENT lane, not every lane.
			// The original owner may still re-dispatch, which is the retry loop this
			// reclaim exists to unblock.
			await enforcePrFeedbackVerificationOwnership(
				tempDir,
				SESSION_ID,
				[{ laneId: 'verify-b', ownedItemIds: [ORPHAN_ITEM] }],
				{ batchId: 'owner-retry', prHeadSha: HEAD_SHA },
			);
			gateInternals.resetTrackedStateCache();
			const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
			expect(state?.prFeedbackRetiredItemOwnership).toMatchObject({
				[ORPHAN_ITEM]: 'verify-b',
			});

			// Rollback: the ledger is an optional TOP-LEVEL key written only by this
			// GC, so this is the one file a v2 plugin actually produced that can be
			// parsed against the v1 passthrough schema the release note claims.
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
			expect(persisted.prFeedbackRetiredItemOwnership).toBeDefined();
			expect(V1_PASSTHROUGH_SCHEMA.safeParse(persisted).success).toBe(true);
		},
		CAP_TEST_TIMEOUT_MS,
	);

	test(
		'the GC aborts and keeps every batch when the revision digest cannot be resolved',
		async () => {
			await fillVerificationCap();
			const original = gateInternals.resolvePrWorkflowRevisionDigest;
			try {
				// An unresolvable digest makes `currentPrFeedbackRevisionDigest` throw,
				// which the prune's outer catch must convert into "keep every batch" so
				// the caller's pre-existing cap error stands. A partial prune landing
				// here would drop ownership bindings on the strength of a coverage
				// comparison that was never computed.
				gateInternals.resolvePrWorkflowRevisionDigest = () => '';
				await expect(
					enforcePrFeedbackVerificationOwnership(
						tempDir,
						SESSION_ID,
						[{ laneId: 'verify-a', ownedItemIds: [COVERED_ITEM] }],
						{ batchId: 'blocked', prHeadSha: HEAD_SHA },
					),
				).rejects.toThrow('PR_FEEDBACK verification batch limit reached');
			} finally {
				gateInternals.resolvePrWorkflowRevisionDigest = original;
			}
			expect(await verificationBatchIds()).toHaveLength(MAX_WORKFLOW_BATCHES);
			gateInternals.resetTrackedStateCache();
			const state = await readPrWorkflowGateState(tempDir, SESSION_ID);
			expect(state?.prFeedbackRetiredItemOwnership).toBeUndefined();
		},
		CAP_TEST_TIMEOUT_MS,
	);
});

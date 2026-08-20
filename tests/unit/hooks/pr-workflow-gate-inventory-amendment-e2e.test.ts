import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	assertPrFeedbackGatePhaseSettled,
	assertPrFeedbackVerificationSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #2242 R3: the *executable* proof that an append-only inventory
 * amendment is recoverable end to end.
 *
 * The R3 unit suite exercises each rule in isolation. This file runs the whole
 * sequence an operator actually performs after discovering a missing feedback
 * item mid-workflow — settle → amend → cover only the appended item → re-record
 * Stage A → re-run the ordered gate — because the decision to keep EXACT
 * inventory comparators (rather than the plan's prefix acceptance) rests
 * entirely on that sequence being reachable. Availability, not integrity, is
 * what this file defends.
 */

const SESSION_ID = 'feedback-amendment-e2e';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const UPSTREAM = {
	remoteName: 'origin',
	remoteBranchRef: 'refs/heads/pr-branch',
	remoteTrackingRef: 'refs/remotes/origin/pr-branch',
};

let directory = '';
const originals = { ...gateInternals };

beforeEach(() => {
	directory = canonicalMkdtemp('pr-gate-amend-e2e-');
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolveCurrentUpstreamPushTarget = () => UPSTREAM;
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async () => UPSTREAM;
	gateInternals.resolveRemoteRefsContainingHead = () => [
		UPSTREAM.remoteTrackingRef,
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async () => [
		UPSTREAM.remoteTrackingRef,
	];
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, originals);
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistLaneArtifact(options: {
	batchId: string;
	laneId: string;
	mode: string;
	role: string;
	text: string;
}): Promise<void> {
	const correlationId = `${options.batchId}--${options.laneId}`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `call-${correlationId}`,
		normalizedAgent: options.role,
		swarmPrefixedAgent: options.role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId: options.batchId,
		laneId: options.laneId,
		mode: options.mode,
		workflowLane: options.laneId,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: REVISION,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: options.batchId,
		laneId: options.laneId,
		agent: options.role,
		role: options.role,
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: options.mode,
		workflowLane: options.laneId,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION,
		source: 'collect_lane_results',
		text: options.text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'completed',
		result: {
			text: options.text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
}

/** One verification batch whose single lane owns exactly `itemIds`. */
async function settleVerification(
	batchId: string,
	laneId: string,
	itemIds: readonly string[],
): Promise<void> {
	await enforcePrFeedbackVerificationOwnership(
		directory,
		SESSION_ID,
		[{ laneId, ownedItemIds: [...itemIds] }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistLaneArtifact({
		batchId,
		laneId,
		mode: 'swarm-pr-feedback:verification',
		role: 'reviewer',
		text: itemIds
			.map((itemId) => `[FEEDBACK-VERIFIED] | ${itemId} | CONFIRMED | evidence`)
			.join('\n'),
	});
}

const OBLIGATION = {
	id: 'OBL-A',
	category: 'build' as const,
	workingDirectory: '.',
	source: 'manual:OBL-A',
};

function checksFor(itemIds: readonly string[]) {
	return [
		{
			category: 'diff-check' as const,
			command: ['git', 'diff', '--check'],
			durationMs: 1,
		},
		{
			category: 'reproduction' as const,
			command: ['test', 'regression'],
			targets: ['regression'],
			feedbackTargets: itemIds.map((itemId) => ({
				feedbackItemId: itemId,
				target: 'regression',
				expectedBehavior: 'regression stays fixed',
			})),
			durationMs: 1,
		},
		{
			category: OBLIGATION.category,
			command: ['build', OBLIGATION.id],
			obligationId: OBLIGATION.id,
			workingDirectory: OBLIGATION.workingDirectory,
			durationMs: 1,
		},
	];
}

async function recordStageA(itemIds: readonly string[]): Promise<void> {
	await recordPrFeedbackStageA(
		directory,
		SESSION_ID,
		REVISION,
		checksFor(itemIds),
		{
			applicableCategories: ['build'],
			applicableObligations: [OBLIGATION],
		},
	);
}

/** One ordered `stage-b-reviewer` gate batch owning exactly `itemIds`. */
async function armStageBReviewer(
	batchId: string,
	itemIds: readonly string[],
): Promise<void> {
	await recordPrFeedbackGateBatch(
		directory,
		SESSION_ID,
		'stage-b-reviewer',
		{ laneId: 'stage-b-reviewer', ownedItemIds: [...itemIds] },
		{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION },
	);
	await persistLaneArtifact({
		batchId,
		laneId: 'stage-b-reviewer',
		mode: 'swarm-pr-feedback:stage-b-reviewer',
		role: 'reviewer',
		text: itemIds
			.map((itemId) => `[STAGE-B-REVIEW] | ${itemId} | APPROVE | evidence`)
			.join('\n'),
	});
}

async function messageOf(promise: Promise<unknown>): Promise<string | null> {
	return promise.then(
		() => null,
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

describe('PR_FEEDBACK inventory amendment — regression: W-2 left a late-discovered finding with no mechanical repair (R3, end-to-end)', () => {
	test('the full amend → cover → re-record → re-run recovery sequence completes', async () => {
		// Previous behaviour: `declarePrFeedbackInventory` threw
		// `inventory is immutable after declaration` for ANY different array, so
		// the only exit was abort_pr_workflow plus a full restart — which also
		// discarded the completed verification below for FB-1/FB-2.

		// --- 1. a fully settled pre-amendment workflow over [FB-1, FB-2] ---
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-2'], {
			prHeadSha: HEAD_SHA,
		});
		await settleVerification('verify-1', 'verify-a', ['FB-1', 'FB-2']);
		await assertPrFeedbackVerificationSettled(directory, SESSION_ID);
		await recordStageA(['FB-1', 'FB-2']);
		await armStageBReviewer('gate-1', ['FB-1', 'FB-2']);
		await assertPrFeedbackGatePhaseSettled(
			directory,
			SESSION_ID,
			'stage-b-reviewer',
		);

		// --- 2. the amendment itself is accepted ---
		const amended = await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2', 'FB-3'],
			{ prHeadSha: HEAD_SHA },
		);
		expect(amended.prFeedbackInventory).toEqual(['FB-1', 'FB-2', 'FB-3']);
		expect(amended.prFeedbackInventoryAmendments).toEqual([
			{ entry: 'FB-3', amendedAt: expect.any(String), batch: 1 },
		]);

		// --- 3. the appended item is now uncovered, and BOTH gates say so ---
		expect(
			await messageOf(
				assertPrFeedbackVerificationSettled(directory, SESSION_ID),
			),
		).toMatch(/missing inventory items: FB-3/i);
		expect(
			await messageOf(
				assertPrFeedbackGatePhaseSettled(
					directory,
					SESSION_ID,
					'stage-b-reviewer',
				),
			),
		).not.toBeNull();

		// --- 4. cover ONLY the appended item; the FB-1/FB-2 verification is
		// preserved and must not be re-claimed (cumulative ownership ledger) ---
		await settleVerification('verify-2', 'verify-b', ['FB-3']);
		await assertPrFeedbackVerificationSettled(directory, SESSION_ID);

		// --- 5. Stage A re-recorded over the full amended inventory ---
		await recordStageA(['FB-1', 'FB-2', 'FB-3']);

		// --- 6. the pre-amendment gate batch must NOT settle the phase ---
		expect(
			await messageOf(
				assertPrFeedbackGatePhaseSettled(
					directory,
					SESSION_ID,
					'stage-b-reviewer',
				),
			),
		).toMatch(/stale inventory|amended after this batch/i);

		// --- 7. re-run the ordered gate over every current inventory item ---
		await armStageBReviewer('gate-2', ['FB-1', 'FB-2', 'FB-3']);
		const settled = await assertPrFeedbackGatePhaseSettled(
			directory,
			SESSION_ID,
			'stage-b-reviewer',
		);

		expect(settled.prFeedbackInventory).toEqual(['FB-1', 'FB-2', 'FB-3']);
		expect(settled.prFeedbackInventoryAmendments).toHaveLength(1);
	});

	test('the appended item cannot be re-claimed by the original verification lane', async () => {
		// The cumulative item→lane ownership ledger is what makes step 4 above a
		// NEW batch owning only FB-3 rather than a re-declaration of the old one.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-1', 'FB-2'], {
			prHeadSha: HEAD_SHA,
		});
		await settleVerification('verify-1', 'verify-a', ['FB-1', 'FB-2']);
		await declarePrFeedbackInventory(
			directory,
			SESSION_ID,
			['FB-1', 'FB-2', 'FB-3'],
			{ prHeadSha: HEAD_SHA },
		);

		// A DIFFERENT lane trying to re-own FB-1 is still rejected...
		expect(
			await messageOf(
				enforcePrFeedbackVerificationOwnership(
					directory,
					SESSION_ID,
					[{ laneId: 'verify-b', ownedItemIds: ['FB-1', 'FB-3'] }],
					{ batchId: 'verify-2', prHeadSha: HEAD_SHA },
				),
			),
		).toMatch(/owned by both/i);

		// ...while a lane owning only the appended item is accepted.
		await settleVerification('verify-3', 'verify-c', ['FB-3']);
		await expect(
			assertPrFeedbackVerificationSettled(directory, SESSION_ID),
		).resolves.toMatchObject({
			prFeedbackInventory: ['FB-1', 'FB-2', 'FB-3'],
		});
	});
});

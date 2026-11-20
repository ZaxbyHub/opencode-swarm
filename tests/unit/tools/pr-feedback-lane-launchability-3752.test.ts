// Issue #3752 AC2 (pulled into PR #3751 by the user's option-b instruction):
// PR_FEEDBACK lane modes must probe agent launchability at the admission site —
// BEFORE the verification record (declare/enforce) or the ordered-gate batch
// (recordPrFeedbackGateBatch) is written and before lane launch refuses the
// agent. At base (abd68f19d) no such probe exists for the PR_FEEDBACK modes, so
// an unregistered-but-role-resolving agent (a bare canonical role on a
// prefixed-only host) consumes the record before launchAsyncLane's
// validateLaneAgent refusal arrives.
//
// Classification: L1/L2 DISCRIMINATING (RED at base — the base log shows BOTH
// the consumed record in the state diff AND the raw 'not registered on this
// host' launch refusal); L3 PRESERVING (registered agents dispatch fine).
//
// Harness: the canonical PR_FEEDBACK gate fixtures (stubbed checkout/digest
// reads) plus the dispatch-lanes async stubs, mirroring the transport-binding
// suite's seed shape so recordPrFeedbackGateBatch's prerequisites (declared
// inventory, settled verification, Stage A evidence) hold for the ordered-gate
// leg.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	assertPrFeedbackVerificationSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import {
	installLegacyPrReviewPolicy,
	restorePrReviewPolicy,
} from './dispatch-lanes-pr-workflow-gate.test-fixtures.js';

let directory = '';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';
const ITEM_IDS = ['FB-001'] as const;
const originalGate = { ...gateInternals };
const originalDispatch = { ...dispatchInternals };
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-feedback-launchability-3752-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async () =>
		gateInternals.resolveCurrentUpstreamPushTarget();
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async () =>
		gateInternals.resolveRemoteRefsContainingHead();
	installLegacyPrReviewPolicy();
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async () => 'def456';
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'lane-session' } })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	Object.assign(gateInternals, originalGate);
	Object.assign(dispatchInternals, originalDispatch);
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	restorePrReviewPolicy();
	safeRmRecursive(directory);
});

/** Seed a settled verification batch so the ordered gates' prerequisites hold. */
async function seedVerification(
	session: string,
	batchId: string,
): Promise<void> {
	await enforcePrFeedbackVerificationOwnership(
		directory,
		session,
		[{ laneId: 'seed-lane', ownedItemIds: [...ITEM_IDS] }],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	const correlationId = `${batchId}--seed-lane`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: session,
		callID: batchId,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: 'seed-lane',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'seed-lane',
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: REVISION_DIGEST,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
		promptHash: 'seed-hash',
		generation: 1,
	});
	const text = ITEM_IDS.map(
		(itemId) =>
			`[FEEDBACK-VERIFIED] | ${itemId} | CONFIRMED | evidence ${itemId}`,
	).join('\n');
	const stored = storeLaneOutput(directory, {
		batchId,
		laneId: 'seed-lane',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: session,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'seed-lane',
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
	});
	await assertPrFeedbackVerificationSettled(directory, session);
}

describe('PR_FEEDBACK lane launchability admission (issue #3752 AC2)', () => {
	test('L1: an unregistered stage-b-reviewer agent is refused before the ordered-gate batch is recorded', async () => {
		const session = 'stage-b-reviewer-launch-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await declarePrFeedbackInventory(directory, session, [...ITEM_IDS], {
			prHeadSha: HEAD_SHA,
		});
		await seedVerification(session, 'seed-batch');
		await recordPrFeedbackStageA(directory, session, REVISION_DIGEST, [
			{
				category: 'diff-check',
				command: ['git', 'diff', '--check'],
				durationMs: 1,
			},
			{
				category: 'reproduction',
				command: ['test', 'feedback'],
				targets: ['feedback'],
				feedbackTargets: ITEM_IDS.map((itemId) => ({
					feedbackItemId: itemId,
					target: 'feedback',
					expectedBehavior: `fixed ${itemId}`,
				})),
				durationMs: 1,
			},
		]);
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		dispatchInternals.getGeneratedAgentNames = () => [
			'mega_reviewer',
			'mega_test_engineer',
		];
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:stage-b-reviewer',
				pr_head_sha: HEAD_SHA,
				max_concurrent: 1,
				batch_id: 'stage-b-reviewer-launch-3752',
				lanes: [
					{
						id: 'stage-b-reviewer-lane-3752',
						agent: 'reviewer',
						prompt: 'Review the feedback fix for FB-001.',
						workflow_lane: 'stage-b-reviewer',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		// Reachability control: at base the request reaches launch and the raw
		// registry refusal appears in the message/lane errors; at head the
		// admission wrapper embeds the same registry text.
		const message = [
			String(result.message ?? ''),
			...(result.lane_results ?? []).map((lane) =>
				String((lane as { error?: unknown }).error ?? ''),
			),
		].join('\n');
		expect(message).toContain('not registered on this host');
		// The discriminator: the rejected request leaves the gate state
		// byte-for-byte unchanged (at base the ordered batch was recorded before
		// the launch refusal, so this comparison fails).
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
		// HEAD behavior: the admission wrapper names the refusal.
		expect(message).toContain('is not launchable on this host');
	}, 60_000);

	test.each([
		{
			mode: 'swarm-pr-feedback:stage-b-test' as const,
			agent: 'test_engineer',
			label: 'stage-b-test',
		},
		{
			mode: 'swarm-pr-feedback:closeout-reviewer' as const,
			agent: 'reviewer',
			label: 'closeout-reviewer',
		},
		{
			mode: 'swarm-pr-feedback:closeout-critic' as const,
			agent: 'critic',
			label: 'closeout-critic',
		},
	])('L4: an unregistered $label agent is refused before the ordered-gate batch is recorded', async ({
		mode,
		agent,
		label,
	}) => {
		// Same shape as L1 for the three remaining ordered modes the probe
		// covers: the production admission probe lists five PR_FEEDBACK modes
		// (dispatch-lanes.ts), and a mutant deleting one of these three mode
		// disjuncts must redden here (the refusal text reaches this fixture via
		// the launch-prerequisite throw's message; L1 additionally pins the
		// state byte-for-byte) instead of leaving that mode's admission
		// coverage unpinned with the suite green.
		const session = `${label}-launch-3752`;
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await declarePrFeedbackInventory(directory, session, [...ITEM_IDS], {
			prHeadSha: HEAD_SHA,
		});
		await seedVerification(session, `seed-${label}`);
		await recordPrFeedbackStageA(directory, session, REVISION_DIGEST, [
			{
				category: 'diff-check',
				command: ['git', 'diff', '--check'],
				durationMs: 1,
			},
			{
				category: 'reproduction',
				command: ['test', 'feedback'],
				targets: ['feedback'],
				feedbackTargets: ITEM_IDS.map((itemId) => ({
					feedbackItemId: itemId,
					target: 'feedback',
					expectedBehavior: `fixed ${itemId}`,
				})),
				durationMs: 1,
			},
		]);
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		dispatchInternals.getGeneratedAgentNames = () => [
			'mega_reviewer',
			'mega_test_engineer',
			'mega_critic',
		];
		const result = await executeDispatchLanesAsync(
			{
				mode,
				pr_head_sha: HEAD_SHA,
				max_concurrent: 1,
				batch_id: `${label}-launch-3752`,
				lanes: [
					{
						id: `${label}-lane-3752`,
						agent,
						prompt: `Review the feedback fix for FB-001 (${label}).`,
						workflow_lane: label,
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		const message = [
			String(result.message ?? ''),
			...(result.lane_results ?? []).map((lane) =>
				String((lane as { error?: unknown }).error ?? ''),
			),
		].join('\n');
		// Reachability control: the raw registry refusal appears (the same
		// text launchAsyncLane would emit).
		expect(message).toContain('not registered on this host');
		// Defense-in-depth pin (live at L1 whose prerequisites are fully
		// seeded; for these modes the predecessor-phase prerequisite throws
		// before any persist, so the state is trivially unchanged here too).
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
		// HEAD behavior: the admission wrapper names the refusal.
		expect(message).toContain('is not launchable on this host');
	}, 60_000);

	test('L2: an unregistered verification-lane agent is refused before the verification record is written', async () => {
		const session = 'verify-launch-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		await declarePrFeedbackInventory(directory, session, [...ITEM_IDS], {
			prHeadSha: HEAD_SHA,
		});
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		dispatchInternals.getGeneratedAgentNames = () => [
			'mega_reviewer',
			'mega_test_engineer',
		];
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: HEAD_SHA,
				batch_id: 'verify-launch-3752',
				feedback_inventory: [...ITEM_IDS],
				lanes: [
					{
						id: 'verify-lane-3752',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		const message = [
			String(result.message ?? ''),
			...(result.lane_results ?? []).map((lane) =>
				String((lane as { error?: unknown }).error ?? ''),
			),
		].join('\n');
		expect(message).toContain('not registered on this host');
		// At base declare+enforce consumed state (inventory already declared is
		// idempotent here, but the verification record lands) before the launch
		// refusal; at head nothing changes.
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
		// HEAD behavior: the admission wrapper names the refusal.
		expect(message).toContain('is not launchable on this host');
	}, 60_000);

	test('L3: preserving — a bare canonical reviewer agent on an empty registry dispatches successfully', async () => {
		// No registry stub: the real in-test registry is empty, so BOTH registry
		// views agree — resolveGeneratedAgentRole (swarmState, read directly by
		// the ordered-role check) canonicalizes 'reviewer', and
		// validateLaneAgent skips the registration requirement when the registry
		// is empty. The dispatch must clear the role check AND launchability.
		const session = 'registered-control-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: HEAD_SHA,
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: HEAD_SHA,
				batch_id: 'registered-control-3752',
				feedback_inventory: [...ITEM_IDS],
				lanes: [
					{
						id: 'registered-control-lane-3752',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(true);
		const state = await readPrWorkflowGateState(directory, session);
		expect(state?.prFeedbackInventory).toEqual([...ITEM_IDS]);
	}, 60_000);
});

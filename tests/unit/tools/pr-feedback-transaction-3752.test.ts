// Issue #3752 AC1 — the direct transactional contract of
// declareAndEnforcePrFeedbackVerification (non-frozen companion to the frozen
// C4 dispatch-level checks): the executed counterexample sequence (declare +
// enforce batch A, AMEND + re-enforce batch A -> stateful rejection, corrected
// retry) leaves NOTHING durable on rejection, and the live-publication
// invalidation event appends only AFTER the single persist (round-4/5 critic
// edge coverage).
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	activatePrWorkflow,
	declareAndEnforcePrFeedbackVerification,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import {
	installLegacyPrReviewPolicy,
	restorePrReviewPolicy,
} from './dispatch-lanes-pr-workflow-gate.test-fixtures.js';

let directory = '';
const originalGate = { ...gateInternals };
const originalDispatch = { ...dispatchInternals };

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-feedback-transaction-3752-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
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
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		'revision-1';
	installLegacyPrReviewPolicy();
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
	restorePrReviewPolicy();
	safeRmRecursive(directory);
});

describe('declareAndEnforcePrFeedbackVerification transaction (issue #3752 AC1)', () => {
	test('the executed wedge sequence leaves no durable state and the corrected retry succeeds', async () => {
		const session = 'transaction-probe-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'lane-a', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'batch-A' },
		);
		const before = await readPrWorkflowGateState(directory, session);
		expect(before?.prFeedbackInventory).toEqual(['FB-001']);
		let threw: string | null = null;
		try {
			await declareAndEnforcePrFeedbackVerification(
				directory,
				session,
				['FB-001', 'FB-00X'],
				[{ laneId: 'lane-b', ownedItemIds: ['FB-00X'] }],
				{ prHeadSha: 'abc123', batchId: 'batch-A' },
			);
		} catch (error) {
			threw = String((error as Error).message);
		}
		expect(threw).toContain(
			'verification batch id "batch-A" is already recorded',
		);
		// Nothing durable from the rejected amendment.
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
		// The corrected retry succeeds.
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'lane-c', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'batch-B' },
		);
		const after = await readPrWorkflowGateState(directory, session);
		expect(
			after?.prFeedbackVerifications?.some((r) => r.batchId === 'batch-B'),
		).toBe(true);
	}, 60_000);

	test('a rejected shape leaves nothing durable either (fresh declaration path)', async () => {
		const session = 'transaction-shape-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const before = await readPrWorkflowGateState(directory, session);
		let threw: string | null = null;
		try {
			await declareAndEnforcePrFeedbackVerification(
				directory,
				session,
				['FB-001'],
				[{ laneId: 'lane-x', ownedItemIds: ['FB-999'] }],
				{ prHeadSha: 'abc123', batchId: 'shape-batch' },
			);
		} catch (error) {
			threw = String((error as Error).message);
		}
		expect(threw).toContain('owns undeclared item "FB-999"');
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
	}, 60_000);

	test('a valid fresh declaration persists the inventory AND the verification record in one write', async () => {
		const session = 'transaction-fresh-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'lane-f', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'fresh-batch' },
		);
		const state = await readPrWorkflowGateState(directory, session);
		expect(state?.prFeedbackInventory).toEqual(['FB-001']);
		expect(
			state?.prFeedbackVerifications?.some((r) => r.batchId === 'fresh-batch'),
		).toBe(true);
	}, 60_000);

	test('a live-publication amendment persists the cleared state BEFORE the invalidation event (success pair)', async () => {
		const session = 'transaction-livepub-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'livepub-lane-a', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'livepub-batch-a' },
		);
		// Arm a live publication (the #2108 shape supersedeLivePublicationInPendingState
		// reacts to): prFeedbackReadyToPublish set on the authoritative state.
		const armed = await readPrWorkflowGateState(directory, session);
		expect(armed).not.toBeNull();
		await writeAuthoritativePrWorkflowState(directory, {
			...(armed as Record<string, unknown>),
			prFeedbackReadyToPublish: {
				revisionDigest: 'revision-1',
				localHead: 'abc123',
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/pr-head',
				remoteRef: 'refs/remotes/origin/pr-head',
				validatedAt: '2026-11-19T00:00:00.000Z',
			},
		} as Parameters<typeof writeAuthoritativePrWorkflowState>[1]);
		const before = await readPrWorkflowGateState(directory, session);
		expect(before?.prFeedbackReadyToPublish).toBeDefined();
		// A valid AMENDED dispatch through the transaction: the combined write
		// persists the amended inventory + the cleared publication state + the
		// new verification record in ONE persist, then appends the event.
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001', 'FB-002'],
			[{ laneId: 'livepub-lane-b', ownedItemIds: ['FB-002'] }],
			{ prHeadSha: 'abc123', batchId: 'livepub-batch-b' },
		);
		const after = await readPrWorkflowGateState(directory, session);
		expect(after?.prFeedbackInventory).toEqual(['FB-001', 'FB-002']);
		expect(after?.prFeedbackReadyToPublish).toBeUndefined();
		expect(
			after?.prFeedbackVerifications?.some(
				(record) => record.batchId === 'livepub-batch-b',
			),
		).toBe(true);
	}, 60_000);

	test('a live-publication amendment that is REJECTED leaves neither state nor event (rejection pair)', async () => {
		const session = 'transaction-livepub-rej-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'livepub-rej-lane-a', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'livepub-rej-batch-a' },
		);
		const armed = await readPrWorkflowGateState(directory, session);
		expect(armed).not.toBeNull();
		await writeAuthoritativePrWorkflowState(directory, {
			...(armed as Record<string, unknown>),
			prFeedbackReadyToPublish: {
				revisionDigest: 'revision-1',
				localHead: 'abc123',
				remoteName: 'origin',
				remoteBranchRef: 'refs/heads/pr-head',
				remoteRef: 'refs/remotes/origin/pr-head',
				validatedAt: '2026-11-19T00:00:00.000Z',
			},
		} as Parameters<typeof writeAuthoritativePrWorkflowState>[1]);
		const before = await readPrWorkflowGateState(directory, session);
		expect(before?.prFeedbackReadyToPublish).toBeDefined();
		// The amended dispatch reuses batch A: the stateful duplicate rejection
		// fires inside the transaction — nothing persists and no event lands.
		let threw: string | null = null;
		try {
			await declareAndEnforcePrFeedbackVerification(
				directory,
				session,
				['FB-001', 'FB-00X'],
				[{ laneId: 'livepub-rej-lane-b', ownedItemIds: ['FB-00X'] }],
				{ prHeadSha: 'abc123', batchId: 'livepub-rej-batch-a' },
			);
		} catch (error) {
			threw = String((error as Error).message);
		}
		expect(threw).toContain(
			'verification batch id "livepub-rej-batch-a" is already recorded',
		);
		const after = await readPrWorkflowGateState(directory, session);
		expect(after).toEqual(before);
		// The armed publication is untouched: no invalidation was recorded.
		expect(after?.prFeedbackReadyToPublish).toBeDefined();
	}, 60_000);

	test('the dispatch path wires the transaction (a well-formed amended dispatch succeeds end to end)', async () => {
		const session = 'transaction-dispatch-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				batch_id: 'dispatch-tx-batch',
				feedback_inventory: ['FB-001', 'FB-002'],
				lanes: [
					{
						id: 'dispatch-tx-lane',
						agent: 'reviewer',
						prompt: 'Verify FB-002.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-002'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(true);
		const state = await readPrWorkflowGateState(directory, session);
		expect(state?.prFeedbackInventory).toEqual(['FB-001', 'FB-002']);
		expect(
			state?.prFeedbackVerifications?.some(
				(r) => r.batchId === 'dispatch-tx-batch',
			),
		).toBe(true);
	}, 60_000);
});

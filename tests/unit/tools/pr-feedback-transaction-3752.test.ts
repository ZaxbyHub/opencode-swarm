// Issue #3752 AC1 — the direct transactional contract of
// declareAndEnforcePrFeedbackVerification (non-frozen companion to the frozen
// C4 dispatch-level checks): the executed counterexample sequence (declare +
// enforce batch A, AMEND + re-enforce batch A -> stateful rejection, corrected
// retry) leaves NOTHING durable on rejection, and the live-publication
// invalidation event appends only AFTER the single persist (round-4/5 critic
// edge coverage).
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { coreEventsFilePath } from '../../../src/events/core-events.js';
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
	const readEventsFile = (path: string): string =>
		existsSync(path) ? readFileSync(path, 'utf-8') : '';
	// Arm a LIVE publication GENERATION (prFeedbackPublication.active in state
	// 'armed'). supersedeLivePublicationInPendingState only produces an
	// invalidation event when an active generation exists — a bare
	// prFeedbackReadyToPublish record clears state but emits no event.
	const armLivePublicationGeneration = async (session: string) => {
		const current = await readPrWorkflowGateState(directory, session);
		expect(current).not.toBeNull();
		await writeAuthoritativePrWorkflowState(directory, {
			...(current as Record<string, unknown>),
			prFeedbackPublication: {
				schemaVersion: 1,
				active: {
					schemaVersion: 1,
					generation: 1,
					state: 'armed',
					workspaceIdentity: 'workspace-identity-1',
					sessionID: session,
					intakeHeadSha: 'abc123',
					localHeadRef: 'refs/heads/pr-head',
					localHead: 'abc123',
					remoteName: 'origin',
					remoteBranchRef: 'refs/heads/pr-head',
					remoteRef: 'refs/remotes/origin/pr-head',
					revisionDigest: 'revision-1',
					evidence: {
						stageAValidatedAt: '2026-11-19T00:00:00.000Z',
						batches: [
							{
								phase: 'stage-b-reviewer',
								batchId: 'gen1-sbr-batch',
								laneId: 'gen1-sbr-lane',
							},
						],
					},
					createdAt: '2026-11-19T00:00:00.000Z',
					armedAt: '2026-11-19T00:00:00.000Z',
				},
				history: [],
				attempts: [],
			},
		} as Parameters<typeof writeAuthoritativePrWorkflowState>[1]);
	};

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

	test('a live-publication amendment appends exactly one inventory-amended event on success and NONE on rejection', async () => {
		// Event-store observation: .swarm/events.jsonl. The success leg of the
		// armed-publication pair appends EXACTLY ONE invalidation event
		// (reason inventory-amended); the rejection leg appends NONE. Combined
		// with the persist-failure ordering leg below, this closes the
		// event-contract coverage the round-5 reviewer required.
		const session = 'transaction-events-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'events-lane-a', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'events-batch-a' },
		);
		await armLivePublicationGeneration(session);
		const eventsPath = coreEventsFilePath(directory);
		const eventsBefore = readEventsFile(eventsPath);
		// Rejection first: two lanes in the same ownership array claim FB-002.
		// (The duplicate-batch rejection is unusable here because compute1's
		// publication supersession clears prFeedbackVerifications before
		// compute2 reads it — stateful exclusivity is the surviving rejection.)
		let threw: string | null = null;
		try {
			await declareAndEnforcePrFeedbackVerification(
				directory,
				session,
				['FB-001', 'FB-002'],
				[
					{ laneId: 'events-lane-b', ownedItemIds: ['FB-002'] },
					{ laneId: 'events-lane-b2', ownedItemIds: ['FB-002'] },
				],
				{ prHeadSha: 'abc123', batchId: 'events-batch-b' },
			);
		} catch (error) {
			threw = String((error as Error).message);
		}
		expect(threw).toContain('owned by both');
		expect(readEventsFile(eventsPath)).toBe(eventsBefore);
		// Success: a fresh batch id amends the inventory.
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001', 'FB-002'],
			[{ laneId: 'events-lane-c', ownedItemIds: ['FB-002'] }],
			{ prHeadSha: 'abc123', batchId: 'events-batch-c' },
		);
		const eventsAfter = readEventsFile(eventsPath);
		expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
		const newLines = eventsAfter
			.slice(eventsBefore.length)
			.split('\n')
			.filter((line) => line.length > 0);
		const appendedEvents = newLines.map(
			(line) => JSON.parse(line) as Record<string, unknown>,
		);
		// The store bootstrap may prepend a manifest header when the file is
		// created; every OTHER appended record must be exactly the one
		// invalidation event.
		const invalidations = appendedEvents.filter(
			(event) => event.type === 'pr_feedback_publication_invalidated',
		);
		const nonManifest = appendedEvents.filter(
			(event) => event.type !== 'swarm-events-manifest',
		);
		expect(nonManifest).toHaveLength(1);
		expect(invalidations).toHaveLength(1);
		expect(invalidations[0].reason).toBe('inventory-amended');
		expect(invalidations[0].generation).toBe(1);
		expect(invalidations[0].previousState).toBe('armed');
		expect(invalidations[0].supersededBatchIds).toEqual(['gen1-sbr-batch']);
	}, 60_000);

	test('a persist failure appends NO event (append follows the persist, not precedes it)', async () => {
		// Ordering discriminator: force the transaction's single persistState to
		// throw STRICTLY AFTER compute1/compute2 (so the invalidation event
		// candidate already exists in memory) but BEFORE any append could run.
		// Reads keep working, so both the no-state and no-event halves are
		// directly assertable. An append-before-persist implementation would
		// leave an orphaned event in the store.
		const session = 'transaction-order-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declareAndEnforcePrFeedbackVerification(
			directory,
			session,
			['FB-001'],
			[{ laneId: 'order-lane-a', ownedItemIds: ['FB-001'] }],
			{ prHeadSha: 'abc123', batchId: 'order-batch-a' },
		);
		await armLivePublicationGeneration(session);
		const eventsPath = coreEventsFilePath(directory);
		const eventsBefore = readEventsFile(eventsPath);
		// Inject the persist failure through the module's own call-time hook.
		// The failing dispatch makes exactly TWO session-state lock
		// acquisitions: bind's session-state lock (the head is already bound,
		// so bind is a read + lock cycle, not a tracking validation write), then
		// the transaction's single persistState. Acquisition #1 passes,
		// acquisition #2 (the persist) throws — strictly AFTER compute1
		// produced the invalidation event candidate and BEFORE any append could
		// run. (The append-before-persist mutant is what proves this test
		// discriminates: it would leave an orphaned event.)
		let mutationsSinceArm = 0;
		gateInternals.beforeSessionStateLockWrite = async () => {
			mutationsSinceArm += 1;
			if (mutationsSinceArm >= 2) {
				throw new Error('INJECTED-PERSIST-FAILURE: ordering discriminator');
			}
		};
		let threw: unknown = null;
		try {
			await declareAndEnforcePrFeedbackVerification(
				directory,
				session,
				['FB-001', 'FB-002'],
				[{ laneId: 'order-lane-b', ownedItemIds: ['FB-002'] }],
				{ prHeadSha: 'abc123', batchId: 'order-batch-b' },
			);
		} catch (error) {
			threw = error;
		} finally {
			gateInternals.beforeSessionStateLockWrite = undefined;
		}
		// The throw must be the INJECTED persist failure (self-verifying the
		// injection point), never an earlier bind/compute rejection, and the
		// mutation count must be exactly bind-write + persist (a drift to more
		// writes means the fixture premise changed and must be revisited).
		expect(String((threw as Error | null)?.message ?? '')).toContain(
			'INJECTED-PERSIST-FAILURE',
		);
		expect(mutationsSinceArm).toBe(2);
		// NO event was appended despite compute1 having produced one, and no
		// state landed (the amendment never persisted; the publication stays
		// armed and the inventory stays single-item).
		expect(readEventsFile(eventsPath)).toBe(eventsBefore);
		const after = await readPrWorkflowGateState(directory, session);
		expect(after?.prFeedbackInventory).toEqual(['FB-001']);
		expect(after?.prFeedbackPublication?.active?.state).toBe('armed');
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

/**
 * Issue #2108 §4/§5 — drift invalidation from every actor, full approval
 * revocation, evidence-ABA closure, and the recovery-reachability contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	enforcePrWorkflowToolBefore,
	invalidatePrFeedbackPublication,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	createPublicationFixture,
	HEAD_SHA,
	POST_COMMIT_SHA,
	type PublicationFixture,
	REVISION,
} from './pr-workflow-publication.test-fixtures.js';

const SESSION_ID = 'pub-invalidation';
let fixture: PublicationFixture;

beforeEach(async () => {
	fixture = await createPublicationFixture();
});

afterEach(async () => {
	await fixture.teardown();
});

async function readActive(sessionId = SESSION_ID) {
	return fixture.readActive(sessionId);
}

async function attemptExactPush(sessionId = SESSION_ID): Promise<void> {
	await enforcePrWorkflowToolBefore(fixture.directory, sessionId, 'shell', {
		command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
	});
}

describe('controller invalidation (explicit rework transition)', () => {
	test('invalidates the armed generation and supersedes every content approval', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		const generation = await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'approved fix must change',
		);
		expect(generation.generation).toBe(1);
		expect(generation.state).toBe('invalidated');
		expect(generation.invalidationReason).toBe(
			'controller-rework:approved fix must change',
		);
		const { state, active } = await readActive();
		expect(active?.state).toBe('invalidated');
		expect(state?.prFeedbackReadyToPublish).toBeUndefined();
		// Every content-dependent approval is superseded (rebind precedent).
		expect(state?.prFeedbackStageA).toBeUndefined();
		expect(state?.prFeedbackVerifications).toBeUndefined();
		expect(state?.prFeedbackGateBatches).toBeUndefined();
		expect(state?.prFeedbackScopes).toBeUndefined();
		// The generation record itself survives for audit.
		expect(active?.evidence.batches.length).toBe(4);
	});

	test('requires a non-empty reason and refuses when no live window exists', async () => {
		await expect(
			invalidatePrFeedbackPublication(fixture.directory, SESSION_ID, '   '),
		).rejects.toThrow('non-empty reason');
		await expect(
			invalidatePrFeedbackPublication(
				fixture.directory,
				'no-such-session',
				'x',
			),
		).rejects.toThrow();
	});

	test('double invalidation is refused with the current state', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'first',
		);
		await expect(
			invalidatePrFeedbackPublication(fixture.directory, SESSION_ID, 'second'),
		).rejects.toThrow('already invalidated');
	});
});

describe('automatic drift invalidation (every actor, at detection points)', () => {
	const driftScenarios: Array<[string, () => void]> = [
		['digest', () => fixture.mutators.digest('different-content')],
		['head', () => fixture.mutators.head('0'.repeat(40))],
		['worktree', () => fixture.mutators.worktreeClean(false)],
		[
			'upstream',
			() =>
				fixture.mutators.upstream({
					remoteName: 'evil',
					remoteBranchRef: 'refs/heads/evil',
					remoteTrackingRef: 'refs/remotes/evil/evil',
				}),
		],
		[
			'remote-url',
			() => fixture.mutators.remoteUrl('https://***@evil.example/repo.git'),
		],
	];

	for (const [name, mutate] of driftScenarios) {
		test(`proven ${name} drift durably invalidates the generation`, async () => {
			await fixture.prepareArmedGeneration(SESSION_ID);
			mutate();
			await expect(attemptExactPush()).rejects.toThrow(
				'was INVALIDATED because approved content identity drifted',
			);
			const { state, active } = await readActive();
			expect(active?.state).toBe('invalidated');
			expect(active?.invalidationReason).toBe(
				`drift:${name === 'worktree' ? 'worktree' : name}`,
			);
			expect(state?.prFeedbackReadyToPublish).toBeUndefined();
			expect(state?.prFeedbackGateBatches).toBeUndefined();
		});
	}

	test('resolver failure stays armed and fails closed (unverifiable is not invalid)', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.digest('__throw__');
		_test_exports.resolvePrWorkflowRevisionDigest = () => {
			throw new Error('digest resolver outage');
		};
		await expect(attemptExactPush()).rejects.toThrow(
			'could not verify the armed publication identity component "digest"',
		);
		const { active, state } = await readActive();
		expect(active?.state).toBe('armed');
		expect(state?.prFeedbackReadyToPublish).toBeDefined();
	});

	test('no false invalidation: read-only interactions never revoke approval', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Several read-only gated interactions with identity intact.
		for (let i = 0; i < 3; i += 1) {
			await enforcePrWorkflowToolBefore(
				fixture.directory,
				SESSION_ID,
				'read',
				{},
			);
		}
		const { active, state } = await readActive();
		expect(active?.state).toBe('armed');
		expect(state?.prFeedbackReadyToPublish).toBeDefined();
		expect(state?.prFeedbackGateBatches?.length).toBe(4);
	});

	test('a rejected (non-matching) push does not invalidate — the window stays armed', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await expect(
			enforcePrWorkflowToolBefore(fixture.directory, SESSION_ID, 'shell', {
				command: 'git push evil 0000:refs/heads/pr-head',
			}),
		).rejects.toThrow('only the exact approved push');
		const { active } = await readActive();
		expect(active?.state).toBe('armed');
	});
});

describe('revocation + fresh approval (evidence N cannot satisfy N+1)', () => {
	test('content that drifts away and BACK (digest ABA) still requires fresh evidence', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		fixture.mutators.digest('temporary-change');
		await expect(attemptExactPush()).rejects.toThrow('INVALIDATED');
		// Content returns byte-identical to the approved digest.
		fixture.mutators.digest(REVISION);
		const { state } = await readActive();
		// The invalidated generation and its superseded receipts persist; the
		// active receipts are gone, so arming N+1 needs a fresh Stage A + gates
		// regardless of the digest returning to the approved value.
		expect(state?.prFeedbackStageA).toBeUndefined();
		expect(state?.prFeedbackGateBatches).toBeUndefined();
		expect(state?.prFeedbackPublication?.active?.state).toBe('invalidated');
	});

	test('re-arming after invalidation creates generation N+1 and supersedes N', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'rework',
		);
		// The corrected content walks the full ladder again (fresh batch ids
		// via sessionSeq so lane records stay distinct).
		await fixture.prepareArmedGeneration(SESSION_ID, 2);
		const { state, active, publication } = await readActive();
		expect(active?.generation).toBe(2);
		expect(active?.state).toBe('armed');
		expect(publication?.history.length).toBe(1);
		expect(publication?.history[0]?.generation).toBe(1);
		expect(publication?.history[0]?.supersededByGeneration).toBe(2);
		expect(state?.prFeedbackReadyToPublish?.localHead).toBe(POST_COMMIT_SHA);
	});

	test('from invalidated, the productive recovery paths are reachable', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		await invalidatePrFeedbackPublication(
			fixture.directory,
			SESSION_ID,
			'rework',
		);
		// Read-only status is reachable.
		await enforcePrWorkflowToolBefore(
			fixture.directory,
			SESSION_ID,
			'read',
			{},
		);
		// The ordered ladder restarts at verification (invalidation superseded
		// those receipts too): Stage A is gated behind re-settled verification
		// — reachable, in ladder order, not skipped.
		await expect(
			enforcePrWorkflowToolBefore(
				fixture.directory,
				SESSION_ID,
				'run_pr_feedback_stage_a',
				{},
			),
		).rejects.toThrow('immutable inventory and verification batches');
		// complete_pr_workflow refuses until fresh evidence arms a new
		// generation — stale approvals cannot publish.
		const { completePrWorkflow } = await import(
			'../../../src/hooks/pr-workflow-gate.js'
		);
		await expect(
			completePrWorkflow(
				fixture.directory,
				SESSION_ID,
				'PR_FEEDBACK',
				HEAD_SHA,
			),
		).rejects.toThrow();
		const { active } = await readActive();
		expect(active?.state).toBe('invalidated');
	});
});

describe('cross-workspace binding (copied .swarm cannot authorize)', () => {
	test('a generation armed in another workspace fails closed on identity check', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Simulate the copied-state attack: the state file is moved to a
		// DIFFERENT workspace identity. The workspace component re-checks
		// canonicalWorkspaceIdentity(directory) — simulate by rewriting the
		// persisted workspace identity to a foreign value (the equivalent of
		// copying the state into another repository).
		const stateBefore = await readActive();
		expect(stateBefore.active?.workspaceIdentity).toBeTruthy();
		await withSessionStateMutation(fixture.directory, SESSION_ID, async () => {
			const current = await readPrWorkflowGateState(
				fixture.directory,
				SESSION_ID,
			);
			if (!current?.prFeedbackPublication?.active) {
				throw new Error('missing active publication generation');
			}
			await writeStateWhileLocked(fixture.directory, {
				...current,
				prFeedbackPublication: {
					...current.prFeedbackPublication,
					active: {
						...current.prFeedbackPublication.active,
						workspaceIdentity: 'Z:/other/workspace',
					},
				},
			});
		});
		_test_exports.resetTrackedStateCache();
		await expect(attemptExactPush()).rejects.toThrow('INVALIDATED');
		const { active } = await readActive();
		expect(active?.invalidationReason).toBe('drift:workspace-identity');
	});
});

describe('evidence-join integrity (defense-in-depth, PR #2422 review PRR-009)', () => {
	test('a mutated receipt set with identity intact still invalidates via the evidence join', async () => {
		await fixture.prepareArmedGeneration(SESSION_ID);
		// Keep every identity component (digest/head/worktree/upstream/remote-
		// url/workspace) intact; forge ONLY the receipt set the generation's
		// join pinned — Stage A validatedAt from a different arming.
		await withSessionStateMutation(fixture.directory, SESSION_ID, async () => {
			const current = await readPrWorkflowGateState(
				fixture.directory,
				SESSION_ID,
			);
			if (!current?.prFeedbackStageA) {
				throw new Error('missing stage A state');
			}
			await writeStateWhileLocked(fixture.directory, {
				...current,
				prFeedbackStageA: {
					...current.prFeedbackStageA,
					validatedAt: '2000-01-01T00:00:00.000Z',
				},
			});
		});
		_test_exports.resetTrackedStateCache();
		await expect(attemptExactPush()).rejects.toThrow('INVALIDATED');
		const { active } = await readActive();
		expect(active?.invalidationReason).toBe('drift:evidence-join');
	});
});

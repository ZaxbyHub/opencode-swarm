import { describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	awaitingMergeByCallID,
	finishStandardWorktreeDispatch,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	HEX_A,
	HEX_B,
	HEX_C,
	HEX_D,
	HEX_E,
	makeDispatch,
	setupRecoveryIsolationHarness,
} from '../../helpers/worktree-isolation-recovery-2105-shared';

describe('issue #2105 worktree isolation recovery settlement', () => {
	const harness = setupRecoveryIsolationHarness();
	const QUEUED_AT = 1_785_369_600_000;

	test('partial merge on an original lane publishes a recovery authority', async () => {
		const dispatch = makeDispatch({
			reservationId: 'reservation-1',
			generation: 5,
			canonicalBranch: 'swarm/task-2-1',
			canonicalPath: `${harness.directory}/canonical`,
		});
		awaitingMergeByCallID.set(dispatch.callID, {
			callID: dispatch.callID,
			parentSessionID: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			mergeStrategy: dispatch.mergeStrategy,
			queuedAt: QUEUED_AT,
		});
		_internals.attemptMergeBackFromDirty = mock(async () => ({
			partial: true,
			stage: 'merge',
			message: 'conflict',
			autoCommitted: true,
			cleaned: false,
			conflictFiles: ['src/conflict.ts'],
			provenance: {
				operationId: 'op-1',
				sourceHead: HEX_C,
				targetHeadBefore: HEX_D,
				branchName: dispatch.handle.branchName,
				strategy: 'merge' as const,
			},
		}));
		_internals.recoverMergeBackFromImmutableCoordinates = mock(async () => ({
			conflict: true as const,
			files: ['src/conflict.ts'],
			message: 'conflict',
		})) as never;
		const buildIdentity = mock(async () => ({
			originalCallID: dispatch.callID,
			parentSessionId: dispatch.parentSessionID,
			taskId: dispatch.planTaskId!,
			reservationId: 'reservation-1',
			generation: 5,
			canonicalBranch: 'swarm/task-2-1',
			canonicalPath: `${harness.directory}/canonical`,
			laneBranch: dispatch.handle.branchName,
			lanePath: dispatch.handle.worktreePath,
			expectedPrimaryHead: HEX_D,
			sourceBaseOid: HEX_B,
			sourceHeadOid: HEX_C,
			targetHeadOid: HEX_E,
			strategy: 'merge' as const,
			declaredConflictFiles: ['src/conflict.ts'],
		}));
		const publish = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-published',
				status: 'preserved' as const,
				immutable: {
					originalCallID: dispatch.callID,
					parentSessionId: dispatch.parentSessionID,
					taskId: dispatch.planTaskId!,
					reservationId: 'reservation-1',
					generation: 5,
					canonicalBranch: 'swarm/task-2-1',
					canonicalPath: `${harness.directory}/canonical`,
					laneBranch: dispatch.handle.branchName,
					lanePath: dispatch.handle.worktreePath,
					expectedPrimaryHead: HEX_D,
					sourceBaseOid: HEX_B,
					sourceHeadOid: HEX_C,
					targetHeadOid: HEX_E,
					strategy: 'merge' as const,
					declaredConflictFiles: ['src/conflict.ts'],
					createdAt: 1,
				},
			},
		}));
		_internals.buildWorktreeRecoveryPublishIdentity = buildIdentity as never;
		_internals.publishWorktreeRecoveryAuthority = publish as never;

		const result = await finishStandardWorktreeDispatch(
			harness.directory,
			dispatch,
			undefined,
			dispatch.callID,
		);

		expect(result.outcome).toBe('partial');
		expect(buildIdentity).toHaveBeenCalledTimes(1);
		expect(publish).toHaveBeenCalledTimes(1);
	});

	test('partial merge on a claimed recovery lane releases the exact claim instead of publishing a new authority', async () => {
		const dispatch = makeDispatch({
			recoveryClaim: {
				authorityDigest: 'digest-2',
				claimRevision: 3,
				rawToken: 'token-3',
			},
		});
		awaitingMergeByCallID.set(dispatch.callID, {
			callID: dispatch.callID,
			parentSessionID: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			mergeStrategy: dispatch.mergeStrategy,
			queuedAt: QUEUED_AT,
		});
		_internals.attemptMergeBackFromDirty = mock(async () => ({
			partial: true,
			stage: 'merge',
			message: 'conflict',
			autoCommitted: true,
			cleaned: false,
			conflictFiles: ['src/conflict.ts'],
			provenance: {
				operationId: 'op-2',
				sourceHead: HEX_C,
				targetHeadBefore: HEX_D,
				branchName: dispatch.handle.branchName,
				strategy: 'merge' as const,
			},
		}));
		_internals.recoverMergeBackFromImmutableCoordinates = mock(async () => ({
			conflict: true as const,
			files: ['src/conflict.ts'],
			message: 'conflict',
		})) as never;
		const releaseClaim = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-2',
				status: 'preserved' as const,
				immutable: {
					originalCallID: 'call-original',
					parentSessionId: 'parent-1',
					taskId: '2.1',
					reservationId: 'reservation-1',
					generation: 3,
					canonicalBranch: 'swarm/task-2-1',
					canonicalPath: `${harness.directory}/canonical`,
					laneBranch: dispatch.handle.branchName,
					lanePath: dispatch.handle.worktreePath,
					expectedPrimaryHead: HEX_A,
					sourceBaseOid: HEX_B,
					sourceHeadOid: HEX_C,
					targetHeadOid: HEX_D,
					strategy: 'merge' as const,
					createdAt: 1,
				},
			},
		}));
		const publish = mock(() => {
			throw new Error(
				'must not publish a new authority for a claimed recovery lane',
			);
		});
		_internals.releaseWorktreeRecoveryClaim = releaseClaim as never;
		_internals.publishWorktreeRecoveryAuthority = publish as never;
		_internals.renewWorktreeRecoveryClaim = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-2',
			},
		})) as never;

		const result = await finishStandardWorktreeDispatch(
			harness.directory,
			dispatch,
			undefined,
			dispatch.callID,
		);

		expect(result.outcome).toBe('partial');
		expect(releaseClaim).toHaveBeenCalledTimes(1);
		expect(publish).not.toHaveBeenCalled();
	});

	test('partial merge on a claimed recovery lane fails closed when claim release is stale', async () => {
		const dispatch = makeDispatch({
			recoveryClaim: {
				authorityDigest: 'digest-2',
				claimRevision: 3,
				rawToken: 'token-3',
			},
		});
		awaitingMergeByCallID.set(dispatch.callID, {
			callID: dispatch.callID,
			parentSessionID: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			mergeStrategy: dispatch.mergeStrategy,
			queuedAt: QUEUED_AT,
		});
		_internals.attemptMergeBackFromDirty = mock(async () => ({
			partial: true,
			stage: 'merge',
			message: 'conflict',
			autoCommitted: true,
			cleaned: false,
			conflictFiles: ['src/conflict.ts'],
			provenance: {
				operationId: 'op-2b',
				sourceHead: HEX_C,
				targetHeadBefore: HEX_D,
				branchName: dispatch.handle.branchName,
				strategy: 'merge' as const,
			},
		}));
		_internals.renewWorktreeRecoveryClaim = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-2',
			},
		})) as never;
		_internals.releaseWorktreeRecoveryClaim = mock(() => ({
			ok: false as const,
			code: 'stale_claim' as const,
			reason: 'claim already changed owners',
		})) as never;

		const result = await finishStandardWorktreeDispatch(
			harness.directory,
			dispatch,
			undefined,
			dispatch.callID,
		);

		expect(result).toMatchObject({
			outcome: 'failed',
			stage: 'recovery-claim-release',
		});
	});

	test('successful merge on a claimed recovery lane finalizes the exact claim after cleanup', async () => {
		const dispatch = makeDispatch({
			recoveryClaim: {
				authorityDigest: 'digest-3',
				claimRevision: 4,
				rawToken: 'token-4',
			},
		});
		awaitingMergeByCallID.set(dispatch.callID, {
			callID: dispatch.callID,
			parentSessionID: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			mergeStrategy: dispatch.mergeStrategy,
			queuedAt: QUEUED_AT,
		});
		const dirtyMerge = mock(async () => ({
			merged: true,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
			reconciled: false,
			provenance: {
				operationId: 'op-3',
				sourceHead: HEX_C,
				targetHeadBefore: HEX_D,
				branchName: dispatch.handle.branchName,
				strategy: 'merge' as const,
			},
		}));
		_internals.attemptMergeBackFromDirty = dirtyMerge;
		const exactRecovery = mock(async () => ({
			merged: true as const,
			strategy: 'cherry-pick' as const,
			sourceCommitOrder: [HEX_B, HEX_C],
			rewrittenCommitOrder: [HEX_D, HEX_E],
		}));
		_internals.recoverMergeBackFromImmutableCoordinates =
			exactRecovery as never;
		_internals.removeWorktree = mock(async () => ({
			success: true as const,
		})) as never;
		_internals.postMergeCleanup = mock(async () => ({
			cleaned: true as const,
		})) as never;
		const renew = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-3',
			},
		}));
		const finalize = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-3',
				status: 'finalized' as const,
				immutable: {
					originalCallID: 'call-original',
					parentSessionId: 'parent-1',
					taskId: '2.1',
					reservationId: 'reservation-1',
					generation: 3,
					canonicalBranch: 'swarm/task-2-1',
					canonicalPath: `${harness.directory}/canonical`,
					laneBranch: dispatch.handle.branchName,
					lanePath: dispatch.handle.worktreePath,
					expectedPrimaryHead: HEX_A,
					sourceBaseOid: HEX_B,
					sourceHeadOid: HEX_C,
					targetHeadOid: HEX_D,
					strategy: 'merge' as const,
					createdAt: 1,
				},
				finalizedAt: 2,
			},
		}));
		_internals.renewWorktreeRecoveryClaim = renew as never;
		_internals.finalizeWorktreeRecoveryAuthority = finalize as never;

		const result = await finishStandardWorktreeDispatch(
			harness.directory,
			dispatch,
			undefined,
			dispatch.callID,
		);

		expect(result.outcome).toBe('merged');
		expect(dirtyMerge).not.toHaveBeenCalled();
		expect(exactRecovery).toHaveBeenCalledWith(
			harness.directory,
			dispatch.recoveryClaim?.coordinates,
		);
		expect(renew).toHaveBeenCalledTimes(2);
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(finalize.mock.calls[0]?.[1]).toMatchObject({
			authorityDigest: 'digest-3',
			claimantCallID: 'call-1',
			claimRevision: 4,
			rawToken: 'token-4',
			settlement: {
				sourceCommitOrder: [HEX_B, HEX_C],
				rewrittenCommitOrder: [HEX_D, HEX_E],
			},
		});
	});

	test('partial merge on an original lane fails when recovery authority publication cannot be persisted', async () => {
		const dispatch = makeDispatch({
			reservationId: 'reservation-1',
			generation: 5,
			canonicalBranch: 'swarm/task-2-1',
			canonicalPath: `${harness.directory}/canonical`,
		});
		awaitingMergeByCallID.set(dispatch.callID, {
			callID: dispatch.callID,
			parentSessionID: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			mergeStrategy: dispatch.mergeStrategy,
			queuedAt: QUEUED_AT,
		});
		_internals.attemptMergeBackFromDirty = mock(async () => ({
			partial: true,
			stage: 'merge',
			message: 'conflict',
			autoCommitted: true,
			cleaned: false,
			conflictFiles: ['src/conflict.ts'],
			provenance: {
				operationId: 'op-publish-fail',
				sourceHead: HEX_C,
				targetHeadBefore: HEX_D,
				branchName: dispatch.handle.branchName,
				strategy: 'merge' as const,
			},
		}));
		_internals.buildWorktreeRecoveryPublishIdentity = mock(async () => ({
			originalCallID: dispatch.callID,
			parentSessionId: dispatch.parentSessionID,
			taskId: dispatch.planTaskId!,
			reservationId: 'reservation-1',
			generation: 5,
			canonicalBranch: 'swarm/task-2-1',
			canonicalPath: `${harness.directory}/canonical`,
			laneBranch: dispatch.handle.branchName,
			lanePath: dispatch.handle.worktreePath,
			expectedPrimaryHead: HEX_D,
			sourceBaseOid: HEX_B,
			sourceHeadOid: HEX_C,
			targetHeadOid: HEX_E,
			strategy: 'merge' as const,
			declaredConflictFiles: ['src/conflict.ts'],
		})) as never;
		_internals.publishWorktreeRecoveryAuthority = mock(() => ({
			ok: false as const,
			code: 'uncertain_store' as const,
			reason: 'store write failed',
		})) as never;

		const result = await finishStandardWorktreeDispatch(
			harness.directory,
			dispatch,
			undefined,
			dispatch.callID,
		);

		expect(result).toMatchObject({
			outcome: 'failed',
			stage: 'recovery-authority-publish',
		});
	});

	test('unexpected merge dependency failure returns typed settlement and clears awaiting registry', async () => {
		const dispatch = makeDispatch();
		awaitingMergeByCallID.set(dispatch.callID, {
			callID: dispatch.callID,
			parentSessionID: dispatch.parentSessionID,
			taskId: dispatch.taskId,
			planTaskId: dispatch.planTaskId,
			branch: dispatch.handle.branchName,
			worktreePath: dispatch.handle.worktreePath,
			mergeStrategy: dispatch.mergeStrategy,
			queuedAt: QUEUED_AT,
		});
		_internals.attemptMergeBackFromDirty = mock(async () => {
			throw new Error('simulated merge dependency failure');
		}) as never;

		const result = await finishStandardWorktreeDispatch(
			harness.directory,
			dispatch,
			undefined,
			dispatch.callID,
		);

		expect(result).toMatchObject({ outcome: 'failed', stage: 'merge' });
		expect(result.message).toContain('simulated merge dependency failure');
		expect(awaitingMergeByCallID.has(dispatch.callID)).toBe(false);
	});
});

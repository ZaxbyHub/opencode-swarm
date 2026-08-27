import { describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	abortStandardWorktreeDispatch,
	precreateStandardWorktreeSession,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, swarmState } from '../../../src/state';
import {
	HEX_A,
	HEX_B,
	HEX_C,
	HEX_D,
	makeDispatch,
	setupRecoveryIsolationHarness,
} from '../../helpers/worktree-isolation-recovery-2105-shared';

describe('issue #2105 worktree isolation recovery routing lifecycle', () => {
	const harness = setupRecoveryIsolationHarness();

	test('precreate re-dispatch claims a preserved authority and reuses the preserved lane', async () => {
		const worktreePath = `${harness.directory}/.swarm-worktrees/parent-1/task-1`;
		const branchName = 'swarm/lane/parent-1/task-1';
		const authority = {
			schemaVersion: 2 as const,
			authorityDigest: 'digest-1',
			status: 'preserved' as const,
			immutable: {
				originalCallID: 'call-original',
				parentSessionId: 'parent-1',
				taskId: '2.1',
				reservationId: 'reservation-1',
				generation: 3,
				canonicalBranch: 'swarm/task-2-1',
				canonicalPath: `${harness.directory}/.swarm-canonical/2.1`,
				laneBranch: branchName,
				lanePath: worktreePath,
				expectedPrimaryHead: HEX_A,
				sourceBaseOid: HEX_B,
				sourceHeadOid: HEX_C,
				targetHeadOid: HEX_D,
				strategy: 'rebase' as const,
				createdAt: 1,
			},
		};
		const createSession = mock(async () => ({
			data: { id: 'child-recovered' },
		}));
		swarmState.opencodeClient = {
			session: { create: createSession },
		} as never;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as never;
		_internals.preProvisionCollisionCheck = mock(async () => ({
			collision: true,
			existingBranch: branchName,
			ownerSessionId: 'parent-1',
			worktreePath,
		}));
		_internals.lookupWorktreeRecoveryAuthoritiesByTask = mock(() => ({
			status: 'ok' as const,
			authorities: [authority],
		})) as never;
		const claim = mock((_dir, request) => ({
			ok: true as const,
			rawToken: 'token-1',
			credentialPath: `${harness.directory}/.swarm/worktree-recovery-claims/digest-1.json`,
			authority: {
				...authority,
				status: 'claimed' as const,
				claim: {
					claimantCallID: 'call-1',
					claimantSessionId: 'parent-1',
					childSessionId: request.createChildSession(),
					claimRevision: 4,
					attempt: 2,
					leaseExpiresAt: 1234,
					claimTokenDigest: 'digest-token',
					claimedAt: 1000,
				},
			},
		}));
		_internals.claimWorktreeRecoveryAuthority = claim as never;
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => {
			throw new Error('must not classify a claimed recovery lane');
		}) as never;
		_internals.provisionWorktree = mock(async () => {
			throw new Error('must not provision a new lane for claimed recovery');
		});
		_internals.removeWorktree = mock(async () => {
			throw new Error('must not remove a preserved recovery lane');
		}) as never;
		_internals.postMergeCleanup = mock(async () => {
			throw new Error('must not delete a preserved recovery branch');
		}) as never;

		const outputArgs: Record<string, unknown> = {
			prompt: 'TASK: 2.1\nFILE: src/retry.ts',
		};
		await precreateStandardWorktreeSession({
			config: { worktree: { policy: 'auto' } } as never,
			directory: harness.directory,
			parentSessionID: 'parent-1',
			callID: 'call-1',
			taskId: 'task-1',
			planTaskId: '2.1',
			outputArgs,
		});

		expect(createSession).toHaveBeenCalledTimes(1);
		expect(createSession.mock.calls[0]?.[0]).toMatchObject({
			body: { parentID: 'parent-1' },
			query: { directory: worktreePath },
		});
		expect(claim).toHaveBeenCalledTimes(1);
		expect(outputArgs.task_id).toBe('child-recovered');
		expect(String(outputArgs.prompt)).toContain(
			`authoritative_lane_root: ${JSON.stringify(worktreePath)}`,
		);
		expect(String(outputArgs.prompt)).toContain(
			'do not change directory into, or edit/write through, the primary checkout or any other worktree',
		);
		expect(String(outputArgs.prompt)).toContain(
			'FILE: src/example.ts means <authoritative_lane_root>/src/example.ts',
		);
		const dispatch = standardWorktreeByCallID.get('call-1');
		expect(dispatch?.handle.worktreePath).toBe(worktreePath);
		expect(dispatch?.mergeStrategy).toBe('rebase');
		expect(dispatch?.recoveryClaim).toMatchObject({
			authorityDigest: 'digest-1',
			claimRevision: 4,
			rawToken: 'token-1',
		});
	});

	test('precreate blocks expired-claim transfer while the previous claimant dispatch is still tracked live', async () => {
		const worktreePath = `${harness.directory}/.swarm-worktrees/parent-1/task-1`;
		const branchName = 'swarm/lane/parent-1/task-1';
		const authority = {
			schemaVersion: 2 as const,
			authorityDigest: 'digest-live',
			status: 'claimed' as const,
			immutable: {
				originalCallID: 'call-original',
				parentSessionId: 'parent-1',
				taskId: '2.1',
				reservationId: 'reservation-1',
				generation: 3,
				canonicalBranch: 'swarm/task-2-1',
				canonicalPath: `${harness.directory}/.swarm-canonical/2.1`,
				laneBranch: branchName,
				lanePath: worktreePath,
				expectedPrimaryHead: HEX_A,
				sourceBaseOid: HEX_B,
				sourceHeadOid: HEX_C,
				targetHeadOid: HEX_D,
				strategy: 'rebase' as const,
				createdAt: 1,
			},
			claim: {
				claimantCallID: 'call-live',
				claimantSessionId: 'parent-1',
				childSessionId: 'child-live',
				claimRevision: 2,
				attempt: 1,
				leaseExpiresAt: 0,
				claimTokenDigest: 'digest-token',
				claimedAt: 1,
			},
		};
		swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({ data: { id: 'child-recovered' } })),
			},
		} as never;
		const liveChild = ensureAgentSession('child-live', 'coder', worktreePath);
		liveChild.workspaceDirectory = worktreePath;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as never;
		_internals.preProvisionCollisionCheck = mock(async () => ({
			collision: true,
			existingBranch: branchName,
			ownerSessionId: 'parent-1',
			worktreePath,
		}));
		_internals.lookupWorktreeRecoveryAuthoritiesByTask = mock(() => ({
			status: 'ok' as const,
			authorities: [authority],
		})) as never;
		_internals.claimWorktreeRecoveryAuthority = mock(async (_dir, request) =>
			request
				.revalidateExpiredClaim?.({
					authority,
					previousClaim: authority.claim!,
				})
				.then((verdict) =>
					verdict?.ok
						? {
								ok: true as const,
								rawToken: 'token-1',
								credentialPath: `${harness.directory}/.swarm/worktree-recovery-claims/digest-live.json`,
								authority,
							}
						: {
								ok: false as const,
								code: 'revalidation_failed' as const,
								reason: verdict?.reason ?? 'missing verdict',
							},
				),
		) as never;

		await expect(
			precreateStandardWorktreeSession({
				config: { worktree: { policy: 'auto' } } as never,
				directory: harness.directory,
				parentSessionID: 'parent-1',
				callID: 'call-1',
				taskId: 'task-1',
				planTaskId: '2.1',
				outputArgs: { prompt: 'TASK: 2.1\nFILE: src/retry.ts' },
			}),
		).rejects.toThrow(
			'expired recovery claim still belongs to a live claimant session or dispatch',
		);
	});

	test('aborting a claimed recovery lane preserves the lane and releases the exact claim', async () => {
		const dispatch = makeDispatch({
			recoveryClaim: {
				authorityDigest: 'digest-1',
				claimRevision: 2,
				rawToken: 'token-2',
			},
		});
		standardWorktreeByCallID.set(dispatch.callID, dispatch);
		const renewClaim = mock(() => ({
			ok: true as const,
			authority: { schemaVersion: 2 as const, authorityDigest: 'digest-1' },
		}));
		const removeWorktree = mock(async () => ({ success: true as const }));
		const cleanupBranch = mock(async () => ({ cleaned: true as const }));
		const releaseClaim = mock(() => ({
			ok: true as const,
			authority: {
				schemaVersion: 2 as const,
				authorityDigest: 'digest-1',
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
		_internals.renewWorktreeRecoveryClaim = renewClaim as never;
		_internals.removeWorktree = removeWorktree as never;
		_internals.postMergeCleanup = cleanupBranch as never;
		_internals.releaseWorktreeRecoveryClaim = releaseClaim as never;

		await abortStandardWorktreeDispatch(
			dispatch.callID,
			'cancelled',
			harness.directory,
		);

		expect(renewClaim).toHaveBeenCalledTimes(1);
		expect(releaseClaim).toHaveBeenCalledTimes(1);
		expect(releaseClaim.mock.calls[0]?.[1]).toMatchObject({
			authorityDigest: 'digest-1',
			claimantCallID: 'call-1',
			claimRevision: 2,
			rawToken: 'token-2',
		});
		expect(removeWorktree).not.toHaveBeenCalled();
		expect(cleanupBranch).not.toHaveBeenCalled();
		expect(standardWorktreeByCallID.has(dispatch.callID)).toBe(false);
	});

	test('aborting a claimed recovery lane fails closed when the exact claim cannot be released', async () => {
		const dispatch = makeDispatch({
			recoveryClaim: {
				authorityDigest: 'digest-stale',
				claimRevision: 2,
				rawToken: 'token-stale',
			},
		});
		standardWorktreeByCallID.set(dispatch.callID, dispatch);
		_internals.renewWorktreeRecoveryClaim = mock(() => ({
			ok: true as const,
			authority: { schemaVersion: 2 as const, authorityDigest: 'digest-stale' },
		})) as never;
		_internals.releaseWorktreeRecoveryClaim = mock(() => ({
			ok: false as const,
			code: 'stale_claim' as const,
			reason: 'claim already changed owners',
		})) as never;

		await expect(
			abortStandardWorktreeDispatch(
				dispatch.callID,
				'cancelled',
				harness.directory,
			),
		).rejects.toThrow('STANDARD_WORKTREE_RECOVERY_ABORT_RELEASE_FAILED');
		expect(standardWorktreeByCallID.has(dispatch.callID)).toBe(true);
	});
});

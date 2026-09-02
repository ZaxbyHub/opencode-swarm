import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState, swarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { withFrozenClockAsync } from '../../helpers/test-clock';

const originals = {
	tryAcquireWorktreeLifecycleLock: _internals.tryAcquireWorktreeLifecycleLock,
	preProvisionCollisionCheck: _internals.preProvisionCollisionCheck,
	inspectStandardWorktreeCollisionOwnership:
		_internals.inspectStandardWorktreeCollisionOwnership,
	preserveDirtyWorktreeAtPath: _internals.preserveDirtyWorktreeAtPath,
	removeWorktree: _internals.removeWorktree,
	removeWorktreeProvisioningOwner: _internals.removeWorktreeProvisioningOwner,
	postMergeCleanup: _internals.postMergeCleanup,
	provisionWorktree: _internals.provisionWorktree,
	lookupWorktreeRecoveryAuthoritiesByTask:
		_internals.lookupWorktreeRecoveryAuthoritiesByTask,
	claimWorktreeRecoveryAuthority: _internals.claimWorktreeRecoveryAuthority,
	worktreeSessionCreateTimeoutMs: _internals.worktreeSessionCreateTimeoutMs,
};

describe('issue #2105 bounded lane session creation', () => {
	let directory: string;
	let cleanup: () => void;
	const parentSessionID = 'parent-1';
	const taskId = 'task-1';
	const branchName = `swarm/lane/${parentSessionID}/${taskId}`;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-session-create-'));
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		swarmState.opencodeClient = {
			session: {
				create: async () => ({ data: { id: 'child-session' } }),
			},
		} as never;
	});

	afterEach(() => {
		Object.assign(_internals, originals);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	function args(options?: { generation?: number }) {
		return {
			config: { worktree: { policy: 'auto' } } as never,
			directory,
			parentSessionID,
			callID: 'call-1',
			taskId,
			outputArgs: {},
			...(options?.generation !== undefined
				? { generation: options.generation }
				: {}),
		};
	}

	test('times out a direct lane session.create and cleans up the provisional owner and lane', async () => {
		const worktreePath = path.join(directory, '.swarm-worktrees', taskId);
		fs.mkdirSync(worktreePath, { recursive: true });
		const remove = mock(async () => ({ success: true as const }));
		const ownerCleanup = mock(async () => {});
		const createSession = mock(async () => new Promise(() => {}));
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: true,
			lock: { _release: async () => {} },
		})) as never;
		_internals.preProvisionCollisionCheck = mock(async () => ({
			collision: false,
		}));
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => {
			throw new Error('must not classify when no collision is present');
		}) as never;
		_internals.preserveDirtyWorktreeAtPath = mock(async () => {
			throw new Error('must not preserve when no collision is present');
		}) as never;
		_internals.removeWorktree = remove as never;
		_internals.removeWorktreeProvisioningOwner = ownerCleanup as never;
		_internals.postMergeCleanup = mock(async () => {
			throw new Error('must not clean up a non-collision branch');
		}) as never;
		_internals.provisionWorktree = mock(async () => ({
			worktreePath,
			branchName,
			purpose: 'lane' as const,
			id: taskId,
			sessionId: parentSessionID,
		}));
		_internals.worktreeSessionCreateTimeoutMs = 1;
		swarmState.opencodeClient = {
			session: {
				create: createSession,
			},
		} as never;

		await precreateStandardWorktreeSession(args({ generation: 0 }));

		expect(remove).toHaveBeenCalledTimes(1);
		expect(ownerCleanup).toHaveBeenCalledTimes(1);
		expect(createSession).toHaveBeenCalledTimes(1);
		expect(createSession.mock.calls[0]?.[0]).toMatchObject({
			query: { directory: worktreePath },
		});
		expect(ownerCleanup.mock.calls[0]?.[2]).toEqual({
			reservationId: 'foreground:parent-1:task-1:call-1',
			generation: 1,
			branchName,
		});
	});

	test('routes recovery session.create through the collision worktree path', async () => {
		await withFrozenClockAsync(async () => {
			const collisionPath = path.join(
				directory,
				'.swarm-worktrees',
				'recovery-lane',
			);
			const createSession = mock(async () => ({
				data: { id: 'child-recovered' },
			}));
			_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
				acquired: true,
				lock: { _release: async () => {} },
			})) as never;
			_internals.preProvisionCollisionCheck = mock(async () => ({
				collision: true,
				existingBranch: branchName,
				ownerSessionId: parentSessionID,
				worktreePath: collisionPath,
			}));
			const authority = {
				status: 'published' as const,
				immutable: {
					laneBranch: branchName,
					lanePath: collisionPath,
					reservationId: 'reservation-1',
					generation: 3,
					canonicalBranch: branchName,
					canonicalPath: directory,
					strategy: 'merge' as const,
					sourceBaseOid: 'base',
					sourceHeadOid: 'head',
					targetHeadOid: 'target',
				},
				authorityDigest: 'digest-1',
				claimCursor: null,
			};
			_internals.lookupWorktreeRecoveryAuthoritiesByTask = mock(() => ({
				status: 'ok' as const,
				authorities: [authority],
			})) as never;
			_internals.claimWorktreeRecoveryAuthority = mock(
				async (_dir, request) => {
					const childSessionId = await request.createChildSession();
					return {
						ok: true as const,
						rawToken: 'token-1',
						credentialPath: path.join(
							directory,
							'.swarm',
							'worktree-recovery-claims',
							'digest-1.json',
						),
						authority: {
							...authority,
							status: 'claimed' as const,
							claim: {
								claimantCallID: 'call-1',
								claimantSessionId: parentSessionID,
								childSessionId,
								claimRevision: 3,
								attempt: 1,
								leaseExpiresAt: Date.now() + 60_000,
								claimTokenDigest: 'digest-token',
								claimedAt: Date.now(),
							},
						},
					};
				},
			) as never;
			_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => {
				throw new Error('must not classify a recoverable collision');
			}) as never;
			_internals.removeWorktree = mock(async () => ({
				success: true as const,
			})) as never;
			_internals.postMergeCleanup = mock(async () => ({
				cleaned: true as const,
			})) as never;
			_internals.provisionWorktree = mock(async () => {
				throw new Error('must not provision a new lane during recovery');
			});
			swarmState.opencodeClient = {
				session: { create: createSession },
			} as never;

			await precreateStandardWorktreeSession(args());

			expect(createSession).toHaveBeenCalledTimes(1);
			expect(createSession.mock.calls[0]?.[0]).toMatchObject({
				query: { directory: collisionPath },
			});
		});
	});
});

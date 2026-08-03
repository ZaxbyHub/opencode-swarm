import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as path from 'node:path';
import {
	_internals,
	precreateStandardWorktreeSession,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState, swarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originals = {
	tryAcquireWorktreeLifecycleLock: _internals.tryAcquireWorktreeLifecycleLock,
	preProvisionCollisionCheck: _internals.preProvisionCollisionCheck,
	inspectStandardWorktreeCollisionOwnership:
		_internals.inspectStandardWorktreeCollisionOwnership,
	preserveDirtyWorktreeAtPath: _internals.preserveDirtyWorktreeAtPath,
	removeWorktree: _internals.removeWorktree,
	postMergeCleanup: _internals.postMergeCleanup,
	recordWorktreeProvisioningOwner: _internals.recordWorktreeProvisioningOwner,
	removeWorktreeProvisioningOwner: _internals.removeWorktreeProvisioningOwner,
	provisionWorktree: _internals.provisionWorktree,
};

describe('precreate durable collision protection', () => {
	let directory: string;
	let cleanup: () => void;
	const parentSessionID = 'parent-1';
	const taskId = 'task-1';
	const branchName = `swarm/lane/${parentSessionID}/${taskId}`;
	let worktreePath: string;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('swarm-precreate-owner-'));
		worktreePath = path.join(directory, '.swarm-worktrees', taskId);
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

	function args() {
		return {
			config: { worktree: { policy: 'auto' } } as never,
			directory,
			parentSessionID,
			callID: 'call-1',
			taskId,
			outputArgs: {},
		};
	}

	function installCollision() {
		const release = mock(async () => {});
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: true,
			lock: { _release: release },
		})) as never;
		_internals.preProvisionCollisionCheck = mock(async () => ({
			collision: true,
			existingBranch: branchName,
			ownerSessionId: parentSessionID,
			worktreePath,
		}));
		return release;
	}

	test.each([
		['primary', 'active'],
		['fallback', 'active'],
		['primary', 'preserved'],
		['provisioning', 'active'],
		['ownership-tag', 'preserved'],
		['merge-status', 'preserved'],
	] as const)('hard-stops a %s/%s durable owner without destructive cleanup', async (ownerKind, lifecycle) => {
		const release = installCollision();
		const preserve = mock(async () => ({
			outcome: 'clean' as const,
			preserved: false,
		}));
		const remove = mock(async () => ({ success: true as const }));
		const cleanupBranch = mock(async () => ({ cleaned: true as const }));
		const provision = mock(async () => ({
			worktreePath,
			branchName,
			purpose: 'lane' as const,
			id: taskId,
			sessionId: parentSessionID,
		}));
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => ({
			status: 'protected' as const,
			ownerKind,
			lifecycle,
			reason: 'durable owner exists',
		})) as never;
		_internals.preserveDirtyWorktreeAtPath = preserve as never;
		_internals.removeWorktree = remove as never;
		_internals.postMergeCleanup = cleanupBranch as never;
		_internals.provisionWorktree = provision as never;

		await expect(precreateStandardWorktreeSession(args())).rejects.toThrow(
			'STANDARD_WORKTREE_OWNER_PROTECTED',
		);
		expect(preserve).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(cleanupBranch).not.toHaveBeenCalled();
		expect(provision).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('hard-stops ownership uncertainty regardless of auto policy', async () => {
		const release = installCollision();
		const provision = mock(async () => {
			throw new Error('must not provision');
		});
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => ({
			status: 'uncertain' as const,
			reason: 'primary owner store is unreadable',
		})) as never;
		_internals.provisionWorktree = provision as never;

		await expect(precreateStandardWorktreeSession(args())).rejects.toThrow(
			'STANDARD_WORKTREE_OWNERSHIP_UNCERTAIN',
		);
		expect(provision).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test('cleans only a proven-unowned lane, verifies absence, then publishes v2 owner', async () => {
		const events: string[] = [];
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => {
			events.push('lock');
			return {
				acquired: true,
				lock: {
					_release: async () => {
						events.push('release');
					},
				},
			};
		}) as never;
		let collisionChecks = 0;
		_internals.preProvisionCollisionCheck = mock(async () => {
			collisionChecks++;
			events.push(`scan-${collisionChecks}`);
			return collisionChecks === 1
				? {
						collision: true,
						existingBranch: branchName,
						ownerSessionId: parentSessionID,
						worktreePath,
					}
				: { collision: false };
		});
		_internals.inspectStandardWorktreeCollisionOwnership = mock(async () => {
			events.push('classify');
			return { status: 'unowned' as const };
		}) as never;
		_internals.preserveDirtyWorktreeAtPath = mock(async () => {
			events.push('preserve');
			return { outcome: 'clean' as const, preserved: false };
		}) as never;
		_internals.removeWorktree = mock(async () => {
			events.push('remove');
			return { success: true as const };
		}) as never;
		_internals.postMergeCleanup = mock(async () => {
			events.push('cleanup-branch');
			return { cleaned: true as const };
		}) as never;
		const ownerInputs: unknown[] = [];
		_internals.recordWorktreeProvisioningOwner = mock((_directory, owner) => {
			events.push('record-owner');
			ownerInputs.push(owner);
			return { schemaVersion: 2, ...owner, createdAt: 1 };
		}) as never;
		_internals.provisionWorktree = mock(async () => {
			events.push('provision');
			return {
				worktreePath,
				branchName,
				purpose: 'lane' as const,
				id: taskId,
				sessionId: parentSessionID,
			};
		});

		await precreateStandardWorktreeSession(args());

		expect(events).toEqual([
			'lock',
			'scan-1',
			'classify',
			'preserve',
			'remove',
			'cleanup-branch',
			'scan-2',
			'record-owner',
			'release',
			'provision',
		]);
		expect(ownerInputs).toEqual([
			{
				callID: 'call-1',
				parentSessionId: parentSessionID,
				worktreeSessionId: parentSessionID,
				taskId,
			},
		]);
	});
});

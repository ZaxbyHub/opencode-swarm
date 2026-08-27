import { afterEach, beforeEach, mock } from 'bun:test';
import {
	_internals,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
} from '../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { createSafeTestDir } from './safe-test-dir';

export const HEX_A = 'a'.repeat(40);
export const HEX_B = 'b'.repeat(40);
export const HEX_C = 'c'.repeat(40);
export const HEX_D = 'd'.repeat(40);
export const HEX_E = 'e'.repeat(40);

export function makeDispatch(
	overrides: Partial<StandardWorktreeDispatch> = {},
): StandardWorktreeDispatch {
	const recoveryClaim = overrides.recoveryClaim
		? {
				...overrides.recoveryClaim,
				coordinates: overrides.recoveryClaim.coordinates ?? {
					sourceBaseOid: HEX_B,
					sourceHeadOid: HEX_C,
					targetHeadOid: HEX_D,
					strategy: 'merge' as const,
				},
			}
		: undefined;
	return {
		callID: 'call-1',
		parentSessionID: 'parent-1',
		taskId: 'task-1',
		planTaskId: '2.1',
		handle: {
			worktreePath: 'C:/repo/.swarm-worktrees/parent-1/task-1',
			branchName: 'swarm/lane/parent-1/task-1',
			purpose: 'lane',
			id: 'task-1',
			sessionId: 'parent-1',
		},
		mergeStrategy: 'merge',
		laneIndex: 0,
		...overrides,
		...(recoveryClaim ? { recoveryClaim } : {}),
	};
}

export type RecoveryIsolationHarness = {
	readonly directory: string;
	readonly originals: Record<string, unknown>;
};

export function setupRecoveryIsolationHarness(): RecoveryIsolationHarness {
	let directory = '';
	let cleanup = () => {};
	let originals: Record<string, unknown> = {};

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir(
			'worktree-isolation-recovery-2105-',
		));
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		ensureAgentSession('parent-1');
		originals = {
			tryAcquireWorktreeLifecycleLock:
				_internals.tryAcquireWorktreeLifecycleLock,
			preProvisionCollisionCheck: _internals.preProvisionCollisionCheck,
			inspectStandardWorktreeCollisionOwnership:
				_internals.inspectStandardWorktreeCollisionOwnership,
			lookupWorktreeRecoveryAuthoritiesByTask:
				_internals.lookupWorktreeRecoveryAuthoritiesByTask,
			claimWorktreeRecoveryAuthority: _internals.claimWorktreeRecoveryAuthority,
			renewWorktreeRecoveryClaim: _internals.renewWorktreeRecoveryClaim,
			provisionWorktree: _internals.provisionWorktree,
			removeWorktree: _internals.removeWorktree,
			postMergeCleanup: _internals.postMergeCleanup,
			releaseWorktreeRecoveryClaim: _internals.releaseWorktreeRecoveryClaim,
			finalizeWorktreeRecoveryAuthority:
				_internals.finalizeWorktreeRecoveryAuthority,
			publishWorktreeRecoveryAuthority:
				_internals.publishWorktreeRecoveryAuthority,
			buildWorktreeRecoveryPublishIdentity:
				_internals.buildWorktreeRecoveryPublishIdentity,
			attemptMergeBackFromDirty: _internals.attemptMergeBackFromDirty,
			recoverMergeBackFromImmutableCoordinates:
				_internals.recoverMergeBackFromImmutableCoordinates,
		};
		_internals.recoverMergeBackFromImmutableCoordinates = mock(async () => ({
			merged: true as const,
			strategy: 'merge',
		})) as never;
	});

	afterEach(() => {
		Object.assign(_internals, originals);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	return {
		get directory() {
			return directory;
		},
		get originals() {
			return originals;
		},
	};
}

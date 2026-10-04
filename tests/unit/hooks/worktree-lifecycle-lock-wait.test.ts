/**
 * Lane provisioning waits (bounded) for the worktree lifecycle lock.
 *
 * The lock is held across the collision check (a git spawn) and the owner
 * write, by every lane being provisioned and by init orphan recovery.
 * `tryAcquireLock` alone gives up after about 310ms, so parallel coder
 * dispatches that provisioned lanes at the same moment hard-stopped each
 * other with "init orphan recovery is active" — although no recovery ran.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	precreateStandardWorktreeSession,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { swarmState } from '../../../src/state';
import { setupRecoveryIsolationHarness } from '../../helpers/worktree-isolation-recovery-2105-shared';

const real = {
	tryAcquireWorktreeLifecycleLock: _internals.tryAcquireWorktreeLifecycleLock,
	worktreeLifecycleLockWaitMs: _internals.worktreeLifecycleLockWaitMs,
	now: _internals.now,
	sleep: _internals.sleep,
};

let clock = 0;
let slept: number[] = [];

beforeEach(() => {
	clock = 1_000;
	slept = [];
	_internals.now = () => clock;
	_internals.sleep = async (ms: number) => {
		slept.push(ms);
		clock += ms;
	};
});

afterEach(() => {
	Object.assign(_internals, real);
});

const ACQUIRED = { acquired: true, lock: { _release: async () => {} } };

describe('acquireWorktreeLifecycleLockWithin', () => {
	test('keeps retrying while another lane holds the lock, then acquires it', async () => {
		let attempts = 0;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => {
			attempts += 1;
			return attempts < 4 ? { acquired: false } : ACQUIRED;
		}) as never;
		const result = await _internals.acquireWorktreeLifecycleLockWithin(
			'/repo',
			'2.1',
			10_000,
		);
		expect(result.acquired).toBe(true);
		expect(attempts).toBe(4);
		expect(slept).toHaveLength(3);
		for (const ms of slept) {
			expect(ms).toBeGreaterThanOrEqual(50);
			expect(ms).toBeLessThan(250);
		}
	});

	test('gives up once the bounded wait is spent', async () => {
		let attempts = 0;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => {
			attempts += 1;
			return { acquired: false };
		}) as never;
		const result = await _internals.acquireWorktreeLifecycleLockWithin(
			'/repo',
			'2.1',
			1_000,
		);
		expect(result.acquired).toBe(false);
		expect(attempts).toBeGreaterThan(3);
		expect(clock - 1_000).toBeLessThanOrEqual(1_000);
	});

	test('a zero wait tries exactly once', async () => {
		let attempts = 0;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => {
			attempts += 1;
			return { acquired: false };
		}) as never;
		await _internals.acquireWorktreeLifecycleLockWithin('/repo', '2.1', 0);
		expect(attempts).toBe(1);
		expect(slept).toHaveLength(0);
	});
});

describe('precreateStandardWorktreeSession with a busy lifecycle lock', () => {
	const harness = setupRecoveryIsolationHarness();

	test('hard-stops after the wait with a message naming both holders', async () => {
		swarmState.opencodeClient = {
			session: { create: mock(async () => ({ data: { id: 'child' } })) },
		} as never;
		_internals.worktreeLifecycleLockWaitMs = 500;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: false,
		})) as never;
		const collisionCheck = mock(async () => ({ collision: false }));
		_internals.preProvisionCollisionCheck = collisionCheck as never;

		await expect(
			precreateStandardWorktreeSession({
				config: { worktree: { policy: 'auto' } } as never,
				directory: harness.directory,
				parentSessionID: 'parent-1',
				callID: 'call-busy',
				taskId: 'task-busy',
				planTaskId: '2.1',
				outputArgs: { prompt: 'TASK: 2.1' },
			}),
		).rejects.toThrow(
			/STANDARD_WORKTREE_LIFECYCLE_BUSY: .*another lane is provisioning or init orphan recovery/,
		);
		expect(collisionCheck).not.toHaveBeenCalled();
	});
});

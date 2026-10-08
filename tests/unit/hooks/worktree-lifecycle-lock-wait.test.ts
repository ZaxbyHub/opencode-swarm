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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	_internals,
	precreateStandardWorktreeSession,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { swarmState } from '../../../src/state';
import { setupRecoveryIsolationHarness } from '../../helpers/worktree-isolation-recovery-2105-shared';

const real = {
	tryAcquireWorktreeLifecycleLock: _internals.tryAcquireWorktreeLifecycleLock,
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

/**
 * A holder keeps the lock across a recovery-lane session.create bounded by
 * `worktree.session_create_timeout_ms`, so the wait follows that budget. The
 * waiting dispatch then runs its own session.create in the same host hook
 * call, so the wait also leaves room for that within the OpenCode 2 hook
 * budget.
 */
describe('resolveWorktreeLifecycleLockWaitMs', () => {
	const HOOK_BUDGET_MS = 60_000;
	const SETTLE_GRACE_MS = 5_000;

	test('the hook budget it assumes matches the OpenCode 2 adapter', () => {
		const source = readFileSync(
			join(import.meta.dir, '../../../src/host/v2/hooks.ts'),
			'utf8',
		);
		expect(source).toMatch(/const V2_HOOK_TIMEOUT_MS = 60_000;/);
	});

	test.each([
		// [session_create_timeout_ms, expected wait]
		[1_000, 10_000], // floor
		[10_000, 15_000], // budget + 5s margin
		[20_000, 20_000], // limited by room left in the hook
		[30_000, 10_000], // default: limited by room left in the hook
		[120_000, 10_000], // schema max: floor
	])('session_create_timeout_ms %d waits %d ms', (createMs, expected) => {
		expect(_internals.resolveWorktreeLifecycleLockWaitMs(createMs)).toBe(
			expected,
		);
	});

	test('wait + own create + settle grace + provisioning fits the hook budget', () => {
		const PROVISION_ALLOWANCE_MS = 15_000;
		for (let createMs = 1_000; createMs <= 40_000; createMs += 1_000) {
			const waitMs = _internals.resolveWorktreeLifecycleLockWaitMs(createMs);
			if (waitMs === 10_000) continue; // floor; a 30s+ create leaves no room
			expect(
				waitMs + createMs + SETTLE_GRACE_MS + PROVISION_ALLOWANCE_MS,
			).toBeLessThanOrEqual(HOOK_BUDGET_MS);
		}
	});
});

describe('precreateStandardWorktreeSession with a busy lifecycle lock', () => {
	const harness = setupRecoveryIsolationHarness();

	async function dispatchBusy(sessionCreateTimeoutMs: number) {
		swarmState.opencodeClient = {
			session: { create: mock(async () => ({ data: { id: 'child' } })) },
		} as never;
		_internals.tryAcquireWorktreeLifecycleLock = mock(async () => ({
			acquired: false,
		})) as never;
		const collisionCheck = mock(async () => ({ collision: false }));
		_internals.preProvisionCollisionCheck = collisionCheck as never;
		let message = '';
		await precreateStandardWorktreeSession({
			config: {
				worktree: {
					policy: 'auto',
					session_create_timeout_ms: sessionCreateTimeoutMs,
				},
			} as never,
			directory: harness.directory,
			parentSessionID: 'parent-1',
			callID: 'call-busy',
			taskId: 'task-busy',
			planTaskId: '2.1',
			outputArgs: { prompt: 'TASK: 2.1' },
		}).catch((error: Error) => {
			message = error.message;
		});
		expect(collisionCheck).not.toHaveBeenCalled();
		return message;
	}

	test('hard-stops after the wait with a message naming both holders and the knob', async () => {
		const message = await dispatchBusy(20_000);
		expect(message).toMatch(
			/STANDARD_WORKTREE_LIFECYCLE_BUSY: .*busy for 20s .*another lane is provisioning or init orphan recovery/,
		);
		expect(message).toContain('worktree.session_create_timeout_ms');
		// The fake clock advanced by the derived wait, not a fixed 10s.
		expect(clock - 1_000).toBeGreaterThanOrEqual(20_000);
		expect(clock - 1_000).toBeLessThan(20_250);
	});

	test('the default budget waits 10s', async () => {
		expect(await dispatchBusy(30_000)).toContain('busy for 10s');
	});
});

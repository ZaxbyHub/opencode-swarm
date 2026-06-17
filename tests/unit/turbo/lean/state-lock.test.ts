/**
 * Unit tests for withTurboStateLock and TurboStateLockTimeoutError (Issue #2).
 *
 * Covers:
 * - Successful lock acquisition and fn execution
 * - Error propagation when fn throws
 * - Lock release even when fn throws (finally-block guarantee)
 * - TurboStateLockTimeoutError when lock is held by another caller
 * - TurboStateLockTimeoutError constructor properties
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryAcquireLock } from '../../../../src/parallel/file-locks';
import {
	_internals,
	TurboStateLockTimeoutError,
	withTurboStateLock,
} from '../../../../src/turbo/lean/state-lock';

const savedTryAcquireLock = _internals.tryAcquireLock;

let tmpDir: string;
const SESSION_ID = 'sess-state-lock-test';

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-test-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	_internals.tryAcquireLock = savedTryAcquireLock;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('TurboStateLockTimeoutError', () => {
	test('has correct name and properties', () => {
		const err = new TurboStateLockTimeoutError('/some/dir', 'sess-abc', 5000);
		expect(err.name).toBe('TurboStateLockTimeoutError');
		expect(err.directory).toBe('/some/dir');
		expect(err.sessionID).toBe('sess-abc');
		expect(err.message).toContain('5000ms');
		expect(err.message).toContain('sess-abc');
		expect(err instanceof Error).toBe(true);
		expect(err instanceof TurboStateLockTimeoutError).toBe(true);
	});
});

describe('withTurboStateLock', () => {
	test('acquires lock, executes fn, and returns its result', async () => {
		const result = await withTurboStateLock(tmpDir, SESSION_ID, async () => {
			return 42;
		});
		expect(result).toBe(42);
	});

	test('propagates errors thrown by fn', async () => {
		const boom = new Error('deliberate-failure');
		await expect(
			withTurboStateLock(tmpDir, SESSION_ID, async () => {
				throw boom;
			}),
		).rejects.toThrow('deliberate-failure');
	});

	test('releases lock even when fn throws (lock reusable after failure)', async () => {
		const boom = new Error('fn-error');
		await expect(
			withTurboStateLock(tmpDir, SESSION_ID, async () => {
				throw boom;
			}),
		).rejects.toThrow('fn-error');

		// If the lock was properly released, a second call should succeed.
		const result = await withTurboStateLock(tmpDir, SESSION_ID, async () => {
			return 'recovered';
		});
		expect(result).toBe('recovered');
	});

	test('logs a warning when lock._release() throws but still returns fn() result', async () => {
		const warnSpy = spyOn(console, 'warn');

		// Inject a mock tryAcquireLock that returns a lock whose _release throws.
		_internals.tryAcquireLock = mock(async () => ({
			acquired: true as const,
			lock: {
				filePath: '.swarm/turbo-state.json',
				agent: 'lean-turbo-runner',
				taskId: SESSION_ID,
				timestamp: new Date().toISOString(),
				expiresAt: Date.now() + 60_000,
				_release: async () => {
					throw new Error('simulated release failure');
				},
			},
		}));

		// fn() should complete successfully even though release fails.
		const result = await withTurboStateLock(
			tmpDir,
			SESSION_ID,
			async () => 'ok',
		);
		expect(result).toBe('ok');
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain('state lock release failed');

		warnSpy.mockRestore();
	});

	test('retries and eventually throws TurboStateLockTimeoutError when tryAcquireLock throws', async () => {
		let callCount = 0;
		_internals.tryAcquireLock = mock(async () => {
			callCount++;
			throw new Error('simulated filesystem error during lock acquisition');
		});

		await expect(
			withTurboStateLock(tmpDir, SESSION_ID, async () => 'should-not-run', 150),
		).rejects.toBeInstanceOf(TurboStateLockTimeoutError);

		// Multiple retries should have been attempted before timing out.
		expect(callCount).toBeGreaterThan(1);
	});

	test('throws TurboStateLockTimeoutError when lock is held by another caller', async () => {
		// Hold the lock ourselves via the lower-level primitive.
		const held = await tryAcquireLock(
			tmpDir,
			'.swarm/turbo-state.json',
			'test-holder',
			'holder-session',
		);
		expect(held.acquired).toBe(true);

		let releaseHeld: (() => Promise<void>) | undefined;
		if (held.acquired) {
			releaseHeld = held.lock._release;
		}

		try {
			// withTurboStateLock should fail with a very short timeout.
			await expect(
				withTurboStateLock(
					tmpDir,
					SESSION_ID,
					async () => 'should-not-run',
					150,
				),
			).rejects.toBeInstanceOf(TurboStateLockTimeoutError);
		} finally {
			// Always release the held lock so cleanup can succeed.
			if (releaseHeld) {
				try {
					await releaseHeld();
				} catch {
					// non-fatal
				}
			}
		}
	});
});

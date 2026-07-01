/**
 * REGRESSION GUARD — issue #660 FR-004, finding F-09.
 *
 * Pins the retry configuration that `tryAcquireLock` passes to
 * `proper-lockfile`'s `lock()` (src/parallel/file-locks.ts ~L163-172):
 *   retries: { retries: 5, minTimeout: 10, maxTimeout: 500, factor: 2 }
 *
 * Prior buggy behavior (what the fix corrected): lock acquisition used
 * `retries: 0` (no automatic retry). Transient lock contention immediately
 * returned `acquired: false`, forcing a manual LLM-driven retry of the whole
 * tool call. The fix added bounded exponential-backoff retries so transient
 * contention is absorbed in-process before reporting contention.
 *
 * How this guard works (and how it fails on revert):
 *   `tryAcquireLock` calls `lockfile.lock(path, options)` directly (there is no
 *   `_internals` seam for the proper-lockfile dependency), so we intercept the
 *   `proper-lockfile` module via `mock.module` (normalizes to the allowlisted
 *   `src/proper-lockfile`) and capture the options object.
 *
 *   Revert that breaks this guard: changing the option back to `retries: 0`
 *   makes `options.retries` a number, so `typeof options.retries === 'object'`
 *   fails; any reduction below 5, removal of exponential backoff (factor < 2),
 *   or a non-growing window (maxTimeout <= minTimeout) also fails.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface LockRetries {
	retries: number;
	minTimeout?: number;
	maxTimeout?: number;
	factor?: number;
}
interface LockOptions {
	retries?: LockRetries | number;
	stale?: number;
	realpath?: boolean;
}

const capturedOptions: LockOptions[] = [];

// Capture the options proper-lockfile.lock() is invoked with, then return a
// no-op release function so tryAcquireLock reports success.
const lockSpy = mock(async (_lockPath: string, options: LockOptions) => {
	capturedOptions.push(options);
	return async () => {};
});

mock.module('proper-lockfile', () => ({
	default: {
		lock: lockSpy,
		unlock: mock(async () => {}),
	},
}));

// Import AFTER the mock is registered so file-locks binds the mocked module.
import { tryAcquireLock } from '../../../src/parallel/file-locks';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-locks-retry-guard-'));
	capturedOptions.length = 0;
	lockSpy.mockClear();
});

afterEach(() => {
	mock.restore();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
});

describe('file-locks — regression: tryAcquireLock retry config (F-09)', () => {
	test('passes bounded exponential-backoff retries (>=5) to proper-lockfile.lock', async () => {
		// Before the fix, the options were `retries: 0` (no retry), so transient
		// ELOCKED contention surfaced immediately. The fix passes a retries object
		// with exponential backoff.
		const result = await tryAcquireLock(tmpDir, 'target.ts', 'agent', 'task');

		expect(result.acquired).toBe(true);
		expect(lockSpy).toHaveBeenCalledTimes(1);
		expect(capturedOptions.length).toBe(1);

		const opts = capturedOptions[0];

		// retries must be an OBJECT (not the number 0 from the reverted config).
		expect(typeof opts.retries).toBe('object');
		const retries = opts.retries as LockRetries;

		// At least 5 retries — the core of the F-09 fix.
		expect(retries.retries).toBeGreaterThanOrEqual(5);
		// Exponential backoff (factor >= 2) over a growing window.
		expect(retries.factor ?? 0).toBeGreaterThanOrEqual(2);
		expect(retries.minTimeout ?? 0).toBeGreaterThan(0);
		expect(retries.maxTimeout ?? 0).toBeGreaterThan(retries.minTimeout ?? 0);

		// Stale timeout is still configured so dead locks expire.
		expect(opts.stale ?? 0).toBeGreaterThan(0);
	});
});

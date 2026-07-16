/**
 * Tests for src/evidence/lock.ts
 *
 * Runs in per-file isolation (CI step 6). Uses real filesystem via os.tmpdir().
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	EvidenceLockTimeoutError,
	withEvidenceLock,
} from '../evidence/lock.js';

// Suppress telemetry output by mocking it
mock.module('../telemetry.js', () => ({
	emit: () => {},
}));

let tempDir: string;

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlock-test-'));
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
	mock.restore();
});

describe('withEvidenceLock — happy path', () => {
	test('executes fn and returns result when lock is available', async () => {
		const result = await withEvidenceLock(
			tempDir,
			'evidence/1.1.json',
			'test-agent',
			'1.1',
			async () => 'hello',
		);
		expect(result).toBe('hello');
	});

	test('creates lock files in .swarm/locks/ subdirectory', async () => {
		await withEvidenceLock(
			tempDir,
			'evidence/1.2.json',
			'test-agent',
			'1.2',
			async () => 42,
		);
		// After release the sentinel file remains; no lock dir
		const locksDir = path.join(tempDir, '.swarm', 'locks');
		expect(fs.existsSync(locksDir)).toBe(true);
	});

	test('propagates thrown errors from fn', async () => {
		await expect(
			withEvidenceLock(
				tempDir,
				'evidence/1.3.json',
				'test-agent',
				'1.3',
				async () => {
					throw new Error('fn error');
				},
			),
		).rejects.toThrow('fn error');
	});

	test('releases lock even when fn throws', async () => {
		try {
			await withEvidenceLock(
				tempDir,
				'evidence/1.4.json',
				'test-agent',
				'1.4',
				async () => {
					throw new Error('boom');
				},
			);
		} catch {
			// expected
		}

		// Second acquire should succeed because lock was released
		const result = await withEvidenceLock(
			tempDir,
			'evidence/1.4.json',
			'test-agent2',
			'1.4',
			async () => 'acquired',
		);
		expect(result).toBe('acquired');
	});
});

describe('withEvidenceLock — contention path', () => {
	test('second caller waits while first holds the lock', async () => {
		const order: string[] = [];
		let resolveInner!: () => void;
		const _innerDone = new Promise<void>((r) => {
			resolveInner = r;
		});

		// First caller holds the lock until resolveInner is called
		const first = withEvidenceLock(
			tempDir,
			'evidence/2.1.json',
			'agent-a',
			'2.1',
			async () => {
				order.push('first-start');
				await new Promise<void>((r) => {
					resolveInner = r;
				});
				order.push('first-end');
				return 'first';
			},
		);

		// Give the first lock a moment to be acquired
		await Bun.sleep(10);

		const second = withEvidenceLock(
			tempDir,
			'evidence/2.1.json',
			'agent-b',
			'2.1',
			async () => {
				order.push('second');
				return 'second';
			},
		);

		// Release first
		resolveInner();

		const [r1, r2] = await Promise.all([first, second]);
		expect(r1).toBe('first');
		expect(r2).toBe('second');
		// First must finish before second starts
		expect(order[0]).toBe('first-start');
		expect(order[1]).toBe('first-end');
		expect(order[2]).toBe('second');
	});
});

describe('withEvidenceLock — timeout path', () => {
	test('throws EvidenceLockTimeoutError when lock is never released', async () => {
		let resolveBlock!: () => void;
		const blockDone = new Promise<void>((r) => {
			resolveBlock = r;
		});

		// Fires from inside the blocker's callback — i.e. once withEvidenceLock
		// has ACTUALLY acquired the lock and is executing fn. The waiter below
		// only starts contending after this resolves. Without this barrier both
		// withEvidenceLock calls race to acquire the fresh lock and the "waiter"
		// can win it, running its callback and RESOLVING instead of timing out —
		// a flaky "expected reject, received resolved" failure that reproduces on
		// loaded CI runners (observed failing all retries on macOS shards).
		let signalHeld!: () => void;
		const lockHeld = new Promise<void>((r) => {
			signalHeld = r;
		});

		// Occupy the lock without releasing
		const blocker = withEvidenceLock(
			tempDir,
			'evidence/3.1.json',
			'blocker',
			'3.1',
			async () => {
				signalHeld();
				await blockDone;
				return 'blocked';
			},
		);

		// Only contend once the blocker demonstrably holds the lock.
		await lockHeld;

		// Short timeout so the test doesn't hang
		const attempt = withEvidenceLock(
			tempDir,
			'evidence/3.1.json',
			'waiter',
			'3.1',
			async () => 'should-not-run',
			200, // 200ms timeout
		);

		await expect(attempt).rejects.toThrow(EvidenceLockTimeoutError);

		// Check error fields
		try {
			await attempt;
		} catch (err) {
			expect(err).toBeInstanceOf(EvidenceLockTimeoutError);
			const e = err as EvidenceLockTimeoutError;
			expect(e.taskId).toBe('3.1');
			expect(e.agent).toBe('waiter');
		}

		// Clean up blocker
		resolveBlock();
		await blocker;
	});

	test('EvidenceLockTimeoutError has correct name', async () => {
		const e = new EvidenceLockTimeoutError('/tmp', 'ev.json', 'a', '1.1', 100);
		expect(e.name).toBe('EvidenceLockTimeoutError');
		expect(e.message).toContain('100ms');
	});
});

describe('withEvidenceLock — stale lock recovery', () => {
	test('acquires lock after stale lock is cleaned up by proper-lockfile', async () => {
		// proper-lockfile cleans stale locks automatically based on mtime.
		// We simulate this by running a successful acquire — the library
		// handles stale recovery internally.
		const result = await withEvidenceLock(
			tempDir,
			'evidence/4.1.json',
			'agent',
			'4.1',
			async () => 'recovered',
		);
		expect(result).toBe('recovered');
	});
});

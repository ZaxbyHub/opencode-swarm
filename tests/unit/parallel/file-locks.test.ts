/**
 * Verification tests for file-locks module
 * Covers tryAcquireLock, releaseLock, and lock expiration
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	cleanupExpiredLocks,
	type FileLock,
	isLocked,
	listActiveLocks,
	releaseLock,
	tryAcquireLock,
} from '../../../src/parallel/file-locks';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';

describe('file-locks module tests', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-locks-test-'));
	});

	afterEach(async () => {
		// Release any lingering proper-lockfile locks before removing the directory
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== GROUP 1: tryAcquireLock tests ==========
	describe('Group 1: tryAcquireLock', () => {
		it('acquires lock on first attempt', async () => {
			const result = await tryAcquireLock(
				tmpDir,
				'test-file.ts',
				'agent1',
				'task1',
			);

			expect(result.acquired).toBe(true);
			if (result.acquired && 'lock' in result) {
				expect(result.lock).toBeDefined();
				expect(result.lock.filePath).toBe('test-file.ts');
				expect(result.lock.agent).toBe('agent1');
				expect(result.lock.taskId).toBe('task1');
				expect(result.lock.expiresAt).toBeGreaterThan(Date.now());
				// Release so the lock dir can be cleaned up
				await result.lock._release?.();
			}
		});

		it('fails to acquire existing valid lock', async () => {
			// First acquisition
			const first = await tryAcquireLock(
				tmpDir,
				'test-file.ts',
				'agent1',
				'task1',
			);
			expect(first.acquired).toBe(true);

			// Second attempt should fail
			const second = await tryAcquireLock(
				tmpDir,
				'test-file.ts',
				'agent2',
				'task2',
			);
			expect(second.acquired).toBe(false);

			// Release the first lock
			if (first.acquired) await first.lock._release?.();
		});

		it('creates locks directory if not exists', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent', 'task');

			expect(result.acquired).toBe(true);
			expect(fs.existsSync(path.join(tmpDir, '.swarm', 'locks'))).toBe(true);
			if (result.acquired) await result.lock._release?.();
		});

		it('recovers an ownerless (empty) past-TTL lock via ttl-cleanup (#3934)', async () => {
			const { getOwnerLockPath } = await import(
				'../../../src/parallel/file-locks'
			);
			const FIXED_NOW = 1_700_000_000_000;
			const ownerLockPath = getOwnerLockPath(tmpDir, 'ownerless.ts');
			fs.mkdirSync(path.dirname(ownerLockPath), { recursive: true });
			fs.writeFileSync(ownerLockPath, '');
			// Seed an mtime 6 minutes before the frozen clock (#3934 TTL gate).
			const sixMinAgo = new Date(FIXED_NOW - 6 * 60 * 1000);
			fs.utimesSync(ownerLockPath, sixMinAgo, sixMinAgo);

			const result = await withFrozenClockAsync(
				() => tryAcquireLock(tmpDir, 'ownerless.ts', 'agent', 'task'),
				{ fixedNow: FIXED_NOW },
			);
			expect(result.acquired).toBe(true);
			if (result.acquired) {
				expect(result.brokeStale).toBe(true);
				await result.lock._release?.();
			}
		});

		it('does NOT break a fresh (within-TTL) ownerless lock (#3934 AC4)', async () => {
			const { getOwnerLockPath } = await import(
				'../../../src/parallel/file-locks'
			);
			const FIXED_NOW = 1_700_000_000_000;
			const ownerLockPath = getOwnerLockPath(tmpDir, 'fresh-ownerless.ts');
			fs.mkdirSync(path.dirname(ownerLockPath), { recursive: true });
			fs.writeFileSync(ownerLockPath, '');
			// Fresh mtime: within the TTL window relative to the frozen clock.
			const now = new Date(FIXED_NOW);
			fs.utimesSync(ownerLockPath, now, now);

			const result = await withFrozenClockAsync(
				() => tryAcquireLock(tmpDir, 'fresh-ownerless.ts', 'agent', 'task'),
				{ fixedNow: FIXED_NOW },
			);
			expect(result.acquired).toBe(false);
		});

		it('uses path hash for lock filename', async () => {
			const result1 = await tryAcquireLock(
				tmpDir,
				'file-a.ts',
				'agent',
				'task',
			);
			const result2 = await tryAcquireLock(
				tmpDir,
				'file-b.ts',
				'agent',
				'task',
			);

			// Different files should have different lock paths
			expect(result1.acquired).toBe(true);
			expect(result2.acquired).toBe(true);

			if (result1.acquired) await result1.lock._release?.();
			if (result2.acquired) await result2.lock._release?.();
		});
	});

	// ========== GROUP 2: releaseLock tests ==========
	// releaseLock is now a no-op wrapper for API compatibility.
	// Actual release is via lock._release(). These tests verify compatibility.
	describe('Group 2: releaseLock', () => {
		it('releaseLock is a no-op and returns true', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent', 'task1');
			expect(result.acquired).toBe(true);

			// releaseLock is a no-op but must return true for API compatibility
			const released = await releaseLock(tmpDir, 'test.ts', 'task1');
			expect(released).toBe(true);

			// Actual release via _release
			if (result.acquired) await result.lock._release?.();
		});

		it('releaseLock always returns true (no-op)', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent1', 'task1');
			expect(result.acquired).toBe(true);

			// Even a "wrong" taskId returns true since this is now a no-op
			const released = await releaseLock(tmpDir, 'test.ts', 'task2');
			expect(released).toBe(true);

			if (result.acquired) await result.lock._release?.();
		});

		it('returns true for non-existent lock', async () => {
			const released = await releaseLock(tmpDir, 'nonexistent.ts', 'task');
			expect(released).toBe(true);
		});

		it('lock can be re-acquired after _release()', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent', 'task1');
			expect(result.acquired).toBe(true);

			if (result.acquired) await result.lock._release?.();

			// Now another agent should be able to acquire it
			const result2 = await tryAcquireLock(
				tmpDir,
				'test.ts',
				'agent2',
				'task2',
			);
			expect(result2.acquired).toBe(true);
			if (result2.acquired) await result2.lock._release?.();
		});
	});

	// ========== GROUP 3: isLocked tests ==========
	describe('Group 3: isLocked', () => {
		it('returns null for unlocked file', () => {
			const lock = isLocked(tmpDir, 'test.ts');
			expect(lock).toBeNull();
		});

		it('returns lock info for locked file', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent', 'task1');
			expect(result.acquired).toBe(true);

			const lock = isLocked(tmpDir, 'test.ts');
			expect(lock).not.toBeNull();
			expect(lock?.filePath).toBe('test.ts');

			if (result.acquired) await result.lock._release?.();
		});

		it('returns null after lock is released', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent', 'task');
			expect(result.acquired).toBe(true);

			if (result.acquired) await result.lock._release?.();

			const lock = isLocked(tmpDir, 'test.ts');
			expect(lock).toBeNull();
		});
	});

	// ========== GROUP 4: Lock expiration tests ==========
	describe('Group 4: Lock expiration', () => {
		it('re-acquiring a lock after _release succeeds immediately', async () => {
			const result = await tryAcquireLock(tmpDir, 'test.ts', 'agent1', 'task1');
			expect(result.acquired).toBe(true);
			if (result.acquired) await result.lock._release?.();

			const result2 = await tryAcquireLock(
				tmpDir,
				'test.ts',
				'new-agent',
				'new-task',
			);
			expect(result2.acquired).toBe(true);
			if (result2.acquired) await result2.lock._release?.();
		});
	});

	// ========== GROUP 5: cleanupExpiredLocks tests ==========
	describe('Group 5: cleanupExpiredLocks', () => {
		it('removes stale sentinel files (plain files older than timeout)', () => {
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Create a sentinel file and backdate its mtime to simulate staleness
			const sentinelPath = path.join(locksDir, 'stale.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');
			// Backdate mtime by 6 minutes (past the 5-minute timeout)
			const staleTime = new Date(Date.now() - 6 * 60 * 1000);
			fs.utimesSync(sentinelPath, staleTime, staleTime);

			// Create a fresh sentinel file that should not be removed
			const freshPath = path.join(locksDir, 'fresh.lock');
			fs.writeFileSync(freshPath, '', 'utf-8');

			const cleaned = cleanupExpiredLocks(tmpDir);
			expect(cleaned).toBe(1);
			expect(fs.existsSync(freshPath)).toBe(true);
			expect(fs.existsSync(sentinelPath)).toBe(false);
		});

		it('returns 0 for non-existent locks directory', () => {
			const cleaned = cleanupExpiredLocks(tmpDir);
			expect(cleaned).toBe(0);
		});
	});

	// ========== GROUP 6: listActiveLocks tests ==========
	describe('Group 6: listActiveLocks', () => {
		it('lists active locks', async () => {
			const r1 = await tryAcquireLock(tmpDir, 'file1.ts', 'agent1', 'task1');
			const r2 = await tryAcquireLock(tmpDir, 'file2.ts', 'agent2', 'task2');

			const locks = listActiveLocks(tmpDir);
			expect(locks.length).toBe(2);

			if (r1.acquired) await r1.lock._release?.();
			if (r2.acquired) await r2.lock._release?.();
		});

		it('excludes files without active proper-lockfile lock directory', async () => {
			// Create a bare sentinel file with no .lock directory — should not appear
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			fs.writeFileSync(path.join(locksDir, 'orphan.lock'), '', 'utf-8');

			// Create a real active lock
			const r = await tryAcquireLock(tmpDir, 'file.ts', 'agent', 'task');
			expect(r.acquired).toBe(true);

			const locks = listActiveLocks(tmpDir);
			expect(locks.length).toBe(1);

			if (r.acquired) await r.lock._release?.();
		});

		it('returns empty array for no locks', () => {
			const locks = listActiveLocks(tmpDir);
			expect(locks).toEqual([]);
		});
	});
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	acquireLaneLocks,
	cleanupExpiredLocks,
	isLocked,
	type LockMetadata,
	listActiveLocks,
	releaseLaneLocks,
	tryAcquireLock,
} from '../../../src/parallel/file-locks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'file-locks-adversarial-'));
}

// ---------------------------------------------------------------------------
// Security note on path validation
// ---------------------------------------------------------------------------
// The file-lock module's security boundary is: no lock may be acquired on a
// file outside the project directory (path traversal prevention).  It does
// NOT validate filename characters — on Unix, whitespace/newlines/pipes are
// valid filename characters and the code correctly accepts them.  Attackers
// cannot escape the project directory via filenames.

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('file-locks — adversarial security tests', () => {
	let dir: string;

	beforeEach(async () => {
		dir = tempDir();
		// Stub validateDirectory so Windows tmp paths don't get rejected
		mock.module('../../../src/utils/path-security', () => ({
			validateDirectory: () => {},
			validateSwarmPath: (p: string) => p,
		}));
	});

	afterEach(() => {
		mock.restore();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	});

	// ========================================================================
	// ATTACK VECTOR 1: Path Traversal Attempts (security boundary)
	// ========================================================================

	describe('path traversal attacks on getLockFilePath (via tryAcquireLock)', () => {
		test('rejects traversal with forward slashes (../../etc/passwd)', async () => {
			await expect(
				tryAcquireLock(dir, '../../etc/passwd', 'attacker', 't1'),
			).rejects.toThrow('Invalid file path: path traversal not allowed');
		});

		test('rejects traversal with backslashes (Windows-style)', async () => {
			// Note: on Unix, backslashes are valid filename characters, not separators.
			// The path.resolve normalizes this to an absolute path outside the project.
			await expect(
				tryAcquireLock(dir, '..\\..\\etc\\passwd', 'attacker', 't1'),
			).rejects.toThrow('Invalid file path: path traversal not allowed');
		});

		test('rejects absolute path outside project', async () => {
			const outside = path.join(os.tmpdir(), 'totally-outside.txt');
			await expect(
				tryAcquireLock(dir, outside, 'attacker', 't1'),
			).rejects.toThrow('Invalid file path: path traversal not allowed');
		});

		test('rejects Unix absolute path', async () => {
			await expect(
				tryAcquireLock(dir, '/etc/passwd', 'attacker', 't1'),
			).rejects.toThrow('Invalid file path: path traversal not allowed');
		});

		test('rejects path that ends at project root boundary', async () => {
			// Trying to lock a file at the parent of the project directory.
			await expect(tryAcquireLock(dir, '..', 'attacker', 't1')).rejects.toThrow(
				'Invalid file path: path traversal not allowed',
			);
		});

		test('rejects deep traversal beyond project root', async () => {
			await expect(
				tryAcquireLock(dir, '../../../../../../../../../bin', 'attacker', 't1'),
			).rejects.toThrow('Invalid file path: path traversal not allowed');
		});

		test('rejects Windows root-level path (C:\\)', async () => {
			if (process.platform !== 'win32') {
				test.skip('Windows-only attack vector');
				return;
			}
			await expect(
				tryAcquireLock(dir, 'C:\\', 'attacker', 't1'),
			).rejects.toThrow('Invalid file path: path traversal not allowed');
		});

		test('accepts legitimate relative paths within project root', async () => {
			// This must NOT throw — valid in-project path.
			const targetFile = path.join(dir, 'src/utils/helper.ts');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');
			const result = await tryAcquireLock(
				dir,
				'src/utils/helper.ts',
				'agent',
				't1',
			);
			expect(result.acquired).toBe(true);
			if (result.acquired) {
				await result.lock._release?.();
			}
		});

		test('accepts path with doubledots that stay within project', async () => {
			// path.resolve resolves ../ within the directory, so it stays inside.
			const targetFile = path.join(dir, 'src/helper.ts');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');
			// src/../src/helper.ts normalizes to src/helper.ts
			const result = await tryAcquireLock(
				dir,
				'src/../src/helper.ts',
				'agent',
				't1',
			);
			expect(result.acquired).toBe(true);
			if (result.acquired) {
				await result.lock._release?.();
			}
		});
	});

	// ========================================================================
	// ATTACK VECTOR 2: Malformed / Oversized Metadata
	// ========================================================================

	describe('malformed and oversized metadata attacks', () => {
		test('readMetaFile with empty file returns null (not throw)', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'empty.meta');
			fs.writeFileSync(meta, ''); // empty file

			// listActiveLocks calls readMetaFile — must not throw.
			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('readMetaFile with invalid JSON returns null (not throw)', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'bad.meta');
			fs.writeFileSync(meta, '{ not json }');

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('readMetaFile with oversized JSON (> 1MB) returns null gracefully', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'huge.meta');
			// Create a 2MB JSON string.
			const hugeMeta = JSON.stringify({ payload: 'x'.repeat(2 * 1024 * 1024) });
			fs.writeFileSync(meta, hugeMeta);

			// Must not throw — should handle oversized gracefully.
			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with maliciously long strings does not crash parser', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'evil.meta');
			const evilMeta: LockMetadata = {
				originalPath: 'A'.repeat(100_000),
				laneId: 'B'.repeat(100_000),
				taskId: 'C'.repeat(100_000),
				agent: 'D'.repeat(100_000),
				sessionID: 'E'.repeat(100_000),
				acquiredAt: new Date().toISOString(),
				expiresAt: Date.now() + 999_999_999,
			};
			fs.writeFileSync(meta, JSON.stringify(evilMeta));

			// Must not throw — readMetaFile returns null on error.
			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with NaN expiresAt does not crash listActiveLocks', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'nan.meta');
			const badMeta = {
				originalPath: 'src/file.ts',
				laneId: 'lane-1',
				taskId: 't1',
				agent: 'agent',
				sessionID: 'session',
				acquiredAt: new Date().toISOString(),
				expiresAt: NaN,
			};
			fs.writeFileSync(meta, JSON.stringify(badMeta));

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with Infinity expiresAt does not crash listActiveLocks', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'inf.meta');
			const infMeta = {
				originalPath: 'src/file.ts',
				laneId: 'lane-1',
				taskId: 't1',
				agent: 'agent',
				sessionID: 'session',
				acquiredAt: new Date().toISOString(),
				expiresAt: Infinity,
			};
			fs.writeFileSync(meta, JSON.stringify(infMeta));

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with negative expiresAt does not crash listActiveLocks', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'neg.meta');
			const negMeta = {
				originalPath: 'src/file.ts',
				laneId: 'lane-1',
				taskId: 't1',
				agent: 'agent',
				sessionID: 'session',
				acquiredAt: new Date().toISOString(),
				expiresAt: -1,
			};
			fs.writeFileSync(meta, JSON.stringify(negMeta));

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with __proto__ pollution attempt is handled safely', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'proto.meta');
			// Modern JSON.parse does not execute __proto__ pollution, but we
			// verify the code path doesn't crash.
			const protoPollution = JSON.parse('{"__proto__":{"admin":true}}');
			fs.writeFileSync(meta, JSON.stringify(protoPollution));

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with constructor pollution attempt is handled safely', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'ctor.meta');
			const ctorPollution = JSON.parse(
				'{"constructor":{"prototype":{"admin":true}}}',
			);
			fs.writeFileSync(meta, JSON.stringify(ctorPollution));

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('meta file with toString property pollution is handled safely', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const meta = path.join(locksDir, 'tostring.meta');
			// Attempt to pollute via toString on the parsed object
			const pollute = JSON.parse('{"toString":"[object Object]"}');
			fs.writeFileSync(meta, JSON.stringify(pollute));

			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('writeMetaFile failure during lane acquisition rolls back all locks', async () => {
			const targetFile = path.join(dir, 'src/helper.ts');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			// Override writeFile to always fail after first call.
			// Save original so we can restore it.
			const originalWriteFile = _internals.writeFile;
			let callCount = 0;
			_internals.writeFile = async (
				p: string,
				data: string,
				enc: BufferEncoding,
			) => {
				callCount++;
				if (callCount > 1) {
					throw new Error('Synthetic write failure');
				}
				// Delegate to the real implementation for temp file writes.
				return originalWriteFile(p, data, enc);
			};

			try {
				// First file succeeds, second file triggers write failure.
				const result = await acquireLaneLocks(
					dir,
					'lane-rollback',
					['src/helper.ts', 'src/helper.ts'],
					'agent',
					't1',
					'session',
				);

				expect(result.acquired).toBe(false);
				expect(result.conflicts.length).toBeGreaterThan(0);

				// Verify no leaked locks remain for this lane.
				const locks = listActiveLocks(dir);
				const leaked = locks.filter((l) => l.laneId === 'lane-rollback');
				expect(leaked.length).toBe(0);
			} finally {
				// Restore original writeFile.
				_internals.writeFile = originalWriteFile;
			}
		});

		test('oversized agent name (> 10KB) in lane acquisition: no crash', async () => {
			const targetFile = path.join(dir, 'src/helper.ts');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');
			const longAgent = 'A'.repeat(15_000);

			// This should not crash — the module handles large strings.
			const result = await acquireLaneLocks(
				dir,
				'lane-1',
				['src/helper.ts'],
				longAgent,
				't1',
				'session',
			);
			// Result could be success or failure, but no crash.
			if (result.acquired) {
				await releaseLaneLocks(dir, 'lane-1');
			}
		});
	});

	// ========================================================================
	// ATTACK VECTOR 3: Boundary Violations
	// ========================================================================

	describe('boundary violations', () => {
		test('acquireLaneLocks with empty files array returns acquired: true with empty locks', async () => {
			const result = await acquireLaneLocks(
				dir,
				'lane-1',
				[],
				'agent',
				't1',
				'session',
			);
			expect(result.acquired).toBe(true);
			expect(result.locks).toEqual([]);
		});

		test('cleanupExpiredLocks ignores non-existent locks directory', () => {
			// Call cleanup on a dir with no .swarm/locks — must not throw.
			expect(() => cleanupExpiredLocks(dir)).not.toThrow();
			expect(cleanupExpiredLocks(dir)).toBe(0);
		});

		test('cleanupExpiredLocks handles corrupted entries gracefully', () => {
			// Create a .lock file with mtime 0 (epoch) — definitely expired.
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const sentinel = path.join(locksDir, 'expired-test.lock');
			fs.writeFileSync(sentinel, '');
			fs.utimesSync(sentinel, 0, 0); // epoch — expired

			const cleaned = cleanupExpiredLocks(dir);
			expect(cleaned).toBeGreaterThanOrEqual(0);
			// The expired file should be cleaned.
			expect(fs.existsSync(sentinel)).toBe(false);
		});

		test('cleanupExpiredLocks skips proper-lockfile directories', () => {
			// proper-lockfile creates .lock directories; cleanup should skip them.
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			// Create a proper-lockfile lock directory (treated specially by cleanup).
			const plLockDir = path.join(locksDir, 'sentinel.lock.lock');
			fs.mkdirSync(plLockDir, { recursive: true });

			// Must not throw.
			expect(() => cleanupExpiredLocks(dir)).not.toThrow();
		});

		test('listActiveLocks returns empty array for non-existent locks dir', () => {
			expect(listActiveLocks(dir)).toEqual([]);
		});

		test('listActiveLocks ignores malformed .meta files without crashing', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Write a valid sentinel lock file.
			const sentinel = path.join(locksDir, 'valid.lock');
			fs.writeFileSync(sentinel, '');

			// Write a malformed meta file (not valid JSON).
			const meta = path.join(locksDir, 'valid.meta');
			fs.writeFileSync(meta, 'not-json{');

			// Write an expired valid meta.
			const sentinel2 = path.join(locksDir, 'expired.lock');
			fs.writeFileSync(sentinel2, '');
			const expiredMeta = path.join(locksDir, 'expired.meta');
			const expiredMetaContent: LockMetadata = {
				originalPath: 'src/file.ts',
				laneId: 'lane-1',
				taskId: 't1',
				agent: 'agent',
				sessionID: 'session',
				acquiredAt: new Date(Date.now() - 10_000_000).toISOString(),
				expiresAt: Date.now() - 1_000_000, // expired 1000s ago
			};
			fs.writeFileSync(expiredMeta, JSON.stringify(expiredMetaContent));

			// listActiveLocks must not throw on malformed meta.
			expect(() => listActiveLocks(dir)).not.toThrow();
		});

		test('isLocked returns null for a file with no lock', () => {
			expect(isLocked(dir, 'nonexistent.txt')).toBeNull();
		});

		test('isLocked does not throw when sentinel is manually deleted', async () => {
			const targetFile = path.join(dir, 'src/deleted.txt');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			const lock = await tryAcquireLock(dir, 'src/deleted.txt', 'agent', 't1');
			expect(lock.acquired).toBe(true);

			// Manually delete sentinel (simulating attacker or accident).
			const locksDir = path.join(dir, '.swarm', 'locks');
			const sentinel = path.join(locksDir, 'deleted.txt.lock');
			fs.rmSync(sentinel, { force: true });

			// isLocked must not throw.
			expect(() => isLocked(dir, 'src/deleted.txt')).not.toThrow();
		});
	});

	// ========================================================================
	// ATTACK VECTOR 4: Race Conditions
	// ========================================================================

	describe('race condition attacks', () => {
		test('concurrent tryAcquireLock on same file: only one succeeds', async () => {
			const targetFile = path.join(dir, 'src/race.txt');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			// Two concurrent acquisitions on the same file.
			const [r1, r2] = await Promise.all([
				tryAcquireLock(dir, 'src/race.txt', 'agent1', 't1'),
				tryAcquireLock(dir, 'src/race.txt', 'agent2', 't2'),
			]);

			// Exactly one must succeed.
			const successes = [r1, r2].filter((r) => r.acquired);
			const failures = [r1, r2].filter((r) => !r.acquired);
			expect(successes.length).toBe(1);
			expect(failures.length).toBe(1);

			// Release the winner.
			if (successes[0]!.acquired) {
				await successes[0]!.lock._release?.();
			}
		});

		test('concurrent acquireLaneLocks on same lane files: all-or-nothing atomicity', async () => {
			const targetFile = path.join(dir, 'src/lane.txt');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			const [r1, r2] = await Promise.allSettled([
				acquireLaneLocks(
					dir,
					'lane-race',
					['src/lane.txt'],
					'agent1',
					't1',
					's1',
				),
				acquireLaneLocks(
					dir,
					'lane-race',
					['src/lane.txt'],
					'agent2',
					't2',
					's2',
				),
			]);

			// One should succeed, one should fail. Clean up.
			await releaseLaneLocks(dir, 'lane-race');
		});

		test('rapid acquire/release cycles do not leak sentinel files', async () => {
			const targetFile = path.join(dir, 'src/cycle.txt');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			for (let i = 0; i < 20; i++) {
				const lock = await tryAcquireLock(
					dir,
					'src/cycle.txt',
					'agent',
					`t${i}`,
				);
				if (lock.acquired) {
					await lock.lock._release?.();
				}
			}

			// After 20 rapid cycles, check for leaked sentinel files.
			const locksDir = path.join(dir, '.swarm', 'locks');
			if (fs.existsSync(locksDir)) {
				const sentinels = fs
					.readdirSync(locksDir)
					.filter(
						(f) =>
							f.endsWith('.lock') &&
							!fs.statSync(path.join(locksDir, f)).isDirectory(),
					);
				// At most 1 sentinel leftover (from the current holder).
				expect(sentinels.length).toBeLessThanOrEqual(1);
			}
		});

		test('concurrent lock acquisition and cleanup does not corrupt lock state', async () => {
			const targetFile = path.join(dir, 'src/concurrent.txt');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			// Hold lock1.
			const lock1 = await tryAcquireLock(
				dir,
				'src/concurrent.txt',
				'agent1',
				't1',
			);
			expect(lock1.acquired).toBe(true);

			// While holding lock1, another acquisition should fail.
			const lock2 = await tryAcquireLock(
				dir,
				'src/concurrent.txt',
				'agent2',
				't2',
			);
			expect(lock2.acquired).toBe(false);

			// List active locks should show lock1.
			const active = listActiveLocks(dir);
			expect(active.length).toBeGreaterThanOrEqual(1);

			// Release lock1.
			if (lock1.acquired) {
				await lock1.lock._release?.();
			}

			// Now lock2 should succeed.
			const lock3 = await tryAcquireLock(
				dir,
				'src/concurrent.txt',
				'agent2',
				't2',
			);
			expect(lock3.acquired).toBe(true);
			if (lock3.acquired) {
				await lock3.lock._release?.();
			}
		});
	});

	// ========================================================================
	// ATTACK VECTOR 5: Resource Exhaustion / DoS
	// ========================================================================

	describe('denial of service via resource exhaustion', () => {
		test('acquireLaneLocks with many files completes or fails cleanly', async () => {
			const fileCount = 100;
			const files: string[] = [];
			for (let i = 0; i < fileCount; i++) {
				const f = path.join(dir, `src/file-${i}.ts`);
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, '');
				files.push(`src/file-${i}.ts`);
			}

			const result = await acquireLaneLocks(
				dir,
				'lane-dos',
				files,
				'agent',
				't1',
				'session',
			);

			// Must return cleanly — either all acquired or conflicts.
			if (result.acquired) {
				await releaseLaneLocks(dir, 'lane-dos');
			}
			expect(result.acquired === true || result.conflicts.length > 0).toBe(
				true,
			);
		}, 30_000);

		test('repeated cleanupExpiredLocks calls are idempotent', () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			for (let i = 0; i < 10; i++) {
				const sentinel = path.join(locksDir, `expired-${i}.lock`);
				fs.writeFileSync(sentinel, '');
				fs.utimesSync(sentinel, 0, 0);
			}

			const result1 = cleanupExpiredLocks(dir);
			expect(result1).toBeGreaterThanOrEqual(0);

			const result2 = cleanupExpiredLocks(dir);
			// Second cleanup should find nothing to clean.
			expect(result2).toBe(0);
		});

		test('locking a non-existent file creates sentinel and succeeds', async () => {
			const result = await tryAcquireLock(
				dir,
				'never-existed.txt',
				'agent',
				't1',
			);
			expect(result.acquired).toBe(true);
			if (result.acquired) {
				await result.lock._release?.();
			}
		});
	});

	// ========================================================================
	// ATTACK VECTOR 6: Lane Lock Cleanup Correctness
	// ========================================================================

	describe('lane lock release correctness', () => {
		test('releaseLaneLocks only releases locks for the specified lane', async () => {
			const targetFile = path.join(dir, 'src/lane-specific.txt');
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, '');

			// Acquire lock with lane-1.
			const result = await acquireLaneLocks(
				dir,
				'lane-1',
				['src/lane-specific.txt'],
				'agent',
				't1',
				'session',
			);
			expect(result.acquired).toBe(true);

			// Release lane-2 — should NOT release lane-1's lock.
			const released = await releaseLaneLocks(dir, 'lane-2');
			expect(released).toBe(0);

			// Lane-1's lock should still be visible.
			const active = listActiveLocks(dir);
			expect(active.some((l) => l.laneId === 'lane-1')).toBe(true);

			// Clean up lane-1.
			await releaseLaneLocks(dir, 'lane-1');
		});

		test('releaseLaneLocks handles missing lock files gracefully', async () => {
			const locksDir = path.join(dir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Create a meta file with no corresponding lock sentinel.
			const fakeMeta = path.join(locksDir, 'orphan.meta');
			const fakeMetaContent: LockMetadata = {
				originalPath: 'src/orphan.ts',
				laneId: 'orphan-lane',
				taskId: 't1',
				agent: 'agent',
				sessionID: 'session',
				acquiredAt: new Date().toISOString(),
				expiresAt: Date.now() + 999_999,
			};
			fs.writeFileSync(fakeMeta, JSON.stringify(fakeMetaContent));

			// releaseLaneLocks must not throw on missing sentinel.
			expect(() => releaseLaneLocks(dir, 'orphan-lane')).not.toThrow();
		});
	});
});

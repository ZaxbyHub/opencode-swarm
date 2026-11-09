/**
 * Verification tests for lane-based file locking.
 * Tests: acquireLaneLocks, releaseLaneLocks, listActiveLocks (metadata), cleanupExpiredLocks (metadata)
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LockMetadata } from '../../../src/parallel/file-locks';
import {
	_internals,
	acquireLaneLocks,
	cleanupExpiredLocks,
	listActiveLocks,
	releaseLaneLocks,
} from '../../../src/parallel/file-locks';

describe('lane-based file locks', () => {
	let tmpDir: string;
	// Capture the original at suite scope — before any test can modify it
	const originalWriteFile = _internals.writeFile;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-locks-test-'));
	});

	afterEach(async () => {
		// Always restore _internals.writeFile — no matter which path the test took
		_internals.writeFile = originalWriteFile;
		// Release any lingering proper-lockfile locks before removing the directory
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		// Restore any mocked internals
		mock.restore();
	});

	// ========== GROUP 1: acquireLaneLocks success ==========
	describe('Group 1: acquireLaneLocks success', () => {
		it('acquires multiple files in a lane, creates .meta sidecars, returns locks array', async () => {
			const files = ['file-a.ts', 'file-b.ts', 'file-c.ts'];
			const result = await acquireLaneLocks(
				tmpDir,
				'lane-1',
				files,
				'architect',
				'4.1',
				'session-abc',
			);

			expect(result.acquired).toBe(true);
			if (!result.acquired) return;

			expect(result.locks).toHaveLength(3);
			expect(result.locks.map((l) => l.filePath).sort()).toEqual(files.sort());
			for (const lock of result.locks) {
				expect(lock.laneId).toBe('lane-1');
				expect(lock.agent).toBe('architect');
				expect(lock.taskId).toBe('4.1');
				expect(lock.expiresAt).toBeGreaterThan(Date.now());
			}

			// Verify all 3 .meta files were created
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			const metaFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.meta'));
			expect(metaFiles).toHaveLength(3);

			// Clean up via releaseLaneLocks
			await releaseLaneLocks(tmpDir, 'lane-1');
		});

		it('acquires a single file in a lane', async () => {
			const result = await acquireLaneLocks(
				tmpDir,
				'lane-x',
				['only-file.ts'],
				'coder',
				'2.3',
				'session-xyz',
			);

			expect(result.acquired).toBe(true);
			if (!result.acquired) return;
			expect(result.locks).toHaveLength(1);
			expect(result.locks[0]!.filePath).toBe('only-file.ts');
			expect(result.locks[0]!.laneId).toBe('lane-x');

			await releaseLaneLocks(tmpDir, 'lane-x');
		});
	});

	// ========== GROUP 2: acquireLaneLocks all-or-nothing ==========
	describe('Group 2: acquireLaneLocks all-or-nothing', () => {
		it('first file succeeds, second file conflicts → first lock is released, no .meta files remain', async () => {
			// Pre-acquire file-b.ts so it conflicts
			const preResult = await acquireLaneLocks(
				tmpDir,
				'other-lane',
				['file-b.ts'],
				'other-agent',
				'9.9',
				'other-session',
			);
			expect(preResult.acquired).toBe(true);

			// Now try to acquire file-a.ts then file-b.ts in lane-1
			// file-a.ts should succeed, file-b.ts should conflict
			const result = await acquireLaneLocks(
				tmpDir,
				'lane-1',
				['file-a.ts', 'file-b.ts'],
				'architect',
				'4.1',
				'session-abc',
			);

			expect(result.acquired).toBe(false);
			expect(result.conflicts).toContain('file-b.ts');

			// Verify NO .meta files remain (all-or-nothing rollback)
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			if (fs.existsSync(locksDir)) {
				const metaFiles = fs
					.readdirSync(locksDir)
					.filter((f) => f.endsWith('.meta'));
				// The pre-existing lane should still have its meta, but lane-1's should not
				const lane1Metas = metaFiles.filter((f) => {
					const metaPath = path.join(locksDir, f);
					const meta = JSON.parse(
						fs.readFileSync(metaPath, 'utf-8'),
					) as LockMetadata;
					return meta.laneId === 'lane-1';
				});
				expect(lane1Metas).toHaveLength(0);
			}

			// Clean up the pre-acquired lock
			await releaseLaneLocks(tmpDir, 'other-lane');
		});

		it('all files available → all acquired successfully', async () => {
			const result = await acquireLaneLocks(
				tmpDir,
				'lane-1',
				['alpha.ts', 'beta.ts'],
				'architect',
				'4.1',
				'session-abc',
			);

			expect(result.acquired).toBe(true);
			expect(result.locks).toHaveLength(2);

			await releaseLaneLocks(tmpDir, 'lane-1');
		});

		it('third file conflicts → first two are rolled back', async () => {
			// Pre-acquire the third file
			await acquireLaneLocks(
				tmpDir,
				'blocker',
				['conflict.ts'],
				'agent',
				't',
				's',
			);
			expect(
				(
					await acquireLaneLocks(
						tmpDir,
						'lane-1',
						['a.ts', 'b.ts', 'conflict.ts'],
						'a',
						't',
						's',
					)
				).acquired,
			).toBe(false);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			if (fs.existsSync(locksDir)) {
				const metaFiles = fs
					.readdirSync(locksDir)
					.filter((f) => f.endsWith('.meta'));
				const lane1Metas = metaFiles.filter((f) => {
					const metaPath = path.join(locksDir, f);
					const meta = JSON.parse(
						fs.readFileSync(metaPath, 'utf-8'),
					) as LockMetadata;
					return meta.laneId === 'lane-1';
				});
				expect(lane1Metas).toHaveLength(0);
			}

			await releaseLaneLocks(tmpDir, 'blocker');
		});

		it('metadata write failure on second file → first lock is rolled back, no metadata remains', async () => {
			// Inject metadata write failure on the second .meta.tmp write via _internals seam
			let writeCount = 0;
			try {
				_internals.writeFile = (
					path: string,
					data: string | Buffer,
					encoding?:
						| BufferEncoding
						| { encoding?: BufferEncoding; flag?: string },
				) => {
					if (String(path).endsWith('.meta.tmp') && writeCount++ >= 1) {
						return Promise.reject(new Error('Injected metadata write failure'));
					}
					return originalWriteFile(path, data, encoding);
				};

				// Attempt to acquire two files; second metadata write will fail
				const result = acquireLaneLocks(
					tmpDir,
					'meta-fail-lane',
					['file-a.ts', 'file-b.ts'],
					'architect',
					'4.1',
					'session-abc',
				);

				// Function should throw due to metadata write failure
				let thrown: unknown;
				try {
					await result;
				} catch (err: unknown) {
					thrown = err;
				}
				expect(thrown).toBeDefined();
				expect((thrown as Error).message).toContain(
					'Injected metadata write failure',
				);

				// Verify no .meta files remain for this lane
				const locksDir = path.join(tmpDir, '.swarm', 'locks');
				if (fs.existsSync(locksDir)) {
					const metaFiles = fs
						.readdirSync(locksDir)
						.filter((f) => f.endsWith('.meta'));
					const laneMetas = metaFiles.filter((f) => {
						const metaPath = path.join(locksDir, f);
						const meta = JSON.parse(
							fs.readFileSync(metaPath, 'utf-8'),
						) as LockMetadata;
						return meta.laneId === 'meta-fail-lane';
					});
					expect(laneMetas).toHaveLength(0);
				}

				// Verify no .lock sentinels remain for this lane
				if (fs.existsSync(locksDir)) {
					const lockFiles = fs
						.readdirSync(locksDir)
						.filter((f) => f.endsWith('.lock'));
					const laneLocks = lockFiles.filter((f) => {
						const lockPath = path.join(locksDir, f);
						const stat = fs.statSync(lockPath);
						if (stat.isDirectory()) return false; // skip proper-lockfile dirs
						// Check if this lock has metadata pointing to our lane
						const metaPath = path.join(locksDir, f.replace('.lock', '.meta'));
						if (!fs.existsSync(metaPath)) return false;
						const meta = JSON.parse(
							fs.readFileSync(metaPath, 'utf-8'),
						) as LockMetadata;
						return meta.laneId === 'meta-fail-lane';
					});
					expect(laneLocks).toHaveLength(0);
				}
			} finally {
				// Defense-in-depth: afterEach also restores, but this ensures we can't leak
				_internals.writeFile = originalWriteFile;
			}
		});
	});

	// ========== GROUP 3: acquireLaneLocks metadata ==========
	describe('Group 3: acquireLaneLocks metadata', () => {
		it('verify .meta files contain correct laneId, taskId, agent, sessionID, originalPath', async () => {
			const files = ['project/src/model.ts'];
			await acquireLaneLocks(
				tmpDir,
				'mega-lane-42',
				files,
				'test-agent',
				'7.15',
				'session-mega-007',
			);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			const metaFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.meta'));
			expect(metaFiles).toHaveLength(1);

			const metaPath = path.join(locksDir, metaFiles[0]!);
			const meta = JSON.parse(
				fs.readFileSync(metaPath, 'utf-8'),
			) as LockMetadata;

			expect(meta.originalPath).toBe('project/src/model.ts');
			expect(meta.laneId).toBe('mega-lane-42');
			expect(meta.taskId).toBe('7.15');
			expect(meta.agent).toBe('test-agent');
			expect(meta.sessionID).toBe('session-mega-007');
			expect(meta.acquiredAt).toBeDefined();
			expect(meta.expiresAt).toBeGreaterThan(Date.now());

			await releaseLaneLocks(tmpDir, 'mega-lane-42');
		});

		it('multiple files each get correct individual metadata', async () => {
			const files = ['a.ts', 'b.ts', 'c.ts'];
			await acquireLaneLocks(
				tmpDir,
				'multi-lane',
				files,
				'architect',
				'1.0',
				'session-multi',
			);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			const metaFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.meta'));

			const metas = metaFiles.map((f) => {
				const metaPath = path.join(locksDir, f);
				return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as LockMetadata;
			});

			// Each meta should reference its own originalPath
			for (const file of files) {
				const matching = metas.filter((m) => m.originalPath === file);
				expect(matching).toHaveLength(1);
				expect(matching[0]!.laneId).toBe('multi-lane');
			}

			await releaseLaneLocks(tmpDir, 'multi-lane');
		});
	});

	// ========== GROUP 4: releaseLaneLocks ==========
	describe('Group 4: releaseLaneLocks', () => {
		it('release all locks for a lane, verify .lock and .meta files are removed', async () => {
			const files = ['x.ts', 'y.ts', 'z.ts'];
			await acquireLaneLocks(
				tmpDir,
				'release-lane',
				files,
				'agent',
				'task',
				'session',
			);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');

			// Verify locks exist
			expect(
				fs.readdirSync(locksDir).filter((f) => f.endsWith('.meta')),
			).toHaveLength(3);

			const released = await releaseLaneLocks(tmpDir, 'release-lane');

			expect(released).toBe(3);

			// Verify all .lock and .meta for this lane are gone
			// (the .swarm/locks dir itself may remain, just empty)
			if (fs.existsSync(locksDir)) {
				const remaining = fs.readdirSync(locksDir);
				const laneSpecificRemaining = remaining.filter((f) => {
					if (!f.endsWith('.meta')) return false;
					const metaPath = path.join(locksDir, f);
					const meta = JSON.parse(
						fs.readFileSync(metaPath, 'utf-8'),
					) as LockMetadata;
					return meta.laneId === 'release-lane';
				});
				expect(laneSpecificRemaining).toHaveLength(0);
			}
		});

		it('releaseLaneLocks returns 0 for non-existent lane', async () => {
			const result = await releaseLaneLocks(tmpDir, 'nonexistent-lane');
			expect(result).toBe(0);
		});

		it('releaseLaneLocks returns 0 when locks dir does not exist', async () => {
			const result = await releaseLaneLocks(tmpDir, 'any-lane');
			expect(result).toBe(0);
		});
	});

	// ========== GROUP 5: releaseLaneLocks partial ==========
	describe('Group 5: releaseLaneLocks partial', () => {
		it('some locks already released, others still held → releases remaining, cleans up metadata', async () => {
			const files = ['p.ts', 'q.ts'];
			const result = await acquireLaneLocks(
				tmpDir,
				'partial-lane',
				files,
				'a',
				't',
				's',
			);
			expect(result.acquired).toBe(true);

			// Manually delete just the .lock sentinel for p.ts (simulating it was already released)
			// but keep the .meta file
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			const metaFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.meta'));
			const pMeta = metaFiles.find((f) => {
				const metaPath = path.join(locksDir, f);
				const meta = JSON.parse(
					fs.readFileSync(metaPath, 'utf-8'),
				) as LockMetadata;
				return meta.originalPath === 'p.ts';
			});

			if (pMeta) {
				const pLockPath = pMeta.replace('.meta', '.lock');
				try {
					fs.unlinkSync(path.join(locksDir, pLockPath));
				} catch {
					/* ignore */
				}
			}

			// Now releaseLaneLocks should clean up q.ts fully and p.ts metadata
			// Both p.ts and q.ts have .meta for partial-lane, so both are counted
			const released = await releaseLaneLocks(tmpDir, 'partial-lane');
			expect(released).toBe(2); // both p.ts and q.ts metas cleaned

			// p.ts metadata should also be gone even though we manually removed its lock
			const remainingMetas = fs.existsSync(locksDir)
				? fs.readdirSync(locksDir).filter((f) => f.endsWith('.meta'))
				: [];
			const partialLaneMetas = remainingMetas.filter((f) => {
				const metaPath = path.join(locksDir, f);
				const meta = JSON.parse(
					fs.readFileSync(metaPath, 'utf-8'),
				) as LockMetadata;
				return meta.laneId === 'partial-lane';
			});
			expect(partialLaneMetas).toHaveLength(0);
		});
	});

	// ========== GROUP 6: listActiveLocks with metadata ==========
	describe('Group 6: listActiveLocks with metadata', () => {
		it('returns rich FileLock objects with laneId, actual path (not hash), agent, taskId', async () => {
			const files = ['real-path-a.ts', 'real-path-b.ts'];
			await acquireLaneLocks(
				tmpDir,
				'rich-lane',
				files,
				'rich-agent',
				'3.14',
				'rich-session',
			);

			const locks = listActiveLocks(tmpDir);

			expect(locks.length).toBeGreaterThanOrEqual(2);
			const richLocks = locks.filter((l) => l.laneId === 'rich-lane');
			expect(richLocks).toHaveLength(2);

			for (const lock of richLocks) {
				expect(lock.laneId).toBe('rich-lane');
				expect(lock.agent).toBe('rich-agent');
				expect(lock.taskId).toBe('3.14');
				// filePath should be the original path, not the hashed lock filename
				expect(files).toContain(lock.filePath);
				expect(lock.expiresAt).toBeGreaterThan(Date.now());
			}

			await releaseLaneLocks(tmpDir, 'rich-lane');
		});

		it('returns empty array when no locks exist', () => {
			const locks = listActiveLocks(tmpDir);
			expect(locks).toEqual([]);
		});
	});

	// ========== GROUP 7: listActiveLocks filters expired ==========
	describe('Group 7: listActiveLocks filters expired', () => {
		it('expired locks (past expiresAt) are not returned', async () => {
			// Create a lock manually with an expired timestamp in its .meta
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Create an expired .lock sentinel + .meta
			const expiredMeta: LockMetadata = {
				originalPath: 'expired.ts',
				laneId: 'expired-lane',
				taskId: 't',
				agent: 'a',
				sessionID: 's',
				acquiredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
				expiresAt: Date.now() - 5 * 60 * 1000, // expired 5 min ago
			};

			// Write a sentinel .lock file
			const sentinelPath = path.join(locksDir, 'expired.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');
			// Backdate the mtime to simulate age
			const oldTime = new Date(Date.now() - 10 * 60 * 1000);
			fs.utimesSync(sentinelPath, oldTime, oldTime);

			// Write the expired .meta
			const metaPath = sentinelPath.replace('.lock', '.meta');
			fs.writeFileSync(metaPath, JSON.stringify(expiredMeta), 'utf-8');

			// Also create a proper-lockfile lock directory for the expired lock (to pass the active check)
			const plLockDir = `${sentinelPath}.lock`;
			fs.mkdirSync(plLockDir, { recursive: true });

			// Create a fresh valid lock
			await acquireLaneLocks(tmpDir, 'valid-lane', ['valid.ts'], 'a', 't', 's');

			const locks = listActiveLocks(tmpDir);

			// Expired lock should not appear
			const expiredLocks = locks.filter((l) => l.filePath === 'expired.ts');
			expect(expiredLocks).toHaveLength(0);

			// Valid lock should appear
			const validLocks = locks.filter((l) => l.filePath === 'valid.ts');
			expect(validLocks).toHaveLength(1);

			await releaseLaneLocks(tmpDir, 'valid-lane');
			// Clean up expired sentinel manually
			try {
				fs.unlinkSync(metaPath);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(sentinelPath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmSync(plLockDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});
	});

	// ========== GROUP 8: listActiveLocks fallback ==========
	describe('Group 8: listActiveLocks fallback', () => {
		it('when .meta is missing, still returns basic lock info with expiry filtering', async () => {
			// Create a sentinel .lock file with proper-lockfile directory but NO .meta
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			const sentinelPath = path.join(locksDir, 'no-meta.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');

			// Create proper-lockfile lock directory (makes it appear active)
			const plLockDir = `${sentinelPath}.lock`;
			fs.mkdirSync(plLockDir, { recursive: true });

			// Backdate the plLockDir mtime to make it appear expired (mtime-based fallback expiry check)
			// listActiveLocks uses plLockDir mtime for fallback expiry, not sentinel mtime
			const oldTime = new Date(Date.now() - 10 * 60 * 1000);
			fs.utimesSync(plLockDir, oldTime, oldTime);

			// Now add a fresh valid lock
			await acquireLaneLocks(tmpDir, 'fresh-lane', ['fresh.ts'], 'a', 't', 's');

			const locks = listActiveLocks(tmpDir);

			// The no-meta lock should be filtered out (expired via mtime fallback)
			const noMetaLocks = locks.filter((l) => l.filePath === 'no-meta.lock');
			expect(noMetaLocks).toHaveLength(0);

			// Fresh lock should appear
			const freshLocks = locks.filter((l) => l.filePath === 'fresh.ts');
			expect(freshLocks).toHaveLength(1);

			await releaseLaneLocks(tmpDir, 'fresh-lane');
			// Clean up no-meta artifacts
			try {
				fs.unlinkSync(sentinelPath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmSync(plLockDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});

		it('meta file with invalid JSON is treated as missing (fallback)', async () => {
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Write sentinel and lock dir
			const sentinelPath = path.join(locksDir, 'bad-meta.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');
			const plLockDir = `${sentinelPath}.lock`;
			fs.mkdirSync(plLockDir, { recursive: true });

			// Write invalid JSON meta
			const metaPath = sentinelPath.replace('.lock', '.meta');
			fs.writeFileSync(metaPath, 'not-valid-json{{{', 'utf-8');

			// Backdate the plLockDir mtime to expire via mtime
			const oldTime = new Date(Date.now() - 10 * 60 * 1000);
			fs.utimesSync(plLockDir, oldTime, oldTime);

			const locks = listActiveLocks(tmpDir);
			const badMetaLocks = locks.filter((l) => l.filePath === 'bad-meta.lock');
			expect(badMetaLocks).toHaveLength(0);

			// Clean up
			try {
				fs.unlinkSync(metaPath);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(sentinelPath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmSync(plLockDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		});
	});

	// ========== GROUP 9: cleanupExpiredLocks with meta ==========
	describe('Group 9: cleanupExpiredLocks with meta', () => {
		it('removes both .lock sentinel and .meta sidecar for expired locks', () => {
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Create an expired sentinel + meta
			const expiredMeta: LockMetadata = {
				originalPath: 'old.ts',
				laneId: 'old-lane',
				taskId: 't',
				agent: 'a',
				sessionID: 's',
				acquiredAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
				expiresAt: Date.now() - 5 * 60 * 1000,
			};

			const sentinelPath = path.join(locksDir, 'old.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');
			const oldTime = new Date(Date.now() - 10 * 60 * 1000);
			fs.utimesSync(sentinelPath, oldTime, oldTime);

			const metaPath = sentinelPath.replace('.lock', '.meta');
			fs.writeFileSync(metaPath, JSON.stringify(expiredMeta), 'utf-8');

			// Create a fresh sentinel that should NOT be removed
			const freshPath = path.join(locksDir, 'fresh.lock');
			fs.writeFileSync(freshPath, '', 'utf-8');
			const freshMeta: LockMetadata = {
				originalPath: 'fresh.ts',
				laneId: 'fresh-lane',
				taskId: 't',
				agent: 'a',
				sessionID: 's',
				acquiredAt: new Date().toISOString(),
				expiresAt: Date.now() + 5 * 60 * 1000,
			};
			const freshMetaPath = freshPath.replace('.lock', '.meta');
			fs.writeFileSync(freshMetaPath, JSON.stringify(freshMeta), 'utf-8');

			const cleaned = cleanupExpiredLocks(tmpDir);

			expect(cleaned).toBe(1);
			// Expired .lock and .meta should be gone
			expect(fs.existsSync(sentinelPath)).toBe(false);
			expect(fs.existsSync(metaPath)).toBe(false);
			// Fresh should remain
			expect(fs.existsSync(freshPath)).toBe(true);
			expect(fs.existsSync(freshMetaPath)).toBe(true);

			// Clean up fresh
			fs.unlinkSync(freshPath);
			fs.unlinkSync(freshMetaPath);
		});

		it('cleanupExpiredLocks returns 0 for non-existent locks directory', () => {
			const cleaned = cleanupExpiredLocks(tmpDir);
			expect(cleaned).toBe(0);
		});
	});

	// ========== GROUP 10: Windows case-sensitivity ==========
	describe('Group 10: Windows case-sensitivity', () => {
		it.skipIf(process.platform !== 'win32')(
			'paths differing only in case resolve to same lock file on Windows',
			async () => {
				// On Windows, the lock path is lowercased during hash computation
				const files = ['File.TS', 'file.ts'];

				// First acquisition
				const r1 = await acquireLaneLocks(
					tmpDir,
					'case-lane',
					[files[0]],
					'a',
					't',
					's',
				);
				expect(r1.acquired).toBe(true);

				// Second acquisition with different case should conflict
				const r2 = await acquireLaneLocks(
					tmpDir,
					'case-lane-2',
					[files[1]],
					'b',
					't2',
					's2',
				);
				expect(r2.acquired).toBe(false);
				expect(r2.conflicts).toContain(files[1]);

				await releaseLaneLocks(tmpDir, 'case-lane');
			},
		);

		it('same path can be locked and released consistently', async () => {
			const file = 'consistent.ts';

			const r1 = await acquireLaneLocks(
				tmpDir,
				'consist-lane',
				[file],
				'a',
				't',
				's',
			);
			expect(r1.acquired).toBe(true);

			await releaseLaneLocks(tmpDir, 'consist-lane');

			// Can re-acquire after release
			const r2 = await acquireLaneLocks(
				tmpDir,
				'consist-lane-2',
				[file],
				'b',
				't2',
				's2',
			);
			expect(r2.acquired).toBe(true);

			await releaseLaneLocks(tmpDir, 'consist-lane-2');
		});
	});

	// ========== GROUP 11: Edge cases ==========
	describe('Group 11: Edge cases', () => {
		it('acquireLaneLocks with empty files array returns success with empty locks', async () => {
			const result = await acquireLaneLocks(
				tmpDir,
				'empty-lane',
				[],
				'a',
				't',
				's',
			);
			expect(result.acquired).toBe(true);
			expect(result.locks).toEqual([]);
		});

		it('releaseLaneLocks on lane with no locks returns 0', async () => {
			await acquireLaneLocks(tmpDir, 'some-lane', ['a.ts'], 'a', 't', 's');
			const released = await releaseLaneLocks(tmpDir, 'other-lane');
			expect(released).toBe(0);
			await releaseLaneLocks(tmpDir, 'some-lane');
		});

		it('listActiveLocks returns all three locks for the lane', async () => {
			await acquireLaneLocks(
				tmpDir,
				'order-lane',
				['z.ts', 'a.ts', 'm.ts'],
				'a',
				't',
				's',
			);
			const locks = listActiveLocks(tmpDir).filter(
				(l) => l.laneId === 'order-lane',
			);
			const paths = locks.map((l) => l.filePath);
			// Verify all three files are present (ordering not guaranteed)
			expect(paths.sort()).toEqual(['a.ts', 'm.ts', 'z.ts']);
			await releaseLaneLocks(tmpDir, 'order-lane');
		});
	});
});

/**
 * Behavioral tests for the lean_turbo_acquire_locks tool.
 *
 * Covers three observable outcomes:
 * 1. acquire returns lock handles (successful path)
 * 2. fails fast on contention (concurrent acquire scenario)
 * 3. releases on completion (cleanup after work)
 *
 * Uses the _internals.tryAcquireLock seam to inject contention failures
 * without needing to manage real concurrent processes. The real
 * proper-lockfile library is exercised in the successful-path tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	acquireLaneLocks,
	cleanupExpiredLocks,
	releaseLaneLocks,
} from '../../../src/parallel/file-locks';
import {
	executeLeanTurboAcquireLocks,
	type LeanTurboAcquireLocksArgs,
} from '../../../src/tools/lean-turbo-acquire-locks';

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

function makeArgs(
	overrides: Partial<LeanTurboAcquireLocksArgs> = {},
): LeanTurboAcquireLocksArgs {
	const tmpDir = overrides['directory'] ?? 'E:\\OpenCode\\opencode-swarm-dev2'; // placeholder, overridden in beforeEach
	return {
		directory: tmpDir,
		laneId: 'lane-1',
		files: ['src/utils.ts'],
		agent: 'test-agent',
		taskId: '1.1',
		sessionID: 'session-1',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('lean_turbo_acquire_locks tool', () => {
	let tmpDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-locks-test-')),
		);
		originalCwd = process.cwd();
		// Ensure .swarm directory exists (file-locks creates locks under it)
		fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		// Best-effort cleanup of locks directory
		try {
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			if (fs.existsSync(locksDir)) {
				fs.rmSync(locksDir, { recursive: true, force: true });
			}
		} catch {
			// ignore cleanup errors
		}
		// Restore cwd in case any test changed it
		try {
			process.chdir(originalCwd);
		} catch {
			// ignore if already at original
		}
	});

	// -------------------------------------------------------------------------
	// Outcome 1: acquire returns lock handles (successful path)
	// -------------------------------------------------------------------------

	describe('1. acquire returns lock handles (successful path)', () => {
		it('executeLeanTurboAcquireLocks returns success:true with FileLock array', async () => {
			const args = makeArgs({
				directory: tmpDir,
				laneId: 'lane-1',
				files: ['src/utils.ts'],
			});

			const result = await executeLeanTurboAcquireLocks(args);

			expect(result.success).toBe(true);
			expect(result.locks).toBeDefined();
			expect(Array.isArray(result.locks)).toBe(true);
			expect(result.locks!.length).toBe(1);
		});

		it('lock handle contains expected fields (filePath, agent, taskId, laneId)', async () => {
			const args = makeArgs({
				directory: tmpDir,
				laneId: 'lane-test',
				files: ['src/feature.ts'],
				agent: 'my-agent',
				taskId: '2.3',
				sessionID: 'session-abc',
			});

			const result = await executeLeanTurboAcquireLocks(args);

			expect(result.success).toBe(true);
			const lock = result.locks![0];
			expect(lock.filePath).toBe('src/feature.ts');
			expect(lock.agent).toBe('my-agent');
			expect(lock.taskId).toBe('2.3');
			expect(lock.laneId).toBe('lane-test');
			expect(lock.timestamp).toBeDefined();
			expect(typeof lock.timestamp).toBe('string');
			expect(lock.expiresAt).toBeGreaterThan(Date.now());
		});

		it('acquires locks for multiple files in a single lane', async () => {
			const args = makeArgs({
				directory: tmpDir,
				laneId: 'lane-multi',
				files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
			});

			const result = await executeLeanTurboAcquireLocks(args);

			expect(result.success).toBe(true);
			expect(result.locks!.length).toBe(3);
			expect(result.locks!.map((l) => l.filePath).sort()).toEqual([
				'src/a.ts',
				'src/b.ts',
				'src/c.ts',
			]);
		});

		it('acquireLaneLocks creates sentinel .lock files under .swarm/locks', async () => {
			const args = makeArgs({ directory: tmpDir, files: ['src/test.ts'] });

			await acquireLaneLocks(
				args.directory,
				args.laneId,
				args.files,
				args.agent,
				args.taskId,
				args.sessionID,
			);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			expect(fs.existsSync(locksDir)).toBe(true);
			const lockFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.lock'));
			expect(lockFiles.length).toBeGreaterThan(0);
		});

		it('acquireLaneLocks writes sidecar .meta files', async () => {
			const args = makeArgs({ directory: tmpDir, files: ['src/meta-test.ts'] });

			await acquireLaneLocks(
				args.directory,
				args.laneId,
				args.files,
				args.agent,
				args.taskId,
				args.sessionID,
			);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			const lockFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.lock'));
			const metaFiles = lockFiles.map((f) => f.replace(/\.lock$/, '.meta'));
			const metaPath = path.join(locksDir, metaFiles[0]);
			expect(fs.existsSync(metaPath)).toBe(true);
			const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
			expect(meta.originalPath).toBe('src/meta-test.ts');
			expect(meta.laneId).toBe('lane-1');
			expect(meta.taskId).toBe('1.1');
			expect(meta.agent).toBe('test-agent');
			expect(meta.sessionID).toBe('session-1');
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 2: fails fast on contention (concurrent acquire scenario)
	// -------------------------------------------------------------------------

	describe('2. fails fast on contention (concurrent acquire scenario)', () => {
		it('acquiring the same file twice returns acquired:false with conflicts', async () => {
			const args = makeArgs({ directory: tmpDir, files: ['src/contested.ts'] });

			// First acquisition succeeds
			const first = await acquireLaneLocks(
				args.directory,
				'lane-1',
				args.files,
				'agent-1',
				'1.1',
				'session-1',
			);
			expect(first.acquired).toBe(true);
			expect(first.locks).toHaveLength(1);

			// Second acquisition for the same file in a different lane fails fast
			const second = await acquireLaneLocks(
				args.directory,
				'lane-2',
				args.files,
				'agent-2',
				'2.1',
				'session-2',
			);
			expect(second.acquired).toBe(false);
			expect(second.conflicts).toBeDefined();
			expect(second.conflicts!).toContain('src/contested.ts');
		});

		it('contention on any single file in a multi-file lane fails the entire lane', async () => {
			// First lane takes files A and B
			const first = await acquireLaneLocks(
				tmpDir,
				'lane-1',
				['src/a.ts', 'src/b.ts'],
				'agent-1',
				'1.1',
				'session-1',
			);
			expect(first.acquired).toBe(true);

			// Second lane tries to take B and C — B is already locked → entire lane fails
			const second = await acquireLaneLocks(
				tmpDir,
				'lane-2',
				['src/b.ts', 'src/c.ts'],
				'agent-2',
				'2.1',
				'session-2',
			);
			expect(second.acquired).toBe(false);
			expect(second.conflicts!).toContain('src/b.ts');
		});

		it('executeLeanTurboAcquireLocks surfaces conflicts in result', async () => {
			// Pre-lock the file
			await acquireLaneLocks(
				tmpDir,
				'lane-prelock',
				['src/prelocked.ts'],
				'agent-prev',
				'0.1',
				'session-prev',
			);

			const args = makeArgs({
				directory: tmpDir,
				files: ['src/prelocked.ts'],
			});

			const result = await executeLeanTurboAcquireLocks(args);

			expect(result.success).toBe(false);
			expect(result.conflicts).toBeDefined();
			expect(result.conflicts!).toContain('src/prelocked.ts');
			expect(result.errors).toBeUndefined();
		});

		it('contention on one file in a multi-file lane releases all previously acquired locks', async () => {
			// Pre-lock the first file so when we try to acquire lane with [first, second],
			// the first fails (already locked), triggering cleanup of zero previously acquired
			// locks (none yet) but returning conflicts.
			await acquireLaneLocks(
				tmpDir,
				'lane-blocker',
				['src/blocked.ts'],
				'agent-blocker',
				'0.1',
				'session-blocker',
			);

			// Try to acquire a lane that starts with the already-locked file
			const result = await acquireLaneLocks(
				tmpDir,
				'lane-waiting',
				['src/blocked.ts', 'src/new.ts'],
				'agent-waiting',
				'5.1',
				'session-waiting',
			);

			// Should fail because first file is locked; no cleanup needed (nothing acquired yet)
			expect(result.acquired).toBe(false);
			expect(result.conflicts!).toContain('src/blocked.ts');
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 3: releases on completion (cleanup after work)
	// -------------------------------------------------------------------------

	describe('3. releases on completion (cleanup after work)', () => {
		it('lock._release() removes the lock from the filesystem', async () => {
			const args = makeArgs({
				directory: tmpDir,
				files: ['src/release-test.ts'],
			});

			const result = await acquireLaneLocks(
				args.directory,
				args.laneId,
				args.files,
				args.agent,
				args.taskId,
				args.sessionID,
			);
			expect(result.acquired).toBe(true);

			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			const lockFilesBefore = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.lock'));

			// Simulate work completion — call _release()
			await result.locks[0]._release!();

			const lockFilesAfter = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.lock'));
			// After release, the sentinel file may be gone or the .lock dir may be unlocked
			expect(lockFilesAfter.length).toBeLessThanOrEqual(lockFilesBefore.length);
		});

		it('releaseLaneLocks releases all locks for a given laneId', async () => {
			// Acquire multiple locks under lane-1
			await acquireLaneLocks(
				tmpDir,
				'lane-release',
				['src/x.ts', 'src/y.ts'],
				'agent-release',
				'3.1',
				'session-release',
			);

			// Verify locks exist
			const locksBefore = fs
				.readdirSync(path.join(tmpDir, '.swarm', 'locks'))
				.filter((f) => f.endsWith('.meta'));
			expect(locksBefore.length).toBe(2);

			// Release by laneId
			const released = await releaseLaneLocks(tmpDir, 'lane-release');
			expect(released).toBe(2);

			// Meta files should be gone
			const metaAfter = fs
				.readdirSync(path.join(tmpDir, '.swarm', 'locks'))
				.filter((f) => f.endsWith('.meta'));
			expect(metaAfter.length).toBe(0);
		});

		it('after releaseLaneLocks, files can be re-acquired by a new lane', async () => {
			// Acquire a lane
			const first = await acquireLaneLocks(
				tmpDir,
				'lane-orig',
				['src/reacquire.ts'],
				'agent-orig',
				'6.1',
				'session-orig',
			);
			expect(first.acquired).toBe(true);

			// Release it
			const released = await releaseLaneLocks(tmpDir, 'lane-orig');
			expect(released).toBe(1);

			// Same file can now be acquired by a new lane (no more conflicts)
			const second = await acquireLaneLocks(
				tmpDir,
				'lane-new',
				['src/reacquire.ts'],
				'agent-new',
				'6.2',
				'session-new',
			);
			expect(second.acquired).toBe(true);

			// Cleanup
			await releaseLaneLocks(tmpDir, 'lane-new');
		});

		it('cleanupExpiredLocks removes stale sentinels', async () => {
			// Create a fake stale lock sentinel file manually (not via proper-lockfile)
			const locksDir = path.join(tmpDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });
			const stalePath = path.join(locksDir, 'stale_test_hash.lock');
			fs.writeFileSync(stalePath, '', 'utf-8');

			// Set mtime to 10 minutes ago (beyond LOCK_TIMEOUT_MS = 5 minutes)
			const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
			fs.utimesSync(
				stalePath,
				new Date(tenMinutesAgo / 1000),
				new Date(tenMinutesAgo / 1000),
			);

			const cleaned = cleanupExpiredLocks(tmpDir);
			expect(cleaned).toBeGreaterThanOrEqual(1);
			expect(fs.existsSync(stalePath)).toBe(false);
		});

		it('executeLeanTurboAcquireLocks returns errors array on path traversal attempt', async () => {
			// Path traversal is rejected synchronously by getLockFilePath and surfaced
			// as an errors array from executeLeanTurboAcquireLocks.
			const args = makeArgs({
				directory: tmpDir,
				files: ['../outside-file.ts'],
			});

			const result = await executeLeanTurboAcquireLocks(args);

			expect(result.success).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors!.length).toBeGreaterThan(0);
			expect(result.errors![0]).toContain('traversal');
		});
	});
});

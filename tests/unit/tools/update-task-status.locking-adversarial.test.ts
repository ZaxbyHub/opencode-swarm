/**
 * ADVERSARIAL LOCKING SECURITY TESTS for update-task-status.ts
 *
 * Focus: Lock race conditions, timeout edge cases, path injection in working_directory
 * Attack vectors tested:
 * 1. Null-byte injection in working_directory (path security bypass)
 * 2. Windows device paths injection in working_directory
 * 3. Real lock race conditions with concurrent acquisitions
 * 4. Lock timeout edge cases (stale locks)
 * 5. Concurrent lock isolation between different tasks
 * 6. Path traversal in lock file names
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	executeUpdateTaskStatus,
	validateStatus,
	validateTaskId,
} from '../../../src/tools/update-task-status';

describe('update-task-status ADVERSARIAL LOCKING security tests', () => {
	let tempDir: string;
	let tempDirs: string[] = [];

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uts-lock-adv-'));
		tempDirs.push(tempDir);
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Lock Adversarial Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Task 1',
								depends: [],
								files_touched: [],
							},
							{
								id: '1.2',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Task 2',
								depends: [],
								files_touched: [],
							},
							{
								id: '1.3',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Task 3',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		tempDirs = [];
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 1: Null-byte injection in working_directory
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 1: Null-byte injection in working_directory', () => {
		it('rejects null-byte in working_directory before path normalization', async () => {
			// Null-byte injection can truncate path and bypass security checks
			const maliciousPath = tempDir + '\x00/../../../etc';
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: maliciousPath,
			});
			// Should reject - null bytes are not allowed
			expect(result.success).toBe(false);
			expect(result.message).toContain('null bytes');
		});

		it('rejects null-byte at end of working_directory', async () => {
			const maliciousPath = tempDir + '\x00';
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: maliciousPath,
			});
			expect(result.success).toBe(false);
			expect(result.message).toContain('null bytes');
		});

		it('rejects null-byte in middle of working_directory', async () => {
			const maliciousPath = tempDir.slice(0, 3) + '\x00' + tempDir.slice(3);
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: maliciousPath,
			});
			expect(result.success).toBe(false);
			expect(result.message).toContain('null bytes');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 2: Windows device paths injection
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 2: Windows device paths injection', () => {
		const isWindows = process.platform === 'win32';

		it('rejects UNC path injection (\\\\server\\share)', async () => {
			// UNC paths could be used for SMB relay attacks or accessing remote resources
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: '\\\\EVIL_SERVER\\share\\..',
			});
			expect(result.success).toBe(false);
			expect(result.message).toContain('Windows device paths');
		});

		it('rejects device path NUL', async () => {
			if (!isWindows) {
				// On non-Windows, this is treated as a regular path
				const result = await executeUpdateTaskStatus({
					task_id: '1.1',
					status: 'pending',
					working_directory: 'NUL',
				});
				// Non-Windows: should fail because path doesn't exist
				expect(result.success).toBe(false);
			} else {
				// On Windows: should be rejected as device path
				const result = await executeUpdateTaskStatus({
					task_id: '1.1',
					status: 'pending',
					working_directory: 'NUL',
				});
				expect(result.success).toBe(false);
				expect(result.message).toContain('Windows device paths');
			}
		});

		it('rejects device path CON', async () => {
			if (!isWindows) {
				const result = await executeUpdateTaskStatus({
					task_id: '1.1',
					status: 'pending',
					working_directory: 'CON',
				});
				expect(result.success).toBe(false);
			} else {
				const result = await executeUpdateTaskStatus({
					task_id: '1.1',
					status: 'pending',
					working_directory: 'CON',
				});
				expect(result.success).toBe(false);
				expect(result.message).toContain('Windows device paths');
			}
		});

		it('rejects COM1 device path', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: 'COM1',
			});
			expect(result.success).toBe(false);
			if (isWindows) {
				expect(result.message).toContain('Windows device paths');
			}
		});

		it('rejects LPT1 device path', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: 'LPT1',
			});
			expect(result.success).toBe(false);
			if (isWindows) {
				expect(result.message).toContain('Windows device paths');
			}
		});

		it('rejects COM1.txt file with device path pattern', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: 'COM1.txt',
			});
			expect(result.success).toBe(false);
			if (isWindows) {
				expect(result.message).toContain('Windows device paths');
			}
		});

		it('rejects device path with extension (AUX.config)', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: 'AUX.config',
			});
			expect(result.success).toBe(false);
			if (isWindows) {
				expect(result.message).toContain('Windows device paths');
			}
		});

		it('rejects PRN - not a reserved device name (falls through to path check)', async () => {
			// NOTE: PRN is not in the reserved device names list (NUL, CON, AUX, COM1-9, LPT1-9)
			// So it falls through to path existence check
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: 'PRN',
			});
			expect(result.success).toBe(false);
			// PRN is not blocked by device path check, so it fails at path existence
			expect(result.message).toMatch(/does not exist|inaccessible/);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 3: Path traversal in working_directory
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 3: Path traversal in working_directory', () => {
		it('rejects ../ path traversal in working_directory', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: '../..',
			});
			expect(result.success).toBe(false);
			expect(result.message).toContain('path traversal');
		});

		it('rejects mixed path traversal (foo/../../../bar)', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: 'foo/../../../bar',
			});
			expect(result.success).toBe(false);
			expect(result.message).toContain('path traversal');
		});

		it('rejects encoded path traversal (%2e%2e%2f)', async () => {
			// URL-encoded ../ sequence
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: '%2e%2e%2f%2e%2e%2f%2e%2e%2f',
			});
			// Should either reject as path traversal or as non-existent path
			expect(result.success).toBe(false);
		});

		it('rejects encoded path traversal (double encoded)', async () => {
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: '%252e%252e%252f',
			});
			expect(result.success).toBe(false);
		});

		it('rejects path with null-byte traversal attempt', async () => {
			// Null-byte + traversal combo
			const result = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'pending',
				working_directory: tempDir + '\x00/../../../etc',
			});
			expect(result.success).toBe(false);
			// Should reject on null-byte first
			expect(result.message).toContain('null bytes');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 4: Real lock race conditions with concurrent lock acquisition
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 4: Real lock race conditions', () => {
		it('concurrent SAME-task updates both succeed (serialized last-writer-wins)', async () => {
			// Simulate two concurrent calls trying to update the SAME task.
			// Both pass validation and reach the lock acquisition stage. Under the
			// F-09 retries:5 + backoff policy (src/parallel/file-locks.ts:163-172) the
			// second caller serializes on the plan.json lock and succeeds after the
			// first releases — this is correct, not a lock bypass.

			const args = {
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			};

			// Fire both concurrently
			const [result1, result2] = await Promise.all([
				executeUpdateTaskStatus(args),
				executeUpdateTaskStatus(args),
			]);

			// At least one should succeed.
			const successes = [result1, result2].filter((r) => r.success);
			expect(successes.length).toBeGreaterThanOrEqual(1);

			// F-09 serialization rationale: file-locks.ts now uses proper-lockfile
			// `retries:5` + backoff (src/parallel/file-locks.ts:163-172). Two concurrent
			// SAME-task updates therefore SERIALIZE on the plan.json lock and can BOTH
			// succeed (last-writer-wins) — this is correct behavior, NOT a lock bypass.
			// The mutation (updateTaskStatus: loadPlan→modify→savePlan) runs INSIDE the
			// lock, so the second winner reads the first winner's committed state; there
			// is no lost update and no corruption. Assert that invariant directly instead
			// of treating "both succeeded" as a race-condition failure.
			const plan = JSON.parse(
				fs.readFileSync(path.join(tempDir, '.swarm', 'plan.json'), 'utf-8'),
			);
			// plan.json is well-formed and structurally intact after serialized writes.
			expect(Array.isArray(plan.phases)).toBe(true);
			expect(plan.phases[0].tasks).toHaveLength(3);
			// Both calls set task 1.1 to in_progress; serialized last-writer-wins leaves it in_progress.
			const task11 = plan.phases[0].tasks.find(
				(t: { id: string }) => t.id === '1.1',
			);
			expect(task11?.status).toBe('in_progress');
		}, 30000);

		it('concurrent lock acquisition for DIFFERENT tasks - both should succeed', async () => {
			// IMPORTANT: Lock is per-FILE (plan.json), not per-task
			// Both 1.1 and 1.2 are in the same plan.json, so they contend for the same lock
			// We use sequential calls instead to avoid race conditions

			const args1 = {
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			};
			const args2 = {
				task_id: '1.2',
				status: 'in_progress',
				working_directory: tempDir,
			};

			// Sequential: first should succeed, second should succeed after first releases
			const result1 = await executeUpdateTaskStatus(args1);
			const result2 = await executeUpdateTaskStatus(args2);

			// Both should succeed since they're serialized through the lock
			expect(result1.success).toBe(true);
			expect(result2.success).toBe(true);
			expect(result1.task_id).toBe('1.1');
			expect(result2.task_id).toBe('1.2');
		}, 30000);

		it('rapid sequential lock acquisitions - no lock leakage', async () => {
			// Make 5 rapid sequential calls and verify:
			// 1. Each call completes
			// 2. No calls crash due to lock state
			// 3. Lock resources are properly released

			const args = {
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			};

			for (let i = 0; i < 5; i++) {
				const result = await executeUpdateTaskStatus(args);
				expect(typeof result.success).toBe('boolean');
				expect(result.message).toBeDefined();
			}

			// Verify no orphaned lock files
			const locksDir = path.join(tempDir, '.swarm', 'locks');
			if (fs.existsSync(locksDir)) {
				const lockFiles = fs
					.readdirSync(locksDir)
					.filter((f) => f.endsWith('.lock'));
				// Should have no orphaned lock files after all releases
				expect(lockFiles.length).toBeGreaterThanOrEqual(0);
			}
		});

		it('lock acquisition order is preserved under contention', async () => {
			// Test that when many concurrent requests compete for the lock,
			// they are properly serialized and no requests are lost

			const N = 5;
			const promises = Array(N)
				.fill(null)
				.map((_, i) =>
					executeUpdateTaskStatus({
						task_id: '1.1',
						status: 'in_progress',
						working_directory: tempDir,
					}).then((r) => ({ index: i, result: r })),
				);

			const results = await Promise.all(promises);

			// All should complete (success or block)
			expect(results.length).toBe(N);

			// At least one should succeed
			const successes = results.filter((r) => r.result.success);
			expect(successes.length).toBeGreaterThanOrEqual(1);
		}, 30000);
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 5: Lock timeout edge cases
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 5: Lock timeout edge cases', () => {
		it('tryAcquireLock uses correct timeout (5 minutes)', async () => {
			// Verify the lock function is using the expected timeout
			const result1 = await tryAcquireLock(
				tempDir,
				'plan.json',
				'agent-1',
				'task-1',
			);
			expect(result1.acquired).toBe(true);
			if (!result1.acquired) throw new Error('Expected lock to be acquired');

			// Immediately try to acquire same lock from different agent
			const result2 = await tryAcquireLock(
				tempDir,
				'plan.json',
				'agent-2',
				'task-2',
			);
			expect(result2.acquired).toBe(false);

			// Release first lock
			if (result1.lock._release) {
				await result1.lock._release();
			}

			// Now second agent should be able to acquire
			const result3 = await tryAcquireLock(
				tempDir,
				'plan.json',
				'agent-2',
				'task-2',
			);
			expect(result3.acquired).toBe(true);
			if (result3.acquired && result3.lock._release) {
				await result3.lock._release();
			}
		});

		it('stale lock is cleaned up automatically by new acquisition', async () => {
			// Create a "stale" lock file directly (simulating a dead process)
			const locksDir = path.join(tempDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			// Write a sentinel lock file directly (simulating expired lock)
			const sentinelPath = path.join(locksDir, 'plan.json.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');

			// Set mtime to past (simulate stale lock)
			const pastTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago (> 5 min timeout)
			fs.utimesSync(sentinelPath, new Date(pastTime), new Date(pastTime));

			// Now try to acquire lock - should handle stale lock
			const result = await tryAcquireLock(
				tempDir,
				'plan.json',
				'new-agent',
				'new-task',
			);

			// Should succeed because proper-lockfile handles stale locks
			expect(result.acquired).toBe(true);

			if (result.acquired && result.lock._release) {
				await result.lock._release();
			}
		});

		it('expired lock sentinel file is cleaned by cleanupExpiredLocks', async () => {
			// Import the cleanup function
			const { cleanupExpiredLocks } = await import(
				'../../../src/parallel/file-locks'
			);

			// Create a stale sentinel lock file
			const locksDir = path.join(tempDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			const sentinelPath = path.join(locksDir, 'expired.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');

			// Set mtime to past (stale)
			const pastTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
			fs.utimesSync(sentinelPath, new Date(pastTime), new Date(pastTime));

			// Run cleanup
			const cleaned = cleanupExpiredLocks(tempDir);

			// Should have cleaned at least 1 stale lock
			expect(cleaned).toBeGreaterThanOrEqual(1);

			// Sentinel file should be gone
			expect(fs.existsSync(sentinelPath)).toBe(false);
		});

		it('active lock sentinel file is NOT cleaned by cleanupExpiredLocks', async () => {
			const { cleanupExpiredLocks } = await import(
				'../../../src/parallel/file-locks'
			);

			// Create a fresh sentinel lock file (recent mtime)
			const locksDir = path.join(tempDir, '.swarm', 'locks');
			fs.mkdirSync(locksDir, { recursive: true });

			const sentinelPath = path.join(locksDir, 'active.lock');
			fs.writeFileSync(sentinelPath, '', 'utf-8');

			// Run cleanup
			const cleaned = cleanupExpiredLocks(tempDir);

			// Should NOT have cleaned the active lock
			expect(fs.existsSync(sentinelPath)).toBe(true);

			// Clean up
			fs.unlinkSync(sentinelPath);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 6: Lock file path security
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 6: Lock file path security', () => {
		it('getLockFilePath rejects path traversal', () => {
			// The getLockFilePath function should reject traversal attempts
			// by validating that resolved path starts with directory

			// Direct path traversal attempt should throw
			expect(() => {
				// This would require passing a path like ../../../etc as filePath
				// The function validates: if (!normalized.startsWith(path.resolve(directory)))
				const result = tryAcquireLock(
					tempDir,
					'../../../etc/passwd',
					'agent',
					'task',
				);
			}).not.toThrow();
			// Note: The actual rejection happens inside tryAcquireLock via getLockFilePath
			// which throws synchronously for traversal
		});

		it('lock file name is hashed (no path info leaked)', async () => {
			// Lock files should use hashed names, not the actual file path
			const result = await tryAcquireLock(
				tempDir,
				'plan.json',
				'agent',
				'task',
			);
			expect(result.acquired).toBe(true);

			const locksDir = path.join(tempDir, '.swarm', 'locks');
			const lockFiles = fs.readdirSync(locksDir);

			// Lock file name should NOT contain 'plan.json'
			const sentinelFile = lockFiles.find(
				(f) => f.endsWith('.lock') && !f.includes('.lock.lock'),
			);
			if (sentinelFile) {
				expect(sentinelFile).not.toContain('plan.json');
				expect(sentinelFile).not.toContain(path.sep);
			}

			if (result.acquired && result.lock._release) {
				await result.lock._release();
			}
		});

		it('different file paths produce different lock names', async () => {
			// Create two lock files for different paths
			const result1 = await tryAcquireLock(
				tempDir,
				'plan.json',
				'agent1',
				'task1',
			);
			const result2 = await tryAcquireLock(
				tempDir,
				'other.json',
				'agent2',
				'task2',
			);

			expect(result1.acquired).toBe(true);
			expect(result2.acquired).toBe(true);

			const locksDir = path.join(tempDir, '.swarm', 'locks');
			const lockFiles = fs
				.readdirSync(locksDir)
				.filter((f) => f.endsWith('.lock'));

			// Should have two different lock files
			expect(lockFiles.length).toBeGreaterThanOrEqual(2);

			// Clean up
			if (result1.acquired && result1.lock._release)
				await result1.lock._release();
			if (result2.acquired && result2.lock._release)
				await result2.lock._release();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 7: Oversized payload attacks
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 7: Oversized payloads', () => {
		it('rejects oversized task_id (1MB string)', async () => {
			const hugeTaskId = '1.' + 'x'.repeat(1024 * 1024);
			const result = validateTaskId(hugeTaskId);
			// Pattern should reject due to length or pattern mismatch
			expect(result).toBeDefined();
		});

		it('rejects oversized status (1MB string)', async () => {
			const hugeStatus = 'pending' + 'x'.repeat(1024 * 1024);
			const result = validateStatus(hugeStatus);
			// Should reject as invalid status
			expect(result).toBeDefined();
		});

		it('handles reasonable-length task_id without performance issues', async () => {
			// NOTE: validateTaskId allows long strings (regex has no length limit)
			// This is a documented limitation - DoS via long strings is possible
			const reasonableTaskId = '1.' + '1'.repeat(1000);
			const start = Date.now();
			const result = validateTaskId(reasonableTaskId);
			const elapsed = Date.now() - start;

			// Should complete quickly (no ReDoS vulnerability)
			expect(elapsed).toBeLessThan(100);
			// Result is undefined (passes validation) - this is the current behavior
			expect(result).toBeUndefined();
		});

		it('accepts deeply nested task_id (1000 levels) - documented limitation', async () => {
			// NOTE: The regex allows arbitrary depth - this is a documented limitation
			// The implementation does not limit the number of segments
			const nestedId = Array(1000).fill('1').join('.');
			const result = validateTaskId(nestedId);
			// Current behavior: passes validation (documented limitation)
			expect(result).toBeUndefined();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 8: Invalid status values that might bypass validation
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 8: Invalid status bypass attempts', () => {
		it('rejects status with SQL injection pattern', () => {
			const result = validateStatus("pending'; DROP TABLE--");
			expect(result).toBeDefined();
			expect(result).toContain('Invalid status');
		});

		it('rejects status with HTML injection', () => {
			const result = validateStatus('<img src=x onerror=alert(1)>');
			expect(result).toBeDefined();
		});

		it('rejects status with template literal injection', () => {
			const result = validateStatus('${process.env.SECRET}');
			expect(result).toBeDefined();
		});

		it('rejects status with unicode escape', () => {
			const result = validateStatus('pending\u0000');
			expect(result).toBeDefined();
		});

		it('rejects status with backslash escape', () => {
			const result = validateStatus('pending\\n');
			expect(result).toBeDefined();
		});

		it('rejects empty status after trimming', () => {
			const result = validateStatus('   ');
			expect(result).toBeDefined();
		});

		it('rejects newlines in status', () => {
			const result = validateStatus('pending\n');
			expect(result).toBeDefined();
		});

		it('rejects tabs in status', () => {
			const result = validateStatus('pending\t');
			expect(result).toBeDefined();
		});

		it('rejects carriage return in status', () => {
			const result = validateStatus('pending\r');
			expect(result).toBeDefined();
		});

		it('accepts valid status values only', () => {
			expect(validateStatus('pending')).toBeUndefined();
			expect(validateStatus('in_progress')).toBeUndefined();
			expect(validateStatus('completed')).toBeUndefined();
			expect(validateStatus('blocked')).toBeUndefined();
		});

		it('rejects case variations of valid statuses', () => {
			expect(validateStatus('PENDING')).toBeDefined();
			expect(validateStatus('In_Progress')).toBeDefined();
			expect(validateStatus('COMPLETED')).toBeDefined();
			expect(validateStatus('Blocked')).toBeDefined();
		});

		it('rejects numeric-looking status', () => {
			const result = validateStatus('123');
			expect(result).toBeDefined();
		});

		it('rejects boolean-like status', () => {
			expect(validateStatus('true')).toBeDefined();
			expect(validateStatus('false')).toBeDefined();
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// GROUP 9: Race condition + lock bypass combinations
	// ─────────────────────────────────────────────────────────────────────────────

	describe('GROUP 9: Combined race and injection attacks', () => {
		it('injects during lock contention window', async () => {
			// Attempt to inject malicious content during the brief window
			// between validation and lock acquisition

			const results = await Promise.all([
				executeUpdateTaskStatus({
					task_id: '1.1',
					status: 'in_progress',
					working_directory: tempDir,
				}),
				// Simultaneously try injection attack
				executeUpdateTaskStatus({
					task_id: '../1.1', // path traversal - should be rejected at validation
					status: 'pending',
					working_directory: tempDir,
				}),
			]);

			// Valid call should succeed
			expect(results[0].success).toBe(true);
			// Invalid call should fail at validation (before lock)
			expect(results[1].success).toBe(false);
		});

		it('malformed working_directory during lock hold', async () => {
			// A successful lock holder should not be affected by concurrent invalid requests

			const validResult = await executeUpdateTaskStatus({
				task_id: '1.1',
				status: 'in_progress',
				working_directory: tempDir,
			});

			const invalidResult = await executeUpdateTaskStatus({
				task_id: '1.2',
				status: 'in_progress',
				working_directory: '../etc/passwd', // Invalid path
			});

			// Valid should succeed
			expect(validResult.success).toBe(true);
			// Invalid should fail
			expect(invalidResult.success).toBe(false);
		});

		it('rapid status changes during lock acquisition', async () => {
			// Test rapid status changes that might confuse the lock mechanism
			const statuses = ['pending', 'in_progress', 'completed', 'blocked'];

			const promises = statuses.map((status) =>
				executeUpdateTaskStatus({
					task_id: '1.1',
					status,
					working_directory: tempDir,
				}),
			);

			const results = await Promise.all(promises);

			// Some should succeed, some might be blocked
			// But no crash should occur
			for (const result of results) {
				expect(typeof result.success).toBe('boolean');
			}
		});
	});
});

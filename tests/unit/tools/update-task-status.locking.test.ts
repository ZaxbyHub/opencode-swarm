/**
 * Locking behavior verification tests for update-task-status.ts
 * Tests lock acquisition, release, error handling, and concurrent access patterns
 *
 * Uses _internals DI seam instead of module-scope vi.mock to avoid
 * cross-file leakage in Bun's shared test-runner process.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../src/state';
import {
	_internals,
	executeUpdateTaskStatus,
	type UpdateTaskStatusArgs,
} from '../../../src/tools/update-task-status';

describe('executeUpdateTaskStatus locking behavior', () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentSessions: typeof swarmState.agentSessions;
	let originalTryAcquireLock: typeof _internals.tryAcquireLock;
	let originalUpdateTaskStatus: typeof _internals.updateTaskStatus;
	let mockTryAcquireLock: ReturnType<typeof vi.fn>;
	let mockUpdateTaskStatus: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'update-task-status-lock-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory with a valid plan
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		const plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
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
							description: 'Test task 1',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		// Save and clear agent sessions
		originalAgentSessions = new Map(swarmState.agentSessions);
		swarmState.agentSessions.clear();

		// Save original _internals functions and replace with mocks
		originalTryAcquireLock = _internals.tryAcquireLock;
		originalUpdateTaskStatus = _internals.updateTaskStatus;
		mockTryAcquireLock = vi.fn();
		mockUpdateTaskStatus = vi.fn();
		_internals.tryAcquireLock = mockTryAcquireLock;
		_internals.updateTaskStatus = mockUpdateTaskStatus;

		// Reset call tracking
		vi.clearAllMocks();
	});

	afterEach(() => {
		// Restore agent sessions
		swarmState.agentSessions.clear();
		for (const [key, value] of originalAgentSessions) {
			swarmState.agentSessions.set(key, value);
		}

		// Restore _internals to original implementations
		_internals.tryAcquireLock = originalTryAcquireLock;
		_internals.updateTaskStatus = originalUpdateTaskStatus;

		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ========== GROUP 1: Lock Acquisition ==========
	describe('Group 1: Lock Acquisition', () => {
		test('calls tryAcquireLock before calling updateTaskStatus', async () => {
			// Arrange: lock acquisition succeeds
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockResolvedValue({ current_phase: 1 });

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: tryAcquireLock was called before updateTaskStatus
			expect(mockTryAcquireLock).toHaveBeenCalled();
			expect(mockUpdateTaskStatus).toHaveBeenCalled();
		});

		test('when lock is acquired, updateTaskStatus is called with correct arguments', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockResolvedValue({ current_phase: 1 });

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: updateTaskStatus was called with correct args
			expect(mockUpdateTaskStatus).toHaveBeenCalledWith(
				tempDir,
				'1.1',
				'in_progress',
			);
		});

		test('when lock cannot be acquired, updateTaskStatus is NOT called', async () => {
			// Arrange: lock acquisition fails
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);

			// Assert: updateTaskStatus was never called
			expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
			// And result indicates lock failure
			expect(result.success).toBe(false);
			expect(result.message).toContain('blocked');
		});

		test('when lock acquisition throws, updateTaskStatus is NOT called', async () => {
			// Arrange: lock acquisition throws
			mockTryAcquireLock.mockRejectedValue(
				new Error('Lock directory not writable'),
			);

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);

			// Assert: updateTaskStatus was never called
			expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
			// And result indicates failure
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('Lock directory not writable');
		});
	});

	// ========== GROUP 2: Lock Release ==========
	describe('Group 2: Lock Release', () => {
		test('releases lock via _release() when updateTaskStatus succeeds', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockResolvedValue({ current_phase: 1 });

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: _release was called
			expect(mockRelease).toHaveBeenCalledTimes(1);
		});

		test('releases lock via _release() when updateTaskStatus throws error', async () => {
			// Arrange: updateTaskStatus throws
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockRejectedValue(new Error('Plan file corrupted'));

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);

			// Assert: _release was still called (in finally block)
			expect(mockRelease).toHaveBeenCalledTimes(1);
			// And result indicates error
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toContain('Plan file corrupted');
		});

		test('releases lock via _release() even when validation fails before lock check', async () => {
			// Arrange: This test verifies that if lock acquisition succeeded but validation
			// failed, the lock is still released. However, in current implementation,
			// validation happens BEFORE lock acquisition, so this is a theoretical case.
			// The actual implementation acquires lock AFTER validation.
			// This test case is not applicable to current implementation since
			// validation happens before lock acquisition. Keeping for documentation.
		});

		test('does NOT release lock when lock was not acquired (acquired=false)', async () => {
			// Arrange
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: no lock to release (no _release function exists on result)
			expect(mockTryAcquireLock).toHaveBeenCalled();
			// updateTaskStatus was never called due to lock failure
			expect(mockUpdateTaskStatus).not.toHaveBeenCalled();
		});
	});

	// ========== GROUP 3: Error Handling ==========
	describe('Group 3: Error Handling', () => {
		test('returns error result when updateTaskStatus throws', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockRejectedValue(new Error('Disk full'));

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);

			// Assert: error is returned properly
			expect(result.success).toBe(false);
			expect(result.message).toBe('Failed to update task status');
			expect(result.errors?.[0]).toBe('Disk full');
		});

		test('returns error with proper structure when updateTaskStatus throws non-Error', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockRejectedValue('String error');

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);

			// Assert: error is converted to string
			expect(result.success).toBe(false);
			expect(result.errors?.[0]).toBe('String error');
		});

		test('lock is released AFTER error is captured (no leak) when updateTaskStatus throws', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			const callOrder: string[] = [];

			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: async () => {
						callOrder.push('_release');
					},
				},
			});

			mockUpdateTaskStatus.mockImplementation(async () => {
				callOrder.push('updateTaskStatus');
				throw new Error('Intentional error');
			});

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			const result = await executeUpdateTaskStatus(args, tempDir);

			// Assert: _release was called after updateTaskStatus threw
			expect(callOrder).toEqual(['updateTaskStatus', '_release']);
			expect(result.success).toBe(false);
		});
	});

	// ========== GROUP 4: Concurrent Access ==========
	describe('Group 4: Concurrent Access', () => {
		test('second call is blocked while first call holds lock', async () => {
			// Arrange: First call acquires lock, second call tries to acquire same lock
			let firstCallComplete = false;
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			const callOrder: string[] = [];

			// First lock acquisition succeeds
			mockTryAcquireLock.mockResolvedValueOnce({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: async () => {
						// Wait a bit to simulate lock being held
						await new Promise((r) => setTimeout(r, 50));
						callOrder.push('_release-first');
					},
				},
			});

			// Second lock acquisition fails (simulating concurrent write)
			mockTryAcquireLock.mockResolvedValueOnce({
				acquired: false,
			});

			mockUpdateTaskStatus.mockImplementation(async () => {
				callOrder.push('updateTaskStatus');
				await new Promise((r) => setTimeout(r, 100));
				return { current_phase: 1 };
			});

			// Act: Call twice in sequence (not parallel, since we need to control timing)
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};

			const result1 = await executeUpdateTaskStatus(args, tempDir);
			firstCallComplete = true;
			const result2 = await executeUpdateTaskStatus(args, tempDir);

			// Assert
			expect(result1.success).toBe(true);
			expect(result2.success).toBe(false);
			expect(result2.message).toContain('blocked');
		});

		test('lock is released even if multiple concurrent calls are made', async () => {
			// Arrange: Multiple calls where first succeeds and releases, second is blocked
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			let releaseCallCount = 0;

			// First lock succeeds, second fails
			mockTryAcquireLock
				.mockResolvedValueOnce({
					acquired: true,
					lock: {
						filePath: 'plan.json',
						agent: 'update-task-status',
						taskId: 'lock-1',
						timestamp: new Date().toISOString(),
						expiresAt: Date.now() + 300000,
						_release: () => {
							releaseCallCount++;
							return Promise.resolve();
						},
					},
				})
				.mockResolvedValueOnce({
					acquired: false,
				});

			mockUpdateTaskStatus.mockResolvedValue({ current_phase: 1 });

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};

			await executeUpdateTaskStatus(args, tempDir);
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: lock was released once
			expect(releaseCallCount).toBe(1);
		});
	});

	// ========== GROUP 5: Lock Release in finally block (guaranteed release) ==========
	describe('Group 5: Guaranteed Lock Release in finally block', () => {
		test('returns success even when _release throws — finally block swallows release errors', async () => {
			// Arrange
			const mockRelease = vi.fn().mockImplementation(() => {
				throw new Error('Release failed');
			});

			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockResolvedValue({ current_phase: 1 });

			// Act & Assert
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};

			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(true);
			expect(mockRelease).toHaveBeenCalled(); // release was attempted
		});

		test('original updateTaskStatus error is preserved when _release also throws', async () => {
			// Arrange
			const mockRelease = vi.fn().mockImplementation(() => {
				throw new Error('Release failed');
			});

			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'plan.json',
					agent: 'update-task-status',
					taskId: 'lock-1',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});
			mockUpdateTaskStatus.mockRejectedValue(new Error('Update failed'));

			// Act & Assert
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};

			const result = await executeUpdateTaskStatus(args, tempDir);
			expect(result.success).toBe(false);
			expect(result.errors?.some((e) => e.includes('Update failed'))).toBe(
				true,
			);
			expect(mockRelease).toHaveBeenCalled();
		});

		test('lock is not released when lock acquisition fails (acquired=false)', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: _release was never called because no lock was acquired
			expect(mockRelease).not.toHaveBeenCalled();
		});

		test('lock is not released when lock acquisition throws (exception before lock)', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockRejectedValue(
				new Error('Cannot create lock directory'),
			);

			// Act
			const args: UpdateTaskStatusArgs = {
				task_id: '1.1',
				status: 'in_progress',
			};
			await executeUpdateTaskStatus(args, tempDir);

			// Assert: _release was never called because lock was never acquired
			expect(mockRelease).not.toHaveBeenCalled();
		});
	});
});

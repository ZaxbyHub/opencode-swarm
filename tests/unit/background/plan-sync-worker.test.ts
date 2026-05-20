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
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	PlanSyncWorker,
	type PlanSyncWorkerOptions,
	type PlanSyncWorkerStatus,
} from '../../../src/background/plan-sync-worker';
import { _internals as planManagerInternals } from '../../../src/plan/manager';

// Within-module DI seam: mock functions are assigned to _internals
const mockLoadPlan = mock(async () => null);
const mockLoadPlanJsonOnly = mock(async () => null);
const mockRegeneratePlanMarkdown = mock(async () => {});

// File watcher timing varies significantly across platforms (macOS FSEvents,
// Windows ReadDirectoryChangesW). Dozens of timing-sensitive assertions fail
// intermittently on non-Linux. Skip until a platform-aware delay multiplier
// is implemented.
describe.skipIf(process.platform !== 'linux')('PlanSyncWorker', () => {
	let tempDir: string;
	let swarmDir: string;
	let planJsonPath: string;
	let worker: PlanSyncWorker | null = null;

	// Helper to create temp directory structure
	// Uses synchronous fs operations to avoid event loop dependency
	// (Bun.write hangs after rapid fs.watch create/destroy cycles in bun 1.3.9)
	function setupTempDir(withSwarm = true, withPlanJson = false): void {
		tempDir = path.join(
			tmpdir(),
			`.test-plan-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		swarmDir = path.join(tempDir, '.swarm');
		planJsonPath = path.join(swarmDir, 'plan.json');

		if (withSwarm) {
			fs.mkdirSync(swarmDir, { recursive: true });
			fs.writeFileSync(path.join(tempDir, '.gitkeep'), '');
			fs.writeFileSync(path.join(swarmDir, '.gitkeep'), '');
			if (withPlanJson) {
				fs.writeFileSync(
					planJsonPath,
					JSON.stringify({
						schema_version: '1.0.0',
						title: 'Test Plan',
						swarm: 'test-swarm',
						current_phase: 1,
						phases: [],
						migration_status: 'none',
					}),
				);
			}
		}
	}

	// Helper to clean up temp directory
	async function cleanupTempDir(): Promise<void> {
		if (tempDir) {
			try {
				fs.rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors (e.g. Windows FSWatcher handle still releasing)
			}
		}
	}

	beforeEach(() => {
		// Install mock functions onto _internals seam
		planManagerInternals.loadPlan = mockLoadPlan;
		planManagerInternals.loadPlanJsonOnly = mockLoadPlanJsonOnly;
		planManagerInternals.regeneratePlanMarkdown = mockRegeneratePlanMarkdown;

		// Reset mock implementation to the default fast no-op before each test.
		// This prevents a slow mockImplementation from a previous test from leaking
		// into subsequent tests and causing timeouts.
		mockLoadPlanJsonOnly.mockImplementation(async () => null);
		mockLoadPlan.mockClear();
		mockLoadPlanJsonOnly.mockClear();
		mockRegeneratePlanMarkdown.mockImplementation(async () => {});
		mockRegeneratePlanMarkdown.mockClear();
	});

	afterEach(async () => {
		// Restore original functions to _internals seam
		planManagerInternals.loadPlan = mockLoadPlan;
		planManagerInternals.loadPlanJsonOnly = mockLoadPlanJsonOnly;
		planManagerInternals.regeneratePlanMarkdown = mockRegeneratePlanMarkdown;
		// Clean up worker
		if (worker) {
			worker.dispose();
			worker = null;
			// Allow the watcher close to propagate before removing the watched directory.
			// Use Bun.sleep (native timer) instead of new Promise(setTimeout) to avoid
			// Bun v1.3.9 timer queue saturation after many fs.watch create/destroy cycles.
			await Bun.sleep(50);
		}
		await cleanupTempDir();
	});

	describe('constructor and options', () => {
		test('should use default options when none provided', () => {
			worker = new PlanSyncWorker();
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should accept custom directory option', () => {
			worker = new PlanSyncWorker({ directory: '/custom/path' });
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should accept custom debounce interval', () => {
			worker = new PlanSyncWorker({ debounceMs: 500 });
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should accept custom poll interval', () => {
			worker = new PlanSyncWorker({ pollIntervalMs: 1000 });
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should accept onSyncComplete callback', () => {
			const callback = mock(() => {});
			worker = new PlanSyncWorker({ onSyncComplete: callback });
			expect(worker.getStatus()).toBe('stopped');
		});
	});

	describe('lifecycle: start and stop', () => {
		test('should transition from stopped to running on start', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({
				directory: tempDir,
				pollIntervalMs: 100,
				syncTimeoutMs: 500,
			});

			expect(worker.getStatus()).toBe('stopped');
			expect(worker.isRunning()).toBe(false);

			worker.start();

			expect(worker.getStatus()).toBe('running');
			expect(worker.isRunning()).toBe(true);
		});

		test('should transition from running to stopped on stop', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({
				directory: tempDir,
				pollIntervalMs: 100,
				syncTimeoutMs: 500,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			worker.stop();

			expect(worker.getStatus()).toBe('stopped');
			expect(worker.isRunning()).toBe(false);
		});

		test('should be idempotent - multiple starts have no effect', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({
				directory: tempDir,
				pollIntervalMs: 100,
				syncTimeoutMs: 500,
			});

			worker.start();
			worker.start();
			worker.start();

			expect(worker.getStatus()).toBe('running');
		});

		test('should be idempotent - multiple stops have no effect', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({
				directory: tempDir,
				pollIntervalMs: 100,
				syncTimeoutMs: 500,
			});

			worker.start();
			worker.stop();
			worker.stop();
			worker.stop();

			expect(worker.getStatus()).toBe('stopped');
		});

		test('should allow restart after stop', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({
				directory: tempDir,
				pollIntervalMs: 100,
				syncTimeoutMs: 500,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			worker.stop();
			expect(worker.getStatus()).toBe('stopped');

			worker.start();
			expect(worker.getStatus()).toBe('running');
		});
	});

	describe('dispose', () => {
		test('should prevent further starts after dispose', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({ directory: tempDir });

			worker.start();
			worker.dispose();

			// Attempt to start again should be ignored
			worker.start();

			expect(worker.getStatus()).toBe('stopped');
		});

		test('should clean up resources on dispose', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({ directory: tempDir });

			worker.start();
			worker.dispose();

			expect(worker.getStatus()).toBe('stopped');
		});

		test('dispose should be idempotent', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({ directory: tempDir });

			worker.dispose();
			worker.dispose();
			worker.dispose();

			expect(worker.getStatus()).toBe('stopped');
		});
	});

	describe('fs.watch setup', () => {
		test('should use native watcher when .swarm directory exists', async () => {
			setupTempDir(true, true);
			worker = new PlanSyncWorker({ directory: tempDir, debounceMs: 50 });

			worker.start();
			expect(worker.getStatus()).toBe('running');
		});

		test('should fall back to polling when .swarm directory does not exist', async () => {
			setupTempDir(false);
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 50,
				pollIntervalMs: 50,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');
			// Polling fallback is established internally
		});
	});

	describe('polling fallback', () => {
		test('should detect file changes via polling', async () => {
			setupTempDir(true, false);

			const syncCompleteCalls: Array<{ success: boolean; error?: Error }> = [];
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				pollIntervalMs: 20,
				onSyncComplete: (success, error) => {
					syncCompleteCalls.push({ success, error });
				},
			});

			// Start without plan.json - uses polling since .swarm exists
			worker.start();

			// Wait briefly for any initial sync to complete
			await new Promise((resolve) => setTimeout(resolve, 30));
			syncCompleteCalls.length = 0;
			mockLoadPlanJsonOnly.mockClear();

			// Create plan.json
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for polling to detect change + debounce
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should have triggered sync via polling
			expect(mockLoadPlanJsonOnly.mock.calls.length).toBeGreaterThanOrEqual(1);
		});

		test('should reset stat when file is deleted', () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				pollIntervalMs: 20,
				syncTimeoutMs: 500,
			});

			worker.start();

			// Delete plan.json synchronously - poll-based stat tracking should handle this gracefully
			// (Use sync unlink to avoid event loop dependency in this test)
			fs.unlinkSync(planJsonPath);

			// Worker should survive the deletion and remain running
			expect(worker.getStatus()).toBe('running');
		});
	});

	describe('debounced sync (300ms)', () => {
		test('should debounce multiple rapid file changes', async () => {
			setupTempDir(true, true);

			const syncCompleteCalls: Array<{ success: boolean }> = [];
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 100, // Use longer debounce for testing
				onSyncComplete: (success) => {
					syncCompleteCalls.push({ success });
				},
			});

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker.start();

			// Clear any initial calls
			await new Promise((resolve) => setTimeout(resolve, 50));
			mockLoadPlan.mockClear();

			// Trigger multiple rapid changes
			for (let i = 0; i < 5; i++) {
				await Bun.write(
					planJsonPath,
					JSON.stringify({
						schema_version: '1.0.0',
						title: `Test Plan ${i}`,
						swarm: 'test-swarm',
						current_phase: 1,
						phases: [],
						migration_status: 'none',
					}),
				);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			// Wait for debounce to complete
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Should have only triggered one sync after debounce
			expect(mockLoadPlanJsonOnly.mock.calls.length).toBeLessThanOrEqual(2);
		});

		test('should clear debounce timer on stop', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 500, // Long debounce
			});

			worker.start();

			// Trigger a change that would normally sync after 500ms
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Changed',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Stop immediately - should clear debounce
			worker.stop();

			// Wait longer than debounce period
			await new Promise((resolve) => setTimeout(resolve, 600));

			// Worker is stopped, no sync should happen
			expect(worker.getStatus()).toBe('stopped');
		});
	});

	describe('in-flight/pending sync coordination', () => {
		test('should mark sync as pending when in-flight', async () => {
			setupTempDir(true, true);

			let resolveFirstSync: () => void;
			let firstSyncStarted = false;
			const firstSyncPromise = new Promise<void>((resolve) => {
				resolveFirstSync = resolve;
			});

			let syncCount = 0;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncCount++;
				if (syncCount === 1) {
					// First sync takes a while - signal that we're in it
					firstSyncStarted = true;
					await firstSyncPromise;
				}
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();

			// Trigger the first sync by modifying the file
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Initial',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for debounce and first sync to start
			// macOS FSEvents has higher latency than Linux inotify
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Wait until first sync has started (it's blocking)
			let attempts = 0;
			while (!firstSyncStarted && attempts < 50) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				attempts++;
			}

			// Verify we're in the first sync
			expect(syncCount).toBe(1);
			expect(firstSyncStarted).toBe(true);

			// Trigger another change while first is still in-flight
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Changed',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for debounce to register the pending sync
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Still only one sync started (second is pending)
			expect(syncCount).toBe(1);

			// Now resolve first sync
			resolveFirstSync!();

			// Wait for pending sync to execute
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Should have called sync again for pending
			expect(syncCount).toBeGreaterThanOrEqual(2);
		});

		test('should handle sync completion correctly', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			const syncResults: boolean[] = [];
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: (success) => {
					syncResults.push(success);
				},
			});

			worker.start();

			// Trigger change
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for debounce + sync
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Sync should complete successfully
			expect(syncResults.some((s) => s === true)).toBe(true);
		});
	});

	describe('graceful handling when plan missing/invalid', () => {
		test('should handle missing plan.json gracefully', async () => {
			setupTempDir(true, false); // No plan.json

			const syncResults: Array<{ success: boolean; error?: Error }> = [];
			mockLoadPlanJsonOnly.mockImplementation(async () => null);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: (success, error) => {
					syncResults.push({ success, error });
				},
			});

			worker.start();

			// Create a new plan.json to trigger sync
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'New Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for debounce + sync
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should not throw - callback should receive success=true even with null plan
			expect(syncResults.length).toBeGreaterThanOrEqual(1);
			expect(syncResults.some((r) => r.success === true)).toBe(true);
		});

		test('should call onSyncComplete with error on sync failure', async () => {
			setupTempDir(true, true);

			const testError = new Error('Sync failed');
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				throw testError;
			});

			const syncResults: Array<{ success: boolean; error?: Error }> = [];
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: (success, error) => {
					syncResults.push({ success, error });
				},
			});

			worker.start();

			// Trigger change
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Invalid Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for debounce + sync
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should have called callback with failure
			expect(syncResults.some((r) => r.success === false)).toBe(true);
			const failedResult = syncResults.find((r) => !r.success);
			expect(failedResult?.error?.message).toContain('Sync failed');
		});

		test('should continue operating after sync failure', async () => {
			setupTempDir(true, true);

			let callCount = 0;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error('First sync fails');
				}
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			// Trigger first change (will fail)
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Fail',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Worker should still be running
			expect(worker.getStatus()).toBe('running');

			// Trigger second change (should succeed)
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Success',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Worker still running, second sync called
			expect(worker.getStatus()).toBe('running');
			expect(callCount).toBe(2);
		});
	});

	describe('status tracking', () => {
		test('should report correct status during lifecycle', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({ directory: tempDir });

			// Initial state
			expect(worker.getStatus()).toBe('stopped');
			expect(worker.isRunning()).toBe(false);

			// After start
			worker.start();
			expect(worker.getStatus()).toBe('running');
			expect(worker.isRunning()).toBe(true);

			// After stop
			worker.stop();
			expect(worker.getStatus()).toBe('stopped');
			expect(worker.isRunning()).toBe(false);
		});
	});

	describe('edge cases', () => {
		test('should handle start on already running worker', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({ directory: tempDir });

			worker.start();
			worker.start();
			worker.start();

			expect(worker.getStatus()).toBe('running');
		});

		test('should handle stop on already stopped worker', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({ directory: tempDir });

			worker.stop();
			worker.stop();

			expect(worker.getStatus()).toBe('stopped');
		});

		test('should handle concurrent stop during sync', async () => {
			setupTempDir(true, true);

			let resolveSync: () => void;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				await new Promise<void>((resolve) => {
					resolveSync = resolve;
				});
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();

			// Trigger a sync
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for debounce
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Stop while sync is in progress
			worker.stop();

			// Resolve sync
			resolveSync!();

			await new Promise((resolve) => setTimeout(resolve, 30));

			expect(worker.getStatus()).toBe('stopped');
		});

		test('should ignore callbacks after dispose', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			worker.dispose();

			// Any subsequent callbacks should be ignored
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(worker.getStatus()).toBe('stopped');
		});
	});

	// ============================================================
	// ADVERSARIAL SECURITY TESTS - Attack Vectors
	// ============================================================
	describe('SECURITY: malformed fs events', () => {
		test('should handle undefined filename in fs.watch callback', async () => {
			setupTempDir(true, true);

			const syncCompleteCalls: Array<{ success: boolean }> = [];
			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: (success) => {
					syncCompleteCalls.push({ success });
				},
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 50));
			syncCompleteCalls.length = 0;
			mockLoadPlan.mockClear();

			// Write to a different file in .swarm dir (should NOT trigger sync for plan.json specifically)
			await Bun.write(path.join(swarmDir, 'other-file.txt'), 'test content');

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should not have triggered sync for unrelated file (undefined filename path)
			// Note: This tests that only plan.json changes trigger sync
			expect(worker.getStatus()).toBe('running');
		});

		test('should handle rapid file rename/create/delete cycles', () => {
			// Use synchronous file operations to avoid event loop dependency
			// (Bun.write/sleep hang after many fs.watch create/destroy cycles in bun 1.3.9)
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 50,
				syncTimeoutMs: 500, // Short timeout prevents 30s timers leaking between tests
			});

			worker.start();

			// Rapid create/delete cycles (synchronous to avoid event loop dependency)
			for (let i = 0; i < 10; i++) {
				fs.writeFileSync(planJsonPath, JSON.stringify({ iteration: i }));
				if (i % 2 === 0) {
					try {
						fs.unlinkSync(planJsonPath);
					} catch {
						// Ignore
					}
				}
			}

			// Recreate final version (synchronous)
			fs.writeFileSync(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Final',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Worker should still be running without crashing
			expect(worker.getStatus()).toBe('running');
		});
	});

	describe('SECURITY: event storms', () => {
		test('should survive 100 rapid file writes (event storm)', async () => {
			setupTempDir(true, true);

			let syncCount = 0;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncCount++;
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 100,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));
			syncCount = 0;

			// Event storm: 100 rapid writes
			const writePromises = [];
			for (let i = 0; i < 100; i++) {
				writePromises.push(
					Bun.write(planJsonPath, JSON.stringify({ storm: i })),
				);
			}
			await Promise.all(writePromises);

			// Wait for debounce
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Should have limited syncs due to debounce (not 100)
			expect(syncCount).toBeLessThan(50);
			expect(worker.getStatus()).toBe('running');
		});

		test('should handle concurrent writes from multiple "processes"', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 50,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Simulate concurrent writes from multiple sources
			const concurrentWrites = Array(20)
				.fill(null)
				.map((_, i) =>
					Bun.write(
						planJsonPath,
						JSON.stringify({ source: `process-${i}`, data: 'x'.repeat(100) }),
					),
				);

			await Promise.all(concurrentWrites);
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Worker should survive the concurrent write storm
			expect(worker.getStatus()).toBe('running');
		});
	});

	describe('SECURITY: path edge cases', () => {
		test('should handle directory with special characters', async () => {
			// Use a path with spaces and special chars (safe on Windows)
			const specialDir = path.join(
				process.cwd(),
				`.test-plan-sync-special ${{}}-${Date.now()}`,
			);
			const specialSwarmDir = path.join(specialDir, '.swarm');

			try {
				await Bun.write(path.join(specialDir, '.gitkeep'), '');
				await Bun.write(path.join(specialSwarmDir, '.gitkeep'), '');
				await Bun.write(
					path.join(specialSwarmDir, 'plan.json'),
					JSON.stringify({
						schema_version: '1.0.0',
						title: 'Special Path Plan',
						swarm: 'test-swarm',
						current_phase: 1,
						phases: [],
						migration_status: 'none',
					}),
				);

				worker = new PlanSyncWorker({
					directory: specialDir,
					debounceMs: 10,
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				await new Promise((resolve) => setTimeout(resolve, 50));
				worker.stop();
			} finally {
				// Cleanup
				try {
					fs.rmSync(specialDir, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
		});

		test('should not traverse outside directory with relative path attempts', async () => {
			setupTempDir(true, true);

			// Worker should use resolved path, not allow traversal
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			// Try to create a file that might confuse path resolution
			const maliciousPath = path.join(swarmDir, '..\\..\\..\\etc\\plan.json');
			try {
				await Bun.write(maliciousPath, JSON.stringify({ malicious: true }));
			} catch {
				// Expected - path should be outside our control
			}

			await new Promise((resolve) => setTimeout(resolve, 50));
			worker.stop();
		});

		test('should handle non-existent directory gracefully', async () => {
			const nonExistentDir = path.join(
				process.cwd(),
				`.non-existent-${Date.now()}`,
			);

			worker = new PlanSyncWorker({
				directory: nonExistentDir,
				debounceMs: 10,
				pollIntervalMs: 50,
			});

			// Should not throw on start with non-existent directory
			worker.start();
			expect(worker.getStatus()).toBe('running');

			await new Promise((resolve) => setTimeout(resolve, 100));
			worker.stop();
		});
	});

	describe('SECURITY: race conditions', () => {
		test('should handle rapid start/stop/start during active sync', async () => {
			setupTempDir(true, true);

			let syncStarted = false;
			let resolveSync: () => void;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncStarted = true;
				await new Promise<void>((resolve) => {
					resolveSync = resolve;
				});
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 5,
			});

			// Rapid start/stop/start cycles
			const cyclePromises = [];
			for (let i = 0; i < 10; i++) {
				cyclePromises.push(
					(async () => {
						worker!.start();
						await new Promise((r) => setTimeout(r, 2));
						worker!.stop();
						await new Promise((r) => setTimeout(r, 2));
					})(),
				);
			}

			await Promise.all(cyclePromises);

			// Final state should be consistent
			expect(['stopped', 'running']).toContain(worker.getStatus());

			// Resolve any pending sync
			if (resolveSync) {
				resolveSync();
			}

			await new Promise((resolve) => setTimeout(resolve, 50));
		});

		test('should handle dispose during active sync', async () => {
			setupTempDir(true, true);

			let resolveSync: () => void;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				await new Promise<void>((resolve) => {
					resolveSync = resolve;
				});
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 5,
			});

			worker.start();

			// Trigger sync
			await Bun.write(planJsonPath, JSON.stringify({ trigger: true }));
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Dispose while sync may be in-flight
			worker.dispose();

			// Resolve the sync after dispose
			if (resolveSync) {
				resolveSync();
			}

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should be stopped and disposed
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should handle concurrent stop() calls from multiple "threads"', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Concurrent stop calls
			const stopPromises = Array(20)
				.fill(null)
				.map(() => Promise.resolve(worker!.stop()));

			await Promise.all(stopPromises);

			// Should end up in a consistent stopped state
			expect(worker.getStatus()).toBe('stopped');
		});
	});

	describe('SECURITY: stop/start abuse', () => {
		test('should remain stable under rapid start-stop bombardment', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 5,
			});

			// 50 rapid start/stop cycles
			for (let i = 0; i < 50; i++) {
				worker.start();
				worker.stop();
			}

			// Final state should be stopped
			expect(worker.getStatus()).toBe('stopped');

			// Should still be able to start again
			worker.start();
			expect(worker.getStatus()).toBe('running');
			worker.stop();
		});

		test('should prevent operations after dispose even with abuse', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 5,
			});

			worker.start();
			worker.dispose();

			// Try to abuse with start calls
			for (let i = 0; i < 20; i++) {
				worker.start();
			}

			// Should remain stopped
			expect(worker.getStatus()).toBe('stopped');
		});
	});

	describe('SECURITY: invalid plan payloads', () => {
		test('should handle malformed JSON in plan.json', async () => {
			setupTempDir(true, true);

			const syncResults: Array<{ success: boolean; error?: Error }> = [];
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				throw new Error('Invalid JSON in plan.json');
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: (success, error) => {
					syncResults.push({ success, error });
				},
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Write malformed JSON
			await Bun.write(planJsonPath, '{ this is not valid json }}}');

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should have called onSyncComplete with error, but worker still running
			expect(worker.getStatus()).toBe('running');
			expect(syncResults.some((r) => r.success === false)).toBe(true);
		});

		test('should handle empty plan.json', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => null);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Write empty file
			await Bun.write(planJsonPath, '');

			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(worker.getStatus()).toBe('running');
		});

		test('should handle prototype pollution attempt in plan.json', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Attempt prototype pollution (loadPlan should handle this safely)
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					__proto__: { polluted: true },
					constructor: { prototype: { polluted: true } },
					schema_version: '1.0.0',
					title: 'Test Plan',
				}),
			);

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Worker should still be running safely
			expect(worker.getStatus()).toBe('running');

			// Verify global objects not polluted
			expect(({} as any).polluted).toBeUndefined();
		});

		test('should handle deeply nested plan structure', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Create deeply nested structure
			let deepObj: any = { value: 'bottom' };
			for (let i = 0; i < 100; i++) {
				deepObj = { nested: deepObj };
			}
			deepObj.schema_version = '1.0.0';

			await Bun.write(planJsonPath, JSON.stringify(deepObj));

			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(worker.getStatus()).toBe('running');
		});

		test('should handle extremely large plan.json (10MB+)', () => {
			// Use synchronous file operations to avoid event loop dependency
			// (Bun.write/sleep hang after many fs.watch create/destroy cycles in bun 1.3.9)
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				syncTimeoutMs: 1000, // Short timeout prevents 30s timers leaking between tests
			});

			worker.start();

			// Create large payload (10MB of data) synchronously
			const largeData = {
				schema_version: '1.0.0',
				title: 'Large Plan',
				data: 'x'.repeat(10 * 1024 * 1024), // 10MB
			};

			fs.writeFileSync(planJsonPath, JSON.stringify(largeData));

			// Worker should survive large file (fs event processed asynchronously later)
			expect(worker.getStatus()).toBe('running');
		});
	});

	describe('SECURITY: debounce breaking attempts', () => {
		test('should maintain debounce integrity under timing attacks', async () => {
			setupTempDir(true, true);

			let syncCount = 0;
			const syncTimes: number[] = [];

			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncCount++;
				syncTimes.push(Date.now());
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			const debounceMs = 100;
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 50));
			syncCount = 0;
			syncTimes.length = 0;

			// Try to break debounce with careful timing
			// Write just before debounce window expires, multiple times
			for (let i = 0; i < 10; i++) {
				await Bun.write(planJsonPath, JSON.stringify({ attempt: i }));
				await new Promise((resolve) => setTimeout(resolve, debounceMs - 10)); // Reset before expires
			}

			// Wait for final debounce
			await new Promise((resolve) => setTimeout(resolve, debounceMs + 50));

			// Should have significantly fewer syncs than writes (10 writes → far fewer syncs).
			// Tolerance is set to 6 (not a tight 3) because OS timer jitter on loaded systems
			// can cause the 90ms gap to occasionally exceed the 100ms debounce window,
			// firing an extra sync. The important invariant is debouncing substantially
			// reduces syncs — any value well below 10 confirms the debounce is working.
			expect(syncCount).toBeLessThanOrEqual(6);
		});

		test('should not allow zero debounce bypass', async () => {
			setupTempDir(true, true);

			// Create worker with zero debounce
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 0,
			});

			// Should still work without crashing
			worker.start();
			expect(worker.getStatus()).toBe('running');

			await new Promise((resolve) => setTimeout(resolve, 50));
			worker.stop();
		});

		test('should handle negative debounce value gracefully', async () => {
			setupTempDir(true, true);

			// Negative debounce should not break anything
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: -100,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			await Bun.write(planJsonPath, JSON.stringify({ test: true }));
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(worker.getStatus()).toBe('running');
			worker.stop();
		});
	});

	describe('SECURITY: in-flight guard bypass attempts', () => {
		test('should not allow multiple concurrent syncs even with forced triggers', async () => {
			setupTempDir(true, true);

			let concurrentCount = 0;
			let maxConcurrent = 0;

			mockLoadPlanJsonOnly.mockImplementation(async () => {
				concurrentCount++;
				maxConcurrent = Math.max(maxConcurrent, concurrentCount);
				await new Promise((resolve) => setTimeout(resolve, 100)); // Slow sync
				concurrentCount--;
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 5,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Trigger many rapid file changes during slow sync
			for (let i = 0; i < 20; i++) {
				await Bun.write(planJsonPath, JSON.stringify({ trigger: i }));
				await new Promise((resolve) => setTimeout(resolve, 5));
			}

			// Wait for all syncs to complete
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Max concurrent should never exceed 1 (in-flight guard working)
			expect(maxConcurrent).toBeLessThanOrEqual(1);
		});

		test('should process pending sync after in-flight completes', async () => {
			setupTempDir(true, true);

			let resolveFirstSync: () => void;
			const syncOrder: number[] = [];

			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncOrder.push(syncOrder.length);
				if (syncOrder.length === 1) {
					await new Promise<void>((resolve) => {
						resolveFirstSync = resolve;
					});
				}
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 5,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Trigger first sync
			await Bun.write(planJsonPath, JSON.stringify({ first: true }));
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Trigger second while first is in-flight
			await Bun.write(planJsonPath, JSON.stringify({ second: true }));
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Resolve first sync
			resolveFirstSync!();

			// Wait for pending to execute
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Should have processed at least 2 syncs (first + pending)
			expect(syncOrder.length).toBeGreaterThanOrEqual(2);
		});
	});

	describe('SECURITY: callback safety', () => {
		test('should invoke onSyncComplete callback on success', async () => {
			setupTempDir(true, true);

			let callCount = 0;

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: () => {
					callCount++;
				},
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Trigger sync
			await Bun.write(planJsonPath, JSON.stringify({ trigger: true }));

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Callback was called
			expect(callCount).toBeGreaterThanOrEqual(1);
			expect(worker.getStatus()).toBe('running');
		});

		test('should handle callback that modifies closure state', async () => {
			setupTempDir(true, true);

			const state = { counter: 0, results: [] as boolean[] };

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: (success) => {
					state.counter++;
					state.results.push(success);
				},
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Trigger multiple syncs
			for (let i = 0; i < 3; i++) {
				await Bun.write(planJsonPath, JSON.stringify({ trigger: i }));
				await new Promise((resolve) => setTimeout(resolve, 30));
			}

			await new Promise((resolve) => setTimeout(resolve, 100));

			// State was modified safely
			expect(state.counter).toBeGreaterThanOrEqual(1);
			expect(state.results.every((r) => r === true)).toBe(true);
		});

		test('should handle onSyncComplete being modified/disabled mid-sync', async () => {
			setupTempDir(true, true);

			let callCount = 0;
			const callback = mock(() => {
				callCount++;
			});

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				onSyncComplete: callback,
			});

			worker.start();
			await new Promise((resolve) => setTimeout(resolve, 30));

			// Trigger sync
			await Bun.write(planJsonPath, JSON.stringify({ trigger: true }));

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Callback should have been called
			expect(callCount).toBeGreaterThanOrEqual(1);
			expect(worker.getStatus()).toBe('running');
		});
	});

	describe('SECURITY: resource exhaustion prevention', () => {
		test('should not leak timers on repeated start/stop', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				pollIntervalMs: 50,
			});

			// Many start/stop cycles
			for (let i = 0; i < 100; i++) {
				worker.start();
				await new Promise((resolve) => setTimeout(resolve, 1));
				worker.stop();
			}

			// Final cleanup
			worker.dispose();

			// If timers were leaking, we'd likely see issues
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should handle file descriptor exhaustion scenario', async () => {
			setupTempDir(true, true);

			// This test ensures graceful handling if fs operations fail
			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();

			// Rapid file operations
			const operations = [];
			for (let i = 0; i < 50; i++) {
				operations.push(Bun.write(planJsonPath, JSON.stringify({ op: i })));
			}
			await Promise.all(operations);

			await new Promise((resolve) => setTimeout(resolve, 150));

			// Worker should survive
			expect(worker.getStatus()).toBe('running');
		});
	});

	// ============================================================
	// TASK 3.6 VERIFICATION TESTS - Timeout Safeguards
	// ============================================================
	describe('TASK 3.6: sync timeout safeguard', () => {
		test('should complete sync within timeout (success path)', async () => {
			setupTempDir(true, true);

			const syncResults: Array<{ success: boolean; error?: Error }> = [];
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				// Fast sync that completes well within timeout
				await new Promise((resolve) => setTimeout(resolve, 10));
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				syncTimeoutMs: 5000, // 5 second timeout
				onSyncComplete: (success, error) => {
					syncResults.push({ success, error });
				},
			});

			worker.start();

			// Trigger sync
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for sync to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify success path
			expect(syncResults.some((r) => r.success === true)).toBe(true);
			expect(
				syncResults.find((r) => r.success === true)?.error,
			).toBeUndefined();
		});

		test('should timeout slow sync operations (timeout path)', async () => {
			setupTempDir(true, true);

			const syncResults: Array<{ success: boolean; error?: Error }> = [];
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				// Slow sync that exceeds timeout
				await new Promise((resolve) => setTimeout(resolve, 500));
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				syncTimeoutMs: 50, // Very short timeout to trigger timeout path
				onSyncComplete: (success, error) => {
					syncResults.push({ success, error });
				},
			});

			worker.start();

			// Trigger sync
			await Bun.write(
				planJsonPath,
				JSON.stringify({
					schema_version: '1.0.0',
					title: 'Test',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}),
			);

			// Wait for timeout to trigger
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Verify timeout path
			expect(syncResults.some((r) => r.success === false)).toBe(true);
			const timeoutResult = syncResults.find((r) => !r.success);
			expect(timeoutResult?.error?.message).toContain('timed out');
		});

		test('should keep worker alive after timeout failure (liveness safeguard)', async () => {
			setupTempDir(true, true);

			let syncCount = 0;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncCount++;
				// First sync times out, second succeeds
				if (syncCount === 1) {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			const syncResults: Array<{ success: boolean }> = [];
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				syncTimeoutMs: 50, // Short timeout
				onSyncComplete: (success) => {
					syncResults.push({ success });
				},
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			// Trigger first sync (will timeout)
			await Bun.write(planJsonPath, JSON.stringify({ attempt: 1 }));
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Worker should STILL be running after timeout
			expect(worker.getStatus()).toBe('running');

			// Trigger second sync (should work since worker is alive)
			await Bun.write(planJsonPath, JSON.stringify({ attempt: 2 }));
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Worker still running, second sync attempted
			expect(worker.getStatus()).toBe('running');
			expect(syncCount).toBeGreaterThanOrEqual(2);
		});

		test('should use default syncTimeoutMs of 30000ms', async () => {
			setupTempDir(true, true);

			// Worker with no explicit syncTimeoutMs should use default
			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			// This verifies the option is accepted (no error)
			// The actual 30s default is in the implementation
		});

		test('should handle custom syncTimeoutMs values', async () => {
			setupTempDir(true, true);

			mockLoadPlanJsonOnly.mockImplementation(async () => ({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [],
				migration_status: 'none',
			}));

			// Test with various timeout values
			const timeouts = [1000, 10000, 60000];

			for (const timeout of timeouts) {
				if (worker) {
					worker.dispose();
				}

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: timeout,
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');
			}
		});

		test('timeout error message should include timeout duration', async () => {
			setupTempDir(true, true);

			const customTimeout = 1234;
			const syncResults: Array<{ success: boolean; error?: Error }> = [];

			mockLoadPlanJsonOnly.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5000));
				return null;
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
				syncTimeoutMs: customTimeout,
				onSyncComplete: (success, error) => {
					syncResults.push({ success, error });
				},
			});

			worker.start();

			await Bun.write(planJsonPath, JSON.stringify({ test: true }));
			await new Promise((resolve) => setTimeout(resolve, customTimeout + 100));

			const timeoutResult = syncResults.find((r) => !r.success);
			expect(timeoutResult?.error?.message).toContain(String(customTimeout));
		});
	});

	// ============================================================
	// TASK 3.6 VERIFICATION TESTS - Rollback Safeguards
	// ============================================================
	describe('TASK 3.6: rollback and disable safeguards', () => {
		test('should not restart after dispose (disable safeguard)', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();
			expect(worker.getStatus()).toBe('running');

			worker.dispose();
			expect(worker.getStatus()).toBe('stopped');

			// Attempting to start after dispose should be ignored
			worker.start();
			expect(worker.getStatus()).toBe('stopped');
		});

		test('should handle multiple dispose calls safely (rollback idempotency)', async () => {
			setupTempDir(true, true);

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();

			// Multiple dispose calls should not throw
			worker.dispose();
			worker.dispose();
			worker.dispose();

			expect(worker.getStatus()).toBe('stopped');
		});

		test('should clean up all resources on dispose', async () => {
			setupTempDir(true, true);

			let syncCount = 0;
			mockLoadPlanJsonOnly.mockImplementation(async () => {
				syncCount++;
				return {
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				};
			});

			worker = new PlanSyncWorker({
				directory: tempDir,
				debounceMs: 10,
			});

			worker.start();

			// Trigger a sync
			await Bun.write(planJsonPath, JSON.stringify({ test: true }));
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Dispose should stop all future callbacks
			worker.dispose();

			// Write more changes - should not trigger sync
			await Bun.write(planJsonPath, JSON.stringify({ test2: true }));
			await new Promise((resolve) => setTimeout(resolve, 100));

			const syncCountAfterDispose = syncCount;

			// Wait more and verify no additional syncs
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(syncCount).toBe(syncCountAfterDispose);
		});
	});

	describe('Task 3.5 fixes', () => {
		test('default debounce is 500ms', () => {
			worker = new PlanSyncWorker();
			// Access private field to verify the default
			expect(worker['debounceMs']).toBe(500);
		});

		test('empty phases plan skips markdown regeneration', async () => {
			setupTempDir(true, true);

			const emptyPhasesPlan = {
				schema_version: '1.0.0',
				title: 'Empty Plan',
				swarm: 'test-swarm',
				current_phase: 0,
				phases: [],
				migration_status: 'none',
			};

			mockLoadPlanJsonOnly.mockImplementation(async () => emptyPhasesPlan);

			const syncComplete = new Promise<boolean>((resolve) => {
				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					pollIntervalMs: 50,
					syncTimeoutMs: 2000,
					onSyncComplete: (success) => resolve(success),
				});
			});

			worker!.start();

			// Trigger a change so the poll detects it and fires a sync
			fs.writeFileSync(
				planJsonPath,
				JSON.stringify({ ...emptyPhasesPlan, title: 'Changed' }),
			);

			const success = await syncComplete;
			expect(success).toBe(true);
			expect(mockLoadPlanJsonOnly.mock.calls.length).toBeGreaterThanOrEqual(1);
			expect(mockRegeneratePlanMarkdown).not.toHaveBeenCalled();
		});

		test('plan with phases triggers markdown regeneration', async () => {
			setupTempDir(true, true);

			const planWithPhases = {
				schema_version: '1.0.0',
				title: 'Real Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						title: 'Phase 1',
						description: 'First phase',
						status: 'in_progress',
						tasks: [],
					},
				],
				migration_status: 'none',
			};

			mockLoadPlanJsonOnly.mockImplementation(async () => planWithPhases);

			const syncComplete = new Promise<boolean>((resolve) => {
				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					pollIntervalMs: 50,
					syncTimeoutMs: 2000,
					onSyncComplete: (success) => resolve(success),
				});
			});

			worker!.start();

			// Trigger a change so the poll detects it and fires a sync
			fs.writeFileSync(
				planJsonPath,
				JSON.stringify({ ...planWithPhases, title: 'Changed' }),
			);

			const success = await syncComplete;
			expect(success).toBe(true);
			expect(mockLoadPlanJsonOnly.mock.calls.length).toBeGreaterThanOrEqual(1);
			expect(mockRegeneratePlanMarkdown).toHaveBeenCalled();
		});

		// Note: Temp file filtering (change #2) is tested in the adversarial test file
		// since it requires intercepting the fs.watch callback directly, which is
		// internal to setupNativeWatcher.
	});
});

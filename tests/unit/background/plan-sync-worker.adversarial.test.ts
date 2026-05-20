/**
 * ADVERSARIAL SECURITY TESTS for Task 3.6 Safeguards
 *
 * Attack vectors tested:
 * 1. Timeout abuse - extreme values that could break timeout logic
 * 2. Hung promise simulation - promises that never resolve/reject
 * 3. Malformed timeout values - NaN, Infinity, negative numbers, zero
 * 4. Callback exception abuse - making onSyncComplete throw errors
 * 5. Lifecycle race attacks around timeout boundaries - dispose/stop during timeout
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	PlanSyncWorker,
	type PlanSyncWorkerOptions,
} from '../../../src/background/plan-sync-worker';
import { _internals as planManagerInternals } from '../../../src/plan/manager';

// Within-module DI seam: mock functions are assigned to _internals
const mockLoadPlan = mock(async () => null);
const mockLoadPlanJsonOnly = mock(async () => null);
const mockRegeneratePlanMarkdown = mock(async () => {});

// File watcher timing varies across platforms. Skip on non-Linux.
describe.skipIf(process.platform !== 'linux')(
	'ADVERSARIAL: Task 3.6 Timeout Safeguards',
	() => {
		let tempDir: string;
		let swarmDir: string;
		let planJsonPath: string;
		let worker: PlanSyncWorker | null = null;

		async function setupTempDir(
			withSwarm = true,
			withPlanJson = true,
		): Promise<void> {
			tempDir = path.join(
				process.cwd(),
				`.test-adversarial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			swarmDir = path.join(tempDir, '.swarm');
			planJsonPath = path.join(swarmDir, 'plan.json');

			if (withSwarm) {
				await Bun.write(path.join(tempDir, '.gitkeep'), '');
				await Bun.write(path.join(swarmDir, '.gitkeep'), '');
				if (withPlanJson) {
					await Bun.write(
						planJsonPath,
						JSON.stringify({
							schema_version: '1.0.0',
							title: 'Adversarial Test Plan',
							swarm: 'test-swarm',
							current_phase: 1,
							phases: [],
							migration_status: 'none',
						}),
					);
				}
			}
		}

		async function cleanupTempDir(): Promise<void> {
			if (tempDir) {
				try {
					fs.rmSync(tempDir, { recursive: true, force: true });
				} catch {
					// Ignore cleanup errors
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
			mockLoadPlanJsonOnly.mockClear();
			mockLoadPlan.mockClear();
		});

		afterEach(async () => {
			// Restore original functions to _internals seam
			planManagerInternals.loadPlan = mockLoadPlan;
			planManagerInternals.loadPlanJsonOnly = mockLoadPlanJsonOnly;
			planManagerInternals.regeneratePlanMarkdown = mockRegeneratePlanMarkdown;
			if (worker) {
				worker.dispose();
				worker = null;
			}
			await cleanupTempDir();
		});

		// ============================================================
		// ATTACK VECTOR 1: MALFORMED TIMEOUT VALUES
		// ============================================================
		describe('ATTACK: Malformed timeout values', () => {
			test('should handle NaN syncTimeoutMs without crash (defaults gracefully)', async () => {
				await setupTempDir(true, true);

				// @ts-expect-error - Testing invalid input
				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: NaN, // Attack: NaN should not break timeout
				});

				// Worker should still function (NaN becomes truthy but setTimeout handles it)
				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger a sync
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'nan-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should remain operational
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle Infinity syncTimeoutMs (eternal timeout)', async () => {
				await setupTempDir(true, true);

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
					syncTimeoutMs: Infinity, // Attack: Infinity should work (no timeout)
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger sync - should complete successfully since no real timeout
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'infinity-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				expect(worker.getStatus()).toBe('running');
			});

			test('should handle negative syncTimeoutMs without crash', async () => {
				await setupTempDir(true, true);

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
					syncTimeoutMs: -5000, // Attack: negative should behave as immediate or default
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger sync
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'negative-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should survive negative timeout
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle zero syncTimeoutMs (immediate timeout)', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean; error?: Error }> = [];

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					await new Promise((resolve) => setTimeout(resolve, 50));
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
					syncTimeoutMs: 0, // Attack: zero should trigger immediate timeout
					onSyncComplete: (success, error) => {
						syncResults.push({ success, error });
					},
				});

				worker.start();

				// Trigger sync
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'zero-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should remain running (liveness preserved)
				expect(worker.getStatus()).toBe('running');

				// Zero timeout should trigger immediate timeout (or close to it)
				// Either way, the worker should not crash
			});

			test('should handle extremely large syncTimeoutMs (near MAX_SAFE_INTEGER)', async () => {
				await setupTempDir(true, true);

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
					syncTimeoutMs: Number.MAX_SAFE_INTEGER - 1, // Attack: near max int
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger sync - should complete normally
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'max-int-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				expect(worker.getStatus()).toBe('running');
			});

			test('should handle floating point syncTimeoutMs', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean; error?: Error }> = [];

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					await new Promise((resolve) => setTimeout(resolve, 100));
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
					syncTimeoutMs: 50.567, // Attack: floating point
					onSyncComplete: (success, error) => {
						syncResults.push({ success, error });
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'float-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 200));

				// Floating point should be coerced to integer by setTimeout
				expect(worker.getStatus()).toBe('running');
			});
		});

		// ============================================================
		// ATTACK VECTOR 2: HUNG PROMISE SIMULATION
		// ============================================================
		describe('ATTACK: Hung promise simulation', () => {
			test('should handle promise that never resolves (hung)', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean; error?: Error }> = [];

				// Create a promise that NEVER resolves
				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {
						// Intentionally never resolves - hangs forever
					});
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 100, // Short timeout to test safeguard
					onSyncComplete: (success, error) => {
						syncResults.push({ success, error });
					},
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger sync with hung promise
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'hung-promise' }),
				);

				// Wait for timeout to trigger
				await new Promise((resolve) => setTimeout(resolve, 200));

				// TIMEOUT SAFEGUARD: Worker should still be running despite hung promise
				expect(worker.getStatus()).toBe('running');

				// Timeout should have been triggered
				expect(syncResults.some((r) => r.success === false)).toBe(true);
				const timeoutError = syncResults.find(
					(r) => !r.success && r.error?.message.includes('timed out'),
				);
				expect(timeoutError).toBeDefined();
			});

			test('should handle promise that resolves after timeout', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean; error?: Error }> = [];
				let lateResolveCallback: (() => void) | null = null;

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise((resolve) => {
						lateResolveCallback = () =>
							resolve({
								schema_version: '1.0.0',
								title: 'Late Resolve',
								swarm: 'test-swarm',
								current_phase: 1,
								phases: [],
								migration_status: 'none',
							});
						// Never resolve on its own - will be resolved externally
					});
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 50, // Very short timeout
					onSyncComplete: (success, error) => {
						syncResults.push({ success, error });
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'late-resolve' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Timeout should have fired
				expect(syncResults.some((r) => r.success === false)).toBe(true);
				expect(worker.getStatus()).toBe('running');

				// Now resolve the promise LATE (after timeout)
				if (lateResolveCallback) {
					lateResolveCallback();
				}

				// Worker should still be stable
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle multiple hung promises sequentially', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean }> = [];
				let syncCount = 0;

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					syncCount++;
					// All syncs hang forever
					return new Promise(() => {});
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 50,
					onSyncComplete: (success) => {
						syncResults.push({ success });
					},
				});

				worker.start();

				// Trigger multiple hung syncs
				for (let i = 0; i < 5; i++) {
					await Bun.write(
						planJsonPath,
						JSON.stringify({ attack: `hung-${i}` }),
					);
					await new Promise((resolve) => setTimeout(resolve, 100));
				}

				// Worker should survive all hung promises
				expect(worker.getStatus()).toBe('running');

				// All should have timed out
				expect(syncResults.every((r) => r.success === false)).toBe(true);
			});

			test('should handle promise that throws synchronously in constructor', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean; error?: Error }> = [];

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					throw new Error('Synchronous throw in async function');
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 5000,
					onSyncComplete: (success, error) => {
						syncResults.push({ success, error });
					},
				});

				worker.start();

				await Bun.write(planJsonPath, JSON.stringify({ attack: 'sync-throw' }));
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Error should be caught, not hung
				expect(syncResults.some((r) => r.success === false)).toBe(true);
				expect(worker.getStatus()).toBe('running');
			});
		});

		// ============================================================
		// ATTACK VECTOR 3: CALLBACK EXCEPTION ABUSE
		// ============================================================
		describe('ATTACK: Callback exception abuse', () => {
			test('should handle onSyncComplete throwing error on success', async () => {
				await setupTempDir(true, true);

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
					syncTimeoutMs: 5000,
					onSyncComplete: () => {
						throw new Error('Malicious callback exception on success');
					},
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger sync - callback will throw
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'callback-throw-success' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should survive callback exception
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle onSyncComplete throwing error on timeout', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 50,
					onSyncComplete: () => {
						throw new Error('Malicious callback exception on timeout');
					},
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Trigger sync - will timeout and callback will throw
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'callback-throw-timeout' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 150));

				// Worker should survive callback exception during timeout handling
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle onSyncComplete throwing on sync failure', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					throw new Error('Sync failed intentionally');
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 5000,
					onSyncComplete: () => {
						throw new Error('Malicious callback exception on failure');
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'callback-throw-failure' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should survive the double-fault (sync failure + callback exception)
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle onSyncComplete that disposes worker', async () => {
				await setupTempDir(true, true);

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
					syncTimeoutMs: 5000,
					onSyncComplete: () => {
						// Attack: callback tries to dispose the worker
						worker?.dispose();
					},
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'callback-dispose' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should be disposed (stopped) after callback
				expect(worker.getStatus()).toBe('stopped');
			});

			test('should handle onSyncComplete that calls stop then start', async () => {
				await setupTempDir(true, true);

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
					syncTimeoutMs: 5000,
					onSyncComplete: () => {
						// Attack: rapid stop/start cycle in callback
						worker?.stop();
						worker?.start();
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'callback-stop-start' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should end up running (last start wins)
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle onSyncComplete with stack overflow attempt', async () => {
				await setupTempDir(true, true);

				let callDepth = 0;
				const maxDepth = { value: 0 };

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
					syncTimeoutMs: 5000,
					onSyncComplete: () => {
						callDepth++;
						maxDepth.value = Math.max(maxDepth.value, callDepth);
						// Recursive call (won't actually recurse infinitely due to debounce)
						if (callDepth < 10) {
							worker?.start(); // Attempt to trigger more syncs
						}
						callDepth--;
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'stack-overflow' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Worker should survive without stack overflow
				expect(worker.getStatus()).toBe('running');
			});
		});

		// ============================================================
		// ATTACK VECTOR 4: LIFECYCLE RACE ATTACKS AROUND TIMEOUT BOUNDARIES
		// ============================================================
		describe('ATTACK: Lifecycle race attacks around timeout boundaries', () => {
			test('should handle stop() called exactly at timeout moment', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean }> = [];
				const timeout = 80;

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: timeout,
					onSyncComplete: (success) => {
						syncResults.push({ success });
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'race-stop-at-timeout' }),
				);

				// Wait until just before timeout, then call stop
				await new Promise((resolve) => setTimeout(resolve, timeout - 10));
				worker.stop();

				// Wait for what would have been timeout
				await new Promise((resolve) => setTimeout(resolve, 50));

				// Worker should be stopped cleanly
				expect(worker.getStatus()).toBe('stopped');
			});

			test('should handle dispose() called during timeout handling', async () => {
				await setupTempDir(true, true);

				let callbackInvoked = false;

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 50,
					onSyncComplete: () => {
						callbackInvoked = true;
						// Attack: dispose during callback
						worker?.dispose();
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'dispose-in-callback' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 150));

				expect(callbackInvoked).toBe(true);
				expect(worker.getStatus()).toBe('stopped');
			});

			test('should handle rapid start/stop during timeout countdown', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 5,
					syncTimeoutMs: 100,
				});

				worker.start();

				// Trigger sync
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'rapid-cycle' }),
				);

				// Rapid start/stop cycles during timeout
				for (let i = 0; i < 20; i++) {
					worker.stop();
					worker.start();
					await new Promise((resolve) => setTimeout(resolve, 2));
				}

				// Should end in consistent state
				expect(['running', 'stopped']).toContain(worker.getStatus());
			});

			test('should handle stop() immediately after timeout fires', async () => {
				await setupTempDir(true, true);

				const syncResults: Array<{ success: boolean }> = [];

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 50,
					onSyncComplete: (success) => {
						syncResults.push({ success });
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'stop-after-timeout' }),
				);

				// Wait for timeout to fire (with buffer for async operations)
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Now stop after timeout has definitely fired
				worker.stop();

				// Timeout should have fired, worker now stopped
				expect(syncResults.some((r) => r.success === false)).toBe(true);
				expect(worker.getStatus()).toBe('stopped');
			});

			test('should handle dispose during pending sync timeout', async () => {
				await setupTempDir(true, true);

				let firstSyncStarted = false;
				let resolveFirstSync: () => void;

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					firstSyncStarted = true;
					await new Promise<void>((resolve) => {
						resolveFirstSync = resolve;
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
					syncTimeoutMs: 1000,
				});

				worker.start();

				// Trigger first sync
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'dispose-pending' }),
				);

				// Wait for first sync to start
				await new Promise((resolve) => setTimeout(resolve, 30));

				// Trigger second sync (will be pending)
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'dispose-pending-2' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 10));

				// Dispose while first is running and second is pending
				worker.dispose();

				// Resolve first sync (should be ignored due to dispose)
				if (resolveFirstSync) {
					resolveFirstSync();
				}

				await new Promise((resolve) => setTimeout(resolve, 50));

				expect(worker.getStatus()).toBe('stopped');
			});

			test('should handle start() during timeout callback execution', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				let callbackCount = 0;

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 5,
					syncTimeoutMs: 50,
					onSyncComplete: () => {
						callbackCount++;
						// Attack: try to start during callback (should be idempotent)
						worker?.start();
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'start-in-timeout-callback' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 150));

				// Worker should still be running
				expect(worker.getStatus()).toBe('running');
				expect(callbackCount).toBeGreaterThanOrEqual(1);
			});

			test('should handle timeout during status transition (starting/stopping)', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Hung promise
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 5,
					syncTimeoutMs: 30,
				});

				// Start
				worker.start();

				// Trigger sync
				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'timeout-during-transition' }),
				);

				// Immediately trigger stop during sync
				await new Promise((resolve) => setTimeout(resolve, 5));
				worker.stop();

				// Wait for what would be timeout
				await new Promise((resolve) => setTimeout(resolve, 100));

				// Should be stopped cleanly
				expect(worker.getStatus()).toBe('stopped');
			});

			test('should handle multiple timeouts with overlapping syncs', async () => {
				await setupTempDir(true, true);

				const timeoutCount = { value: 0 };

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise(() => {}); // Always hang
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 5,
					syncTimeoutMs: 40,
					onSyncComplete: (success) => {
						if (!success) timeoutCount.value++;
					},
				});

				worker.start();

				// Trigger multiple syncs that will all timeout
				for (let i = 0; i < 5; i++) {
					await Bun.write(
						planJsonPath,
						JSON.stringify({ attack: `overlap-${i}` }),
					);
					await new Promise((resolve) => setTimeout(resolve, 30));
				}

				// Wait for all timeouts
				await new Promise((resolve) => setTimeout(resolve, 200));

				// Worker should survive multiple overlapping timeouts
				expect(worker.getStatus()).toBe('running');
				expect(timeoutCount.value).toBeGreaterThanOrEqual(2);
			});
		});

		// ============================================================
		// ATTACK VECTOR 5: TIMEOUT ABUSE - EDGE CASES
		// ============================================================
		describe('ATTACK: Timeout abuse edge cases', () => {
			test('should not allow timeout bypass via rapid file changes', async () => {
				await setupTempDir(true, true);

				let syncCount = 0;
				let maxConcurrent = 0;

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					syncCount++;
					maxConcurrent = Math.max(maxConcurrent, syncCount);
					await new Promise((resolve) => setTimeout(resolve, 200)); // Slow sync
					syncCount--;
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
					syncTimeoutMs: 5000, // Long timeout
				});

				worker.start();

				// Rapid file changes to try to bypass timeout/overlap protection
				const promises = [];
				for (let i = 0; i < 50; i++) {
					promises.push(Bun.write(planJsonPath, JSON.stringify({ bypass: i })));
				}
				await Promise.all(promises);

				await new Promise((resolve) => setTimeout(resolve, 500));

				// Max concurrent should never exceed 1 (in-flight guard)
				expect(maxConcurrent).toBeLessThanOrEqual(1);
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle timeout with cleanup race (timer vs promise)', async () => {
				await setupTempDir(true, true);

				const events: string[] = [];

				mockLoadPlanJsonOnly.mockImplementation(async () => {
					events.push('sync-start');
					await new Promise((resolve) => setTimeout(resolve, 100));
					events.push('sync-end');
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
					syncTimeoutMs: 50, // Shorter than sync duration
					onSyncComplete: (success) => {
						events.push(success ? 'callback-success' : 'callback-timeout');
					},
				});

				worker.start();

				await Bun.write(planJsonPath, JSON.stringify({ attack: 'timer-race' }));
				await new Promise((resolve) => setTimeout(resolve, 200));

				// Timeout should fire, callback should indicate timeout
				expect(events).toContain('callback-timeout');
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle timeout value mutation after construction', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => ({
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}));

				// Options object that could be mutated externally
				const options: PlanSyncWorkerOptions = {
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: 5000,
				};

				worker = new PlanSyncWorker(options);

				// Mutate options after construction (attack)
				options.syncTimeoutMs = 1;

				worker.start();
				expect(worker.getStatus()).toBe('running');

				// Worker should use original timeout, not mutated value
				await Bun.write(planJsonPath, JSON.stringify({ attack: 'mutation' }));
				await new Promise((resolve) => setTimeout(resolve, 100));

				expect(worker.getStatus()).toBe('running');
			});

			test('should handle Symbol timeout value (extreme edge case)', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => ({
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}));

				// @ts-expect-error - Testing extreme edge case
				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: Symbol('timeout'), // Attack: symbol instead of number
				});

				// Should not crash - Symbol coerces or defaults
				worker.start();
				expect(['running', 'stopped']).toContain(worker.getStatus());
			});

			test('should handle null/undefined syncTimeoutMs', async () => {
				await setupTempDir(true, true);

				mockLoadPlanJsonOnly.mockImplementation(async () => ({
					schema_version: '1.0.0',
					title: 'Test Plan',
					swarm: 'test-swarm',
					current_phase: 1,
					phases: [],
					migration_status: 'none',
				}));

				// Test null
				// @ts-expect-error - Testing invalid input
				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: null,
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');
				worker.dispose();

				// Test undefined (should use default)
				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 10,
					syncTimeoutMs: undefined,
				});

				worker.start();
				expect(worker.getStatus()).toBe('running');
			});

			test('should handle timeout with promise rejection vs resolve race', async () => {
				await setupTempDir(true, true);

				const events: string[] = [];

				// Promise that races between reject (timeout) and resolve
				mockLoadPlanJsonOnly.mockImplementation(async () => {
					return new Promise((resolve, reject) => {
						const resolveTimer = setTimeout(() => {
							events.push('resolve');
							resolve({
								schema_version: '1.0.0',
								title: 'Test Plan',
								swarm: 'test-swarm',
								current_phase: 1,
								phases: [],
								migration_status: 'none',
							});
						}, 80);

						const rejectTimer = setTimeout(() => {
							events.push('reject');
							reject(new Error('Manual rejection'));
						}, 60);

						// Clear the other timer when one fires
						// This simulates a race condition
					});
				});

				worker = new PlanSyncWorker({
					directory: tempDir,
					debounceMs: 5,
					syncTimeoutMs: 100,
					onSyncComplete: (success) => {
						events.push(success ? 'success' : 'failure');
					},
				});

				worker.start();

				await Bun.write(
					planJsonPath,
					JSON.stringify({ attack: 'reject-resolve-race' }),
				);
				await new Promise((resolve) => setTimeout(resolve, 200));

				// Worker should survive race condition
				expect(worker.getStatus()).toBe('running');
			});
		});
	},
);

/**
 * ADVERSARIAL SECURITY TESTS for Task 3.6 Safeguards — Timeout abuse edge
 * cases (ATTACK VECTOR 5).
 *
 * Split from tests/unit/background/plan-sync-worker.adversarial.test.ts
 * (FR-006 file cap). Same vectors, same fixtures, same r15 seam-isolation
 * contract: the timeout edge cases include the reject-resolve race, whose
 * timers are tracked and cleared so no racing timer leaks into later test
 * files in the same process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	PlanSyncWorker,
	type PlanSyncWorkerOptions,
} from '../../../src/background/plan-sync-worker';
import { _internals as planManagerInternals } from '../../../src/plan/manager';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Within-module DI seam: mock functions are assigned to _internals
const mockLoadPlan = mock(async () => null);
const mockLoadPlanJsonOnly = mock(async () => null);
const mockRegeneratePlanMarkdown = mock(async () => {});
const planSyncWorkerPrototype = PlanSyncWorker.prototype as unknown as {
	start: () => void;
	setupNativeWatcher: () => boolean;
};
const originalStart = planSyncWorkerPrototype.start;
const originalSetupNativeWatcher = planSyncWorkerPrototype.setupNativeWatcher;

// r15 audit repair (Phase 6 — test isolation): snapshot of the seam's
// ORIGINALS (the same §7/RC-3/#2305 pattern plan-sync-worker.test.ts uses).
// The previous afterEach RE-INSTALLED the mocks instead of restoring the
// originals (its comment claimed "Restore original functions"), so the LAST
// test's mockImplementation leaked process-wide: every later test file's
// loadPlanJsonOnly call hit the "reject-resolve-race" implementation and
// failed with "Manual rejection" ~60 ms later (15+ full-suite failures in
// the WAL-transfer suite, the context-map release suite, and others).
const seamSnapshot = { ...planManagerInternals };

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
			// F-010: clock-free unique name (same rationale as
			// plan-sync-worker-unref.test.ts). The wall-clock timestamp this
			// replaced was a uniqueness source, not a time-dependent assertion;
			// `freezeClock` would be the wrong tool because a frozen clock makes
			// "unique" names collide across tests, runs and processes.
			tempDir = canonicalMkdtemp(`.test-adversarial-${randomUUID()}`);
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
			// These tests exercise timeout/liveness behavior, not native fs.watch.
			// Force the polling path so prior Linux watcher churn in the same CI shard
			// cannot leave this file with non-deterministic native watcher handles.
			planSyncWorkerPrototype.setupNativeWatcher = () => false;
			planSyncWorkerPrototype.start = function (this: unknown) {
				(this as { pollIntervalMs: number }).pollIntervalMs = 10;
				return originalStart.call(this);
			};

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
			planSyncWorkerPrototype.start = originalStart;
			planSyncWorkerPrototype.setupNativeWatcher = originalSetupNativeWatcher;
			// r15 (Phase 6): restore the seam's ORIGINALS (the previous code
			// re-installed the mocks here, leaking the last test's
			// implementation process-wide). Reset the mock implementations to
			// their benign defaults first so even a later re-install of the
			// same mock objects cannot replay a stale racing implementation.
			mockLoadPlanJsonOnly.mockImplementation(async () => null);
			mockLoadPlan.mockImplementation(async () => null);
			mockRegeneratePlanMarkdown.mockImplementation(async () => {});
			mockLoadPlanJsonOnly.mockClear();
			mockLoadPlan.mockClear();
			mockRegeneratePlanMarkdown.mockClear();
			Object.assign(planManagerInternals, seamSnapshot);
			if (worker) {
				worker.dispose();
				worker = null;
			}
			await cleanupTempDir();
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
				// r15 (Phase 6): every timer created by the racing
				// implementation is tracked and cleared at test end — an
				// uncleared 60/80 ms timer from the worker's LAST poll (10 ms
				// interval) would otherwise fire into the NEXT test file's
				// promises in the same process.
				const raceTimers: ReturnType<typeof setTimeout>[] = [];

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
						raceTimers.push(resolveTimer);

						const rejectTimer = setTimeout(() => {
							events.push('reject');
							reject(new Error('Manual rejection'));
						}, 60);
						raceTimers.push(rejectTimer);

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
				// Leave no racing timer behind for later test files.
				for (const timer of raceTimers) clearTimeout(timer);
			});
		});
	},
);

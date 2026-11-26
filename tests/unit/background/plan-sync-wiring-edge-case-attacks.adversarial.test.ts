/**
 * ADVERSARIAL TESTS: PlanSyncWorker Edge Case Attack Vectors
 *
 * Split from tests/unit/background/plan-sync-wiring-adversarial.test.ts
 * (FR-006 file cap). These vectors attack PlanSyncWorker robustness
 * directly: extreme values, callback abuse, and memory pressure — the
 * same r15 seam-isolation contract as the parent suite.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PlanSyncWorker } from '../../../src/background/plan-sync-worker';
import { _internals as planManagerInternals } from '../../../src/plan/manager';

// Within-module DI seam: mock functions assigned to _internals
const mockLoadPlan = mock(async () => null);

// r15 audit repair (Phase 6 — test isolation): snapshot of the seam's
// ORIGINALS. The afterEach blocks previously RE-INSTALLED the mock
// instead of restoring the originals (their comments claimed "Restore
// mocks"), leaving loadPlan mocked process-wide after this file — a
// deterministic polluter for later-running test files (the context-map
// release suite's update_task_status failed with it).
const planManagerSeamSnapshot = { ...planManagerInternals };

/** r15 (Phase 6): restore the seam's REAL originals. */
function restoreSeam(): void {
	mockLoadPlan.mockImplementation(async () => null);
	mockLoadPlan.mockClear();
	Object.assign(planManagerInternals, planManagerSeamSnapshot);
}

// Helper to install mocks onto _internals seam
function installMocks(): void {
	planManagerInternals.loadPlan = mockLoadPlan;
}

// Helper to reset mock state
function resetMockState(): void {
	// Reset mock implementation to fast no-op to avoid test interference
	mockLoadPlan.mockImplementation(async () => null);
	mockLoadPlan.mockClear();
}

describe('ADVERSARIAL: Edge Case Attack Vectors', () => {
	beforeEach(() => {
		installMocks();
		resetMockState();
	});

	afterEach(() => {
		// r15 (Phase 6): restore the seam's REAL originals.
		restoreSeam();
	});

	describe('Extreme value attacks', () => {
		test('extremely long directory path', async () => {
			// Create a very long path (but still valid on most systems)
			const longPath = path.join(process.cwd(), 'a'.repeat(100));

			// Constructor should not crash
			const worker = new PlanSyncWorker({ directory: longPath });
			expect(worker).toBeDefined();
			worker.dispose();
		});

		test('directory path with special characters', async () => {
			// Path with spaces and special chars
			// F-010: clock-free unique name. The wall-clock timestamp this
			// replaced was only ever a uniqueness source (same for every
			// `randomUUID()` directory below), not a time-dependent assertion, so
			// `freezeClock` would be the wrong tool — a frozen clock makes
			// "unique" names collide across tests, runs and processes.
			const specialPath = path.join(process.cwd(), `test-dir-${randomUUID()}`);

			const worker = new PlanSyncWorker({ directory: specialPath });
			expect(worker).toBeDefined();
			worker.dispose();
		});
	});

	describe('Callback abuse', () => {
		test('onSyncComplete callback throwing does not crash worker', async () => {
			const localTempDir = path.join(
				process.cwd(),
				`.test-callback-${randomUUID()}`,
			);

			const worker = new PlanSyncWorker({
				directory: localTempDir,
				debounceMs: 10,
				pollIntervalMs: 20,
				onSyncComplete: () => {
					throw new Error('Callback error');
				},
			});

			// Start should succeed even with throwing callback
			worker.start();
			expect(worker.getStatus()).toBe('running');

			// Wait briefly
			await Bun.sleep(50);

			// Worker should still be running (callback errors are caught internally)
			expect(worker.getStatus()).toBe('running');

			worker.dispose();

			// Cleanup
			try {
				fs.rmSync?.(localTempDir, { recursive: true, force: true });
			} catch {}
		});

		test('onSyncComplete callback null does not crash', async () => {
			const localTempDir = path.join(
				process.cwd(),
				`.test-null-cb-${randomUUID()}`,
			);

			const worker = new PlanSyncWorker({
				directory: localTempDir,
				onSyncComplete: null as any, // Intentionally null
			});

			expect(worker).toBeDefined();
			worker.dispose();
		});
	});

	describe('Memory pressure simulation', () => {
		test('rapid create/dispose cycles', async () => {
			const localTempDir = path.join(
				process.cwd(),
				`.test-memory-${randomUUID()}`,
			);

			// Create and dispose many workers rapidly
			for (let i = 0; i < 20; i++) {
				const worker = new PlanSyncWorker({ directory: localTempDir });
				worker.start();
				worker.dispose();
			}

			// Reaching this line without a throw IS the assertion: 20 rapid
			// construct/start/dispose cycles completed. Marked, because there is no
			// value to assert beyond non-throw (vacuous-assertion ratchet, #2903).
			const completedAllCycles = true;
			expect(completedAllCycles).toBe(true); // vacuous-ok: non-throw survival probe

			// Cleanup
			try {
				fs.rmSync?.(localTempDir, { recursive: true, force: true });
			} catch {}
		});
	});
});

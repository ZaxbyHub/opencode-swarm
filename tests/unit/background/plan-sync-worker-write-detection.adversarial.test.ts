import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PlanSyncWorker } from '../../../src/background/plan-sync-worker';

// Track log calls for testing
const logCalls: { message: string; data?: unknown }[] = [];

// Import _internals seam for plan/manager (within-module)
import { _internals as planManagerInternals } from '../../../src/plan/manager';

// r15 audit repair (Phase 6 — test isolation): same defect and same fix as
// plan-sync-worker-write-detection.test.ts — the previous top-level
// mock.module('../../../src/utils') replaced the whole utils module with
// ONLY log/warn/error (every other export undefined process-wide from
// Bun's test-file preloading onward). The mock is now per-test
// (beforeEach/afterEach) and the REAL module snapshot is re-installed after
// each test (mock.restore() does NOT undo mock.module).
import * as realUtilsModule from '../../../src/utils';

const utilsSnapshot = { ...realUtilsModule };
const planManagerSeamSnapshot = { ...planManagerInternals };

// Within-module DI seam: mock functions assigned to _internals
const mockLoadPlan = mock(async () => null);

// Helper to create temp directory structure
function setupTempDir(): {
	tempDir: string;
	swarmDir: string;
	planJsonPath: string;
	markerPath: string;
} {
	const tempDir = path.join(
		tmpdir(),
		`.test-unauthorized-write-adversarial-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	const swarmDir = path.join(tempDir, '.swarm');
	const planJsonPath = path.join(swarmDir, 'plan.json');
	const markerPath = path.join(swarmDir, '.plan-write-marker');

	// Create directories
	fs.mkdirSync(swarmDir, { recursive: true });

	// Create a basic .gitkeep to ensure directory exists
	fs.writeFileSync(path.join(tempDir, '.gitkeep'), '');
	fs.writeFileSync(path.join(swarmDir, '.gitkeep'), '');

	return { tempDir, swarmDir, planJsonPath, markerPath };
}

// Helper to clean up temp directory
function cleanupTempDir(tempDir: string): void {
	if (tempDir) {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

// Helper to create a valid plan.json
function createPlanJson(planJsonPath: string): void {
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

describe('checkForUnauthorizedWrite - ADVERSARIAL TESTS', () => {
	let tempDir: string;
	let swarmDir: string;
	let planJsonPath: string;
	let markerPath: string;

	beforeEach(() => {
		// Install mock functions onto _internals seam for plan/manager
		planManagerInternals.loadPlan = mockLoadPlan;
		// Per-test cross-module mock (r15 Phase 6): installed HERE, not at
		// file top level, so Bun's test-file preloading cannot leak it into
		// earlier-running test files.
		mock.module('../../../src/utils', () => ({
			...utilsSnapshot,
			log: (message: string, data?: unknown) => {
				logCalls.push({ message, data });
			},
			warn: (message: string, data?: unknown) => {
				// Also track warns
				logCalls.push({ message, data });
			},
			error: () => {}, // Don't track errors
		}));

		const dirs = setupTempDir();
		tempDir = dirs.tempDir;
		swarmDir = dirs.swarmDir;
		planJsonPath = dirs.planJsonPath;
		markerPath = dirs.markerPath;
		// Clear log calls before each test
		logCalls.length = 0;
		mockLoadPlan.mockClear();
	});

	afterEach(() => {
		// r15 (Phase 6): restore the REAL utils module and the plan-manager
		// seam's originals (the previous code re-installed the mock here).
		mock.module('../../../src/utils', () => ({ ...utilsSnapshot }));
		Object.assign(planManagerInternals, planManagerSeamSnapshot);
		mockLoadPlan.mockImplementation(async () => null);
		mockLoadPlan.mockClear();
		mock.restore(); // Clean up function mocks
		cleanupTempDir(tempDir);
	});

	describe('ADVERSARY 1: Marker with malicious timestamp - "not-a-date"', () => {
		test('should NOT log warning when marker timestamp is invalid (NaN)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with malicious timestamp: "not-a-date"
			// new Date("not-a-date").getTime() returns NaN
			// Comparison: planMtime > NaN + 5000 is false
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: 'not-a-date',
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT have logged any warning about unauthorized write
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('ADVERSARY 2: Marker with extreme future timestamp (100 years)', () => {
		test('should NOT log warning when marker has extreme future timestamp', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Get current plan.json mtime
			const planStats = fs.statSync(planJsonPath);

			// Create marker with timestamp 100 years in the future
			// This simulates an attacker trying to suppress the warning
			const futureDate = new Date(
				planStats.mtimeMs + 100 * 365 * 24 * 60 * 60 * 1000,
			);
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: futureDate.toISOString(),
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT log warning (plan.json mtime is always less than 100 years in future)
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('ADVERSARY 3: Marker with missing timestamp field', () => {
		test('should NOT log warning when marker has no timestamp field', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with missing timestamp field
			// new Date(undefined).getTime() returns NaN
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT log warning
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('ADVERSARY 4: Marker with null timestamp', () => {
		test('SHOULD log warning when marker has null timestamp (expected behavior)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with null timestamp
			// new Date(null).getTime() returns 0
			// So any plan.json with mtime > 5000 will trigger warning
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: null,
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// SHOULD log warning because new Date(null).getTime() = 0
			// and plan.json mtime (current time) > 5000
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(1);
			expect(warningCalls[0].message).toContain(
				'unauthorized direct write suspected',
			);
		});

		test('documenting expected behavior: null timestamp means marker has no valid time, so any real plan mtime triggers warning', () => {
			// Verify the underlying behavior: new Date(null).getTime() returns 0
			expect(new Date(null).getTime()).toBe(0);
			expect(new Date(0).getTime()).toBe(0);

			// Current timestamp is always > 5000 (we're past 1970)
			const currentTime = Date.now();
			expect(currentTime).toBeGreaterThan(5000);

			// Therefore: currentTime > 0 + 5000 = currentTime > 5000 = true
			expect(currentTime > 0 + 5000).toBe(true);
		});
	});

	describe('ADVERSARY 5: Empty marker file', () => {
		test('should NOT log warning when marker file is empty string', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create empty marker file (empty string)
			// JSON.parse("") throws: Unexpected end of JSON input
			fs.writeFileSync(markerPath, '');

			// Call the method - should NOT throw (caught by try/catch)
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT log warning (caught silently)
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('ADVERSARY 6: Oversized marker file (1MB)', () => {
		test('should NOT log warning when marker file is 1MB of random data', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with 1MB of random data
			// JSON.parse will fail, but should be caught silently
			const randomData = 'x'.repeat(1024 * 1024); // 1MB
			fs.writeFileSync(markerPath, randomData);

			// Call the method - should NOT throw (caught by try/catch)
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT log warning (caught silently)
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('ADVERSARY 7: Concurrent calls to checkForUnauthorizedWrite', () => {
		test('should complete without error when two concurrent calls on same instance', async () => {
			// Create plan.json with a marker
			createPlanJson(planJsonPath);
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: new Date().toISOString(),
					source: 'save_plan',
				}),
			);

			const worker = new PlanSyncWorker({ directory: tempDir });

			// Execute two concurrent calls
			const call1 = () => (worker as any).checkForUnauthorizedWrite();
			const call2 = () => (worker as any).checkForUnauthorizedWrite();

			// Both should complete without error (no shared mutable state)
			expect(call1).not.toThrow();
			expect(call2).not.toThrow();

			// Run them truly concurrently using Promise.all
			await expect(
				Promise.all([
					Promise.resolve((worker as any).checkForUnauthorizedWrite()),
					Promise.resolve((worker as any).checkForUnauthorizedWrite()),
				]),
			).resolves.toBeDefined();
		});

		test('should complete without error when multiple concurrent calls on different instances', async () => {
			// Create plan.json and marker
			createPlanJson(planJsonPath);
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: new Date().toISOString(),
					source: 'save_plan',
				}),
			);

			const worker1 = new PlanSyncWorker({ directory: tempDir });
			const worker2 = new PlanSyncWorker({ directory: tempDir });

			// Execute concurrent calls on different instances
			await expect(
				Promise.all([
					Promise.resolve((worker1 as any).checkForUnauthorizedWrite()),
					Promise.resolve((worker2 as any).checkForUnauthorizedWrite()),
				]),
			).resolves.toBeDefined();

			// Both should complete without error
			expect(() => (worker1 as any).checkForUnauthorizedWrite()).not.toThrow();
			expect(() => (worker2 as any).checkForUnauthorizedWrite()).not.toThrow();
		});
	});
});

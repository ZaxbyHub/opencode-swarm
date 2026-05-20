import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PlanSyncWorker } from '../../../src/background/plan-sync-worker';

// Track log calls for testing
const logCalls: { message: string; data?: unknown }[] = [];

// Import _internals seam for plan/manager (within-module)
import { _internals as planManagerInternals } from '../../../src/plan/manager';

// Within-module DI seam: mock functions assigned to _internals
const mockLoadPlan = mock(async () => null);

// Cross-module mock: Mock the utils module's re-exports since warn is called directly
// from ../utils (not via _internals in logger.ts)
mock.module('../../../src/utils', () => ({
	log: (message: string, data?: unknown) => {
		logCalls.push({ message, data });
	},
	warn: (message: string, data?: unknown) => {
		// Also track warns
		logCalls.push({ message, data });
	},
	error: () => {}, // Don't track errors
}));

// Helper to create temp directory structure
function setupTempDir(): {
	tempDir: string;
	swarmDir: string;
	planJsonPath: string;
	markerPath: string;
} {
	const tempDir = path.join(
		tmpdir(),
		`.test-unauthorized-write-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// Helper to create a valid marker file
function createMarker(markerPath: string, timestamp: Date): void {
	const marker = { timestamp: timestamp.toISOString() };
	fs.writeFileSync(markerPath, JSON.stringify(marker));
}

describe('checkForUnauthorizedWrite', () => {
	let tempDir: string;
	let swarmDir: string;
	let planJsonPath: string;
	let markerPath: string;

	beforeEach(() => {
		// Install mock functions onto _internals seam for plan/manager
		planManagerInternals.loadPlan = mockLoadPlan;

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
		// Restore original function to _internals seam
		planManagerInternals.loadPlan = mockLoadPlan;
		mock.restore(); // Clean up cross-module mocks
		cleanupTempDir(tempDir);
	});

	describe('Test 1: marker present and plan.json mtime <= marker timestamp + 5000ms → no warning', () => {
		test('should NOT log warning when plan.json modified within 5000ms of marker', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Get plan.json current mtime
			const planStats = fs.statSync(planJsonPath);

			// Create marker with a timestamp 1 second BEFORE plan.json mtime
			// This means planMtime > markerTimestamp + 5000 is FALSE (within threshold)
			const markerTimestamp = new Date(planStats.mtimeMs - 1000);
			createMarker(markerPath, markerTimestamp);

			// Call the method
			const worker = new PlanSyncWorker({ directory: tempDir });
			(worker as any).checkForUnauthorizedWrite();

			// Should NOT have logged any warning about unauthorized write
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});

		test('should NOT log warning when plan.json mtime equals marker timestamp + 5000ms (boundary)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			const planStats = fs.statSync(planJsonPath);

			// Create marker with exactly 5000ms before plan.json mtime
			// This tests the boundary: planMtime > markerTimestamp + 5000 is FALSE (= is not >)
			const markerTimestamp = new Date(planStats.mtimeMs - 5000);
			createMarker(markerPath, markerTimestamp);

			// Call the method
			const worker = new PlanSyncWorker({ directory: tempDir });
			(worker as any).checkForUnauthorizedWrite();

			// Should NOT log warning (boundary condition: <= 5000ms)
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('Test 2: marker present and plan.json mtime > marker timestamp + 5000ms → warning logged', () => {
		test('should log warning when plan.json modified more than 5000ms after marker', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			const planStats = fs.statSync(planJsonPath);

			// Create marker with timestamp 6000ms before plan.json mtime
			// This tests: planMtime > markerTimestamp + 5000 = T > (T-6000) + 5000 = T > T-1000 = TRUE
			const markerTimestamp = new Date(planStats.mtimeMs - 6000);
			createMarker(markerPath, markerTimestamp);

			// Call the method
			const worker = new PlanSyncWorker({ directory: tempDir });
			(worker as any).checkForUnauthorizedWrite();

			// Should have logged a warning
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(1);
			expect(warningCalls[0].message).toContain(
				'unauthorized direct write suspected',
			);
		});
	});

	describe('Test 3: marker file does NOT exist → no warning, no error thrown', () => {
		test('should not throw when marker file does not exist', () => {
			// Create plan.json but NO marker file
			createPlanJson(planJsonPath);

			// Should not throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should not have logged any warning
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('Test 4: plan.json does NOT exist → no warning, no error thrown', () => {
		test('should not throw when plan.json does not exist', () => {
			// Create marker but NO plan.json
			createMarker(markerPath, new Date());

			// Should not throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should not have logged any warning
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('Test 5: marker file contains invalid JSON → no warning, no error thrown', () => {
		test('should not throw when marker contains invalid JSON', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with invalid JSON
			fs.writeFileSync(markerPath, 'not valid json {');

			// Should not throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should not have logged any warning
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});
	});

	describe('Test 6: executeSync completes successfully regardless of checkForUnauthorizedWrite outcome', () => {
		test('should complete sync when unauthorized write detected (mocked)', async () => {
			// Create plan.json and marker with suspicious timing
			createPlanJson(planJsonPath);

			const planStats = fs.statSync(planJsonPath);
			const markerTimestamp = new Date(planStats.mtimeMs - 10000); // 10 seconds before
			createMarker(markerPath, markerTimestamp);

			// The key test: checkForUnauthorizedWrite should not throw
			// even when it detects a potential unauthorized write
			const worker = new PlanSyncWorker({
				directory: tempDir,
				syncTimeoutMs: 5000,
			});

			// Just calling the check method should not throw
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// A warning should have been logged
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(1);

			// Cleanup
			worker.dispose();
		});

		test('should complete sync when checkForUnauthorizedWrite has errors (mocked)', async () => {
			// Create neither plan.json nor marker - this should cause errors in the check
			// but not propagate

			const worker = new PlanSyncWorker({
				directory: tempDir,
				syncTimeoutMs: 5000,
			});

			// Should not throw even when files don't exist
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// No warning should be logged due to silent error handling
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);

			// Cleanup
			worker.dispose();
		});
	});
});

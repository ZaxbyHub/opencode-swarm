			/** * ADVERSARIAL TESTS: checkForUnauthorizedWrite — marker type edge cases. * * Split from tests/unit/background/plan-sync-worker-write-detection.adversarial.test.ts * (FR-006 file cap). The ADDITIONAL EDGE CASES vectors (timestamp field * type-confusion attacks) run with the same r15 isolation contract: the * utils mock is installed per-test and the REAL utils module plus the * plan-manager seam's originals are restored after every test. */ import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'; import { randomUUID } from 'node:crypto'; import * as fs from 'node:fs'; import { tmpdir } from 'node:os'; import * as path from 'node:path'; import { PlanSyncWorker } from '../../../src/background/plan-sync-worker'; // Track log calls for testing const logCalls: { message: string; data?: unknown }[] = []; // Import _internals seam for plan/manager (within-module) import { _internals as planManagerInternals } from '../../../src/plan/manager'; // r15 audit repair (Phase 6 — test isolation): same defect and same fix as // plan-sync-worker-write-detection.test.ts — the previous top-level // mock.module('../../../src/utils') replaced the whole utils module with // ONLY log/warn/error (every other export undefined process-wide from // Bun's test-file preloading onward). The mock is now per-test // (beforeEach/afterEach) and the REAL module snapshot is re-installed after // each test (mock.restore() does NOT undo mock.module). import * as realUtilsModule from '../../../src/utils'; const utilsSnapshot = { ...realUtilsModule }; const planManagerSeamSnapshot = { ...planManagerInternals }; // Within-module DI seam: mock functions assigned to _internals const mockLoadPlan = mock(async () => null); // Helper to create temp directory structure function setupTempDir(): { tempDir: string; swarmDir: string; planJsonPath: string; markerPath: string; } { // F-010: clock-free unique name (same rationale as // plan-sync-worker-unref.test.ts). The wall-clock timestamp this replaced // was a uniqueness source, not a time-dependent assertion; `freezeClock` // would be the wrong tool because a frozen clock makes "unique" names // collide across tests, runs and processes. const tempDir = path.join( tmpdir(), `.test-unauthorized-write-adversarial-${randomUUID()}`, ));

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
	describe('ADDITIONAL EDGE CASES', () => {
		test('marker with undefined timestamp field (JSON.stringify)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with timestamp set to undefined via JSON
			// Note: JSON.stringify turns undefined to null
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: undefined,
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// With undefined, JSON.stringify converts to null
			// So this becomes same as null timestamp case: warning logged
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			// Note: JSON.stringify({timestamp: undefined}) produces {"source":"save_plan"}
			// So timestamp is actually missing, not null - no warning
		});

		test('marker with empty string timestamp', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with empty string timestamp
			// new Date("").getTime() returns NaN
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: '',
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT log warning (NaN comparison)
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);

			// Verify: new Date("").getTime() returns NaN
			expect(new Date('').getTime()).toBeNaN();
		});

		test('marker with very old timestamp (year 1970)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with timestamp at epoch (1970-01-01)
			// new Date(0).getTime() returns 0
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: '1970-01-01T00:00:00.000Z',
					source: 'save_plan',
				}),
			);

			// Call the method
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// SHOULD log warning because current plan.json mtime > 5000
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(1);
		});

		test('marker with numeric timestamp (not ISO string)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with numeric timestamp
			// new Date(1234567890000).getTime() works fine
			// F-010: "recent" means recent relative to the value production
			// compares against — plan.json's filesystem mtime
			// (checkForUnauthorizedWrite warns when planMtimeMs > marker + 5000).
			// That comparator is an OS timestamp `freezeClock` cannot reach: a
			// frozen wall clock at any past instant stamps the marker older than
			// plan.json and logs the WARNING this test asserts is absent.
			// Stamping from plan.json's own mtime keeps "recent" true by
			// construction instead of by read-after-write timing.
			const planMtimeMs = Math.floor(fs.statSync(planJsonPath).mtimeMs);
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: planMtimeMs,
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// Should NOT log warning (timestamp is recent)
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(0);
		});

		test('marker with array instead of timestamp (type confusion)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with array instead of timestamp
			// new Date([...]).getTime() returns NaN
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: ['invalid'],
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

			// Verify: array converts to NaN
			expect(new Date(['test']).getTime()).toBeNaN();
		});

		test('marker with object timestamp (type confusion)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with object instead of timestamp
			// new Date({}).getTime() returns NaN
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: { invalid: true },
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

		test('marker with boolean timestamp (type confusion)', () => {
			// Create plan.json
			createPlanJson(planJsonPath);

			// Create marker with boolean instead of timestamp
			// new Date(true).getTime() returns 1 (true converts to 1)
			// new Date(false).getTime() returns 0 (false converts to 0)
			// Both will trigger warning since plan.json mtime > 5000
			fs.writeFileSync(
				markerPath,
				JSON.stringify({
					timestamp: false, // Use false to get 0
					source: 'save_plan',
				}),
			);

			// Call the method - should NOT throw
			const worker = new PlanSyncWorker({ directory: tempDir });
			expect(() => {
				(worker as any).checkForUnauthorizedWrite();
			}).not.toThrow();

			// SHOULD log warning because new Date(false).getTime() = 0
			// and plan.json mtime > 5000
			const warningCalls = logCalls.filter((call) =>
				call.message.includes('WARNING'),
			);
			expect(warningCalls.length).toBe(1);

			// Verify: false converts to 0, true converts to 1
			expect(new Date(false).getTime()).toBe(0);
			expect(new Date(true).getTime()).toBe(1);
		});
	});
});

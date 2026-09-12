/**
 * Integration tests for phase preflight auto-trigger behavior
 *
 * Tests the following acceptance criteria:
 * 1. Phase transitions trigger preflight checks
 * 2. Same-phase updates do NOT retrigger preflight
 * 3. safeHook isolation prevents preflight failures from breaking hook execution
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PreflightTriggerManager } from '../../src/background/trigger';
import { type Plan, PlanSchema } from '../../src/config/plan-schema';
import { AutomationConfigSchema } from '../../src/config/schema';
import { createPhaseMonitorHook } from '../../src/hooks/phase-monitor';
import { composeHandlers, safeHook } from '../../src/hooks/utils';
import { loadPlan, savePlan } from '../../src/plan/manager';

describe('Phase Preflight Auto-Trigger Integration', () => {
	let tempDir: string;
	let swarmDir: string;

	beforeEach(() => {
		// Create a temp directory for each test
		tempDir = mkdtempSync(path.join(tmpdir(), 'phase-preflight-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up temp directory after each test
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Helper: Create a plan with specific phase configuration
	 * Sets previous phase to complete status so task counts are accurate
	 */
	// Helper: build (no save) plans for on-disk shapes savePlan cannot produce
	// (#2532: cursor normalization is forward-only; backward transitions Bun.write).
	function buildTestPlan(currentPhase: number, phaseCount: number = 2): Plan {
		const phases = Array.from({ length: phaseCount }, (_, i) => {
			const isPreviousPhase = i + 1 === currentPhase - 1;
			const isCurrentPhase = i + 1 === currentPhase;

			return {
				id: i + 1,
				name: `Phase ${i + 1}`,
				// Previous phase should be complete, current phase is in_progress or pending
				status: isPreviousPhase
					? ('complete' as const)
					: isCurrentPhase
						? ('in_progress' as const)
						: ('pending' as const),
				tasks: [
					{
						id: `${i + 1}.1`,
						phase: i + 1,
						// Previous phase tasks completed, current phase pending
						status: isPreviousPhase
							? ('completed' as const)
							: ('pending' as const),
						size: 'small' as const,
						description: `Task in phase ${i + 1}`,
						depends: [],
						files_touched: [],
					},
				],
			};
		});

		return PlanSchema.parse({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: currentPhase,
			phases,
		});
	}

	/**
	 * Helper: Create a minimal valid plan with given phase
	 */
	async function createTestPlan(
		currentPhase: number,
		phaseCount: number = 2,
	): Promise<Plan> {
		const validated = buildTestPlan(currentPhase, phaseCount);
		await savePlan(tempDir, validated);
		return validated;
	}

	/**
	 * Helper: Create a mock PreflightTriggerManager that tracks calls
	 */
	function createMockPreflightManager(): PreflightTriggerManager {
		const config = AutomationConfigSchema.parse({
			mode: 'hybrid',
			capabilities: { phase_preflight: true },
		});

		return new PreflightTriggerManager(config);
	}

	describe('Acceptance Criterion 1: Phase transitions trigger preflight checks', () => {
		it('should trigger preflight when phase changes from 1 to 2', async () => {
			// Create plan at phase 1
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// First call - initializes phase tracking (should NOT trigger)
			await hook({}, {});
			expect(checkAndTriggerSpy).not.toHaveBeenCalled();

			// Update plan to phase 2
			await createTestPlan(2, 2);

			// Second call - phase changed, should trigger
			await hook({}, {});
			expect(checkAndTriggerSpy).toHaveBeenCalledTimes(1);
			expect(checkAndTriggerSpy).toHaveBeenCalledWith(
				2, // currentPhase
				1, // completedTasks (phase 1 had 1 task completed - now we need to check)
				1, // totalTasks
			);
		});

		it('should trigger preflight for multiple phase transitions', async () => {
			// Start at phase 1
			await createTestPlan(1, 3);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Initialize
			await hook({}, {});

			// Transition to phase 2
			await createTestPlan(2, 3);
			await hook({}, {});
			expect(checkAndTriggerSpy).toHaveBeenCalledTimes(1);

			// Transition to phase 3
			await createTestPlan(3, 3);
			await hook({}, {});
			expect(checkAndTriggerSpy).toHaveBeenCalledTimes(2);
		});

		it('should pass correct completed/total task counts to preflight', async () => {
			// #2532: phase 1 must start NON-terminal (one task pending) — a
			// fully complete phase 1 cannot hold the cursor at 1, so savePlan
			// would normalize straight to phase 2 and the init would not be at 1.
			const mkTask = (id: string, status: 'completed' | 'pending') => ({
				id,
				phase: Number(id[0]),
				status,
				size: 'small' as const,
				description: `Task ${id}`,
				depends: [],
				files_touched: [],
			});
			const phases = [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress' as const,
					tasks: [
						mkTask('1.1', 'completed'),
						mkTask('1.2', 'completed'),
						mkTask('1.3', 'pending'),
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'pending' as const,
					tasks: [mkTask('2.1', 'pending')],
				},
			];

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			// First, save and initialize at phase 1 (non-terminal)
			const planAtPhase1: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases,
			};
			await savePlan(tempDir, PlanSchema.parse(planAtPhase1));

			const hook = createPhaseMonitorHook(tempDir, mockManager);
			await hook({}, {}); // Initialize at phase 1

			// Now complete phase 1 and save at phase 2 — normalization advances
			// the cursor off the now-terminal phase 1.
			const planAtPhase2: Plan = {
				...planAtPhase1,
				current_phase: 2,
				phases: planAtPhase1.phases.map((phase) =>
					phase.id === 1
						? {
								...phase,
								status: 'complete' as const,
								tasks: phase.tasks.map((task) => ({
									...task,
									status: 'completed' as const,
								})),
							}
						: phase,
				),
			};
			await savePlan(tempDir, PlanSchema.parse(planAtPhase2));
			await hook({}, {});

			expect(checkAndTriggerSpy).toHaveBeenCalledWith(
				2, // currentPhase
				3, // completedTasks - should count completed tasks from phase 1
				3, // totalTasks - total tasks in phase 1
			);
		});
	});

	describe('Acceptance Criterion 2: Same-phase updates do NOT retrigger preflight', () => {
		it('should NOT trigger preflight when calling hook multiple times with same phase', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// First call - initializes
			await hook({}, {});
			expect(checkAndTriggerSpy).not.toHaveBeenCalled();

			// Multiple subsequent calls at same phase - should NOT trigger
			await hook({}, {});
			await hook({}, {});
			await hook({}, {});

			expect(checkAndTriggerSpy).not.toHaveBeenCalled();
		});

		it('should NOT retrigger when plan file is rewritten with same phase', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Initialize
			await hook({}, {});

			// Simulate task updates in same phase - rewrite plan with same current_phase
			const plan = await loadPlan(tempDir);
			expect(plan).not.toBeNull();

			// Update a task status but keep same phase. #2532: completing the
			// ONLY task of phase 1 would advance the cursor to phase 2 (a real
			// transition), so the rewrite moves it to in_progress instead.
			const updatedPlan: Plan = {
				...plan!,
				phases: plan!.phases.map((phase) =>
					phase.id === 1
						? {
								...phase,
								tasks: phase.tasks.map((task) =>
									task.id === '1.1'
										? { ...task, status: 'in_progress' as const }
										: task,
								),
							}
						: phase,
				),
			};
			await savePlan(tempDir, PlanSchema.parse(updatedPlan));

			// Hook called again - should NOT trigger because phase hasn't changed
			await hook({}, {});

			expect(checkAndTriggerSpy).not.toHaveBeenCalled();
		});

		it('should handle rapid successive calls gracefully without retriggering', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Rapid calls - all in same phase
			await Promise.all([
				hook({}, {}),
				hook({}, {}),
				hook({}, {}),
				hook({}, {}),
				hook({}, {}),
			]);

			// Only the initialization should have happened (phase 1 tracked but no trigger)
			expect(checkAndTriggerSpy).not.toHaveBeenCalled();
		});
	});

	describe('Acceptance Criterion 3: safeHook isolation prevents preflight failures', () => {
		it('should NOT throw when preflight manager throws an error', async () => {
			await createTestPlan(1, 2);

			// Create a manager that always throws
			const failingManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);

			// Override checkAndTrigger to throw
			failingManager.checkAndTrigger = vi
				.fn()
				.mockRejectedValue(new Error('Preflight failed!'));

			const hook = createPhaseMonitorHook(tempDir, failingManager);

			// Initialize at phase 1
			await hook({}, {});

			// Update to phase 2 - this should NOT throw even though the manager fails
			await createTestPlan(2, 2);

			// This should not propagate the error - safeHook catches it
			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should continue working after preflight failure', async () => {
			await createTestPlan(1, 3);

			let shouldFail = false;
			const failingManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);

			// Make it fail on first phase transition only
			failingManager.checkAndTrigger = vi
				.fn()
				.mockImplementation(async (phase) => {
					if (shouldFail && phase === 2) {
						throw new Error('Simulated preflight failure');
					}
					return false;
				});

			const hook = createPhaseMonitorHook(tempDir, failingManager);

			// Initialize
			await hook({}, {});

			// First transition - fail
			shouldFail = true;
			await createTestPlan(2, 3);

			// Should not propagate - safeHook catches it
			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);

			// Second transition - should work again (failure was isolated)
			shouldFail = false;
			await createTestPlan(3, 3);

			threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('safeHook should catch errors from the wrapped handler', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();

			// Create a handler that throws
			const throwingHandler = async (
				_input: unknown,
				_output: unknown,
			): Promise<void> => {
				throw new Error('Handler exploded!');
			};

			// wrap with safeHook
			const safeHandler = safeHook(throwingHandler);

			// Should NOT throw - safeHook catches it
			let threw = false;
			try {
				await safeHandler({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('composeHandlers should isolate failures in individual handlers', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();

			// First handler throws
			const failingHandler = async (
				_input: unknown,
				_output: unknown,
			): Promise<void> => {
				throw new Error('First handler failed');
			};

			// Second handler tracks calls
			let secondHandlerCalled = false;
			const succeedingHandler = async (
				_input: unknown,
				_output: unknown,
			): Promise<void> => {
				secondHandlerCalled = true;
			};

			const composed = composeHandlers(failingHandler, succeedingHandler);

			// Should NOT throw - safeHook wraps each handler
			let threw = false;
			try {
				await composed({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);

			// Second handler should still have been called
			expect(secondHandlerCalled).toBe(true);
		});

		it('phase monitor hook wrapped in safeHook does not crash on invalid plan', async () => {
			// Don't create a valid plan - leave .swarm empty or invalid

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Should not throw even with no valid plan
			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	describe('Integration: Full workflow with real filesystem', () => {
		it('complete workflow: init -> phase change -> task update -> phase change', async () => {
			// Step 1: Create initial plan at phase 1
			await createTestPlan(1, 3);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');

			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Initialize - tracks phase 1
			await hook({}, {});
			expect(checkAndTriggerSpy).not.toHaveBeenCalled();

			// Step 2: Transition to phase 2
			await createTestPlan(2, 3);
			await hook({}, {});
			expect(checkAndTriggerSpy).toHaveBeenCalledTimes(1);

			// Step 3: Multiple updates within phase 2 - should NOT retrigger.
			// #2532: completing phase 2's ONLY task would advance the cursor
			// to phase 3 (covered by Step 4), so this update stays in-phase.
			const plan = await loadPlan(tempDir);
			expect(plan).not.toBeNull();

			// Update the task without completing the phase
			const updatedPlan: Plan = {
				...plan!,
				phases: plan!.phases.map((phase) => {
					if (phase.id === 2) {
						return {
							...phase,
							tasks: phase.tasks.map((task) => ({
								...task,
								status: 'in_progress' as const,
							})),
						};
					}
					return phase;
				}),
			};
			await savePlan(tempDir, PlanSchema.parse(updatedPlan));

			// Multiple hooks calls - should NOT trigger preflight
			await hook({}, {});
			await hook({}, {});
			await hook({}, {});

			expect(checkAndTriggerSpy).toHaveBeenCalledTimes(1); // Still only 1

			// Step 4: Transition to phase 3
			await createTestPlan(3, 3);
			await hook({}, {});
			expect(checkAndTriggerSpy).toHaveBeenCalledTimes(2); // Now 2
		});

		it('handles plan.json missing gracefully and recovers', async () => {
			// Create initial valid plan
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Initialize should work
			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);

			// Delete plan.json (simulating corruption)
			rmSync(path.join(swarmDir, 'plan.json'));

			// Hook should handle missing plan gracefully
			threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);

			// Restore plan
			await createTestPlan(2, 2);

			// Should work again
			threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// ADVERSARIAL SECURITY TESTS
	// Attack vectors: malformed inputs, oversized payloads, corruption,
	// boundary conditions, trigger abuse, safeHook isolation bypass
	// ============================================================
	describe('ADVERSARIAL: Malformed Plan Inputs', () => {
		it('should handle completely invalid JSON in plan.json without crashing', async () => {
			// Write garbage bytes as plan.json
			const garbageContent = '\x00\x01\x02\xff\xfe not json {{{';
			await Bun.write(path.join(swarmDir, 'plan.json'), garbageContent);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with null as root object', async () => {
			await Bun.write(path.join(swarmDir, 'plan.json'), 'null');

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with empty object {}', async () => {
			await Bun.write(path.join(swarmDir, 'plan.json'), '{}');

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with wrong data types for critical fields', async () => {
			const malformedPlan = {
				schema_version: 12345, // Should be string
				title: null, // Should be string
				swarm: [], // Should be string
				current_phase: 'two', // Should be number
				phases: 'not an array', // Should be array
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(malformedPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with negative current_phase', async () => {
			const malformedPlan = {
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				current_phase: -1,
				phases: [{ id: 1, name: 'P1', status: 'pending', tasks: [] }],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(malformedPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with floating point phase numbers', async () => {
			const malformedPlan = {
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				current_phase: 1.999999,
				phases: [{ id: 1.5, name: 'P1', status: 'pending', tasks: [] }],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(malformedPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with tasks containing invalid status', async () => {
			const malformedPlan = {
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'invalid_status_xyz',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: '__proto__',
								size: 'gigantic',
								description: 'test',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(malformedPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with prototype pollution attempt in fields', async () => {
			const maliciousPlan = {
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				current_phase: 1,
				phases: [],
				__proto__: { polluted: true },
				constructor: { prototype: { polluted: true } },
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(maliciousPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);

			// Verify prototype wasn't polluted
			expect({} as any).not.toHaveProperty('polluted');
		});

		it('should handle deeply nested JSON structure', async () => {
			// Create a deeply nested structure that could cause stack overflow
			let deeplyNested: any = { value: 'bottom' };
			for (let i = 0; i < 100; i++) {
				deeplyNested = { nested: deeplyNested };
			}
			deeplyNested.phases = [];
			deeplyNested.current_phase = 1;
			deeplyNested.schema_version = '1.0.0';
			deeplyNested.title = 'Deep';
			deeplyNested.swarm = 'test';

			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(deeplyNested),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with unicode/special characters in fields', async () => {
			const unicodePlan = {
				schema_version: '1.0.0',
				title: 'Test \u0000\x00 null bytes \u202E\u202E',
				swarm: 'test\n\r\t<script>alert(1)</script>',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: '\uD83D\uDE00 emoji \u0000',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: '\u202E<script>alert("xss")</script>',
								depends: [],
								files_touched: [
									'../../etc/passwd',
									'../../../windows/system32',
								],
							},
						],
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(unicodePlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	describe('ADVERSARIAL: Oversized Payloads', () => {
		it('should handle plan with extremely large number of phases', async () => {
			const phases = Array.from({ length: 1000 }, (_, i) => ({
				id: i + 1,
				name: `Phase ${i + 1}`,
				status: 'pending' as const,
				tasks: [
					{
						id: `${i + 1}.1`,
						phase: i + 1,
						status: 'pending' as const,
						size: 'small' as const,
						description: `Task for phase ${i + 1}`,
						depends: [],
						files_touched: [],
					},
				],
			}));

			const largePlan = {
				schema_version: '1.0.0',
				title: 'Massive Plan',
				swarm: 'test',
				current_phase: 1,
				phases,
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(largePlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with thousands of tasks per phase', async () => {
			const tasks = Array.from({ length: 500 }, (_, i) => ({
				id: `1.${i + 1}`,
				phase: 1,
				status: 'pending' as const,
				size: 'small' as const,
				description: `Task ${i + 1} - ${'x'.repeat(100)}`,
				depends: [],
				files_touched: [],
			}));

			const largePlan = {
				schema_version: '1.0.0',
				title: 'Many Tasks',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending' as const,
						tasks,
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(largePlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with extremely long string values', async () => {
			// Create a 1MB string
			const hugeString = 'x'.repeat(1024 * 1024);

			const largePlan = {
				schema_version: '1.0.0',
				title: hugeString,
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: hugeString.substring(0, 10000),
						status: 'pending' as const,
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending' as const,
								size: 'small' as const,
								description: hugeString.substring(0, 100000),
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(largePlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with MAX_SAFE_INTEGER as phase ID', async () => {
			const boundaryPlan = {
				schema_version: '1.0.0',
				title: 'Boundary Test',
				swarm: 'test',
				current_phase: Number.MAX_SAFE_INTEGER,
				phases: [
					{
						id: Number.MAX_SAFE_INTEGER,
						name: 'Max Phase',
						status: 'pending' as const,
						tasks: [],
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(boundaryPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan with circular dependency references', async () => {
			const cyclicPlan = {
				schema_version: '1.0.0',
				title: 'Cyclic Deps',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending' as const,
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending' as const,
								size: 'small' as const,
								description: 'T1',
								depends: ['1.2'],
								files_touched: [],
							},
							{
								id: '1.2',
								phase: 1,
								status: 'pending' as const,
								size: 'small' as const,
								description: 'T2',
								depends: ['1.3'],
								files_touched: [],
							},
							{
								id: '1.3',
								phase: 1,
								status: 'pending' as const,
								size: 'small' as const,
								description: 'T3',
								depends: ['1.1'],
								files_touched: [],
							},
						],
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(cyclicPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	describe('ADVERSARIAL: Corruption Scenarios', () => {
		it('should handle partial/truncated JSON file', async () => {
			// Valid start but truncated
			const truncated =
				'{"schema_version":"1.0.0","title":"Test","swarm":"test","current_phase":1,"phases":[{"id":1,"name":"P1","status":"pendi';
			await Bun.write(path.join(swarmDir, 'plan.json'), truncated);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan.json that is a directory', async () => {
			mkdirSync(path.join(swarmDir, 'plan.json'), { recursive: true });

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle .swarm directory being a file', async () => {
			// Remove the .swarm directory and create a file with same name
			rmSync(swarmDir, { recursive: true, force: true });
			await Bun.write(
				path.join(tempDir, '.swarm'),
				'I am a file, not a directory',
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle rapid sequential read/write operations without crash', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Sequential operations to avoid Windows file locking issues
			// Tests that the hook doesn't crash even with rapid state changes
			for (let i = 0; i < 10; i++) {
				await hook({}, {});
				// Interleave writes
				if (i % 3 === 0) {
					await createTestPlan((i % 3) + 1, 3);
				}
			}

			// If we get here, the hook handled rapid sequential operations gracefully
			expect(true).toBe(true);
		});

		it('should handle empty plan.json file (0 bytes)', async () => {
			await Bun.write(path.join(swarmDir, 'plan.json'), '');

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle plan.json with only whitespace', async () => {
			await Bun.write(path.join(swarmDir, 'plan.json'), '   \n\t  \r\n   ');

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	describe('ADVERSARIAL: Boundary Conditions', () => {
		it('should handle phase transition to phase 0', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			await hook({}, {}); // Initialize at phase 1

			// Try to set current_phase to 0 (invalid)
			const zeroPhasePlan = {
				schema_version: '1.0.0',
				title: 'Zero Phase',
				swarm: 'test',
				current_phase: 0,
				phases: [{ id: 1, name: 'P1', status: 'pending', tasks: [] }],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(zeroPhasePlan),
			);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle backward phase transition (phase 2 -> phase 1)', async () => {
			await createTestPlan(2, 3);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			await hook({}, {}); // Initialize at phase 2

			// Transition backwards. #2532: savePlan can no longer persist a
			// backward cursor, so the projection is written directly (like the
			// phase-0 case above).
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(buildTestPlan(1, 3)),
			);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
			// Should still trigger (phase changed, regardless of direction)
			expect(checkAndTriggerSpy).toHaveBeenCalled();
		});

		it('should handle skipping multiple phases at once (phase 1 -> phase 5)', async () => {
			await createTestPlan(1, 5);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			await hook({}, {}); // Initialize at phase 1

			// Skip directly to phase 5
			await createTestPlan(5, 5);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
			expect(checkAndTriggerSpy).toHaveBeenCalled();
		});

		it('should handle plan with empty phases array', async () => {
			const emptyPhasesPlan = {
				schema_version: '1.0.0',
				title: 'No Phases',
				swarm: 'test',
				current_phase: 1,
				phases: [],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(emptyPhasesPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle phase with empty tasks array', async () => {
			const emptyTasksPlan = {
				schema_version: '1.0.0',
				title: 'No Tasks',
				swarm: 'test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Empty Phase',
						status: 'pending' as const,
						tasks: [],
					},
				],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(emptyTasksPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle current_phase pointing to non-existent phase', async () => {
			const invalidRefPlan = {
				schema_version: '1.0.0',
				title: 'Invalid Reference',
				swarm: 'test',
				current_phase: 999,
				phases: [{ id: 1, name: 'Only Phase', status: 'pending', tasks: [] }],
			};
			await Bun.write(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(invalidRefPlan),
			);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	describe('ADVERSARIAL: Trigger Abuse', () => {
		it('should handle rapid sequential phase transitions without queue overflow', async () => {
			await createTestPlan(1, 20);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			await hook({}, {}); // Initialize

			// Sequential phase changes (avoids Windows file locking issues)
			for (let i = 2; i <= 20; i++) {
				await createTestPlan(i, 20);
				await hook({}, {});
			}

			// If we get here, the hook handled rapid sequential transitions gracefully
			expect(true).toBe(true);
		});

		it('should handle oscillating phase values (1->2->1->2->1)', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const checkAndTriggerSpy = vi.spyOn(mockManager, 'checkAndTrigger');
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			await hook({}, {}); // Initialize

			// Oscillate
			for (let i = 0; i < 5; i++) {
				await createTestPlan(2, 2);
				await hook({}, {});
				await createTestPlan(1, 2);
				await hook({}, {});
			}

			// Should not crash - each transition should trigger
			expect(checkAndTriggerSpy).toHaveBeenCalled();
		});

		it('should handle preflight manager checkAndTrigger throwing synchronously', async () => {
			await createTestPlan(1, 2);

			const explodingManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);
			// Override to throw synchronously
			(explodingManager as any).checkAndTrigger = () => {
				throw new Error('Synchronous explosion!');
			};

			const hook = createPhaseMonitorHook(tempDir, explodingManager);
			await hook({}, {}); // Initialize

			await createTestPlan(2, 2);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			// safeHook should catch this
			expect(threw).toBe(false);
		});

		it('should handle preflight manager checkAndTrigger returning rejected promise', async () => {
			await createTestPlan(1, 2);

			const rejectingManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);
			(rejectingManager as any).checkAndTrigger = async () => {
				return Promise.reject(new Error('Async rejection!'));
			};

			const hook = createPhaseMonitorHook(tempDir, rejectingManager);
			await hook({}, {}); // Initialize

			await createTestPlan(2, 2);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle preflight manager checkAndTrigger causing deep recursion', async () => {
			await createTestPlan(1, 2);

			const deepRecursionManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);

			// Use deep but finite recursion (100 levels) instead of infinite
			// to test error handling without causing actual stack overflow
			(deepRecursionManager as any).checkAndTrigger = () => {
				function deepRecurse(depth: number): void {
					if (depth > 0) deepRecurse(depth - 1);
					throw new Error(`Deep recursion at depth ${depth}`);
				}
				deepRecurse(100);
			};

			const hook = createPhaseMonitorHook(tempDir, deepRecursionManager);
			await hook({}, {}); // Initialize

			await createTestPlan(2, 2);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			// safeHook should catch the error from deep recursion
			expect(threw).toBe(false);
		});
	});

	describe('ADVERSARIAL: SafeHook Isolation Bypass Attempts', () => {
		it('should catch errors thrown via input object manipulation', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Try to pass malicious input
			const maliciousInput = {
				__proto__: { injected: true },
				constructor: { prototype: { injected: true } },
				toString: () => {
					throw new Error('Input toString threw');
				},
			};

			let threw = false;
			try {
				await hook(maliciousInput, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should catch errors thrown via output object manipulation', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Try to pass malicious output
			const maliciousOutput = {
				get system() {
					throw new Error('Output getter threw');
				},
			};

			let threw = false;
			try {
				await hook({}, maliciousOutput);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle handler that modifies global state before throwing', async () => {
			await createTestPlan(1, 2);

			// Track if global state was modified despite error
			let globalModified = false;

			const stateChangingManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);
			(stateChangingManager as any).checkAndTrigger = async () => {
				globalModified = true;
				throw new Error('Failed after state change');
			};

			const hook = createPhaseMonitorHook(tempDir, stateChangingManager);
			await hook({}, {}); // Initialize

			await createTestPlan(2, 2);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
			// The state was modified (side effect), but error didn't propagate
			expect(globalModified).toBe(true);
		});

		it('should handle multiple safeHook wrapped handlers with cascading failures', async () => {
			const throw1 = async () => {
				throw new Error('First');
			};
			const throw2 = async () => {
				throw new Error('Second');
			};
			const throw3 = async () => {
				throw new Error('Third');
			};
			const success = vi.fn();

			const composed = composeHandlers(throw1, throw2, throw3, success);
			await composed({}, {});

			// All handlers should have been called despite failures
			expect(success).toHaveBeenCalled();
		});

		it('should not leak memory via closure retention on repeated failures', async () => {
			await createTestPlan(1, 2);

			const failingManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);

			// Create a large object that shouldn't be retained
			const largeObject = { data: 'x'.repeat(100000) };
			(failingManager as any).checkAndTrigger = async () => {
				// Reference large object in closure (potential leak)
				void largeObject.data.length;
				throw new Error('Failing');
			};

			const hook = createPhaseMonitorHook(tempDir, failingManager);
			await hook({}, {}); // Initialize

			// Run many iterations
			for (let i = 0; i < 100; i++) {
				await createTestPlan((i % 2) + 1, 2);
				await hook({}, {});
			}

			// If we get here without OOM, closure retention is handled
			expect(true).toBe(true);
		});

		it('should handle Symbol throwing during property access', async () => {
			await createTestPlan(1, 2);

			const mockManager = createMockPreflightManager();
			const hook = createPhaseMonitorHook(tempDir, mockManager);

			// Object that throws when Symbol properties are accessed
			const symbolThrower = {
				[Symbol.toPrimitive]: () => {
					throw new Error('Symbol access');
				},
				[Symbol.toStringTag]: 'Thrower',
			};

			let threw = false;
			try {
				await hook(symbolThrower, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle handler that returns thenable which rejects', async () => {
			await createTestPlan(1, 2);

			const thenableRejectManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);
			(thenableRejectManager as any).checkAndTrigger = () => ({
				then: (_resolve: any, reject: any) =>
					reject(new Error('Thenable rejected')),
			});

			const hook = createPhaseMonitorHook(tempDir, thenableRejectManager);
			await hook({}, {}); // Initialize

			await createTestPlan(2, 2);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle Promise subclass with malicious then', async () => {
			await createTestPlan(1, 2);

			class MaliciousPromise<T> extends Promise<T> {
				then(onFulfilled?: any, onRejected?: any) {
					// Call onRejected with error instead of resolving
					if (onRejected) {
						onRejected(new Error('Malicious promise'));
					}
					return super.then(onFulfilled, onRejected);
				}
			}

			const maliciousManager = new PreflightTriggerManager(
				AutomationConfigSchema.parse({
					mode: 'hybrid',
					capabilities: { phase_preflight: true },
				}),
			);
			(maliciousManager as any).checkAndTrigger = () =>
				new MaliciousPromise(() => {});

			const hook = createPhaseMonitorHook(tempDir, maliciousManager);
			await hook({}, {}); // Initialize

			await createTestPlan(2, 2);

			let threw = false;
			try {
				await hook({}, {});
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});
});

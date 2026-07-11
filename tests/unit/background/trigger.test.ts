import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
	getGlobalEventBus,
	resetGlobalEventBus,
} from '../../../src/background/event-bus';
import type { AutomationQueue } from '../../../src/background/queue';
import {
	PhaseBoundaryTrigger,
	PreflightTriggerManager,
} from '../../../src/background/trigger';

describe('PhaseBoundaryTrigger', () => {
	let trigger: PhaseBoundaryTrigger;

	beforeEach(() => {
		resetGlobalEventBus();
		trigger = new PhaseBoundaryTrigger();
	});

	afterEach(() => {
		trigger.reset();
	});

	it('should detect phase boundary when phase changes', () => {
		// Phase 1 to 2
		const result = trigger.detectBoundary(2, 5, 10);

		expect(result.detected).toBe(true);
		expect(result.previousPhase).toBe(0);
		expect(result.currentPhase).toBe(2);
		expect(result.reason).toContain('Phase transition');
	});

	it('should not detect boundary when phase unchanged', () => {
		trigger.setCurrentPhase(2);

		const result = trigger.detectBoundary(2, 5, 10);

		expect(result.detected).toBe(false);
		expect(result.reason).toBe('Phase unchanged');
	});

	it('should update internal phase after detection', () => {
		trigger.detectBoundary(2, 5, 10);
		expect(trigger.getCurrentPhase()).toBe(2);

		// Second detection should not trigger since phase unchanged
		const result2 = trigger.detectBoundary(2, 8, 10);
		expect(result2.detected).toBe(false);
	});

	it('should respect minCompletedTasksThreshold', () => {
		const triggerWithThreshold = new PhaseBoundaryTrigger(undefined, {
			minCompletedTasksThreshold: 3,
		});

		// Phase boundary detected
		const boundaryResult = triggerWithThreshold.detectBoundary(2, 2, 10);
		expect(boundaryResult.detected).toBe(true);

		// But should not trigger preflight due to threshold
		const shouldTrigger =
			triggerWithThreshold.shouldTriggerPreflight(boundaryResult);
		expect(shouldTrigger).toBe(false);
	});

	it('should trigger preflight when threshold met', () => {
		const triggerWithThreshold = new PhaseBoundaryTrigger(undefined, {
			minCompletedTasksThreshold: 3,
		});

		const boundaryResult = triggerWithThreshold.detectBoundary(2, 5, 10);
		const shouldTrigger =
			triggerWithThreshold.shouldTriggerPreflight(boundaryResult);

		expect(shouldTrigger).toBe(true);
	});

	it('should allow zero task trigger when configured', () => {
		const triggerWithZero = new PhaseBoundaryTrigger(undefined, {
			allowZeroTaskTrigger: true,
			minCompletedTasksThreshold: 5,
		});

		const boundaryResult = triggerWithZero.detectBoundary(2, 0, 10);
		const shouldTrigger =
			triggerWithZero.shouldTriggerPreflight(boundaryResult);

		expect(shouldTrigger).toBe(true);
	});

	it('should not re-trigger for same phase', () => {
		const boundaryResult = trigger.detectBoundary(2, 5, 10);
		const firstTrigger = trigger.shouldTriggerPreflight(boundaryResult);
		expect(firstTrigger).toBe(true);

		// Mark as triggered (simulating what happens in the full flow)
		trigger.markTriggered(2);

		// Try again - should not trigger since we already triggered for phase 2
		const shouldTriggerAgain = trigger.shouldTriggerPreflight(boundaryResult);
		expect(shouldTriggerAgain).toBe(false);
	});

	it('should reset state', () => {
		trigger.detectBoundary(2, 5, 10);
		trigger.reset();

		expect(trigger.getCurrentPhase()).toBe(0);
	});
});

describe('PreflightTriggerManager', () => {
	afterEach(() => {
		resetGlobalEventBus();
	});

	it('should be disabled when mode is manual', () => {
		const manager = new PreflightTriggerManager({
			mode: 'manual',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		expect(manager.isEnabled()).toBe(false);
	});

	it('should be disabled when phase_preflight capability is false', () => {
		const manager = new PreflightTriggerManager({
			mode: 'hybrid',
			capabilities: {
				phase_preflight: false,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		expect(manager.isEnabled()).toBe(false);
	});

	it('should be enabled when mode is not manual and capability is true', () => {
		const manager = new PreflightTriggerManager({
			mode: 'hybrid',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		expect(manager.isEnabled()).toBe(true);
	});

	it('should return correct mode', () => {
		const manager = new PreflightTriggerManager({
			mode: 'auto',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		expect(manager.getMode()).toBe('auto');
	});

	it('should not trigger when disabled', async () => {
		const manager = new PreflightTriggerManager({
			mode: 'manual',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		const triggered = await manager.checkAndTrigger(2, 5, 10);

		expect(triggered).toBe(false);
		expect(manager.getQueueSize()).toBe(0);
	});

	it('should trigger preflight on phase boundary', async () => {
		const manager = new PreflightTriggerManager({
			mode: 'hybrid',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		const triggered = await manager.checkAndTrigger(2, 5, 10);

		expect(triggered).toBe(true);
		expect(manager.getQueueSize()).toBe(1);

		const requests = manager.getPendingRequests();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.currentPhase).toBe(2);
		expect(requests[0]?.source).toBe('phase_boundary');
	});

	it('should not trigger when phase unchanged', async () => {
		const manager = new PreflightTriggerManager({
			mode: 'hybrid',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		// First call sets phase
		await manager.checkAndTrigger(2, 5, 10);

		// Second call with same phase - should not trigger
		const triggered = await manager.checkAndTrigger(2, 8, 10);

		expect(triggered).toBe(false);
	});

	it('should not trigger when task threshold not met', async () => {
		const manager = new PreflightTriggerManager(
			{
				mode: 'hybrid',
				capabilities: {
					phase_preflight: true,
					plan_sync: false,
					config_doctor_on_startup: false,
					evidence_auto_summaries: false,
					decision_drift_detection: false,
				},
			},
			undefined,
			{ minCompletedTasksThreshold: 10 },
		);

		// Only 5 tasks completed, but 10 required
		const triggered = await manager.checkAndTrigger(2, 5, 10);

		expect(triggered).toBe(false);
	});

	it('should get correct stats', async () => {
		const manager = new PreflightTriggerManager({
			mode: 'hybrid',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		const stats = manager.getStats();

		expect(stats.enabled).toBe(true);
		expect(stats.mode).toBe('hybrid');
		expect(stats.pendingRequests).toBe(0);

		// Trigger once
		await manager.checkAndTrigger(2, 5, 10);

		const statsAfter = manager.getStats();
		expect(statsAfter.pendingRequests).toBe(1);
	});

	it('should reset state', async () => {
		const manager = new PreflightTriggerManager({
			mode: 'hybrid',
			capabilities: {
				phase_preflight: true,
				plan_sync: false,
				config_doctor_on_startup: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			},
		});

		await manager.checkAndTrigger(2, 5, 10);
		expect(manager.getQueueSize()).toBe(1);

		manager.reset();
		expect(manager.getQueueSize()).toBe(0);
	});

	// ===== SECURITY TESTS =====

	describe('Queue Overflow Protection (#1778 H5 — no permanent brick)', () => {
		it('still fires the trigger when the queue is full (evict-oldest, no brick)', async () => {
			const manager = new PreflightTriggerManager({
				mode: 'hybrid',
				capabilities: {
					phase_preflight: true,
					plan_sync: false,
					config_doctor_on_startup: false,
					evidence_auto_summaries: false,
					decision_drift_detection: false,
				},
			});

			const queue = (manager as unknown as { requestQueue: AutomationQueue })
				.requestQueue;

			// Observe that the 101st trigger STILL publishes preflight.requested.
			let requestedCount = 0;
			const unsub = getGlobalEventBus().subscribe('preflight.requested', () => {
				requestedCount++;
			});

			// Fill the queue to max lifetime capacity.
			for (let i = 0; i < 100; i++) {
				queue.enqueue(
					{
						id: `flood-${i}`,
						triggeredAt: Date.now(),
						currentPhase: 1,
						source: 'phase_boundary',
						reason: 'test',
					},
					'high',
				);
			}
			expect(queue.isFull()).toBe(true);

			// The 101st trigger must NOT be bricked — it fires and publishes.
			const triggered = await manager.checkAndTrigger(2, 5, 10);

			expect(triggered).toBe(true);
			expect(requestedCount).toBe(1);
			// evict-oldest keeps the queue bounded (no unbounded growth, no throw).
			expect(queue.size()).toBe(100);

			unsub();
		});

		it('does not throw when the queue is full', async () => {
			const manager = new PreflightTriggerManager({
				mode: 'hybrid',
				capabilities: {
					phase_preflight: true,
					plan_sync: false,
					config_doctor_on_startup: false,
					evidence_auto_summaries: false,
					decision_drift_detection: false,
				},
			});

			const queue = (manager as unknown as { requestQueue: AutomationQueue })
				.requestQueue;

			for (let i = 0; i < 100; i++) {
				queue.enqueue(
					{
						id: `flood-${i}`,
						triggeredAt: Date.now(),
						currentPhase: 1,
						source: 'phase_boundary',
						reason: 'test',
					},
					'high',
				);
			}

			// No throw, and the trigger succeeds rather than silently failing.
			const result = await manager.checkAndTrigger(3, 5, 10);
			expect(result).toBe(true);
		});
	});

	// ===== NULL-SAFETY TESTS =====

	describe('Null-safety for malformed config', () => {
		it('should fail-safe when automationConfig is null', () => {
			// @ts-expect-error - testing runtime behavior with null
			const manager = new PreflightTriggerManager(null);

			expect(manager.isEnabled()).toBe(false);
		});

		it('should fail-safe when automationConfig is undefined', () => {
			// @ts-expect-error - testing runtime behavior with undefined
			const manager = new PreflightTriggerManager(undefined);

			expect(manager.isEnabled()).toBe(false);
		});

		it('should fail-safe when capabilities is missing', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const manager = new PreflightTriggerManager({ mode: 'hybrid' } as any);

			expect(manager.isEnabled()).toBe(false);
		});

		it('should fail-safe when capabilities is null', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const manager = new PreflightTriggerManager({
				mode: 'hybrid',
				capabilities: null,
			} as any);

			expect(manager.isEnabled()).toBe(false);
		});

		it('should not throw in checkAndTrigger when config is malformed', async () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const manager = new PreflightTriggerManager({ mode: 'hybrid' } as any);

			// Should not throw, should return false
			const result = await manager.checkAndTrigger(2, 5, 10);
			expect(result).toBe(false);
		});

		it('should not throw in checkAndTrigger when config is null', async () => {
			// @ts-expect-error - testing runtime behavior with null
			const manager = new PreflightTriggerManager(null);

			// Should not throw, should return false
			const result = await manager.checkAndTrigger(2, 5, 10);
			expect(result).toBe(false);
		});

		// Tests for getMode() null-safety
		describe('getMode() null-safety', () => {
			it('should return "unknown" when config is null', () => {
				// @ts-expect-error - testing runtime behavior with null
				const manager = new PreflightTriggerManager(null);

				expect(manager.getMode()).toBe('unknown');
			});

			it('should return "unknown" when config is undefined', () => {
				// @ts-expect-error - testing runtime behavior with undefined
				const manager = new PreflightTriggerManager(undefined);

				expect(manager.getMode()).toBe('unknown');
			});

			it('should return "unknown" when mode is missing from config', () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const manager = new PreflightTriggerManager({} as any);

				expect(manager.getMode()).toBe('unknown');
			});

			it('should return "unknown" when mode is null', () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const manager = new PreflightTriggerManager({ mode: null } as any);

				expect(manager.getMode()).toBe('unknown');
			});

			it('should return mode value when config is valid', () => {
				const manager = new PreflightTriggerManager({
					mode: 'hybrid',
					capabilities: {
						phase_preflight: true,
						plan_sync: false,
						config_doctor_on_startup: false,
						evidence_auto_summaries: false,
						decision_drift_detection: false,
					},
				});

				expect(manager.getMode()).toBe('hybrid');
			});
		});

		// Tests for getStats() null-safety
		describe('getStats() null-safety', () => {
			it('should not throw when config is null', () => {
				// @ts-expect-error - testing runtime behavior with null
				const manager = new PreflightTriggerManager(null);

				const stats = manager.getStats();

				expect(stats.enabled).toBe(false);
				expect(stats.mode).toBe('unknown');
				expect(stats.currentPhase).toBe(0);
				expect(stats.lastTriggeredPhase).toBe(0);
				expect(stats.pendingRequests).toBe(0);
			});

			it('should not throw when config is undefined', () => {
				// @ts-expect-error - testing runtime behavior with undefined
				const manager = new PreflightTriggerManager(undefined);

				const stats = manager.getStats();

				expect(stats.enabled).toBe(false);
				expect(stats.mode).toBe('unknown');
			});

			it('should not throw when mode is missing from config', () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const manager = new PreflightTriggerManager({} as any);

				const stats = manager.getStats();

				expect(stats.mode).toBe('unknown');
				expect(stats.enabled).toBe(false);
			});

			it('should return correct stats when config is valid', () => {
				const manager = new PreflightTriggerManager({
					mode: 'hybrid',
					capabilities: {
						phase_preflight: true,
						plan_sync: false,
						config_doctor_on_startup: false,
						evidence_auto_summaries: false,
						decision_drift_detection: false,
					},
				});

				const stats = manager.getStats();

				expect(stats.enabled).toBe(true);
				expect(stats.mode).toBe('hybrid');
				expect(stats.currentPhase).toBe(0);
				expect(stats.pendingRequests).toBe(0);
			});
		});
	});
});

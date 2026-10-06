/**
 * Epic sizing (pure): thresholds, Amdahl S_eff, and every boundary.
 */
import { describe, expect, test } from 'bun:test';
import {
	computeEffectiveSpeedup,
	DEFAULT_EPIC_SIZING_THRESHOLDS,
	describeEpicSizingReason,
	evaluateEpicSizing,
	resolveEpicSizingThresholds,
} from '../../../src/epic/sizing';

describe('computeEffectiveSpeedup', () => {
	test('Amdahl: S_eff = 1 / ((1 − c) + c / S)', () => {
		expect(computeEffectiveSpeedup(2, 0.6)).toBeCloseTo(1 / (0.4 + 0.3), 10);
		expect(computeEffectiveSpeedup(4, 1)).toBeCloseTo(4, 10);
	});

	test('no concurrency or no coder share ⇒ exactly 1', () => {
		expect(computeEffectiveSpeedup(1, 0.6)).toBe(1);
		expect(computeEffectiveSpeedup(0.5, 0.6)).toBe(1);
		expect(computeEffectiveSpeedup(3, 0)).toBe(1);
		expect(computeEffectiveSpeedup(Number.NaN, 0.6)).toBe(1);
	});

	test('coder_fraction is clamped to [0, 1]', () => {
		expect(computeEffectiveSpeedup(3, 2)).toBeCloseTo(3, 10);
		expect(computeEffectiveSpeedup(3, -1)).toBe(1);
	});
});

describe('resolveEpicSizingThresholds', () => {
	test('defaults 6 / 0.8 / 1.25 / 0.6', () => {
		expect(resolveEpicSizingThresholds(undefined)).toEqual({
			minTasks: 6,
			minScopeCoverage: 0.8,
			minEffectiveSpeedup: 1.25,
			coderFraction: 0.6,
		});
		expect(DEFAULT_EPIC_SIZING_THRESHOLDS.minTasks).toBe(6);
	});

	test('config keys override individually', () => {
		expect(
			resolveEpicSizingThresholds({ min_tasks: 3, coder_fraction: 0.9 }),
		).toEqual({
			minTasks: 3,
			minScopeCoverage: 0.8,
			minEffectiveSpeedup: 1.25,
			coderFraction: 0.9,
		});
	});
});

describe('evaluateEpicSizing boundaries', () => {
	test('exactly at every threshold ⇒ epic-sized', () => {
		// T=6, coverage 5/6 ≥ 0.8; L=3 ⇒ S=2 ⇒ S_eff = 1/0.7 ≈ 1.4286 ≥ 1.25.
		const v = evaluateEpicSizing({
			pendingTasks: 6,
			scopedTasks: 5,
			serialSteps: 3,
		});
		expect(v.epicSized).toBe(true);
		expect(v.reasons).toEqual([]);
		expect(v.concurrency).toBe(2);
		expect(v.effectiveSpeedup).toBeCloseTo(1 / 0.7, 10);
	});

	test('T = min_tasks − 1 ⇒ too-few-tasks', () => {
		const v = evaluateEpicSizing({
			pendingTasks: 5,
			scopedTasks: 5,
			serialSteps: 1,
		});
		expect(v.reasons).toEqual(['too-few-tasks']);
	});

	test('coverage just below min ⇒ insufficient-scope-coverage; exactly 0.8 passes', () => {
		const below = evaluateEpicSizing({
			pendingTasks: 10,
			scopedTasks: 7,
			serialSteps: 2,
		});
		expect(below.reasons).toEqual(['insufficient-scope-coverage']);
		const at = evaluateEpicSizing({
			pendingTasks: 10,
			scopedTasks: 8,
			serialSteps: 2,
		});
		expect(at.reasons).toEqual([]);
	});

	test('S_eff just below min ⇒ insufficient-parallelism', () => {
		// S = 6/4 = 1.5 ⇒ S_eff = 1/(0.4+0.4) = 1.25 — exactly at the bound.
		const at = evaluateEpicSizing({
			pendingTasks: 6,
			scopedTasks: 6,
			serialSteps: 4,
		});
		expect(at.effectiveSpeedup).toBeCloseTo(1.25, 10);
		expect(at.epicSized).toBe(true);
		// S = 6/5 = 1.2 ⇒ S_eff ≈ 1.111 < 1.25.
		const below = evaluateEpicSizing({
			pendingTasks: 6,
			scopedTasks: 6,
			serialSteps: 5,
		});
		expect(below.reasons).toEqual(['insufficient-parallelism']);
	});

	test('fully serial (L = T) and empty plans', () => {
		expect(
			evaluateEpicSizing({ pendingTasks: 8, scopedTasks: 8, serialSteps: 8 })
				.reasons,
		).toEqual(['insufficient-parallelism']);
		const empty = evaluateEpicSizing({
			pendingTasks: 0,
			scopedTasks: 0,
			serialSteps: 0,
		});
		expect(empty.reasons).toEqual([
			'too-few-tasks',
			'insufficient-scope-coverage',
			'insufficient-parallelism',
		]);
		expect(empty.scopeCoverage).toBe(0);
		expect(empty.concurrency).toBe(1);
	});

	test('scoped count is clamped to the pending count', () => {
		const v = evaluateEpicSizing({
			pendingTasks: 6,
			scopedTasks: 99,
			serialSteps: 2,
		});
		expect(v.scopedTasks).toBe(6);
		expect(v.scopeCoverage).toBe(1);
	});

	test('reason text names the measured values and thresholds', () => {
		const v = evaluateEpicSizing({
			pendingTasks: 4,
			scopedTasks: 1,
			serialSteps: 4,
		});
		expect(describeEpicSizingReason('too-few-tasks', v)).toBe(
			'too-few-tasks: 4 pending task(s) < min_tasks 6',
		);
		expect(
			describeEpicSizingReason('insufficient-scope-coverage', v),
		).toContain('1/4 pending task(s)');
		expect(describeEpicSizingReason('insufficient-parallelism', v)).toContain(
			'effective speedup 1.00× < min_effective_speedup 1.25×',
		);
	});
});

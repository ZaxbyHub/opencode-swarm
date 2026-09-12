/**
 * #2532: the summary extractors resolve through the canonical active-phase
 * resolver, so a dangling stored cursor (legacy plans whose current_phase
 * never advanced or points at a removed phase) reports the honest active
 * phase instead of null. Supersedes the two "Returns null when
 * current_phase does not match any phase ID" tests relocated here from
 * extractors.test.ts (FR-006 move-out).
 */
import { describe, expect, it } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	extractCurrentPhaseFromPlan,
	extractCurrentTaskFromPlan,
} from '../../../src/hooks/extractors';

function createTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress' as const,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed' as const,
						size: 'small' as const,
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
					{
						id: '1.2',
						phase: 1,
						status: 'in_progress' as const,
						size: 'medium' as const,
						description: 'Task two',
						depends: ['1.1'],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

describe('extractCurrentPhaseFromPlan — dangling cursor (#2532)', () => {
	it('reports the honest active phase when current_phase matches no phase', () => {
		const plan = createTestPlan({ current_phase: 99 });
		const result = extractCurrentPhaseFromPlan(plan);
		expect(result).toBe('Phase 1: Phase 1 [IN PROGRESS]');
	});
});

describe('extractCurrentTaskFromPlan — dangling cursor (#2532)', () => {
	it('reports the honest active task when current_phase matches no phase', () => {
		const plan = createTestPlan({ current_phase: 99 });
		const result = extractCurrentTaskFromPlan(plan);
		expect(result).toContain('1.2: Task two');
		expect(result).toContain('← CURRENT');
	});
});

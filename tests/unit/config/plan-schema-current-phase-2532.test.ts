/**
 * #2532: getCurrentPhase resolves through the canonical active-phase
 * resolver — an explicit cursor is honored only while it points at a
 * NON-terminal phase. Supersedes the "returns explicit current_phase when
 * set" test relocated here from plan-schema.test.ts (FR-006 move-out),
 * extending it with the non-terminal requirement.
 */
import { describe, expect, it } from 'bun:test';
import { getCurrentPhase, type Plan } from '../../../src/config/plan-schema';

function createTestPlan(overrides: Partial<Plan> = {}): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [],
			},
		],
		...overrides,
	} as Plan;
}

describe('getCurrentPhase with inference (#2532)', () => {
	it('returns explicit current_phase when it points at a non-terminal phase', () => {
		const plan = createTestPlan({
			current_phase: 2,
			phases: [
				{ id: 1, name: 'Phase 1', status: 'complete', tasks: [] },
				{ id: 2, name: 'Phase 2', status: 'in_progress', tasks: [] },
			],
		});
		expect(getCurrentPhase(plan)).toBe(2);
	});

	it('advances off a terminal cursor phase to the first non-terminal phase', () => {
		const plan = createTestPlan({
			current_phase: 1,
			phases: [
				{ id: 1, name: 'Phase 1', status: 'complete', tasks: [] },
				{ id: 2, name: 'Phase 2', status: 'pending', tasks: [] },
			],
		});
		expect(getCurrentPhase(plan)).toBe(2);
	});
});

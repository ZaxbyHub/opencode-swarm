import { describe, expect, it } from 'bun:test';
import {
	type ExecutionProfile,
	ExecutionProfileSchema,
	PlanSchema,
} from '../../../src/config/plan-schema';

describe('ExecutionProfileSchema', () => {
	describe('defaults', () => {
		it('parses empty object with all defaults', () => {
			const result = ExecutionProfileSchema.safeParse({});
			expect(result.success).toBe(true);
			if (!result.success) return;
			const profile: ExecutionProfile = result.data;
			expect(profile.parallelization_enabled).toBe(false);
			expect(profile.max_concurrent_tasks).toBe(1);
			expect(profile.council_parallel).toBe(true);
			expect(profile.locked).toBe(false);
			expect(profile.auto_proceed).toBe(false);
		});
	});

	describe('valid values', () => {
		it('accepts parallelization_enabled: true', () => {
			const result = ExecutionProfileSchema.safeParse({
				parallelization_enabled: true,
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.parallelization_enabled).toBe(true);
		});

		it('accepts max_concurrent_tasks at boundary min (1)', () => {
			const result = ExecutionProfileSchema.safeParse({
				max_concurrent_tasks: 1,
			});
			expect(result.success).toBe(true);
		});

		it('accepts max_concurrent_tasks at boundary max (64)', () => {
			const result = ExecutionProfileSchema.safeParse({
				max_concurrent_tasks: 64,
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.max_concurrent_tasks).toBe(64);
		});

		it('accepts council_parallel: true', () => {
			const result = ExecutionProfileSchema.safeParse({
				council_parallel: true,
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.council_parallel).toBe(true);
		});

		it('accepts locked: true', () => {
			const result = ExecutionProfileSchema.safeParse({ locked: true });
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.locked).toBe(true);
		});

		it('accepts auto_proceed: true', () => {
			const result = ExecutionProfileSchema.safeParse({ auto_proceed: true });
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.auto_proceed).toBe(true);
		});

		it('accepts auto_proceed: false', () => {
			const result = ExecutionProfileSchema.safeParse({ auto_proceed: false });
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.auto_proceed).toBe(false);
		});

		it('accepts a fully populated profile', () => {
			const result = ExecutionProfileSchema.safeParse({
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
				council_parallel: true,
				locked: true,
				auto_proceed: true,
			});
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.parallelization_enabled).toBe(true);
			expect(result.data.max_concurrent_tasks).toBe(4);
			expect(result.data.council_parallel).toBe(true);
			expect(result.data.locked).toBe(true);
			expect(result.data.auto_proceed).toBe(true);
		});
	});

	describe('invalid values', () => {
		it('rejects max_concurrent_tasks: 0 (below min)', () => {
			const result = ExecutionProfileSchema.safeParse({
				max_concurrent_tasks: 0,
			});
			expect(result.success).toBe(false);
		});

		it('rejects max_concurrent_tasks: 65 (above max)', () => {
			const result = ExecutionProfileSchema.safeParse({
				max_concurrent_tasks: 65,
			});
			expect(result.success).toBe(false);
		});

		it('rejects non-integer max_concurrent_tasks', () => {
			const result = ExecutionProfileSchema.safeParse({
				max_concurrent_tasks: 1.5,
			});
			expect(result.success).toBe(false);
		});

		it('rejects string for parallelization_enabled', () => {
			const result = ExecutionProfileSchema.safeParse({
				parallelization_enabled: 'yes',
			});
			expect(result.success).toBe(false);
		});

		it('rejects number for locked', () => {
			const result = ExecutionProfileSchema.safeParse({ locked: 1 });
			expect(result.success).toBe(false);
		});

		it('rejects string for auto_proceed', () => {
			const result = ExecutionProfileSchema.safeParse({ auto_proceed: 'yes' });
			expect(result.success).toBe(false);
		});

		it('rejects number for auto_proceed', () => {
			const result = ExecutionProfileSchema.safeParse({ auto_proceed: 1 });
			expect(result.success).toBe(false);
		});

		it('rejects null for auto_proceed', () => {
			const result = ExecutionProfileSchema.safeParse({ auto_proceed: null });
			expect(result.success).toBe(false);
		});
	});

	describe('PlanSchema integration', () => {
		it('PlanSchema parses plan with execution_profile field', () => {
			const planData = {
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'swarm-test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [],
					},
				],
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 2,
					council_parallel: false,
					locked: false,
					auto_proceed: true,
				},
			};
			const result = PlanSchema.safeParse(planData);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.execution_profile?.parallelization_enabled).toBe(true);
			expect(result.data.execution_profile?.max_concurrent_tasks).toBe(2);
			expect(result.data.execution_profile?.auto_proceed).toBe(true);
		});

		it('PlanSchema parses plan without execution_profile (optional)', () => {
			const planData = {
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'swarm-test',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [],
					},
				],
			};
			const result = PlanSchema.safeParse(planData);
			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.execution_profile).toBeUndefined();
		});
	});
});

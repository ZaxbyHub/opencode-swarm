import { describe, expect, test } from 'bun:test';
import type { ExecutionProfile } from '../../../src/config/plan-schema';
import {
	normalizeExecutionProfileForHash,
	renderPlanningProfileDirective,
	resolvePlanningProfile,
} from '../../../src/plan/planning-profile';

describe('planning-profile resolver', () => {
	test('defaults to balanced when execution_mode is not strict', () => {
		const resolved = resolvePlanningProfile({
			directory: process.cwd(),
			config: { execution_mode: 'balanced' },
		});
		expect(resolved).toEqual({
			effective: 'balanced',
			persisted: 'balanced',
			source: 'repository_default',
		});
	});

	test('defaults to strict when execution_mode is strict', () => {
		const resolved = resolvePlanningProfile({
			directory: process.cwd(),
			config: { execution_mode: 'strict' },
		});
		expect(resolved).toEqual({
			effective: 'strict',
			persisted: 'strict',
			source: 'repository_default',
		});
	});

	test('legacy locked profiles without the field resolve conservatively to strict', () => {
		const resolved = resolvePlanningProfile({
			directory: process.cwd(),
			existingExecutionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: false,
				locked: true,
				auto_proceed: false,
				commit_after_each_completed_task: false,
			},
			config: { execution_mode: 'balanced' },
		});
		expect(resolved).toEqual({
			effective: 'strict',
			persisted: undefined,
			source: 'legacy_locked_default',
		});
	});

	test('incoming planning_profile overrides persisted and repository defaults', () => {
		const resolved = resolvePlanningProfile({
			directory: process.cwd(),
			incomingExecutionProfile: {
				planning_profile: 'strict',
			},
			existingExecutionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				council_parallel: false,
				locked: false,
				auto_proceed: false,
				commit_after_each_completed_task: false,
				planning_profile: 'balanced',
			},
			config: { execution_mode: 'balanced' },
		});
		expect(resolved).toEqual({
			effective: 'strict',
			persisted: 'strict',
			source: 'incoming',
		});
	});
});

describe('normalizeExecutionProfileForHash', () => {
	function profile(
		overrides?: Partial<ExecutionProfile>,
	): NonNullable<ExecutionProfile> {
		return {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: true,
			auto_proceed: false,
			commit_after_each_completed_task: false,
			...overrides,
		};
	}

	test('retains explicit strict while omitting only the legacy default-false field', () => {
		expect(
			normalizeExecutionProfileForHash(profile({ planning_profile: 'strict' })),
		).toEqual({
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: true,
			auto_proceed: false,
			commit_after_each_completed_task: undefined,
			planning_profile: 'strict',
		});
	});

	test('retains balanced and explicit true fields in hashes', () => {
		expect(
			normalizeExecutionProfileForHash(
				profile({
					planning_profile: 'balanced',
					commit_after_each_completed_task: true,
				}),
			),
		).toEqual({
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: true,
			auto_proceed: false,
			commit_after_each_completed_task: true,
			planning_profile: 'balanced',
		});
	});
});

describe('planning-profile prompt directive', () => {
	test('balanced skips questionnaire/spec ceremony but preserves material decisions', () => {
		const directive = renderPlanningProfileDirective({
			effective: 'balanced',
			persisted: 'balanced',
			source: 'persisted',
		});
		expect(directive).toContain('effective=balanced');
		expect(directive).toContain('without pausing for the full questionnaire');
		expect(directive).toContain('unresolved material ambiguity');
		expect(directive).toContain('Do not require a spec solely as ceremony');
	});

	test('strict requires the full planning ceremony and preserves locked legacy semantics', () => {
		const directive = renderPlanningProfileDirective({
			effective: 'strict',
			persisted: undefined,
			source: 'legacy_locked_default',
		});
		expect(directive).toContain('effective=strict');
		expect(directive).toContain('require an effective spec');
		expect(directive).toContain('complete clarification funnel');
		expect(directive).toContain('without materializing a new hash field');
	});

	test('runtime authority explicitly supersedes the repository-default prompt', () => {
		const repositoryDefault = renderPlanningProfileDirective(
			{
				effective: 'balanced',
				persisted: 'balanced',
				source: 'repository_default',
			},
			'repository_default',
		);
		const runtime = renderPlanningProfileDirective({
			effective: 'strict',
			persisted: 'strict',
			source: 'persisted',
		});

		expect(repositoryDefault).toContain(
			'USE ONLY WHEN NO RUNTIME RESOLUTION EXISTS',
		);
		expect(runtime).toContain('CURRENT RUNTIME AUTHORITY');
		expect(runtime).toContain(
			'supersedes any planning-profile default in the base prompt',
		);
	});
});

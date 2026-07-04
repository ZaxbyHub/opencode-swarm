import { afterEach, describe, expect, test } from 'bun:test';
import { _internals, quality_budget } from '../../../src/tools/quality-budget';

describe('quality_budget tool - regression: full config surface', () => {
	const realQualityBudget = _internals.qualityBudget;

	afterEach(() => {
		_internals.qualityBudget = realQualityBudget;
	});

	test('execute accepts enforce_on_globs and exclude_globs config fields', async () => {
		let receivedConfig:
			| {
					enforce_on_globs?: string[];
					exclude_globs?: string[];
			  }
			| undefined;
		_internals.qualityBudget = async (input, _directory) => {
			receivedConfig = input.config;
			return {
				verdict: 'pass',
				metrics: {
					complexity_delta: 0,
					public_api_delta: 0,
					duplication_ratio: 0,
					test_to_code_ratio: 0,
					files_analyzed: [],
					thresholds: {
						enabled: true,
						max_complexity_delta: 5,
						max_public_api_delta: 10,
						max_duplication_ratio: 0.05,
						min_test_to_code_ratio: 0.3,
						enforce_on_globs: ['lib/**'],
						exclude_globs: ['generated/**'],
					},
					violations: [],
				},
				violations: [],
				summary: {
					files_analyzed: 0,
					violations_count: 0,
					errors_count: 0,
					warnings_count: 0,
				},
			};
		};

		const result = await quality_budget.execute(
			{
				changed_files: ['lib/a.ts'],
				config: {
					enforce_on_globs: ['lib/**'],
					exclude_globs: ['generated/**'],
				},
			},
			'/tmp/project',
		);

		expect(JSON.parse(result).verdict).toBe('pass');
		expect(receivedConfig?.enforce_on_globs).toEqual(['lib/**']);
		expect(receivedConfig?.exclude_globs).toEqual(['generated/**']);
	});
});

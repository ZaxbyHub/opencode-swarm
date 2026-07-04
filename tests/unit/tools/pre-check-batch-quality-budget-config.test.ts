import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	type PreCheckBatchInput,
	runPreCheckBatch,
} from '../../../src/tools/pre-check-batch';
import type { QualityBudgetInput } from '../../../src/tools/quality-budget';

describe('pre_check_batch - regression: quality budget config forwarding', () => {
	let tempDir: string;
	const realQualityBudget = _internals.qualityBudget;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-qb-config-')),
		);
		fs.writeFileSync(path.join(tempDir, 'target.ts'), 'export const x = 1;\n');
	});

	afterEach(() => {
		_internals.qualityBudget = realQualityBudget;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('passes gates.quality_budget into qualityBudget', async () => {
		let received: QualityBudgetInput | undefined;
		_internals.qualityBudget = mock(async (input: QualityBudgetInput) => {
			received = input;
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
						max_complexity_delta: 99,
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
		}) as typeof realQualityBudget;

		const input: PreCheckBatchInput = {
			files: ['target.ts'],
			directory: tempDir,
			config: {
				gates: {
					quality_budget: {
						enabled: true,
						max_complexity_delta: 99,
						enforce_on_globs: ['lib/**'],
						exclude_globs: ['generated/**'],
					},
				},
			} as PreCheckBatchInput['config'],
		};

		await runPreCheckBatch(input, tempDir, tempDir);

		expect(received?.config?.max_complexity_delta).toBe(99);
		expect(received?.config?.enforce_on_globs).toEqual(['lib/**']);
		expect(received?.config?.exclude_globs).toEqual(['generated/**']);
	});
});

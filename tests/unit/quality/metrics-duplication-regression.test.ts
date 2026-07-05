import { beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QualityBudgetConfig } from '../../../src/config/schema';
import { computeQualityMetrics } from '../../../src/quality/metrics';

function thresholds(
	overrides: Partial<QualityBudgetConfig> = {},
): QualityBudgetConfig {
	return {
		enabled: true,
		max_complexity_delta: 100,
		max_public_api_delta: 100,
		max_duplication_ratio: 0.05,
		min_test_to_code_ratio: 0,
		enforce_on_globs: ['src/**'],
		exclude_globs: [],
		...overrides,
	};
}

describe('quality metrics duplication - regression: repeated single lines', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-dup-regression-')),
		);
		fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
	});

	test('does not count isolated repeated syntax lines as duplicated blocks', async () => {
		const content = Array.from({ length: 20 }, (_, index) =>
			[`export function f${index}() {`, `  return ${index};`, '}'].join('\n'),
		).join('\n');
		fs.writeFileSync(path.join(tempDir, 'src', 'syntax.ts'), content);

		const result = await computeQualityMetrics(
			['src/syntax.ts'],
			thresholds(),
			tempDir,
		);

		expect(result.duplication_ratio).toBe(0);
		expect(result.violations.some((v) => v.type === 'duplication')).toBe(false);
	});

	test('counts copied contiguous blocks as duplicated code', async () => {
		const block = [
			'const alpha = 1;',
			'const beta = 2;',
			'const gamma = alpha + beta;',
			'if (gamma > 1) {',
			'  console.log(gamma);',
			'}',
			'for (const item of [alpha, beta]) {',
			'  console.log(item);',
			'}',
			'export const done = true;',
		].join('\n');
		fs.writeFileSync(
			path.join(tempDir, 'src', 'copied.ts'),
			`${block}\n${block}\n`,
		);

		const result = await computeQualityMetrics(
			['src/copied.ts'],
			thresholds({ max_duplication_ratio: 0.1 }),
			tempDir,
		);

		expect(result.duplication_ratio).toBeGreaterThan(0.1);
		expect(result.violations.some((v) => v.type === 'duplication')).toBe(true);
	});
});

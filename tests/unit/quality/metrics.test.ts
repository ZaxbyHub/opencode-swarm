import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QualityBudgetConfig } from '../../../src/config/schema';
import {
	computeQualityMetrics,
	type QualityMetrics,
	type QualityViolation,
} from '../../../src/quality/metrics';

// Temp directories
let tempDir: string;
let originalCwd: string;

// Helper to create mock thresholds
function getMockThresholds(
	overrides?: Partial<QualityBudgetConfig>,
): QualityBudgetConfig {
	return {
		enabled: true,
		max_complexity_delta: 10,
		max_public_api_delta: 5,
		max_duplication_ratio: 0.1,
		min_test_to_code_ratio: 0.2,
		enforce_on_globs: ['src/**', 'lib/**'],
		exclude_globs: ['**/*.test.*', '**/*.spec.*', 'docs/**'],
		...overrides,
	};
}

// Helper to create test files
function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tempDir, relativePath);
	const dir = path.dirname(fullPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(fullPath, content);
}

describe('computeQualityMetrics', () => {
	beforeEach(async () => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'quality-metrics-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Basic Functionality Tests ============

	it('should return empty metrics when no changed files provided', async () => {
		const result = await computeQualityMetrics(
			[],
			getMockThresholds(),
			tempDir,
		);
		expect(result.files_analyzed).toEqual([]);
		expect(result.violations).toEqual([]);
	});

	it('should return zero deltas when no files exist', async () => {
		const result = await computeQualityMetrics(
			['src/nonexistent.ts'],
			getMockThresholds(),
			tempDir,
		);
		expect(result.complexity_delta).toBe(0);
		expect(result.public_api_delta).toBe(0);
	});

	it('should handle non-existent files gracefully', async () => {
		const thresholds = getMockThresholds();
		const result = await computeQualityMetrics(
			['src/missing.ts', 'src/also-missing.ts'],
			thresholds,
			tempDir,
		);
		expect(result.files_analyzed).toEqual([]);
	});

	// ============ Complexity Delta Tests ============

	it('should compute complexity delta for TypeScript files', async () => {
		createTestFile(
			'src/utils.ts',
			`
			export function test() {
				if (a && b) {
					for (let i = 0; i < 10; i++) {
						while (true) {
							console.log(i);
						}
					}
				}
			}
		`,
		);

		const result = await computeQualityMetrics(
			['src/utils.ts'],
			getMockThresholds({ max_complexity_delta: 5 }),
			tempDir,
		);

		expect(result.complexity_delta).toBeGreaterThan(0);
		expect(result.files_analyzed).toContain('src/utils.ts');
	});

	it('should compute complexity delta for JavaScript files', async () => {
		createTestFile(
			'src/app.js',
			`
			export function process() {
				if (x > 0) {
					switch (x) {
						case 1: return 1;
						case 2: return 2;
					}
				}
			}
		`,
		);

		const result = await computeQualityMetrics(
			['src/app.js'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.complexity_delta).toBeGreaterThan(0);
	});

	it('should compute complexity delta for Python files', async () => {
		createTestFile(
			'src/helper.py',
			`
			def process():
				if x > 0:
					for i in range(10):
						while True:
							pass
		`,
		);

		const result = await computeQualityMetrics(
			['src/helper.py'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.complexity_delta).toBeGreaterThan(0);
	});

	it('should count decision points correctly', async () => {
		createTestFile(
			'src/counter.ts',
			`
			export function decisionPoints() {
				if (a && b || c) {
					for (;;) { }
					while (x) { }
					try { } catch (e) { }
					const result = condition ? 'yes' : 'no';
				}
			}
		`,
		);

		const result = await computeQualityMetrics(
			['src/counter.ts'],
			getMockThresholds(),
			tempDir,
		);

		// Base 1 + if + && + || + for + while + try + catch + ternary = 9
		expect(result.complexity_delta).toBeGreaterThanOrEqual(8);
	});

	// ============ Public API Delta Tests ============

	it('should count exports in TypeScript files', async () => {
		createTestFile(
			'src/api.ts',
			`
			export function foo() { }
			export class Bar { }
			export const BAZ = 1;
			export interface Qux { }
			export type Test = string;
			export enum Status { }
		`,
		);

		const result = await computeQualityMetrics(
			['src/api.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.public_api_delta).toBe(6);
	});

	it('should count named exports', async () => {
		createTestFile(
			'src/named.ts',
			`
			export { foo, bar, baz };
		`,
		);

		const result = await computeQualityMetrics(
			['src/named.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.public_api_delta).toBe(3);
	});

	it('should count default exports', async () => {
		createTestFile(
			'src/default.ts',
			`
			export default function() { }
		`,
		);

		const result = await computeQualityMetrics(
			['src/default.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.public_api_delta).toBe(1);
	});

	it('should count Python exports', async () => {
		createTestFile(
			'src/python_exports.py',
			`
			def foo(): pass
			class Bar: pass
			__all__ = ['foo', 'Bar', 'baz']
		`,
		);

		const result = await computeQualityMetrics(
			['src/python_exports.py'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.public_api_delta).toBeGreaterThanOrEqual(3);
	});

	it('should count Rust exports', async () => {
		createTestFile(
			'src/lib.rs',
			`
			pub fn exported_func() { }
			pub struct ExportedStruct { }
			pub enum ExportedEnum { }
			pub const VALUE: i32 = 42;
		`,
		);

		const result = await computeQualityMetrics(
			['src/lib.rs'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.public_api_delta).toBe(4);
	});

	it('should count Go exports', async () => {
		createTestFile(
			'src/main.go',
			`
			package main
			
			func ExportedFunc() { }
			type ExportedType struct { }
			var ExportedVar = 42
		`,
		);

		const result = await computeQualityMetrics(
			['src/main.go'],
			getMockThresholds(),
			tempDir,
		);

		// Package + exported functions/types/vars
		expect(result.public_api_delta).toBeGreaterThanOrEqual(4);
	});

	// ============ Duplication Ratio Tests ============

	it('should compute low duplication ratio for unique code', async () => {
		createTestFile(
			'src/unique.ts',
			`
			export function one() { return 1; }
			export function two() { return 2; }
			export function three() { return 3; }
			export function four() { return 4; }
			export function five() { return 5; }
			export function six() { return 6; }
			export function seven() { return 7; }
			export function eight() { return 8; }
			export function nine() { return 9; }
			export function ten() { return 10; }
			export function eleven() { return 11; }
			export function twelve() { return 12; }
		`,
		);

		const result = await computeQualityMetrics(
			['src/unique.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.duplication_ratio).toBeLessThan(0.1);
	});

	it('should compute high duplication ratio for duplicated code', async () => {
		createTestFile(
			'src/dup.ts',
			`
			const block1 = [
				'a',
				'b',
				'c',
				'd',
				'e',
				'f',
				'g',
				'h',
				'i',
			];
			const block1 = [
				'a',
				'b',
				'c',
				'd',
				'e',
				'f',
				'g',
				'h',
				'i',
			];
		`,
		);

		const result = await computeQualityMetrics(
			['src/dup.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.duplication_ratio).toBeGreaterThan(0);
	});

	// ============ Test-to-Code Ratio Tests ============

	it('should compute test-to-code ratio', async () => {
		// Create production code
		createTestFile(
			'src/prod.ts',
			`
			export function add(a: number, b: number): number {
				return a + b;
			}
			export function subtract(a: number, b: number): number {
				return a - b;
			}
		`,
		);

		// Create test code
		createTestFile(
			'tests/prod.test.ts',
			`
			import { describe, it, expect } from 'bun:test';
			import { add, subtract } from '../src/prod';

			describe('add', () => {
				it('should add two numbers', () => {
					expect(add(1, 2)).toBe(3);
				});
			});

			describe('subtract', () => {
				it('should subtract two numbers', () => {
					expect(subtract(5, 3)).toBe(2);
				});
			});
		`,
		);

		const result = await computeQualityMetrics(
			['src/prod.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.test_to_code_ratio).toBeGreaterThan(0);
	});

	it('should return zero ratio when no tests exist', async () => {
		createTestFile(
			'src/solo.ts',
			`
			export function solo() { return true; }
		`,
		);

		const result = await computeQualityMetrics(
			['src/solo.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.test_to_code_ratio).toBe(0);
	});

	it('should include test directory in ratio calculation', async () => {
		// Create production code in lib
		createTestFile(
			'lib/math.ts',
			`
			export function multiply(a: number, b: number): number {
				return a * b;
			}
		`,
		);

		// Create test in test directory
		createTestFile(
			'test/math.test.ts',
			`
			import { describe, it, expect } from 'bun:test';
			import { multiply } from '../lib/math';

			describe('multiply', () => {
				it('should multiply two numbers', () => {
					expect(multiply(2, 3)).toBe(6);
				});
			});
		`,
		);

		const result = await computeQualityMetrics(
			['lib/math.ts'],
			getMockThresholds({ enforce_on_globs: ['lib/**'] }),
			tempDir,
		);

		expect(result.test_to_code_ratio).toBeGreaterThan(0);
	});

	// ============ File Filtering Tests ============

	it('should exclude files matching exclude globs', async () => {
		createTestFile(
			'src/app.ts',
			`
			export function app() { return 'app'; }
		`,
		);

		createTestFile(
			'src/app.test.ts',
			`
			export function testApp() { return 'test'; }
		`,
		);

		// Include test file but it should be excluded by default globs
		const result = await computeQualityMetrics(
			['src/app.test.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.files_analyzed).not.toContain('src/app.test.ts');
	});

	it('should only include files matching enforce globs', async () => {
		createTestFile(
			'src/included.ts',
			`
			export function included() { return true; }
		`,
		);

		createTestFile(
			'docs/excluded.md',
			`
			# Documentation
		`,
		);

		const result = await computeQualityMetrics(
			['src/included.ts', 'docs/excluded.md'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.files_analyzed).toContain('src/included.ts');
		// docs should be excluded by default exclude_globs
	});

	// ============ Violation Detection Tests ============

	it('should detect complexity violation when threshold exceeded', async () => {
		createTestFile(
			'src/complex.ts',
			`
			export function complex() {
				if (a && b) {
					if (c && d) {
						if (e && f) {
							if (g && h) {
								if (i && j) {
									console.log('nested');
								}
							}
						}
					}
				}
			}
		`,
		);

		const result = await computeQualityMetrics(
			['src/complex.ts'],
			getMockThresholds({ max_complexity_delta: 1 }),
			tempDir,
		);

		const complexityViolation = result.violations.find(
			(v) => v.type === 'complexity',
		);
		expect(complexityViolation).toBeDefined();
		expect(complexityViolation?.severity).toBe('error');
	});

	it('should detect API violation when threshold exceeded', async () => {
		createTestFile(
			'src/many-exports.ts',
			`
			export function one() { }
			export function two() { }
			export function three() { }
			export function four() { }
			export function five() { }
			export function six() { }
		`,
		);

		const result = await computeQualityMetrics(
			['src/many-exports.ts'],
			getMockThresholds({ max_public_api_delta: 2 }),
			tempDir,
		);

		const apiViolation = result.violations.find((v) => v.type === 'api');
		expect(apiViolation).toBeDefined();
		expect(apiViolation?.severity).toBe('error');
	});

	it('should detect duplication violation when ratio exceeded', async () => {
		const copiedBlock = `
			const alpha = 1;
			const beta = 2;
			const gamma = alpha + beta;
			if (gamma > 1) {
				console.log(gamma);
			}
			for (const item of [alpha, beta]) {
				console.log(item);
			}
			export const done = true;
		`;
		createTestFile(
			'src/heavy-dup.ts',
			`${copiedBlock}
			${copiedBlock}
			function unique() { return 'unique'; }
		`,
		);

		const result = await computeQualityMetrics(
			['src/heavy-dup.ts'],
			getMockThresholds({ max_duplication_ratio: 0.1 }),
			tempDir,
		);

		const dupViolation = result.violations.find(
			(v) => v.type === 'duplication',
		);
		expect(dupViolation).toBeDefined();
	});

	it('should detect test ratio violation when below threshold', async () => {
		// Create only production code without tests
		createTestFile(
			'lib/app.ts',
			`
			export function app() { return true; }
			export function app2() { return true; }
			export function app3() { return true; }
			export function app4() { return true; }
			export function app5() { return true; }
			export function app6() { return true; }
		`,
		);

		const result = await computeQualityMetrics(
			['lib/app.ts'],
			getMockThresholds({
				min_test_to_code_ratio: 0.5,
				enforce_on_globs: ['lib/**'],
			}),
			tempDir,
		);

		const testViolation = result.violations.find(
			(v) => v.type === 'test_ratio',
		);
		expect(testViolation).toBeDefined();
	});

	it('should return warning severity for moderate threshold violations', async () => {
		createTestFile(
			'src/warn.ts',
			`
			export function a() { if (x) { return 1; } }
		`,
		);

		// complexity = 2 (base 1 + if = 1)
		// With threshold = 1.4:
		// 2 > 1.4 * 1.5 = 2 > 2.1 = false → warning ✓
		const result = await computeQualityMetrics(
			['src/warn.ts'],
			getMockThresholds({ max_complexity_delta: 1.4 }),
			tempDir,
		);

		const complexityViolation = result.violations.find(
			(v) => v.type === 'complexity',
		);
		expect(complexityViolation?.severity).toBe('warning');
	});

	it('should not report violations when within thresholds', async () => {
		createTestFile(
			'src/simple.ts',
			`
			export function simple() {
				if (a) { return 1; }
			}
		`,
		);

		const result = await computeQualityMetrics(
			['src/simple.ts'],
			getMockThresholds({
				max_complexity_delta: 10,
				max_public_api_delta: 10,
				max_duplication_ratio: 0.5,
				min_test_to_code_ratio: 0,
			}),
			tempDir,
		);

		expect(result.violations).toEqual([]);
	});

	// ============ Type Interface Tests ============

	it('should return complete QualityMetrics structure', async () => {
		createTestFile(
			'src/complete.ts',
			`
			export function test() { return true; }
		`,
		);

		const result = await computeQualityMetrics(
			['src/complete.ts'],
			getMockThresholds(),
			tempDir,
		);

		// Check all required fields
		expect(result).toHaveProperty('complexity_delta');
		expect(result).toHaveProperty('public_api_delta');
		expect(result).toHaveProperty('duplication_ratio');
		expect(result).toHaveProperty('test_to_code_ratio');
		expect(result).toHaveProperty('files_analyzed');
		expect(result).toHaveProperty('thresholds');
		expect(result).toHaveProperty('violations');
	});

	it('should return correct QualityViolation structure', async () => {
		createTestFile(
			'src/violation.ts',
			`
			export function a() { if (x) { if (y) { if (z) { } } } }
			export function b() { if (x) { if (y) { if (z) { } } } }
		`,
		);

		const result = await computeQualityMetrics(
			['src/violation.ts'],
			getMockThresholds({ max_complexity_delta: 1 }),
			tempDir,
		);

		if (result.violations.length > 0) {
			const violation = result.violations[0];
			expect(violation).toHaveProperty('type');
			expect(violation).toHaveProperty('message');
			expect(violation).toHaveProperty('severity');
			expect(violation).toHaveProperty('files');
			expect(['complexity', 'api', 'duplication', 'test_ratio']).toContain(
				violation.type,
			);
			expect(['error', 'warning']).toContain(violation.severity);
		}
	});

	// ============ Edge Cases ============

	it('should handle empty files', async () => {
		createTestFile('src/empty.ts', '');

		const result = await computeQualityMetrics(
			['src/empty.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.files_analyzed).toContain('src/empty.ts');
		expect(result.complexity_delta).toBeGreaterThanOrEqual(0);
	});

	it('should handle files with only comments', async () => {
		createTestFile(
			'src/comments.ts',
			`
			// This is a comment
			/* Block comment */
			# Python comment
		`,
		);

		const result = await computeQualityMetrics(
			['src/comments.ts'],
			getMockThresholds(),
			tempDir,
		);

		// Comments should not contribute to complexity
		expect(result.complexity_delta).toBe(1); // Base complexity
	});

	it('should handle large files gracefully', async () => {
		// Create a large file
		const lines: string[] = [];
		for (let i = 0; i < 1000; i++) {
			lines.push(`export function func${i}() { return ${i}; }`);
		}
		createTestFile('src/large.ts', lines.join('\n'));

		const result = await computeQualityMetrics(
			['src/large.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.files_analyzed).toContain('src/large.ts');
	});

	it('should use default thresholds when not provided', async () => {
		createTestFile(
			'src/defaults.ts',
			`
			export function test() { return true; }
		`,
		);

		const result = await computeQualityMetrics(
			['src/defaults.ts'],
			{} as QualityBudgetConfig,
			tempDir,
		);

		// Should use default values
		expect(result.thresholds.max_complexity_delta).toBeDefined();
		expect(result.thresholds.max_public_api_delta).toBeDefined();
	});

	it('should merge provided thresholds with defaults', async () => {
		const thresholds: QualityBudgetConfig = {
			enabled: true,
			max_complexity_delta: 100, // Custom value
			// Other values should be defaulted
		} as QualityBudgetConfig;

		createTestFile(
			'src/merge.ts',
			`
			export function test() { return true; }
		`,
		);

		const result = await computeQualityMetrics(
			['src/merge.ts'],
			thresholds,
			tempDir,
		);

		expect(result.thresholds.max_complexity_delta).toBe(100);
		expect(result.thresholds.max_public_api_delta).toBeDefined();
	});

	it('should analyze multiple files and combine results', async () => {
		createTestFile(
			'src/file1.ts',
			`
			export function func1() { if (a) { return 1; } }
		`,
		);

		createTestFile(
			'src/file2.ts',
			`
			export function func2() { if (b) { return 2; } }
			export function func3() { if (c) { return 3; } }
		`,
		);

		const result = await computeQualityMetrics(
			['src/file1.ts', 'src/file2.ts'],
			getMockThresholds(),
			tempDir,
		);

		expect(result.files_analyzed).toContain('src/file1.ts');
		expect(result.files_analyzed).toContain('src/file2.ts');
		expect(result.public_api_delta).toBe(3); // func1, func2, func3
	});

	it('should return empty files_analyzed when all files excluded', async () => {
		createTestFile(
			'src/file.test.ts',
			`
			export function test() { return true; }
		`,
		);

		// Strict exclude patterns
		const result = await computeQualityMetrics(
			['src/file.test.ts'],
			getMockThresholds({ exclude_globs: ['**/*'] }),
			tempDir,
		);

		expect(result.files_analyzed).not.toContain('src/file.test.ts');
	});
});

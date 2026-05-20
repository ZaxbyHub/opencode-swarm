import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, analyzeImpact } from '../../../src/test-impact/analyzer';

/**
 * Unit tests for the budget parameter in analyzeImpact.
 * Verifies:
 * 1. budget=undefined returns unlimited results
 * 2. budget=5 stops after 5 tests and returns budgetExceeded:true
 * 3. budget=0 returns empty results with budgetExceeded:true
 * 4. Multiple source files mapping to multiple tests counts each test toward budget
 */

let tempDir: string;
let originalLoadImpactMap: typeof _internals.loadImpactMap;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-budget-')),
	);
	// Save original and replace with mock
	originalLoadImpactMap = _internals.loadImpactMap;
});

afterEach(() => {
	// Restore original
	_internals.loadImpactMap = originalLoadImpactMap;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe('analyzeImpact budget parameter', () => {
	test('budget=undefined returns all impacted tests without budgetExceeded', async () => {
		// Set up a mock impact map with 10 tests for 3 source files
		const mockImpactMap: Record<string, string[]> = {
			'/project/src/a.ts': [
				'test_a1.test.ts',
				'test_a2.test.ts',
				'test_a3.test.ts',
				'test_a4.test.ts',
			],
			'/project/src/b.ts': [
				'test_b1.test.ts',
				'test_b2.test.ts',
				'test_b3.test.ts',
			],
			'/project/src/c.ts': [
				'test_c1.test.ts',
				'test_c2.test.ts',
				'test_c3.test.ts',
			],
		};
		_internals.loadImpactMap = mock(() => Promise.resolve(mockImpactMap));

		const result = await analyzeImpact(
			['/project/src/a.ts', '/project/src/b.ts', '/project/src/c.ts'],
			'/project',
			undefined,
		);

		expect(result.impactedTests.length).toBe(10);
		// budgetExceeded is false when no budget is set (field defaults to false, not undefined)
		expect(result.budgetExceeded).toBeFalsy();
	});

	test('budget=5 stops after 5 tests and returns budgetExceeded:true', async () => {
		// Set up a mock impact map with more than 5 tests
		const mockImpactMap: Record<string, string[]> = {
			'/project/src/a.ts': [
				'test_a1.test.ts',
				'test_a2.test.ts',
				'test_a3.test.ts',
			],
			'/project/src/b.ts': [
				'test_b1.test.ts',
				'test_b2.test.ts',
				'test_b3.test.ts',
				'test_b4.test.ts',
			],
			'/project/src/c.ts': [
				'test_c1.test.ts',
				'test_c2.test.ts',
				'test_c3.test.ts',
			],
		};
		_internals.loadImpactMap = mock(() => Promise.resolve(mockImpactMap));

		const result = await analyzeImpact(
			['/project/src/a.ts', '/project/src/b.ts', '/project/src/c.ts'],
			'/project',
			5,
		);

		expect(result.impactedTests.length).toBe(5);
		expect(result.budgetExceeded).toBe(true);
	});

	test('budget=0 returns empty results with budgetExceeded=true', async () => {
		// When budget=0, the outer loop breaks immediately (0 >= 0 is true)
		// and budgetExceeded is correctly set to true.
		const mockImpactMap: Record<string, string[]> = {
			'/project/src/a.ts': ['test_a1.test.ts', 'test_a2.test.ts'],
		};
		_internals.loadImpactMap = mock(() => Promise.resolve(mockImpactMap));

		const result = await analyzeImpact(['/project/src/a.ts'], '/project', 0);

		expect(result.impactedTests.length).toBe(0);
		expect(result.budgetExceeded).toBe(true);
	});

	test('multiple source files with multiple tests counts each test toward budget', async () => {
		// Source file a.ts has 2 tests, b.ts has 3 tests, c.ts has 2 tests
		// With budget=4, we should get 2 from a.ts + 2 from b.ts, then stop
		const mockImpactMap: Record<string, string[]> = {
			'/project/src/a.ts': ['test_a1.test.ts', 'test_a2.test.ts'],
			'/project/src/b.ts': [
				'test_b1.test.ts',
				'test_b2.test.ts',
				'test_b3.test.ts',
			],
			'/project/src/c.ts': ['test_c1.test.ts', 'test_c2.test.ts'],
		};
		_internals.loadImpactMap = mock(() => Promise.resolve(mockImpactMap));

		const result = await analyzeImpact(
			['/project/src/a.ts', '/project/src/b.ts', '/project/src/c.ts'],
			'/project',
			4,
		);

		expect(result.impactedTests.length).toBe(4);
		expect(result.budgetExceeded).toBe(true);
		// Should include both from a.ts and first two from b.ts
		expect(result.impactedTests).toContain('test_a1.test.ts');
		expect(result.impactedTests).toContain('test_a2.test.ts');
		expect(result.impactedTests).toContain('test_b1.test.ts');
		expect(result.impactedTests).toContain('test_b2.test.ts');
	});

	test('budget larger than total tests returns all tests without budgetExceeded', async () => {
		const mockImpactMap: Record<string, string[]> = {
			'/project/src/a.ts': ['test_a1.test.ts', 'test_a2.test.ts'],
		};
		_internals.loadImpactMap = mock(() => Promise.resolve(mockImpactMap));

		const result = await analyzeImpact(['/project/src/a.ts'], '/project', 100);

		expect(result.impactedTests.length).toBe(2);
		expect(result.budgetExceeded).toBe(false);
	});

	test('untestedFiles are correctly identified with budget limiting', async () => {
		const mockImpactMap: Record<string, string[]> = {
			'/project/src/a.ts': ['test_a1.test.ts'],
			'/project/src/b.ts': ['test_b1.test.ts'],
		};
		_internals.loadImpactMap = mock(() => Promise.resolve(mockImpactMap));

		// Request 3 changed files but only 2 have tests
		const result = await analyzeImpact(
			['/project/src/a.ts', '/project/src/b.ts', '/project/src/nonexistent.ts'],
			'/project',
			10,
		);

		expect(result.untestedFiles).toContain('/project/src/nonexistent.ts');
	});
});

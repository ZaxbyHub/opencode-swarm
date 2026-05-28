import { describe, expect, test } from 'bun:test';

// Import via _internals seam as specified in task
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { _internals } = require('../../../src/tools/test-runner');
const { selectHistoryForAnalysis, AGGREGATE_TEST_NAME } = _internals;

// TestRunRecord shape (mirrors history-store.ts)
interface TestRunRecord {
	testFile: string;
	testName: string;
	result: 'pass' | 'fail' | 'skip';
	timestamp?: number;
}

describe('selectHistoryForAnalysis', () => {
	describe('AGGREGATE_TEST_NAME constant', () => {
		test('AGGREGATE_TEST_NAME is "(aggregate)"', () => {
			expect(AGGREGATE_TEST_NAME).toBe('(aggregate)');
		});
	});

	describe('case 1: mixed aggregate + individual for same file', () => {
		test('aggregate record is removed when individual records exist for same file', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/utils/helper.test.ts',
					testName: 'helps with formatting',
					result: 'pass',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: 'handles edge cases',
					result: 'fail',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
				{
					testFile: 'src/otherthing/another.test.ts',
					testName: 'does something else',
					result: 'pass',
				},
				{
					testFile: 'src/otherthing/another.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
			];

			const result = selectHistoryForAnalysis(history);

			// Aggregate for helper.test.ts should be removed (individual records exist)
			expect(result).not.toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'pass',
			});

			// Aggregate for another.test.ts should be removed (individual record exists)
			expect(result).not.toContainEqual({
				testFile: 'src/otherthing/another.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'pass',
			});

			// Individual records should be kept
			expect(result).toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: 'helps with formatting',
				result: 'pass',
			});
			expect(result).toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: 'handles edge cases',
				result: 'fail',
			});
			expect(result).toContainEqual({
				testFile: 'src/otherthing/another.test.ts',
				testName: 'does something else',
				result: 'pass',
			});

			// Should have exactly 3 records (no aggregates)
			expect(result).toHaveLength(3);
		});
	});

	describe('case 2: all-aggregate history', () => {
		test('all aggregate records are kept when no individual records exist', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/feature.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
				{
					testFile: 'src/tools/other.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'fail',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'skip',
				},
			];

			const result = selectHistoryForAnalysis(history);

			// All aggregate records should be kept
			expect(result).toHaveLength(3);
			expect(result).toContainEqual({
				testFile: 'src/tools/feature.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'pass',
			});
			expect(result).toContainEqual({
				testFile: 'src/tools/other.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'fail',
			});
			expect(result).toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'skip',
			});
		});
	});

	describe('case 3: all-individual history', () => {
		test('all individual records are kept', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/utils/helper.test.ts',
					testName: 'test case 1',
					result: 'pass',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: 'test case 2',
					result: 'fail',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: 'test case 3',
					result: 'skip',
				},
			];

			const result = selectHistoryForAnalysis(history);

			// All individual records should be kept
			expect(result).toHaveLength(3);
			expect(result).toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: 'test case 1',
				result: 'pass',
			});
			expect(result).toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: 'test case 2',
				result: 'fail',
			});
			expect(result).toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: 'test case 3',
				result: 'skip',
			});
		});
	});

	describe('case 4: empty history', () => {
		test('returns empty array', () => {
			const history: TestRunRecord[] = [];

			const result = selectHistoryForAnalysis(history);

			expect(result).toHaveLength(0);
			expect(result).toEqual([]);
		});
	});

	describe('case 5: case sensitivity in file path matching', () => {
		test('file paths are compared case-insensitively', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/utils/HELPER.TEST.TS',
					testName: 'test case 1',
					result: 'pass',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'fail',
				},
			];

			const result = selectHistoryForAnalysis(history);

			// Aggregate should be removed because individual record exists for same file (case-insensitive)
			expect(result).toHaveLength(1);
			expect(result).toContainEqual({
				testFile: 'src/utils/HELPER.TEST.TS',
				testName: 'test case 1',
				result: 'pass',
			});
			expect(result).not.toContainEqual({
				testFile: 'src/utils/helper.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'fail',
			});
		});

		test('mixed case individual records remove aggregate with different case', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'Src/Utils/Helper.test.ts',
					testName: 'my test',
					result: 'pass',
				},
				{
					testFile: 'src/utils/helper.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
			];

			const result = selectHistoryForAnalysis(history);

			// Aggregate should be removed
			expect(result).toHaveLength(1);
			expect(result[0].testName).not.toBe(AGGREGATE_TEST_NAME);
		});
	});

	describe('case 6: various result types handled equally', () => {
		test('pass result type is handled equally', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/pass.test.ts',
					testName: 'should pass',
					result: 'pass',
				},
				{
					testFile: 'src/tools/pass.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
			];

			const result = selectHistoryForAnalysis(history);

			expect(result).toHaveLength(1);
			expect(result[0].result).toBe('pass');
			expect(result[0].testName).not.toBe(AGGREGATE_TEST_NAME);
		});

		test('fail result type is handled equally', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/fail.test.ts',
					testName: 'should fail',
					result: 'fail',
				},
				{
					testFile: 'src/tools/fail.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'fail',
				},
			];

			const result = selectHistoryForAnalysis(history);

			expect(result).toHaveLength(1);
			expect(result[0].result).toBe('fail');
			expect(result[0].testName).not.toBe(AGGREGATE_TEST_NAME);
		});

		test('skip result type is handled equally', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/skip.test.ts',
					testName: 'should skip',
					result: 'skip',
				},
				{
					testFile: 'src/tools/skip.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'skip',
				},
			];

			const result = selectHistoryForAnalysis(history);

			expect(result).toHaveLength(1);
			expect(result[0].result).toBe('skip');
			expect(result[0].testName).not.toBe(AGGREGATE_TEST_NAME);
		});
	});

	describe('edge cases', () => {
		test('single aggregate record with no individual records', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/only-aggregate.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
			];

			const result = selectHistoryForAnalysis(history);

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				testFile: 'src/tools/only-aggregate.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'pass',
			});
		});

		test('multiple individual records for same file removes aggregate', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/multi.test.ts',
					testName: 'test 1',
					result: 'pass',
				},
				{
					testFile: 'src/tools/multi.test.ts',
					testName: 'test 2',
					result: 'pass',
				},
				{
					testFile: 'src/tools/multi.test.ts',
					testName: 'test 3',
					result: 'fail',
				},
				{
					testFile: 'src/tools/multi.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'fail',
				},
			];

			const result = selectHistoryForAnalysis(history);

			expect(result).toHaveLength(3);
			expect(result.every((r) => r.testName !== AGGREGATE_TEST_NAME)).toBe(
				true,
			);
		});

		test('records with various testName values that are not aggregate', () => {
			const history: TestRunRecord[] = [
				{
					testFile: 'src/tools/various.test.ts',
					testName: '(aggregate)', // Looks like aggregate but isn't (different case)
					result: 'pass',
				},
				{
					testFile: 'src/tools/other.test.ts',
					testName: AGGREGATE_TEST_NAME,
					result: 'pass',
				},
				{
					testFile: 'src/tools/various.test.ts',
					testName: 'regular test name',
					result: 'fail',
				},
			];

			const result = selectHistoryForAnalysis(history);

			// The '(aggregate)' on various.test.ts IS removed (matches AGGREGATE_TEST_NAME + file has individual)
			// The AGGREGATE_TEST_NAME on other.test.ts is KEPT (no individual records for that file)
			expect(result).toHaveLength(2);
			expect(result).toContainEqual({
				testFile: 'src/tools/other.test.ts',
				testName: AGGREGATE_TEST_NAME,
				result: 'pass',
			});
			expect(result).toContainEqual({
				testFile: 'src/tools/various.test.ts',
				testName: 'regular test name',
				result: 'fail',
			});
		});
	});
});

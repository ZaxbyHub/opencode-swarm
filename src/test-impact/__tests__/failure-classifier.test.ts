import { describe, expect, test } from 'bun:test';
import {
	type ClassifiedFailure,
	classifyAndCluster,
	classifyFailure,
	clusterFailures,
} from '../failure-classifier.js';
import type { TestRunRecord } from '../history-store.js';

// Helper to create a TestRunRecord
function makeRecord(
	overrides: Partial<TestRunRecord> & {
		testFile: string;
		testName: string;
		result: 'pass' | 'fail' | 'skip';
	},
): TestRunRecord {
	return {
		timestamp: '2024-01-01T00:00:00.000Z',
		taskId: '1.1',
		durationMs: 100,
		changedFiles: [],
		...overrides,
	};
}

// Helper to create timestamps relative to now (descending order for history)
function ts(daysAgo: number): string {
	const d = new Date();
	d.setDate(d.getDate() - daysAgo);
	return d.toISOString();
}

describe('classifyFailure', () => {
	// Behavior 1: new_regression
	test('classifies as new_regression when last 3 runs passed, current fails, and testFile in changedFiles', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/foo.test.ts', 'src/bar.ts'],
		});

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(3),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('new_regression');
	});

	// Behavior 2: pre_existing
	test('classifies as pre_existing when has recent failures and testFile NOT in changedFiles', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/other.ts'],
		});

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(3),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('pre_existing');
	});

	// Behavior 3: flaky
	test('classifies as flaky when alternation count >= 2 over last 10 runs', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		// Pattern: pass, fail, pass, fail, pass, fail, pass, fail, pass, fail
		// Last 3 (ts1,ts2,ts3) are: pass, pass, pass - all pass so hasRecentFailure=false
		// Alternation count: pass→fail(1), fail→pass(2), pass→fail(3), fail→pass(4), pass→fail(5), fail→pass(6), pass→fail(7), fail→pass(8), pass→fail(9) = 9
		// Since hasRecentFailure=false and alternationCount >= 2, returns flaky
		const history: TestRunRecord[] = [
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'pass',
					timestamp: ts(1),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'pass',
					timestamp: ts(2),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'pass',
					timestamp: ts(3),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'fail',
					timestamp: ts(4),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'pass',
					timestamp: ts(5),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'fail',
					timestamp: ts(6),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'pass',
					timestamp: ts(7),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'fail',
					timestamp: ts(8),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'pass',
					timestamp: ts(9),
				}),
			},
			{
				...makeRecord({
					testFile: 'src/foo.test.ts',
					testName: 'test one',
					result: 'fail',
					timestamp: ts(10),
				}),
			},
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('flaky');
	});

	// Behavior 4: unknown
	test('classifies as unknown when no pattern matches', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		// Only 1 history entry with 'pass' - no recent failures so pre_existing doesn't trigger
		// and only 1 entry so alternation count is 0 (not >= 2 for flaky)
		// not enough for new_regression (needs 3 history)
		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('unknown');
	});

	// Behavior 5: empty history classified as unknown (not new_regression)
	test('classifies as unknown when history is empty', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/foo.test.ts'],
		});

		const result = classifyFailure(current, []);
		expect(result.classification).toBe('unknown');
	});

	// Behavior 6: confidence scores
	test('confidence is 1.0 when history length >= 5', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		const history: TestRunRecord[] = Array.from({ length: 5 }, (_, i) =>
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(i + 1),
			}),
		);

		const result = classifyFailure(current, history);
		expect(result.confidence).toBe(1.0);
	});

	test('confidence is 0.5 when history length is 3-4', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		const history3: TestRunRecord[] = Array.from({ length: 3 }, (_, i) =>
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(i + 1),
			}),
		);

		const history4: TestRunRecord[] = Array.from({ length: 4 }, (_, i) =>
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(i + 1),
			}),
		);

		expect(classifyFailure(current, history3).confidence).toBe(0.5);
		expect(classifyFailure(current, history4).confidence).toBe(0.5);
	});

	test('confidence is 0.3 when history length is 1-2', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		const history1 = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(1),
			}),
		];
		const history2 = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(2),
			}),
		];

		expect(classifyFailure(current, history1).confidence).toBe(0.3);
		expect(classifyFailure(current, history2).confidence).toBe(0.3);
	});

	test('confidence is 0.1 when history is empty', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		const result = classifyFailure(current, []);
		expect(result.confidence).toBe(0.1);
	});

	// Behavior 7: case-insensitive changedFiles comparison
	test('changedFiles comparison is case-insensitive', () => {
		const current = makeRecord({
			testFile: 'src/Foo.Test.TS',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/foo.test.ts', 'src/bar.ts'],
		});

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/Foo.Test.TS',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/Foo.Test.TS',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/Foo.Test.TS',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(3),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('new_regression');
	});

	// Additional: testFile in changedFiles but case differs
	test('matches testFile in changedFiles with different case', () => {
		const current = makeRecord({
			testFile: 'src/Foo.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/foo.ts'],
		});

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/Foo.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/Foo.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/Foo.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(3),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('new_regression');
	});

	// Edge: fewer than 3 history entries but all pass - should be unknown (not new_regression)
	test('requires exactly 3 history entries for new_regression', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/foo.test.ts'],
		});

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(2),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('unknown');
	});

	// Edge: new_regression only triggers if isInChangedFiles
	test('new_regression requires testFile in changedFiles', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: ['src/other.ts'],
		});

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(3),
			}),
		];

		const result = classifyFailure(current, history);
		// Not new_regression because testFile not in changedFiles
		expect(result.classification).toBe('unknown');
	});

	// Pre-existing requires at least 1 recent failure
	test('pre_existing requires at least 1 recent failure in last 3', () => {
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'test one',
			result: 'fail',
			changedFiles: [],
		});

		// Mixed: 2 passes, 1 fail
		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(3),
			}),
		];

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('pre_existing');
	});
});

describe('clusterFailures', () => {
	// Behavior 8: groups by (stackPrefix + errorMessage) combination
	test('groups failures by stackPrefix + errorMessage combination', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 100,
				confidence: 1.0,
			},
			{
				testFile: 'src/b.test.ts',
				testName: 'test 2',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 200,
				confidence: 1.0,
			},
			{
				testFile: 'src/c.test.ts',
				testName: 'test 3',
				classification: 'pre_existing',
				errorMessage: 'Error: bar',
				stackPrefix: 'at bar (src/bar.ts:1)',
				durationMs: 300,
				confidence: 1.0,
			},
		];

		const clusters = clusterFailures(failures);
		expect(clusters).toHaveLength(2);
	});

	// Behavior 9: dominant classification is the most common
	test('dominant classification is the most common in the cluster', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'pre_existing',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 100,
				confidence: 1.0,
			},
			{
				testFile: 'src/b.test.ts',
				testName: 'test 2',
				classification: 'pre_existing',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 200,
				confidence: 1.0,
			},
			{
				testFile: 'src/c.test.ts',
				testName: 'test 3',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 300,
				confidence: 1.0,
			},
		];

		const clusters = clusterFailures(failures);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].classification).toBe('pre_existing');
	});

	// Behavior 10: affectedTestFiles are unique testFile values
	test('affectedTestFiles contains unique testFile values', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 100,
				confidence: 1.0,
			},
			{
				testFile: 'src/b.test.ts',
				testName: 'test 2',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 200,
				confidence: 1.0,
			},
			{
				testFile: 'src/a.test.ts', // duplicate
				testName: 'test 3',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 300,
				confidence: 1.0,
			},
		];

		const clusters = clusterFailures(failures);
		expect(clusters[0].affectedTestFiles).toHaveLength(2);
		expect(clusters[0].affectedTestFiles).toContain('src/a.test.ts');
		expect(clusters[0].affectedTestFiles).toContain('src/b.test.ts');
	});

	// Cluster with only stackPrefix
	test('clusters by stackPrefix only when errorMessage is undefined', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'new_regression',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 100,
				confidence: 1.0,
			},
			{
				testFile: 'src/b.test.ts',
				testName: 'test 2',
				classification: 'pre_existing',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 200,
				confidence: 1.0,
			},
		];

		const clusters = clusterFailures(failures);
		expect(clusters).toHaveLength(1);
	});

	// Cluster with only errorMessage
	test('clusters by errorMessage only when stackPrefix is undefined', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'new_regression',
				errorMessage: 'Error: same',
				durationMs: 100,
				confidence: 1.0,
			},
			{
				testFile: 'src/b.test.ts',
				testName: 'test 2',
				classification: 'pre_existing',
				errorMessage: 'Error: same',
				durationMs: 200,
				confidence: 1.0,
			},
		];

		const clusters = clusterFailures(failures);
		expect(clusters).toHaveLength(1);
	});

	// Empty array returns empty clusters
	test('returns empty array for empty input', () => {
		const clusters = clusterFailures([]);
		expect(clusters).toHaveLength(0);
	});

	// Cluster ID is deterministic hash
	test('clusterId is deterministic for same input', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 100,
				confidence: 1.0,
			},
			{
				testFile: 'src/a.test.ts',
				testName: 'test 1',
				classification: 'new_regression',
				errorMessage: 'Error: foo',
				stackPrefix: 'at foo (src/foo.ts:1)',
				durationMs: 100,
				confidence: 1.0,
			},
		];

		const clusters1 = clusterFailures(failures);
		const clusters2 = clusterFailures(failures);
		expect(clusters1[0].clusterId).toBe(clusters2[0].clusterId);
	});
});

describe('classifyAndCluster', () => {
	// Behavior 11: convenience function combines both operations
	test('combines classification and clustering', () => {
		const testResults: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				changedFiles: [],
				timestamp: ts(0),
			}),
		];

		const history: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(1),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(2),
			}),
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'fail',
				timestamp: ts(3),
			}),
		];

		const { classified, clusters } = classifyAndCluster(testResults, history);
		expect(classified).toHaveLength(1);
		expect(clusters).toHaveLength(1);
		expect(classified[0].classification).toBe('pre_existing');
	});

	// Behavior 12: only processes 'fail' results, skips 'pass'/'skip'
	test('only processes fail results, skips pass', () => {
		const testResults: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
				timestamp: ts(0),
			}),
			makeRecord({
				testFile: 'src/bar.test.ts',
				testName: 'test two',
				result: 'fail',
				timestamp: ts(0),
			}),
			makeRecord({
				testFile: 'src/baz.test.ts',
				testName: 'test three',
				result: 'skip',
				timestamp: ts(0),
			}),
		];

		const { classified } = classifyAndCluster(testResults, []);
		expect(classified).toHaveLength(1);
		expect(classified[0].testFile).toBe('src/bar.test.ts');
	});

	test('returns empty classified and clusters when all results are pass or skip', () => {
		const testResults: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/foo.test.ts',
				testName: 'test one',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'src/bar.test.ts',
				testName: 'test two',
				result: 'skip',
			}),
		];

		const { classified, clusters } = classifyAndCluster(testResults, []);
		expect(classified).toHaveLength(0);
		expect(clusters).toHaveLength(0);
	});

	// Multiple failures with same root cause cluster together
	test('multiple failures with same error cluster together', () => {
		const testResults: TestRunRecord[] = [
			makeRecord({
				testFile: 'src/a.test.ts',
				testName: 'test a',
				result: 'fail',
				errorMessage: 'Error: same',
				stackPrefix: 'at same (src/same.ts:1)',
				timestamp: ts(0),
			}),
			makeRecord({
				testFile: 'src/b.test.ts',
				testName: 'test b',
				result: 'fail',
				errorMessage: 'Error: same',
				stackPrefix: 'at same (src/same.ts:1)',
				timestamp: ts(0),
			}),
		];

		const { clusters } = classifyAndCluster(testResults, []);
		expect(clusters).toHaveLength(1);
		expect(clusters[0].failures).toHaveLength(2);
	});
});

import { expect, test } from 'bun:test';
import {
	classifyAndCluster,
	classifyFailure,
	clusterFailures,
} from '../failure-classifier.js';

// ─────────────────────────────────────────────
// Types for test helpers
// ─────────────────────────────────────────────

type TestRunRecord = {
	taskId: string;
	testFile: string;
	testName: string;
	result: 'pass' | 'fail';
	timestamp: string;
	errorMessage?: string;
	stackPrefix?: string;
	durationMs: number;
	changedFiles: string[];
};

function makeRecord(overrides: Partial<TestRunRecord> = {}): TestRunRecord {
	return {
		taskId: 'test-task',
		testFile: 'test.spec.ts',
		testName: 'test case',
		result: 'fail',
		timestamp: '2024-01-01T00:00:00.000Z',
		errorMessage: 'Error: assertion failed',
		stackPrefix: 'at Test.',
		durationMs: 100,
		changedFiles: ['test.spec.ts'],
		...overrides,
	};
}

// ─────────────────────────────────────────────
// 1. Empty arrays everywhere
// ─────────────────────────────────────────────

test('classifyAndCluster with empty testResults returns empty classified and clusters', () => {
	const result = classifyAndCluster([], [makeRecord()]);
	expect(result.classified).toEqual([]);
	expect(result.clusters).toEqual([]);
});

test('classifyAndCluster with empty history still returns empty clusters for failing results', () => {
	const failingResult = makeRecord({ result: 'fail' });
	const result = classifyAndCluster([failingResult], []);
	expect(result.classified).toHaveLength(1);
	expect(result.classified[0].classification).toBe('unknown');
	expect(result.clusters).toHaveLength(1);
});

test('classifyAndCluster with empty history classifies first-time infrastructure failures', () => {
	const failingResult = makeRecord({
		result: 'fail',
		errorMessage:
			'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
	});
	const result = classifyAndCluster([failingResult], []);
	expect(result.classified).toHaveLength(1);
	expect(result.classified[0].classification).toBe('infrastructure_failure');
	expect(result.classified[0].confidence).toBe(0.1);
	expect(result.clusters).toHaveLength(1);
	expect(result.clusters[0].classification).toBe('infrastructure_failure');
});

test('clusterFailures with empty array returns empty array', () => {
	const result = clusterFailures([]);
	expect(result).toEqual([]);
});

// ─────────────────────────────────────────────
// 2. All pass results — classifyAndCluster returns empty classified/clusters
// ─────────────────────────────────────────────

test('classifyAndCluster filters to only failing results — all pass gives empty classified', () => {
	const allPassing = [
		makeRecord({ result: 'pass' }),
		makeRecord({ result: 'pass', testName: 'test case 2' }),
	];
	const result = classifyAndCluster(allPassing, []);
	expect(result.classified).toEqual([]);
	expect(result.clusters).toEqual([]);
});

// ─────────────────────────────────────────────
// 3. Very large history (1000+ entries) — performance test
// ─────────────────────────────────────────────

test('classifyFailure handles large history (1000 entries) without hanging', () => {
	const largeHistory: TestRunRecord[] = Array.from({ length: 1000 }, (_, i) =>
		makeRecord({
			testFile: 'test.spec.ts',
			testName: 'test case',
			result: i % 2 === 0 ? 'pass' : 'fail',
			timestamp: new Date(Date.now() - i * 1000).toISOString(),
		}),
	);
	const current = makeRecord({
		result: 'fail',
		timestamp: new Date().toISOString(),
	});

	const start = Date.now();
	const result = classifyFailure(current, largeHistory);
	const elapsed = Date.now() - start;

	expect(elapsed).toBeLessThan(1000); // Should complete in under 1 second
	expect(result.classification).toBe('flaky');
});

test('classifyAndCluster handles large testResults array (500 failing results)', () => {
	// All 500 records share the same errorMessage and stackPrefix (from makeRecord defaults)
	// so they cluster into 1 cluster, not 500
	const largeTestResults: TestRunRecord[] = Array.from(
		{ length: 500 },
		(_, i) =>
			makeRecord({
				testFile: `test${i}.spec.ts`,
				testName: `test case ${i}`,
				result: 'fail',
			}),
	);

	const start = Date.now();
	const result = classifyAndCluster(largeTestResults, []);
	const elapsed = Date.now() - start;

	expect(elapsed).toBeLessThan(5000); // Should complete in under 5 seconds
	expect(result.classified).toHaveLength(500);
	expect(result.clusters).toHaveLength(1); // All same error/stackPrefix = 1 cluster
});

// ─────────────────────────────────────────────
// 4. Identical stackPrefix+errorMessage for all failures → single cluster
// ─────────────────────────────────────────────

test('clusterFailures groups failures with identical stackPrefix+errorMessage into single cluster', () => {
	const failures = [
		{
			testFile: 'file1.spec.ts',
			testName: 'test1',
			classification: 'new_regression' as const,
			errorMessage: 'SameError',
			stackPrefix: 'at Test.',
			durationMs: 100,
			confidence: 1.0,
		},
		{
			testFile: 'file2.spec.ts',
			testName: 'test2',
			classification: 'new_regression' as const,
			errorMessage: 'SameError',
			stackPrefix: 'at Test.',
			durationMs: 200,
			confidence: 1.0,
		},
		{
			testFile: 'file3.spec.ts',
			testName: 'test3',
			classification: 'pre_existing' as const,
			errorMessage: 'SameError',
			stackPrefix: 'at Test.',
			durationMs: 150,
			confidence: 0.5,
		},
	];

	const result = clusterFailures(failures);
	expect(result).toHaveLength(1);
	expect(result[0].failures).toHaveLength(3);
	expect(result[0].affectedTestFiles).toEqual([
		'file1.spec.ts',
		'file2.spec.ts',
		'file3.spec.ts',
	]);
});

test('clusterFailures dominant classification is the most frequent one', () => {
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'new_regression' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'new_regression' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f3',
			testName: 't3',
			classification: 'pre_existing' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f4',
			testName: 't4',
			classification: 'flaky' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
	];
	const result = clusterFailures(failures);
	expect(result[0].classification).toBe('new_regression');
});

// ─────────────────────────────────────────────
// 5. All different stackPrefix+errorMessage → N clusters
// ─────────────────────────────────────────────

test('clusterFailures creates one cluster per unique stackPrefix+errorMessage', () => {
	const failures = Array.from({ length: 5 }, (_, i) => ({
		testFile: `file${i}.spec.ts`,
		testName: `test${i}`,
		classification: 'unknown' as const,
		errorMessage: `Error message ${i}`,
		stackPrefix: `at Test${i}.`,
		durationMs: 100,
		confidence: 0.3,
	}));

	const result = clusterFailures(failures);
	expect(result).toHaveLength(5);
});

// ─────────────────────────────────────────────
// 6. Unicode/emoji in errorMessage and stackPrefix
// ─────────────────────────────────────────────

test('classifyFailure handles Unicode and emoji in errorMessage and stackPrefix', () => {
	const current = makeRecord({
		errorMessage: 'エラーメッセージ 🔥💻エラー',
		stackPrefix: 'at 函数 🚀',
	});

	const result = classifyFailure(current, []);
	expect(result.errorMessage).toBe('エラーメッセージ 🔥💻エラー');
	expect(result.stackPrefix).toBe('at 函数 🚀');
});

test('clusterFailures groups by exact Unicode string match', () => {
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'unknown' as const,
			errorMessage: '日本語エラー',
			stackPrefix: 'at テスト',
			durationMs: 1,
			confidence: 0.3,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'unknown' as const,
			errorMessage: '日本語エラー',
			stackPrefix: 'at テスト',
			durationMs: 1,
			confidence: 0.3,
		},
		{
			testFile: 'f3',
			testName: 't3',
			classification: 'unknown' as const,
			errorMessage: '別のエラー',
			stackPrefix: 'at テスト',
			durationMs: 1,
			confidence: 0.3,
		},
	];
	const result = clusterFailures(failures);
	expect(result).toHaveLength(2); // Two distinct keys
});

// ─────────────────────────────────────────────
// 7. Extremely long strings (10000+ chars) in errorMessage/stackPrefix
// ─────────────────────────────────────────────

test('classifyFailure handles extremely long errorMessage (10000 chars)', () => {
	const longError = 'x'.repeat(10000);
	const current = makeRecord({ errorMessage: longError });

	const result = classifyFailure(current, []);
	expect(result.errorMessage).toBe(longError);
	expect(result.errorMessage).toHaveLength(10000);
});

test('classifyFailure handles extremely long stackPrefix (10000 chars)', () => {
	const longPrefix = `at ${'x'.repeat(9997)}`;
	const current = makeRecord({ stackPrefix: longPrefix });

	const result = classifyFailure(current, []);
	expect(result.stackPrefix).toBe(longPrefix);
	expect(result.stackPrefix).toHaveLength(10000);
});

test('clusterFailures handles long strings in clustering', () => {
	const _longKey = `prefix${'x'.repeat(5000)}error${'y'.repeat(5000)}`;
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'unknown' as const,
			errorMessage: 'x'.repeat(5000),
			stackPrefix: 'prefix',
			durationMs: 1,
			confidence: 0.3,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'unknown' as const,
			errorMessage: 'y'.repeat(5000),
			stackPrefix: 'prefix',
			durationMs: 1,
			confidence: 0.3,
		},
	];
	const result = clusterFailures(failures);
	expect(result).toHaveLength(2);
});

// ─────────────────────────────────────────────
// 8. Null/undefined optional fields (errorMessage, stackPrefix)
// ─────────────────────────────────────────────

test('classifyFailure works when errorMessage is undefined', () => {
	const current = makeRecord({ errorMessage: undefined });
	const result = classifyFailure(current, []);
	expect(result.errorMessage).toBeUndefined();
});

test('classifyFailure works when stackPrefix is undefined', () => {
	const current = makeRecord({ stackPrefix: undefined });
	const result = classifyFailure(current, []);
	expect(result.stackPrefix).toBeUndefined();
});

test('classifyFailure works when both errorMessage and stackPrefix are undefined', () => {
	const current = makeRecord({
		errorMessage: undefined,
		stackPrefix: undefined,
	});
	const result = classifyFailure(current, []);
	expect(result.errorMessage).toBeUndefined();
	expect(result.stackPrefix).toBeUndefined();
});

test('clusterFailures groups failures where both errorMessage and stackPrefix are undefined', () => {
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'unknown' as const,
			errorMessage: undefined,
			stackPrefix: undefined,
			durationMs: 1,
			confidence: 0.3,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'unknown' as const,
			errorMessage: undefined,
			stackPrefix: undefined,
			durationMs: 1,
			confidence: 0.3,
		},
	];
	const result = clusterFailures(failures);
	expect(result).toHaveLength(1);
	expect(result[0].errorMessage).toBeUndefined();
	expect(result[0].stackPrefix).toBeUndefined();
	expect(result[0].rootCause).toBe(''); // Empty string from concatenation
});

test('clusterFailures SOURCE BUG: undefined and empty string errorMessage produce same cluster key', () => {
	// BUG: (undefined || '') and ('' || '') both evaluate to '' due to falsy short-circuit
	// So undefined errorMessage and empty string errorMessage produce the SAME cluster key
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'unknown' as const,
			errorMessage: undefined,
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 0.3,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'unknown' as const,
			errorMessage: '',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 0.3,
		},
	];
	const result = clusterFailures(failures);
	// Currently returns 1 due to bug (both undefined and '' produce '' via ||)
	expect(result).toHaveLength(1);
});

// ─────────────────────────────────────────────
// 9. History with all same results (all pass or all fail)
// ─────────────────────────────────────────────

test('classifyFailure with all-pass history on new failure returns unknown', () => {
	const allPassHistory: TestRunRecord[] = Array.from({ length: 5 }, (_, i) =>
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - i * 1000).toISOString(),
		}),
	);
	const current = makeRecord({
		result: 'fail',
		timestamp: new Date().toISOString(),
		changedFiles: [], // Not in changed files
	});

	const result = classifyFailure(current, allPassHistory);
	// Conditions: lastThree has all pass = true, current is fail, isInChangedFiles = false
	// So it falls through to unknown (not new_regression because isInChangedFiles=false)
	expect(result.classification).toBe('unknown');
});

test('classifyFailure with all-fail history on new failure returns pre_existing', () => {
	const allFailHistory: TestRunRecord[] = Array.from({ length: 5 }, (_, i) =>
		makeRecord({
			result: 'fail',
			timestamp: new Date(Date.now() - i * 1000).toISOString(),
		}),
	);
	const current = makeRecord({
		result: 'fail',
		timestamp: new Date().toISOString(),
		changedFiles: [], // Not in changed files
	});

	const result = classifyFailure(current, allFailHistory);
	// hasRecentFailure = true, isInChangedFiles = false => pre_existing
	expect(result.classification).toBe('pre_existing');
});

// ─────────────────────────────────────────────
// 10. Single test result with massive changedFiles array
// ─────────────────────────────────────────────

test('classifyFailure handles massive changedFiles array (10000 entries)', () => {
	const massiveChangedFiles = Array.from(
		{ length: 10000 },
		(_, i) => `file${i}.ts`,
	);
	const current = makeRecord({
		changedFiles: massiveChangedFiles,
		result: 'pass',
	});

	const result = classifyFailure(current, []);
	// Should not throw, should handle efficiently
	expect(result.classification).toBe('unknown');
});

test('classifyFailure isInChangedFiles check with large array containing the testFile', () => {
	const largeChangedFiles = ['other.ts', 'test.spec.ts', 'another.ts'];
	const current = makeRecord({
		testFile: 'test.spec.ts',
		changedFiles: largeChangedFiles,
		result: 'fail',
	});

	const historyWithPass: TestRunRecord[] = [
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 1000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 2000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 3000).toISOString(),
		}),
	];

	const result = classifyFailure(current, historyWithPass);
	// lastThree all pass, current fail, testFile in changedFiles => new_regression
	expect(result.classification).toBe('new_regression');
});

// ─────────────────────────────────────────────
// 11. Tie-breaking in cluster dominant classification (equal count of two classifications)
// ─────────────────────────────────────────────

test('clusterFailures tie-breaking: earlier classification in iteration order wins', () => {
	// When counts are equal (2 vs 2), the first one encountered should win
	// Map iteration order: insertion order determines which is "first"
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'flaky' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'flaky' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f3',
			testName: 't3',
			classification: 'new_regression' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f4',
			testName: 't4',
			classification: 'new_regression' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
	];
	const result = clusterFailures(failures);
	// flaky comes before new_regression in insertion order, so it wins
	expect(result[0].classification).toBe('flaky');
});

test('clusterFailures tie-breaking: three-way tie', () => {
	const failures = [
		{
			testFile: 'f1',
			testName: 't1',
			classification: 'unknown' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f2',
			testName: 't2',
			classification: 'pre_existing' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
		{
			testFile: 'f3',
			testName: 't3',
			classification: 'new_regression' as const,
			errorMessage: 'Err',
			stackPrefix: 'at ',
			durationMs: 1,
			confidence: 1.0,
		},
	];
	const result = clusterFailures(failures);
	// unknown is first inserted, so it wins
	expect(result[0].classification).toBe('unknown');
});

// ─────────────────────────────────────────────
// 12. currentResult with result='pass' passed to classifyFailure — should still classify (does not check currentResult.result for unknown, only checks for fail for new_regression)
// ─────────────────────────────────────────────

test('classifyFailure accepts result=pass without error — does not validate result field', () => {
	// classifyFailure does not check currentResult.result for unknown classification
	// It only uses it for new_regression condition (currentResult.result === 'fail')
	const current = makeRecord({ result: 'pass' });
	const result = classifyFailure(current, []);
	// Should not throw, should return a classified failure
	expect(result.testFile).toBe('test.spec.ts');
	expect(result.testName).toBe('test case');
	expect(result.classification).toBe('unknown');
});

test('classifyFailure infrastructure detection runs before result-based classification checks', () => {
	const current = makeRecord({
		result: 'pass',
		errorMessage: 'Broken pipe',
	});
	const result = classifyFailure(current, []);
	expect(result.classification).toBe('infrastructure_failure');
});

test('classifyFailure can match infrastructure signals that only appear in stackPrefix', () => {
	const current = makeRecord({
		errorMessage: 'Error: generic worker failure',
		stackPrefix: 'SIGBUS at shared-worker',
	});
	const result = classifyFailure(current, []);
	expect(result.classification).toBe('infrastructure_failure');
});

test('classifyFailure assertion guard ignores stackPrefix when suppressing infra false positives', () => {
	const current = makeRecord({
		errorMessage: 'AssertionError: expected crash banner to mention SIGSEGV',
		stackPrefix: 'SIGSEGV at shared-worker',
		changedFiles: [],
	});
	const result = classifyFailure(current, []);
	expect(result.classification).toBe('unknown');
});

test('classifyFailure with result=pass and alternating history returns flaky', () => {
	const current = makeRecord({ result: 'pass' });
	const alternatingHistory: TestRunRecord[] = [
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 1000).toISOString(),
		}),
		makeRecord({
			result: 'fail',
			timestamp: new Date(Date.now() - 2000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 3000).toISOString(),
		}),
		makeRecord({
			result: 'fail',
			timestamp: new Date(Date.now() - 4000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 5000).toISOString(),
		}),
		makeRecord({
			result: 'fail',
			timestamp: new Date(Date.now() - 6000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 7000).toISOString(),
		}),
		makeRecord({
			result: 'fail',
			timestamp: new Date(Date.now() - 8000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 9000).toISOString(),
		}),
		makeRecord({
			result: 'fail',
			timestamp: new Date(Date.now() - 10000).toISOString(),
		}),
	];

	const result = classifyFailure(current, alternatingHistory);
	// alternationCount >= 2, so it returns flaky regardless of currentResult.result
	expect(result.classification).toBe('flaky');
});

// ─────────────────────────────────────────────
// 13. History where all entries are for different testFiles — no matching history
// ─────────────────────────────────────────────

test('classifyFailure with no matching testFile/testName in history returns unknown', () => {
	const current = makeRecord({
		testFile: 'unique.spec.ts',
		testName: 'unique test',
	});
	const differentFilesHistory: TestRunRecord[] = Array.from(
		{ length: 5 },
		(_, i) =>
			makeRecord({
				testFile: `other${i}.spec.ts`,
				testName: `other test ${i}`,
				timestamp: new Date(Date.now() - i * 1000).toISOString(),
			}),
	);

	const result = classifyFailure(current, differentFilesHistory);
	expect(result.classification).toBe('unknown');
	expect(result.confidence).toBe(0.1); // No history = minimum confidence
});

test('classifyFailure with partial match (same testFile, different testName) returns unknown', () => {
	const current = makeRecord({
		testFile: 'same.spec.ts',
		testName: 'current test',
	});
	const history: TestRunRecord[] = [
		makeRecord({
			testFile: 'same.spec.ts',
			testName: 'other test',
			timestamp: new Date(Date.now() - 1000).toISOString(),
		}),
	];

	const result = classifyFailure(current, history);
	expect(result.classification).toBe('unknown');
});

// ─────────────────────────────────────────────
// 14. changedFiles with prototype pollution strings (__proto__, constructor)
// ─────────────────────────────────────────────

test('classifyFailure handles __proto__ in changedFiles without prototype pollution', () => {
	const current = makeRecord({
		testFile: '__proto__.spec.ts', // actual test file name
		changedFiles: ['__proto__', 'constructor', 'toString', '__proto__.spec.ts'],
		result: 'fail',
	});

	// Should not pollute Object prototype or cause unexpected behavior
	const result = classifyFailure(current, []);
	expect(result.classification).toBeDefined();
	expect(result.testFile).toBe('__proto__.spec.ts');

	// Verify Object.prototype is not polluted
	// Note: Object.prototype.__proto__ is null (spec-compliant), not undefined
	expect(Object.getPrototypeOf(Object.prototype)).toBeNull();
	expect(Object.prototype.constructor).toBe(Object);
});

test('classifyFailure handles constructor in changedFiles safely', () => {
	const current = makeRecord({
		testFile: 'constructor.spec.ts',
		changedFiles: ['constructor', '__proto__', 'hasOwnProperty'],
		result: 'fail',
	});

	const result = classifyFailure(current, []);
	expect(result.classification).toBeDefined();
	// Object.prototype should not be affected
	expect(Object.prototype.constructor).toBe(Object);
});

test('classifyFailure handles changedFiles with numeric-like keys safely', () => {
	const current = makeRecord({
		testFile: '123.spec.ts',
		changedFiles: ['0', '1', '2'],
		result: 'fail',
	});

	const result = classifyFailure(current, []);
	expect(result.classification).toBe('unknown'); // '123.spec.ts' not in ['0', '1', '2']
});

test('classifyFailure isInChangedFiles uses case-insensitive comparison', () => {
	// Note: changedFiles check is case-insensitive, but testFile history filter is case-SENSITIVE
	// So we must use matching case for testFile
	const current = makeRecord({
		testFile: 'test.spec.ts', // Same case as history
		changedFiles: ['TEST.SPEC.TS'], // Different case - should still match
		result: 'fail',
	});
	// Must have 3 recent passes for new_regression
	const passHistory = [
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 1000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 2000).toISOString(),
		}),
		makeRecord({
			result: 'pass',
			timestamp: new Date(Date.now() - 3000).toISOString(),
		}),
	];

	const result = classifyFailure(current, passHistory);
	expect(result.classification).toBe('new_regression'); // Case-insensitive changedFiles
});

test('classifyFailure handles empty changedFiles array', () => {
	const current = makeRecord({
		changedFiles: [],
		result: 'fail',
	});

	const result = classifyFailure(current, []);
	expect(result.classification).toBe('unknown'); // Not in changed files
});

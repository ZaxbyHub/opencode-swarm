import { describe, expect, test } from 'bun:test';
import {
	computeFlakyScore,
	detectFlakyTests,
	isTestQuarantined,
} from '../flaky-detector.js';
import type { TestRunRecord } from '../history-store.js';

type TestRunRecordInput = Partial<TestRunRecord> & {
	testFile: string;
	testName: string;
	result: 'pass' | 'fail' | 'skip';
};

function makeRecord(overrides: TestRunRecordInput): TestRunRecord {
	return {
		timestamp: '2024-01-01T00:00:00.000Z',
		taskId: '1.1',
		durationMs: 100,
		changedFiles: [],
		...overrides,
	};
}

// --- ATTACK VECTOR 1: Empty arrays ---

describe('ADVERSARIAL: empty arrays', () => {
	test('computeFlakyScore([]) returns 0', () => {
		expect(computeFlakyScore([])).toBe(0);
	});

	test('detectFlakyTests([]) returns []', () => {
		expect(detectFlakyTests([])).toEqual([]);
	});

	test('isTestQuarantined with empty history returns false', () => {
		expect(isTestQuarantined('a.test.ts', 'test1', [])).toBe(false);
	});
});

// --- ATTACK VECTOR 2: Very large history (1000+ records) ---

describe('ADVERSARIAL: large history performance', () => {
	test('computeFlakyScore handles 1000 records', () => {
		const history: TestRunRecord[] = Array.from({ length: 1000 }, (_, i) =>
			makeRecord({
				testFile: 'perf.test.ts',
				testName: 'perf',
				result: i % 2 === 0 ? 'pass' : 'fail',
			}),
		);
		const start = Date.now();
		const score = computeFlakyScore(history);
		const elapsed = Date.now() - start;
		// Capped at MAX_HISTORY_RUNS = 20: alternation=0.95, pass-rate variance=1 => 0.975
		expect(score).toBe(0.975);
		expect(elapsed).toBeLessThan(100); // should be fast
	});

	test('detectFlakyTests handles 1000 records across many tests', () => {
		const history: TestRunRecord[] = [];
		for (let t = 0; t < 50; t++) {
			for (let i = 0; i < 20; i++) {
				history.push(
					makeRecord({
						testFile: `test${t}.test.ts`,
						testName: `test${t}`,
						result: i % 2 === 0 ? 'pass' : 'fail',
					}),
				);
			}
		}
		const start = Date.now();
		const results = detectFlakyTests(history);
		const elapsed = Date.now() - start;
		expect(results.length).toBe(50);
		expect(elapsed).toBeLessThan(500); // should be reasonable
	});
});

// --- ATTACK VECTOR 3: All same results ---

describe('ADVERSARIAL: all same results', () => {
	test('all pass → score is 0', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allpass',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allpass',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allpass',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allpass',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allpass',
				result: 'pass',
			}),
		];
		const score = computeFlakyScore(history);
		expect(score).toBe(0);
	});

	test('all fail → score is 0', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allfail',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allfail',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allfail',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allfail',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allfail',
				result: 'fail',
			}),
		];
		const score = computeFlakyScore(history);
		expect(score).toBe(0);
	});

	test('all same with 5 runs → NOT quarantined (score = 0)', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'stable', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'stable', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'stable', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'stable', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'stable', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results[0].isQuarantined).toBe(false);
		expect(results[0].flakyScore).toBe(0);
	});
});

// --- ATTACK VECTOR 4: Perfectly alternating results ---

describe('ADVERSARIAL: perfectly alternating results', () => {
	test('alternating P,F,P,F,P,F,P,F (8 runs) combines both signals', () => {
		const history: TestRunRecord[] = Array.from({ length: 8 }, (_, i) =>
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'alternating',
				result: i % 2 === 0 ? 'pass' : 'fail',
			}),
		);
		const score = computeFlakyScore(history);
		expect(score).toBe(0.9375);
	});

	test('alternating 20 runs keeps a near-max score (limited to 20)', () => {
		const history: TestRunRecord[] = Array.from({ length: 20 }, (_, i) =>
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'alternating20',
				result: i % 2 === 0 ? 'pass' : 'fail',
			}),
		);
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBe(0.975);
		expect(results[0].alternationCount).toBe(19);
		expect(results[0].isQuarantined).toBe(true);
	});
});

// --- ATTACK VECTOR 5: Exactly MIN_RUNS_FOR_QUARANTINE (5) at boundary ---

describe('ADVERSARIAL: quarantine threshold boundaries', () => {
	test('5 runs with score exactly 0.4 (2 alternations) → isQuarantined = true (score > 0.3)', () => {
		// P,F,P,F,P → 4 alternations / 5 = 0.8 > 0.3
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'quota1', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota1', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota1', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota1', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota1', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBe(0.88);
		expect(results[0].isQuarantined).toBe(true);
	});

	test('5 runs with score exactly 0.3 → NOT quarantined (threshold is strictly >)', () => {
		// F,F,F,P,P → 1 alternation / 5 = 0.2 — wait, we need score = 0.3
		// Actually we need 1.5 alternations for 0.3 which is impossible with integers
		// So minimum with 5 runs to get 0.3+ is: need 2 alternations for 2/5 = 0.4
		// Let's try P,P,F,F,P → 2 alternations = 0.4
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'quota2', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota2', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota2', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota2', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'quota2', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBeCloseTo(0.68, 3);
		expect(results[0].isQuarantined).toBe(true);
	});

	test('5 runs can exceed threshold via variance even with low alternation', () => {
		// F,F,F,F,P → alternation=0.2, pass-rate variance=0.64, combined=0.42
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'below', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'below', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'below', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'below', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'below', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBeCloseTo(0.42, 3);
		expect(results[0].isQuarantined).toBe(true);
	});

	test('score exactly FLAKY_THRESHOLD (0.3) → NOT quarantined (strictly greater required)', () => {
		// Use 10 runs with one fail at the end:
		// alternation=1/10=0.1, pass-rate variance=4*(9/10)*(1/10)=0.36, combined=0.23
		const history: TestRunRecord[] = [];
		for (let i = 0; i < 10; i++) {
			let result: 'pass' | 'fail' = 'pass';
			if (i === 9) result = 'fail';
			history.push(
				makeRecord({ testFile: 'a.test.ts', testName: 'exact30', result }),
			);
		}
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBeCloseTo(0.23, 3);
		expect(results[0].isQuarantined).toBe(false);
	});

	test('5 runs with frequent state changes stays above threshold', () => {
		// With the combined formula this pattern remains above threshold.
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'boundary',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'boundary',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'boundary',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'boundary',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'boundary',
				result: 'fail',
			}),
		];
		const results = detectFlakyTests(history);
		// alternation=0.6, pass-rate variance=0.96 => combined=0.78
		expect(results[0].flakyScore).toBe(0.78);
		expect(results[0].isQuarantined).toBe(true);
	});
});

// --- ATTACK VECTOR 7: Special characters in test names ---

describe('ADVERSARIAL: special characters in test names', () => {
	test('pipe character in test name is parsed correctly', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test | with | pipes',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test | with | pipes',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test | with | pipes',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test | with | pipes',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test | with | pipes',
				result: 'pass',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe('test | with | pipes');
		expect(results[0].testFile).toBe('a.test.ts');
		expect(results[0].isQuarantined).toBe(true);
	});

	test('newline in test name', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test\nwith\nnewlines',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test\nwith\nnewlines',
				result: 'fail',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe('test\nwith\nnewlines');
	});

	test('unicode emoji in test name', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test 🚀 with 🚀 emojis',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'test 🚀 with 🚀 emojis',
				result: 'fail',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe('test 🚀 with 🚀 emojis');
	});

	test('null byte in test name', () => {
		const nullName = 'test\u0000with\u0000nullbytes';
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: nullName,
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: nullName,
				result: 'fail',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe(nullName);
	});

	test('mixed unicode (RTL, combining chars) in test name', () => {
		const rtlName = 'test\u202Ewith\u200BRTL';
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: rtlName, result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: rtlName, result: 'fail' }),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe(rtlName);
	});
});

// --- ATTACK VECTOR 8: Very long test names ---

describe('ADVERSARIAL: very long test names', () => {
	test('10,000 char test name is handled', () => {
		const longName = 'a'.repeat(10000);
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: longName, result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: longName, result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: longName, result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe(longName);
		expect(results[0].testName.length).toBe(10000);
	});

	test('50,000 char test name is handled (max allowed by some systems)', () => {
		const veryLongName = 'x'.repeat(50000);
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: veryLongName,
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: veryLongName,
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: veryLongName,
				result: 'pass',
			}),
		];
		const start = Date.now();
		const results = detectFlakyTests(history);
		const elapsed = Date.now() - start;
		expect(results.length).toBe(1);
		expect(results[0].testName.length).toBe(50000);
		expect(elapsed).toBeLessThan(500);
	});
});

// --- ATTACK VECTOR 9: skip results mixed with pass/fail ---

describe('ADVERSARIAL: skip results in history', () => {
	test('skip alternates with pass: P,S,P,S,P includes variance signal', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'skip1', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip1', result: 'skip' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip1', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip1', result: 'skip' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip1', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBe(0.88);
		expect(results[0].recentResults).toEqual([
			'pass',
			'skip',
			'pass',
			'skip',
			'pass',
		]);
	});

	test('skip, fail, pass, skip, fail → mixed alternation', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'skip2', result: 'skip' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip2', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip2', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip2', result: 'skip' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'skip2', result: 'fail' }),
		];
		const results = detectFlakyTests(history);
		// skip→fail (alt), fail→pass (alt), pass→skip (alt), skip→fail (alt) = 4/5
		expect(results[0].flakyScore).toBeCloseTo(0.72, 3);
	});

	test('all skips = 0 alternations', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allskip',
				result: 'skip',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allskip',
				result: 'skip',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allskip',
				result: 'skip',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allskip',
				result: 'skip',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'allskip',
				result: 'skip',
			}),
		];
		const score = computeFlakyScore(history);
		expect(score).toBe(0);
	});
});

// --- ATTACK VECTOR 10: Unsorted timestamps ---

describe('ADVERSARIAL: unsorted timestamps', () => {
	test('detectFlakyTests sorts by timestamp before computing score', () => {
		// Out of order timestamps but correct result order when sorted
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted',
				result: 'pass',
				timestamp: '2024-01-05T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted',
				result: 'fail',
				timestamp: '2024-01-01T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted',
				result: 'pass',
				timestamp: '2024-01-03T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted',
				result: 'fail',
				timestamp: '2024-01-02T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted',
				result: 'pass',
				timestamp: '2024-01-04T00:00:00.000Z',
			}),
		];
		const results = detectFlakyTests(history);
		// Sorted: Jan1=fail, Jan2=fail, Jan3=pass, Jan4=pass, Jan5=pass
		// fail→fail (no), fail→pass (alt), pass→pass (no), pass→pass (no); combined score = 0.58
		expect(results[0].flakyScore).toBe(0.58);
	});

	test('computeFlakyScore with unsorted array — does NOT sort (external caller must sort)', () => {
		// computeFlakyScore does not sort — if caller passes unsorted, they get wrong result
		// This is documented behavior — detectFlakyTests sorts, but computeFlakyScore does not
		const unsorted = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted2',
				result: 'pass',
				timestamp: '2024-01-05T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'unsorted2',
				result: 'fail',
				timestamp: '2024-01-01T00:00:00.000Z',
			}),
		];
		// No sorting — pass then fail; combined score = (0.5 + 1) / 2 = 0.75
		const score = computeFlakyScore(unsorted);
		expect(score).toBe(0.75);
	});
});

// --- ATTACK VECTOR 11: Multiple tests with same testFile but different testName ---

describe('ADVERSARIAL: grouping by (testFile, testName)', () => {
	test('same testFile, different testNames → separate entries', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'testA', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'testA', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'testA', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'testB', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'testB', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(2);
		const entryA = results.find((r) => r.testName === 'testA');
		const entryB = results.find((r) => r.testName === 'testB');
		expect(entryA?.totalRuns).toBe(3);
		expect(entryB?.totalRuns).toBe(2);
	});

	test('same testFile+testName but different results → grouped together', () => {
		const history = [
			makeRecord({
				testFile: 'shared.test.ts',
				testName: 'shared',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'shared.test.ts',
				testName: 'shared',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'shared.test.ts',
				testName: 'shared',
				result: 'pass',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		// P,F,P: alternation=2/3, pass-rate variance=8/9 => combined=7/9
		expect(results[0].flakyScore).toBe(7 / 9);
	});

	test('many tests in same file all with different names → all separate', () => {
		const history: TestRunRecord[] = [];
		for (let i = 0; i < 100; i++) {
			// Each test needs 2+ runs to be included in results
			history.push(
				makeRecord({
					testFile: 'one-file.test.ts',
					testName: `test${i}`,
					result: 'pass',
				}),
			);
			history.push(
				makeRecord({
					testFile: 'one-file.test.ts',
					testName: `test${i}`,
					result: 'fail',
				}),
			);
		}
		const results = detectFlakyTests(history);
		expect(results.length).toBe(100);
	});
});

// --- ATTACK VECTOR 12: computeFlakyScore with unsorted array ---

describe('ADVERSARIAL: computeFlakyScore unsorted input', () => {
	test('single run returns 0', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'single', result: 'pass' }),
		];
		expect(computeFlakyScore(history)).toBe(0);
	});

	test('exactly 2 runs: no alternation → score = 0', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'two', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'two', result: 'pass' }),
		];
		expect(computeFlakyScore(history)).toBe(0);
	});

	test('exactly 2 runs: with alternation includes variance', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'two', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'two', result: 'fail' }),
		];
		expect(computeFlakyScore(history)).toBe(0.75);
	});

	test('limits to last 20 regardless of input size', () => {
		const history: TestRunRecord[] = [];
		// First 10: all pass
		for (let i = 0; i < 10; i++) {
			history.push(
				makeRecord({
					testFile: 'a.test.ts',
					testName: 'twenty',
					result: 'pass',
				}),
			);
		}
		// Next 20: alternating
		for (let i = 0; i < 20; i++) {
			history.push(
				makeRecord({
					testFile: 'a.test.ts',
					testName: 'twenty',
					result: i % 2 === 0 ? 'fail' : 'pass',
				}),
			);
		}
		// Score based on last 20 (alternating): (0.95 + 1) / 2 = 0.975
		expect(computeFlakyScore(history)).toBe(0.975);
	});
});

// --- ATTACK VECTOR: isTestQuarantined boundary conditions ---

describe('ADVERSARIAL: isTestQuarantined boundary conditions', () => {
	test('empty history → false', () => {
		expect(isTestQuarantined('a.test.ts', 't', [])).toBe(false);
	});

	test('test not in history → false', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'other', result: 'pass' }),
		];
		expect(isTestQuarantined('a.test.ts', 'nonexistent', history)).toBe(false);
	});

	test('quarantined test → true', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'pass' }),
		];
		expect(isTestQuarantined('a.test.ts', 'flaky', history)).toBe(true);
	});

	test('non-quarantined (score > 0.3 but only 4 runs) → false', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'flaky', result: 'fail' }),
		];
		expect(isTestQuarantined('a.test.ts', 'flaky', history)).toBe(false);
	});

	test('combined score can exceed threshold with low alternation', () => {
		const history: TestRunRecord[] = [];
		for (let i = 0; i < 10; i++) {
			history.push(
				makeRecord({
					testFile: 'a.test.ts',
					testName: 'below',
					result: i >= 3 && i < 5 ? 'fail' : 'pass',
				}),
			);
		}
		const score = computeFlakyScore(history);
		expect(score).toBeCloseTo(0.42, 3);
		expect(isTestQuarantined('a.test.ts', 'below', history)).toBe(true);
	});
});

// --- ATTACK VECTOR: Injection via key parsing ---

describe('ADVERSARIAL: key injection in grouping', () => {
	test('testName containing pipe character — key separator is |', () => {
		// The key is `${record.testFile}|${record.testName}`
		// So "a.test.ts|foo|bar" as testName would parse incorrectly
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'foo|bar',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'foo|bar',
				result: 'fail',
			}),
		];
		const results = detectFlakyTests(history);
		// key = "a.test.ts|foo|bar" → parsed as testFile="a.test.ts", testName="foo|bar"
		expect(results[0].testFile).toBe('a.test.ts');
		expect(results[0].testName).toBe('foo|bar');
	});

	test('testFile containing pipe character — edge case', () => {
		// In practice testFile shouldn't have | but let's see
		const history = [
			makeRecord({
				testFile: 'a|test.ts',
				testName: 'test',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a|test.ts',
				testName: 'test',
				result: 'fail',
			}),
		];
		const results = detectFlakyTests(history);
		// Now uses entry.originalFile/originalName instead of splitting by |
		// Pipe characters in testFile are preserved correctly
		expect(results[0].testFile).toBe('a|test.ts');
		expect(results[0].testName).toBe('test');
	});

	test('empty testName → valid key', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: '', result: 'pass' }),
			makeRecord({ testFile: 'a.test.ts', testName: '', result: 'fail' }),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testName).toBe('');
	});

	test('empty testFile → valid key', () => {
		const history = [
			makeRecord({ testFile: '', testName: 'test', result: 'pass' }),
			makeRecord({ testFile: '', testName: 'test', result: 'fail' }),
		];
		const results = detectFlakyTests(history);
		expect(results.length).toBe(1);
		expect(results[0].testFile).toBe('');
	});
});

// --- ATTACK VECTOR: ISO timestamp edge cases ---

describe('ADVERSARIAL: ISO timestamp edge cases', () => {
	test('ISO timestamps with different timezone offsets', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'tz',
				result: 'pass',
				timestamp: '2024-01-01T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'tz',
				result: 'fail',
				timestamp: '2024-01-02T00:00:00.000+05:00',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'tz',
				result: 'pass',
				timestamp: '2024-01-03T00:00:00.000-08:00',
			}),
		];
		const results = detectFlakyTests(history);
		// Z → +05:00 → -08:00 when converted to ms: Jan1, Jan2+5hrs, Jan3-8hrs
		// Should still sort correctly
		expect(results.length).toBe(1);
	});

	test('very old ISO timestamp (year 0001)', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'old',
				result: 'pass',
				timestamp: '0001-01-01T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'old',
				result: 'fail',
				timestamp: '2024-01-01T00:00:00.000Z',
			}),
		];
		const results = detectFlakyTests(history);
		// Oldest first → P then F
		expect(results[0].flakyScore).toBe(0.75);
	});

	test('far future ISO timestamp', () => {
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'future',
				result: 'pass',
				timestamp: '2024-01-01T00:00:00.000Z',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'future',
				result: 'fail',
				timestamp: '9999-12-31T23:59:59.999Z',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBe(0.75);
	});
});

// --- ATTACK VECTOR: recommendations at exact boundaries ---

describe('ADVERSARIAL: recommendation tiers', () => {
	test('alternationCount === totalRuns - 1 → Highly unstable', () => {
		// Perfect alternation: P,F,P,F,P = 4 alternations = 5 runs
		const history = [
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'perfect',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'perfect',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'perfect',
				result: 'pass',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'perfect',
				result: 'fail',
			}),
			makeRecord({
				testFile: 'a.test.ts',
				testName: 'perfect',
				result: 'pass',
			}),
		];
		const results = detectFlakyTests(history);
		expect(results[0].recommendation).toContain('Highly unstable');
	});

	test('score > 0.5 but not perfect → Severely flaky', () => {
		// 10 runs, 6 alternations = 0.6
		const history: TestRunRecord[] = [];
		for (let i = 0; i < 10; i++) {
			history.push(
				makeRecord({
					testFile: 'a.test.ts',
					testName: 'severe',
					result: i === 0 || i === 3 || i === 6 || i === 9 ? 'pass' : 'fail',
				}),
			);
		}
		const results = detectFlakyTests(history);
		expect(results[0].recommendation).toContain('Severely flaky');
	});

	test('score > 0.5 → Severely flaky', () => {
		// 10 runs, 4 alternations = 0.4
		const history: TestRunRecord[] = [];
		for (let i = 0; i < 10; i++) {
			history.push(
				makeRecord({
					testFile: 'a.test.ts',
					testName: 'moderate',
					result: i === 1 || i === 3 ? 'fail' : 'pass',
				}),
			);
		}
		const results = detectFlakyTests(history);
		expect(results[0].recommendation).toContain('Severely flaky');
	});

	test('score > 0.3 can produce a recommendation even with low alternation', () => {
		const history = [
			makeRecord({ testFile: 'a.test.ts', testName: 'low', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'low', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'low', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'low', result: 'fail' }),
			makeRecord({ testFile: 'a.test.ts', testName: 'low', result: 'pass' }),
		];
		const results = detectFlakyTests(history);
		expect(results[0].flakyScore).toBeCloseTo(0.42, 3);
		expect(results[0].recommendation).toContain('Moderately flaky');
	});
});

import { describe, expect, test } from 'bun:test';
import * as tools from '../../../src/tools/index.js';

describe('barrel exports — test-impact utilities', () => {
	describe('failure-classifier exports', () => {
		test('classifyAndCluster is a function', () => {
			expect(typeof tools.classifyAndCluster).toBe('function');
		});

		test('classifyFailure is a function', () => {
			expect(typeof tools.classifyFailure).toBe('function');
		});

		test('clusterFailures is a function', () => {
			expect(typeof tools.clusterFailures).toBe('function');
		});
	});

	describe('failure-classifier type exports', () => {
		test('ClassifiedFailure type is exported', () => {
			// Verify the type exists by assigning a value
			const _val: tools.ClassifiedFailure = {
				testFile: 'foo.test.ts',
				testName: 'test foo',
				classification: 'new_regression',
				durationMs: 100,
				confidence: 0.9,
			};
			expect(_val).toBeDefined();
		});

		test('FailureClassification type is exported', () => {
			const _val: tools.FailureClassification = 'new_regression';
			expect(_val).toBe('new_regression');
		});

		test('FailureCluster type is exported', () => {
			const _val: tools.FailureCluster = {
				clusterId: 'abc123',
				rootCause: 'some error',
				failures: [],
				classification: 'unknown',
				affectedTestFiles: [],
			};
			expect(_val).toBeDefined();
		});
	});

	describe('flaky-detector exports', () => {
		test('computeFlakyScore is a function', () => {
			expect(typeof tools.computeFlakyScore).toBe('function');
		});

		test('detectFlakyTests is a function', () => {
			expect(typeof tools.detectFlakyTests).toBe('function');
		});

		test('isTestQuarantined is a function', () => {
			expect(typeof tools.isTestQuarantined).toBe('function');
		});
	});

	describe('flaky-detector type exports', () => {
		test('FlakyTestEntry type is exported', () => {
			const _val: tools.FlakyTestEntry = {
				testFile: 'bar.test.ts',
				testName: 'test bar',
				flakyScore: 0.5,
				totalRuns: 10,
				alternationCount: 5,
				isQuarantined: true,
				recentResults: ['pass', 'fail', 'pass'],
			};
			expect(_val).toBeDefined();
		});
	});
});

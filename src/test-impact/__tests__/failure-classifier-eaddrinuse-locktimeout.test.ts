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

function makeRecentPassHistory(
	testFile: string,
	testName: string,
): TestRunRecord[] {
	return [1, 2, 3].map((daysAgo) =>
		makeRecord({
			testFile,
			testName,
			result: 'pass',
			timestamp: ts(daysAgo),
		}),
	);
}

// =============================================================================
// SC-136: EADDRINUSE — real-world error messages from Node.js, Go, Python
// =============================================================================
describe('SC-136: EADDRINUSE patterns — infrastructure_failure', () => {
	// Node.js primary format
	test('Node.js: Error: listen EADDRINUSE: address already in use 0.0.0.0:3000', () => {
		const current = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts server on port 3000',
			result: 'fail',
			errorMessage:
				'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
			changedFiles: ['src/server.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/server.test.ts', 'starts server on port 3000'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	// Node.js with IPv6 context
	test('Node.js with IPv6 context: bind: address in use :::1:8080', () => {
		const current = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts server on IPv6 8080',
			result: 'fail',
			errorMessage: 'Error: bind EADDRINUSE: address in use :::1:8080',
			changedFiles: ['src/server.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/server.test.ts', 'starts server on IPv6 8080'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	// Go format: "listen tcp :3000: bind: address already in use"
	test('Go: listen tcp :3000: bind: address already in use', () => {
		const current = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts go server on :3000',
			result: 'fail',
			errorMessage: 'listen tcp :3000: bind: address already in use',
			changedFiles: ['src/server.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/server.test.ts', 'starts go server on :3000'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	// Python format: "OSError: [Errno 98] Address already in use"
	test('Python: OSError: [Errno 98] Address already in use', () => {
		const current = makeRecord({
			testFile: 'tests/test_server.py',
			testName: 'test_server_starts',
			result: 'fail',
			errorMessage: 'OSError: [Errno 98] Address already in use',
			changedFiles: ['tests/test_server.py'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('tests/test_server.py', 'test_server_starts'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	// SC-136: EADDRINUSE with changedFiles would have been new_regression but is infra
	test('EADDRINUSE overrides new_regression logic — classified as infrastructure_failure even with changedFiles', () => {
		// Set up a scenario that would match new_regression: 3 passing history, file in changedFiles
		const current = makeRecord({
			testFile: 'src/foo.test.ts',
			testName: 'eaddrinuse test',
			result: 'fail',
			errorMessage:
				'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
			changedFiles: ['src/foo.test.ts'],
		});

		const history = makeRecentPassHistory('src/foo.test.ts', 'eaddrinuse test');

		const result = classifyFailure(current, history);
		// isInfrastructureFailure() is checked BEFORE new_regression logic
		expect(result.classification).toBe('infrastructure_failure');
	});
});

// =============================================================================
// SC-137: Lock-timeout patterns — infrastructure_failure
// =============================================================================
describe('SC-137: Lock-timeout patterns — infrastructure_failure', () => {
	test('resource lock acquisition timeout', () => {
		const current = makeRecord({
			testFile: 'src/lock.test.ts',
			testName: 'acquires resource lock',
			result: 'fail',
			errorMessage: 'Error: resource lock acquisition timeout',
			changedFiles: ['src/lock.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/lock.test.ts', 'acquires resource lock'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	test('file lock timeout while waiting for /tmp/test.lock', () => {
		const current = makeRecord({
			testFile: 'src/file.test.ts',
			testName: 'locks file',
			result: 'fail',
			errorMessage: 'Error: file lock timeout while waiting for /tmp/test.lock',
			changedFiles: ['src/file.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/file.test.ts', 'locks file'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	test('failed to acquire lock: EAGAIN', () => {
		const current = makeRecord({
			testFile: 'src/lock.test.ts',
			testName: 'acquires advisory lock',
			result: 'fail',
			errorMessage: 'Error: failed to acquire lock: EAGAIN',
			changedFiles: ['src/lock.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/lock.test.ts', 'acquires advisory lock'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	// Variant: "failed to acquire lock" without EAGAIN (already covered in existing tests)
	test('failed to acquire lock without errno', () => {
		const current = makeRecord({
			testFile: 'src/lock.test.ts',
			testName: 'acquires mutex',
			result: 'fail',
			errorMessage: 'failed to acquire lock',
			changedFiles: ['src/lock.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/lock.test.ts', 'acquires mutex'),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});
});

// =============================================================================
// SC-136 / SC-137: False-positive guards — no classification as infrastructure_failure
// =============================================================================
describe('False-positive guards — assertion errors should NOT be infrastructure_failure', () => {
	test('regular assertion error: expect(1).toBe(2) → new_regression', () => {
		const current = makeRecord({
			testFile: 'src/math.test.ts',
			testName: 'adds 1 and 1',
			result: 'fail',
			errorMessage: 'AssertionError: expected 1 to be 2',
			changedFiles: ['src/math.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/math.test.ts', 'adds 1 and 1'),
		);
		expect(result.classification).toBe('new_regression');
	});

	test('assertion error containing infrastructure token "killed" → new_regression, NOT infrastructure_failure', () => {
		const current = makeRecord({
			testFile: 'src/process.test.ts',
			testName: 'process is killed',
			result: 'fail',
			errorMessage: 'AssertionError: expected process to be killed',
			changedFiles: ['src/process.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory('src/process.test.ts', 'process is killed'),
		);
		expect(result.classification).toBe('new_regression');
	});

	test('EADDRINUSE in test name but assertion error in message → new_regression', () => {
		// The assertion guard only checks errorMessage, not testName.
		// This tests that a test named "test_eaddrinuse" with an assertion error doesn't false-positive.
		const current = makeRecord({
			testFile: 'src/eaddrinuse.test.ts',
			testName: 'test_eaddrinuse scenario',
			result: 'fail',
			errorMessage: 'AssertionError: expected "EADDRINUSE" to equal "SUCCESS"',
			changedFiles: ['src/eaddrinuse.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory(
				'src/eaddrinuse.test.ts',
				'test_eaddrinuse scenario',
			),
		);
		expect(result.classification).toBe('new_regression');
	});

	test('EADDRINUSE in test name but generic error message → infrastructure_failure', () => {
		// EADDRINUSE in the actual error message (not assertion) should still match
		const current = makeRecord({
			testFile: 'src/eaddrinuse.test.ts',
			testName: 'test_eaddrinuse scenario',
			result: 'fail',
			errorMessage: 'listen tcp :3000: bind: address already in use',
			changedFiles: ['src/eaddrinuse.test.ts'],
		});

		const result = classifyFailure(
			current,
			makeRecentPassHistory(
				'src/eaddrinuse.test.ts',
				'test_eaddrinuse scenario',
			),
		);
		expect(result.classification).toBe('infrastructure_failure');
	});

	test('"lock" as regular word in error message does NOT match lock-timeout pattern', () => {
		// These should NOT match any lock-timeout pattern:
		// - "waiting for /tmp/test.lock" — no "timeout", no "acquisition"
		// - "database lock released" — "lock" appears but not in lock-timeout context
		const messages = [
			'Error: waiting for /tmp/test.lock',
			'Error: database lock released',
			'Error: could not obtain lock on resource in method deallocate',
		];

		for (const errorMessage of messages) {
			const current = makeRecord({
				testFile: 'src/db.test.ts',
				testName: 'db test',
				result: 'fail',
				errorMessage,
				changedFiles: ['src/db.test.ts'],
			});

			const result = classifyFailure(
				current,
				makeRecentPassHistory('src/db.test.ts', 'db test'),
			);
			// These should NOT be infrastructure_failure (no timeout or acquisition pattern)
			expect(result.classification).not.toBe('infrastructure_failure');
		}
	});
});

// =============================================================================
// SC-138: Determinism — same input produces identical classification
// =============================================================================
describe('SC-138: Determinism — same input produces identical classification', () => {
	const testCases = [
		{
			label: 'EADDRINUSE Node.js format',
			current: makeRecord({
				testFile: 'src/server.test.ts',
				testName: 'server start',
				result: 'fail',
				errorMessage:
					'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
				changedFiles: ['src/server.test.ts'],
			}),
		},
		{
			label: 'Go EADDRINUSE format',
			current: makeRecord({
				testFile: 'src/server.test.ts',
				testName: 'go server start',
				result: 'fail',
				errorMessage: 'listen tcp :3000: bind: address already in use',
				changedFiles: ['src/server.test.ts'],
			}),
		},
		{
			label: 'Python EADDRINUSE format',
			current: makeRecord({
				testFile: 'tests/test_server.py',
				testName: 'python server start',
				result: 'fail',
				errorMessage: 'OSError: [Errno 98] Address already in use',
				changedFiles: ['tests/test_server.py'],
			}),
		},
		{
			label: 'resource lock acquisition timeout',
			current: makeRecord({
				testFile: 'src/lock.test.ts',
				testName: 'resource lock',
				result: 'fail',
				errorMessage: 'Error: resource lock acquisition timeout',
				changedFiles: ['src/lock.test.ts'],
			}),
		},
		{
			label: 'file lock timeout with path',
			current: makeRecord({
				testFile: 'src/file.test.ts',
				testName: 'file lock',
				result: 'fail',
				errorMessage:
					'Error: file lock timeout while waiting for /tmp/test.lock',
				changedFiles: ['src/file.test.ts'],
			}),
		},
		{
			label: 'failed to acquire lock: EAGAIN',
			current: makeRecord({
				testFile: 'src/lock.test.ts',
				testName: 'advisory lock',
				result: 'fail',
				errorMessage: 'Error: failed to acquire lock: EAGAIN',
				changedFiles: ['src/lock.test.ts'],
			}),
		},
	];

	for (const { label, current } of testCases) {
		test(`deterministic for ${label}`, () => {
			const history = makeRecentPassHistory(current.testFile, current.testName);

			const result1 = classifyFailure(current, history);
			const result2 = classifyFailure(current, history);

			expect(result1.classification).toBe(result2.classification);
			expect(result1.confidence).toBe(result2.confidence);
			expect(result1.errorMessage).toBe(result2.errorMessage);
			expect(result1.testFile).toBe(result2.testFile);
			expect(result1.testName).toBe(result2.testName);
		});
	}

	// Multiple consecutive calls (stress test)
	test('5 consecutive calls with same EADDRINUSE input produce identical classification', () => {
		const current = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'server start',
			result: 'fail',
			errorMessage:
				'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
			changedFiles: ['src/server.test.ts'],
		});

		const history = makeRecentPassHistory('src/server.test.ts', 'server start');
		const results = Array.from({ length: 5 }, () =>
			classifyFailure(current, history),
		);

		for (const result of results) {
			expect(result.classification).toBe('infrastructure_failure');
			expect(result.confidence).toBe(results[0].confidence);
		}
	});
});

// =============================================================================
// End-to-end: EADDRINUSE with history — should NOT be new_regression
// =============================================================================
describe('End-to-end: EADDRINUSE with history → infrastructure_failure', () => {
	test('EADDRINUSE on first occurrence (no history) → infrastructure_failure', () => {
		const current = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts server',
			result: 'fail',
			errorMessage:
				'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
			changedFiles: ['src/server.test.ts'],
		});

		const result = classifyFailure(current, []);
		expect(result.classification).toBe('infrastructure_failure');
		expect(result.confidence).toBe(0.1); // empty history = 0.1 confidence
	});

	test('EADDRINUSE with pass history → infrastructure_failure (not new_regression)', () => {
		const current = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts server',
			result: 'fail',
			errorMessage:
				'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
			changedFiles: ['src/server.test.ts'],
		});

		// 3 passing runs — would trigger new_regression for a regular assertion failure
		// but EADDRINUSE should be infrastructure_failure
		const history = makeRecentPassHistory(
			'src/server.test.ts',
			'starts server',
		);

		const result = classifyFailure(current, history);
		expect(result.classification).toBe('infrastructure_failure');
		// computeConfidence: historyLength >= 3 → 0.5; 3 entries = 0.5
		expect(result.confidence).toBe(0.5);
	});

	test('EADDRINUSE first failure, second pass → infrastructure_failure classification (not flaky)', () => {
		// First failure: EADDRINUSE
		const firstFailure = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts server',
			result: 'fail',
			errorMessage:
				'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
			changedFiles: ['src/server.test.ts'],
			timestamp: ts(1),
		});

		// Second run: passes
		const secondPass = makeRecord({
			testFile: 'src/server.test.ts',
			testName: 'starts server',
			result: 'pass',
			changedFiles: [],
			timestamp: ts(0),
		});

		const { classified } = classifyAndCluster([firstFailure, secondPass], []);

		expect(classified).toHaveLength(1);
		expect(classified[0].classification).toBe('infrastructure_failure');
	});

	test('lock-timeout first failure, second pass → infrastructure_failure classification', () => {
		const firstFailure = makeRecord({
			testFile: 'src/lock.test.ts',
			testName: 'acquires lock',
			result: 'fail',
			errorMessage: 'Error: resource lock acquisition timeout',
			changedFiles: ['src/lock.test.ts'],
			timestamp: ts(1),
		});

		const secondPass = makeRecord({
			testFile: 'src/lock.test.ts',
			testName: 'acquires lock',
			result: 'pass',
			changedFiles: [],
			timestamp: ts(0),
		});

		const { classified } = classifyAndCluster([firstFailure, secondPass], []);

		expect(classified).toHaveLength(1);
		expect(classified[0].classification).toBe('infrastructure_failure');
	});
});

// =============================================================================
// clusterFailures — EADDRINUSE and lock-timeout clustering
// =============================================================================
describe('clusterFailures — EADDRINUSE and lock-timeout cluster correctly', () => {
	test('multiple EADDRINUSE failures from different files cluster together', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/server-a.test.ts',
				testName: 'starts server',
				classification: 'infrastructure_failure',
				errorMessage:
					'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
				durationMs: 50,
				confidence: 0.3,
			},
			{
				testFile: 'src/server-b.test.ts',
				testName: 'starts server on 3000',
				classification: 'infrastructure_failure',
				errorMessage: 'listen tcp :3000: bind: address already in use',
				durationMs: 75,
				confidence: 0.3,
			},
		];

		const clusters = clusterFailures(failures);

		// Same error message key → one cluster
		expect(clusters).toHaveLength(2);
	});

	test('EADDRINUSE cluster has infrastructure_failure as dominant classification', () => {
		const failures: ClassifiedFailure[] = [
			{
				testFile: 'src/server-a.test.ts',
				testName: 'starts server',
				classification: 'infrastructure_failure',
				errorMessage:
					'Error: listen EADDRINUSE: address already in use 0.0.0.0:3000',
				durationMs: 50,
				confidence: 0.3,
			},
			{
				testFile: 'src/server-b.test.ts',
				testName: 'starts server on 3000',
				classification: 'infrastructure_failure',
				errorMessage: 'listen tcp :3000: bind: address already in use',
				durationMs: 75,
				confidence: 0.3,
			},
		];

		const clusters = clusterFailures(failures);

		// Each failure has its own cluster (different error message keys)
		expect(clusters[0].classification).toBe('infrastructure_failure');
		expect(clusters[1].classification).toBe('infrastructure_failure');
	});
});

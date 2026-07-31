import { describe, expect, test } from 'bun:test';
import { classifyTaskResult } from '../../../src/hooks/task-result-classifier';

describe('Task result classification', () => {
	test('gives terminal non-success fields precedence over contradictory success', () => {
		expect(
			classifyTaskResult({
				state: 'completed',
				status: 'error',
				output: 'looks successful',
			}),
		).toBe('non_success');
		expect(
			classifyTaskResult({
				state: 'completed',
				metadata: { status: 'cancelled' },
				output: 'looks successful',
			}),
		).toBe('non_success');
		expect(
			classifyTaskResult({
				status: 'completed',
				result: { error: 'provider failed' },
				output: 'looks successful',
			}),
		).toBe('non_success');
	});

	test('classifies running placeholders before success and fails unknown shapes closed', () => {
		expect(
			classifyTaskResult({
				state: 'completed',
				metadata: { background: true },
				output: 'background placeholder',
			}),
		).toBe('running');
		expect(classifyTaskResult({ output: 'ordinary sync completion' })).toBe(
			'success',
		);
		expect(classifyTaskResult({})).toBe('success');
		expect(classifyTaskResult({ metadata: {} })).toBe('non_success');
	});

	test('fails closed when explicit state or status values are unknown', () => {
		expect(
			classifyTaskResult({ state: 'mystery', output: 'looks successful' }),
		).toBe('non_success');
		expect(
			classifyTaskResult({ status: 'alien', output: 'looks successful' }),
		).toBe('non_success');
		expect(
			classifyTaskResult({
				state: 'completed',
				metadata: { status: 'unexpected' },
				output: 'looks successful',
			}),
		).toBe('non_success');
	});
});

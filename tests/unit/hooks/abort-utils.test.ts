import { describe, expect, test } from 'bun:test';
import { isAbortError } from '../../../src/hooks/abort-utils';

describe('isAbortError', () => {
	test('returns true for AbortError', () => {
		const err = new Error('aborted');
		err.name = 'AbortError';
		expect(isAbortError(err)).toBe(true);
	});

	test('returns true for TimeoutError', () => {
		const err = new Error('timeout');
		err.name = 'TimeoutError';
		expect(isAbortError(err)).toBe(true);
	});

	test('returns false for a plain Error', () => {
		expect(isAbortError(new Error('UPSTREAM_500'))).toBe(false);
	});

	test('returns false for non-object values', () => {
		expect(isAbortError('string error')).toBe(false);
		expect(isAbortError(null)).toBe(false);
		expect(isAbortError(undefined)).toBe(false);
		expect(isAbortError(42)).toBe(false);
	});

	test('returns false for objects without a matching name', () => {
		expect(isAbortError({})).toBe(false);
		expect(isAbortError({ message: 'fail' })).toBe(false);
	});
});

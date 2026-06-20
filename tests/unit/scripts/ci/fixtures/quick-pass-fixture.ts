/**
 * Quick-pass test fixture for run-test-with-timeout tests.
 * Exits immediately with code 0.
 */
import { describe, expect, test } from 'bun:test';

describe('quick-pass fixture', () => {
	test('passes immediately', () => {
		expect(1 + 1).toBe(2);
	});
});

/**
 * Hanging test fixture for run-test-with-timeout tests.
 * Runs indefinitely to test the timeout kill mechanism.
 */
import { describe, expect, test } from 'bun:test';

describe('hanging fixture', () => {
	test('hangs forever', async () => {
		// Create an infinite promise that never resolves
		await new Promise(() => {
			// This test hangs indefinitely
		});
	});
});

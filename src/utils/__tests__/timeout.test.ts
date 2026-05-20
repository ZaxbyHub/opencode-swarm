/**
 * Timeout-helper tests (issue #704).
 *
 * The plugin init path uses `withTimeout` to bound the snapshot rehydration
 * read so a slow filesystem cannot pin the host's `await server(...)`. The
 * helper must:
 *   - resolve to the racer's value when the racer wins,
 *   - reject with the supplied error when the deadline elapses,
 *   - clear its timer in `finally` (no leak that holds the loop open),
 *   - never throw synchronously.
 */

import { describe, expect, test } from 'bun:test';
import { withTimeout, yieldToEventLoop } from '../timeout';

describe('withTimeout', () => {
	test('resolves to racer value when racer wins', async () => {
		const result = await withTimeout(
			Promise.resolve(42),
			1000,
			new Error('would not reach'),
		);
		expect(result).toBe(42);
	});

	test('rejects with the supplied error when the deadline elapses first', async () => {
		const err = new Error('deadline exceeded');
		const slow = new Promise<number>((resolve) => {
			setTimeout(() => resolve(99), 200);
		});
		await expect(withTimeout(slow, 25, err)).rejects.toBe(err);
	});

	test('clears its timer when the racer wins (no event-loop pin)', async () => {
		// If the timer were not cleared, the test runner would hold open the
		// process for the full timeout. Bun's test runner enforces a default
		// process exit, so this regression would surface as a hang in CI.
		const start = Date.now();
		await withTimeout(Promise.resolve('done'), 60_000, new Error('nope'));
		expect(Date.now() - start).toBeLessThan(500);
	});
});

describe('yieldToEventLoop', () => {
	test('returns a fresh promise that resolves on the next macrotask', async () => {
		let observed = false;
		setTimeout(() => {
			observed = true;
		}, 0);
		await yieldToEventLoop();
		expect(observed).toBe(true);
	});
});

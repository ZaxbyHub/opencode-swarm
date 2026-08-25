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
 *
 * `withTimeoutSignal` is the same contract plus a cooperative abort signal for
 * callers that can cancel the underlying work.
 */

import { describe, expect, test } from 'bun:test';
import {
	_internals,
	withTimeout,
	withTimeoutSignal,
	yieldToEventLoop,
} from '../timeout';

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

describe('withTimeoutSignal', () => {
	test('resolves to the operation value when the operation wins', async () => {
		const result = await withTimeoutSignal(
			async (signal) => {
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(signal.aborted).toBe(false);
				return 7;
			},
			1000,
			new Error('would not reach'),
		);
		expect(result).toBe(7);
	});

	test('rejects with the supplied error and aborts the signal when the deadline elapses', async () => {
		const err = new Error('deadline exceeded');
		let observedSignal: AbortSignal | undefined;
		await expect(
			withTimeoutSignal(
				async (signal) => {
					observedSignal = signal;
					await new Promise(() => {});
					return 99;
				},
				25,
				err,
			),
		).rejects.toBe(err);
		expect(observedSignal).toBeDefined();
		expect(observedSignal?.aborted).toBe(true);
		expect(observedSignal?.reason).toBe(err);
		expect(err.name).toBe('TimeoutError');
	});

	test('clears its timer on success, operation error, and timeout', async () => {
		const originalSetTimeout = _internals.setTimeout;
		const originalClearTimeout = _internals.clearTimeout;
		const cleared: unknown[] = [];
		let nextTimer = 0;
		try {
			_internals.setTimeout = ((callback: () => void, ms: number) => {
				const token = { id: ++nextTimer, unref() {} };
				if (ms === 0) queueMicrotask(callback);
				return token;
			}) as typeof setTimeout;
			_internals.clearTimeout = ((timer: unknown) => {
				cleared.push(timer);
			}) as typeof clearTimeout;

			await expect(
				withTimeoutSignal(async () => 'ok', 100, new Error('late')),
			).resolves.toBe('ok');
			await expect(
				withTimeoutSignal(
					async () => {
						throw new Error('operation failed');
					},
					100,
					new Error('late'),
				),
			).rejects.toThrow('operation failed');
			await expect(
				withTimeoutSignal(
					async () => new Promise<never>(() => {}),
					0,
					new Error('expired'),
				),
			).rejects.toThrow('expired');
			expect(cleared).toHaveLength(3);
		} finally {
			_internals.setTimeout = originalSetTimeout;
			_internals.clearTimeout = originalClearTimeout;
		}
	});

	test('rejects invalid timeout bounds before starting the operation', async () => {
		let started = false;
		await expect(
			withTimeoutSignal(
				async () => {
					started = true;
				},
				Number.POSITIVE_INFINITY,
				new Error('invalid'),
			),
		).rejects.toThrow('finite non-negative');
		expect(started).toBe(false);
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

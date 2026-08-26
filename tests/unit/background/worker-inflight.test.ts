/**
 * Issue #2104 — WorkerManager in-flight policy.
 *
 * Regression class: the worker dequeued an item (`shift()`), then called
 * `queue.retry(item.id)` which could never find it. These tests pin the
 * end-to-end retry/complete path through a real WorkerManager loop and the
 * deterministic stop semantics with a handler still running.
 *
 * Time handling: the worker loop polls on real timers, so these tests wait on
 * real elapsed time via a poll-count-bounded `waitFor` — deliberately NOT raw
 * Date-clock reads (the test-clock lint requires freezeClock adoption for
 * those, and freezing the clock would freeze nothing the loop uses while
 * breaking wall-clock deadline math). No assertion depends on clock values;
 * the flaky-retry test uses `defaultBackoffMs: 0` so the scheduled retry is
 * due immediately without patching internal state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetGlobalEventBus } from '../../../src/background/event-bus';
import { AutomationQueue } from '../../../src/background/queue';
import { WorkerManager } from '../../../src/background/worker';

function waitFor(predicate: () => boolean, maxPolls = 200): Promise<void> {
	return new Promise((resolve, reject) => {
		let polls = 0;
		const check = () => {
			if (predicate()) {
				resolve();
				return;
			}
			polls += 1;
			if (polls > maxPolls) {
				reject(new Error('waitFor timeout'));
				return;
			}
			setTimeout(check, 20);
		};
		check();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WorkerManager in-flight policy (issue #2104)', () => {
	let manager: WorkerManager;

	beforeEach(() => {
		resetGlobalEventBus();
		manager = new WorkerManager();
	});

	afterEach(() => {
		manager.stopAll();
	});

	test('a successful handler completes the dequeued item exactly once', async () => {
		const queue = new AutomationQueue<string>();
		let handled = 0;
		manager.register({
			name: 'ok-worker',
			queue,
			handler: async () => {
				handled += 1;
				return { success: true };
			},
			autoStart: true,
		});
		queue.enqueue('job', 'normal');

		await waitFor(() => handled === 1);
		await waitFor(() => queue.size() === 0 && queue.inflightSize() === 0);
		const stats = manager.getStats('ok-worker');
		expect(stats?.processedCount).toBe(1);
		expect(stats?.queueInflight).toBe(0);
		expect(queue.getStats().inflight).toBe(0);
	});

	test('a transiently failing dequeued item is re-enqueued (the #2104 regression)', async () => {
		// defaultBackoffMs 0: the scheduled retry is due immediately, so the
		// loop can pick it up without a real backoff wait and without patching
		// the item's internal nextAttemptAt.
		const queue = new AutomationQueue<string>({
			defaultMaxRetries: 3,
			defaultBackoffMs: 0,
		});
		let attempts = 0;
		manager.register({
			name: 'flaky-worker',
			queue,
			handler: async () => {
				attempts += 1;
				if (attempts === 1) return { success: false, error: 'transient' };
				return { success: true };
			},
			autoStart: true,
		});
		queue.enqueue('job', 'normal');

		// First execution fails; the item must be back in the queued set with
		// attempts incremented instead of being silently dropped.
		await waitFor(() => attempts === 1);
		await waitFor(() => queue.size() === 1 && queue.inflightSize() === 0);
		const scheduled = queue.getAll()[0];
		expect(scheduled?.retry?.attempts).toBe(1);

		await waitFor(() => attempts === 2);
		await waitFor(() => queue.size() === 0 && queue.inflightSize() === 0);
		expect(manager.getStats('flaky-worker')?.processedCount).toBe(1);
	});

	test('stop() is deterministic with an in-flight handler: the handler still settles', async () => {
		const queue = new AutomationQueue<string>();
		let releaseHandler: (() => void) | null = null;
		const handlerStarted = new Promise<void>((resolve) => {
			manager.register({
				name: 'slow-worker',
				queue,
				handler: () =>
					new Promise<{ success: boolean }>((resolveHandler) => {
						resolve();
						releaseHandler = () => resolveHandler({ success: true });
					}),
				autoStart: true,
			});
		});
		const id = queue.enqueue('job', 'normal');
		await handlerStarted;
		expect(queue.inflightSize()).toBe(1);

		expect(manager.stop('slow-worker')).toBe(true);
		expect(manager.getStats('slow-worker')?.status).toBe('stopped');

		// In-flight policy: the handler runs to completion and settles its
		// item through the in-flight map even after stop.
		releaseHandler?.();
		await waitFor(() => queue.inflightSize() === 0);
		expect(queue.complete(id)).toBe(false); // already settled exactly once
	});

	test('no busy loop while the only queued item is inside its retry backoff', async () => {
		const queue = new AutomationQueue<string>({ defaultBackoffMs: 60_000 });
		let handlerCalls = 0;
		manager.register({
			name: 'idle-worker',
			queue,
			handler: async () => {
				handlerCalls += 1;
				return { success: true };
			},
			autoStart: true,
		});
		const id = queue.enqueue('job', 'normal');
		// Schedule a retry 60s out while the item is queued (not in flight).
		queue.retry(id);
		expect(queue.size()).toBe(1);

		// Across several poll intervals the loop must not hand out the item
		// and must not spin the handler.
		await sleep(300);
		expect(handlerCalls).toBe(0);
		expect(queue.size()).toBe(1);
		expect(manager.getStats('idle-worker')?.queueInflight).toBe(0);
	});
});

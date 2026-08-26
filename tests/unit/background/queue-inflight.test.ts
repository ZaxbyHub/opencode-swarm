/**
 * Issue #2104 — AutomationQueue in-flight ownership model.
 *
 * Regression class: `dequeue()` used `shift()`, so `retry(id)` after dequeue
 * found nothing and silently returned false — every transiently failing
 * dequeued item was dropped instead of re-enqueued. These tests pin the
 * exactly-one-of (queued | in-flight | terminal) ownership contract.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
	getGlobalEventBus,
	resetGlobalEventBus,
} from '../../../src/background/event-bus';
import { AutomationQueue } from '../../../src/background/queue';
import { freezeClock } from '../../helpers/test-clock.js';

describe('AutomationQueue in-flight ownership (issue #2104)', () => {
	beforeEach(() => {
		resetGlobalEventBus();
	});

	test('dequeue moves the item to the in-flight set and keeps it addressable', () => {
		const queue = new AutomationQueue<string>();
		const id = queue.enqueue('payload', 'normal');

		const dequeued = queue.dequeue();

		expect(dequeued?.id).toBe(id);
		expect(queue.size()).toBe(0);
		expect(queue.inflightSize()).toBe(1);
		// The previously-lost guarantee: get() still finds the dequeued item.
		expect(queue.get(id)?.payload).toBe('payload');
	});

	test('retry after dequeue re-enqueues the item with attempts incremented', () => {
		const restore = freezeClock({ fixedNow: 10_000 });
		try {
			const queue = new AutomationQueue<string>({
				defaultBackoffMs: 1000,
				defaultMaxRetries: 3,
			});
			const id = queue.enqueue('payload', 'normal');
			queue.dequeue();

			const retried = queue.retry(id, new Error('transient'));

			expect(retried).toBe(true);
			const item = queue.get(id);
			expect(item?.retry?.attempts).toBe(1);
			expect(item?.retry?.nextAttemptAt).toBe(11_000);
			// Back in the queued set, out of the in-flight set.
			expect(queue.size()).toBe(1);
			expect(queue.inflightSize()).toBe(0);
		} finally {
			restore();
		}
	});

	test('an item is never observable in both queued and in-flight state', () => {
		const queue = new AutomationQueue<string>();
		const idA = queue.enqueue('a', 'normal');
		const idB = queue.enqueue('b', 'normal');
		queue.enqueue('c', 'normal');

		queue.dequeue(); // 'a' in flight
		queue.dequeue(); // 'b' in flight

		// The queued view holds only 'c'; the in-flight set holds exactly a+b.
		expect(queue.getAll().map((item) => item.payload)).toEqual(['c']);
		expect(queue.size()).toBe(1);
		expect(queue.inflightSize()).toBe(2);
		expect(queue.get(idA)?.payload).toBe('a');
		expect(queue.get(idB)?.payload).toBe('b');
	});

	test('dequeue honors retry backoff: a not-due item is skipped', () => {
		const restore = freezeClock({ fixedNow: 10_000 });
		try {
			const queue = new AutomationQueue<string>({ defaultBackoffMs: 60_000 });
			queue.enqueue('due', 'low');
			const notDueId = queue.enqueue('not-due', 'high');
			// Schedule the high-priority item for a retry 60s out.
			queue.retry(notDueId);

			const dequeued = queue.dequeue();

			// The due low-priority item wins over the not-due high-priority one.
			expect(dequeued?.payload).toBe('due');
			// The not-due item stays queued, in priority position.
			expect(queue.get(notDueId)?.payload).toBe('not-due');
		} finally {
			restore();
		}
	});

	test('no busy hand-out before nextAttemptAt: dequeue returns undefined until due', () => {
		const queue = new AutomationQueue<string>({ defaultBackoffMs: 60_000 });
		let id = '';
		let restore = freezeClock({ fixedNow: 10_000 });
		try {
			id = queue.enqueue('payload', 'normal');
			queue.retry(id);
			queue.dequeue(); // moves item to in-flight
			queue.retry(id); // back to queued, due at 70_000

			expect(queue.dequeue()).toBeUndefined();
		} finally {
			restore();
		}
		// After the backoff elapses the same item is hand-out-able again.
		restore = freezeClock({ fixedNow: 70_001 });
		try {
			expect(queue.dequeue()?.id).toBe(id);
		} finally {
			restore();
		}
	});

	test('complete is exactly-once for a dequeued item', () => {
		const queue = new AutomationQueue<string>();
		const id = queue.enqueue('payload', 'normal');
		queue.dequeue();

		expect(queue.complete(id)).toBe(true);
		expect(queue.complete(id)).toBe(false);
		expect(queue.inflightSize()).toBe(0);
		expect(queue.size()).toBe(0);
	});

	test('retry exhaustion emits exactly one terminal failure and the item never reappears', () => {
		const queue = new AutomationQueue<string>({ defaultMaxRetries: 2 });
		const failures: string[] = [];
		getGlobalEventBus().subscribe(
			'queue.item.failed',
			(event: { payload?: { itemId?: string } }) => {
				failures.push(event.payload?.itemId ?? '');
			},
		);
		const id = queue.enqueue('payload', 'normal');
		queue.dequeue();

		expect(queue.retry(id)).toBe(true);
		expect(queue.retry(id)).toBe(false); // attempts 2 >= maxAttempts 2
		expect(failures).toEqual([id]);
		// Terminal: gone from every store and every later call is a no-op.
		expect(queue.get(id)).toBeUndefined();
		expect(queue.size()).toBe(0);
		expect(queue.inflightSize()).toBe(0);
		expect(queue.retry(id)).toBe(false);
		expect(queue.complete(id)).toBe(false);
		expect(queue.remove(id)).toBe(false);
		// A second exhaustion cannot emit a second failure event.
		expect(queue.retry(id)).toBe(false);
		expect(failures).toEqual([id]);
	});

	test('a still-queued item can be retried without leaving the queued set', () => {
		const queue = new AutomationQueue<string>({ defaultMaxRetries: 3 });
		const id = queue.enqueue('payload', 'normal');

		expect(queue.retry(id)).toBe(true);
		expect(queue.size()).toBe(1);
		expect(queue.get(id)?.retry?.attempts).toBe(1);
	});

	test('clear() drops queued and in-flight items; a settled ID stays settled', () => {
		const queue = new AutomationQueue<string>();
		const settledId = queue.enqueue('done', 'normal');
		queue.dequeue();
		expect(queue.complete(settledId)).toBe(true);

		const inFlightId = queue.enqueue('running', 'normal');
		queue.dequeue();
		queue.enqueue('queued', 'normal');

		queue.clear();

		expect(queue.size()).toBe(0);
		expect(queue.inflightSize()).toBe(0);
		// The in-flight item was dropped, not completed.
		expect(queue.complete(inFlightId)).toBe(false);
		// The previously terminal ID cannot be resurrected by a late settle.
		expect(queue.complete(settledId)).toBe(false);
	});

	test('the in-flight set is bounded: dequeue returns undefined at the cap', () => {
		const queue = new AutomationQueue<string>({ maxSize: 2 });
		queue.enqueue('a', 'normal');
		queue.enqueue('b', 'normal');

		expect(queue.dequeue()).toBeDefined();
		expect(queue.dequeue()).toBeDefined();
		// In-flight at maxSize: no further hand-out until something settles.
		queue.enqueue('c', 'normal');
		expect(queue.dequeue()).toBeUndefined();
		expect(queue.size()).toBe(1);
	});
});

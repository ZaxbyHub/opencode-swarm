import { beforeEach, describe, expect, test } from 'bun:test';
import { resetGlobalEventBus } from '../../../src/background/event-bus';
import {
	AutomationQueue,
	type QueueItem,
	type QueuePriority,
} from '../../../src/background/queue';

describe('AutomationQueue', () => {
	beforeEach(() => {
		resetGlobalEventBus();
	});

	describe('enqueue and dequeue', () => {
		test('should enqueue items with priority', () => {
			const queue = new AutomationQueue<string>();

			const id1 = queue.enqueue('item1', 'low');
			const id2 = queue.enqueue('item2', 'high');
			const id3 = queue.enqueue('item3', 'critical');

			expect(queue.size()).toBe(3);
			expect(id1).toBeDefined();
			expect(id2).toBeDefined();
			expect(id3).toBeDefined();
		});

		test('should dequeue in priority order', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('low-priority', 'low');
			queue.enqueue('high-priority', 'high');
			queue.enqueue('critical-priority', 'critical');
			queue.enqueue('normal-priority', 'normal');

			const first = queue.dequeue();
			const second = queue.dequeue();
			const third = queue.dequeue();
			const fourth = queue.dequeue();

			expect(first?.payload).toBe('critical-priority');
			expect(second?.payload).toBe('high-priority');
			expect(third?.payload).toBe('normal-priority');
			expect(fourth?.payload).toBe('low-priority');
		});

		test('should maintain FIFO for same priority', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('first', 'normal');
			queue.enqueue('second', 'normal');
			queue.enqueue('third', 'normal');

			const first = queue.dequeue();
			const second = queue.dequeue();
			const third = queue.dequeue();

			expect(first?.payload).toBe('first');
			expect(second?.payload).toBe('second');
			expect(third?.payload).toBe('third');
		});

		test('should throw when queue is full', () => {
			const queue = new AutomationQueue<string>({ maxSize: 2 });

			queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'normal');

			expect(() => queue.enqueue('item3', 'normal')).toThrow('Queue is full');
		});
	});

	describe('peek and get', () => {
		test('should peek without removing', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'high');

			const peeked = queue.peek();
			expect(peeked?.payload).toBe('item2');
			expect(queue.size()).toBe(2);
		});

		test('should get item by ID', () => {
			const queue = new AutomationQueue<string>();

			const id = queue.enqueue('item1', 'normal');
			const item = queue.get(id);

			expect(item?.payload).toBe('item1');
		});

		test('should return undefined for non-existent ID', () => {
			const queue = new AutomationQueue<string>();
			const item = queue.get('non-existent');

			expect(item).toBeUndefined();
		});
	});

	describe('remove and complete', () => {
		test('should remove specific item', () => {
			const queue = new AutomationQueue<string>();

			const id1 = queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'normal');

			const removed = queue.remove(id1);

			expect(removed).toBe(true);
			expect(queue.size()).toBe(1);
			expect(queue.get(id1)).toBeUndefined();
		});

		test('should complete and remove item', () => {
			const queue = new AutomationQueue<string>();

			const id = queue.enqueue('item1', 'normal');
			const completed = queue.complete(id);

			expect(completed).toBe(true);
			expect(queue.size()).toBe(0);
		});

		test('should return false for completing non-existent item', () => {
			const queue = new AutomationQueue<string>();
			const completed = queue.complete('non-existent');

			expect(completed).toBe(false);
		});
	});

	describe('retry handling', () => {
		test('should retry failed item', () => {
			const queue = new AutomationQueue<string>();

			const id = queue.enqueue('item1', 'normal');

			const retried = queue.retry(id, new Error('test error'));

			expect(retried).toBe(true);
			// Item should still be in queue for retry
			expect(queue.size()).toBe(1);
		});

		test('should increment retry attempts', () => {
			const queue = new AutomationQueue<string>({
				defaultMaxRetries: 3,
			});

			const id = queue.enqueue('item1', 'normal');

			queue.retry(id);
			queue.retry(id);

			const item = queue.get(id);
			expect(item?.retry?.attempts).toBe(2);
		});

		test('should remove item after max retries exceeded', () => {
			const queue = new AutomationQueue<string>({
				defaultMaxRetries: 2,
			});

			const id = queue.enqueue('item1', 'normal');

			queue.retry(id);
			queue.retry(id);
			const retried = queue.retry(id); // Third attempt exceeds max

			expect(retried).toBe(false);
			expect(queue.size()).toBe(0);
		});

		test('should calculate exponential backoff', () => {
			const queue = new AutomationQueue<string>({
				defaultBackoffMs: 1000,
				maxBackoffMs: 10000,
			});

			const id = queue.enqueue('item1', 'normal');

			// First retry: backoff = 1000 * 2^0 = 1000
			queue.retry(id);
			const afterFirst = queue.get(id);
			expect(afterFirst?.retry?.nextAttemptAt).toBeDefined();

			// Second retry: backoff = 1000 * 2^1 = 2000
			queue.retry(id);
			const afterSecond = queue.get(id);
			expect(afterSecond?.retry?.nextAttemptAt).toBeDefined();
		});

		test('should get items due for retry', async () => {
			const queue = new AutomationQueue<string>();

			const id1 = queue.enqueue('item1', 'normal');
			const id2 = queue.enqueue('item2', 'normal');

			// Schedule retry in the past
			queue.retry(id1);
			const item1 = queue.get(id1);
			if (item1?.retry) {
				item1.retry.nextAttemptAt = Date.now() - 1000;
			}

			const retryable = queue.getRetryableItems();

			expect(retryable.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('queue statistics', () => {
		test('should return correct size', () => {
			const queue = new AutomationQueue<string>();

			expect(queue.size()).toBe(0);
			expect(queue.isEmpty()).toBe(true);

			queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'normal');

			expect(queue.size()).toBe(2);
			expect(queue.isEmpty()).toBe(false);
		});

		test('should return isFull correctly', () => {
			const queue = new AutomationQueue<string>({ maxSize: 2 });

			expect(queue.isFull()).toBe(false);

			queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'normal');

			expect(queue.isFull()).toBe(true);
		});

		test('should get items by priority', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('low', 'low');
			queue.enqueue('high', 'high');
			queue.enqueue('normal', 'normal');
			queue.enqueue('another-high', 'high');

			const highItems = queue.getByPriority('high');
			expect(highItems).toHaveLength(2);
		});

		test('should return full statistics', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('low', 'low');
			queue.enqueue('high', 'high');
			queue.enqueue('normal', 'normal');

			const stats = queue.getStats();

			expect(stats.size).toBe(3);
			expect(stats.maxSize).toBe(1000);
			expect(stats.byPriority.low).toBe(1);
			expect(stats.byPriority.high).toBe(1);
			expect(stats.byPriority.normal).toBe(1);
			expect(stats.byPriority.critical).toBe(0);
		});

		test('should clear all items', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'normal');

			queue.clear();

			expect(queue.size()).toBe(0);
			expect(queue.isEmpty()).toBe(true);
		});

		test('should get all items', () => {
			const queue = new AutomationQueue<string>();

			queue.enqueue('item1', 'normal');
			queue.enqueue('item2', 'high');

			const all = queue.getAll();

			expect(all).toHaveLength(2);
		});
	});

	describe('queue item structure', () => {
		test('should generate unique IDs', () => {
			const queue = new AutomationQueue<string>();

			const id1 = queue.enqueue('item1', 'normal');
			const id2 = queue.enqueue('item2', 'normal');

			expect(id1).not.toBe(id2);
		});

		test('should include createdAt timestamp', () => {
			const before = Date.now();
			const queue = new AutomationQueue<string>();
			const id = queue.enqueue('item1', 'normal');
			const after = Date.now();

			const item = queue.get(id);
			expect(item?.createdAt).toBeGreaterThanOrEqual(before);
			expect(item?.createdAt).toBeLessThanOrEqual(after);
		});

		test('should store metadata', () => {
			const queue = new AutomationQueue<string>();
			const id = queue.enqueue('item1', 'normal', {
				customField: 'value',
			});

			const item = queue.get(id);
			expect(item?.metadata?.customField).toBe('value');
		});

		test('should initialize retry metadata', () => {
			const queue = new AutomationQueue<string>({
				defaultMaxRetries: 5,
				defaultBackoffMs: 2000,
			});

			const id = queue.enqueue('item1', 'normal');
			const item = queue.get(id);

			expect(item?.retry).toBeDefined();
			expect(item?.retry?.attempts).toBe(0);
			expect(item?.retry?.maxAttempts).toBe(5);
			expect(item?.retry?.backoffMs).toBe(2000);
		});
	});

	describe('overflow strategy (#1778 H5)', () => {
		test('throws at cap by default (fail-loud preserved)', () => {
			const queue = new AutomationQueue<string>({ maxSize: 2 });
			queue.enqueue('a');
			queue.enqueue('b');
			expect(() => queue.enqueue('c')).toThrow('Queue is full');
			expect(queue.size()).toBe(2);
		});

		test('evict-oldest keeps a bounded rolling window without throwing', () => {
			const queue = new AutomationQueue<string>({
				maxSize: 2,
				overflowStrategy: 'evict-oldest',
			});
			const idA = queue.enqueue('a');
			queue.enqueue('b');
			// Third enqueue evicts the oldest ('a') instead of throwing.
			expect(() => queue.enqueue('c')).not.toThrow();
			expect(queue.size()).toBe(2);
			expect(queue.get(idA)).toBeUndefined();
			const payloads = queue.getAll().map((i) => i.payload);
			expect(payloads).toContain('b');
			expect(payloads).toContain('c');
		});
	});
});

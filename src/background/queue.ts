/**
 * Lightweight In-Process Queue with Priorities and Retry Metadata
 *
 * Provides a simple but powerful queue abstraction for background automation.
 * Supports priorities, retry logic, and in-memory persistence only.
 * NOTE: This queue does NOT persist across restarts — all items are lost when the process exits.
 */

import { type AutomationEventBus, getGlobalEventBus } from './event-bus';

/** Queue priority levels */
export type QueuePriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * Behaviour when enqueueing into a full queue.
 * - `throw` (default): reject the new item — the historical behaviour.
 * - `evict-oldest`: drop the oldest item to make room, forming a bounded
 *   rolling window that can never brick (issue #1778 H5). Opt-in per queue so
 *   other consumers keep the fail-loud `throw` semantics.
 */
export type OverflowStrategy = 'throw' | 'evict-oldest';

/** Retry metadata for failed items */
export interface RetryMetadata {
	attempts: number;
	maxAttempts: number;
	lastAttempt?: number;
	nextAttemptAt?: number;
	backoffMs: number;
	maxBackoffMs: number;
}

/** Queue item structure */
export interface QueueItem<T = unknown> {
	id: string;
	priority: QueuePriority;
	payload: T;
	createdAt: number;
	metadata?: Record<string, unknown>;
	retry?: RetryMetadata;
}

/** Queue configuration */
export interface QueueConfig {
	priorityLevels?: QueuePriority[];
	maxSize?: number;
	defaultMaxRetries?: number;
	defaultBackoffMs?: number;
	maxBackoffMs?: number;
	/** Overflow behaviour at cap. Defaults to `throw`. */
	overflowStrategy?: OverflowStrategy;
}

/**
 * Priority comparator for queue ordering
 */
function comparePriority(a: QueueItem, b: QueueItem): number {
	const priorityOrder: Record<QueuePriority, number> = {
		critical: 0,
		high: 1,
		normal: 2,
		low: 3,
	};

	const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
	if (priorityDiff !== 0) return priorityDiff;

	// FIFO for same priority
	return a.createdAt - b.createdAt;
}

/**
 * In-process queue with priority support and retry metadata
 */
export class AutomationQueue<T = unknown> {
	private items: QueueItem<T>[] = [];
	private readonly maxSize: number;
	private readonly defaultMaxRetries: number;
	private readonly defaultBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly eventBus: AutomationEventBus;
	private readonly overflowStrategy: OverflowStrategy;
	private itemCounter = 0;

	constructor(config?: QueueConfig) {
		this.maxSize = config?.maxSize ?? 1000;
		this.defaultMaxRetries = config?.defaultMaxRetries ?? 3;
		this.defaultBackoffMs = config?.defaultBackoffMs ?? 1000;
		this.maxBackoffMs = config?.maxBackoffMs ?? 60000;
		this.overflowStrategy = config?.overflowStrategy ?? 'throw';
		this.eventBus = getGlobalEventBus();
	}

	/**
	 * Generate unique item ID
	 */
	private generateId(): string {
		return `queue-${Date.now()}-${++this.itemCounter}`;
	}

	/**
	 * Enqueue an item with priority
	 */
	enqueue(
		payload: T,
		priority: QueuePriority = 'normal',
		metadata?: Record<string, unknown>,
	): string {
		if (this.items.length >= this.maxSize) {
			if (this.overflowStrategy === 'evict-oldest') {
				// Drop the genuinely oldest item (smallest createdAt) to make room,
				// forming a bounded rolling window instead of a hard brick
				// (issue #1778 H5).
				let oldestIdx = 0;
				for (let i = 1; i < this.items.length; i++) {
					if (this.items[i].createdAt < this.items[oldestIdx].createdAt) {
						oldestIdx = i;
					}
				}
				const [evicted] = this.items.splice(oldestIdx, 1);
				if (evicted) {
					this.eventBus.publish('queue.item.evicted', { itemId: evicted.id });
				}
			} else {
				throw new Error(`Queue is full (max ${this.maxSize} items)`);
			}
		}

		const item: QueueItem<T> = {
			id: this.generateId(),
			priority,
			payload,
			createdAt: Date.now(),
			metadata,
			retry: {
				attempts: 0,
				maxAttempts: this.defaultMaxRetries,
				backoffMs: this.defaultBackoffMs,
				maxBackoffMs: this.maxBackoffMs,
			},
		};

		this.items.push(item);
		// Maintain heap-like property by sorting after insertion
		this.items.sort(comparePriority);

		// Emit event
		this.eventBus.publish('queue.item.enqueued', { itemId: item.id, priority });

		return item.id;
	}

	/**
	 * Dequeue the highest priority item
	 */
	dequeue(): QueueItem<T> | undefined {
		const item = this.items.shift();
		if (item) {
			this.eventBus.publish('queue.item.dequeued', { itemId: item.id });
		}
		return item;
	}

	/**
	 * Peek at the highest priority item without removing
	 */
	peek(): QueueItem<T> | undefined {
		return this.items[0];
	}

	/**
	 * Get item by ID
	 */
	get(id: string): QueueItem<T> | undefined {
		return this.items.find((item) => item.id === id);
	}

	/**
	 * Remove specific item by ID
	 */
	remove(id: string): boolean {
		const index = this.items.findIndex((item) => item.id === id);
		if (index !== -1) {
			this.items.splice(index, 1);
			return true;
		}
		return false;
	}

	/**
	 * Mark item as completed and remove from queue
	 */
	complete(id: string): boolean {
		const removed = this.remove(id);
		if (removed) {
			this.eventBus.publish('queue.item.completed', { itemId: id });
		}
		return removed;
	}

	/**
	 * Mark item as failed and schedule retry if possible
	 */
	retry(id: string, _error?: unknown): boolean {
		const item = this.get(id);
		if (!item || !item.retry) return false;

		item.retry.attempts++;
		item.retry.lastAttempt = Date.now();

		// Check if max retries exceeded
		if (item.retry.attempts >= item.retry.maxAttempts) {
			this.eventBus.publish('queue.item.failed', {
				itemId: id,
				attempts: item.retry.attempts,
			});
			this.remove(id);
			return false;
		}

		// Calculate backoff with exponential growth
		const backoff = Math.min(
			item.retry.backoffMs * 2 ** (item.retry.attempts - 1),
			item.retry.maxBackoffMs,
		);
		item.retry.nextAttemptAt = Date.now() + backoff;

		this.eventBus.publish('queue.item.retry scheduled', {
			itemId: id,
			attempt: item.retry.attempts,
			nextAttemptAt: item.retry.nextAttemptAt,
			backoffMs: backoff,
		});

		return true;
	}

	/**
	 * Get items due for retry
	 */
	getRetryableItems(): QueueItem<T>[] {
		const now = Date.now();
		return this.items.filter(
			(item) => item.retry?.nextAttemptAt && item.retry.nextAttemptAt <= now,
		);
	}

	/**
	 * Get current queue size
	 */
	size(): number {
		return this.items.length;
	}

	/**
	 * Check if queue is empty
	 */
	isEmpty(): boolean {
		return this.items.length === 0;
	}

	/**
	 * Check if queue is full
	 */
	isFull(): boolean {
		return this.items.length >= this.maxSize;
	}

	/**
	 * Clear all items from queue
	 */
	clear(): void {
		this.items = [];
	}

	/**
	 * Get all items (for debugging/inspection)
	 */
	getAll(): QueueItem<T>[] {
		return [...this.items];
	}

	/**
	 * Get items by priority
	 */
	getByPriority(priority: QueuePriority): QueueItem<T>[] {
		return this.items.filter((item) => item.priority === priority);
	}

	/**
	 * Get queue statistics
	 */
	getStats(): {
		size: number;
		maxSize: number;
		byPriority: Record<QueuePriority, number>;
		retryable: number;
	} {
		return {
			size: this.items.length,
			maxSize: this.maxSize,
			byPriority: {
				critical: this.items.filter((i) => i.priority === 'critical').length,
				high: this.items.filter((i) => i.priority === 'high').length,
				normal: this.items.filter((i) => i.priority === 'normal').length,
				low: this.items.filter((i) => i.priority === 'low').length,
			},
			retryable: this.getRetryableItems().length,
		};
	}
}

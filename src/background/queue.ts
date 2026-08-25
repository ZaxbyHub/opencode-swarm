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

/** Bound for the terminal-ID registry (completed / retry-exhausted). */
const MAX_TERMINAL_IDS = 2048;

/**
 * In-process queue with priority support and retry metadata.
 *
 * Ownership model (issue #2104): an item exists in exactly one of three
 * states — `queued` (in `items`), `in-flight` (in `inflight`, handed to a
 * worker by `dequeue`), or `terminal` (recorded in `terminalIds` after
 * `complete` or retry exhaustion). `dequeue` moves queued→in-flight, a
 * scheduled `retry` moves in-flight→queued (honouring `nextAttemptAt`), and
 * `complete`/retry-exhaustion moves either→terminal exactly once. A terminal
 * ID can never be completed, retried, or removed again, so a recycled ID
 * cannot act on a newer item.
 */
export class AutomationQueue<T = unknown> {
	private items: QueueItem<T>[] = [];
	/** Dequeued items awaiting complete/retry; bounded by maxSize. */
	private inflight: Map<string, QueueItem<T>> = new Map();
	/** Terminal IDs (completed or exhausted); FIFO-evicted at the cap. */
	private terminalIds: Map<string, number> = new Map();
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
	 * Dequeue the highest priority item whose retry backoff has elapsed.
	 *
	 * `items` stays sorted by (priority, createdAt); a not-yet-due item is
	 * skipped without reordering, so a due lower-priority item can be handed
	 * out ahead of a not-due higher-priority one. The dequeued item moves to
	 * the in-flight map and remains addressable by ID for `complete`/`retry`
	 * until it settles (issue #2104: previously `shift()` removed it and every
	 * later `retry(id)` silently returned false).
	 */
	dequeue(): QueueItem<T> | undefined {
		if (this.inflight.size >= this.maxSize) return undefined;
		const now = Date.now();
		const index = this.items.findIndex(
			(item) =>
				item.retry?.nextAttemptAt === undefined ||
				item.retry.nextAttemptAt <= now,
		);
		if (index === -1) return undefined;
		const [item] = this.items.splice(index, 1);
		if (!item) return undefined;
		this.inflight.set(item.id, item);
		this.eventBus.publish('queue.item.dequeued', { itemId: item.id });
		return item;
	}

	/**
	 * Peek at the highest priority item without removing
	 */
	peek(): QueueItem<T> | undefined {
		return this.items[0];
	}

	/**
	 * Get item by ID (searches queued and in-flight items)
	 */
	get(id: string): QueueItem<T> | undefined {
		return this.items.find((item) => item.id === id) ?? this.inflight.get(id);
	}

	/** Number of items currently in flight (dequeued, not yet settled). */
	inflightSize(): number {
		return this.inflight.size;
	}

	private removeQueuedOrInflight(id: string): QueueItem<T> | undefined {
		const queuedIndex = this.items.findIndex((item) => item.id === id);
		if (queuedIndex !== -1) {
			const [removed] = this.items.splice(queuedIndex, 1);
			return removed;
		}
		const inflightItem = this.inflight.get(id);
		if (inflightItem) this.inflight.delete(id);
		return inflightItem;
	}

	private markTerminal(id: string, at: number): void {
		this.terminalIds.set(id, at);
		if (this.terminalIds.size > MAX_TERMINAL_IDS) {
			const oldest = this.terminalIds.keys().next().value;
			if (oldest !== undefined) this.terminalIds.delete(oldest);
		}
	}

	/**
	 * Remove specific item by ID (queued or in-flight)
	 */
	remove(id: string): boolean {
		if (this.terminalIds.has(id)) return false;
		return this.removeQueuedOrInflight(id) !== undefined;
	}

	/**
	 * Mark item as completed and remove from queue. Exactly once: a second
	 * call for the same ID (or one for a recycled ID) returns false.
	 */
	complete(id: string): boolean {
		if (this.terminalIds.has(id)) return false;
		const removed = this.removeQueuedOrInflight(id);
		if (!removed) return false;
		this.markTerminal(id, Date.now());
		this.eventBus.publish('queue.item.completed', { itemId: id });
		return true;
	}

	/**
	 * Mark item as failed and schedule retry if possible.
	 *
	 * Increments attempts exactly once per failed execution. On exhaustion the
	 * item becomes terminal: exactly one `queue.item.failed` event is emitted
	 * and the ID can never reappear. Otherwise the item returns to the queued
	 * set with `nextAttemptAt` honoured by `dequeue` before it can be handed
	 * out again (works for in-flight and still-queued items alike).
	 */
	retry(id: string, _error?: unknown): boolean {
		if (this.terminalIds.has(id)) return false;
		const item = this.get(id);
		if (!item || !item.retry) return false;

		item.retry.attempts++;
		item.retry.lastAttempt = Date.now();

		// Check if max retries exceeded
		if (item.retry.attempts >= item.retry.maxAttempts) {
			this.removeQueuedOrInflight(id);
			this.markTerminal(id, Date.now());
			this.eventBus.publish('queue.item.failed', {
				itemId: id,
				attempts: item.retry.attempts,
			});
			return false;
		}

		// Calculate backoff with exponential growth
		const backoff = Math.min(
			item.retry.backoffMs * 2 ** (item.retry.attempts - 1),
			item.retry.maxBackoffMs,
		);
		item.retry.nextAttemptAt = Date.now() + backoff;

		// A failed in-flight execution returns to the queued set; a still-queued
		// item (scheduled retry) simply gets a fresh nextAttemptAt.
		this.inflight.delete(id);
		if (!this.items.some((queued) => queued.id === id)) {
			this.items.push(item);
			this.items.sort(comparePriority);
		}

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
	 * Clear all items from queue.
	 *
	 * Reset policy (issue #2104): both the queued set AND the in-flight set
	 * are dropped — an in-flight item whose handler is still running will find
	 * its later `complete`/`retry` returning false (the ID is no longer known;
	 * it is NOT marked terminal). The bounded terminal-ID registry is kept so
	 * recycling cannot resurrect a settled ID.
	 */
	clear(): void {
		for (const item of this.items) {
			this.eventBus.publish('queue.item.evicted', { itemId: item.id });
		}
		this.items = [];
		for (const item of this.inflight.values()) {
			this.eventBus.publish('queue.item.evicted', { itemId: item.id });
		}
		this.inflight.clear();
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
		inflight: number;
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
			inflight: this.inflight.size,
		};
	}
}

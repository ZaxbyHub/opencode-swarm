/**
 * Worker Lifecycle Manager
 *
 * Manages worker threads for background automation.
 * Handles registration, start/stop, and handler coordination.
 */

import { type AutomationEventBus, getGlobalEventBus } from './event-bus';
import type { AutomationQueue, QueueItem } from './queue';

/** Worker handler function */
export type WorkerHandler<T = unknown> = (
	item: QueueItem<T>,
) => Promise<{ success: boolean; result?: unknown; error?: unknown }>;

/** Worker registration options */
export interface WorkerRegistration {
	name: string;
	handler: WorkerHandler;
	queue: AutomationQueue;
	concurrency?: number;
	autoStart?: boolean;
}

/** Worker status */
export type WorkerStatus =
	| 'idle'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'error';

/** Worker instance */
interface Worker {
	name: string;
	handler: WorkerHandler;
	queue: AutomationQueue;
	concurrency: number;
	status: WorkerStatus;
	activeCount: number;
	processedCount: number;
	errorCount: number;
	lastError?: unknown;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Worker Lifecycle Manager
 *
 * Manages worker registration, lifecycle, and processing.
 */
export class WorkerManager {
	private workers: Map<string, Worker> = new Map();
	private readonly eventBus: AutomationEventBus;

	constructor() {
		this.eventBus = getGlobalEventBus();
	}

	/**
	 * Register a new worker
	 */
	register(registration: WorkerRegistration): void {
		if (this.workers.has(registration.name)) {
			throw new Error(`Worker '${registration.name}' is already registered`);
		}

		const worker: Worker = {
			name: registration.name,
			handler: registration.handler,
			queue: registration.queue,
			concurrency: registration.concurrency ?? 1,
			status: 'idle',
			activeCount: 0,
			processedCount: 0,
			errorCount: 0,
		};

		this.workers.set(registration.name, worker);

		this.eventBus.publish('worker.started', {
			workerName: registration.name,
			concurrency: worker.concurrency,
		});

		// Auto-start if requested
		if (registration.autoStart) {
			this.start(registration.name);
		}
	}

	/**
	 * Unregister a worker
	 */
	unregister(name: string): boolean {
		const worker = this.workers.get(name);
		if (!worker) return false;

		// Stop if running
		if (worker.status === 'running') {
			this.stop(name);
		}

		this.workers.delete(name);
		return true;
	}

	/**
	 * Start a worker
	 */
	start(name: string): boolean {
		const worker = this.workers.get(name);
		if (!worker) {
			throw new Error(`Worker '${name}' is not registered`);
		}

		if (worker.status === 'running') {
			return false; // Already running
		}

		worker.status = 'running';

		// Start the processing loop
		this.startProcessingLoop(worker);

		this.eventBus.publish('worker.started', {
			workerName: name,
			concurrency: worker.concurrency,
		});

		return true;
	}

	/**
	 * Start processing loop for a worker.
	 *
	 * The loop polls (bounded sleeps: 50 ms at the concurrency cap, 100 ms
	 * when idle or when every queued item is still inside its retry backoff —
	 * `dequeue` returns undefined for not-yet-due items, so there is no busy
	 * loop and no retry can run before `nextAttemptAt`).
	 */
	private startProcessingLoop(worker: Worker): void {
		const processLoop = async () => {
			while (worker.status === 'running') {
				// Check concurrency limit
				if (worker.activeCount >= worker.concurrency) {
					await sleep(50);
					continue;
				}

				// Try to get an item from the queue
				const item = worker.queue.dequeue();
				if (!item) {
					// No items, wait before checking again
					await sleep(100);
					continue;
				}

				// Process item
				worker.activeCount++;

				this.handleItem(worker, item).finally(() => {
					worker.activeCount--;
				});
			}
		};

		// Start the loop asynchronously
		processLoop().catch((error) => {
			this.eventBus.publish('worker.error', {
				workerName: worker.name,
				itemId: 'loop',
				error,
			});
		});
	}

	/**
	 * Handle a single queue item.
	 *
	 * The item is in the queue's in-flight set for the whole handler run
	 * (issue #2104), so both `complete` and `retry` address it reliably even
	 * though `dequeue` already removed it from the queued array.
	 */
	private async handleItem(worker: Worker, item: QueueItem): Promise<void> {
		try {
			const result = await worker.handler(item);

			if (result.success) {
				worker.processedCount++;
				worker.queue.complete(item.id);
			} else {
				worker.errorCount++;
				worker.lastError = result.error;
				// Schedule retry
				worker.queue.retry(item.id, result.error);
			}
		} catch (error) {
			worker.errorCount++;
			worker.lastError = error;

			this.eventBus.publish('worker.error', {
				workerName: worker.name,
				itemId: item.id,
				error,
			});

			// Try to schedule retry
			worker.queue.retry(item.id, error);
		}
	}

	/**
	 * Stop a worker.
	 *
	 * In-flight policy (issue #2104): stopping marks the worker so the loop
	 * exits at its next bounded check (≤100 ms later); already-running
	 * handlers are NOT cancelled — they run to completion and settle their
	 * item through the queue's in-flight `complete`/`retry`. Queued items
	 * stay queued for a future `start`. The method stays synchronous, so it
	 * does not wait for those handlers; use the queue's `inflightSize()`
	 * (exposed via `getStats().queueInflight`) to observe drain progress.
	 */
	stop(name: string): boolean {
		const worker = this.workers.get(name);
		if (!worker) return false;

		if (worker.status !== 'running') {
			return false;
		}

		worker.status = 'stopping';

		this.eventBus.publish('worker.stopped', {
			workerName: name,
			processedCount: worker.processedCount,
			errorCount: worker.errorCount,
		});

		worker.status = 'stopped';
		return true;
	}

	/**
	 * Start all workers
	 */
	startAll(): void {
		for (const [name, worker] of this.workers) {
			if (worker.status === 'idle' || worker.status === 'stopped') {
				this.start(name);
			}
		}
	}

	/**
	 * Stop all workers
	 */
	stopAll(): void {
		for (const name of this.workers.keys()) {
			this.stop(name);
		}
	}

	/**
	 * Get worker status
	 */
	getStatus(name: string): WorkerStatus | undefined {
		return this.workers.get(name)?.status;
	}

	/**
	 * Get worker statistics
	 */
	getStats(name: string):
		| {
				status: WorkerStatus;
				activeCount: number;
				processedCount: number;
				errorCount: number;
				lastError?: unknown;
				queueSize: number;
				queueInflight: number;
		  }
		| undefined {
		const worker = this.workers.get(name);
		if (!worker) return undefined;

		return {
			status: worker.status,
			activeCount: worker.activeCount,
			processedCount: worker.processedCount,
			errorCount: worker.errorCount,
			lastError: worker.lastError,
			queueSize: worker.queue.size(),
			queueInflight: worker.queue.inflightSize(),
		};
	}

	/**
	 * Get all worker names
	 */
	getWorkerNames(): string[] {
		return Array.from(this.workers.keys());
	}

	/**
	 * Check if any workers are running
	 */
	isAnyRunning(): boolean {
		for (const worker of this.workers.values()) {
			if (worker.status === 'running') {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get total statistics across all workers
	 */
	getTotalStats(): Record<string, ReturnType<WorkerManager['getStats']>> {
		const stats: Record<string, ReturnType<WorkerManager['getStats']>> = {};
		for (const name of this.workers.keys()) {
			stats[name] = this.getStats(name);
		}
		return stats;
	}
}

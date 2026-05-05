/**
 * Typed Event Bus for Internal Automation Events
 *
 * Provides a type-safe event system for background automation.
 * Events flow through the system without external dependencies.
 */

import { log } from '../utils';

/** Automation event types */
export type AutomationEventType =
	| 'queue.item.enqueued'
	| 'queue.item.dequeued'
	| 'queue.item.completed'
	| 'queue.item.failed'
	| 'queue.item.retry scheduled'
	| 'worker.started'
	| 'worker.stopped'
	| 'worker.error'
	| 'circuit.breaker.opened'
	| 'circuit.breaker.half-open'
	| 'circuit.breaker.closed'
	| 'loop.protection.triggered'
	| 'automation.started'
	| 'automation.stopped'
	| 'preflight.requested'
	| 'preflight.triggered'
	| 'preflight.skipped'
	| 'preflight.completed'
	| 'phase.boundary.detected'
	| 'phase.status.checked'
	| 'task.completed'
	| 'evidence.summary.generated'
	| 'evidence.summary.error'
	| 'curator.init.completed'
	| 'curator.init.llm_completed'
	| 'curator.init.llm_fallback'
	| 'curator.phase.completed'
	| 'curator.phase.llm_completed'
	| 'curator.phase.llm_fallback'
	| 'curator.drift.completed'
	| 'curator.error';

/** Base automation event */
export interface AutomationEvent<T = unknown> {
	type: AutomationEventType;
	timestamp: number;
	payload: T;
	source?: string;
}

/** Event listener type */
export type EventListener<T = unknown> = (
	event: AutomationEvent<T>,
) => void | Promise<void>;

/**
 * Type-safe event bus for automation events
 */
export class AutomationEventBus {
	private listeners: Map<AutomationEventType, Set<EventListener>> = new Map();
	private eventHistory: AutomationEvent[] = [];
	private readonly maxHistorySize: number;

	constructor(options?: { maxHistorySize?: number }) {
		this.maxHistorySize = options?.maxHistorySize ?? 100;
	}

	/**
	 * Subscribe to an event type
	 */
	subscribe<T>(
		type: AutomationEventType,
		listener: EventListener<T>,
	): () => void {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, new Set());
		}
		this.listeners.get(type)!.add(listener as EventListener);

		// Return unsubscribe function
		return () => {
			this.listeners.get(type)?.delete(listener as EventListener);
		};
	}

	/**
	 * Publish an event to all subscribers
	 */
	async publish<T>(
		type: AutomationEventType,
		payload: T,
		source?: string,
	): Promise<void> {
		const event: AutomationEvent<T> = {
			type,
			timestamp: Date.now(),
			payload,
			source,
		};

		// Store in history
		this.eventHistory.push(event as AutomationEvent);
		if (this.eventHistory.length > this.maxHistorySize) {
			this.eventHistory.shift();
		}

		// Log for debugging
		log(`[EventBus] ${type}`, {
			source,
			payload: typeof payload === 'object' ? '...' : payload,
		});

		// Notify listeners
		const listeners = this.listeners.get(type);
		if (listeners) {
			await Promise.all(
				Array.from(listeners).map(async (listener) => {
					try {
						await listener(event);
					} catch (error) {
						log(`[EventBus] Listener error for ${type}`, { error });
					}
				}),
			);
		}
	}

	/**
	 * Get recent event history
	 */
	getHistory(types?: AutomationEventType[]): AutomationEvent[] {
		if (!types || types.length === 0) {
			return [...this.eventHistory];
		}
		return this.eventHistory.filter((e) => types.includes(e.type));
	}

	/**
	 * Clear event history
	 */
	clearHistory(): void {
		this.eventHistory = [];
	}

	/**
	 * Get listener count for an event type
	 */
	getListenerCount(type: AutomationEventType): number {
		return this.listeners.get(type)?.size ?? 0;
	}

	/**
	 * Check if any listeners exist for a type
	 */
	hasListeners(type: AutomationEventType): boolean {
		return this.getListenerCount(type) > 0;
	}
}

/** Singleton instance for framework-wide events */
let globalEventBus: AutomationEventBus | null = null;

/**
 * Get or create the global event bus instance
 */
export function getGlobalEventBus(): AutomationEventBus {
	if (!globalEventBus) {
		globalEventBus = new AutomationEventBus();
	}
	return globalEventBus;
}

/**
 * Reset the global event bus (for testing)
 */
export function resetGlobalEventBus(): void {
	globalEventBus = null;
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	getGlobalEventBus: typeof getGlobalEventBus;
	resetGlobalEventBus: typeof resetGlobalEventBus;
} = {
	getGlobalEventBus,
	resetGlobalEventBus,
} as const;

/**
 * Typed Event Bus for Internal Automation Events
 *
 * Provides a type-safe event system for background automation.
 * Events flow through the system without external dependencies.
 */
/** Automation event types */
export type AutomationEventType = 'queue.item.enqueued' | 'queue.item.dequeued' | 'queue.item.completed' | 'queue.item.failed' | 'queue.item.retry scheduled' | 'worker.started' | 'worker.stopped' | 'worker.error' | 'circuit.breaker.opened' | 'circuit.breaker.half-open' | 'circuit.breaker.closed' | 'loop.protection.triggered' | 'automation.started' | 'automation.stopped' | 'preflight.requested' | 'preflight.triggered' | 'preflight.skipped' | 'preflight.completed' | 'phase.boundary.detected' | 'phase.status.checked' | 'task.completed' | 'evidence.summary.generated' | 'evidence.summary.error' | 'curator.init.completed' | 'curator.init.llm_completed' | 'curator.init.llm_fallback' | 'curator.phase.completed' | 'curator.phase.llm_completed' | 'curator.phase.llm_fallback' | 'curator.drift.completed' | 'curator.error';
/** Base automation event */
export interface AutomationEvent<T = unknown> {
    type: AutomationEventType;
    timestamp: number;
    payload: T;
    source?: string;
}
/** Event listener type */
export type EventListener<T = unknown> = (event: AutomationEvent<T>) => void | Promise<void>;
/**
 * Type-safe event bus for automation events
 */
export declare class AutomationEventBus {
    private listeners;
    private eventHistory;
    private readonly maxHistorySize;
    constructor(options?: {
        maxHistorySize?: number;
    });
    /**
     * Subscribe to an event type
     */
    subscribe<T>(type: AutomationEventType, listener: EventListener<T>): () => void;
    /**
     * Publish an event to all subscribers
     */
    publish<T>(type: AutomationEventType, payload: T, source?: string): Promise<void>;
    /**
     * Get recent event history
     */
    getHistory(types?: AutomationEventType[]): AutomationEvent[];
    /**
     * Clear event history
     */
    clearHistory(): void;
    /**
     * Get listener count for an event type
     */
    getListenerCount(type: AutomationEventType): number;
    /**
     * Check if any listeners exist for a type
     */
    hasListeners(type: AutomationEventType): boolean;
}
/**
 * Get or create the global event bus instance
 */
export declare function getGlobalEventBus(): AutomationEventBus;
/**
 * Reset the global event bus (for testing)
 */
export declare function resetGlobalEventBus(): void;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    getGlobalEventBus: typeof getGlobalEventBus;
    resetGlobalEventBus: typeof resetGlobalEventBus;
};

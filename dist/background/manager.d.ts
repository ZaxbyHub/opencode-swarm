/**
 * Background Automation Manager
 *
 * Main entry point for the background automation framework.
 * Handles feature flag gating and orchestrates all components.
 */
import type { AutomationConfig } from '../config/schema';
import { CircuitBreaker, type CircuitBreakerConfig, LoopProtection, type LoopProtectionConfig } from './circuit-breaker';
import { type AutomationEvent, type AutomationEventType } from './event-bus';
import { AutomationQueue } from './queue';
import { WorkerManager, type WorkerRegistration } from './worker';
/** Framework configuration */
export interface AutomationFrameworkConfig {
    /** Enable/disable the entire framework */
    enabled: boolean;
    /** Max queue size */
    maxQueueSize?: number;
    /** Max retries for failed items */
    maxRetries?: number;
    /** Circuit breaker config */
    circuitBreaker?: Partial<CircuitBreakerConfig>;
    /** Loop protection config */
    loopProtection?: Partial<LoopProtectionConfig>;
}
/**
 * Background Automation Manager
 *
 * Provides a unified interface for background automation with feature flag gating.
 * All components are optional and only activated when enabled.
 */
export declare class BackgroundAutomationManager {
    private readonly config;
    private readonly eventBus;
    private readonly workerManager;
    private readonly queues;
    private readonly circuitBreakers;
    private readonly loopProtections;
    private isInitialized;
    private isRunning;
    constructor(config: AutomationFrameworkConfig);
    /**
     * Initialize the automation framework
     * Only performs work if enabled
     */
    initialize(): void;
    /**
     * Start the automation framework
     */
    start(): void;
    /**
     * Stop the automation framework
     */
    stop(): void;
    /**
     * Check if framework is enabled
     */
    isEnabled(): boolean;
    /**
     * Check if framework is running
     */
    isActive(): boolean;
    /**
     * Create or get a named queue
     */
    getOrCreateQueue<T>(name: string): AutomationQueue<T>;
    /**
     * Register a worker with the framework
     */
    registerWorker(registration: WorkerRegistration): void;
    /**
     * Start a specific worker
     */
    startWorker(name: string): boolean;
    /**
     * Stop a specific worker
     */
    stopWorker(name: string): boolean;
    /**
     * Get or create a circuit breaker
     */
    getOrCreateCircuitBreaker(name: string): CircuitBreaker;
    /**
     * Get or create loop protection
     */
    getOrCreateLoopProtection(operationKey: string): LoopProtection;
    /**
     * Subscribe to automation events
     */
    subscribe<T>(type: AutomationEventType, listener: (event: AutomationEvent<T>) => void | Promise<void>): () => void;
    /**
     * Publish an event to the automation event bus
     */
    publish<T>(type: AutomationEventType, payload: T, source?: string): Promise<void>;
    /**
     * Get framework statistics
     */
    getStats(): {
        enabled: boolean;
        initialized: boolean;
        running: boolean;
        queues: Record<string, ReturnType<AutomationQueue['getStats']>>;
        workers: Record<string, ReturnType<WorkerManager['getStats']>>;
        circuitBreakers: Record<string, ReturnType<CircuitBreaker['getStats']>>;
        loopProtections: string[];
    };
    /**
     * Reset the framework (for testing)
     */
    reset(): void;
}
/**
 * Get or create the global automation manager
 */
export declare function getAutomationManager(config?: AutomationFrameworkConfig): BackgroundAutomationManager;
/**
 * Initialize automation manager from plugin config
 */
export declare function createAutomationManager(automationConfig: AutomationConfig | undefined): BackgroundAutomationManager;
/**
 * Reset the global manager (for testing)
 */
export declare function resetAutomationManager(): void;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    getAutomationManager: typeof getAutomationManager;
    createAutomationManager: typeof createAutomationManager;
    resetAutomationManager: typeof resetAutomationManager;
};

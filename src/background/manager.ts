/**
 * Background Automation Manager
 *
 * Main entry point for the background automation framework.
 * Handles feature flag gating and orchestrates all components.
 */

import type { AutomationConfig } from '../config/schema';
import { log } from '../utils';
import {
	CircuitBreaker,
	type CircuitBreakerConfig,
	LoopProtection,
	type LoopProtectionConfig,
} from './circuit-breaker';
import {
	type AutomationEvent,
	type AutomationEventBus,
	type AutomationEventType,
	getGlobalEventBus,
} from './event-bus';
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
export class BackgroundAutomationManager {
	private readonly config: AutomationFrameworkConfig;
	private readonly eventBus: AutomationEventBus;
	private readonly workerManager: WorkerManager;
	private readonly queues: Map<string, AutomationQueue> = new Map();
	private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();
	private readonly loopProtections: Map<string, LoopProtection> = new Map();
	private isInitialized = false;
	private isRunning = false;

	constructor(config: AutomationFrameworkConfig) {
		// Apply defaults
		this.config = {
			enabled: config.enabled,
			maxQueueSize: config.maxQueueSize ?? 1000,
			maxRetries: config.maxRetries ?? 3,
			circuitBreaker: config.circuitBreaker,
			loopProtection: config.loopProtection,
		};

		this.eventBus = getGlobalEventBus();
		this.workerManager = new WorkerManager();
	}

	/**
	 * Initialize the automation framework
	 * Only performs work if enabled
	 */
	initialize(): void {
		if (!this.config.enabled) {
			log('[Automation] Framework disabled, skipping initialization');
			return;
		}

		if (this.isInitialized) {
			log('[Automation] Already initialized');
			return;
		}

		log('[Automation] Initializing framework...');
		this.isInitialized = true;

		this.eventBus.publish('automation.started', {
			config: this.config,
		});
	}

	/**
	 * Start the automation framework
	 */
	start(): void {
		if (!this.config.enabled || !this.isInitialized) {
			return;
		}

		if (this.isRunning) {
			return;
		}

		log('[Automation] Starting framework...');
		this.isRunning = true;

		this.eventBus.publish('automation.started', {
			timestamp: Date.now(),
		});
	}

	/**
	 * Stop the automation framework
	 */
	stop(): void {
		if (!this.isRunning) {
			return;
		}

		log('[Automation] Stopping framework...');
		this.workerManager.stopAll();
		this.isRunning = false;

		this.eventBus.publish('automation.stopped', {
			timestamp: Date.now(),
		});
	}

	/**
	 * Check if framework is enabled
	 */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Check if framework is running
	 */
	isActive(): boolean {
		return this.isRunning;
	}

	/**
	 * Create or get a named queue
	 */
	getOrCreateQueue<T>(name: string): AutomationQueue<T> {
		if (!this.queues.has(name)) {
			const queue = new AutomationQueue<T>({
				maxSize: this.config.maxQueueSize,
				defaultMaxRetries: this.config.maxRetries,
			});
			this.queues.set(name, queue);
		}
		return this.queues.get(name) as AutomationQueue<T>;
	}

	/**
	 * Register a worker with the framework
	 */
	registerWorker(registration: WorkerRegistration): void {
		if (!this.config.enabled) {
			throw new Error(
				'Cannot register worker: automation framework is disabled',
			);
		}

		this.workerManager.register(registration);
	}

	/**
	 * Start a specific worker
	 */
	startWorker(name: string): boolean {
		if (!this.config.enabled) return false;
		return this.workerManager.start(name);
	}

	/**
	 * Stop a specific worker
	 */
	stopWorker(name: string): boolean {
		if (!this.config.enabled) return false;
		return this.workerManager.stop(name);
	}

	/**
	 * Get or create a circuit breaker
	 */
	getOrCreateCircuitBreaker(name: string): CircuitBreaker {
		if (!this.circuitBreakers.has(name)) {
			const cb = new CircuitBreaker(
				name,
				this.config.circuitBreaker,
				(eventType, event) => {
					log(`[CircuitBreaker] ${name}: ${eventType}`, event);
					// Publish generic event - circuit breaker emits its own events
					this.eventBus.publish('circuit.breaker.opened', {
						breakerName: name,
						eventType,
						event,
					});
				},
			);
			this.circuitBreakers.set(name, cb);
		}
		return this.circuitBreakers.get(name)!;
	}

	/**
	 * Get or create loop protection
	 */
	getOrCreateLoopProtection(operationKey: string): LoopProtection {
		if (!this.loopProtections.has(operationKey)) {
			const config: LoopProtectionConfig = {
				maxIterations: this.config.loopProtection?.maxIterations ?? 10,
				timeWindowMs: this.config.loopProtection?.timeWindowMs ?? 60000,
				operationKey,
			};
			const lp = new LoopProtection(config, (key, count) => {
				log(
					`[LoopProtection] ${key}: Detected potential loop (${count} iterations)`,
				);
				this.eventBus.publish('loop.protection.triggered', {
					operationKey: key,
					count,
					timestamp: Date.now(),
				});
			});
			this.loopProtections.set(operationKey, lp);
		}
		return this.loopProtections.get(operationKey)!;
	}

	/**
	 * Subscribe to automation events
	 */
	subscribe<T>(
		type: AutomationEventType,
		listener: (event: AutomationEvent<T>) => void | Promise<void>,
	): () => void {
		return this.eventBus.subscribe(type, listener);
	}

	/**
	 * Publish an event to the automation event bus
	 */
	async publish<T>(
		type: AutomationEventType,
		payload: T,
		source?: string,
	): Promise<void> {
		await this.eventBus.publish(type, payload, source);
	}

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
	} {
		return {
			enabled: this.config.enabled,
			initialized: this.isInitialized,
			running: this.isRunning,
			queues: Object.fromEntries(
				Array.from(this.queues.entries()).map(([name, queue]) => [
					name,
					queue.getStats(),
				]),
			),
			workers: this.workerManager.getTotalStats(),
			circuitBreakers: Object.fromEntries(
				Array.from(this.circuitBreakers.entries()).map(([name, cb]) => [
					name,
					cb.getStats(),
				]),
			),
			loopProtections: Array.from(this.loopProtections.keys()),
		};
	}

	/**
	 * Reset the framework (for testing)
	 */
	reset(): void {
		this.stop();
		this.workerManager.stopAll();
		this.queues.clear();
		this.circuitBreakers.clear();
		this.loopProtections.clear();
		this.isInitialized = false;
	}
}

/** Singleton instance */
let managerInstance: BackgroundAutomationManager | null = null;

/**
 * Get or create the global automation manager
 */
export function getAutomationManager(
	config?: AutomationFrameworkConfig,
): BackgroundAutomationManager {
	if (!managerInstance && config) {
		managerInstance = new BackgroundAutomationManager(config);
	}
	if (!managerInstance) {
		throw new Error(
			'Automation manager not initialized. Provide config to create it.',
		);
	}
	return managerInstance;
}

/**
 * Initialize automation manager from plugin config
 */
export function createAutomationManager(
	automationConfig: AutomationConfig | undefined,
): BackgroundAutomationManager {
	// Only enable if automation mode is not 'manual' (the default)
	const isEnabled = automationConfig?.mode !== 'manual';

	const config: AutomationFrameworkConfig = {
		enabled: isEnabled,
		maxQueueSize: 500,
		maxRetries: 3,
		circuitBreaker: {
			failureThreshold: 5,
			resetTimeoutMs: 30000,
			successThreshold: 2,
			callTimeoutMs: 15000,
		},
		loopProtection: {
			maxIterations: 10,
			timeWindowMs: 60000,
		},
	};

	const manager = new BackgroundAutomationManager(config);
	manager.initialize();

	return manager;
}

/**
 * Reset the global manager (for testing)
 */
export function resetAutomationManager(): void {
	if (managerInstance) {
		managerInstance.reset();
		managerInstance = null;
	}
}

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	getAutomationManager: typeof getAutomationManager;
	createAutomationManager: typeof createAutomationManager;
	resetAutomationManager: typeof resetAutomationManager;
} = {
	getAutomationManager,
	createAutomationManager,
	resetAutomationManager,
} as const;

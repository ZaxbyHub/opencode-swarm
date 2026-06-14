/**
 * Background Automation Framework
 *
 * Provides infrastructure for v6.7 background-first automation:
 * - Typed event bus for internal automation events
 * - Lightweight in-process queue with priorities and retry metadata
 * - Worker lifecycle manager (start/stop/register handlers)
 * - Circuit breaker + loop protection primitives
 * - Phase-boundary trigger detection and preflight request plumbing
 * - Passive status artifact writer for GUI visibility
 *
 * Gated behind Task 5.2 automation feature flags and default-off behavior.
 */

export {
	CircuitBreaker,
	type CircuitBreakerConfig,
	type CircuitBreakerState,
	LoopProtection,
} from './circuit-breaker';
// Re-export all background components
export {
	type AutomationEvent,
	AutomationEventBus,
	type AutomationEventType,
} from './event-bus';
// v6.7 Task 5.8: Evidence summary background integration
export {
	createEvidenceSummaryIntegration,
	type EvidenceSummaryIntegrationConfig,
	type EvidenceSummaryTriggerEvent,
	type EvidenceSummaryTriggerPayload,
} from './evidence-summary-integration';
export {
	type AutomationFrameworkConfig,
	BackgroundAutomationManager,
	createAutomationManager,
} from './manager';
// v6.7 Task 3.4: Plan sync worker for plan.json -> plan.md sync
export {
	PlanSyncWorker,
	type PlanSyncWorkerOptions,
	type PlanSyncWorkerStatus,
} from './plan-sync-worker';
// PR Event Subscribers for advisory notification delivery
export {
	type PrEventSubscriberOptions,
	registerPrEventSubscribers,
} from './pr-event-subscribers';
// PR Monitor Worker for background PR status polling (lazy-started)
export {
	PrMonitorWorker,
	type PrMonitorWorkerOptions,
	type PrMonitorWorkerStatus,
} from './pr-monitor-worker';
export {
	AutomationQueue,
	type QueueItem,
	type QueuePriority,
	type RetryMetadata,
} from './queue';
// v6.7 Task 5.5: Passive status artifact writer
export {
	AutomationStatusArtifact,
	type AutomationStatusSnapshot,
} from './status-artifact';
// v6.7 Task 5.5: Phase-boundary preflight trigger plumbing
export {
	type PhaseBoundaryResult,
	PhaseBoundaryTrigger,
	type PreflightHandler,
	type PreflightRequest,
	type PreflightRequestPayload,
	type PreflightTriggerConfig,
	type PreflightTriggerEventType,
	PreflightTriggerManager,
} from './trigger';
export {
	type WorkerHandler,
	WorkerManager,
	type WorkerRegistration,
} from './worker';

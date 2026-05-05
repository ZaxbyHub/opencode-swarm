/**
 * Typed error for concurrent plan modification (#444 item 3).
 * Thrown when savePlan exhausts CAS retries due to concurrent writers.
 * Callers can catch this specifically to refresh and retry at the outer level.
 */
export declare class PlanConcurrentModificationError extends Error {
    constructor(message: string);
}
import { type Plan, type RuntimePlan, type TaskStatus } from '../config/plan-schema';
import { type LedgerEvent, type LedgerEventInput } from './ledger';
/** Reset the startup ledger check flag. For testing only. */
export declare function resetStartupLedgerCheck(): void;
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPlan(...)`, `_internals.loadPlanJsonOnly(...)`, etc. so tests
 * can replace the functions on this object without touching the real module —
 * `mock.module` from `bun:test` leaks across files in Bun's shared test-runner
 * process, which would corrupt unrelated suites. Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export declare const _internals: {
    loadPlan: typeof loadPlan;
    loadPlanJsonOnly: typeof loadPlanJsonOnly;
    regeneratePlanMarkdown: typeof regeneratePlanMarkdown;
};
/**
 * Append a ledger event with exponential-backoff retry on stale-writer conflicts.
 *
 * Replaces the raw `appendLedgerEventWithRetry` call in savePlan with a helper
 * that uses the project-standard backoff schedule and emits observable telemetry
 * on each retry. Hash values in telemetry are truncated to 8-char prefixes to
 * avoid leaking full content hashes into event streams.
 *
 * Backoff schedule: start=5ms, doubles each attempt, cap=250ms, ±25% jitter.
 */
export declare function retryCasWithBackoff(directory: string, eventInput: LedgerEventInput, options: {
    expectedHash: string;
    planHashAfter?: string;
    verifyValid?: () => Promise<boolean> | boolean;
    maxRetries?: number;
}): Promise<LedgerEvent | null>;
/**
 * Load plan.json ONLY without auto-migration from plan.md.
 * Returns null if plan.json doesn't exist or is invalid.
 * Use this when you want to check for structured plans without triggering migration.
 */
export declare function loadPlanJsonOnly(directory: string): Promise<Plan | null>;
/**
 * Regenerate plan.md from valid plan.json (auto-heal case 1).
 */
export declare function regeneratePlanMarkdown(directory: string, plan: Plan): Promise<void>;
/**
 * Load and validate plan from .swarm/plan.json with auto-heal sync.
 *
 * 4-step precedence with auto-heal:
 * 1. .swarm/plan.json exists AND validates ->
 *    a) If plan.md missing or stale -> regenerate plan.md from plan.json
 *    b) Return parsed Plan
 * 2. .swarm/plan.json exists but FAILS validation ->
 *    a) If plan.md exists -> migrate from plan.md, save valid plan.json, then derive plan.md
 *    b) Return migrated Plan
 * 3. .swarm/plan.md exists only -> migrate from plan.md, save both files, return Plan
 * 4. Neither exists -> return null
 */
export declare function loadPlan(directory: string): Promise<RuntimePlan | null>;
/**
 * Validate against PlanSchema (throw on invalid), write to .swarm/plan.json via atomic temp+rename pattern,
 * then derive and write .swarm/plan.md
 */
export declare function savePlan(directory: string, plan: Plan, options?: {
    preserveCompletedStatuses?: boolean;
}): Promise<void>;
/**
 * Rebuild plan from ledger events.
 * Replays the ledger to reconstruct plan state, then writes the result.
 * Uses direct atomic writes to avoid circular ledger append (savePlan appends ledger events).
 *
 * @param directory - The working directory
 * @returns Reconstructed Plan from ledger, or null if ledger is empty/missing
 */
export declare function rebuildPlan(directory: string, plan?: Plan): Promise<Plan | null>;
/**
 * Load plan → find task by ID → update status → save → return updated plan.
 * Throw if plan not found or task not found.
 *
 * Uses loadPlan() (not loadPlanJsonOnly) so that legitimate same-identity ledger
 * drift is detected and healed before the status update is applied. Without this,
 * a stale plan.json would silently overwrite ledger-ahead task state with only the
 * one targeted status change applied on top.
 *
 * The migration guard in loadPlan() (plan_id identity check) prevents destructive
 * revert after a swarm rename — so this is safe even in post-migration scenarios.
 */
export declare function updateTaskStatus(directory: string, taskId: string, status: TaskStatus): Promise<Plan>;
/**
 * Generate deterministic markdown view from plan object.
 * Ensures stable ordering: phases by ID (ascending), tasks by ID (natural numeric).
 */
export declare function derivePlanMarkdown(plan: Plan): string;
/**
 * Convert existing plan.md to plan.json. PURE function — no I/O.
 */
export declare function migrateLegacyPlan(planContent: string, swarmId?: string): Plan;

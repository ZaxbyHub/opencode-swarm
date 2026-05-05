/**
 * Append-only Plan Ledger
 *
 * Provides durable, immutable audit trail of plan evolution events.
 * Each event is written as a JSON line to .swarm/plan-ledger.jsonl
 */
import { type Plan } from '../config/plan-schema';
/**
 * Ledger schema version
 */
export declare const LEDGER_SCHEMA_VERSION = "1.0.0";
/**
 * Valid ledger event types
 */
export declare const LEDGER_EVENT_TYPES: readonly ["plan_created", "task_added", "task_updated", "task_status_changed", "task_reordered", "phase_completed", "plan_rebuilt", "plan_exported", "plan_reset", "snapshot", "execution_profile_set", "execution_profile_locked"];
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];
/**
 * A ledger event representing a plan mutation.
 * All fields are required unless marked optional.
 */
export interface LedgerEvent {
    /** Monotonically increasing sequence number (starts at 1) */
    seq: number;
    /** ISO 8601 timestamp when event was recorded */
    timestamp: string;
    /** Unique identifier for the plan */
    plan_id: string;
    /** Type of event that occurred */
    event_type: LedgerEventType;
    /** Task ID when event relates to a specific task */
    task_id?: string;
    /** Phase ID when event relates to a specific phase */
    phase_id?: number;
    /** Previous status (for status change events) */
    from_status?: string;
    /** New status (for status change events) */
    to_status?: string;
    /** What triggered this event */
    source: string;
    /** SHA-256 hash of plan state before this event */
    plan_hash_before: string;
    /** SHA-256 hash of plan state after this event */
    plan_hash_after: string;
    /** Schema version for this ledger entry */
    schema_version: string;
    /** Optional payload for events that carry additional data */
    payload?: Record<string, unknown>;
}
/**
 * Input type for appendLedgerEvent (excludes auto-generated fields)
 */
export type LedgerEventInput = Omit<LedgerEvent, 'seq' | 'timestamp' | 'plan_hash_before' | 'plan_hash_after' | 'schema_version'>;
/**
 * Payload for snapshot ledger events.
 * Embeds the full Plan payload for ledger-only rebuild.
 */
export interface SnapshotEventPayload {
    plan: Plan;
    payload_hash: string;
}
/**
 * Error thrown when a writer attempts to append to the ledger with stale state.
 * Indicates another writer has modified the ledger since the caller last read it.
 */
export declare class LedgerStaleWriterError extends Error {
    constructor(message: string);
}
/**
 * Get the path to the ledger file
 */
declare function getLedgerPath(directory: string): string;
/**
 * Get the path to plan.json
 */
declare function getPlanJsonPath(directory: string): string;
/**
 * Compute a SHA-256 hash of the plan state.
 * Uses deterministic JSON serialization for consistent hashing.
 *
 * @param plan - The plan to hash
 * @returns Hex-encoded SHA-256 hash
 */
export declare function computePlanHash(plan: Plan): string;
/**
 * Read the current plan.json and compute its hash.
 *
 * @param directory - The working directory
 * @returns Hash of current plan.json, or empty string if not found
 */
export declare function computeCurrentPlanHash(directory: string): string;
/**
 * Check if the ledger file exists.
 *
 * @param directory - The working directory
 * @returns true if ledger file exists
 */
export declare function ledgerExists(directory: string): Promise<boolean>;
/**
 * Get the latest sequence number in the ledger.
 *
 * @param directory - The working directory
 * @returns Highest seq value, or 0 if ledger is empty/doesn't exist
 */
export declare function getLatestLedgerSeq(directory: string): Promise<number>;
/**
 * Read all events from the ledger.
 *
 * @param directory - The working directory
 * @returns Array of LedgerEvent sorted by seq
 */
export declare function readLedgerEvents(directory: string): Promise<LedgerEvent[]>;
/**
 * Initialize a new ledger with a plan_created event.
 * Only call this if the ledger doesn't exist.
 *
 * @param directory - The working directory
 * @param planId - Unique identifier for the plan
 */
export declare function initLedger(directory: string, planId: string, initialPlanHash?: string, initialPlan?: Plan): Promise<void>;
/**
 * Append a new event to the ledger.
 * Uses atomic write: write to temp file then rename.
 *
 * @param directory - The working directory
 * @param eventInput - Event data to append (without seq, timestamp, hashes)
 * @param options - Optional concurrency control options
 * @returns The full LedgerEvent that was written
 */
export declare function appendLedgerEvent(directory: string, eventInput: LedgerEventInput, options?: {
    expectedSeq?: number;
    expectedHash?: string;
    planHashAfter?: string;
}): Promise<LedgerEvent>;
/**
 * Append a ledger event with optimistic retry on stale-writer conflicts.
 *
 * When another writer advances the ledger between the caller's read and
 * their append, `appendLedgerEvent` throws `LedgerStaleWriterError`. This
 * helper wraps that call in a bounded retry loop, refreshing the
 * `expectedHash` concurrency token against the current plan.json before
 * each retry.
 *
 * IMPORTANT: refreshing the hash is only safe when the event input is
 * *still semantically valid* after the intervening write. For audit
 * events computed from an in-memory plan the caller is about to persist,
 * it is always valid. For `task_status_changed` events, pass a
 * `verifyValid` callback that returns false when the transition no
 * longer applies (e.g. the task's on-disk status already matches the
 * `to_status`, or has moved past it). When `verifyValid` returns false,
 * the retry loop exits and the helper returns `null` to signal that the
 * event was skipped — it is not an error.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param eventInput - Event to append (required fields minus auto-generated)
 * @param options - Concurrency and retry configuration:
 *   - expectedHash: the hash of plan.json the caller observed (REQUIRED)
 *   - planHashAfter: precomputed hash of the mutated plan
 *   - maxRetries: max stale-writer retries (default: 3)
 *   - backoffMs: base delay in milliseconds (default: 10; exponential)
 *   - verifyValid: callback invoked before each retry to confirm the
 *     event input is still meaningful. Returning false aborts and
 *     resolves the helper to `null`.
 * @returns The written LedgerEvent, or `null` if verifyValid aborted.
 * @throws LedgerStaleWriterError if retries are exhausted.
 */
export declare function appendLedgerEventWithRetry(directory: string, eventInput: LedgerEventInput, options: {
    expectedHash: string;
    planHashAfter?: string;
    maxRetries?: number;
    backoffMs?: number;
    verifyValid?: () => Promise<boolean> | boolean;
}): Promise<LedgerEvent | null>;
/**
 * Take a snapshot event and append it to the ledger.
 * The snapshot embeds the full Plan payload for ledger-only rebuild.
 *
 * @param directory - The working directory
 * @param plan - The current plan state to snapshot
 * @param options - Optional configuration:
 *   - planHashAfter: precomputed hash of the mutated plan (bypasses the
 *     on-disk plan.json read when available)
 *   - source: attribution string stored on the ledger event. Defaults to
 *     `'takeSnapshotEvent'`. Use `'critic_approved'` to mark a snapshot as
 *     the immutable phase-approved checkpoint readable by
 *     `loadLastApprovedPlan`.
 *   - approvalMetadata: optional free-form metadata embedded into the
 *     snapshot payload (e.g. phase number, verdict, summary) so that
 *     downstream readers can filter without decoding prompts.
 * @returns The LedgerEvent that was written
 */
export declare function takeSnapshotEvent(directory: string, plan: Plan, options?: {
    planHashAfter?: string;
    source?: string;
    approvalMetadata?: Record<string, unknown>;
}): Promise<LedgerEvent>;
/**
 * Options for replayFromLedger
 */
interface ReplayOptions {
    /** If true, use the latest snapshot to speed up replay */
    useSnapshot?: boolean;
}
/**
 * Replay ledger events to reconstruct plan state.
 * Loads plan.json as the base state and applies ledger events in sequence.
 *
 * NOTE: This function requires plan.json to exist as the base state.
 * The ledger only stores task_status_changed events, not the full plan payload.
 * If plan.json is missing, replay cannot proceed — this is a known limitation.
 * The fix would be to store the initial plan payload in the ledger, but that
 * is a larger architectural change beyond the current scope.
 *
 * @param directory - The working directory
 * @param options - Optional replay options
 * @returns Reconstructed Plan from ledger events, or null if plan.json doesn't exist or ledger is empty
 */
export declare function replayFromLedger(directory: string, _options?: ReplayOptions): Promise<Plan | null>;
/**
 * Apply a single ledger event to the plan state.
 * Returns null if the event indicates a full reset (plan_reset).
 *
 * @param plan - Current plan state
 * @param event - Event to apply
 * @returns Updated plan state, or null if plan should be reset
 */
declare function applyEventToPlan(plan: Plan, event: LedgerEvent): Plan | null;
/**
 * Result type for readLedgerEventsWithIntegrity
 */
export interface LedgerIntegrityResult {
    /** Valid events up to (but not including) the first malformed line */
    events: LedgerEvent[];
    /** True if a bad line was found and replay was stopped early */
    truncated: boolean;
    /** Raw content from the first bad line to end of file, for quarantine */
    badSuffix: string | null;
}
/**
 * Read ledger events with integrity checking.
 * Stops at the first malformed/unparseable line and returns the remainder for quarantine.
 *
 * @param directory - The working directory
 * @returns LedgerIntegrityResult with events, truncated flag, and bad suffix
 */
export declare function readLedgerEventsWithIntegrity(directory: string): Promise<LedgerIntegrityResult>;
/**
 * Quarantine a corrupted ledger suffix to a separate file.
 * Does NOT modify the ledger file itself.
 *
 * @param directory - The working directory
 * @param badSuffix - The corrupted content to quarantine
 */
export declare function quarantineLedgerSuffix(directory: string, badSuffix: string): Promise<void>;
/**
 * Replay ledger events with integrity checking.
 * If corruption is detected, quarantines the bad suffix and falls back to snapshot+prefix replay.
 * Never throws — all errors return null.
 *
 * @param directory - The working directory
 * @returns Reconstructed Plan from ledger events, or null if replay fails
 */
export declare function replayWithIntegrity(directory: string): Promise<Plan | null>;
/**
 * Metadata describing an approved snapshot recovered from the ledger.
 */
export interface ApprovedSnapshotInfo {
    /** The immutable plan payload captured at critic approval time */
    plan: Plan;
    /** The ledger sequence number of the snapshot event */
    seq: number;
    /** ISO 8601 timestamp of the snapshot event */
    timestamp: string;
    /** Arbitrary metadata the caller attached (phase, verdict, summary, ...) */
    approval?: Record<string, unknown>;
    /** Hash of the plan payload at snapshot time */
    payloadHash: string;
}
/**
 * Find the most recent critic-approved immutable plan snapshot in the ledger.
 *
 * Snapshots are tagged at write time with a distinguishing `source` string
 * (see `takeSnapshotEvent`). The `critic_approved` marker identifies snapshots
 * persisted by the orchestrator after a phase Critic returns APPROVED. This
 * function scans the ledger in reverse order and returns the first matching
 * snapshot, including its embedded plan payload and approval metadata.
 *
 * Intended for use as a fallback when plan.json is lost, overwritten, or
 * suspected of drift: the Architect can fall back to the last approved plan
 * and the Critic can drift-check against it.
 *
 * SAFETY: when `expectedPlanId` is supplied, only snapshots whose event
 * `plan_id` matches are considered. Callers MUST pass an expected identity
 * whenever they have one (e.g. from the ledger's first `plan_created` anchor)
 * to prevent cross-identity contamination: a stale `critic_approved` snapshot
 * left in a reused directory could otherwise be resurrected as the active plan.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param expectedPlanId - Optional plan identity filter. When provided, only
 *   snapshots whose ledger event `plan_id` matches are considered.
 * @returns The most recent approved snapshot info, or null if none exists
 */
export declare function loadLastApprovedPlan(directory: string, expectedPlanId?: string): Promise<ApprovedSnapshotInfo | null>;
export declare const _internals: {
    computePlanHash: typeof computePlanHash;
    computeCurrentPlanHash: typeof computeCurrentPlanHash;
    ledgerExists: typeof ledgerExists;
    getLatestLedgerSeq: typeof getLatestLedgerSeq;
    readLedgerEvents: typeof readLedgerEvents;
    initLedger: typeof initLedger;
    appendLedgerEvent: typeof appendLedgerEvent;
    appendLedgerEventWithRetry: typeof appendLedgerEventWithRetry;
    takeSnapshotEvent: typeof takeSnapshotEvent;
    replayFromLedger: typeof replayFromLedger;
    applyEventToPlan: typeof applyEventToPlan;
    readLedgerEventsWithIntegrity: typeof readLedgerEventsWithIntegrity;
    quarantineLedgerSuffix: typeof quarantineLedgerSuffix;
    replayWithIntegrity: typeof replayWithIntegrity;
    loadLastApprovedPlan: typeof loadLastApprovedPlan;
    getLedgerPath: typeof getLedgerPath;
    getPlanJsonPath: typeof getPlanJsonPath;
};
export {};

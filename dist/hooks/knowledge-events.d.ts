/**
 * Event-sourced knowledge lifecycle for opencode-swarm.
 *
 * `.swarm/knowledge-events.jsonl` is an append-only, immutable log of every
 * meaningful knowledge interaction (retrieval, receipt, outcome, archival).
 * It is the authoritative history: per-entry counters
 * (`retrieval_outcomes.*`) become *derived rollups* recomputed deterministically
 * from this log via {@link recomputeCounters}.
 *
 * Design contracts:
 * - Append-only. We never rewrite or delete lines. OS-level atomic append is
 *   used (same pattern as `appendKnowledge` in knowledge-store.ts) — no lock is
 *   needed for append-only writes.
 * - Fail-open. Event recording is telemetry; it must never break tool or hook
 *   execution. Use {@link recordKnowledgeEvent} (swallows + warns) on hot paths;
 *   {@link appendKnowledgeEvent} throws and is intended for tests / callers that
 *   want explicit error handling.
 * - `.swarm/` containment (AGENTS.md invariant 4): the path is derived from the
 *   `directory` argument injected by `createSwarmTool` / hook constructors — never
 *   from the process working directory.
 */
import type { KnowledgeApplicationRecord, RetrievalOutcome } from './knowledge-types.js';
/** Current event-log record schema version. Bump when the on-disk shape changes. */
export declare const KNOWLEDGE_EVENT_SCHEMA_VERSION = 1;
/**
 * Soft cap on `.swarm/knowledge-events.jsonl` line count. Enforced FIFO after
 * each append: oldest lines are trimmed when total exceeds the cap. Sized for
 * months of activity on a typical project (~5k retrieval/receipt events).
 */
export declare const MAX_EVENT_LOG_ENTRIES = 5000;
/** Retrieval modes that surface knowledge to an agent. */
export type RetrievalEventMode = 'manual' | 'auto_injection' | 'coder_context' | 'review_context' | 'curator';
/** A retrieval: a query returned a ranked set of knowledge entries. */
export interface RetrievedEvent {
    type: 'retrieved';
    schema_version?: number;
    event_id: string;
    trace_id: string;
    timestamp: string;
    session_id: string;
    phase?: string;
    task_id?: string;
    agent: string;
    query: string;
    retrieval_mode: RetrievalEventMode;
    result_ids: string[];
    /** id → 1-based rank in the result list. */
    ranks: Record<string, number>;
    /** id → final score. */
    scores: Record<string, number>;
    score_breakdown?: Record<string, unknown>;
}
/** A receipt: an agent explicitly considered a specific knowledge entry. */
export interface ReceiptEvent {
    type: 'acknowledged' | 'applied' | 'ignored' | 'contradicted' | 'violated';
    schema_version?: number;
    event_id: string;
    trace_id: string;
    knowledge_id: string;
    timestamp: string;
    session_id: string;
    phase?: string;
    task_id?: string;
    agent: string;
    reason?: string;
    evidence?: {
        files?: string[];
        commands?: string[];
        tests?: string[];
        summary?: string;
    };
}
/** An outcome: a task/phase succeeded or failed, optionally attributed to an entry. */
export interface OutcomeEvent {
    type: 'outcome';
    schema_version?: number;
    event_id: string;
    trace_id?: string;
    knowledge_id?: string;
    timestamp: string;
    task_id?: string;
    phase?: string;
    outcome: 'success' | 'failure' | 'partial';
    evidence_summary: string;
}
/** An audit tombstone: an entry was archived / quarantined / purged. */
export interface ArchivedEvent {
    type: 'archived';
    schema_version?: number;
    event_id: string;
    timestamp: string;
    entry_id: string;
    actor: string;
    reason: string;
    mode: 'archive' | 'quarantine' | 'purge';
    evidence?: string;
    previous_status?: string;
}
export type KnowledgeEvent = RetrievedEvent | ReceiptEvent | OutcomeEvent | ArchivedEvent;
export type KnowledgeEventType = KnowledgeEvent['type'];
/**
 * Event shape accepted by {@link appendKnowledgeEvent} / {@link recordKnowledgeEvent}.
 * `event_id` and `timestamp` are optional on input — they are filled in on write.
 * Distributes over the union so each variant keeps its required discriminant
 * fields.
 */
export type KnowledgeEventInput = KnowledgeEvent extends infer T ? T extends KnowledgeEvent ? Omit<T, 'event_id' | 'timestamp'> & {
    event_id?: string;
    timestamp?: string;
} : never : never;
/** Receipt event verbs that reference a single knowledge_id. */
export declare const RECEIPT_EVENT_TYPES: ReadonlySet<string>;
/** Returns `.swarm/knowledge-events.jsonl` for the given project directory. */
export declare function resolveKnowledgeEventsPath(directory: string): string;
/** Returns `.swarm/knowledge-application.jsonl` for legacy v2 audit records. */
export declare function resolveLegacyApplicationLogPath(directory: string): string;
/** Generate a fresh trace id. One per retrieval; receipts reference it. */
export declare function newTraceId(): string;
/** Generate a fresh event id. Unique per appended event. */
export declare function newEventId(): string;
/**
 * Append one event to the log, filling in event_id / timestamp if absent.
 * Returns the fully-populated event that was written.
 *
 * Throws on I/O failure — callers on hot paths should prefer
 * {@link recordKnowledgeEvent}, which swallows errors.
 */
export declare function appendKnowledgeEvent(directory: string, event: KnowledgeEventInput): Promise<KnowledgeEvent>;
/**
 * Fail-open variant of {@link appendKnowledgeEvent} for hot paths (hooks, tool
 * execution). Never throws; logs a warning and returns null on failure.
 */
export declare function recordKnowledgeEvent(directory: string, event: KnowledgeEventInput): Promise<KnowledgeEvent | null>;
/**
 * Read all events from the log. Skips corrupted JSONL lines (logging a warning
 * for each) and returns an empty array when the file does not exist — mirrors
 * `readKnowledge` in knowledge-store.ts.
 */
export declare function readKnowledgeEvents(directory: string): Promise<KnowledgeEvent[]>;
/**
 * Read legacy knowledge-application audit records. Corrupt lines are skipped so
 * stale telemetry cannot break search, promotion, or manual recall.
 */
export declare function readLegacyApplicationRecords(directory: string): Promise<KnowledgeApplicationRecord[]>;
/**
 * Derived per-entry counters. This is the rollup shape recomputed from the
 * event log; it maps onto the v2 `RetrievalOutcome` counter fields plus the v3
 * `contradicted_count`.
 */
export interface CounterRollup {
    shown_count: number;
    acknowledged_count: number;
    applied_explicit_count: number;
    ignored_count: number;
    violated_count: number;
    contradicted_count: number;
    succeeded_after_shown_count: number;
    failed_after_shown_count: number;
    /**
     * Count of partial outcomes. Tracked separately so it surfaces in
     * diagnostics but never contributes to `computeOutcomeSignal` (partial is
     * deliberately ambiguous — it neither rewards nor penalizes).
     */
    partial_after_shown_count: number;
    last_applied_at?: string;
    last_acknowledged_at?: string;
}
/**
 * Recompute per-entry counters deterministically from the immutable event log,
 * optionally folding in legacy `knowledge-application.jsonl` records.
 *
 * Determinism & double-counting: the ONLY outcome our code writes to both logs
 * is "shown" — the injector emits both a legacy `recordKnowledgeShown` record
 * AND a `retrieved` event for the same injection. Every other legacy verb
 * (`applied`/`ignored`/`violated`/`acknowledged`) originates from `knowledge_ack`
 * and has no event-log counterpart; the event-sourced equivalents come from the
 * separate `knowledge_receipt` tool. So the race-free rule is:
 *
 *   - legacy `shown`: folded ONLY when the event log contains no `retrieved`
 *     event (i.e. a pure pre-migration install). Once any `retrieved` event
 *     exists, `shown_count` is derived from events alone, eliminating the
 *     timestamp-race double-count.
 *   - legacy non-`shown` verbs: always folded (no event counterpart, so no
 *     double count), preserving pre-migration history.
 *
 * The result depends only on the input arrays, not on wall-clock time or order.
 *
 * @param events Events from {@link readKnowledgeEvents}.
 * @param legacyRecords Optional legacy application records (any order).
 */
export declare function recomputeCounters(events: KnowledgeEvent[], legacyRecords?: KnowledgeApplicationRecord[]): Map<string, CounterRollup>;
/**
 * Fail-open rollup reader for hot paths. Search and promotion use this instead
 * of stale persisted counters so `knowledge_receipt` feedback affects ranking
 * and safety gates immediately.
 */
export declare function readKnowledgeCounterRollups(directory: string): Promise<Map<string, CounterRollup>>;
/** Merge event-derived rollups over stored outcome counters for scoring only. */
export declare function effectiveRetrievalOutcomes(stored: RetrievalOutcome | undefined, rollup: CounterRollup | undefined): RetrievalOutcome;
export declare const _internals: {
    resolveKnowledgeEventsPath: typeof resolveKnowledgeEventsPath;
    appendKnowledgeEvent: typeof appendKnowledgeEvent;
    recordKnowledgeEvent: typeof recordKnowledgeEvent;
    readKnowledgeEvents: typeof readKnowledgeEvents;
    readLegacyApplicationRecords: typeof readLegacyApplicationRecords;
    readKnowledgeCounterRollups: typeof readKnowledgeCounterRollups;
    effectiveRetrievalOutcomes: typeof effectiveRetrievalOutcomes;
    recomputeCounters: typeof recomputeCounters;
    newTraceId: typeof newTraceId;
    newEventId: typeof newEventId;
};

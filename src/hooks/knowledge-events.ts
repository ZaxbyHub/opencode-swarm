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

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { warn } from '../utils/logger.js';
import { enforceKnowledgeCap } from './knowledge-store.js';
import type { KnowledgeApplicationRecord } from './knowledge-types.js';

/** Current event-log record schema version. Bump when the on-disk shape changes. */
export const KNOWLEDGE_EVENT_SCHEMA_VERSION = 1;

/**
 * Soft cap on `.swarm/knowledge-events.jsonl` line count. Enforced FIFO after
 * each append: oldest lines are trimmed when total exceeds the cap. Sized for
 * months of activity on a typical project (~5k retrieval/receipt events).
 */
export const MAX_EVENT_LOG_ENTRIES = 5000;

// ============================================================================
// Event schema
// ============================================================================

/** Retrieval modes that surface knowledge to an agent. */
export type RetrievalEventMode =
	| 'manual'
	| 'auto_injection'
	| 'coder_context'
	| 'review_context'
	| 'curator';

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

export type KnowledgeEvent =
	| RetrievedEvent
	| ReceiptEvent
	| OutcomeEvent
	| ArchivedEvent;

export type KnowledgeEventType = KnowledgeEvent['type'];

/**
 * Event shape accepted by {@link appendKnowledgeEvent} / {@link recordKnowledgeEvent}.
 * `event_id` and `timestamp` are optional on input — they are filled in on write.
 * Distributes over the union so each variant keeps its required discriminant
 * fields.
 */
export type KnowledgeEventInput = KnowledgeEvent extends infer T
	? T extends KnowledgeEvent
		? Omit<T, 'event_id' | 'timestamp'> & {
				event_id?: string;
				timestamp?: string;
			}
		: never
	: never;

/** Receipt event verbs that reference a single knowledge_id. */
export const RECEIPT_EVENT_TYPES: ReadonlySet<string> = new Set([
	'acknowledged',
	'applied',
	'ignored',
	'contradicted',
	'violated',
]);

// ============================================================================
// Paths
// ============================================================================

/** Returns `.swarm/knowledge-events.jsonl` for the given project directory. */
export function resolveKnowledgeEventsPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-events.jsonl');
}

// ============================================================================
// ID / timestamp helpers
// ============================================================================

/** Generate a fresh trace id. One per retrieval; receipts reference it. */
export function newTraceId(): string {
	return randomUUID();
}

/** Generate a fresh event id. Unique per appended event. */
export function newEventId(): string {
	return randomUUID();
}

/** Fill in event_id / timestamp / schema_version defaults without mutating the caller's object. */
function withDefaults(event: KnowledgeEventInput): KnowledgeEvent {
	return {
		schema_version: KNOWLEDGE_EVENT_SCHEMA_VERSION,
		...event,
		event_id: event.event_id || newEventId(),
		timestamp: event.timestamp || new Date().toISOString(),
	} as KnowledgeEvent;
}

// ============================================================================
// Append (write)
// ============================================================================

/**
 * Append one event to the log, filling in event_id / timestamp if absent.
 * Returns the fully-populated event that was written.
 *
 * Throws on I/O failure — callers on hot paths should prefer
 * {@link recordKnowledgeEvent}, which swallows errors.
 */
export async function appendKnowledgeEvent(
	directory: string,
	event: KnowledgeEventInput,
): Promise<KnowledgeEvent> {
	const populated = withDefaults(event);
	const filePath = resolveKnowledgeEventsPath(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(populated)}\n`, 'utf-8');
	// Best-effort FIFO trim once the log exceeds MAX_EVENT_LOG_ENTRIES.
	// Fail-open: the append itself already succeeded; a failed trim is logged
	// only by enforceKnowledgeCap's internal warnings and must not surface.
	try {
		await enforceKnowledgeCap(filePath, MAX_EVENT_LOG_ENTRIES);
	} catch (err) {
		warn(
			`[knowledge-events] enforceKnowledgeCap failed (non-fatal): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	return populated;
}

/**
 * Fail-open variant of {@link appendKnowledgeEvent} for hot paths (hooks, tool
 * execution). Never throws; logs a warning and returns null on failure.
 */
export async function recordKnowledgeEvent(
	directory: string,
	event: KnowledgeEventInput,
): Promise<KnowledgeEvent | null> {
	try {
		return await appendKnowledgeEvent(directory, event);
	} catch (err) {
		warn(
			`[knowledge-events] recordKnowledgeEvent failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return null;
	}
}

// ============================================================================
// Read
// ============================================================================

/**
 * Read all events from the log. Skips corrupted JSONL lines (logging a warning
 * for each) and returns an empty array when the file does not exist — mirrors
 * `readKnowledge` in knowledge-store.ts.
 */
export async function readKnowledgeEvents(
	directory: string,
): Promise<KnowledgeEvent[]> {
	const filePath = resolveKnowledgeEventsPath(directory);
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	const out: KnowledgeEvent[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as KnowledgeEvent);
		} catch {
			warn(
				`[knowledge-events] Skipping corrupted JSONL line in ${filePath}: ${trimmed.slice(
					0,
					80,
				)}`,
			);
		}
	}
	return out;
}

// ============================================================================
// Deterministic counter rollup
// ============================================================================

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

function emptyRollup(): CounterRollup {
	return {
		shown_count: 0,
		acknowledged_count: 0,
		applied_explicit_count: 0,
		ignored_count: 0,
		violated_count: 0,
		contradicted_count: 0,
		succeeded_after_shown_count: 0,
		failed_after_shown_count: 0,
		partial_after_shown_count: 0,
	};
}

function get(map: Map<string, CounterRollup>, id: string): CounterRollup {
	let r = map.get(id);
	if (!r) {
		r = emptyRollup();
		map.set(id, r);
	}
	return r;
}

/** Track the maximum (latest) ISO timestamp seen for a field. */
function maxIso(current: string | undefined, candidate: string): string {
	if (!current) return candidate;
	return candidate > current ? candidate : current;
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
export function recomputeCounters(
	events: KnowledgeEvent[],
	legacyRecords: KnowledgeApplicationRecord[] = [],
): Map<string, CounterRollup> {
	const map = new Map<string, CounterRollup>();

	const hasRetrievedEvent = events.some((e) => e.type === 'retrieved');

	for (const e of events) {
		switch (e.type) {
			case 'retrieved': {
				for (const id of e.result_ids) {
					get(map, id).shown_count += 1;
				}
				break;
			}
			case 'acknowledged': {
				const r = get(map, e.knowledge_id);
				r.acknowledged_count += 1;
				r.last_acknowledged_at = maxIso(r.last_acknowledged_at, e.timestamp);
				break;
			}
			case 'applied': {
				const r = get(map, e.knowledge_id);
				r.applied_explicit_count += 1;
				r.last_applied_at = maxIso(r.last_applied_at, e.timestamp);
				break;
			}
			case 'ignored':
				get(map, e.knowledge_id).ignored_count += 1;
				break;
			case 'violated':
				get(map, e.knowledge_id).violated_count += 1;
				break;
			case 'contradicted':
				get(map, e.knowledge_id).contradicted_count += 1;
				break;
			case 'outcome': {
				if (!e.knowledge_id) break;
				const r = get(map, e.knowledge_id);
				if (e.outcome === 'success') r.succeeded_after_shown_count += 1;
				else if (e.outcome === 'failure') r.failed_after_shown_count += 1;
				else if (e.outcome === 'partial') r.partial_after_shown_count += 1;
				break;
			}
			// 'archived' events do not contribute to retrieval counters.
		}
	}

	// Fold legacy records. `shown` is folded only when the event log has no
	// `retrieved` event (otherwise events are authoritative for shown_count);
	// every other verb is folded unconditionally (no event-log counterpart).
	for (const rec of legacyRecords) {
		const r = get(map, rec.knowledgeId);
		switch (rec.result) {
			case 'shown':
				if (!hasRetrievedEvent) r.shown_count += 1;
				break;
			case 'acknowledged':
				r.acknowledged_count += 1;
				r.last_acknowledged_at = maxIso(r.last_acknowledged_at, rec.timestamp);
				break;
			case 'applied':
				r.applied_explicit_count += 1;
				r.last_applied_at = maxIso(r.last_applied_at, rec.timestamp);
				break;
			case 'ignored':
				r.ignored_count += 1;
				break;
			case 'violated':
				r.violated_count += 1;
				break;
		}
	}

	return map;
}

// ============================================================================
// DI seam
// ============================================================================

export const _internals: {
	resolveKnowledgeEventsPath: typeof resolveKnowledgeEventsPath;
	appendKnowledgeEvent: typeof appendKnowledgeEvent;
	recordKnowledgeEvent: typeof recordKnowledgeEvent;
	readKnowledgeEvents: typeof readKnowledgeEvents;
	recomputeCounters: typeof recomputeCounters;
	newTraceId: typeof newTraceId;
	newEventId: typeof newEventId;
} = {
	resolveKnowledgeEventsPath,
	appendKnowledgeEvent,
	recordKnowledgeEvent,
	readKnowledgeEvents,
	recomputeCounters,
	newTraceId,
	newEventId,
};

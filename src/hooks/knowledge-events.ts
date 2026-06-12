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
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { warn } from '../utils/logger.js';
import type {
	KnowledgeApplicationRecord,
	RetrievalOutcome,
} from './knowledge-types.js';

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
	| 'curator'
	/** Per-delegate directive injection (Change 1): a delegated subagent
	 *  (coder/reviewer/test_engineer/sme/docs/designer/critic/curator) was shown
	 *  the subset of directives scoped to its role + expected tools. */
	| 'delegate_inject';

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
	type:
		| 'acknowledged'
		| 'applied'
		| 'ignored'
		| 'contradicted'
		| 'violated'
		/** Delegate decided a shown directive did not apply to its task (Change 1).
		 *  Recorded for auditability; never penalizes the entry's outcome signal. */
		| 'n_a'
		/** Architect explicitly accepted an unresolved critical violation at
		 *  phase_complete (Change 2, Task 2.4). Audit-only; never affects rollups. */
		| 'override';
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
	/**
	 * Origin discriminator (Change 2). Distinguishes reviewer-issued verdicts
	 * (`'reviewer'`) from delegate self-acks (`'delegate'`) without changing the
	 * `type`, so existing counter rollups (which switch on `type`) stay intact.
	 * A reviewer VERIFIED maps to type:'applied' with source:'reviewer'.
	 */
	source?: 'delegate' | 'reviewer' | string;
	/** Result of executing a directive's verification_predicate (Change 2). */
	predicate_check?: {
		predicate: string;
		result: 'pass' | 'fail' | 'error';
		detail: string;
	};
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

/** An escalation: a directive was auto-promoted by the repeat-mistake escalator. */
export interface EscalationEvent {
	type: 'escalation';
	schema_version?: number;
	event_id: string;
	timestamp: string;
	entry_id: string;
	from: string;
	to: string;
	reason: string;
	enforcement_mode?: string;
}

export type KnowledgeEvent =
	| RetrievedEvent
	| ReceiptEvent
	| OutcomeEvent
	| ArchivedEvent
	| EscalationEvent;

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
	'n_a',
	'override',
]);

// ============================================================================
// Paths
// ============================================================================

/** Returns `.swarm/knowledge-events.jsonl` for the given project directory. */
export function resolveKnowledgeEventsPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-events.jsonl');
}

/** Returns `.swarm/knowledge-application.jsonl` for legacy v2 audit records. */
export function resolveLegacyApplicationLogPath(directory: string): string {
	return path.join(directory, '.swarm', 'knowledge-application.jsonl');
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
	const dirPath = path.dirname(filePath);
	await mkdir(dirPath, { recursive: true });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(dirPath, {
			retries: { retries: 200, minTimeout: 10, maxTimeout: 100 },
		});
		await appendFile(filePath, `${JSON.stringify(populated)}\n`, 'utf-8');
		// Best-effort FIFO trim once the log exceeds MAX_EVENT_LOG_ENTRIES.
		// Done under the same lock as append so we avoid lock nesting and keep
		// append+trim race-free for concurrent writers.
		try {
			const content = await readFile(filePath, 'utf-8');
			const lines = content
				.split('\n')
				.filter((line) => line.trim().length > 0);
			if (lines.length > MAX_EVENT_LOG_ENTRIES) {
				const trimmed = lines.slice(lines.length - MAX_EVENT_LOG_ENTRIES);
				await writeFile(filePath, `${trimmed.join('\n')}\n`, 'utf-8');
			}
		} catch (err) {
			warn(
				`[knowledge-events] local cap trim failed (non-fatal): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	} finally {
		if (release) await release().catch(() => {});
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

/**
 * Read legacy knowledge-application audit records. Corrupt lines are skipped so
 * stale telemetry cannot break search, promotion, or manual recall.
 */
export async function readLegacyApplicationRecords(
	directory: string,
): Promise<KnowledgeApplicationRecord[]> {
	const filePath = resolveLegacyApplicationLogPath(directory);
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	const out: KnowledgeApplicationRecord[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as KnowledgeApplicationRecord);
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
	/** Count of explicit not-applicable decisions (Change 1). Auditable, neutral:
	 *  never contributes to the outcome ranking signal. */
	n_a_count: number;
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
	/**
	 * The most recent violation timestamps for this entry (ISO 8601, newest
	 * first, capped at the last {@link MAX_VIOLATION_TIMESTAMPS}). Feeds the
	 * repeat-mistake escalator (Change 3).
	 */
	violation_timestamps: string[];
}

/** Cap on retained per-entry violation timestamps. */
export const MAX_VIOLATION_TIMESTAMPS = 10;

function emptyRollup(): CounterRollup {
	return {
		shown_count: 0,
		acknowledged_count: 0,
		applied_explicit_count: 0,
		ignored_count: 0,
		violated_count: 0,
		contradicted_count: 0,
		n_a_count: 0,
		succeeded_after_shown_count: 0,
		failed_after_shown_count: 0,
		partial_after_shown_count: 0,
		violation_timestamps: [],
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
	const retrievedIds = new Set<string>();

	for (const e of events) {
		switch (e.type) {
			case 'retrieved': {
				for (const id of e.result_ids) {
					retrievedIds.add(id);
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
			case 'violated': {
				const r = get(map, e.knowledge_id);
				r.violated_count += 1;
				r.violation_timestamps.push(e.timestamp);
				break;
			}
			case 'contradicted':
				get(map, e.knowledge_id).contradicted_count += 1;
				break;
			case 'n_a':
				// Recorded for auditability; intentionally neutral (no penalty).
				get(map, e.knowledge_id).n_a_count += 1;
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

	// Fold legacy records. `shown` is folded per entry only when that entry has
	// no `retrieved` event (otherwise events are authoritative for shown_count);
	// every other verb is folded unconditionally (no event-log counterpart).
	for (const rec of legacyRecords) {
		const r = get(map, rec.knowledgeId);
		switch (rec.result) {
			case 'shown':
				if (!retrievedIds.has(rec.knowledgeId)) r.shown_count += 1;
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
				r.violation_timestamps.push(rec.timestamp);
				break;
		}
	}

	// Normalize violation timestamps: newest first, capped at the retention limit.
	for (const r of map.values()) {
		if (r.violation_timestamps.length > 1) {
			r.violation_timestamps.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
		}
		if (r.violation_timestamps.length > MAX_VIOLATION_TIMESTAMPS) {
			r.violation_timestamps = r.violation_timestamps.slice(
				0,
				MAX_VIOLATION_TIMESTAMPS,
			);
		}
	}

	return map;
}

/**
 * Count how many of the given violation timestamps fall within `windowDays` of
 * `now` (inclusive). Pure helper — deterministic given its inputs. Malformed
 * timestamps are ignored.
 */
export function countViolationsInWindow(
	timestamps: string[],
	windowDays: number,
	now: Date = new Date(),
): number {
	const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
	let count = 0;
	for (const ts of timestamps) {
		const t = Date.parse(ts);
		if (!Number.isNaN(t) && t >= cutoff) count += 1;
	}
	return count;
}

/**
 * Async convenience: count an entry's violations within a day-window. Counts
 * directly from the event log + legacy application records so the result is
 * INDEPENDENT of the {@link MAX_VIOLATION_TIMESTAMPS} display cap (the rollup's
 * `violation_timestamps` keeps only the newest 10 and would undercount an entry
 * with more in-window violations). Fail-open: returns 0 on error.
 */
export async function countEntryViolationsInWindow(
	directory: string,
	entryId: string,
	windowDays: number,
	now: Date = new Date(),
): Promise<number> {
	try {
		const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
		const [events, legacyRecords] = await Promise.all([
			readKnowledgeEvents(directory),
			readLegacyApplicationRecords(directory),
		]);
		let count = 0;
		for (const e of events) {
			if (e.type !== 'violated' || e.knowledge_id !== entryId) continue;
			const t = Date.parse(e.timestamp);
			if (!Number.isNaN(t) && t >= cutoff) count += 1;
		}
		// Legacy `violated` records originate from the old knowledge_ack tool and
		// have no event-log counterpart, so they are folded unconditionally (same
		// rule recomputeCounters uses) — no double counting.
		for (const rec of legacyRecords) {
			if (rec.result !== 'violated' || rec.knowledgeId !== entryId) continue;
			const t = Date.parse(rec.timestamp);
			if (!Number.isNaN(t) && t >= cutoff) count += 1;
		}
		return count;
	} catch {
		return 0;
	}
}

/**
 * Fail-open rollup reader for hot paths. Search and promotion use this instead
 * of stale persisted counters so `knowledge_receipt` feedback affects ranking
 * and safety gates immediately.
 */
export async function readKnowledgeCounterRollups(
	directory: string,
): Promise<Map<string, CounterRollup>> {
	try {
		const [events, legacyRecords] = await Promise.all([
			readKnowledgeEvents(directory),
			readLegacyApplicationRecords(directory),
		]);
		return recomputeCounters(events, legacyRecords);
	} catch (err) {
		warn(
			`[knowledge-events] readKnowledgeCounterRollups failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return new Map();
	}
}

/** Merge event-derived rollups over stored outcome counters for scoring only. */
export function effectiveRetrievalOutcomes(
	stored: RetrievalOutcome | undefined,
	rollup: CounterRollup | undefined,
): RetrievalOutcome {
	const base = stored ?? {
		applied_count: 0,
		succeeded_after_count: 0,
		failed_after_count: 0,
	};
	if (!rollup) return base;
	return {
		...base,
		...rollup,
	};
}

// ============================================================================
// Feedback bridge — Knowledge verdict → confidence bumps
// ============================================================================

const VERDICT_CONFIDENCE_BOOST = 0.03;
const VERDICT_CONFIDENCE_DECAY = 0.05;

/**
 * Read receipt events (applied/violated/ignored), aggregate per knowledge entry,
 * and apply bounded confidence deltas via `bumpKnowledgeConfidenceBatch`.
 *
 * Complements `applySkillUsageFeedback` (skill-usage-log.ts) which bridges
 * skill compliance → confidence. This function bridges raw knowledge verdict
 * events → confidence, closing the loop where `entry.confidence` was static
 * after creation regardless of how often the entry was applied or violated.
 *
 * Fail-open: errors are logged but never thrown.
 */
export async function applyKnowledgeVerdictFeedback(
	directory: string,
	options?: { sinceTimestamp?: string },
): Promise<{ processed: number; bumps: number }> {
	try {
		const events = await readKnowledgeEvents(directory);

		const actionable = events.filter((e): e is ReceiptEvent => {
			if (
				e.type !== 'applied' &&
				e.type !== 'violated' &&
				e.type !== 'ignored'
			) {
				return false;
			}
			if (
				options?.sinceTimestamp &&
				(e as ReceiptEvent).timestamp <= options.sinceTimestamp
			) {
				return false;
			}
			return true;
		});

		if (actionable.length === 0) {
			return { processed: 0, bumps: 0 };
		}

		const groups = new Map<
			string,
			{ applied: number; violated: number; ignored: number }
		>();
		for (const event of actionable) {
			const kid = event.knowledge_id;
			if (!kid) continue;
			const g = groups.get(kid) ?? { applied: 0, violated: 0, ignored: 0 };
			if (event.type === 'applied') g.applied++;
			else if (event.type === 'violated') g.violated++;
			else if (event.type === 'ignored') g.ignored++;
			groups.set(kid, g);
		}

		const deltas: Array<{ id: string; delta: number }> = [];
		for (const [id, counts] of groups) {
			const positives = counts.applied;
			const negatives = counts.violated + counts.ignored;
			if (positives === 0 && negatives === 0) continue;
			const delta =
				positives > negatives
					? VERDICT_CONFIDENCE_BOOST
					: -VERDICT_CONFIDENCE_DECAY;
			deltas.push({ id, delta });
		}

		if (deltas.length > 0) {
			const { bumpKnowledgeConfidenceBatch } = await import(
				'./knowledge-store.js'
			);
			await bumpKnowledgeConfidenceBatch(directory, deltas);
		}

		return { processed: groups.size, bumps: deltas.length };
	} catch (err) {
		warn(
			`[knowledge-events] applyKnowledgeVerdictFeedback failed (fail-open): ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return { processed: 0, bumps: 0 };
	}
}

// ============================================================================
// DI seam
// ============================================================================

export const _internals: {
	resolveKnowledgeEventsPath: typeof resolveKnowledgeEventsPath;
	appendKnowledgeEvent: typeof appendKnowledgeEvent;
	recordKnowledgeEvent: typeof recordKnowledgeEvent;
	readKnowledgeEvents: typeof readKnowledgeEvents;
	readLegacyApplicationRecords: typeof readLegacyApplicationRecords;
	readKnowledgeCounterRollups: typeof readKnowledgeCounterRollups;
	effectiveRetrievalOutcomes: typeof effectiveRetrievalOutcomes;
	recomputeCounters: typeof recomputeCounters;
	applyKnowledgeVerdictFeedback: typeof applyKnowledgeVerdictFeedback;
	newTraceId: typeof newTraceId;
	newEventId: typeof newEventId;
} = {
	resolveKnowledgeEventsPath,
	appendKnowledgeEvent,
	recordKnowledgeEvent,
	readKnowledgeEvents,
	readLegacyApplicationRecords,
	readKnowledgeCounterRollups,
	effectiveRetrievalOutcomes,
	recomputeCounters,
	applyKnowledgeVerdictFeedback,
	newTraceId,
	newEventId,
};

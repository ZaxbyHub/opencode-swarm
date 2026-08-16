/**
 * Bounded diagnostic knowledge lifecycle stream for opencode-swarm.
 *
 * `.swarm/knowledge-events.jsonl` records meaningful knowledge interactions
 * (retrieval, receipt, outcome, archival). Recent lines stay in the event log;
 * old lines are folded into `.swarm/knowledge-counter-baseline.json` when the
 * log exceeds the cap. The event log plus baseline remain the source for
 * best-effort aggregate metrics (`retrieval_outcomes.*`), but are not receipt,
 * membership, gate, promotion, escalation, or destructive-action authority.
 * Correctness state lives in the canonical project-local V2 receipt ledger.
 *
 * Design contracts:
 * - Append-first, bounded retention. New events use OS-level atomic append; trim
 *   rewrites only after folding evicted counters into the baseline so aggregate
 *   counters survive log rotation.
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
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../evidence/task-file.js';
import { resolveHiveEventsPath as resolveHiveEventsPathImpl } from '../knowledge/hive-paths.js';
import { warn } from '../utils/logger.js';
import { resolveKnowledgeStoreDir } from './knowledge-link.js';
import {
	queryHistoricalOutcomes,
	type ReceiptMembership,
	type ReceiptTerminal,
} from './knowledge-receipt-ledger.js';
// Type-only import: erased at runtime, so it does NOT create a dependency that
// would break the test-mocking pattern (see comment at L247 below). The runtime
// import of knowledge-store is dynamic, inside applyKnowledgeVerdictFeedback.
import type { ConfidenceFloorOptions } from './knowledge-store.js';
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

interface CounterRollupCacheEntry {
	key: string;
	rollups: Map<string, CounterRollup>;
}

const counterRollupCache = new Map<string, CounterRollupCacheEntry>();
const MAX_COUNTER_ROLLUP_CACHE_DIRS = 32;

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
		| 'override'
		/**
		 * Terminal accounting event for an EMPTY retrieval (issue #1849): an agent
		 * considered a trace that surfaced no relevant knowledge and explicitly filed
		 * `no_relevant_knowledge`. This closes the "every retrieval attempt has one
		 * durable terminal accounting path, including empty result" contract. Audit
		 * only — `recomputeCounters` intentionally does NOT mutate any per-entry
		 * counter (there is no `knowledge_id` to credit; this is a trace-level
		 * tombstone, not application credit).
		 */
		| 'no_relevant'
		/**
		 * A shown non-critical directive reached the end of a delegate Task with no
		 * ack marker and no receipt. Audit-only visibility signal; never penalizes
		 * the entry's outcome/violation counters.
		 *
		 * Motivation: before this event, only CRITICAL silence produced a signal (a
		 * `violated`/`unacknowledged` event). Non-critical silence was invisible, so
		 * a corpus with 1 critical entry out of 103 reported ~4% receipt compliance
		 * with no way to see where the other 96% went. This is the missing
		 * observation, NOT a verdict: the delegate filed nothing, so there is no
		 * terminal to credit or penalize.
		 */
		| 'unacknowledged';
	schema_version?: number;
	event_id: string;
	trace_id: string;
	/**
	 * The considered knowledge entry. Optional for the `no_relevant` terminal
	 * (issue #1849), which is a trace-level tombstone for an empty retrieval and
	 * references no specific entry.
	 */
	knowledge_id?: string;
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
	tier?: 'swarm' | 'hive';
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

/** A batch of skills were invalidated after a knowledge entry was archived/purged. */
export interface SkillStaleBatchEvent {
	type: 'skill-stale-batch';
	schema_version?: number;
	event_id?: string;
	timestamp?: string;
	skillIds: string[];
	archivedIds: string[];
	retiredCount: number;
	staleCount: number;
}

/**
 * A diagnostic tombstone: the architect auto-injection hook skipped injection
 * for a diagnosable reason (issue #1768). Every silent early-return in
 * `createKnowledgeInjectorHook` emits one of these so the dead-path cause is
 * recoverable from `.swarm/knowledge-events.jsonl`. Diagnostic only —
 * `recomputeCounters` intentionally ignores it (no counter mutation).
 */
export interface InjectionSkipEvent {
	type: 'injection_skip';
	schema_version?: number;
	event_id: string;
	timestamp: string;
	/** Machine-readable reason tag (e.g. 'headroom_budget', 'no_agent_name'). */
	reason: string;
	agent?: string;
	session_id?: string;
	phase?: number;
	/** Structured, redactable detail (char counts, model id, etc.). */
	detail?: Record<string, unknown>;
}

export type KnowledgeEvent =
	| RetrievedEvent
	| ReceiptEvent
	| OutcomeEvent
	| ArchivedEvent
	| EscalationEvent
	| SkillStaleBatchEvent
	| InjectionSkipEvent;

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
	/**
	 * `no_relevant` (issue #1849) is a trace-level terminal, not a per-entry
	 * receipt, but it is part of the receipt/terminal family. Callers that want
	 * strictly per-entry verbs should subtract this.
	 */
	'no_relevant',
	// NOTE: `'unacknowledged'` is intentionally ABSENT from this set. It is not a
	// terminal the delegate filed — it is the collector's observation that the
	// delegate filed NOTHING — and must never satisfy a terminal / idempotency /
	// conflict check. This set currently has no `src/` consumer, so its only
	// plausible future use is exactly such an allowlist; pre-enrolling
	// `'unacknowledged'` would silently opt it into whatever adopts the set next.
	// Add it only after auditing every consumer at that time.
]);

// ============================================================================
// Paths
// ============================================================================

/** Returns the knowledge-events.jsonl path (link-aware via resolveKnowledgeStoreDir). */
export function resolveKnowledgeEventsPath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-events.jsonl',
	);
}

/** Returns the knowledge-counter-baseline.json path (link-aware). */
export function resolveKnowledgeCounterBaselinePath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-counter-baseline.json',
	);
}

// Hive events-path resolution is centralized in `src/knowledge/hive-paths.ts`
// (issue #1847 §1). Previously this was a local copy of the platform branch
// "to avoid importing from knowledge-store.ts, which tests mock" — the new
// module is mock-free and exposes its own `_internals` seam, so the original
// reason is gone and the drift vector is removed.
export const resolveHiveEventsPath = resolveHiveEventsPathImpl;

/** Returns the knowledge-application.jsonl path for legacy v2 audit records (link-aware). */
export function resolveLegacyApplicationLogPath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-application.jsonl',
	);
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
	const [populated] = await appendKnowledgeEventsBatch(directory, [event]);
	return populated;
}

/**
 * Append several events under ONE lock acquisition and ONE cap-trim pass.
 * Multi-event emitters on awaited paths (e.g. the delegate ack-collector's
 * per-directive `unacknowledged` loop, up to `delegate_max_inject_count`
 * events per delegation) must use this instead of N sequential
 * {@link appendKnowledgeEvent} calls — each of those takes the directory
 * lock and re-reads the whole log for the FIFO trim, which is material on
 * cold filesystems and under parallel delegations.
 *
 * Throws on I/O failure — hot paths should prefer
 * {@link recordKnowledgeEventsBatch}, which swallows errors.
 */
export async function appendKnowledgeEventsBatch(
	directory: string,
	events: KnowledgeEventInput[],
): Promise<KnowledgeEvent[]> {
	if (events.length === 0) return [];
	const populated = events.map(withDefaults);
	const filePath = resolveKnowledgeEventsPath(directory);
	const dirPath = path.dirname(filePath);
	await mkdir(dirPath, { recursive: true });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(dirPath, {
			retries: { retries: 200, minTimeout: 10, maxTimeout: 100 },
		});
		await appendFile(
			filePath,
			`${populated.map((e) => JSON.stringify(e)).join('\n')}\n`,
			'utf-8',
		);
		// Best-effort FIFO trim once the log exceeds MAX_EVENT_LOG_ENTRIES.
		// Done under the same lock as append so we avoid lock nesting and keep
		// append+trim race-free for concurrent writers.
		try {
			const content = await readFile(filePath, 'utf-8');
			const lines = content
				.split('\n')
				.filter((line) => line.trim().length > 0);
			if (lines.length > MAX_EVENT_LOG_ENTRIES) {
				const evicted = lines.slice(0, lines.length - MAX_EVENT_LOG_ENTRIES);
				const trimmed = lines.slice(lines.length - MAX_EVENT_LOG_ENTRIES);
				await foldEvictedEventsIntoBaseline(directory, evicted, filePath);
				await atomicWriteFile(filePath, `${trimmed.join('\n')}\n`);
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

/**
 * Fail-open variant of {@link appendKnowledgeEventsBatch} for hot paths.
 * Never throws; logs a warning and returns null on failure (all-or-nothing:
 * the batch is a single append, so there are no partial writes to report).
 */
export async function recordKnowledgeEventsBatch(
	directory: string,
	events: KnowledgeEventInput[],
): Promise<KnowledgeEvent[] | null> {
	try {
		return await appendKnowledgeEventsBatch(directory, events);
	} catch (err) {
		warn(
			`[knowledge-events] recordKnowledgeEventsBatch failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return null;
	}
}

/**
 * Append one event to the shared, cross-project hive events log. Use for audit
 * tombstones of mutations to the hive store so any project can read why a hive
 * entry was archived/quarantined/purged. Throws on I/O failure; hot paths should
 * prefer {@link recordHiveKnowledgeEvent}.
 */
export async function appendHiveKnowledgeEvent(
	event: KnowledgeEventInput,
): Promise<KnowledgeEvent> {
	const populated = withDefaults(event);
	const filePath = resolveHiveEventsPath();
	const dirPath = path.dirname(filePath);
	await mkdir(dirPath, { recursive: true });
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(dirPath, {
			retries: { retries: 200, minTimeout: 10, maxTimeout: 100 },
			// #1847 F-008: MUST match transactHiveStore's stale (5s). This writer
			// locks the SAME hive data directory; an asymmetric (longer) stale
			// would let a concurrent 5s transaction force-break this append
			// mid-write. The high retry count (200) already covers contention.
			stale: 5_000,
		});
		await appendFile(filePath, `${JSON.stringify(populated)}\n`, 'utf-8');
		// Hive events don't participate in the counter rollup baseline (archival
		// events are audit-only), so trim with a plain FIFO — no baseline folding.
		try {
			const content = await readFile(filePath, 'utf-8');
			const lines = content
				.split('\n')
				.filter((line) => line.trim().length > 0);
			if (lines.length > MAX_EVENT_LOG_ENTRIES) {
				const trimmed = lines.slice(lines.length - MAX_EVENT_LOG_ENTRIES);
				await atomicWriteFile(filePath, `${trimmed.join('\n')}\n`);
			}
		} catch (err) {
			warn(
				`[knowledge-events] hive cap trim failed (non-fatal): ${
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
 * Fail-open variant of {@link appendHiveKnowledgeEvent} for hot paths. Never
 * throws; logs a warning and returns null on failure.
 */
export async function recordHiveKnowledgeEvent(
	event: KnowledgeEventInput,
): Promise<KnowledgeEvent | null> {
	try {
		return await appendHiveKnowledgeEvent(event);
	} catch (err) {
		warn(
			`[knowledge-events] recordHiveKnowledgeEvent failed: ${
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
 *
 * Optional maxEvents cap: when provided as a positive finite number, stops
 * after that many events are parsed, preventing unbounded memory growth.
 */
export async function readKnowledgeEvents(
	directory: string,
	maxEvents?: number,
): Promise<KnowledgeEvent[]> {
	const filePath = resolveKnowledgeEventsPath(directory);
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	const out: KnowledgeEvent[] = [];
	const max = maxEvents !== undefined && maxEvents > 0 ? maxEvents : Infinity;
	for (const line of content.split('\n')) {
		if (out.length >= max) break;
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
 * Read all events from the shared, cross-project hive events log. Skips
 * corrupted JSONL lines and returns an empty array when the file does not exist.
 */
export async function readHiveKnowledgeEvents(): Promise<KnowledgeEvent[]> {
	const filePath = resolveHiveEventsPath();
	if (!existsSync(filePath)) return [];
	const content = await readFile(filePath, 'utf-8');
	return parseEventLines(content.split('\n'), filePath);
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

function cloneRollup(input: CounterRollup): CounterRollup {
	return {
		...emptyRollup(),
		...input,
		violation_timestamps: [...(input.violation_timestamps ?? [])],
	};
}

function cloneRollupMap(
	input: Map<string, CounterRollup>,
): Map<string, CounterRollup> {
	const out = new Map<string, CounterRollup>();
	for (const [id, rollup] of input) {
		out.set(id, cloneRollup(rollup));
	}
	return out;
}

function normalizeRollupTimestamps(rollup: CounterRollup): CounterRollup {
	if (rollup.violation_timestamps.length > 1) {
		rollup.violation_timestamps.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
	}
	if (rollup.violation_timestamps.length > MAX_VIOLATION_TIMESTAMPS) {
		rollup.violation_timestamps = rollup.violation_timestamps.slice(
			0,
			MAX_VIOLATION_TIMESTAMPS,
		);
	}
	return rollup;
}

function mergeRollupInto(target: CounterRollup, source: CounterRollup): void {
	target.shown_count += source.shown_count ?? 0;
	target.acknowledged_count += source.acknowledged_count ?? 0;
	target.applied_explicit_count += source.applied_explicit_count ?? 0;
	target.ignored_count += source.ignored_count ?? 0;
	target.violated_count += source.violated_count ?? 0;
	target.contradicted_count += source.contradicted_count ?? 0;
	target.n_a_count += source.n_a_count ?? 0;
	target.succeeded_after_shown_count += source.succeeded_after_shown_count ?? 0;
	target.failed_after_shown_count += source.failed_after_shown_count ?? 0;
	target.partial_after_shown_count += source.partial_after_shown_count ?? 0;
	if (source.last_applied_at) {
		target.last_applied_at = maxIso(
			target.last_applied_at,
			source.last_applied_at,
		);
	}
	if (source.last_acknowledged_at) {
		target.last_acknowledged_at = maxIso(
			target.last_acknowledged_at,
			source.last_acknowledged_at,
		);
	}
	target.violation_timestamps.push(...(source.violation_timestamps ?? []));
	normalizeRollupTimestamps(target);
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

async function readCounterBaseline(
	directory: string,
): Promise<Map<string, CounterRollup>> {
	const filePath = resolveKnowledgeCounterBaselinePath(directory);
	if (!existsSync(filePath)) return new Map();
	let raw: Record<string, CounterRollup>;
	try {
		raw = JSON.parse(await readFile(filePath, 'utf-8')) as Record<
			string,
			CounterRollup
		>;
	} catch (err) {
		// Fail open SCOPED to the baseline (issue #1477 follow-up): a corrupted
		// baseline must not propagate to readKnowledgeCounterRollups' outer catch,
		// which would discard the LIVE event log too — and post-event-sourcing the
		// live log is where all new outcomes accrue. Dropping only the folded
		// historical baseline lets recomputeCounters still replay live events, so
		// outcome accrual (and skill maturation) survives a corrupt baseline file.
		warn(
			`[knowledge-events] corrupted counter baseline at ${filePath}; ignoring folded baseline and replaying live events only: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return new Map();
	}
	const map = new Map<string, CounterRollup>();
	for (const [id, rollup] of Object.entries(raw)) {
		map.set(id, normalizeRollupTimestamps(cloneRollup(rollup)));
	}
	return map;
}

async function writeCounterBaseline(
	directory: string,
	baseline: Map<string, CounterRollup>,
): Promise<void> {
	const filePath = resolveKnowledgeCounterBaselinePath(directory);
	const out: Record<string, CounterRollup> = {};
	for (const [id, rollup] of [...baseline.entries()].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		out[id] = normalizeRollupTimestamps(cloneRollup(rollup));
	}
	await atomicWriteFile(filePath, `${JSON.stringify(out, null, 2)}\n`);
}

async function statCacheKey(filePath: string): Promise<string> {
	try {
		const fileStat = await stat(filePath);
		return `${fileStat.mtimeMs}:${fileStat.ctimeMs}:${fileStat.size}`;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
		throw err;
	}
}

async function buildCounterRollupCacheKey(directory: string): Promise<string> {
	const [eventsKey, legacyKey, baselineKey] = await Promise.all([
		statCacheKey(resolveKnowledgeEventsPath(directory)),
		statCacheKey(resolveLegacyApplicationLogPath(directory)),
		statCacheKey(resolveKnowledgeCounterBaselinePath(directory)),
	]);
	return `${eventsKey}|${legacyKey}|${baselineKey}`;
}

function setCounterRollupCache(
	directory: string,
	key: string,
	rollups: Map<string, CounterRollup>,
): void {
	if (counterRollupCache.has(directory)) {
		counterRollupCache.delete(directory);
	}
	counterRollupCache.set(directory, {
		key,
		rollups: cloneRollupMap(rollups),
	});
	while (counterRollupCache.size > MAX_COUNTER_ROLLUP_CACHE_DIRS) {
		const oldestKey = counterRollupCache.keys().next().value;
		if (oldestKey === undefined) break;
		counterRollupCache.delete(oldestKey);
	}
}

function parseEventLines(lines: string[], filePath: string): KnowledgeEvent[] {
	const out: KnowledgeEvent[] = [];
	for (const line of lines) {
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

async function foldEvictedEventsIntoBaseline(
	directory: string,
	evictedLines: string[],
	filePath: string,
): Promise<void> {
	const evictedEvents = parseEventLines(evictedLines, filePath);
	if (evictedEvents.length === 0) return;
	const baseline = await readCounterBaseline(directory);
	for (const [id, rollup] of recomputeCounters(evictedEvents)) {
		mergeRollupInto(get(baseline, id), rollup);
	}
	await writeCounterBaseline(directory, baseline);
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
	baseline: Map<string, CounterRollup> = new Map(),
): Map<string, CounterRollup> {
	const map = new Map<string, CounterRollup>();
	const retrievedIds = new Set<string>();
	for (const [id, rollup] of baseline) {
		map.set(id, cloneRollup(rollup));
		if ((rollup.shown_count ?? 0) > 0) retrievedIds.add(id);
	}

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
				if (!e.knowledge_id) break;
				const r = get(map, e.knowledge_id);
				r.acknowledged_count += 1;
				r.last_acknowledged_at = maxIso(r.last_acknowledged_at, e.timestamp);
				break;
			}
			case 'applied': {
				if (!e.knowledge_id) break;
				const r = get(map, e.knowledge_id);
				r.applied_explicit_count += 1;
				r.last_applied_at = maxIso(r.last_applied_at, e.timestamp);
				break;
			}
			case 'ignored':
				if (!e.knowledge_id) break;
				get(map, e.knowledge_id).ignored_count += 1;
				break;
			case 'violated': {
				if (!e.knowledge_id) break;
				const r = get(map, e.knowledge_id);
				r.violated_count += 1;
				r.violation_timestamps.push(e.timestamp);
				break;
			}
			case 'contradicted':
				if (!e.knowledge_id) break;
				get(map, e.knowledge_id).contradicted_count += 1;
				break;
			case 'n_a':
				// Recorded for auditability; intentionally neutral (no penalty).
				if (!e.knowledge_id) break;
				get(map, e.knowledge_id).n_a_count += 1;
				break;
			case 'no_relevant':
				// (issue #1849) Terminal tombstone for an EMPTY retrieval. Trace-level:
				// there is no knowledge_id to credit, so NO per-entry counter mutates.
				// Surfaced separately via `countEmptyTraceTerminals` for diagnostics.
				break;
			case 'unacknowledged':
				// Audit-only visibility signal: a shown non-critical directive reached
				// the end of a delegate Task with no ack marker and no receipt. The
				// delegate filed NO verdict, so there is nothing to credit or penalize
				// — explicitly NEUTRAL, exactly like `no_relevant` above. Deliberately
				// does NOT touch ignored_count / violated_count / n_a_count: silence is
				// not a decision, and counting it would corrupt the application-rate
				// and violation-rate denominators the ranking + escalation paths read.
				// Surfaced instead via the curator post-mortem per-entry tally and the
				// `events_by_type` diagnostics bucket.
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
			case 'contradicted':
				r.contradicted_count += 1;
				break;
			case 'violated':
				r.violated_count += 1;
				r.violation_timestamps.push(rec.timestamp);
				break;
		}
	}

	// Normalize violation timestamps: newest first, capped at the retention limit.
	for (const r of map.values()) {
		normalizeRollupTimestamps(r);
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
 * Count the durable `no_relevant` terminal events (issue #1849) in the given
 * event list — the trace-level tombstones recording that a retrieval surfaced
 * nothing relevant and was explicitly accounted for. Pure helper for
 * diagnostics (`/swarm status`, `knowledge_recall debug`). NOT a per-entry
 * counter; there is no `knowledge_id` to credit.
 */
export function countEmptyTraceTerminals(events: KnowledgeEvent[]): number {
	let n = 0;
	for (const e of events) {
		if (e.type === 'no_relevant') n += 1;
	}
	return n;
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
 * G3 (#1715): count `contradicted` events for an entry within a window, reading
 * from the RAW event log (NOT the rollup cache — `recomputeCounters` is mtime-
 * keyed and can be stale immediately after an append, mirroring the
 * `countEntryViolationsInWindow` discipline above). No legacy-record fold:
 * contradicted has no legacy counterpart (unlike violated). Fail-open: returns 0.
 */
export async function countEntryContradictionsInWindow(
	directory: string,
	entryId: string,
	windowDays: number,
	now: Date = new Date(),
): Promise<number> {
	try {
		const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
		const events = await readKnowledgeEvents(directory);
		let count = 0;
		for (const e of events) {
			if (e.type !== 'contradicted' || e.knowledge_id !== entryId) continue;
			const t = Date.parse(e.timestamp);
			if (!Number.isNaN(t) && t >= cutoff) count += 1;
		}
		return count;
	} catch {
		return 0;
	}
}

/**
 * Fail-open diagnostic rollup reader. This preserves legacy metrics and
 * postmortem views, but correctness-affecting consumers must use
 * {@link readAuthoritativeKnowledgeCounterRollups} instead.
 */
export async function readKnowledgeCounterRollups(
	directory: string,
): Promise<Map<string, CounterRollup>> {
	try {
		const cacheKey = await buildCounterRollupCacheKey(directory);
		const cached = counterRollupCache.get(directory);
		if (cached?.key === cacheKey) {
			counterRollupCache.delete(directory);
			counterRollupCache.set(directory, cached);
			return cloneRollupMap(cached.rollups);
		}
		const [events, legacyRecords, baseline] = await Promise.all([
			readKnowledgeEvents(directory),
			readLegacyApplicationRecords(directory),
			readCounterBaseline(directory),
		]);
		const rollups = recomputeCounters(events, legacyRecords, baseline);
		setCounterRollupCache(directory, cacheKey, rollups);
		return cloneRollupMap(rollups);
	} catch (err) {
		warn(
			`[knowledge-events] readKnowledgeCounterRollups failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return new Map();
	}
}

/**
 * Build correctness-affecting retrieval/outcome counters exclusively from the
 * project-local receipt authority. The bounded knowledge-events FIFO remains a
 * diagnostics/metrics source and must never influence ranking, curation,
 * confidence floors, promotion, or generated-skill eligibility.
 */
export async function readAuthoritativeKnowledgeCounterRollups(
	directory: string,
): Promise<Map<string, CounterRollup>> {
	const history = await queryHistoricalOutcomes(directory);
	if (!history.ok) return new Map();
	const rollups = new Map<string, CounterRollup>();
	for (const membership of history.memberships) {
		const rollup = get(rollups, membership.entry_id);
		rollup.shown_count += 1;
		if (membership.application_marker) {
			rollup.acknowledged_count += 1;
			rollup.last_acknowledged_at = maxIso(
				rollup.last_acknowledged_at,
				membership.application_marker.committed_at,
			);
		}
		const compatible = membership as ReceiptMembership & {
			terminal_history?: ReceiptTerminal[];
			historical_terminals?: ReceiptTerminal[];
		};
		const seen = new Set<string>();
		for (const terminal of [
			...(compatible.terminal_history ?? []),
			...(compatible.historical_terminals ?? []),
			...(membership.terminal ? [membership.terminal] : []),
		]) {
			if (seen.has(terminal.event_id)) continue;
			seen.add(terminal.event_id);
			switch (terminal.outcome) {
				case 'applied':
					rollup.applied_explicit_count += 1;
					rollup.last_applied_at = maxIso(
						rollup.last_applied_at,
						terminal.committed_at,
					);
					break;
				case 'ignored':
					rollup.ignored_count += 1;
					break;
				case 'violated':
					rollup.violated_count += 1;
					rollup.violation_timestamps.push(terminal.committed_at);
					break;
				case 'contradicted':
					rollup.contradicted_count += 1;
					break;
				case 'n_a':
					rollup.n_a_count += 1;
					break;
			}
		}
		normalizeRollupTimestamps(rollup);
	}
	return rollups;
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
	// Spread rollup over base to get non-count fields (last_applied_at,
	// last_acknowledged_at, violation_timestamps, etc.) at rollup-precedence, then
	// explicitly omit `n_a_count` (a CounterRollup-internal field not declared on
	// RetrievalOutcome — F-004) and override the three additive count fields below.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	const { n_a_count: _na, ...rollupWithoutNa } = rollup;
	return {
		...base,
		...rollupWithoutNa,
		// Outcome counts are ADDITIVE, not rollup-overwrite (issue #1477): `base`
		// holds frozen historical counts that were written directly into the entry
		// before shown→outcome attribution was event-sourced; `rollup` holds the
		// event-derived counts. After the move to event sourcing the entry is never
		// mutated for these counters again, so each outcome lives in exactly one of
		// the two sources — summing counts each exactly once AND preserves
		// pre-migration history without a data migration. A plain spread would let
		// the (production-zero) rollup clobber real historical entry counts, which
		// was the root cause of the "outcomes never accrue" stall. Only these two
		// counts were ever written to the entry; partial_after_shown_count is
		// event-only and correctly rides the spread above. All non-count fields keep
		// rollup precedence (they were always events/legacy-authoritative).
		succeeded_after_shown_count:
			(base.succeeded_after_shown_count ?? 0) +
			(rollup.succeeded_after_shown_count ?? 0),
		failed_after_shown_count:
			(base.failed_after_shown_count ?? 0) +
			(rollup.failed_after_shown_count ?? 0),
	};
}

// ============================================================================
// Feedback bridge — Knowledge verdict → confidence bumps
// ============================================================================

const VERDICT_CONFIDENCE_BOOST = 0.03;
const VERDICT_CONFIDENCE_DECAY = 0.05;

/**
 * Read authoritative receipt terminals (applied/violated/ignored), aggregate
 * per knowledge entry, and apply bounded confidence deltas via
 * `bumpKnowledgeConfidenceBatch`.
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
	options?: {
		sinceTimestamp?: string;
		sinceEventId?: string;
		/** G2: forwarded to bumpKnowledgeConfidenceBatch. */
		floorOptions?: ConfidenceFloorOptions;
	},
): Promise<{
	processed: number;
	bumps: number;
	lastProcessedTimestamp?: string;
	lastProcessedEventId?: string;
}> {
	try {
		const history = await _internals.queryHistoricalOutcomes(directory);
		if (!history.ok) return { processed: 0, bumps: 0 };
		const seenEventIds = new Set<string>();
		const events = history.memberships
			.flatMap((membership) => {
				const compatible = membership as ReceiptMembership & {
					terminal_history?: ReceiptTerminal[];
					historical_terminals?: ReceiptTerminal[];
				};
				const terminals = [
					...(compatible.terminal_history ?? []),
					...(compatible.historical_terminals ?? []),
					...(membership.terminal ? [membership.terminal] : []),
				];
				return terminals.flatMap((terminal) => {
					if (
						(terminal.outcome !== 'applied' &&
							terminal.outcome !== 'violated' &&
							terminal.outcome !== 'ignored') ||
						seenEventIds.has(terminal.event_id)
					) {
						return [];
					}
					seenEventIds.add(terminal.event_id);
					return [
						{
							type: terminal.outcome,
							event_id: terminal.event_id,
							knowledge_id: membership.entry_id,
							timestamp: terminal.committed_at,
						},
					];
				});
			})
			.sort((a, b) =>
				a.timestamp === b.timestamp
					? a.event_id.localeCompare(b.event_id)
					: a.timestamp.localeCompare(b.timestamp),
			);
		const markerIndex =
			options?.sinceTimestamp && options.sinceEventId
				? events.findIndex(
						(e) =>
							e.timestamp === options.sinceTimestamp &&
							e.event_id === options.sinceEventId,
					)
				: -1;

		const actionable = events.filter((e, index) => {
			if (options?.sinceTimestamp && e.timestamp < options.sinceTimestamp) {
				return false;
			}
			if (options?.sinceTimestamp && e.timestamp === options.sinceTimestamp) {
				if (!options.sinceEventId) {
					return false;
				}
				if (markerIndex < 0) {
					return false;
				}
				return index > markerIndex;
			}
			return true;
		});

		if (actionable.length === 0) {
			return { processed: 0, bumps: 0 };
		}

		const groups = new Map<string, typeof actionable>();
		let lastProcessedTimestamp: string | undefined;
		let lastProcessedEventId: string | undefined;
		for (const event of actionable) {
			if (
				typeof event.timestamp === 'string' &&
				(!lastProcessedTimestamp || event.timestamp >= lastProcessedTimestamp)
			) {
				lastProcessedTimestamp = event.timestamp;
				lastProcessedEventId = event.event_id;
			}
			const kid = event.knowledge_id;
			if (!kid) continue;
			const group = groups.get(kid) ?? [];
			group.push(event);
			groups.set(kid, group);
		}

		const deltas: Array<{
			id: string;
			delta: number;
			receipt_events: Array<{
				event_id: string;
				timestamp: string;
				outcome: 'applied' | 'violated' | 'ignored';
			}>;
		}> = [];
		for (const [id, group] of groups) {
			const positives = group.filter(
				(event) => event.type === 'applied',
			).length;
			const negatives = group.length - positives;
			if (positives === 0 && negatives === 0) continue;
			const delta =
				positives > negatives
					? VERDICT_CONFIDENCE_BOOST
					: -VERDICT_CONFIDENCE_DECAY;
			deltas.push({
				id,
				delta,
				receipt_events: group.map((event) => ({
					event_id: event.event_id,
					timestamp: event.timestamp,
					outcome: event.type,
				})),
			});
		}

		let bumps = 0;
		if (deltas.length > 0) {
			const { bumpKnowledgeConfidenceBatch } = await import(
				'./knowledge-store.js'
			);
			bumps = await bumpKnowledgeConfidenceBatch(
				directory,
				deltas,
				options?.floorOptions,
			);
		}

		return {
			processed: groups.size,
			bumps,
			lastProcessedTimestamp,
			lastProcessedEventId,
		};
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
	resolveKnowledgeCounterBaselinePath: typeof resolveKnowledgeCounterBaselinePath;
	appendKnowledgeEvent: typeof appendKnowledgeEvent;
	recordKnowledgeEvent: typeof recordKnowledgeEvent;
	readKnowledgeEvents: typeof readKnowledgeEvents;
	queryHistoricalOutcomes: typeof queryHistoricalOutcomes;
	readCounterBaseline: typeof readCounterBaseline;
	readLegacyApplicationRecords: typeof readLegacyApplicationRecords;
	readKnowledgeCounterRollups: typeof readKnowledgeCounterRollups;
	readAuthoritativeKnowledgeCounterRollups: typeof readAuthoritativeKnowledgeCounterRollups;
	effectiveRetrievalOutcomes: typeof effectiveRetrievalOutcomes;
	recomputeCounters: typeof recomputeCounters;
	applyKnowledgeVerdictFeedback: typeof applyKnowledgeVerdictFeedback;
	newTraceId: typeof newTraceId;
	newEventId: typeof newEventId;
	resolveHiveEventsPath: typeof resolveHiveEventsPath;
	appendHiveKnowledgeEvent: typeof appendHiveKnowledgeEvent;
	recordHiveKnowledgeEvent: typeof recordHiveKnowledgeEvent;
	readHiveKnowledgeEvents: typeof readHiveKnowledgeEvents;
	// Exposed for the cohort family-migration engine (issue #1846) so the
	// counter-baseline `sum-counters` merge reuses the canonical primitive
	// rather than reimplementing the per-counter sum + maxIso-timestamp logic.
	mergeRollupInto: typeof mergeRollupInto;
} = {
	resolveKnowledgeEventsPath,
	resolveKnowledgeCounterBaselinePath,
	appendKnowledgeEvent,
	recordKnowledgeEvent,
	readKnowledgeEvents,
	queryHistoricalOutcomes,
	readCounterBaseline,
	readLegacyApplicationRecords,
	readKnowledgeCounterRollups,
	readAuthoritativeKnowledgeCounterRollups,
	effectiveRetrievalOutcomes,
	recomputeCounters,
	applyKnowledgeVerdictFeedback,
	newTraceId,
	newEventId,
	resolveHiveEventsPath,
	appendHiveKnowledgeEvent,
	recordHiveKnowledgeEvent,
	readHiveKnowledgeEvents,
	mergeRollupInto,
};

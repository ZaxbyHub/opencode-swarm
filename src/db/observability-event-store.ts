/**
 * swarm.db store for the canonical observability event envelope (issue #2482,
 * Workstream D PR 3).
 *
 * The durable local query authority for observability events:
 *
 * - Table `observability_event` — one row per emitted canonical
 *   `ObservabilityEvent`, appended through the group-commit writer (queue ->
 *   one txn per flush). Durability class `normal` (rebuildable telemetry
 *   sink; the bounded `.swarm/telemetry.jsonl` stream remains the
 *   operational legacy record — this store does NOT replace it).
 * - The sink registers as a TELEMETRY LISTENER (`registerObservabilityEventSink`),
 *   not as an `emit()` call site: the retention-registry writer-coverage
 *   ratchet requires every writer module to appear in exactly one registry
 *   row, and `src/telemetry.ts` is already owned by the `telemetry-jsonl`
 *   row. The listener receives the canonical envelope as its third
 *   parameter.
 * - Zero top-level executable side effects; no DB work at plugin init. The
 *   DB handle opens lazily on the first sink append (`getProjectDb` /
 *   `getGroupCommitWriter` are invoked inside the listener closure, matching
 *   the `insight-candidate-store.ts` precedent). Processes that never
 *   register the sink (direct CLI / test scripts) simply get no SQLite sink —
 *   fail-open, never an error.
 * - Fail-open everywhere: sink failures are counted (bounded in-memory
 *   counters persisted opportunistically into `observability_sink_health`)
 *   and never propagate. The sink is non-authoritative for every decision;
 *   observability health is surfaced through `/swarm report`.
 * - Malformed events are QUARANTINED, not dropped: rows that cannot carry a
 *   faithful envelope (fallback observations, oversize payloads, unparseable
 *   legacy import lines) are stored with `quarantined = 1` plus a reason and
 *   excluded from report timelines while remaining countable.
 * - Rebuildable: `syncObservabilityImport` (report path only — never per
 *   emit, never at init) incrementally imports the bounded legacy
 *   `telemetry.jsonl(.1)` stream using deterministic per-line synthetic ids,
 *   so deleting the imported rows and re-syncing reproduces byte-identical
 *   content (proven by test).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ObservabilityEvent } from '../observability/envelope.js';
import { extractWorkflowIds } from '../observability/legacy.js';
import type { TelemetryEvent, TelemetryListener } from '../telemetry.js';
import { addTelemetryListener, removeTelemetryListener } from '../telemetry.js';
import { canonicalProjectKey } from './canonical-project.js';
import { DURABILITY_CLASSES } from './durability.js';
import { getGroupCommitWriter } from './group-commit-writer.js';
import { getProjectDb, projectDbExists } from './project-db.js';

/** Hard cap on retained observability rows (DELETE-based retention). */
export const MAX_OBSERVABILITY_EVENT_ROWS = 50_000;

/** Rows past this many accepted events get a retention check appended. */
export const RETENTION_CHECK_INTERVAL = 512;

/** Health-counter deltas are persisted at most this often (events). */
export const HEALTH_UPSERT_INTERVAL = 256;

/** Hard cap on a single serialized payload (oversize → quarantined stub). */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

/** Legacy stream filenames imported by `syncObservabilityImport`. */
const LEGACY_STREAM_FILES = ['telemetry.jsonl.1', 'telemetry.jsonl'] as const;

/** Import id namespace — synthetic event ids are content-derived and stable. */
const IMPORT_ID_NAMESPACE = 'obs-import-v1';

/**
 * Parse gate for legacy import lines (PRR-002): JSON.parse cost scales with
 * line length; rotation bounds the file at ~10 MiB, but a single pathological
 * line is still a self-inflicted heap spike. Lines longer than this are
 * quarantined WITHOUT parsing.
 */
const MAX_IMPORT_LINE_BYTES = 1024 * 1024;

export type IngestedVia = 'live' | 'import';

export interface ObservabilityEventRow {
	rowid: number;
	event_id: string;
	kind: string;
	category: string | null;
	severity: string | null;
	occurred_at: string;
	writer_sequence: number | null;
	trace_id: string | null;
	span_id: string | null;
	host_session_id: string | null;
	task_id: string | null;
	lane_id: string | null;
	batch_id: string | null;
	phase_id: string | null;
	council_round_id: string | null;
	project_ref: string | null;
	outcome_status: string | null;
	retry_index: number | null;
	privacy_class: string | null;
	sampled: number | null;
	payload_json: string;
	relationship_violations: string | null;
	quarantined: number;
	quarantine_reason: string | null;
	ingested_via: string;
}

export interface ObservabilitySinkHealth {
	accepted: number;
	quarantined: number;
	dropped: number;
	last_error_category: string | null;
	last_error_at: string | null;
	last_flush_at: string | null;
	updated_at: string | null;
}

/** Filter set for bounded report queries. Every field optional. */
export interface ObservabilityEventFilter {
	taskId?: string;
	sessionId?: string;
	traceId?: string;
	batchId?: string;
	/** Inclusive lower bound on `occurred_at` (ISO-8601 string compare). */
	since?: string;
}

/**
 * Best-effort flush of the shared group-commit writer so read paths observe
 * every accepted event (the queue batches writes; queries are the natural
 * flush point for a query authority). Never throws — a failed flush simply
 * means the query sees the last committed batch.
 */
/**
 * Flush the SHARED per-root group-commit writer before a read. This commits
 * pending writes of EVERY durability class queued on that writer, not just
 * observability rows — conservative and correct (a flush never harms), at
 * the cost of performing other classes' writes on our read path (documented
 * trade-off, PRR-017).
 */
function flushPendingWrites(directory: string): void {
	try {
		_internals.getGroupCommitWriter(directory).flushSync();
	} catch {
		// fail-open: reads proceed against the last committed batch
	}
}

// ─── Sink listener registration ────────────────────────────────────────────

/** Directory the sink listener writes to; null until registered. */
let _sinkDirectory: string | null = null;
let _sinkListener: TelemetryListener | null = null;

/** Per-process in-memory health deltas (persisted opportunistically). */
const _healthDeltas = new Map<string, ObservabilitySinkHealth>();
const _eventsSinceRetentionCheck = new Map<string, number>();
const _eventsSinceHealthUpsert = new Map<string, number>();

function emptyHealth(): ObservabilitySinkHealth {
	return {
		accepted: 0,
		quarantined: 0,
		dropped: 0,
		last_error_category: null,
		last_error_at: null,
		last_flush_at: null,
		updated_at: null,
	};
}

function noteDropped(directory: string, category: string): void {
	const h = _healthDeltas.get(directory) ?? emptyHealth();
	h.dropped += 1;
	h.last_error_category = category;
	h.last_error_at = new Date().toISOString();
	_healthDeltas.set(directory, h);
}

/**
 * Register the SQLite observability sink as a telemetry listener for this
 * project root. O(1), idempotent, never opens the DB, never throws — safe to
 * call immediately before `initTelemetry` on the plugin init path. Registering
 * with a DIFFERENT directory evicts the previous listener first, so exactly
 * one sink listener is ever on the telemetry bus (per-directory counters live
 * in their own maps and simply resume under the new binding).
 */
export function registerObservabilityEventSink(directory: string): void {
	try {
		const key = canonicalProjectKey(directory);
		if (_sinkListener !== null) {
			if (_sinkDirectory === key) return;
			const previous = _sinkDirectory;
			if (previous !== null) {
				// Best-effort flush of the previous root's pending counters,
				// then forget them: the per-root maps would otherwise grow
				// without bound across rebinds (PRR-012). Only flush when the
				// root already has a DB — getGroupCommitWriter would
				// otherwise materialize one for a root with nothing pending.
				if (projectDbExists(previous)) flushPendingWrites(previous);
				_healthDeltas.delete(previous);
				_eventsSinceRetentionCheck.delete(previous);
				_eventsSinceHealthUpsert.delete(previous);
			}
			try {
				removeTelemetryListener(_sinkListener);
			} catch {
				// not registered
			}
			_sinkListener = null;
		}
		_sinkDirectory = key;
		_sinkListener = (
			_event: TelemetryEvent,
			_data: Record<string, unknown>,
			canonical?: ObservabilityEvent,
		) => {
			const dir = _sinkDirectory;
			if (dir === null || canonical === undefined) return;
			try {
				appendObservabilityEventDb(dir, canonical);
			} catch (err) {
				// Fail-open: the sink never propagates failures into emit().
				noteDropped(
					dir,
					err instanceof Error ? err.constructor.name : 'unknown',
				);
			}
		};
		addTelemetryListener(_sinkListener);
	} catch {
		// Registration must never throw on the init path.
	}
}

/** Test/reset hook: drops the listener and forgets the binding. */
export function resetObservabilityEventSinkForTesting(): void {
	if (_sinkListener !== null) {
		try {
			removeTelemetryListener(_sinkListener);
		} catch {
			// not registered
		}
	}
	_sinkListener = null;
	_sinkDirectory = null;
	_healthDeltas.clear();
	_eventsSinceRetentionCheck.clear();
	_eventsSinceHealthUpsert.clear();
}

// ─── Row construction + append ─────────────────────────────────────────────

interface BuiltRow {
	columns: {
		event_id: string;
		kind: string;
		category: string | null;
		severity: string | null;
		occurred_at: string;
		writer_sequence: number | null;
		trace_id: string | null;
		span_id: string | null;
		host_session_id: string | null;
		task_id: string | null;
		lane_id: string | null;
		batch_id: string | null;
		phase_id: string | null;
		council_round_id: string | null;
		project_ref: string | null;
		outcome_status: string | null;
		retry_index: number | null;
		privacy_class: string | null;
		sampled: number | null;
		payload_json: string;
		relationship_violations: string | null;
		quarantined: 0 | 1;
		quarantine_reason: string | null;
	};
}

/** True when the payload marks this delegation_end as a recovered end. */
function isRecoveredDelegationEnd(canonical: ObservabilityEvent): boolean {
	if (canonical.kind !== 'delegation_end') return false;
	const raw = canonical.legacy?.raw as
		| { recovered?: unknown; record_id?: unknown; result?: unknown }
		| undefined;
	return (
		raw?.recovered === true &&
		typeof raw.record_id === 'string' &&
		raw.record_id.length > 0 &&
		typeof raw.result === 'string'
	);
}

/**
 * PRR-001: recovered delegation ends get a DETERMINISTIC row id derived from
 * the record identity + terminal status, not the random envelope id. The same
 * eventless terminal can be detected twice (the stale-sweep observer and a
 * later settle's already_terminal_without_event branch both emit); random
 * per-emission ids defeated the sink's event_id dedup, storing two rows for
 * one delegation. With this key, duplicate emissions collapse via INSERT OR
 * IGNORE regardless of which call site (or process) emitted them.
 */
function recoveredEndEventId(canonical: ObservabilityEvent): string {
	if (!isRecoveredDelegationEnd(canonical)) return canonical.eventId;
	const raw = canonical.legacy?.raw as { record_id: string; result: string };
	return createHash('sha256')
		.update(`obs-recovered-end-v1\0${raw.record_id}\0${raw.result}`)
		.digest('hex')
		.slice(0, 32);
}

function buildLiveRow(canonical: ObservabilityEvent): BuiltRow {
	const violations = canonical.relationshipViolations ?? [];
	const fallbackBuild = violations.includes('observation_build_failed');
	let payloadJson: string;
	let quarantined: 0 | 1 = 0;
	let quarantineReason: string | null = null;
	try {
		payloadJson = JSON.stringify(canonical.legacy?.raw ?? {});
	} catch {
		payloadJson = '{}';
		quarantined = 1;
		quarantineReason = 'payload_unserializable';
	}
	if (quarantined === 0 && payloadJson.length > MAX_EVENT_PAYLOAD_BYTES) {
		payloadJson = '{"truncated":true}';
		quarantined = 1;
		quarantineReason = 'payload_oversize';
	}
	if (quarantined === 0 && fallbackBuild) {
		quarantined = 1;
		quarantineReason = 'observation_build_fallback';
	}
	const trace = canonical.trace;
	const workflow = canonical.workflow ?? {};
	const lineage = canonical.lineage ?? {};
	const outcome = canonical.outcome ?? {};
	const policy = canonical.policy ?? {};
	return {
		columns: {
			event_id: recoveredEndEventId(canonical),
			kind: canonical.kind,
			category: canonical.category ?? null,
			severity: canonical.severity ?? null,
			occurred_at: canonical.occurredAt,
			writer_sequence: canonical.writerSequence ?? null,
			trace_id: trace?.traceId ?? null,
			span_id: trace?.spanId ?? null,
			host_session_id: workflow.hostSessionId ?? null,
			task_id: workflow.taskId ?? null,
			lane_id: workflow.laneId ?? null,
			batch_id: workflow.batchId ?? null,
			phase_id: workflow.phaseId ?? null,
			council_round_id: workflow.councilRoundId ?? null,
			project_ref: lineage.projectRef ?? null,
			outcome_status: outcome.status ?? null,
			retry_index: outcome.retryIndex ?? null,
			privacy_class: policy.privacyClass ?? null,
			sampled: policy.sampled === undefined ? null : policy.sampled ? 1 : 0,
			payload_json: payloadJson,
			relationship_violations:
				violations.length > 0 ? JSON.stringify(violations) : null,
			quarantined,
			quarantine_reason: quarantineReason,
		},
	};
}

const INSERT_EVENT_SQL = `INSERT OR IGNORE INTO observability_event (
	event_id, kind, category, severity, occurred_at, writer_sequence,
	trace_id, span_id, host_session_id, task_id, lane_id, batch_id,
	phase_id, council_round_id, project_ref, outcome_status, retry_index,
	privacy_class, sampled, payload_json, relationship_violations,
	quarantined, quarantine_reason, ingested_via
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertRow(
	db: ReturnType<typeof getProjectDb>,
	columns: BuiltRow['columns'],
	ingestedVia: IngestedVia,
): void {
	db.run(INSERT_EVENT_SQL, [
		columns.event_id,
		columns.kind,
		columns.category,
		columns.severity,
		columns.occurred_at,
		columns.writer_sequence,
		columns.trace_id,
		columns.span_id,
		columns.host_session_id,
		columns.task_id,
		columns.lane_id,
		columns.batch_id,
		columns.phase_id,
		columns.council_round_id,
		columns.project_ref,
		columns.outcome_status,
		columns.retry_index,
		columns.privacy_class,
		columns.sampled,
		columns.payload_json,
		columns.relationship_violations,
		columns.quarantined,
		columns.quarantine_reason,
		ingestedVia,
	]);
}

function runRetentionIfOverCap(db: ReturnType<typeof getProjectDb>): void {
	const count =
		db
			.query<{ count: number }, []>(
				'SELECT COUNT(*) as count FROM observability_event',
			)
			.get()?.count ?? 0;
	if (count <= MAX_OBSERVABILITY_EVENT_ROWS) return;
	const excess = count - MAX_OBSERVABILITY_EVENT_ROWS;
	db.run(
		'DELETE FROM observability_event WHERE rowid IN (SELECT rowid FROM observability_event ORDER BY rowid ASC LIMIT ?)',
		[excess],
	);
}

function upsertHealthDelta(
	db: ReturnType<typeof getProjectDb>,
	root: string,
	flushed: boolean,
): void {
	const delta = _healthDeltas.get(root);
	if (delta === undefined) return;
	const now = new Date().toISOString();
	db.run(
		`INSERT INTO observability_sink_health (
			id, accepted, quarantined, dropped,
			last_error_category, last_error_at, last_flush_at, updated_at
		) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			accepted = accepted + excluded.accepted,
			quarantined = quarantined + excluded.quarantined,
			dropped = dropped + excluded.dropped,
			last_error_category = excluded.last_error_category,
			last_error_at = excluded.last_error_at,
			last_flush_at = COALESCE(excluded.last_flush_at, last_flush_at),
			updated_at = excluded.updated_at`,
		[
			delta.accepted,
			delta.quarantined,
			delta.dropped,
			delta.last_error_category,
			delta.last_error_at,
			flushed ? now : null,
			now,
		],
	);
	_healthDeltas.delete(root);
}

/**
 * Append one canonical event to the SQLite query authority via the
 * group-commit writer (durability `normal`). Fail-open contract: throws are
 * the CALLER's to swallow (the sink listener does). In-memory health counters
 * track accepted/quarantined; retention + health persistence are appended to
 * the same batch on their throttle intervals so they can never race a live
 * append.
 */
export function appendObservabilityEventDb(
	directory: string,
	canonical: ObservabilityEvent,
): void {
	const root = canonicalProjectKey(directory);
	const row = buildLiveRow(canonical);
	const h = _healthDeltas.get(root) ?? emptyHealth();
	h.accepted += 1;
	if (row.columns.quarantined === 1) h.quarantined += 1;
	_healthDeltas.set(root, h);

	const eventsSinceCheck = (_eventsSinceRetentionCheck.get(root) ?? 0) + 1;
	_eventsSinceRetentionCheck.set(root, eventsSinceCheck);
	const eventsSinceHealth = (_eventsSinceHealthUpsert.get(root) ?? 0) + 1;
	_eventsSinceHealthUpsert.set(root, eventsSinceHealth);

	const writer = _internals.getGroupCommitWriter(root);
	writer.enqueue({
		durability: DURABILITY_CLASSES.observability_event,
		run: (db) => {
			insertRow(db, row.columns, 'live');
			if (eventsSinceCheck >= RETENTION_CHECK_INTERVAL) {
				_eventsSinceRetentionCheck.set(root, 0);
				runRetentionIfOverCap(db);
			}
			if (eventsSinceHealth >= HEALTH_UPSERT_INTERVAL) {
				_eventsSinceHealthUpsert.set(root, 0);
				upsertHealthDelta(db, root, true);
			}
		},
	});
}

// ─── Legacy import (rebuildable) ───────────────────────────────────────────

export interface ObservabilityImportResult {
	imported: number;
	quarantined: number;
	skippedUnchanged: boolean;
}

interface ImportMarker {
	fingerprint_size: number;
	fingerprint_mtime_ms: number;
	lines_seen: number;
}

function syntheticImportEventId(line: string): string {
	return createHash('sha256')
		.update(`${IMPORT_ID_NAMESPACE}\0${line}`)
		.digest('hex');
}

/** Stub row for a line that cannot (or should not) be parsed. */
function unparseableImportRow(
	line: string,
	reason: 'import_unparseable_line' | 'import_oversize_line',
): { columns: BuiltRow['columns']; quarantined: boolean } {
	return {
		columns: {
			event_id: syntheticImportEventId(line),
			kind: 'unknown',
			category: null,
			severity: null,
			occurred_at: new Date().toISOString(),
			writer_sequence: null,
			trace_id: null,
			span_id: null,
			host_session_id: null,
			task_id: null,
			lane_id: null,
			batch_id: null,
			phase_id: null,
			council_round_id: null,
			project_ref: null,
			outcome_status: null,
			retry_index: null,
			privacy_class: null,
			sampled: null,
			payload_json:
				line.length > MAX_EVENT_PAYLOAD_BYTES
					? '{"truncated":true}'
					: JSON.stringify({ raw_line: line }),
			relationship_violations: null,
			quarantined: 1,
			quarantine_reason: reason,
		},
		quarantined: true,
	};
}

/** Build an import row from one legacy JSONL line; null → skip (blank). */
function buildImportRow(
	line: string,
): { columns: BuiltRow['columns']; quarantined: boolean } | null {
	if (line.trim().length === 0) return null;
	// PRR-002: quarantine pathological lines WITHOUT parsing them.
	if (line.length > MAX_IMPORT_LINE_BYTES) {
		return unparseableImportRow(line, 'import_oversize_line');
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return unparseableImportRow(line, 'import_unparseable_line');
	}
	const workflow = _internals.extractWorkflowIds(parsed);
	const timestamp =
		typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
	const kind =
		typeof parsed.event === 'string' && parsed.event.length > 0
			? parsed.event
			: 'unknown';
	const payloadJson = JSON.stringify(parsed);
	return {
		columns: {
			event_id: syntheticImportEventId(line),
			kind,
			category: null,
			severity: null,
			occurred_at: timestamp ?? new Date().toISOString(),
			writer_sequence: null,
			trace_id: null,
			span_id: null,
			host_session_id: workflow.hostSessionId ?? null,
			task_id: workflow.taskId ?? null,
			lane_id: workflow.laneId ?? null,
			batch_id: workflow.batchId ?? null,
			phase_id: workflow.phaseId ?? null,
			council_round_id: workflow.councilRoundId ?? null,
			project_ref: null,
			outcome_status: null,
			retry_index: null,
			privacy_class: null,
			sampled: null,
			payload_json:
				payloadJson.length > MAX_EVENT_PAYLOAD_BYTES
					? '{"truncated":true}'
					: payloadJson,
			relationship_violations: null,
			quarantined: timestamp === null ? 1 : 0,
			quarantine_reason: timestamp === null ? 'import_missing_timestamp' : null,
		},
		quarantined: timestamp === null,
	};
}

/**
 * Incrementally import the bounded legacy `telemetry.jsonl(.1)` stream into
 * the query authority. Deterministic and idempotent: per-file markers record
 * (size, mtime, lines_seen); append-only growth imports just the delta;
 * rotation/shrink (or a deleted/recreated file) triggers a full rescan whose
 * content-derived synthetic ids make every re-insert a no-op (`INSERT OR
 * IGNORE`). Runs only from the report path — never per emit, never at init.
 * Files are read oldest-generation first so rowid order tracks event order.
 */
export function syncObservabilityImport(
	directory: string,
): ObservabilityImportResult {
	flushPendingWrites(directory);
	const root = canonicalProjectKey(directory);
	const result: ObservabilityImportResult = {
		imported: 0,
		quarantined: 0,
		skippedUnchanged: true,
	};
	for (const fileName of LEGACY_STREAM_FILES) {
		const filePath = join(root, '.swarm', fileName);
		let stats: { size: number; mtimeMs: number };
		try {
			const st = statSync(filePath);
			stats = { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			continue;
		}
		const db = _internals.getProjectDb(directory);
		const marker = db
			.query<ImportMarker | null, [string]>(
				'SELECT fingerprint_size, fingerprint_mtime_ms, lines_seen FROM observability_import WHERE source = ?',
			)
			.get(fileName);
		if (
			marker !== null &&
			marker !== undefined &&
			marker.fingerprint_size === stats.size &&
			marker.fingerprint_mtime_ms === stats.mtimeMs
		) {
			continue;
		}
		result.skippedUnchanged = false;
		let content: string;
		try {
			content = readFileSync(filePath, 'utf-8');
		} catch {
			continue;
		}
		const lines = content.split('\n');
		// Append-only growth: start at the previously seen CONTENT line count
		// (the trailing empty string from the final newline is NOT a content
		// line — counting it would skip the first appended line). Any shrink
		// (rotation overwrote the file) resets to a full rescan.
		const contentLineCount =
			lines.length > 0 && lines[lines.length - 1] === ''
				? lines.length - 1
				: lines.length;
		const hasMarker = marker !== null && marker !== undefined;
		const start =
			hasMarker && contentLineCount >= (marker as ImportMarker).lines_seen
				? (marker as ImportMarker).lines_seen
				: 0;
		const rows: Array<{ columns: BuiltRow['columns']; quarantined: boolean }> =
			[];
		for (let i = start; i < lines.length; i++) {
			const built = buildImportRow(lines[i] as string);
			if (built === null) continue;
			rows.push(built);
		}
		const imported = rows.length;
		const quarantined = rows.filter((r) => r.quarantined).length;
		db.run('BEGIN IMMEDIATE');
		try {
			for (const row of rows) insertRow(db, row.columns, 'import');
			db.run(
				`INSERT INTO observability_import (source, fingerprint_size, fingerprint_mtime_ms, lines_seen, imported_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(source) DO UPDATE SET
					fingerprint_size = excluded.fingerprint_size,
					fingerprint_mtime_ms = excluded.fingerprint_mtime_ms,
					lines_seen = excluded.lines_seen,
					imported_at = excluded.imported_at`,
				[
					fileName,
					stats.size,
					stats.mtimeMs,
					contentLineCount,
					new Date().toISOString(),
				],
			);
			runRetentionIfOverCap(db);
			db.run('COMMIT');
		} catch (err) {
			try {
				db.run('ROLLBACK');
			} catch {
				// connection may already be out of the transaction
			}
			throw err;
		}
		result.imported += imported;
		result.quarantined += quarantined;
	}
	return result;
}

// ─── Queries (report path) ─────────────────────────────────────────────────

/** Row cap for a single report query (#2048 bounded output budget). */
export const MAX_REPORT_ROWS = 5000;

export interface ObservabilityQueryResult {
	rows: ObservabilityEventRow[];
	truncated: boolean;
	totalMatching: number;
}

/**
 * Bounded, deterministic query over the query authority. Filters are exact
 * bound parameters (node:sqlite strictness — counts are exact per branch);
 * ordering is code-unit string compare on ISO timestamps plus rowid — no
 * locale-dependent collation. Quarantined rows are excluded from timelines.
 */
export function queryObservabilityEvents(
	directory: string,
	filter: ObservabilityEventFilter,
): ObservabilityQueryResult {
	flushPendingWrites(directory);
	const db = _internals.getProjectDb(directory);
	const where: string[] = ['quarantined = 0'];
	const params: string[] = [];
	if (filter.taskId !== undefined) {
		where.push('task_id = ?');
		params.push(filter.taskId);
	}
	if (filter.sessionId !== undefined) {
		where.push('host_session_id = ?');
		params.push(filter.sessionId);
	}
	if (filter.traceId !== undefined) {
		where.push('trace_id = ?');
		params.push(filter.traceId);
	}
	if (filter.batchId !== undefined) {
		where.push('batch_id = ?');
		params.push(filter.batchId);
	}
	if (filter.since !== undefined) {
		where.push('occurred_at >= ?');
		params.push(filter.since);
	}
	const whereSql = where.join(' AND ');
	const totalMatching =
		db
			.query<{ count: number }, string[]>(
				`SELECT COUNT(*) as count FROM observability_event WHERE ${whereSql}`,
			)
			.get(...params)?.count ?? 0;
	const rows = db
		.query<ObservabilityEventRow, string[]>(
			`SELECT rowid, event_id, kind, category, severity, occurred_at,
				writer_sequence, trace_id, span_id, host_session_id, task_id,
				lane_id,
				batch_id, phase_id, council_round_id, project_ref, outcome_status,
				retry_index, privacy_class, sampled, payload_json,
				relationship_violations, quarantined, quarantine_reason,
				ingested_via
			FROM observability_event WHERE ${whereSql}
			ORDER BY occurred_at ASC, rowid ASC LIMIT ?`,
		)
		// The loader's typed binding params are strings; SQLite coerces the
		// LIMIT bound value back to integer (both drivers accept this).
		.all(...params, String(MAX_REPORT_ROWS));
	return {
		rows,
		truncated: totalMatching > rows.length,
		totalMatching,
	};
}

/** Cumulative persisted sink health (never opens a DB when absent). */
export function readObservabilitySinkHealth(
	directory: string,
): ObservabilitySinkHealth | null {
	if (!projectDbExists(directory)) {
		const root = canonicalProjectKey(directory);
		const delta = _healthDeltas.get(root);
		if (delta === undefined) return null;
		return delta;
	}
	flushPendingWrites(directory);
	const db = _internals.getProjectDb(directory);
	const persisted = db
		.query<ObservabilitySinkHealth, []>(
			'SELECT accepted, quarantined, dropped, last_error_category, last_error_at, last_flush_at, updated_at FROM observability_sink_health WHERE id = 1',
		)
		.get();
	if (persisted === undefined) {
		const root = canonicalProjectKey(directory);
		return _healthDeltas.get(root) ?? null;
	}
	return persisted;
}

/** Coverage snapshot for report disclosure (live/imported/quarantined). */
export interface ObservabilityCoverage {
	liveRows: number;
	importedRows: number;
	quarantinedRows: number;
	totalRows: number;
	earliestOccurredAt: string | null;
	latestOccurredAt: string | null;
}

export function readObservabilityCoverage(
	directory: string,
): ObservabilityCoverage | null {
	// Fresh project (neither DB nor legacy stream): report "unavailable" and
	// materialize nothing. A LEGACY-ONLY project deliberately falls through and
	// opens the DB on the report path — importing that stream IS the rebuild
	// this store exists to perform (#2482 rebuildable indexes), not a
	// materialization violation.
	if (!projectDbExists(directory) && !legacyStreamExists(directory))
		return null;
	flushPendingWrites(directory);
	const db = _internals.getProjectDb(directory);
	const counts = db
		.query<
			{
				total: number;
				live: number;
				imported: number;
				quarantined: number;
			},
			[]
		>(
			`SELECT COUNT(*) as total,
				SUM(CASE WHEN ingested_via = 'live' THEN 1 ELSE 0 END) as live,
				SUM(CASE WHEN ingested_via = 'import' THEN 1 ELSE 0 END) as imported,
				SUM(quarantined) as quarantined
			FROM observability_event`,
		)
		.get();
	const range = db
		.query<{ earliest: string | null; latest: string | null }, []>(
			'SELECT MIN(occurred_at) as earliest, MAX(occurred_at) as latest FROM observability_event WHERE quarantined = 0',
		)
		.get();
	return {
		liveRows: counts?.live ?? 0,
		importedRows: counts?.imported ?? 0,
		quarantinedRows: counts?.quarantined ?? 0,
		totalRows: counts?.total ?? 0,
		earliestOccurredAt: range?.earliest ?? null,
		latestOccurredAt: range?.latest ?? null,
	};
}

function legacyStreamExists(directory: string): boolean {
	const root = canonicalProjectKey(directory);
	for (const fileName of LEGACY_STREAM_FILES) {
		try {
			if (existsSync(join(root, '.swarm', fileName))) return true;
		} catch {
			// unreadable — treat as absent
		}
	}
	return false;
}

/** DI seam (repo `_internals` convention). */
export const _internals: {
	getProjectDb: typeof getProjectDb;
	getGroupCommitWriter: typeof getGroupCommitWriter;
	extractWorkflowIds: typeof extractWorkflowIds;
} = {
	getProjectDb,
	getGroupCommitWriter,
	extractWorkflowIds,
};

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
 *   `telemetry.jsonl(.1)` stream. Existing import rows are matched one-to-one
 *   by their legacy projection across rotation, while deterministic synthetic
 *   ids cover genuinely new occurrences.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ObservabilityEvent } from '../observability/envelope.js';
import { extractWorkflowIds } from '../observability/legacy.js';
import type { TelemetryEvent, TelemetryListener } from '../telemetry.js';
import {
	addTelemetryListener,
	LEGACY_OBSERVATION_ID_FIELD,
	LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX,
	removeTelemetryListener,
	setLegacyIdentityProjectionEnabled,
} from '../telemetry.js';
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

/** Import id namespace — synthetic event ids are occurrence-derived and stable. */
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
		setLegacyIdentityProjectionEnabled(true);
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
	setLegacyIdentityProjectionEnabled(false);
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

interface ProjectionColumns {
	event_id?: string;
	kind: string;
	occurred_at: string;
	quarantined: number;
	quarantine_reason: string | null;
	payload_json: string;
}

interface ProjectionCandidate extends ProjectionColumns {
	rowid: number;
	consumed?: boolean;
}

interface LiveProjectionCandidates {
	byDigest: Map<string, ProjectionCandidate[]>;
	byIdentity: Map<string, ProjectionCandidate[]>;
	byEventId: Map<string, ProjectionCandidate[]>;
}

/**
 * Digest the exact legacy projection, not the canonical envelope. The legacy
 * writer deliberately preserves caller key order and collision semantics, so
 * reconstituting that object from a live row lets the importer recognize rows
 * written by older processes without changing the legacy line bytes.
 */
function projectionDigest(value: unknown): string | null {
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) return null;
		return createHash('sha256').update(encoded).digest('hex');
	} catch {
		return null;
	}
}

function liveProjection(
	columns: ProjectionColumns,
): { digest: string; occurredAt: string; kind: string } | null {
	try {
		const raw = JSON.parse(columns.payload_json) as unknown;
		const projectedRaw =
			raw !== null && typeof raw === 'object' && !Array.isArray(raw)
				? { ...(raw as Record<string, unknown>) }
				: {};
		// The canonical sink stores the caller payload, while the telemetry
		// writer owns this reserved field in the legacy projection. Remove a
		// caller collision before comparing the two projections.
		delete projectedRaw[LEGACY_OBSERVATION_ID_FIELD];
		const projected = {
			timestamp: columns.occurred_at,
			event: columns.kind,
			...projectedRaw,
		};
		if (typeof projected.timestamp !== 'string') return null;
		const digest = projectionDigest(projected);
		return digest === null
			? null
			: {
					digest,
					occurredAt: projected.timestamp,
					kind:
						typeof projected.event === 'string' && projected.event.length > 0
							? projected.event
							: 'unknown',
				};
	} catch {
		return null;
	}
}

function importProjectionDigest(columns: ProjectionColumns): string | null {
	try {
		const parsed = JSON.parse(columns.payload_json) as unknown;
		if (columns.quarantined !== 0) {
			// Unparseable legacy lines retain their exact source text in the
			// quarantined stub. It is safe to reconcile those rows by source text;
			// bucket consumption still preserves duplicate occurrences one-to-one.
			if (
				parsed !== null &&
				typeof parsed === 'object' &&
				!Array.isArray(parsed)
			) {
				const object = parsed as Record<string, unknown>;
				if (typeof object.raw_line === 'string')
					return projectionDigest(object);
				// Oversized but parseable legacy lines retain only the bounded
				// versioned identity marker. Keep that marker stable across rotation
				// so the existing synthetic import row can be reused.
				const identity = provenanceLegacyObservationId(object);
				if (identity !== null) {
					return projectionDigest({
						[LEGACY_OBSERVATION_ID_FIELD]: `${LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX}${identity}`,
					});
				}
			}
			return null;
		}
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			!Array.isArray(parsed)
		) {
			const normalized = { ...(parsed as Record<string, unknown>) };
			delete normalized[LEGACY_OBSERVATION_ID_FIELD];
			return projectionDigest(normalized);
		}
		return projectionDigest(parsed);
	} catch {
		return null;
	}
}

function isUsableLegacyObservationId(value: string): boolean {
	// Canonical ids are UUID-shaped; synthetic import ids and recovered
	// delegation ids are hexadecimal digests. An arbitrary caller field must
	// never become a primary key or spoof a canonical event identity.
	return /^(?:[0-9a-f]{32}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
		value,
	);
}

function provenanceLegacyObservationId(
	parsed: Record<string, unknown>,
): string | null {
	const encoded = parsed[LEGACY_OBSERVATION_ID_FIELD];
	if (
		typeof encoded !== 'string' ||
		!encoded.startsWith(LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX)
	)
		return null;
	const identity = encoded.slice(
		LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX.length,
	);
	return isUsableLegacyObservationId(identity) ? identity : null;
}

function importIdentity(columns: ProjectionColumns): string | null {
	try {
		const parsed = JSON.parse(columns.payload_json) as Record<string, unknown>;
		return provenanceLegacyObservationId(parsed);
	} catch {
		return null;
	}
}

function isRecoveredLegacyProjection(columns: ProjectionColumns): boolean {
	try {
		const parsed = JSON.parse(columns.payload_json) as Record<string, unknown>;
		return (
			parsed.recovered === true &&
			typeof parsed.record_id === 'string' &&
			parsed.record_id.length > 0 &&
			typeof parsed.result === 'string'
		);
	} catch {
		return false;
	}
}

function identityCompatible(
	imported: ProjectionColumns,
	liveEventId: string | undefined,
): boolean {
	const identity = importIdentity(imported);
	return (
		identity === null ||
		identity === liveEventId ||
		// Recovered delegation ends intentionally use a deterministic sink id
		// derived from record_id/result, so the legacy projection's envelope id
		// is not the row's final primary key.
		isRecoveredLegacyProjection(imported)
	);
}

/**
 * Build one-to-one live candidates for a sync pass. Removing a candidate when
 * it is paired is the important part of the compatibility policy: two
 * byte-identical live occurrences remain two rows, while one legacy line can
 * never claim the same live occurrence twice.
 */
function loadLiveProjectionCandidates(
	db: ReturnType<typeof getProjectDb>,
): LiveProjectionCandidates {
	const candidates: LiveProjectionCandidates = {
		byDigest: new Map(),
		byIdentity: new Map(),
		byEventId: new Map(),
	};
	const rows = db
		.query<ProjectionCandidate, []>(
			`SELECT rowid, event_id, kind, occurred_at, quarantined, quarantine_reason, payload_json
			 FROM observability_event
			 WHERE ingested_via = 'live'
			 ORDER BY rowid ASC`,
		)
		.all();
	for (const row of rows) {
		const projected = liveProjection(row);
		if (projected !== null) {
			const bucket = candidates.byDigest.get(projected.digest) ?? [];
			bucket.push(row);
			candidates.byDigest.set(projected.digest, bucket);
		}
		if (row.event_id !== undefined) {
			const eventIdBucket = candidates.byEventId.get(row.event_id) ?? [];
			eventIdBucket.push(row);
			candidates.byEventId.set(row.event_id, eventIdBucket);
			const identityKey = `${row.event_id}\u0000${row.kind}\u0000${row.occurred_at}`;
			const bucket = candidates.byIdentity.get(identityKey) ?? [];
			bucket.push(row);
			candidates.byIdentity.set(identityKey, bucket);
		}
	}
	return candidates;
}

function loadImportProjectionCandidates(
	db: ReturnType<typeof getProjectDb>,
): Map<string, ProjectionCandidate[]> {
	const candidates = new Map<string, ProjectionCandidate[]>();
	const rows = db
		.query<ProjectionCandidate, []>(
			`SELECT rowid, event_id, kind, occurred_at, quarantined, quarantine_reason, payload_json
			 FROM observability_event
			 WHERE ingested_via = 'import'
			 ORDER BY rowid ASC`,
		)
		.all();
	for (const row of rows) {
		const digest = importProjectionDigest(row);
		if (digest === null) continue;
		const bucket = candidates.get(digest) ?? [];
		bucket.push({ ...row });
		candidates.set(digest, bucket);
	}
	return candidates;
}

function takeLiveProjectionCandidate(
	candidates: LiveProjectionCandidates,
	columns: ProjectionColumns,
): ProjectionCandidate | null {
	const identity = importIdentity(columns);
	// Oversized legacy rows retain only the sink-owned canonical marker. Their
	// caller-supplied `event` and `timestamp` may override the canonical kind and
	// time, so use the marker as an identity-only join only when both rows carry
	// the expected oversized quarantine reasons. Require exactly one candidate to
	// fail closed if a malformed database contains an event-id collision.
	if (
		identity !== null &&
		columns.quarantined === 1 &&
		columns.quarantine_reason === 'import_payload_oversize'
	) {
		const eventIdCandidates = candidates.byEventId
			.get(identity)
			?.filter(
				(candidate) =>
					!candidate.consumed &&
					candidate.quarantined === 1 &&
					candidate.quarantine_reason === 'payload_oversize',
			);
		if (eventIdCandidates?.length === 1) {
			const [candidate] = eventIdCandidates;
			if (candidate !== undefined) {
				candidate.consumed = true;
				return candidate;
			}
		}
	}
	if (identity !== null) {
		const identityKey = `${identity}\u0000${columns.kind}\u0000${columns.occurred_at}`;
		const identityBucket = candidates.byIdentity.get(identityKey);
		const identityCandidate = identityBucket?.find(
			(candidate) => !candidate.consumed,
		);
		if (identityCandidate !== undefined) {
			identityCandidate.consumed = true;
			return identityCandidate;
		}
	}
	const digest = importProjectionDigest(columns);
	if (digest === null) return null;
	const bucket = candidates.byDigest.get(digest);
	if (bucket === undefined || bucket.length === 0) return null;
	const candidateIndex = bucket.findIndex(
		(candidate) =>
			!candidate.consumed &&
			(identity === null || identityCompatible(columns, candidate.event_id)),
	);
	if (candidateIndex < 0) return null;
	const [candidate] = bucket.splice(candidateIndex, 1);
	if (candidate !== undefined) candidate.consumed = true;
	if (bucket.length === 0) candidates.byDigest.delete(digest);
	return candidate ?? null;
}

function takeImportProjectionCandidate(
	candidates: Map<string, ProjectionCandidate[]>,
	columns: ProjectionColumns,
): ProjectionCandidate | null {
	const digest = importProjectionDigest(columns);
	if (digest === null) return null;
	const bucket = candidates.get(digest);
	if (bucket === undefined || bucket.length === 0) return null;
	const identity = importIdentity(columns);
	const candidateIndex = bucket.findIndex((candidate) => {
		const candidateIdentity = importIdentity(candidate);
		// If either side carries an explicit identity, require exact equality.
		// This prevents two identical projections with distinct canonical ids
		// from being falsely merged during a rotation rescan.
		return candidateIdentity === identity;
	});
	if (candidateIndex < 0) return null;
	const [candidate] = bucket.splice(candidateIndex, 1);
	if (bucket.length === 0) candidates.delete(digest);
	return candidate ?? null;
}

interface UnchangedImportSource {
	filePath: string;
	generationOffset: number;
}

/**
 * Reserve one existing import candidate for every occurrence in a source that
 * was unchanged this pass. Rows do not carry a source column (intentionally —
 * the store remains rebuildable without another migration), so this bounded
 * reservation prevents an unchanged rotated generation from lending its
 * candidate to a byte-identical *new* occurrence in the current generation.
 *
 * This is needed only when a later source has a full rescan. Normal unchanged
 * runs retain their stat-only fast path; each telemetry generation is bounded
 * by rotation when this compatibility path reads it.
 */
function reserveUnchangedImportCandidates(
	candidates: Map<string, ProjectionCandidate[]>,
	sources: readonly UnchangedImportSource[],
): void {
	for (const source of sources) {
		let content: string;
		try {
			content = readFileSync(source.filePath, 'utf-8');
		} catch {
			continue;
		}
		const lines = content.split('\n');
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] as string;
			const built = buildImportRow(
				line,
				syntheticImportEventId(line, source.generationOffset + index),
			);
			if (built !== null)
				takeImportProjectionCandidate(candidates, built.columns);
		}
	}
}

/**
 * When import wins the race, upgrade exactly one matching import row in place
 * when the canonical live event arrives. This preserves its row position while
 * replacing the synthetic identity and legacy-only payload with the canonical
 * fields. A canonical id collision is handled by deleting only the matched
 * import row; it cannot create a duplicate primary-key row.
 */
function reconcileImportedRow(
	db: ReturnType<typeof getProjectDb>,
	columns: BuiltRow['columns'],
): boolean {
	const projected = liveProjection(columns);
	// Normal live appends retain the indexed kind/time probe. Only an oversized
	// canonical row can have caller-overridden legacy kind/time, so only that
	// bounded quarantine path needs the marker scan across all import rows.
	const candidates =
		columns.quarantined === 1 &&
		columns.quarantine_reason === 'payload_oversize'
			? db
					.query<ProjectionCandidate, []>(
						`SELECT rowid, event_id, kind, occurred_at, quarantined, quarantine_reason, payload_json
						 FROM observability_event
						 WHERE ingested_via = 'import'
						 ORDER BY rowid ASC`,
					)
					.all()
			: db
					.query<ProjectionCandidate, [string, string]>(
						`SELECT rowid, event_id, kind, occurred_at, quarantined, quarantine_reason, payload_json
						 FROM observability_event
						 WHERE ingested_via = 'import'
						   AND kind = ?
						   AND occurred_at = ?
						 ORDER BY rowid ASC`,
					)
					.all(columns.kind, columns.occurred_at);
	const oversizedMarkerCandidates = candidates.filter(
		(row) =>
			row.quarantined === 1 &&
			row.quarantine_reason === 'import_payload_oversize' &&
			importIdentity(row) === columns.event_id,
	);
	const candidate =
		columns.quarantined === 1 &&
		columns.quarantine_reason === 'payload_oversize' &&
		oversizedMarkerCandidates.length === 1
			? oversizedMarkerCandidates[0]
			: (candidates.find(
					(row) =>
						row.kind === columns.kind &&
						row.occurred_at === columns.occurred_at &&
						importIdentity(row) === columns.event_id,
				) ??
				(projected === null
					? undefined
					: candidates.find((row) => {
							if (
								row.kind !== columns.kind ||
								row.occurred_at !== columns.occurred_at
							)
								return false;
							if (importProjectionDigest(row) !== projected.digest)
								return false;
							return identityCompatible(row, columns.event_id);
						})));
	if (candidate === undefined) return false;
	const existing = db
		.query<{ rowid: number }, [string]>(
			'SELECT rowid FROM observability_event WHERE event_id = ?',
		)
		.get(columns.event_id);
	if (existing !== undefined && existing !== null) {
		db.run('DELETE FROM observability_event WHERE rowid = ?', [
			candidate.rowid,
		]);
		return true;
	}
	db.run(
		`UPDATE observability_event SET
			event_id = ?, kind = ?, category = ?, severity = ?, occurred_at = ?,
			writer_sequence = ?, trace_id = ?, span_id = ?, host_session_id = ?,
			task_id = ?, lane_id = ?, batch_id = ?, phase_id = ?,
			council_round_id = ?, project_ref = ?, outcome_status = ?, retry_index = ?,
			privacy_class = ?, sampled = ?, payload_json = ?,
			relationship_violations = ?, quarantined = ?, quarantine_reason = ?,
			ingested_via = 'live'
		 WHERE rowid = ?`,
		[
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
			candidate.rowid,
		],
	);
	return true;
}

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
			if (!reconcileImportedRow(db, row.columns)) {
				insertRow(db, row.columns, 'live');
			}
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
	imported_at: string | null;
}

function syntheticImportEventId(
	line: string,
	occurrenceOrdinal: number,
): string {
	return createHash('sha256')
		.update(`${IMPORT_ID_NAMESPACE}\0${occurrenceOrdinal}\0${line}`)
		.digest('hex');
}

const IMPORT_PREFIX_MARKER = 'obs-import-prefix-v1:';

function contentPrefix(content: string, contentLineCount: number): string {
	if (contentLineCount <= 0) return '';
	let lineBreaks = 0;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) !== 10) continue;
		lineBreaks += 1;
		if (lineBreaks === contentLineCount) return content.slice(0, index + 1);
	}
	return content;
}

function contentPrefixMarker(
	content: string,
	contentLineCount: number,
): string {
	return `${IMPORT_PREFIX_MARKER}${createHash('sha256')
		.update(contentPrefix(content, contentLineCount))
		.digest('hex')}`;
}

function markerMatchesContent(
	marker: ImportMarker,
	content: string,
	contentLineCount: number,
): boolean {
	const expected = contentPrefixMarker(content, marker.lines_seen);
	return (
		marker.lines_seen <= contentLineCount &&
		(marker.imported_at === expected ||
			Boolean(marker.imported_at?.endsWith(`|${expected}`)))
	);
}

function importedAtMarker(content: string, contentLineCount: number): string {
	// Preserve the column's historical timestamp prefix while appending the
	// bounded prefix identity needed to distinguish append from rewrite.
	return `${new Date().toISOString()}|${contentPrefixMarker(content, contentLineCount)}`;
}

/** Stub row for a line that cannot (or should not) be parsed. */
function unparseableImportRow(
	line: string,
	reason: 'import_unparseable_line' | 'import_oversize_line',
	eventId: string,
): { columns: BuiltRow['columns']; quarantined: boolean } {
	return {
		columns: {
			event_id: eventId,
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
	syntheticEventId: string,
): { columns: BuiltRow['columns']; quarantined: boolean } | null {
	if (line.trim().length === 0) return null;
	// PRR-002: quarantine pathological lines WITHOUT parsing them.
	if (line.length > MAX_IMPORT_LINE_BYTES) {
		return unparseableImportRow(line, 'import_oversize_line', syntheticEventId);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return unparseableImportRow(
			line,
			'import_unparseable_line',
			syntheticEventId,
		);
	}
	const workflow = _internals.extractWorkflowIds(parsed);
	const timestamp =
		typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
	const kind =
		typeof parsed.event === 'string' && parsed.event.length > 0
			? parsed.event
			: 'unknown';
	const payloadJson = JSON.stringify(parsed);
	const provenanceIdentity = provenanceLegacyObservationId(parsed);
	const boundedPayloadJson =
		payloadJson.length > MAX_EVENT_PAYLOAD_BYTES && provenanceIdentity !== null
			? JSON.stringify({
					[LEGACY_OBSERVATION_ID_FIELD]: `${LEGACY_OBSERVATION_ID_PROVENANCE_PREFIX}${provenanceIdentity}`,
				})
			: payloadJson.length > MAX_EVENT_PAYLOAD_BYTES
				? '{"truncated":true}'
				: payloadJson;
	// Import rows never adopt a legacy payload field as their primary key — not
	// even a versioned provenance marker. The marker is only a reconciliation
	// hint for a matching live canonical row. This makes a bare caller collision
	// (or a manually forged marker) unable to trigger INSERT OR IGNORE data loss,
	// while a later live write upgrades the synthetic import row in place.
	const eventId = syntheticEventId;
	return {
		columns: {
			event_id: eventId,
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
			payload_json: boundedPayloadJson,
			relationship_violations: null,
			quarantined:
				timestamp === null || payloadJson.length > MAX_EVENT_PAYLOAD_BYTES
					? 1
					: 0,
			quarantine_reason:
				timestamp === null
					? 'import_missing_timestamp'
					: payloadJson.length > MAX_EVENT_PAYLOAD_BYTES
						? 'import_payload_oversize'
						: null,
		},
		quarantined:
			timestamp === null || payloadJson.length > MAX_EVENT_PAYLOAD_BYTES,
	};
}

/**
 * Incrementally import the bounded legacy `telemetry.jsonl(.1)` stream into
 * the query authority. Per-file markers record (size, mtime, lines_seen) plus
 * a hash of the previously consumed prefix, so a rewrite with the same line
 * count cannot be mistaken for append-only growth. Full rescans reuse existing
 * import rows one-to-one across rotation; synthetic ids cover new occurrences.
 * Runs only from the report path — never per emit, never at init. Files are
 * read oldest-generation first so rowid order tracks event order.
 */
export function syncObservabilityImport(
	directory: string,
): ObservabilityImportResult {
	flushPendingWrites(directory);
	const root = canonicalProjectKey(directory);
	const db = _internals.getProjectDb(directory);
	// Build both maps once for the complete rotated-file window. Rebuilding a
	// live map for each source lets the same canonical row be claimed twice when
	// identical occurrences are split between `.1` and the current file.
	const liveCandidates = loadLiveProjectionCandidates(db);
	const importCandidates = loadImportProjectionCandidates(db);
	let generationOffset = 0;
	const unchangedSources: UnchangedImportSource[] = [];
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
		const marker = db
			.query<ImportMarker | null, [string]>(
				'SELECT fingerprint_size, fingerprint_mtime_ms, lines_seen, imported_at FROM observability_import WHERE source = ?',
			)
			.get(fileName);
		if (
			marker !== null &&
			marker !== undefined &&
			marker.fingerprint_size === stats.size &&
			marker.fingerprint_mtime_ms === stats.mtimeMs
		) {
			unchangedSources.push({
				filePath,
				generationOffset,
			});
			generationOffset += marker.lines_seen;
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
			hasMarker &&
			markerMatchesContent(marker as ImportMarker, content, contentLineCount)
				? (marker as ImportMarker).lines_seen
				: 0;
		if (start === 0 && unchangedSources.length > 0) {
			reserveUnchangedImportCandidates(importCandidates, unchangedSources);
			unchangedSources.length = 0;
		}
		const rows: Array<{ columns: BuiltRow['columns']; quarantined: boolean }> =
			[];
		for (let i = start; i < lines.length; i++) {
			const line = lines[i] as string;
			const eventId = syntheticImportEventId(line, generationOffset + i);
			const built = buildImportRow(line, eventId);
			if (built === null) continue;
			rows.push(built);
		}
		const imported = rows.length;
		const quarantined = rows.filter((r) => r.quarantined).length;
		db.run('BEGIN IMMEDIATE');
		try {
			for (const row of rows) {
				// A live canonical row is authoritative. Consume one matching
				// candidate per legacy occurrence, preserving duplicate occurrences
				// instead of collapsing them by content alone.
				if (takeLiveProjectionCandidate(liveCandidates, row.columns) !== null)
					continue;
				// On a full rescan, an unchanged legacy occurrence may have moved
				// from the current file to `.1` (or vice versa). Reuse its existing
				// import row by projection and explicit identity, preserving the
				// original event id. Append-only deltas intentionally do not do this:
				// a new identical line is a distinct occurrence.
				if (
					start === 0 &&
					takeImportProjectionCandidate(importCandidates, row.columns) !== null
				)
					continue;
				insertRow(db, row.columns, 'import');
			}
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
					importedAtMarker(content, contentLineCount),
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
		generationOffset += contentLineCount;
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

/**
 * Opt-in bounded remote OTLP/OpenInference observability exporter
 * (issue #2485; source spec #2049; the deferred runtime consumer of the
 * pinned mapping tables in otel-mapping.ts).
 *
 * ## Shape
 *
 * - Registers as a TELEMETRY LISTENER — the same O(1) shape as the SQLite
 *   observability sink (`src/db/observability-event-store.ts`), never an
 *   `emit()` call site. The listener consumes the CANONICAL envelope passed
 *   as `emit()`'s third argument; privacy class is read from
 *   `canonical.policy.privacyClass`, never from the legacy payload.
 * - Disabled by default. With `observability.export.enabled !== true` (or
 *   the `SWARM_OTLP_EXPORT_DISABLE=1` kill switch, or an invalid endpoint)
 *   NOTHING is registered: no listener, no spool directory, no timers, no
 *   network. Local operation is fully independent of the exporter.
 * - The exporter NEVER calls `emit()` itself (#2049 obligation 5: exporter
 *   failure must not recursively emit through the failed path). All
 *   diagnostics live in exporter-owned health counters surfaced through
 *   `/swarm report`.
 *
 * ## Privacy (allowlist reapplied at this boundary, even for local records)
 *
 * - `policy.privacyClass === 'content'` events produce NO record at all.
 * - Exported span attributes come ONLY from the pinned mapping table for the
 *   configured convention (exact-key lookups into the envelope — never a
 *   deep traversal or serialization of `legacy.raw`, which is an untyped
 *   alias that may be circular) plus the closed `swarm.*` extension set
 *   below. The spool therefore never contains prompt/command/code/path/tool
 *   payload text: filtering happens BEFORE the append.
 * - `outcome.errorMessage`/`reason` are never mapped (no free text on the
 *   wire). Health records error CATEGORIES only — no message text, no
 *   endpoint, no header values.
 *
 * ## Bounded transport
 *
 * - Bounded batches (`batchSize` spans per POST), persistent spool with byte
 *   AND age budgets (drop-oldest with terminal reasons `spool_cap` /
 *   `spool_age`), capped exponential backoff + full jitter honoring 429
 *   `Retry-After`, and a cooldown circuit: after `circuitThreshold`
 *   consecutive failed flush cycles the circuit opens for
 *   `circuitCooldownMs` (records still spool; attempts stop), then admits
 *   exactly one recovery probe.
 *
 * Import rules: node:fs/node:path/telemetry bus only. No OTel SDK, no
 * subprocesses, no Bun-global references (AGENTS.md invariants 2 and 3).
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TelemetryListener } from '../telemetry.js';
import { addTelemetryListener, removeTelemetryListener } from '../telemetry.js';
import { getCatalogEntry } from './catalog.js';
import type { ObservabilityEvent } from './envelope.js';
import {
	OPENINFERENCE_ATTRIBUTES,
	OPENINFERENCE_MAPPING_VERSION,
	OTEL_GENAI_ATTRIBUTES,
	OTEL_GENAI_MAPPING_VERSION,
} from './otel-mapping.js';

/** Spool home, relative to the project root (retention-registry row `otlp-export-spool`). */
export const OTLP_EXPORT_SPOOL_DIR = '.swarm/otlp-export';
const SPOOL_FILE = 'spool.jsonl';
const STATE_FILE = 'state.json';
const SPOOL_RECORD_VERSION = 1;
const STATE_VERSION = 1;

/** Bounded iteration ceiling for one flush cycle (drain-all semantics). */
export const MAX_FLUSH_ITERATIONS = 100;
/** Longest attribute string value exported (model/provider names are short). */
const MAX_ATTRIBUTE_STRING = 128;
/** Hard cap on spool lines read per flush (read bound, independent of bytes). */
const MAX_SPOOL_LINES_PER_FLUSH = 2048;
/** Env kill switch: forces the exporter off even when config-enabled. */
const KILL_SWITCH_ENV = 'SWARM_OTLP_EXPORT_DISABLE';

export interface OtlpExportConfig {
	enabled: boolean;
	endpoint: string;
	convention: 'genai' | 'openinference';
	headers?: Record<string, string>;
	batchSize: number;
	flushIntervalMs: number;
	requestTimeoutMs: number;
	spoolMaxBytes: number;
	spoolMaxAgeMs: number;
	maxRetries: number;
	backoffBaseMs: number;
	backoffMaxMs: number;
	circuitThreshold: number;
	circuitCooldownMs: number;
}

export type OtlpExporterState = 'disabled' | 'active' | 'cooldown';

export interface OtlpExporterHealth {
	state: OtlpExporterState;
	convention: 'genai' | 'openinference' | null;
	mappingVersion: string | null;
	spoolRecords: number;
	spoolBytes: number;
	accepted: number;
	exported: number;
	retried: number;
	dropped: Record<string, number>;
	lastErrorCategory: string | null;
	lastErrorAt: string | null;
	lastSuccessAt: string | null;
	circuitOpen: boolean;
}

interface PersistedState {
	v: number;
	convention: 'genai' | 'openinference';
	accepted: number;
	exported: number;
	retried: number;
	dropped: Record<string, number>;
	lastErrorCategory: string | null;
	lastErrorAt: string | null;
	lastSuccessAt: string | null;
	consecutiveFailures: number;
	circuitOpenAt: number | null;
	nextAttemptAt: number;
}

interface SpoolRecord {
	v: number;
	id: string;
	t: number;
	r: unknown;
}

// ─── Adapter (pure projection) ─────────────────────────────────────────────

function toNanos(iso: string | undefined): string {
	const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(ms)) return '0';
	return String(BigInt(Math.floor(ms)) * 1_000_000n);
}

function readMappedPath(event: ObservabilityEvent, path: string): unknown {
	const raw = event.legacy?.raw;
	if (path.startsWith('legacy.raw.')) {
		const key = path.slice('legacy.raw.'.length);
		if (typeof raw !== 'object' || raw === null) return undefined;
		return (raw as Record<string, unknown>)[key];
	}
	if (path === 'kind') return event.kind;
	if (path.startsWith('provenance.')) {
		return (event.provenance as Record<string, unknown> | undefined)?.[
			path.slice('provenance.'.length)
		];
	}
	if (path.startsWith('workflow.')) {
		return (event.workflow as Record<string, unknown> | undefined)?.[
			path.slice('workflow.'.length)
		];
	}
	if (path === 'outcome.status') return event.outcome?.status;
	return undefined;
}

/**
 * Project a canonical event onto the pinned attribute table for `convention`
 * plus the closed `swarm.*` extension set. PURE: no I/O, no clock, no throw.
 * `legacy.raw` is read ONLY at the exact mapped keys with typeof guards —
 * never traversed or serialized (it may be circular; envelope.ts documents
 * the alias contract).
 */
export function projectOtlpAttributes(
	event: ObservabilityEvent,
	convention: 'genai' | 'openinference',
): Record<string, string | number | boolean> {
	// Content-class events carry no envelope-derived payload attributes either
	// (defense in depth: buildOtlpSpan drops the record entirely; a direct
	// projection caller must never see mapped payload values).
	if (event.policy?.privacyClass === 'content') {
		return {};
	}
	const attributes: Record<string, string | number | boolean> = {};
	const entry = getCatalogEntry(event.kind);
	const table =
		convention === 'openinference'
			? OPENINFERENCE_ATTRIBUTES
			: OTEL_GENAI_ATTRIBUTES;
	// The catalog's otelMapping records whether the kind has external
	// equivalents at all; the configured convention selects WHICH pinned
	// table projects (the tables share envelope paths by construction).
	if (entry !== undefined && entry.otelMapping !== 'none') {
		for (const [path, name] of Object.entries(table)) {
			const value = readMappedPath(event, path);
			if (typeof value === 'number' && Number.isFinite(value)) {
				attributes[name] = value;
			} else if (typeof value === 'boolean') {
				attributes[name] = value;
			} else if (typeof value === 'string' && value.length > 0) {
				attributes[name] = value.slice(0, MAX_ATTRIBUTE_STRING);
			}
		}
	}
	// Closed swarm.* extension set — the only non-mapped attributes allowed.
	attributes['swarm.event.kind'] = event.kind;
	if (event.category !== undefined)
		attributes['swarm.event.category'] = event.category;
	if (event.severity !== undefined)
		attributes['swarm.event.severity'] = event.severity;
	if (event.outcome?.status !== undefined) {
		attributes['swarm.outcome.status'] = event.outcome.status;
	}
	if (typeof event.outcome?.durationMs === 'number') {
		attributes['swarm.outcome.duration_ms'] = event.outcome.durationMs;
	}
	return attributes;
}

/**
 * Build one OTLP/HTTP-JSON span for the event, or `null` when the event must
 * not be exported at all (`content` privacy class).
 */
export function buildOtlpSpan(
	event: ObservabilityEvent,
	convention: 'genai' | 'openinference',
): Record<string, unknown> | null {
	// Privacy class is read from the CANONICAL envelope (emit()'s third
	// argument), never from the legacy payload.
	if (event.policy?.privacyClass === 'content') return null;
	return {
		traceId: event.trace?.traceId ?? '',
		spanId: event.trace?.spanId ?? '',
		name: event.kind,
		kind: 1, // INTERNAL
		startTimeUnixNano: toNanos(event.occurredAt),
		endTimeUnixNano: toNanos(event.observedAt),
		attributes: projectOtlpAttributes(event, convention),
	};
}

// ─── Module state ──────────────────────────────────────────────────────────

let _listener: TelemetryListener | null = null;
let _active = false;
let _config: OtlpExportConfig | null = null;
let _directory: string | null = null;
let _state: PersistedState | null = null;
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _inFlight: Promise<void> | null = null;

function spoolPath(directory: string): string {
	return join(directory, OTLP_EXPORT_SPOOL_DIR, SPOOL_FILE);
}
function statePath(directory: string): string {
	return join(directory, OTLP_EXPORT_SPOOL_DIR, STATE_FILE);
}

function emptyState(convention: 'genai' | 'openinference'): PersistedState {
	return {
		v: STATE_VERSION,
		convention,
		accepted: 0,
		exported: 0,
		retried: 0,
		dropped: {},
		lastErrorCategory: null,
		lastErrorAt: null,
		lastSuccessAt: null,
		consecutiveFailures: 0,
		circuitOpenAt: null,
		nextAttemptAt: 0,
	};
}

function noteDrop(reason: string): void {
	if (_state === null) return;
	_state.dropped[reason] = (_state.dropped[reason] ?? 0) + 1;
	_state.lastErrorCategory = reason;
	_state.lastErrorAt = new Date().toISOString();
}

/** Atomic tmp+rename write for spool/state files (Windows-safe). */
function atomicWrite(path: string, contents: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, contents, 'utf8');
	try {
		renameSync(tmp, path);
	} catch (err) {
		try {
			if (existsSync(tmp)) writeFileSync(path, contents, 'utf8');
		} catch {
			/* fail-open */
		}
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== undefined && code !== 'EPERM' && code !== 'EBUSY') throw err;
	}
}

function loadState(directory: string): PersistedState | null {
	try {
		const raw = readFileSync(statePath(directory), 'utf-8');
		const parsed = JSON.parse(raw) as PersistedState;
		if (parsed.v !== STATE_VERSION) return null;
		return parsed;
	} catch {
		return null;
	}
}

function persistState(): void {
	if (_directory === null || _state === null) return;
	try {
		mkdirSync(join(_directory, OTLP_EXPORT_SPOOL_DIR), { recursive: true });
		atomicWrite(statePath(_directory), JSON.stringify(_state));
	} catch {
		// fail-open: counters continue in memory
	}
}

function readSpoolLines(directory: string): string[] {
	try {
		const content = readFileSync(spoolPath(directory), 'utf-8');
		return content.split('\n').filter((l) => l.length > 0);
	} catch {
		return [];
	}
}

function writeSpoolLines(directory: string, lines: string[]): void {
	mkdirSync(join(directory, OTLP_EXPORT_SPOOL_DIR), { recursive: true });
	atomicWrite(
		spoolPath(directory),
		lines.length === 0 ? '' : `${lines.join('\n')}\n`,
	);
}

function spoolByteSize(lines: string[]): number {
	return lines.reduce((sum, l) => sum + Buffer.byteLength(l, 'utf8') + 1, 0);
}

/**
 * Append one privacy-filtered record. Byte budget enforced drop-oldest with
 * terminal reason `spool_cap`; age sweep (`spool_age`) runs on read paths.
 * The spool never contains raw payload text — `buildOtlpSpan` filtered it.
 */
function appendSpoolRecord(record: SpoolRecord): void {
	if (_directory === null || _config === null) return;
	const cfg = _config;
	const line = JSON.stringify(record);
	const lines = readSpoolLines(_directory);
	// Age sweep first: expired records free budget before cap-dropping.
	const now = record.t;
	const fresh = lines.filter((l) => {
		try {
			const parsed = JSON.parse(l) as SpoolRecord;
			if (now - parsed.t > cfg.spoolMaxAgeMs) {
				noteDrop('spool_age');
				return false;
			}
		} catch {
			noteDrop('spool_corrupt');
			return false;
		}
		return true;
	});
	fresh.push(line);
	while (fresh.length > 1 && spoolByteSize(fresh) > cfg.spoolMaxBytes) {
		const dropped = fresh.shift();
		if (dropped !== undefined) noteDrop('spool_cap');
	}
	writeSpoolLines(_directory, fresh);
}

// ─── Transport ─────────────────────────────────────────────────────────────

function endpointUrl(cfg: OtlpExportConfig): string | null {
	try {
		const url = new URL(cfg.endpoint);
		const isLoopback =
			url.hostname === 'localhost' ||
			url.hostname === '127.0.0.1' ||
			url.hostname === '::1';
		if (url.protocol !== 'https:' && !isLoopback) return null;
		return `${cfg.endpoint.replace(/\/+$/, '')}/v1/traces`;
	} catch {
		return null;
	}
}

function classifyStatus(
	status: number,
): 'rate_limited' | 'server_error' | 'rejected_permanent' {
	if (status === 429 || status === 408) return 'rate_limited';
	if (status >= 500) return 'server_error';
	return 'rejected_permanent';
}

function backoffMs(cfg: OtlpExportConfig, attempt: number): number {
	const exp = cfg.backoffBaseMs * 2 ** attempt;
	const jitter = Math.floor(Math.random() * Math.min(exp / 2, 1_000));
	return Math.min(exp + jitter, cfg.backoffMaxMs);
}

/** Minimal fetch shape used by the transport (Bun's fetch adds `preconnect`). */
export type OtlpFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

/** DI seam (repo convention): tests inject a stub collector fetch. */
export const _internals: {
	fetch: OtlpFetch;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
} = {
	fetch: (input, init) => fetch(input as RequestInfo, init),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
};

async function postBatch(
	cfg: OtlpExportConfig,
	url: string,
	batch: Array<Record<string, unknown>>,
): Promise<{
	ok: boolean;
	category: string | null;
	retryAfterMs: number | null;
}> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
	try {
		const body = JSON.stringify({
			resourceSpans: [
				{
					resource: {
						attributes: [
							{ key: 'service.name', value: { stringValue: 'opencode-swarm' } },
							{
								key: 'swarm.mapping.version',
								value: {
									stringValue:
										cfg.convention === 'openinference'
											? OPENINFERENCE_MAPPING_VERSION
											: OTEL_GENAI_MAPPING_VERSION,
								},
							},
							{
								key: 'swarm.schema.version',
								value: { intValue: 1 },
							},
						],
					},
					scopeSpans: [
						{
							scope: { name: 'opencode-swarm', version: 'opencode-swarm' },
							spans: batch,
						},
					],
				},
			],
		});
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			...(cfg.headers ?? {}),
		};
		const response = await _internals.fetch(url, {
			method: 'POST',
			headers,
			body,
			signal: controller.signal,
		});
		if (response.ok) {
			// partialSuccess is informational: the request was accepted, so the
			// batch is removed either way; rejections are counted, not re-sent
			// (the collector does not identify WHICH spans it rejected).
			try {
				const text = await response.text();
				if (text.includes('"partialSuccess"')) {
					const parsed = JSON.parse(text) as {
						partialSuccess?: { rejectedSpans?: number | string };
					};
					const rejected = Number(parsed.partialSuccess?.rejectedSpans ?? 0);
					if (rejected > 0) {
						if (_state !== null) {
							_state.dropped.partial_rejected =
								(_state.dropped.partial_rejected ?? 0) + rejected;
						}
					}
				}
			} catch {
				/* body optional */
			}
			return { ok: true, category: null, retryAfterMs: null };
		}
		const retryAfterRaw = response.headers.get('retry-after');
		let retryAfterMs: number | null = null;
		if (retryAfterRaw !== null) {
			const seconds = Number(retryAfterRaw);
			if (Number.isFinite(seconds)) {
				retryAfterMs = Math.min(seconds * 1000, cfg.backoffMaxMs);
			}
		}
		return {
			ok: false,
			category: classifyStatus(response.status),
			retryAfterMs,
		};
	} catch {
		// Network/DNS/timeout — transient. Category only; never the message.
		return { ok: false, category: 'unavailable', retryAfterMs: null };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One flush cycle: ship pending records in `batchSize` chunks until the
 * spool drains, a cycle fails terminally, the retry budget is exhausted, or
 * the bounded iteration ceiling is hit. The testing entry point
 * (`flushOtlpExporterForTesting`) calls this directly so checks never depend
 * on interval timers; the interval trigger calls it opportunistically.
 * Single-flight per process: overlapping calls await the same promise.
 */
async function runFlushCycle(): Promise<void> {
	if (_directory === null || _config === null || _state === null) return;
	const cfg = _config;
	const url = endpointUrl(cfg);
	if (url === null) return;
	const now = _internals.now();
	if (_state.circuitOpenAt !== null) {
		if (now < _state.circuitOpenAt + cfg.circuitCooldownMs) return;
		// Cooldown elapsed: admit exactly one recovery probe. The probe is
		// the normal first batch below; on success the circuit closes, on
		// failure it re-opens for another full cooldown.
	}
	if (now < _state.nextAttemptAt) return;
	for (let i = 0; i < MAX_FLUSH_ITERATIONS; i++) {
		const lines = readSpoolLines(_directory).slice(
			0,
			MAX_SPOOL_LINES_PER_FLUSH,
		);
		if (lines.length === 0) {
			persistState();
			return;
		}
		const batchLines = lines.slice(0, cfg.batchSize);
		const batch: Array<Record<string, unknown>> = [];
		for (const line of batchLines) {
			try {
				batch.push(JSON.parse(line).r as Record<string, unknown>);
			} catch {
				noteDrop('spool_corrupt');
			}
		}
		let shipped = false;
		for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
			if (attempt > 0) _state.retried += 1;
			const result = await postBatch(cfg, url, batch);
			if (result.ok) {
				shipped = true;
				break;
			}
			if (result.category === 'rejected_permanent') {
				for (let d = 0; d < batchLines.length; d++)
					noteDrop('rejected_permanent');
				shipped = true; // terminally dropped, not re-sent
				break;
			}
			const wait =
				result.retryAfterMs !== null
					? result.retryAfterMs
					: backoffMs(cfg, attempt);
			if (attempt < cfg.maxRetries) await _internals.sleep(wait);
		}
		if (!shipped) {
			// Transient failure exhausted the retry budget: keep the batch
			// spooled (restart replay), open/extend the circuit, back off.
			_state.consecutiveFailures += 1;
			if (_state.consecutiveFailures >= cfg.circuitThreshold) {
				_state.circuitOpenAt = _internals.now();
			}
			_state.nextAttemptAt = _internals.now() + backoffMs(cfg, cfg.maxRetries);
			noteDrop('flush_failed');
			persistState();
			return;
		}
		// Success (or terminal drop): remove the shipped lines and continue.
		_state.exported += batch.length;
		_state.consecutiveFailures = 0;
		_state.circuitOpenAt = null;
		_state.lastSuccessAt = new Date().toISOString();
		const remaining = readSpoolLines(_directory).slice(batchLines.length);
		writeSpoolLines(_directory, remaining);
	}
	persistState();
}

function flushSingleFlight(): Promise<void> {
	if (_inFlight === null) {
		_inFlight = runFlushCycle()
			.catch(() => {
				/* fail-open: never propagate into emit() or timers */
			})
			.finally(() => {
				_inFlight = null;
			});
	}
	return _inFlight;
}

/** Drain ALL pending batches now (bounded by MAX_FLUSH_ITERATIONS). */
export async function flushOtlpExporterForTesting(
	directory: string,
): Promise<void> {
	if (directory !== _directory) return;
	await flushSingleFlight();
}

// ─── Registration ──────────────────────────────────────────────────────────

function stopTimer(): void {
	if (_flushTimer !== null) {
		clearInterval(_flushTimer);
		_flushTimer = null;
	}
}

/**
 * Register the OTLP exporter for this project root. O(1), idempotent, never
 * throws — safe on the plugin init path (invariant 1); all real I/O happens
 * on the listener/flush paths, post-resolution. When disabled (default), the
 * kill switch is set, or the endpoint violates policy, NOTHING is registered
 * and no `.swarm/otlp-export/` directory is created.
 */
export function registerOtlpExporter(
	directory: string,
	config: OtlpExportConfig,
): void {
	try {
		if (_listener !== null) {
			try {
				removeTelemetryListener(_listener);
			} catch {
				/* not registered */
			}
			_listener = null;
		}
		stopTimer();
		_active = false;
		_config = null;
		_directory = null;
		_state = null;
		if (config.enabled !== true) return;
		if (process.env[KILL_SWITCH_ENV] === '1') return;
		if (endpointUrl(config) === null) return;
		_directory = directory;
		_config = config;
		_state = loadState(directory) ?? emptyState(config.convention);
		_state.convention = config.convention;
		_listener = (_event, _data, canonical?: ObservabilityEvent) => {
			// Fully guarded: a listener error must never propagate into
			// emit() (the bus also guards, but the exporter owns its failure).
			try {
				if (canonical === undefined) return;
				const span = buildOtlpSpan(canonical, config.convention);
				if (span === null) return; // content class: no record at all
				if (_state !== null) _state.accepted += 1;
				appendSpoolRecord({
					v: SPOOL_RECORD_VERSION,
					id: canonical.eventId,
					t: _internals.now(),
					r: span,
				});
			} catch {
				noteDrop('listener_error');
			}
		};
		addTelemetryListener(_listener);
		_active = true;
		_flushTimer = setInterval(() => {
			void flushSingleFlight();
		}, config.flushIntervalMs);
		if (typeof (_flushTimer as { unref?: () => void }).unref === 'function') {
			(_flushTimer as { unref: () => void }).unref();
		}
	} catch {
		// Registration must never throw on the init path.
		_active = false;
	}
}

export function isOtlpExporterActive(): boolean {
	return _active;
}

/**
 * Drop the listener and forget in-memory state. Records already appended to
 * the spool are ON DISK (appends are synchronous), so nothing in-flight is
 * lost; counters are persisted before clearing so health survives rebind.
 */
export function resetOtlpExporterForTesting(): void {
	persistState();
	if (_listener !== null) {
		try {
			removeTelemetryListener(_listener);
		} catch {
			/* not registered */
		}
	}
	_listener = null;
	stopTimer();
	_active = false;
	_config = null;
	_directory = null;
	_state = null;
}

/** Merged health for `/swarm report`. Null when the exporter never ran here. */
export function readOtlpExporterHealth(
	directory: string,
): OtlpExporterHealth | null {
	const persisted =
		_directory === directory && _state !== null ? _state : loadState(directory);
	if (persisted === null) return null;
	const cfg = _directory === directory ? _config : null;
	let spoolRecords = 0;
	let spoolBytes = 0;
	try {
		const st = statSync(spoolPath(directory));
		spoolBytes = st.size;
		spoolRecords = readSpoolLines(directory).length;
	} catch {
		/* no spool yet */
	}
	const circuitOpen =
		persisted.circuitOpenAt !== null &&
		_internals.now() <
			persisted.circuitOpenAt +
				(cfg?.circuitCooldownMs ??
					(persisted.convention === undefined ? 60_000 : 60_000));
	const activeHere = _active && _directory === directory;
	return {
		state: circuitOpen ? 'cooldown' : activeHere ? 'active' : 'disabled',
		convention: persisted.convention,
		mappingVersion:
			persisted.convention === 'openinference'
				? OPENINFERENCE_MAPPING_VERSION
				: OTEL_GENAI_MAPPING_VERSION,
		spoolRecords,
		spoolBytes,
		accepted: persisted.accepted,
		exported: persisted.exported,
		retried: persisted.retried,
		dropped: { ...persisted.dropped },
		lastErrorCategory: persisted.lastErrorCategory,
		lastErrorAt: persisted.lastErrorAt,
		lastSuccessAt: persisted.lastSuccessAt,
		circuitOpen,
	};
}

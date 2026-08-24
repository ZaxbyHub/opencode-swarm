/**
 * Telemetry recording and persistence for the Context Capsule feature.
 *
 * Records capsule telemetry data (token estimates, cache hit/miss counts,
 * stale summary counts) per delegation.
 *
 * ISSUE #2037 (Observability PR 09/23): this store was previously an unbounded
 * append-only JSONL (`.swarm/context-telemetry.jsonl`) full-read on every
 * summary. It is now a BOUNDED single-file store:
 *
 *   Line 1:  `ctx-telemetry-manifest` header carrying a size-bounded FOLDED
 *            aggregate (records compacted away) + health counters.
 *   Line 2+: raw `TelemetryEntry` JSONL — the RECENT retained window, bounded
 *            to CONTEXT_TELEMETRY_LIMITS.activeMaxBytes / activeMaxEntries.
 *
 * Lifetime totals = folded aggregate (header) + retained window (file). Because
 * every structural mutation (first write, compaction, cutover migration,
 * finalize) is a synchronous, atomic single-file rewrite (write tmp + atomic
 * rename), a reader sees either the old complete file or the new complete file
 * — there is no partial-apply state, so double-count and loss cannot arise from
 * a crash mid-mutation.
 *
 * Concurrency: in production the ONLY writer is the plugin's
 * `context-capsule-inject` hook, and every mutating function here is
 * synchronous, so within a single plugin process there is no interleaving at
 * all. A second plugin instance on the same project root is guarded by an
 * exclusive `.swarm/context-telemetry.lock` (`wx` create, stale-broken)
 * acquired for the compaction/cutover read→rewrite window. Cross-process
 * CONCURRENT WRITERS to this store are documented as unsupported (it is a
 * single-writer store). All disk failures are fail-open.
 *
 * All functions are synchronous for simplicity and reliability. The module
 * uses the `_internals` DI seam pattern so tests can override filesystem
 * operations without `mock.module` (which leaks across files in Bun's
 * shared test-runner process).
 *
 * State lives exclusively under `.swarm/` (Invariant 4). No `process.cwd()`
 * usage — every function accepts an explicit `directory` parameter.
 *
 * No `bun:` imports — this module is Node-ESM-loadable (Invariant 2).
 *
 * See issue #1104, FR-007, and issue #2037.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { telemetry } from '../telemetry.js';
import { warn } from '../utils/logger';

// ---------------------------------------------------------------------------
// Hard limits (issue #2037). Exported so tests can override small budgets via
// `_internals.limits` and restore in `afterEach`. Mirrors core telemetry's
// `rotateTelemetryIfNeeded(maxBytes)` parameter-precedent: ceilings are
// documented constants, not user config keys.
// ---------------------------------------------------------------------------

export interface ContextTelemetryLimits {
	/** Hard ceiling on the retained raw window (bytes). */
	activeMaxBytes: number;
	/** Hard ceiling on the retained raw window (entries). */
	activeMaxEntries: number;
	/** Raw retention age: records older than this are pruned from the raw
	 *  window (the folded aggregate is lifetime and unaffected by pruning). */
	ageMaxMs: number;
	/** Bounded work per legacy-migration / compaction pass (bytes folded). */
	compactMaxBytes: number;
	/** Hard documented read bound: getTelemetrySummary never reads more than
	 *  this, even when legacy history is arbitrarily large. Must satisfy
	 *  readMaxBytes >= activeMaxBytes + headerMaxBytes + 1 KiB slack. */
	readMaxBytes: number;
	/** Writes between throttled maintenance checks (mirrors core telemetry's
	 *  ROTATION_CHECK_INTERVAL). */
	checkInterval: number;
	/** Disk-pressure/failure warning cooldown. */
	warnCooldownMs: number;
	/** Upper bound for a serialized manifest header (single line). */
	headerMaxBytes: number;
}

export const CONTEXT_TELEMETRY_LIMITS: ContextTelemetryLimits = {
	activeMaxBytes: 256 * 1024,
	activeMaxEntries: 10_000,
	ageMaxMs: 30 * 24 * 60 * 60 * 1000,
	compactMaxBytes: 64 * 1024,
	readMaxBytes: 280 * 1024,
	checkInterval: 50,
	warnCooldownMs: 60_000,
	headerMaxBytes: 8 * 1024,
};

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

/**
 * Runtime validator for parsed JSONL lines (the TelemetryEntry shape). Ensures
 * all required fields are present and have the correct primitive types so that
 * aggregation never produces `NaN` (or `Infinity`) from undefined/non-finite
 * number fields. The manifest header line (`v`/`type`/...) fails this
 * validator, which is intended — the header is handled explicitly before
 * records are parsed.
 *
 * The on-disk file is UNTRUSTED (issue #2037): a manually edited or externally
 * written line could carry a non-finite number (`JSON.parse('1e309')` →
 * `Infinity`), so every numeric field is also required to be finite and
 * non-negative, matching the defensive `num()` guard used for the manifest
 * header. Such lines are treated as corrupt and never folded into the
 * aggregate.
 */
function isValidTelemetryEntry(value: unknown): value is TelemetryEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const nonNegFinite = (v: unknown): boolean =>
		typeof v === 'number' && Number.isFinite(v) && v >= 0;
	return (
		typeof obj.timestamp === 'string' &&
		typeof obj.task_id === 'string' &&
		typeof obj.agent_role === 'string' &&
		typeof obj.delegation_reason === 'string' &&
		nonNegFinite(obj.token_estimate) &&
		nonNegFinite(obj.cache_hits) &&
		nonNegFinite(obj.cache_misses) &&
		nonNegFinite(obj.stale_entries) &&
		nonNegFinite(obj.recommended_reads) &&
		nonNegFinite(obj.skipped_reads) &&
		typeof obj.success === 'boolean'
	);
}

// ---------------------------------------------------------------------------
// Read telemetry
// ---------------------------------------------------------------------------

/**
 * A single telemetry record for one capsule delegation.
 * Written as one JSON line to `.swarm/context-telemetry.jsonl`.
 */
export interface TelemetryEntry {
	/** ISO 8601 timestamp of when the telemetry was recorded */
	timestamp: string;
	/** Task ID the capsule was generated for (e.g. "1.1", "2.3") */
	task_id: string;
	/** Agent role that received the capsule */
	agent_role: string;
	/** Why the capsule was generated */
	delegation_reason: string;
	/** Estimated token count of the capsule content */
	token_estimate: number;
	/** Number of entries reused from the context map cache */
	cache_hits: number;
	/** Number of entries that required fresh computation */
	cache_misses: number;
	/** Number of stale entries detected during generation */
	stale_entries: number;
	/** Number of files the agent should read directly */
	recommended_reads: number;
	/** Number of files whose summaries were sufficient */
	skipped_reads: number;
	/** Whether capsule generation succeeded */
	success: boolean;
}

/**
 * Coverage disclosure for a computed summary (issue #2037). `'partial-unmigrated'`
 * is produced whenever the on-disk store exceeds the read bound (a pre-cutover
 * header-less file, or a header'd store mid-migration with an unmigrated legacy
 * tail) — in both cases the totals are INCOMPLETE. `'truncated'` is reserved for
 * the physical "read exceeded the bound" state but is never surfaced to callers:
 * a truncated header'd read is re-labeled `'partial-unmigrated'`.
 */
export type TelemetryCoverage =
	| 'complete'
	| 'partial-unmigrated'
	| 'truncated'
	| 'empty';

/**
 * Aggregate statistics computed from all telemetry entries.
 * Returned by {@link getTelemetrySummary}. The eight leading fields preserve the
 * pre-issue-#2037 public surface (semantically compatible); the trailing fields
 * are additive issue-#2037 disclosure (partial coverage / drops / retention).
 */
export interface TelemetrySummary {
	/** Total number of capsule delegations recorded (lifetime) */
	total_delegations: number;
	/** Sum of all cache hits across entries */
	total_cache_hits: number;
	/** Sum of all cache misses across entries */
	total_cache_misses: number;
	/** Sum of all stale entries detected across entries */
	total_stale_entries: number;
	/** Average estimated token count across entries */
	avg_token_estimate: number;
	/** Sum of all recommended reads across entries */
	total_recommended_reads: number;
	/** Sum of all skipped reads across entries */
	total_skipped_reads: number;
	/** Percentage of successful capsule generations (0–100) */
	success_rate: number;
	/** Coverage disclosure (issue #2037). 'complete' = full lifetime history
	 *  accounted; 'partial-unmigrated' = the on-disk store exceeds the read bound
	 *  (legacy history not yet fully migrated) so only the accounted part is
	 *  reflected — never presented as a complete-looking number. */
	coverage: TelemetryCoverage;
	/** Newest - oldest timestamp across all accounted records (ms, or null when
	 *  there is no accounted history). */
	tracked_period_ms: number | null;
	/** Records currently retained in the on-disk raw window. */
	retained_entries: number;
	/** Records folded into the durable aggregate. */
	folded_entries: number;
	/** Corrupt/partial lines encountered (maintenance + current window). */
	corrupt_entries: number;
	/** Records folded into the aggregate due to age retention — included in
	 *  lifetime totals (not an additive counter on top of them), just not
	 *  retained in the raw window. */
	dropped_entries: number;
	/** Approximate on-disk bytes of the store. */
	on_disk_bytes: number;
}

// ---------------------------------------------------------------------------
// DI seam — tests override these functions without touching real modules
// ---------------------------------------------------------------------------

/**
 * Test-only dependency-injection seam. Production code calls through this
 * object so tests can replace the underlying implementations without
 * `mock.module` (which leaks across files in Bun's shared test-runner process).
 * Mutating this local object is file-scoped and trivially restorable
 * via `afterEach`. `limits` is also overridable so tests can exercise small
 * budgets.
 */
export const _internals = {
	appendFileSync: fs.appendFileSync,
	readFileSync: fs.readFileSync,
	existsSync: fs.existsSync,
	mkdirSync: fs.mkdirSync,
	statSync: fs.statSync,
	renameSync: fs.renameSync,
	writeFileSync: fs.writeFileSync,
	unlinkSync: fs.unlinkSync,
	openSync: fs.openSync,
	closeSync: fs.closeSync,
	readSync: fs.readSync,
	limits: CONTEXT_TELEMETRY_LIMITS,
	emitHealth: emitContextTelemetryHealth,
	// Exposed for the withStoreLock regression tests (held / stale-break /
	// release paths, issue #2037 review F-5) — production callers use the
	// module-local binding, so this alias is test-observability only.
	withStoreLock,
} as const;

// ---------------------------------------------------------------------------
// Telemetry file paths
// ---------------------------------------------------------------------------

function telemetryFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'context-telemetry.jsonl');
}

function lockFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'context-telemetry.lock');
}

function tmpFilePath(directory: string): string {
	// PID-scoped so concurrent processes never collide on one temp name.
	return path.join(
		directory,
		'.swarm',
		`.context-telemetry.jsonl.${process.pid}.tmp`,
	);
}

// ---------------------------------------------------------------------------
// Manifest (header) shape
// ---------------------------------------------------------------------------

const MANIFEST_TYPE = 'ctx-telemetry-manifest';
const MANIFEST_SCHEMA = 2;

/** Size-bounded folded aggregate persisted in the manifest header. FOLDED-ONLY:
 *  records compacted/cut away from the raw window. Retained records are NOT in
 *  here. Lifetime total = folded + retained. */
export interface FoldedAggregate {
	delegations: number;
	successCount: number;
	cacheHits: number;
	cacheMisses: number;
	staleEntries: number;
	tokenSum: number;
	recommendedReads: number;
	skippedReads: number;
	corrupt: number;
	dropped: number;
	oldestTimestamp: string | null;
	newestTimestamp: string | null;
}

/** The manifest header — line 1 of `.swarm/context-telemetry.jsonl`. */
export interface TelemetryManifest {
	v: 2;
	type: 'ctx-telemetry-manifest';
	schemaVersion: number;
	folded: FoldedAggregate;
	updatedAt: string;
}

function emptyFolded(): FoldedAggregate {
	return {
		delegations: 0,
		successCount: 0,
		cacheHits: 0,
		cacheMisses: 0,
		staleEntries: 0,
		tokenSum: 0,
		recommendedReads: 0,
		skippedReads: 0,
		corrupt: 0,
		dropped: 0,
		oldestTimestamp: null,
		newestTimestamp: null,
	};
}

function emptyManifest(): TelemetryManifest {
	return {
		v: 2,
		type: MANIFEST_TYPE,
		schemaVersion: MANIFEST_SCHEMA,
		folded: emptyFolded(),
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Header detection rule (issue #2037): "header present" iff line 1 parses to a
 * JSON object with `type === 'ctx-telemetry-manifest'` and `schemaVersion === 2`.
 * A legacy `TelemetryEntry` line can never satisfy this (it has no `type`).
 */
function parseManifestLine(line: string): TelemetryManifest | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const obj: unknown = JSON.parse(trimmed);
		if (typeof obj !== 'object' || obj === null) return null;
		const rec = obj as Record<string, unknown>;
		if (
			rec.type !== MANIFEST_TYPE ||
			rec.v !== 2 ||
			rec.schemaVersion !== MANIFEST_SCHEMA ||
			typeof rec.folded !== 'object' ||
			rec.folded === null
		) {
			return null;
		}
		// Coerce/guard folded counters defensively (never let malformed header
		// values produce NaN).
		const f = rec.folded as Record<string, unknown>;
		const manifest: TelemetryManifest = emptyManifest();
		const num = (v: unknown): number =>
			typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
		manifest.folded.delegations = num(f.delegations);
		manifest.folded.successCount = num(f.successCount);
		manifest.folded.cacheHits = num(f.cacheHits);
		manifest.folded.cacheMisses = num(f.cacheMisses);
		manifest.folded.staleEntries = num(f.staleEntries);
		manifest.folded.tokenSum = num(f.tokenSum);
		manifest.folded.recommendedReads = num(f.recommendedReads);
		manifest.folded.skippedReads = num(f.skippedReads);
		manifest.folded.corrupt = num(f.corrupt);
		manifest.folded.dropped = num(f.dropped);
		if (typeof f.oldestTimestamp === 'string') {
			manifest.folded.oldestTimestamp = f.oldestTimestamp;
		}
		if (typeof f.newestTimestamp === 'string') {
			manifest.folded.newestTimestamp = f.newestTimestamp;
		}
		manifest.updatedAt =
			typeof rec.updatedAt === 'string'
				? rec.updatedAt
				: new Date().toISOString();
		return manifest;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Bounded read helpers
// ---------------------------------------------------------------------------

/**
 * Read at most `maxBytes` of a file starting at offset 0. Guarantees the read
 * never exceeds `maxBytes` regardless of how large the file is (issue #2037:
 * "read path never reads more than its documented bound even when legacy
 * history is arbitrarily large"). If the source is larger, `truncated` is true.
 */
function readBoundedChunk(
	filePath: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	try {
		if (!_internals.existsSync(filePath)) {
			return { text: '', truncated: false };
		}
		const fd = _internals.openSync(filePath, 'r');
		try {
			const size = _internals.statSync(filePath).size;
			const truncated = size > maxBytes;
			const len = Math.min(size, maxBytes);
			const buf = Buffer.alloc(len);
			let read = 0;
			while (read < len) {
				const n = _internals.readSync(fd, buf, read, len - read, read);
				if (n <= 0) break;
				read += n;
			}
			return { text: buf.toString('utf-8', 0, read), truncated };
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		// Fail-open: never break the caller on a transient I/O error (EIO,
		// EBUSY on Windows AV, permissions). Emit a debug-gated ops signal
		// so a silent empty read isn't mistaken for "no data yet" (issue
		// #2037). `warnThrottled` is debug-gated, so this is not chat noise.
		warnThrottled('bounded read failed (transient I/O)');
		return { text: '', truncated: false };
	}
}

function fileSizeOrZero(filePath: string): number {
	try {
		if (!_internals.existsSync(filePath)) return 0;
		return _internals.statSync(filePath).size;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// In-memory fold helpers
// ---------------------------------------------------------------------------

function foldEntryInto(agg: FoldedAggregate, entry: TelemetryEntry): void {
	agg.delegations += 1;
	if (entry.success) agg.successCount += 1;
	agg.cacheHits += entry.cache_hits;
	agg.cacheMisses += entry.cache_misses;
	agg.staleEntries += entry.stale_entries;
	agg.tokenSum += entry.token_estimate;
	agg.recommendedReads += entry.recommended_reads;
	agg.skippedReads += entry.skipped_reads;
	if (agg.oldestTimestamp === null || entry.timestamp < agg.oldestTimestamp) {
		agg.oldestTimestamp = entry.timestamp;
	}
	if (agg.newestTimestamp === null || entry.timestamp > agg.newestTimestamp) {
		agg.newestTimestamp = entry.timestamp;
	}
}

function cloneFolded(agg: FoldedAggregate): FoldedAggregate {
	return {
		delegations: agg.delegations,
		successCount: agg.successCount,
		cacheHits: agg.cacheHits,
		cacheMisses: agg.cacheMisses,
		staleEntries: agg.staleEntries,
		tokenSum: agg.tokenSum,
		recommendedReads: agg.recommendedReads,
		skippedReads: agg.skippedReads,
		corrupt: agg.corrupt,
		dropped: agg.dropped,
		oldestTimestamp: agg.oldestTimestamp,
		newestTimestamp: agg.newestTimestamp,
	};
}

// ---------------------------------------------------------------------------
// Atomic single-file publish
// ---------------------------------------------------------------------------

/**
 * Atomically replace the canonical file with a new text payload (write tmp +
 * rename). Within a single process all callers are synchronous; the rename is
 * atomic on POSIX and Windows-wrapped by Node. Best-effort stale-tmp cleanup.
 */
function atomicReplace(directory: string, content: string): void {
	const finalPath = telemetryFilePath(directory);
	const tmpPath = tmpFilePath(directory);
	try {
		if (_internals.existsSync(tmpPath)) {
			try {
				_internals.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		_internals.writeFileSync(tmpPath, content, 'utf-8');
		_internals.renameSync(tmpPath, finalPath);
	} catch {
		try {
			if (_internals.existsSync(tmpPath)) {
				_internals.unlinkSync(tmpPath);
			}
		} catch {
			/* ignore */
		}
		throw new Error('context-telemetry atomic replace failed');
	}
}

// ---------------------------------------------------------------------------
// Lock — guards compaction/cutover against a second plugin instance
// ---------------------------------------------------------------------------

function withStoreLock<T>(directory: string, fn: () => T): T | null {
	const lockPath = lockFilePath(directory);
	let acquired = false;
	try {
		_internals.mkdirSync(path.dirname(lockPath), { recursive: true });
		const fd = _internals.openSync(lockPath, 'wx');
		_internals.closeSync(fd);
		acquired = true;
	} catch {
		// Lock held (EEXIST) — stale-break if it is ancient.
		try {
			const age = Date.now() - _internals.statSync(lockPath).mtimeMs;
			if (age > 5 * 60_000) {
				try {
					_internals.unlinkSync(lockPath);
				} catch {
					/* ignore */
				}
				try {
					const fd = _internals.openSync(lockPath, 'wx');
					_internals.closeSync(fd);
					acquired = true;
				} catch {
					acquired = false;
				}
			}
		} catch {
			acquired = false;
		}
	}
	if (!acquired) return null;
	try {
		return fn();
	} finally {
		try {
			_internals.unlinkSync(lockPath);
		} catch {
			/* ignore */
		}
	}
}

// ---------------------------------------------------------------------------
// Maintenance state
// ---------------------------------------------------------------------------

let _recordCount = 0;
let _lastWarnAt = 0;

/**
 * Test seam (AGENTS.md invariant 7): resets the module-scoped maintenance
 * counters so an unswept run in Bun's shared test-runner process cannot shift
 * a later test's first maintenance pass. Restore is one call, always in
 * `afterEach`.
 */
export function _resetMaintenanceCounters(): void {
	_recordCount = 0;
	_lastWarnAt = 0;
}

function shouldRunMaintenance(): boolean {
	_recordCount += 1;
	if (_recordCount >= _internals.limits.checkInterval) {
		_recordCount = 0;
		return true;
	}
	return false;
}

function warnThrottled(message: string): void {
	const now = Date.now();
	if (now - _lastWarnAt < _internals.limits.warnCooldownMs) return;
	_lastWarnAt = now;
	// Debug-gated logger (AGENTS.md invariant 10: no chat-visible noise).
	warn(`context-telemetry: ${message}`);
}

// ---------------------------------------------------------------------------
// Read the store into { manifest, records, corrupt }.
// `bounded` reads at most readMaxBytes (for the public/read path); `unbounded`
// reads the whole file in the (bounded) raw-window case for compaction.
// `truncated` is set when the file exceeds the read bound.
// ---------------------------------------------------------------------------

interface StoreView {
	manifest: TelemetryManifest | null;
	records: TelemetryEntry[];
	corruptLines: number;
	truncated: boolean;
}

function readStore(directory: string, bounded: boolean): StoreView {
	const filePath = telemetryFilePath(directory);
	if (!_internals.existsSync(filePath)) {
		return { manifest: null, records: [], corruptLines: 0, truncated: false };
	}
	let text: string;
	let truncated = false;
	if (bounded) {
		const chunk = readBoundedChunk(filePath, _internals.limits.readMaxBytes);
		text = chunk.text;
		truncated = chunk.truncated;
	} else {
		try {
			text = _internals.readFileSync(filePath, 'utf-8');
		} catch {
			return { manifest: null, records: [], corruptLines: 0, truncated: false };
		}
	}

	const lines = text.split('\n');
	const records: TelemetryEntry[] = [];
	let corruptLines = 0;
	let manifest: TelemetryManifest | null = null;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i]!;
		if (line.trim() === '') continue;
		if (i === 0) {
			manifest = parseManifestLine(line);
			// If line 1 was a manifest, skip it and continue to records.
			if (manifest) continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isValidTelemetryEntry(parsed)) {
				records.push(parsed);
			} else {
				corruptLines += 1;
			}
		} catch {
			// Torn/partial line (e.g. split by the bounded read boundary or a
			// crash) — optional diagnostic only; disclosed via corrupt count.
			corruptLines += 1;
		}
	}
	return { manifest, records, corruptLines, truncated };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a telemetry entry to `.swarm/context-telemetry.jsonl`.
 *
 * Creates the `.swarm/` directory if it does not exist. The entry is
 * serialized as a single JSON line and appended to the retained raw window,
 * which is kept within {@link ContextTelemetryLimits}. Throttled maintenance
 * (compaction / bounded legacy cutover) runs every `checkInterval` writes.
 *
 * Returns `true` on success, `false` on any error. Never throws. Disk-pressure
 * and read/write failures are fail-open (the context-map hook is never broken).
 *
 * @param entry - The telemetry record to append
 * @param directory - Project root directory (must contain `.swarm/`)
 */
/**
 * True when the store file's final byte is a newline (or the file is empty /
 * unreadable — fail-open "true" so a transient read error never inserts a
 * spurious blank line; the parser skips blank lines anyway). Guards the append
 * path against appending onto a crash-torn final line (issue #2037 review F-4):
 * without it, a mid-append crash leaves an unterminated line and the NEXT
 * append silently merges into it, losing one record despite a `true` return.
 */
function fileEndsWithNewline(filePath: string): boolean {
	try {
		if (!_internals.existsSync(filePath)) return true;
		const size = _internals.statSync(filePath).size;
		if (size === 0) return true;
		const fd = _internals.openSync(filePath, 'r');
		try {
			const buf = Buffer.alloc(1);
			const n = _internals.readSync(fd, buf, 0, 1, size - 1);
			return n <= 0 || buf[0] === 0x0a;
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		return true;
	}
}

export function recordTelemetry(
	entry: TelemetryEntry,
	directory: string,
): boolean {
	const filePath = telemetryFilePath(directory);
	const swarmDir = path.join(directory, '.swarm');

	try {
		_internals.mkdirSync(swarmDir, { recursive: true });
		// All writes hold the store lock (issue #2037 review F-2): an append
		// racing a concurrent compaction rewrite in another process could be
		// silently discarded while recordTelemetry still returned true. The
		// lock is NOT reentrant, so throttled maintenance runs only after it
		// releases below.
		const wrote = withStoreLock(directory, () => {
			if (!_internals.existsSync(filePath)) {
				// First write is atomic (header + one record) so a crash can never
				// leave a torn header at line 1.
				const manifest = emptyManifest();
				atomicReplace(
					directory,
					`${JSON.stringify(manifest)}\n${JSON.stringify(entry)}\n`,
				);
			} else {
				// Re-establish line framing if a prior crash tore the tail (F-4).
				const prefix = fileEndsWithNewline(filePath) ? '' : '\n';
				_internals.appendFileSync(
					filePath,
					`${prefix}${JSON.stringify(entry)}\n`,
					'utf-8',
				);
			}
			return true;
		});
		if (wrote === null) {
			// Lock held by a concurrent maintenance/close pass in another
			// process: the write did NOT happen — report honestly instead of
			// a false success. Contention is rare and bounded (maintenance
			// passes are fast); the next write succeeds.
			warnThrottled('store lock busy — telemetry write skipped');
			return false;
		}
		if (shouldRunMaintenance()) {
			runMaintenance(directory);
		}
		return true;
	} catch {
		warnThrottled('append failed (disk pressure / permissions)');
		return false;
	}
}

/**
 * Read the telemetry entries currently retained in `.swarm/context-telemetry.jsonl`.
 *
 * ISSUE #2037: this now returns ONLY the bounded recent window (the retained
 * records after the manifest header) — NOT the entire lifetime history. Full
 * lifetime history is represented by {@link getTelemetrySummary}, which folds
 * the durable aggregate + retained window. This bounded read is the intended
 * contract change: no whole-history file read on any command/runtime path.
 *
 * Malformed/partial lines are skipped. Returns an empty array if the file does
 * not exist or cannot be parsed. Never throws.
 *
 * @param directory - Project root directory
 * @returns Array of parsed telemetry entries in the retained window
 */
export function readTelemetry(directory: string): TelemetryEntry[] {
	const view = readStore(directory, true);
	// Legacy (header-less) files are unsupported by the bounded retained read;
	// callers should use getTelemetrySummary, which handles legacy folding.
	return view.records;
}

/**
 * Compute aggregate statistics from all telemetry entries (lifetime).
 *
 * Lifetime totals = folded aggregate (durable header) + current retained
 * window. This is a PURE READ: it never writes. Reads are always bounded to
 * {@link ContextTelemetryLimits.readMaxBytes}; if a legacy (pre-issue-#2037)
 * header-less file is larger than the read bound, only part of it is folded
 * in-memory and {@link TelemetrySummary.coverage} is disclosed as
 * 'partial-unmigrated' rather than silently presenting a complete-looking
 * number. Returns a zeroed summary if no entries exist or on error. Never
 * throws.
 *
 * @param directory - Project root directory
 * @returns Aggregate telemetry summary
 */
export function getTelemetrySummary(directory: string): TelemetrySummary {
	const filePath = telemetryFilePath(directory);
	const zero = (): TelemetrySummary => ({
		total_delegations: 0,
		total_cache_hits: 0,
		total_cache_misses: 0,
		total_stale_entries: 0,
		avg_token_estimate: 0,
		total_recommended_reads: 0,
		total_skipped_reads: 0,
		success_rate: 0,
		coverage: 'empty',
		tracked_period_ms: null,
		retained_entries: 0,
		folded_entries: 0,
		corrupt_entries: 0,
		dropped_entries: 0,
		on_disk_bytes: 0,
	});

	const view = readStore(directory, true);
	const onDiskBytes = fileSizeOrZero(filePath);
	const corrupt = view.corruptLines;

	if (view.manifest === null) {
		// Legacy header-less file (or no file). Fold the bounded read in-memory.
		const folded = emptyFolded();
		for (const rec of view.records) foldEntryInto(folded, rec);
		const total = folded.delegations;
		// Disclose corrupt lines even when every legacy line is corrupt (total 0).
		if (total === 0 && corrupt === 0 && view.records.length === 0) {
			return zero();
		}
		const coverage: TelemetryCoverage = view.truncated
			? 'partial-unmigrated'
			: 'complete';
		return {
			total_delegations: total,
			total_cache_hits: folded.cacheHits,
			total_cache_misses: folded.cacheMisses,
			total_stale_entries: folded.staleEntries,
			avg_token_estimate: total > 0 ? Math.round(folded.tokenSum / total) : 0,
			total_recommended_reads: folded.recommendedReads,
			total_skipped_reads: folded.skippedReads,
			success_rate:
				total > 0 ? Math.round((folded.successCount / total) * 100) : 0,
			coverage,
			tracked_period_ms: periodMs(
				folded.oldestTimestamp,
				folded.newestTimestamp,
			),
			retained_entries: view.records.length,
			folded_entries: 0,
			corrupt_entries: corrupt,
			dropped_entries: 0,
			on_disk_bytes: onDiskBytes,
		};
	}

	// Header present (current format).
	const agg = cloneFolded(view.manifest.folded);
	for (const rec of view.records) foldEntryInto(agg, rec);
	const total = agg.delegations;
	// Mirror the legacy branch's corrupt check: a valid header with zero
	// delegations but a corrupt-only raw window must still disclose the corrupt
	// count rather than a fully-zeroed (corrupt_entries: 0) summary (issue
	// #2037).
	if (total === 0 && view.records.length === 0 && corrupt === 0) {
		return zero();
	}
	// Header present. A header'd store can exceed the read bound only while a
	// legacy tail is still draining (a fully drained store is always well under
	// readMaxBytes), so a truncated header'd read means the totals are
	// INCOMPLETE — disclose it as 'partial-unmigrated', never as a
	// complete-looking number (issue #2037).
	const coverage: TelemetryCoverage = view.truncated
		? 'partial-unmigrated'
		: 'complete';
	return {
		total_delegations: total,
		total_cache_hits: agg.cacheHits,
		total_cache_misses: agg.cacheMisses,
		total_stale_entries: agg.staleEntries,
		avg_token_estimate: total > 0 ? Math.round(agg.tokenSum / total) : 0,
		total_recommended_reads: agg.recommendedReads,
		total_skipped_reads: agg.skippedReads,
		success_rate: total > 0 ? Math.round((agg.successCount / total) * 100) : 0,
		coverage,
		tracked_period_ms: periodMs(agg.oldestTimestamp, agg.newestTimestamp),
		retained_entries: view.records.length,
		folded_entries: view.manifest.folded.delegations,
		corrupt_entries: corrupt + view.manifest.folded.corrupt,
		dropped_entries: view.manifest.folded.dropped,
		on_disk_bytes: onDiskBytes,
	};
}

function periodMs(oldest: string | null, newest: string | null): number | null {
	if (oldest === null || newest === null) return null;
	const o = Date.parse(oldest);
	const n = Date.parse(newest);
	if (Number.isNaN(o) || Number.isNaN(n)) return null;
	return Math.max(0, n - o);
}

// ---------------------------------------------------------------------------
// Maintenance — compaction + bounded legacy cutover (single synchronous pass)
// ---------------------------------------------------------------------------

/**
 * Bounded compaction: fold records REMOVED from the raw window (age-pruned and
 * budget-pruned) into the folded aggregate, retain only the newest records that
 * fit the active budget, and atomically rewrite the file.
 *
 * INVARIANT (no double-count): the retained raw window and the folded aggregate
 * are disjoint — a record lives in exactly one of them at any time. `folded`
 * holds every record ever removed from the window (hence lifetime totals =
 * folded + retained). We fold (and remove) only the records that do NOT fit the
 * retained budget; the newest budget-sized subset stays in `retained` and is
 * NOT folded here.
 *
 * Idempotent: given the same file it produces the same output. Guarded by the
 * store lock against a second plugin instance. Bounded work: input is the
 * retained window (<= activeMaxBytes). Never throws to callers.
 */
function compactStore(
	directory: string,
	trigger: 'compaction' | 'close' = 'compaction',
	alreadyLocked = false,
): void {
	const filePath = telemetryFilePath(directory);
	if (!_internals.existsSync(filePath)) return;

	const run = () => {
		const view = readStore(directory, false);
		if (view.manifest === null) return; // legacy handled by cutover
		const folded = cloneFolded(view.manifest.folded);
		const now = Date.now();

		// Partition the raw window.
		const agePruned: TelemetryEntry[] = [];
		const kept: TelemetryEntry[] = [];
		for (const rec of view.records) {
			const ts = Date.parse(rec.timestamp);
			if (!Number.isNaN(ts) && now - ts > _internals.limits.ageMaxMs) {
				agePruned.push(rec);
			} else {
				kept.push(rec);
			}
		}

		// Retain the NEWEST kept records that fit the budgets; the OLDER kept
		// records that don't fit are compacted (folded) away.
		const retained: TelemetryEntry[] = [];
		let bytes = 0;
		for (let i = kept.length - 1; i >= 0; i -= 1) {
			const rec = kept[i]!;
			const lineBytes = Buffer.byteLength(JSON.stringify(rec)) + 1;
			if (
				retained.length >= _internals.limits.activeMaxEntries ||
				bytes + lineBytes > _internals.limits.activeMaxBytes
			) {
				break;
			}
			retained.push(rec);
			bytes += lineBytes;
		}
		retained.reverse();

		// Compact the age-pruned (counted as dropped) + budget-pruned (compacted)
		// records into the aggregate. Retained records are NOT folded.
		for (const rec of agePruned) foldEntryInto(folded, rec);
		folded.dropped += agePruned.length;
		const retainedSet = new Set(retained);
		const compacted: TelemetryEntry[] = [];
		const keptSet = new Set(kept);
		for (const rec of view.records) {
			if (keptSet.has(rec) && !retainedSet.has(rec)) {
				compacted.push(rec);
			}
		}
		for (const rec of compacted) foldEntryInto(folded, rec);
		// Durable corrupt: fold any current-window corrupt lines into the
		// aggregate count and drop them from the rewritten file, so the lifetime
		// corrupt figure never regresses after a compaction (issue #2037).
		folded.corrupt += view.corruptLines;

		const manifest: TelemetryManifest = {
			...emptyManifest(),
			folded,
			updatedAt: new Date().toISOString(),
		};
		const lines = [`${JSON.stringify(manifest)}`];
		for (const rec of retained) lines.push(JSON.stringify(rec));
		atomicReplace(
			directory,
			lines.length > 1 ? `${lines.join('\n')}\n` : `${lines[0]}\n`,
		);

		emitHealth(directory, {
			trigger,
			accepted: folded.delegations + retained.length,
			compacted: compacted.length,
			retained: retained.length,
			dropped: agePruned.length,
			corrupt: folded.corrupt,
			oldest: folded.oldestTimestamp,
			newest: folded.newestTimestamp,
			bytes: fileSizeOrZero(filePath),
			limitBytes: _internals.limits.activeMaxBytes,
		});
	};
	if (alreadyLocked) {
		run();
		return;
	}
	withStoreLock(directory, run);
}

/**
 * Bounded-pass legacy cutover / drain (issue #2037, plan v3: "migrates
 * incrementally in bounded passes"). This is a WRITE-path operation
 * (recordTelemetry throttled + finalize) and never runs on a read or on plugin
 * initialization.
 *
 * Each pass folds at most CONTEXT_TELEMETRY_LIMITS.compactMaxBytes of the OLDEST
 * records that do not fit the retained budget into the folded aggregate, and
 * atomically rewrites `header + remaining-window`. Later maintenance passes
 * continue from the new state (`runMaintenance` routes a header'd-but-over-budget
 * store back here) until the window is within budget, at which point
 * `compactStore` performs the final bounded fold.
 *
 * Honest work model: what is BOUNDED per pass is the number of records folded
 * (the dominant steady-state CPU cost of compressing history). The one-time
 * legacy read + atomic rewrite of the remaining window still scales with the
 * current store size and is amortized across passes — the single-file
 * atomic-rewrite architecture (which is what keeps the store crash-safe and
 * loss-free) cannot avoid re-reading/re-writing its own remainder. This keeps a
 * large pre-issue tail from being folded in one giant synchronous pass; it does
 * not make the total drain I/O-free.
 *
 * No double-count / loss: a record folds into the aggregate exactly once and
 * leaves the raw window forever; lifetime totals = folded + retained at every
 * step. Fail-open (never throws to callers); guarded by the store lock.
 */
function migrateCutover(
	directory: string,
	trigger: 'compaction' | 'close' = 'compaction',
	alreadyLocked = false,
): void {
	const filePath = telemetryFilePath(directory);
	if (!_internals.existsSync(filePath)) return;

	const run = () => {
		// Re-check under the lock in case a sibling already handled it.
		if (!_internals.existsSync(filePath)) return;
		const view = readStore(directory, false);
		if (view.manifest === null && view.records.length === 0) return;
		const folded = view.manifest
			? cloneFolded(view.manifest.folded)
			: emptyFolded();
		const now = Date.now();

		// Which records must leave the raw window to fit the active budget,
		// oldest-first so the newest recent window is retained: age-pruned
		// (counted as dropped) then budget-pruned (counted as compacted).
		const agePruned: TelemetryEntry[] = [];
		const kept: TelemetryEntry[] = [];
		for (const rec of view.records) {
			const ts = Date.parse(rec.timestamp);
			if (!Number.isNaN(ts) && now - ts > _internals.limits.ageMaxMs) {
				agePruned.push(rec);
			} else {
				kept.push(rec);
			}
		}
		const retained: TelemetryEntry[] = [];
		let bytes = 0;
		for (let i = kept.length - 1; i >= 0; i -= 1) {
			const rec = kept[i]!;
			const lb = Buffer.byteLength(JSON.stringify(rec)) + 1;
			if (
				retained.length >= _internals.limits.activeMaxEntries ||
				bytes + lb > _internals.limits.activeMaxBytes
			) {
				break;
			}
			retained.push(rec);
			bytes += lb;
		}
		retained.reverse();
		const retainedSet = new Set(retained);
		const keptSet = new Set(kept);
		const budgetPruned: TelemetryEntry[] = [];
		for (const rec of view.records) {
			if (keptSet.has(rec) && !retainedSet.has(rec)) budgetPruned.push(rec);
		}

		// Fold only a bounded prefix of the candidates this pass. At least one
		// record is folded per pass (an oversized record cannot be split); the
		// per-pass bound is compactMaxBytes of folded bytes.
		const candidates = [...agePruned, ...budgetPruned];
		const toFold = new Set<TelemetryEntry>();
		let foldedBytes = 0;
		for (const cand of candidates) {
			const cb = Buffer.byteLength(JSON.stringify(cand)) + 1;
			if (
				foldedBytes + cb > _internals.limits.compactMaxBytes &&
				toFold.size > 0
			) {
				break;
			}
			toFold.add(cand);
			foldedBytes += cb;
		}

		const finalRetained: TelemetryEntry[] = [];
		const agePrunedSet = new Set(agePruned);
		let dropped = 0;
		for (const rec of view.records) {
			if (toFold.has(rec)) {
				foldEntryInto(folded, rec);
				if (agePrunedSet.has(rec)) dropped += 1;
			} else {
				finalRetained.push(rec);
			}
		}
		if (dropped > 0) folded.dropped += dropped;
		// Durable corrupt: fold any current-window corrupt lines into the
		// aggregate count and drop them from the rewritten file.
		folded.corrupt += view.corruptLines;

		const manifest: TelemetryManifest = {
			...emptyManifest(),
			folded,
			updatedAt: new Date().toISOString(),
		};
		const lines = [`${JSON.stringify(manifest)}`];
		for (const rec of finalRetained) lines.push(JSON.stringify(rec));
		atomicReplace(
			directory,
			lines.length > 1 ? `${lines.join('\n')}\n` : `${lines[0]}\n`,
		);

		emitHealth(directory, {
			trigger,
			accepted: folded.delegations + finalRetained.length,
			compacted: toFold.size - dropped,
			retained: finalRetained.length,
			dropped,
			corrupt: folded.corrupt,
			oldest: folded.oldestTimestamp,
			newest: folded.newestTimestamp,
			bytes: fileSizeOrZero(filePath),
			limitBytes: _internals.limits.activeMaxBytes,
		});
	};
	if (alreadyLocked) {
		run();
		return;
	}
	withStoreLock(directory, run);
}

/**
 * Throttled maintenance dispatch: bounded-pass cutover (legacy header-less OR a
 * header'd store still draining an over-budget legacy tail) or full compaction
 * (once the window is within budget). Every pass here is bounded — a legacy tail
 * is drained `compactMaxBytes` at a time, never folded all at once.
 */
function runMaintenance(directory: string): void {
	try {
		const filePath = telemetryFilePath(directory);
		if (!_internals.existsSync(filePath)) return;
		const size = fileSizeOrZero(filePath);
		const head = readBoundedChunk(
			filePath,
			_internals.limits.headerMaxBytes + 64,
		);
		const isLegacy = parseManifestLine(head.text.split('\n')[0] ?? '') === null;
		const drainThreshold =
			_internals.limits.activeMaxBytes +
			_internals.limits.headerMaxBytes +
			2048;
		if (isLegacy || size > drainThreshold) {
			migrateCutover(directory);
			return;
		}
		compactStore(directory);
	} catch {
		warnThrottled('maintenance pass failed');
	}
}

/**
 * Fold the entire remaining retained window into the aggregate and atomically
 * publish a defined, validated cut. Called by `/swarm close` before archiving
 * (issue #2037: "close archives a defined, validated cut and leaves active
 * state usable"). Also migrates any header-less legacy file. Fail-open: never
 * throws to the close pipeline.
 *
 * @param directory - Project root directory
 */
export function finalizeContextTelemetry(directory: string): void {
	try {
		const filePath = telemetryFilePath(directory);
		if (!_internals.existsSync(filePath)) return;
		withStoreLock(directory, () => {
			// Drain a legacy header-less file to CONVERGENCE before the close
			// fold (review F-6): each pass folds at most compactMaxBytes, and
			// the loop repeats until the header exists — all under ONE lock
			// acquisition (review F-2), so close never archives a half-drained
			// legacy tail. The no-progress and pass-cap guards are defensive
			// bail-outs so a pathological file can never spin forever.
			let prev = Number.POSITIVE_INFINITY;
			for (let pass = 0; pass < 10_000; pass += 1) {
				const view = readStore(directory, false);
				if (view.manifest !== null) break;
				if (view.records.length === 0) break;
				if (view.records.length >= prev) break; // no progress — bail
				prev = view.records.length;
				migrateCutover(directory, 'close', true);
			}
			// Full close-fold of the remaining window into a defined,
			// validated cut. close is not a hot path, so the full fold is the
			// correct final definition of the archived cut.
			compactStore(directory, 'close', true);
		});
	} catch {
		warnThrottled('finalize failed');
	}
}

// ---------------------------------------------------------------------------
// Health emission (canonical contract, counts only — no capsule/query content)
// ---------------------------------------------------------------------------

function emitContextTelemetryHealth(
	_directory: string,
	payload: {
		trigger: 'compaction' | 'close';
		accepted: number;
		compacted: number;
		retained: number;
		dropped: number;
		corrupt: number;
		oldest: string | null;
		newest: string | null;
		bytes: number;
		limitBytes: number;
	},
): void {
	try {
		telemetry.contextTelemetryHealth({
			trigger: payload.trigger,
			accepted_count: payload.accepted,
			compacted_count: payload.compacted,
			retained_count: payload.retained,
			dropped_count: payload.dropped,
			corrupt_count: payload.corrupt,
			oldest_timestamp: payload.oldest,
			newest_timestamp: payload.newest,
			bytes: payload.bytes,
			limit_bytes: payload.limitBytes,
		});
	} catch {
		// Health telemetry must never break the store.
	}
}

function emitHealth(
	directory: string,
	payload: {
		trigger: 'compaction' | 'close';
		accepted: number;
		compacted: number;
		retained: number;
		dropped: number;
		corrupt: number;
		oldest: string | null;
		newest: string | null;
		bytes: number;
		limitBytes: number;
	},
): void {
	_internals.emitHealth(directory, payload);
}

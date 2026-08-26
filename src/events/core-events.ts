/**
 * Core event store — the single append seam and bounded store for
 * `.swarm/events.jsonl` (issue #2039, Observability PR 11/23).
 *
 * HISTORY: `.swarm/events.jsonl` was an ad hoc shared event bus with ~30
 * direct append sites across ~29 modules and NO hard byte/age/count ceiling;
 * nine production readers parsed the entire file, three of them
 * (coder-retry escalation, spec-drift commit dedup, task-repair audit
 * dedup) basing CORRECTNESS decisions on arbitrary-age lookups.
 *
 * NOW it is a BOUNDED single-file store in the `src/context-map/telemetry.ts`
 * (#2037) house pattern:
 *
 *   Line 1:  `swarm-events-manifest` header carrying the size-bounded FOLDED
 *            aggregate (events compacted away: lifetime total, per-type
 *            counts ≤64 keys + "other", corrupt/dropped counters).
 *   Line 2+: raw event JSONL — the RECENT retained window, bounded to
 *            CORE_EVENT_LIMITS.activeMaxBytes / activeMaxEntries / ageMaxMs.
 *
 * Lifetime totals = folded aggregate (header) + retained window (file). Event
 * lines are preserved byte-for-byte (both `event:` and `type:` discriminators
 * pass through untouched — the store never normalizes producer schemas).
 *
 * AUTHORITATIVE PARTITION (issue #2039 requirement 2/5): the four
 * correctness-relevant event types (`coder_retry_circuit_breaker`,
 * `task_workflow_repaired`, `spec_drift_acknowledged`, `spec_drift_repaired`)
 * are indexed into `.swarm/events-authority-index.json` at THREE points —
 * append time, fold time (BEFORE a line leaves the window), and read time
 * (self-healing) — so compaction can never make an authority answer wrong.
 * Authority queries are index-first with a bounded retained-window fallback
 * for legacy sessions; the only reachable "absent after compaction" case is
 * FIFO eviction past authorityIndexMaxEntries (disclosed via health).
 *
 * CONCURRENCY (issue #2039 review C2/C4): EVERY write (append, compaction,
 * index update, finalize) holds the exclusive `.swarm/events.lock` (`wx`
 * create, stale-broken after 5 minutes) — there are NO lockless writes, so an
 * append racing a compaction rewrite can never be silently discarded. The wx
 * store lock is the ONLY lock on this store; producers' former
 * `tryAcquireLock(..., 'events.jsonl', ...)` proper-lockfile calls are all
 * removed. Lock acquisition retries briefly, then fails with a typed error
 * the caller maps onto its existing error contract.
 *
 * All functions are synchronous (house pattern). The `_internals` DI seam
 * lets tests override filesystem operations and limits without `mock.module`
 * (AGENTS.md invariant 7). State lives exclusively under `.swarm/`
 * (invariant 4) — every function takes an explicit project-root `directory`.
 * No `bun:` imports — Node-ESM-loadable (invariant 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { telemetry } from '../telemetry.js';
import { warn } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Hard limits (issue #2039). Exported so tests can override small budgets via
// `_internals.limits` and restore in `afterEach`. Documented constants, not
// user config keys (the #2037/#2347 precedent).
// ---------------------------------------------------------------------------

export interface CoreEventLimits {
	/** Hard ceiling on the retained window (manifest line + event lines). */
	activeMaxBytes: number;
	/** Hard ceiling on the retained window (event lines). */
	activeMaxEntries: number;
	/** Operational-event retention age; aged events fold into the header. */
	ageMaxMs: number;
	/** Bounded fold work per maintenance pass (bytes of folded lines). */
	compactMaxBytes: number;
	/** Hard documented read bound for public reads, independent of history. */
	readMaxBytes: number;
	/** Appends between throttled maintenance checks. */
	checkInterval: number;
	/** Disk-pressure/failure warning cooldown. */
	warnCooldownMs: number;
	/** Upper bound for a serialized manifest header (single line). */
	headerMaxBytes: number;
	/** Hard ceiling on authority-index entries (FIFO-evicted, disclosed). */
	authorityIndexMaxEntries: number;
	/** Serialized single-event bound; larger appends fail with a typed error. */
	maxLineBytes: number;
}

export const CORE_EVENT_LIMITS: CoreEventLimits = {
	// Sized for ~30 writer modules incl. high-frequency full-auto probes (the
	// #2037 store had ONE writer at 256 KiB; constant churn at that size here
	// would defeat the bounded readers' locality).
	activeMaxBytes: 2 * 1024 * 1024,
	activeMaxEntries: 20_000,
	// Session-scoped file (archived+cleaned at close); the age cap only
	// defends long/stuck sessions (issue #2039's own scenario).
	ageMaxMs: 7 * 24 * 60 * 60 * 1000,
	compactMaxBytes: 512 * 1024,
	readMaxBytes: 3 * 1024 * 1024,
	checkInterval: 25,
	warnCooldownMs: 60_000,
	headerMaxBytes: 64 * 1024,
	authorityIndexMaxEntries: 20_000,
	maxLineBytes: 256 * 1024,
};

// ---------------------------------------------------------------------------
// Authority partition — the closed set of correctness-relevant event types.
// Every member is `type:`-keyed (verified across all producers on main).
// ---------------------------------------------------------------------------

const AUTHORITY_RETRY = 'coder_retry_circuit_breaker';
const AUTHORITY_REPAIR = 'task_workflow_repaired';
const AUTHORITY_DRIFT_ACK = 'spec_drift_acknowledged';
const AUTHORITY_DRIFT_REPAIR = 'spec_drift_repaired';

export type CoderRetryEscalationAction =
	| 'sounding_board_consultation'
	| 'simplification'
	| 'user_escalation';

const RETRY_ACTIONS: ReadonlySet<string> = new Set([
	'sounding_board_consultation',
	'simplification',
	'user_escalation',
]);

/** The authority key for an event, or null when the event is not in the
 *  closed authority set (or lacks the identity fields the key needs). */
function authorityKeyFor(event: Record<string, unknown>): string | null {
	switch (event.type) {
		case AUTHORITY_RETRY: {
			if (
				typeof event.taskId === 'string' &&
				typeof event.retryEpoch === 'number' &&
				Number.isFinite(event.retryEpoch) &&
				typeof event.action === 'string' &&
				RETRY_ACTIONS.has(event.action)
			) {
				return `retry|${event.taskId}|${event.retryEpoch}|${event.action}`;
			}
			return null;
		}
		case AUTHORITY_REPAIR: {
			if (
				typeof event.taskId === 'string' &&
				typeof event.transitionId === 'string'
			) {
				return `repair|${event.taskId}|${event.transitionId}`;
			}
			return null;
		}
		case AUTHORITY_DRIFT_ACK:
		case AUTHORITY_DRIFT_REPAIR: {
			if (typeof event.transitionId === 'string') {
				return `drift|${String(event.type)}|${event.transitionId}`;
			}
			return null;
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Manifest (header) shape
// ---------------------------------------------------------------------------

const MANIFEST_TYPE = 'swarm-events-manifest';
const MANIFEST_SCHEMA = 1;

/** Size-bounded folded aggregate persisted in the manifest header. FOLDED-ONLY:
 *  events compacted/cut away from the retained window. Retained events are NOT
 *  in here. Lifetime totals = folded + retained. */
export interface CoreEventFolded {
	totalEvents: number;
	/** Per-discriminator counts, capped at 64 distinct keys + "other". */
	byType: Record<string, number>;
	corrupt: number;
	dropped: number;
	oldestTimestamp: string | null;
	newestTimestamp: string | null;
}

export interface CoreEventManifest {
	v: 1;
	type: 'swarm-events-manifest';
	schemaVersion: number;
	folded: CoreEventFolded;
	updatedAt: string;
}

const BY_TYPE_MAX_KEYS = 64;
const BY_TYPE_OTHER = '__other__';

function emptyFolded(): CoreEventFolded {
	return {
		totalEvents: 0,
		byType: {},
		corrupt: 0,
		dropped: 0,
		oldestTimestamp: null,
		newestTimestamp: null,
	};
}

function emptyManifest(): CoreEventManifest {
	return {
		v: 1,
		type: MANIFEST_TYPE,
		schemaVersion: MANIFEST_SCHEMA,
		folded: emptyFolded(),
		updatedAt: new Date().toISOString(),
	};
}

/**
 * Header detection rule: "header present" iff line 1 parses to a JSON object
 * with `type === 'swarm-events-manifest'` and `schemaVersion === 1`. A legacy
 * event line can theoretically carry a `type` field, but no producer on main
 * ever wrote this discriminator value, and the fold only treats line 1 as the
 * header when the full shape (v/schemaVersion/folded) matches.
 */
function parseManifestLine(line: string): CoreEventManifest | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const obj: unknown = JSON.parse(trimmed);
		if (typeof obj !== 'object' || obj === null) return null;
		const rec = obj as Record<string, unknown>;
		if (
			rec.type !== MANIFEST_TYPE ||
			rec.v !== 1 ||
			rec.schemaVersion !== MANIFEST_SCHEMA ||
			typeof rec.folded !== 'object' ||
			rec.folded === null
		) {
			return null;
		}
		const f = rec.folded as Record<string, unknown>;
		const manifest = emptyManifest();
		const num = (v: unknown): number =>
			typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
		manifest.folded.totalEvents = num(f.totalEvents);
		manifest.folded.corrupt = num(f.corrupt);
		manifest.folded.dropped = num(f.dropped);
		if (typeof f.byType === 'object' && f.byType !== null) {
			for (const [k, v] of Object.entries(
				f.byType as Record<string, unknown>,
			)) {
				if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
					manifest.folded.byType[k] = v;
				}
			}
		}
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
// DI seam — tests override these functions without touching real modules
// ---------------------------------------------------------------------------

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
	now: (): number => Date.now(),
	limits: CORE_EVENT_LIMITS,
	emitHealth: emitCoreEventsHealth,
} as const;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function eventsFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'events.jsonl');
}

function lockFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'events.lock');
}

function authorityIndexPath(directory: string): string {
	return path.join(directory, '.swarm', 'events-authority-index.json');
}

function tmpPathFor(finalPath: string): string {
	// PID-scoped so concurrent processes never collide on one temp name.
	return `${finalPath}.${process.pid}.tmp`;
}

// ---------------------------------------------------------------------------
// Coverage + health payload types
// ---------------------------------------------------------------------------

export type CoreEventCoverage = 'complete' | 'truncated' | 'empty';

/** The bounded view of the retained window. `text` is manifest-stripped event
 *  lines in append order (possibly starting mid-line when truncated). */
export interface CoreEventReadResult {
	text: string;
	truncated: boolean;
	coverage: CoreEventCoverage;
}

// ---------------------------------------------------------------------------
// Bounded read helpers
// ---------------------------------------------------------------------------

/** Read at most `maxBytes` starting at `offset`. Never exceeds `maxBytes`
 *  regardless of file size. Fail-open on transient I/O errors. */
function readBoundedChunk(
	filePath: string,
	maxBytes: number,
	offset = 0,
): { text: string; truncated: boolean } {
	try {
		if (!_internals.existsSync(filePath)) {
			return { text: '', truncated: false };
		}
		const fd = _internals.openSync(filePath, 'r');
		try {
			const size = _internals.statSync(filePath).size;
			const readable = Math.max(0, size - offset);
			const truncated = readable > maxBytes;
			const len = Math.min(readable, maxBytes);
			const buf = Buffer.alloc(len);
			let read = 0;
			while (read < len) {
				const n = _internals.readSync(fd, buf, read, len - read, offset + read);
				if (n <= 0) break;
				read += n;
			}
			return { text: buf.toString('utf-8', 0, read), truncated };
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
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

/** True when the file's final byte is a newline (or the file is empty /
 *  unreadable — fail-open). Guards the append path against appending onto a
 *  crash-torn final line (issue #2037 review F-4 pattern). */
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

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

function eventDiscriminator(event: Record<string, unknown>): string {
	if (typeof event.type === 'string' && event.type.length > 0) {
		return event.type.slice(0, 64);
	}
	if (typeof event.event === 'string' && event.event.length > 0) {
		return event.event.slice(0, 64);
	}
	return '__untyped__';
}

function eventTimestamp(event: Record<string, unknown>): string | null {
	// Producers use either `timestamp` (ISO string) — every closed-set
	// authority producer does; events without a parseable ISO timestamp are
	// never age-pruned, only budget-pruned.
	if (typeof event.timestamp !== 'string') return null;
	const ts = Date.parse(event.timestamp);
	return Number.isNaN(ts) ? null : event.timestamp;
}

function foldLineInto(
	folded: CoreEventFolded,
	event: Record<string, unknown>,
): void {
	folded.totalEvents += 1;
	const key = eventDiscriminator(event);
	const keys = Object.keys(folded.byType);
	if (folded.byType[key] !== undefined || keys.length < BY_TYPE_MAX_KEYS) {
		folded.byType[key] = (folded.byType[key] ?? 0) + 1;
	} else {
		folded.byType[BY_TYPE_OTHER] = (folded.byType[BY_TYPE_OTHER] ?? 0) + 1;
	}
	const ts = eventTimestamp(event);
	if (ts !== null) {
		if (folded.oldestTimestamp === null || ts < folded.oldestTimestamp) {
			folded.oldestTimestamp = ts;
		}
		if (folded.newestTimestamp === null || ts > folded.newestTimestamp) {
			folded.newestTimestamp = ts;
		}
	}
}

function cloneFolded(folded: CoreEventFolded): CoreEventFolded {
	return {
		totalEvents: folded.totalEvents,
		byType: { ...folded.byType },
		corrupt: folded.corrupt,
		dropped: folded.dropped,
		oldestTimestamp: folded.oldestTimestamp,
		newestTimestamp: folded.newestTimestamp,
	};
}

// ---------------------------------------------------------------------------
// Authority index
// ---------------------------------------------------------------------------

interface AuthorityIndexFile {
	version: 1;
	entries: Record<string, string>;
	evicted: number;
}

function emptyAuthorityIndex(): AuthorityIndexFile {
	return { version: 1, entries: {}, evicted: 0 };
}

/** Result flavors: 'ok' carries the index; 'corrupt' means the index exists
 *  but is unreadable/malformed — authority consumers fail CLOSED on this
 *  (mirroring today's malformed-JSONL throws in the consumers they replace);
 *  'absent' means no index file yet (fresh or legacy session — fall back to
 *  the retained-window scan). */
type AuthorityIndexState =
	| { kind: 'ok'; index: AuthorityIndexFile }
	| { kind: 'absent' }
	| { kind: 'corrupt' };

function loadAuthorityIndex(directory: string): AuthorityIndexState {
	const indexPath = authorityIndexPath(directory);
	try {
		if (!_internals.existsSync(indexPath)) return { kind: 'absent' };
		const raw = _internals.readFileSync(indexPath, 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			(parsed as Record<string, unknown>).version !== 1 ||
			typeof (parsed as Record<string, unknown>).entries !== 'object' ||
			(parsed as Record<string, unknown>).entries === null
		) {
			return { kind: 'corrupt' };
		}
		const entries: Record<string, string> = {};
		for (const [k, v] of Object.entries(
			(parsed as Record<string, unknown>).entries as Record<string, unknown>,
		)) {
			if (typeof v === 'string') entries[k] = v;
		}
		const evictedRaw = (parsed as Record<string, unknown>).evicted;
		return {
			kind: 'ok',
			index: {
				version: 1,
				entries,
				evicted:
					typeof evictedRaw === 'number' &&
					Number.isFinite(evictedRaw) &&
					evictedRaw >= 0
						? evictedRaw
						: 0,
			},
		};
	} catch {
		return { kind: 'corrupt' };
	}
}

/**
 * Merge keys into the authority index and atomically rewrite it (tmp+rename).
 * FIFO-caps at authorityIndexMaxEntries — eviction is the ONLY reachable way a
 * once-indexed authority key becomes un-answerable, and it is disclosed via
 * the persisted `evicted` counter and `core_events_health`.
 *
 * Caller must hold the store lock for authoritative mutations (append/fold
 * paths); the read-time SELF-HEAL path calls this lock-free by design
 * (idempotent last-write-wins on timestamps, eventual consistency — issue
 * #2039 plan-critic round 2 R2-1).
 */
function mergeAuthorityKeys(
	directory: string,
	state: AuthorityIndexState,
	keys: string[],
): void {
	if (keys.length === 0) return;
	const base: AuthorityIndexFile =
		state.kind === 'ok'
			? {
					version: 1,
					entries: { ...state.index.entries },
					evicted: state.index.evicted,
				}
			: emptyAuthorityIndex();
	const now = new Date().toISOString();
	for (const key of keys) base.entries[key] = now;
	const limit = _internals.limits.authorityIndexMaxEntries;
	const allKeys = Object.keys(base.entries);
	if (allKeys.length > limit) {
		// FIFO by insertion-recency proxy: the persisted lastSeen order. Keys
		// re-merged keep their recency, so steady-state eviction drops the
		// oldest-touched entries first.
		allKeys.sort((a, b) => (base.entries[a]! <= base.entries[b]! ? -1 : 1));
		const excess = allKeys.length - limit;
		for (let i = 0; i < excess; i += 1) {
			delete base.entries[allKeys[i]!];
		}
		base.evicted += excess;
	}
	authorityIndexAtomicReplace(directory, base);
}

function authorityIndexAtomicReplace(
	directory: string,
	index: AuthorityIndexFile,
): void {
	const finalPath = authorityIndexPath(directory);
	const tmpPath = tmpPathFor(finalPath);
	try {
		if (_internals.existsSync(tmpPath)) {
			try {
				_internals.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		_internals.writeFileSync(tmpPath, `${JSON.stringify(index)}\n`, 'utf-8');
		_internals.renameSync(tmpPath, finalPath);
	} catch {
		try {
			if (_internals.existsSync(tmpPath)) {
				_internals.unlinkSync(tmpPath);
			}
		} catch {
			/* ignore */
		}
		throw new Error('core-events authority index atomic replace failed');
	}
}

// ---------------------------------------------------------------------------
// Atomic single-file publish (manifest + window)
// ---------------------------------------------------------------------------

/**
 * Atomically replace the events file (write PID-scoped tmp + rename). The
 * composed content is validated IN MEMORY first (manifest round-trips; every
 * non-manifest line JSON-parses; final newline present) and the written tmp
 * is byte-verified against the composed buffer before the rename — the old
 * file is never replaced by an unverified buffer (issue #2039 plan M14).
 */
function atomicReplace(directory: string, content: string): void {
	// Pre-rename validation.
	const lines = content.split('\n');
	if (lines.length < 2 || lines[lines.length - 1] !== '') {
		throw new Error('core-events atomic replace failed (framing)');
	}
	if (parseManifestLine(lines[0] ?? '') === null) {
		throw new Error('core-events atomic replace failed (manifest)');
	}
	for (let i = 1; i < lines.length - 1; i += 1) {
		const line = lines[i]!;
		if (line.trim() === '') continue;
		JSON.parse(line); // throws => abort before touching the file
	}

	const finalPath = eventsFilePath(directory);
	const tmpPath = tmpPathFor(finalPath);
	try {
		if (_internals.existsSync(tmpPath)) {
			try {
				_internals.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		_internals.writeFileSync(tmpPath, content, 'utf-8');
		if (_internals.readFileSync(tmpPath, 'utf-8') !== content) {
			throw new Error('tmp verify mismatch');
		}
		_internals.renameSync(tmpPath, finalPath);
	} catch {
		try {
			if (_internals.existsSync(tmpPath)) {
				_internals.unlinkSync(tmpPath);
			}
		} catch {
			/* ignore */
		}
		throw new Error('core-events atomic replace failed');
	}
}

// ---------------------------------------------------------------------------
// Lock — the ONLY lock on this store (issue #2039 review C2/C4)
// ---------------------------------------------------------------------------

const LOCK_RETRY_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_STALE_MS = 5 * 60_000;

/** Bounded synchronous sleep (works on Node/Bun main threads, unlike the
 *  browser restriction). Used only between lock-retry attempts. */
const sleepScratch = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms: number): void {
	try {
		Atomics.wait(sleepScratch, 0, 0, ms);
	} catch {
		/* fall back to returning immediately — the retry bound still holds */
	}
}

/** Internal: one lock acquisition attempt (wx create + stale-break). */
function tryLockOnce(directory: string): boolean {
	const lockPath = lockFilePath(directory);
	try {
		_internals.mkdirSync(path.dirname(lockPath), { recursive: true });
		const fd = _internals.openSync(lockPath, 'wx');
		_internals.closeSync(fd);
		return true;
	} catch {
		try {
			const age = _internals.now() - _internals.statSync(lockPath).mtimeMs;
			if (age > LOCK_STALE_MS) {
				try {
					_internals.unlinkSync(lockPath);
				} catch {
					/* ignore */
				}
				try {
					const fd = _internals.openSync(lockPath, 'wx');
					_internals.closeSync(fd);
					return true;
				} catch {
					return false;
				}
			}
		} catch {
			/* stat failed — treat as held */
		}
		return false;
	}
}

export interface CoreEventStoreLock {
	/** Release the lock (idempotent). */
	release: () => void;
}

/**
 * Acquire the exclusive store lock with a brief bounded retry, then run `fn`
 * while holding it. Returns null when the lock stays contended for the whole
 * retry window — callers map that onto their existing error contract
 * (operational producers catch+warn; the two hard-fail producers rethrow
 * their pre-existing audit-locked codes).
 */
export function withCoreEventStoreLock<T>(
	directory: string,
	fn: () => T,
): T | null {
	for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
		if (tryLockOnce(directory)) {
			try {
				return fn();
			} finally {
				try {
					_internals.unlinkSync(lockFilePath(directory));
				} catch {
					/* ignore */
				}
			}
		}
		if (attempt < LOCK_RETRY_ATTEMPTS - 1) {
			// Bounded wait: the contention window is a maintenance pass (fast,
			// bounded work), never an unbounded hold.
			syncSleep(LOCK_RETRY_DELAY_MS);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Maintenance state
// ---------------------------------------------------------------------------

let _appendCount = 0;
let _lastWarnAt = 0;

/** Test seam (AGENTS.md invariant 7): reset module-scoped maintenance
 *  counters between tests. Restore by calling in `afterEach`. */
export function _resetMaintenanceCounters(): void {
	_appendCount = 0;
	_lastWarnAt = 0;
}

function shouldRunMaintenance(linesAppended = 1): boolean {
	_appendCount += linesAppended;
	if (_appendCount >= _internals.limits.checkInterval) {
		_appendCount = 0;
		return true;
	}
	return false;
}

function warnThrottled(message: string): void {
	const now = _internals.now();
	if (now - _lastWarnAt < _internals.limits.warnCooldownMs) return;
	_lastWarnAt = now;
	// Debug-gated logger (AGENTS.md invariant 10: no chat-visible noise).
	warn(`core-events: ${message}`);
}

// ---------------------------------------------------------------------------
// Store view (maintenance path — reads the whole file, exactly like the
// #2037 honest-work model: the one-time legacy drain read + rewrite of the
// remaining window scales with the current store size and is amortized
// across compactMaxBytes-bounded passes; PUBLIC reads are tail-bounded).
// ---------------------------------------------------------------------------

interface StoreLine {
	line: string;
	event: Record<string, unknown> | null; // null = corrupt
}

interface StoreView {
	manifest: CoreEventManifest | null;
	lines: StoreLine[]; // event lines only (manifest excluded), append order
	corruptLines: number;
}

function readStoreFull(directory: string): StoreView {
	const filePath = eventsFilePath(directory);
	if (!_internals.existsSync(filePath)) {
		return { manifest: null, lines: [], corruptLines: 0 };
	}
	let text: string;
	try {
		text = _internals.readFileSync(filePath, 'utf-8');
	} catch {
		return { manifest: null, lines: [], corruptLines: 0 };
	}
	const rawLines = text.split('\n');
	const lines: StoreLine[] = [];
	let corruptLines = 0;
	let manifest: CoreEventManifest | null = null;
	for (let i = 0; i < rawLines.length; i += 1) {
		const line = rawLines[i]!;
		if (line.trim() === '') continue;
		if (i === 0) {
			manifest = parseManifestLine(line);
			if (manifest) continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				lines.push({ line, event: parsed as Record<string, unknown> });
			} else {
				corruptLines += 1;
			}
		} catch {
			corruptLines += 1;
		}
	}
	return { manifest, lines, corruptLines };
}

// ---------------------------------------------------------------------------
// Public bounded reads
// ---------------------------------------------------------------------------

function coverageFor(
	fileExists: boolean,
	lineCount: number,
	truncated: boolean,
): CoreEventCoverage {
	if (!fileExists || lineCount === 0) return 'empty';
	return truncated ? 'truncated' : 'complete';
}

/**
 * Bounded read of the retained window: the newest `readMaxBytes` of event
 * lines, manifest-stripped, in append order. `truncated` means older history
 * exists beyond the read bound (a legacy header-less file larger than the
 * bound, or a store mid-drain) — callers disclose it, never silently treat
 * the window as complete history.
 */
export function readCoreEvents(directory: string): CoreEventReadResult {
	const filePath = eventsFilePath(directory);
	if (!_internals.existsSync(filePath)) {
		return { text: '', truncated: false, coverage: 'empty' };
	}
	// TAIL read: readers semantically want the NEWEST events (phase windows,
	// steering reconciliation, rejection counts). When the file exceeds the
	// bound, read the last readMaxBytes and drop the torn partial line the
	// cut creates at the head of the chunk.
	const size = fileSizeOrZero(filePath);
	const truncated = size > _internals.limits.readMaxBytes;
	const offset = truncated
		? Math.max(0, size - _internals.limits.readMaxBytes)
		: 0;
	let text = readBoundedChunk(
		filePath,
		_internals.limits.readMaxBytes,
		offset,
	).text;
	if (truncated) {
		// The chunk starts mid-line; drop that partial first line so no torn
		// fragment leaks into consumer text.
		const firstNewline = text.indexOf('\n');
		text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
	}
	// Strip the manifest when it is inside the read window (only possible on
	// a non-truncated read, which starts at file head).
	const lines = text.split('\n');
	const start = parseManifestLine(lines[0] ?? '') !== null ? 1 : 0;
	if (start === 1) {
		text = lines.slice(1).join('\n');
	}
	const eventLineCount = text.split('\n').filter((l) => l.trim() !== '').length;
	return {
		text,
		truncated,
		coverage: coverageFor(true, eventLineCount, truncated),
	};
}

/** Coverage disclosure without reading the window body. */
export function getCoreEventCoverage(directory: string): CoreEventCoverage {
	const filePath = eventsFilePath(directory);
	if (!_internals.existsSync(filePath)) return 'empty';
	const size = fileSizeOrZero(filePath);
	if (size === 0) return 'empty';
	return size > _internals.limits.readMaxBytes ? 'truncated' : 'complete';
}

/**
 * Lifetime event count = folded total (manifest) + retained window count.
 * The explicit counter/projection the issue requires for turn estimation —
 * O(header) once a manifest exists; a legacy header-less file falls back to
 * a bounded window count (advisory consumers only).
 *
 * Point-in-time advisory: the manifest head read and the window read are two
 * separate reads, so a maintenance fold racing between them can briefly
 * underreport (old folded + new, smaller window). Consumers are display-only
 * (context-budget turn estimate); exactness across a compaction boundary is
 * not required.
 */
export function getCoreEventLifetimeCount(directory: string): number {
	const filePath = eventsFilePath(directory);
	if (!_internals.existsSync(filePath)) return 0;
	const head = readBoundedChunk(
		filePath,
		_internals.limits.headerMaxBytes + 64,
	);
	const manifest = parseManifestLine(head.text.split('\n')[0] ?? '');
	if (manifest) {
		const window = readCoreEvents(directory);
		const windowCount = window.text
			.split('\n')
			.filter((l) => l.trim() !== '').length;
		return manifest.folded.totalEvents + windowCount;
	}
	// Legacy: bounded count of the newest window (disclosed as truncated when
	// the file exceeds the bound by getCoreEventCoverage).
	return readCoreEvents(directory)
		.text.split('\n')
		.filter((l) => l.trim() !== '').length;
}

// ---------------------------------------------------------------------------
// Append seam
// ---------------------------------------------------------------------------

/** Typed store-busy error — producers map it onto their existing contracts
 *  (catch+warn for operational producers; the two hard-fail audit producers
 *  rethrow their pre-existing locked codes). */
export const CORE_EVENT_LOCKED = 'CORE_EVENT_STORE_LOCKED';
export const CORE_EVENT_LINE_TOO_LARGE = 'CORE_EVENT_LINE_TOO_LARGE';

/**
 * Append one event to `.swarm/events.jsonl` through the canonical seam.
 *
 * - Serializes the event EXACTLY as the producer shaped it (`event:` and
 *   `type:` discriminators preserved; no normalization).
 * - Holds the store lock for the write; closed-set authority events index
 *   their authority key in the same lock scope, event-first (the crash
 *   window between the two is healed at fold time and read time).
 * - `dedupeOnAuthorityKey` (authority events only): skips the append when
 *   the event's authority key is already indexed or present in the
 *   retained window — the at-most-once audit contract the two hard-fail
 *   producers previously enforced with lock-then-recheck reads.
 * - Runs throttled maintenance (bounded compaction / legacy drain) every
 *   `checkInterval` appends, after the lock is released.
 *
 * Throws `CORE_EVENT_STORE_LOCKED` after bounded lock retry, or a typed
 * serialize error for oversized lines — every producer's existing error
 * handling applies unchanged.
 */
export function appendCoreEventSync(
	directory: string,
	event: Record<string, unknown>,
	options?: { dedupeOnAuthorityKey?: boolean },
): void {
	const line = `${JSON.stringify(event)}\n`;
	const lineBytes = Buffer.byteLength(line);
	if (lineBytes - 1 > _internals.limits.maxLineBytes) {
		throw new Error(CORE_EVENT_LINE_TOO_LARGE);
	}
	const filePath = eventsFilePath(directory);
	const swarmDir = path.join(directory, '.swarm');

	_internals.mkdirSync(swarmDir, { recursive: true });
	const authorityKey = authorityKeyFor(event);
	const wrote = withCoreEventStoreLock(directory, () => {
		if (authorityKey && options?.dedupeOnAuthorityKey) {
			if (authorityKeyPresent(directory, authorityKey, event)) {
				return 'skipped';
			}
		}
		if (!_internals.existsSync(filePath)) {
			// First write is atomic (header + one event) so a crash can never
			// leave a torn header at line 1 (#2037 pattern).
			const manifest = emptyManifest();
			atomicReplace(directory, `${JSON.stringify(manifest)}\n${line}`);
		} else {
			// Re-establish line framing if a prior crash tore the tail.
			const prefix = fileEndsWithNewline(filePath) ? '' : '\n';
			_internals.appendFileSync(filePath, `${prefix}${line}`, 'utf-8');
		}
		if (authorityKey) {
			const state = loadAuthorityIndex(directory);
			// 'corrupt' here is treated as absent-and-rebuildable on the append
			// path: the producer's audit event must land; the index is rebuilt
			// from the fold pass and read-time self-heal.
			mergeAuthorityKeys(directory, state, [authorityKey]);
		}
		return 'appended';
	});
	if (wrote === null) {
		throw new Error(CORE_EVENT_LOCKED);
	}
	if (shouldRunMaintenance()) {
		runMaintenance(directory);
	}
}

/** Index-or-window presence for the append-time dedupe (lock held). */
function authorityKeyPresent(
	directory: string,
	key: string,
	event: Record<string, unknown>,
): boolean {
	void event;
	const state = loadAuthorityIndex(directory);
	if (state.kind === 'ok' && state.index.entries[key] !== undefined) {
		return true;
	}
	// Window scan for the crash window between a prior append and its index
	// write (identical predicate shape to the producer's own lookups).
	for (const candidate of scanWindowFor(
		directory,
		(e) => authorityKeyFor(e) === key,
	)) {
		void candidate;
		return true;
	}
	return false;
}

/**
 * Batch append: identical semantics to {@link appendCoreEventSync} for each
 * event, but ONE lock acquisition for the whole batch (reconciliation loops
 * that correct many records at once — e.g. the steering hook's unconsumed
 * set — must not pay a lock round-trip per line). Per-line error contracts
 * are the caller's: a lock failure throws `CORE_EVENT_STORE_LOCKED` before
 * any line lands; an oversized line throws `CORE_EVENT_LINE_TOO_LARGE` before
 * the batch starts (all lines are validated first).
 */
export function appendCoreEventsSync(
	directory: string,
	events: readonly Record<string, unknown>[],
	options?: { dedupeOnAuthorityKey?: boolean },
): void {
	if (events.length === 0) return;
	const lines = events.map((event) => `${JSON.stringify(event)}\n`);
	for (const line of lines) {
		if (Buffer.byteLength(line) - 1 > _internals.limits.maxLineBytes) {
			throw new Error(CORE_EVENT_LINE_TOO_LARGE);
		}
	}
	const filePath = eventsFilePath(directory);
	const swarmDir = path.join(directory, '.swarm');

	_internals.mkdirSync(swarmDir, { recursive: true });
	const wrote = withCoreEventStoreLock(directory, () => {
		let appended = 0;
		// Framing is checked once before the first append; under the store
		// lock nothing can interleave, and every appended line ends with \n,
		// so the tail is known-good for the rest of the batch (a per-line
		// openSync/readSync framing probe made large reconciliation batches
		// ~10x slower on Windows real-time-AV hosts).
		let framingChecked = false;
		for (let i = 0; i < events.length; i += 1) {
			const event = events[i]!;
			const authorityKey = authorityKeyFor(event);
			if (authorityKey && options?.dedupeOnAuthorityKey) {
				if (authorityKeyPresent(directory, authorityKey, event)) {
					continue;
				}
			}
			if (appended === 0 && !_internals.existsSync(filePath)) {
				const manifest = emptyManifest();
				atomicReplace(directory, `${JSON.stringify(manifest)}\n${lines[i]}`);
				framingChecked = true;
			} else {
				const prefix =
					!framingChecked && !fileEndsWithNewline(filePath) ? '\n' : '';
				_internals.appendFileSync(filePath, `${prefix}${lines[i]}`, 'utf-8');
				framingChecked = true;
			}
			if (authorityKey) {
				const state = loadAuthorityIndex(directory);
				mergeAuthorityKeys(directory, state, [authorityKey]);
			}
			appended += 1;
		}
		return appended;
	});
	if (wrote === null) {
		throw new Error(CORE_EVENT_LOCKED);
	}
	if (shouldRunMaintenance(events.length)) {
		runMaintenance(directory);
	}
}

// ---------------------------------------------------------------------------
// Authority queries (issue #2039 requirement 4: purpose-built bounded)
// ---------------------------------------------------------------------------

/** Parse the bounded window for authority-fallback scans. */
function scanWindowFor(
	directory: string,
	predicate: (event: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
	const window = readCoreEvents(directory);
	const matches: Record<string, unknown>[] = [];
	for (const line of window.text.split('\n')) {
		if (line.trim() === '') continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				predicate(parsed as Record<string, unknown>)
			) {
				matches.push(parsed as Record<string, unknown>);
			}
		} catch {
			/* malformed unrelated line never blocks authority lookups */
		}
	}
	return matches;
}

function selfHealAuthorityKeys(directory: string, keys: string[]): void {
	// Lock-free atomic rewrite (R2-1): idempotent last-write-wins; races only
	// ever re-write the same or a larger set of keys.
	try {
		const state = loadAuthorityIndex(directory);
		if (state.kind === 'corrupt') return; // fail-closed path handles it
		mergeAuthorityKeys(directory, state, keys);
	} catch {
		/* self-heal is best-effort; the fold pass re-indexes later */
	}
}

/** The set of escalation actions already durably emitted for a
 *  (taskId, retryEpoch) pair. Index answer UNION the bounded retained-window
 *  scan — identical verdicts to the pre-#2039 whole-file scan for everything
 *  within the window, and complete-after-compaction via the index. */
export function getCoderRetryEscalationActions(
	directory: string,
	taskId: string,
	retryEpoch: number,
): Set<CoderRetryEscalationAction> {
	const actions = new Set<CoderRetryEscalationAction>();
	const prefix = `retry|${taskId}|${retryEpoch}|`;
	const state = loadAuthorityIndex(directory);
	if (state.kind === 'corrupt') {
		throw new Error('CORE_EVENT_AUTHORITY_INDEX_UNREADABLE');
	}
	const heal: string[] = [];
	if (state.kind === 'ok') {
		for (const key of Object.keys(state.index.entries)) {
			if (key.startsWith(prefix)) {
				const action = key.slice(prefix.length);
				if (RETRY_ACTIONS.has(action)) {
					actions.add(action as CoderRetryEscalationAction);
				}
			}
		}
	}
	// Bounded window scan (legacy sessions + crash-window self-heal).
	for (const event of scanWindowFor(
		directory,
		(e) =>
			e.type === AUTHORITY_RETRY &&
			e.taskId === taskId &&
			e.retryEpoch === retryEpoch &&
			typeof e.action === 'string' &&
			RETRY_ACTIONS.has(e.action as string),
	)) {
		const action = event.action as CoderRetryEscalationAction;
		if (!actions.has(action)) {
			actions.add(action);
			const key = authorityKeyFor(event);
			if (key) heal.push(key);
		}
	}
	if (heal.length > 0) selfHealAuthorityKeys(directory, heal);
	return actions;
}

function hasAuthorityEvent(
	directory: string,
	key: string,
	predicate: (event: Record<string, unknown>) => boolean,
): boolean {
	const state = loadAuthorityIndex(directory);
	if (state.kind === 'corrupt') {
		throw new Error('CORE_EVENT_AUTHORITY_INDEX_UNREADABLE');
	}
	if (state.kind === 'ok' && state.index.entries[key] !== undefined) {
		return true;
	}
	const found = scanWindowFor(directory, predicate);
	if (found.length > 0) {
		selfHealAuthorityKeys(directory, [key]);
		return true;
	}
	return false;
}

/** Spec-drift audit presence: the idempotency check that gates a drift WAL's
 *  transition to COMMITTED. Fails closed (typed throw) on a corrupt index,
 *  matching the malformed-JSONL throw it replaces. */
export function hasSpecDriftAuditEvent(
	directory: string,
	kind: 'spec_drift_acknowledged' | 'spec_drift_repaired',
	transitionId: string,
): boolean {
	return hasAuthorityEvent(
		directory,
		`drift|${kind}|${transitionId}`,
		(e) => e.type === kind && e.transitionId === transitionId,
	);
}

/** Task-repair audit presence: the idempotency check behind
 *  `ensureAuditEvent` (COMMITTED repair WALs are never deleted within a
 *  session, so this must answer for arbitrarily old repairs). */
export function hasTaskRepairAuditEvent(
	directory: string,
	taskId: string,
	transitionId: string,
): boolean {
	return hasAuthorityEvent(
		directory,
		`repair|${taskId}|${transitionId}`,
		(e) =>
			e.type === AUTHORITY_REPAIR &&
			e.taskId === taskId &&
			e.transitionId === transitionId,
	);
}

// ---------------------------------------------------------------------------
// Maintenance — compaction + bounded legacy cutover
// ---------------------------------------------------------------------------

/**
 * Shared fold pass. Folds at most compactMaxBytes of the oldest
 * non-retained lines into the manifest aggregate; BEFORE any authority line
 * leaves the window its index entry is written (the C1 invariant: compaction
 * can never make an authority answer wrong). Atomic validated rewrite.
 * `forceFull` folds everything non-retained (close finalize).
 */
function foldPass(
	directory: string,
	trigger: 'compaction' | 'close',
	forceFull: boolean,
): void {
	const filePath = eventsFilePath(directory);
	if (!_internals.existsSync(filePath)) return;

	const view = readStoreFull(directory);
	if (view.manifest === null && view.lines.length === 0) return;
	const folded = view.manifest
		? cloneFolded(view.manifest.folded)
		: emptyFolded();
	const now = _internals.now();

	// Age-partition (operational events only; the authority set is exempt —
	// correctness state never ages out of the window, it is INDEXED instead).
	const agePruned: StoreLine[] = [];
	const kept: StoreLine[] = [];
	for (const entry of view.lines) {
		if (entry.event === null) {
			agePruned.push(entry); // corrupt lines always fold (counted corrupt)
			continue;
		}
		if (authorityKeyFor(entry.event) !== null) {
			kept.push(entry);
			continue;
		}
		const ts = eventTimestamp(entry.event);
		if (ts !== null && now - Date.parse(ts) > _internals.limits.ageMaxMs) {
			agePruned.push(entry);
		} else {
			kept.push(entry);
		}
	}

	// Retain the NEWEST kept lines that fit the budgets, oldest-first folding
	// for the rest. Authority events participate in the byte/count budget
	// like every other line (their correctness lives in the index, not the
	// window).
	const retained: StoreLine[] = [];
	let bytes = Buffer.byteLength(
		JSON.stringify(view.manifest ?? emptyManifest()),
	);
	for (let i = kept.length - 1; i >= 0; i -= 1) {
		const entry = kept[i]!;
		const lineBytes = Buffer.byteLength(entry.line) + 1;
		if (
			retained.length >= _internals.limits.activeMaxEntries ||
			bytes + lineBytes > _internals.limits.activeMaxBytes
		) {
			break;
		}
		retained.push(entry);
		bytes += lineBytes;
	}
	retained.reverse();

	const retainedSet = new Set(retained);
	const candidates: StoreLine[] = [];
	for (const entry of view.lines) {
		if (entry.event === null) {
			candidates.push(entry); // corrupt lines always leave the window
		} else if (!retainedSet.has(entry)) {
			candidates.push(entry);
		}
	}

	// Bounded work per pass (unless forceFull — close is not a hot path).
	const toFold = new Set<StoreLine>();
	let foldedBytes = 0;
	for (const cand of candidates) {
		const cb = Buffer.byteLength(cand.line) + 1;
		if (
			!forceFull &&
			foldedBytes + cb > _internals.limits.compactMaxBytes &&
			toFold.size > 0
		) {
			break;
		}
		toFold.add(cand);
		foldedBytes += cb;
	}

	// FOLD-TIME AUTHORITY INDEXING (C1 invariant): index every authority line
	// BEFORE it leaves the window. A corrupt prior index is rebuilt from
	// empty here (its old entries are unreadable; retained lines remain
	// answerable via the window-scan fallback).
	const indexKeys: string[] = [];
	for (const cand of toFold) {
		if (cand.event !== null) {
			const key = authorityKeyFor(cand.event);
			if (key) indexKeys.push(key);
		}
	}
	if (indexKeys.length > 0) {
		mergeAuthorityKeys(directory, loadAuthorityIndex(directory), indexKeys);
	}

	const agePrunedSet = new Set(agePruned);
	let dropped = 0;
	for (const cand of toFold) {
		if (cand.event === null) {
			folded.corrupt += 1;
		} else {
			foldLineInto(folded, cand.event);
			if (agePrunedSet.has(cand)) dropped += 1;
		}
	}
	folded.dropped += dropped;
	folded.corrupt += view.corruptLines;

	const finalRetained: StoreLine[] = [];
	for (const entry of view.lines) {
		if (!toFold.has(entry)) finalRetained.push(entry);
	}

	const manifest: CoreEventManifest = {
		...emptyManifest(),
		folded,
		updatedAt: new Date().toISOString(),
	};
	const outLines = [`${JSON.stringify(manifest)}`];
	for (const entry of finalRetained) outLines.push(entry.line);
	atomicReplace(
		directory,
		outLines.length > 1 ? `${outLines.join('\n')}\n` : `${outLines[0]}\n`,
	);

	emitHealth(directory, {
		trigger,
		accepted: folded.totalEvents + finalRetained.length,
		compacted: toFold.size - dropped,
		retained: finalRetained.length,
		dropped,
		corrupt: folded.corrupt,
		oldest: folded.oldestTimestamp,
		newest: folded.newestTimestamp,
		bytes: fileSizeOrZero(filePath),
		limitBytes: _internals.limits.activeMaxBytes,
	});
}

/** External compaction trigger (diagnose maintenance). Fail-open. */
export function compactCoreEvents(directory: string): void {
	try {
		withCoreEventStoreLock(directory, () => {
			foldPass(directory, 'compaction', false);
		});
	} catch {
		warnThrottled('maintenance pass failed');
	}
}

/** Throttled maintenance dispatch (append path). Converges an over-budget
 *  store with bounded repeated fold passes (a single 512 KiB pass cannot
 *  drain a large overshoot, and the counter fires per LINE — a 1,000-event
 *  batch must not count as one append). */
function runMaintenance(directory: string): void {
	try {
		const filePath = eventsFilePath(directory);
		if (!_internals.existsSync(filePath)) return;
		const drainThreshold =
			_internals.limits.activeMaxBytes +
			_internals.limits.headerMaxBytes +
			2048;
		withCoreEventStoreLock(directory, () => {
			// First pass is unconditional: it enforces the ENTRY/AGE budgets
			// (which a size check cannot see) and folds the bounded slice.
			foldPass(directory, 'compaction', false);
			// Converge a size overshoot with additional bounded passes.
			let prevSize = Number.POSITIVE_INFINITY;
			for (let pass = 0; pass < 64; pass += 1) {
				const size = fileSizeOrZero(filePath);
				if (size <= drainThreshold) break;
				if (size >= prevSize) break; // no progress — next tick resumes
				prevSize = size;
				foldPass(directory, 'compaction', false);
			}
			return true;
		});
	} catch {
		warnThrottled('maintenance pass failed');
	}
}

/**
 * Close finalize (issue #2039 requirement 5): under one lock acquisition,
 * drain any legacy header-less file to convergence and fold the remaining
 * window into a defined, VALIDATED cut (the atomicReplace pre-rename
 * validation), which `/swarm close` then archives. Fail-open: never throws
 * to the close pipeline.
 */
export function finalizeCoreEventsForClose(directory: string): void {
	try {
		const filePath = eventsFilePath(directory);
		if (!_internals.existsSync(filePath)) return;
		withCoreEventStoreLock(directory, () => {
			let prev = Number.POSITIVE_INFINITY;
			for (let pass = 0; pass < 10_000; pass += 1) {
				const view = readStoreFull(directory);
				if (view.manifest !== null) break;
				if (view.lines.length === 0) break;
				if (view.lines.length >= prev) break; // no progress — bail
				prev = view.lines.length;
				foldPass(directory, 'close', false);
			}
			foldPass(directory, 'close', true);
			return true;
		});
	} catch {
		warnThrottled('finalize failed');
	}
}

// ---------------------------------------------------------------------------
// Health emission (counts only — no event content, no paths)
// ---------------------------------------------------------------------------

function emitCoreEventsHealth(
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
	let authorityCount = 0;
	let authorityEvicted = 0;
	const state = loadAuthorityIndex(directory);
	if (state.kind === 'ok') {
		authorityCount = Object.keys(state.index.entries).length;
		authorityEvicted = state.index.evicted;
	}
	try {
		telemetry.coreEventsHealth({
			trigger: payload.trigger,
			accepted_count: payload.accepted,
			compacted_count: payload.compacted,
			retained_count: payload.retained,
			dropped_count: payload.dropped,
			corrupt_count: payload.corrupt,
			authority_index_count: authorityCount,
			authority_evicted_count: authorityEvicted,
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

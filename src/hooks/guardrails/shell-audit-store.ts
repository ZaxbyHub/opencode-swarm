/**
 * Shell-audit bounded store — the single append seam and bounded store for
 * `.swarm/session/shell-audit.jsonl` (issue #2040, Observability PR 12/23).
 *
 * HISTORY: the guardrail decision audit was a fire-and-forget append-only
 * JSONL with NO byte/age/count ceiling, no locking, no torn-tail handling,
 * and one whole-file reader (`/swarm guardrail-log` read the entire file
 * before filtering) — unbounded growth and unbounded read memory in long
 * sessions.
 *
 * NOW it is a BOUNDED single-file store in the `src/events/core-events.ts`
 * (#2039) house pattern, with SECURITY-AUDIT retention defined separately
 * from general events (issue #2040 requirement 1):
 *
 *   Line 1:  `swarm-shell-audit-manifest` header carrying the size-bounded
 *            FOLDED aggregate (decisions compacted away: lifetime total,
 *            per-type counts ≤16 keys + "other", corrupt/dropped counters).
 *   Line 2+: raw decision JSONL — the RECENT retained window, byte-for-byte
 *            preserved (the store never normalizes producer lines; legacy
 *            5-field shell entries stay legacy).
 *
 * DECISION-CLASS PRIORITY (issue #2040 requirement 2):
 *   - SECURITY class — every typed entry (file_write, scope_violation,
 *     destructive_block, sandbox_wrap, sandbox_skip): never AGE-folded.
 *   - ALLOWED class — legacy no-`type` shell entries: age-folded past
 *     allowedAgeMaxMs and held to their own tighter count cap.
 *   - The byte ceiling (activeMaxBytes) is SOVEREIGN over both classes:
 *     when it binds, the oldest lines fold regardless of class, disclosed
 *     via the folded per-type counts and shell_audit_health. Retention
 *     NEVER alters guardrail authorization — this store is write-only
 *     telemetry; enforcement decisions are computed and thrown by the
 *     guardrail hooks independently of any append succeeding.
 *
 * CONCURRENCY: every write (append, fold, finalize) holds the exclusive
 * `.swarm/session/shell-audit.lock` (`wx` create, stale-broken after
 * 5 minutes) — there are no lockless writes.
 *
 * LEGACY MIGRATION: header-less files are read as-is (the manifest is
 * stripped only when line 1 parses as one); the first throttled maintenance
 * fold rewrites them manifest-first in bounded compactMaxBytes passes;
 * close finalize drains to convergence. A crash mid-migration leaves either
 * form, both readable.
 *
 * All functions are synchronous (house pattern). The `_internals` DI seam
 * lets tests override filesystem operations and limits without `mock.module`
 * (AGENTS.md invariant 7). State lives exclusively under `.swarm/session/`
 * (invariant 4) — every function takes an explicit project-root `directory`.
 * No `bun:` imports — Node-ESM-loadable (invariant 2).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { observeStoreHealth } from '../../health/learning-health.js';
import { telemetry } from '../../telemetry.js';
import { warn } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Hard limits (issue #2040). Exported so tests can override small budgets via
// `_internals.limits` and restore in `afterEach`. Documented constants, not
// user config keys (the #2037/#2039/#2347 precedent).
// ---------------------------------------------------------------------------

export interface ShellAuditLimits {
	/** Hard ceiling on the retained window (manifest line + decision lines). */
	activeMaxBytes: number;
	/** Hard ceiling on retained SECURITY-class (typed) decision lines. */
	securityMaxEntries: number;
	/** Hard ceiling on retained ALLOWED-class (legacy shell) decision lines. */
	allowedMaxEntries: number;
	/** ALLOWED-class retention age; older allowed decisions fold into the header. */
	allowedAgeMaxMs: number;
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
	/** Serialized single-decision bound; larger appends fail with a typed error. */
	maxLineBytes: number;
	/** Raw command truncation bound applied at line-shaping time. */
	maxCommandChars: number;
	/** Free-text (reason) truncation bound applied at line-shaping time. */
	maxReasonChars: number;
	/**
	 * Hard bound on any single whole-file store read. A legacy header-less
	 * file larger than this migrates through the bounded STREAMING reader
	 * (chunked line folding) instead of being materialized whole (review
	 * round RC-2: the legacy path is exactly the file that lacks the
	 * activeMaxBytes ceiling).
	 */
	migrationMaxBytes: number;
}

export const SHELL_AUDIT_LIMITS: ShellAuditLimits = {
	// Security audit keeps a smaller window than the general event bus: the
	// diagnostic reader only ever needs the recent window (readMaxBytes) and
	// lifetime totals live in the manifest header.
	activeMaxBytes: 1024 * 1024,
	securityMaxEntries: 4_000,
	allowedMaxEntries: 2_000,
	// Session-scoped file (archived+cleaned at close); the age cap defends
	// long/stuck sessions where allowed shell decisions would otherwise pin
	// the window forever (security decisions are exempt — they never age out).
	allowedAgeMaxMs: 72 * 60 * 60 * 1000,
	compactMaxBytes: 256 * 1024,
	readMaxBytes: 256 * 1024,
	checkInterval: 25,
	warnCooldownMs: 60_000,
	headerMaxBytes: 16 * 1024,
	maxLineBytes: 64 * 1024,
	maxCommandChars: 4_096,
	maxReasonChars: 1_024,
	migrationMaxBytes: 8 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Decision classes (issue #2040 requirement 2)
// ---------------------------------------------------------------------------

export type ShellAuditDecisionClass = 'security' | 'allowed';

/**
 * The retention class of a decision line. SECURITY covers every typed entry
 * (the five decision types with a `type` discriminator — blocks, violations,
 * sandbox transitions); ALLOWED covers legacy no-`type` shell entries. The
 * discriminator used for folded per-type counts is the `type` field when
 * present, `shell` otherwise.
 */
function decisionClassOf(
	event: Record<string, unknown>,
): ShellAuditDecisionClass {
	return typeof event.type === 'string' && event.type.length > 0
		? 'security'
		: 'allowed';
}

function decisionDiscriminator(event: Record<string, unknown>): string {
	if (typeof event.type === 'string' && event.type.length > 0) {
		return event.type.slice(0, 64);
	}
	return 'shell';
}

function decisionTimestamp(event: Record<string, unknown>): string | null {
	// Decisions use `ts` (ISO string). Lines without a parseable timestamp are
	// never age-pruned, only budget-pruned.
	if (typeof event.ts !== 'string') return null;
	const ts = Date.parse(event.ts);
	return Number.isNaN(ts) ? null : event.ts;
}

// ---------------------------------------------------------------------------
// Manifest (header) shape
// ---------------------------------------------------------------------------

const MANIFEST_TYPE = 'swarm-shell-audit-manifest';
const MANIFEST_SCHEMA = 1;

/** Size-bounded folded aggregate persisted in the manifest header. FOLDED-ONLY:
 *  decisions compacted/cut away from the retained window. Retained decisions
 *  are NOT in here. Lifetime totals = folded + retained. */
export interface ShellAuditFolded {
	totalDecisions: number;
	/** Per-discriminator counts, capped at 16 distinct keys + "other". */
	byType: Record<string, number>;
	corrupt: number;
	dropped: number;
	oldestTimestamp: string | null;
	newestTimestamp: string | null;
}

export interface ShellAuditManifest {
	v: 1;
	type: 'swarm-shell-audit-manifest';
	schemaVersion: number;
	folded: ShellAuditFolded;
	updatedAt: string;
}

const BY_TYPE_MAX_KEYS = 16;
const BY_TYPE_OTHER = '__other__';

function emptyFolded(): ShellAuditFolded {
	return {
		totalDecisions: 0,
		byType: {},
		corrupt: 0,
		dropped: 0,
		oldestTimestamp: null,
		newestTimestamp: null,
	};
}

function emptyManifest(): ShellAuditManifest {
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
 * with `type === 'swarm-shell-audit-manifest'` and the full v/schemaVersion/
 * folded shape matches. No decision producer ever wrote this discriminator.
 */
function parseManifestLine(line: string): ShellAuditManifest | null {
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
		manifest.folded.totalDecisions = num(f.totalDecisions);
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
	limits: SHELL_AUDIT_LIMITS,
	emitHealth: emitShellAuditHealth,
} as const;

// ---------------------------------------------------------------------------
// Paths — the ONLY place the literal is constructed (usage-ratchet seam)
// ---------------------------------------------------------------------------

export function shellAuditFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'session', 'shell-audit.jsonl');
}

function lockFilePath(directory: string): string {
	return path.join(directory, '.swarm', 'session', 'shell-audit.lock');
}

function tmpPathFor(finalPath: string): string {
	// PID-scoped so concurrent processes never collide on one temp name.
	return `${finalPath}.${process.pid}.tmp`;
}

// ---------------------------------------------------------------------------
// Coverage + read payload types
// ---------------------------------------------------------------------------

export type ShellAuditCoverage = 'complete' | 'truncated' | 'empty';

/** The bounded view of the retained window. `text` is manifest-stripped
 *  decision lines in append order (never starting mid-line). */
export interface ShellAuditReadResult {
	text: string;
	truncated: boolean;
	coverage: ShellAuditCoverage;
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
 *  crash-torn final line. */
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

function foldLineInto(
	folded: ShellAuditFolded,
	event: Record<string, unknown>,
): void {
	folded.totalDecisions += 1;
	const key = decisionDiscriminator(event);
	const keys = Object.keys(folded.byType);
	if (folded.byType[key] !== undefined || keys.length < BY_TYPE_MAX_KEYS) {
		folded.byType[key] = (folded.byType[key] ?? 0) + 1;
	} else {
		folded.byType[BY_TYPE_OTHER] = (folded.byType[BY_TYPE_OTHER] ?? 0) + 1;
	}
	const ts = decisionTimestamp(event);
	if (ts !== null) {
		if (folded.oldestTimestamp === null || ts < folded.oldestTimestamp) {
			folded.oldestTimestamp = ts;
		}
		if (folded.newestTimestamp === null || ts > folded.newestTimestamp) {
			folded.newestTimestamp = ts;
		}
	}
}

function cloneFolded(folded: ShellAuditFolded): ShellAuditFolded {
	return {
		totalDecisions: folded.totalDecisions,
		byType: { ...folded.byType },
		corrupt: folded.corrupt,
		dropped: folded.dropped,
		oldestTimestamp: folded.oldestTimestamp,
		newestTimestamp: folded.newestTimestamp,
	};
}

// ---------------------------------------------------------------------------
// Atomic single-file publish (manifest + window)
// ---------------------------------------------------------------------------

/**
 * Atomically replace the store file (write PID-scoped tmp + rename). The
 * composed content is validated IN MEMORY first (manifest round-trips; every
 * non-manifest line JSON-parses; final newline present) and the written tmp
 * is byte-verified against the composed buffer before the rename — the old
 * file is never replaced by an unverified buffer.
 */
function atomicReplace(directory: string, content: string): void {
	// Pre-rename validation.
	const lines = content.split('\n');
	if (lines.length < 2 || lines[lines.length - 1] !== '') {
		throw new Error('shell-audit atomic replace failed (framing)');
	}
	if (parseManifestLine(lines[0] ?? '') === null) {
		throw new Error('shell-audit atomic replace failed (manifest)');
	}
	for (let i = 1; i < lines.length - 1; i += 1) {
		const line = lines[i]!;
		if (line.trim() === '') continue;
		JSON.parse(line); // throws => abort before touching the file
	}

	const finalPath = shellAuditFilePath(directory);
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
		renameSyncWithRetry(tmpPath, finalPath);
	} catch {
		try {
			if (_internals.existsSync(tmpPath)) {
				_internals.unlinkSync(tmpPath);
			}
		} catch {
			/* ignore */
		}
		throw new Error('shell-audit atomic replace failed');
	}
}

// ---------------------------------------------------------------------------
// Lock — the ONLY lock on this store
// ---------------------------------------------------------------------------

const LOCK_RETRY_ATTEMPTS = 20;
const LOCK_RETRY_DELAY_MS = 5;
const LOCK_STALE_MS = 5 * 60_000;

/** Bounded synchronous sleep (Atomics.wait with a bounded busy-wait fallback —
 *  the core-events / atomic-write.ts precedent). */
const sleepScratch = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms: number): void {
	try {
		Atomics.wait(sleepScratch, 0, 0, ms);
	} catch {
		const start = _internals.now();
		while (_internals.now() - start < ms) {
			/* bounded busy-wait fallback */
		}
	}
}

// Windows AV scanners transiently hold new files, making the tmp→final rename
// fail with EPERM/EBUSY/EACCES (and EEXIST for clobbered tmp names). Mirrors
// src/utils/atomic-write.ts RENAME_RETRY_DELAYS_MS/RETRYABLE_RENAME_CODES.
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

/** Rename with the bounded retryable-delay loop (atomic-write precedent). */
function renameSyncWithRetry(fromPath: string, toPath: string): void {
	let lastError: unknown;
	for (
		let attempt = 0;
		attempt <= RENAME_RETRY_DELAYS_MS.length;
		attempt += 1
	) {
		try {
			_internals.renameSync(fromPath, toPath);
			return;
		} catch (err) {
			lastError = err;
			const code = (err as NodeJS.ErrnoException)?.code;
			if (!code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
			if (attempt < RENAME_RETRY_DELAYS_MS.length) {
				syncSleep(RENAME_RETRY_DELAYS_MS[attempt]);
			}
		}
	}
	throw lastError;
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

export interface ShellAuditStoreLock {
	/** Release the lock (idempotent). */
	release: () => void;
}

/**
 * Acquire the exclusive store lock with a brief bounded retry, then run `fn`
 * while holding it. Returns null when the lock stays contended for the whole
 * retry window — callers map that onto their existing error contract (the
 * audit append path is fail-open: catch + debug log, never block the tool).
 */
export function withShellAuditStoreLock<T>(
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
// Maintenance state (module-scoped counters — bounded integers, invariant 8
// has no session-keyed data here by design: the store itself is the
// per-project state and the counters are process-wide append throttle state)
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
	warn(`shell-audit: ${message}`);
}

// ---------------------------------------------------------------------------
// Store view (maintenance path — reads the whole CURRENT store, exactly like
// the #2039 honest-work model: the store is bounded at activeMaxBytes so the
// maintenance read is bounded; PUBLIC reads are tail-bounded independently).
// ---------------------------------------------------------------------------

interface StoreLine {
	line: string;
	event: Record<string, unknown> | null; // null = corrupt
}

interface StoreView {
	manifest: ShellAuditManifest | null;
	lines: StoreLine[]; // decision lines only (manifest excluded), append order
	corruptLines: number;
	/**
	 * Aggregate already folded at READ time by the bounded streaming legacy
	 * reader (RC-2): when a header-less legacy file exceeds
	 * migrationMaxBytes, its oldest lines are folded chunk-by-chunk without
	 * materializing the whole file, and foldPass merges this aggregate into
	 * the manifest it writes. Null on every normal (bounded) read.
	 */
	prefixFolded: ShellAuditFolded | null;
}

const EMPTY_VIEW: StoreView = {
	manifest: null,
	lines: [],
	corruptLines: 0,
	prefixFolded: null,
};

/**
 * Bounded streaming read for an oversized LEGACY (header-less) file (RC-2):
 * walks the file forward in chunks, folding every complete line outside the
 * newest retained window into `prefixFolded` without ever holding more than
 * the retained window + one chunk in memory. The returned view has
 * manifest === null; foldPass treats the retained lines exactly like a
 * normal legacy migration and merges prefixFolded into the manifest it
 * writes, so the first maintenance/finalize pass rewrites the file down to
 * the bounded manifest+window layout with lifetime counters preserved.
 */
function streamLegacyStore(filePath: string): StoreView {
	const size = fileSizeOrZero(filePath);
	const prefixFolded = emptyFolded();
	const retained: StoreLine[] = [];
	let retainedBytes = 0;
	const windowBudget =
		_internals.limits.activeMaxBytes + _internals.limits.headerMaxBytes;
	const chunkBytes = Math.min(
		512 * 1024,
		Math.max(1 * 1024, _internals.limits.compactMaxBytes * 2),
	);
	/** Fold-or-retain one complete line under the window budget. */
	const ingest = (line: string): void => {
		if (line.trim() === '') return;
		let event: Record<string, unknown> | null = null;
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				event = parsed as Record<string, unknown>;
			}
		} catch {
			/* corrupt */
		}
		if (event === null) {
			prefixFolded.corrupt += 1;
			return;
		}
		const lineBytes = Buffer.byteLength(line) + 1;
		if (retainedBytes + lineBytes > windowBudget && retained.length > 0) {
			const oldest = retained.shift()!;
			retainedBytes -= Buffer.byteLength(oldest.line) + 1;
			foldLineInto(prefixFolded, oldest.event!);
		}
		retained.push({ line, event });
		retainedBytes += lineBytes;
	};

	// Final-critic round: read RAW bytes and decode through a StringDecoder
	// so a multibyte UTF-8 sequence straddling a chunk boundary is buffered
	// and reassembled, never replaced with U+FFFD, and the offset advances by
	// the bytes actually read (the previous decoded-length advance skipped
	// continuation bytes on every straddle).
	let offset = 0;
	let carry = '';
	const decoder = new StringDecoder('utf-8');
	const fd = _internals.openSync(filePath, 'r');
	try {
		const buf = Buffer.alloc(chunkBytes);
		for (;;) {
			const n = _internals.readSync(fd, buf, 0, chunkBytes, offset);
			if (n <= 0) break;
			offset += n;
			const decoded = decoder.write(buf.subarray(0, n));
			const parts = `${carry}${decoded}`.split('\n');
			carry = parts.pop() ?? ''; // partial tail line carries forward
			for (const line of parts) ingest(line);
			if (offset >= size) break;
		}
	} finally {
		_internals.closeSync(fd);
	}
	// Flush any decoder residue (incomplete final sequence) into the carry
	// before treating it as the file's last line.
	const residue = decoder.end();
	if (residue !== '') carry += residue;
	// A final unterminated tail line is still a complete decision record.
	if (carry.trim() !== '') ingest(carry);
	return { manifest: null, lines: retained, corruptLines: 0, prefixFolded };
}

function readStoreFull(directory: string): StoreView {
	const filePath = shellAuditFilePath(directory);
	if (!_internals.existsSync(filePath)) {
		return EMPTY_VIEW;
	}
	// Oversized legacy files (the only inputs lacking the activeMaxBytes
	// ceiling) migrate through the bounded streaming reader (RC-2).
	if (fileSizeOrZero(filePath) > _internals.limits.migrationMaxBytes) {
		return streamLegacyStore(filePath);
	}
	let text: string;
	try {
		text = _internals.readFileSync(filePath, 'utf-8');
	} catch {
		return EMPTY_VIEW;
	}
	const rawLines = text.split('\n');
	const lines: StoreLine[] = [];
	let corruptLines = 0;
	let manifest: ShellAuditManifest | null = null;
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
	return { manifest, lines, corruptLines, prefixFolded: null };
}

// ---------------------------------------------------------------------------
// Public bounded reads
// ---------------------------------------------------------------------------

function coverageFor(
	fileExists: boolean,
	lineCount: number,
	truncated: boolean,
): ShellAuditCoverage {
	if (!fileExists || lineCount === 0) return 'empty';
	return truncated ? 'truncated' : 'complete';
}

/**
 * Bounded read of the retained window: the newest `readMaxBytes` of decision
 * lines, manifest-stripped, in append order. `truncated` means older history
 * exists beyond the read bound (a legacy header-less file larger than the
 * bound, or a store mid-drain) — callers disclose it, never silently treat
 * the window as complete history.
 */
export function readShellAuditTail(
	directory: string,
	maxBytes?: number,
): ShellAuditReadResult {
	const bound = Math.max(
		1024,
		Math.min(
			maxBytes ?? _internals.limits.readMaxBytes,
			_internals.limits.readMaxBytes,
		),
	);
	const filePath = shellAuditFilePath(directory);
	if (!_internals.existsSync(filePath)) {
		return { text: '', truncated: false, coverage: 'empty' };
	}
	// TAIL read: the diagnostic reader wants the NEWEST decisions. When the
	// file exceeds the bound, read the last `bound` bytes and drop the torn
	// partial line the cut creates at the head of the chunk.
	// RC-3: the outer stat can go stale if an atomicReplace lands between the
	// stat and the chunk read — when the truncated read comes back EMPTY,
	// retry the whole stat+read once against the current file instead of
	// reporting an empty window for a store that just got smaller.
	let size = fileSizeOrZero(filePath);
	let truncated = size > bound;
	let offset = truncated ? Math.max(0, size - bound) : 0;
	let text = readBoundedChunk(filePath, bound, offset).text;
	if (truncated && text === '') {
		size = fileSizeOrZero(filePath);
		truncated = size > bound;
		offset = truncated ? Math.max(0, size - bound) : 0;
		text = readBoundedChunk(filePath, bound, offset).text;
	}
	if (truncated) {
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
	const decisionLineCount = text
		.split('\n')
		.filter((l) => l.trim() !== '').length;
	// A manifest-present store with an empty retained window (everything
	// folded) is a REAL store with history, not an absent one — report
	// 'complete' rather than 'empty'.
	const coverage: ShellAuditCoverage =
		start === 1
			? truncated
				? 'truncated'
				: 'complete'
			: coverageFor(true, decisionLineCount, truncated);
	return { text, truncated, coverage };
}

/** Manifest folded summary via a header-only bounded read (null when the file
 *  is absent or still header-less/legacy). */
export function getShellAuditFoldedSummary(
	directory: string,
): ShellAuditFolded | null {
	const filePath = shellAuditFilePath(directory);
	if (!_internals.existsSync(filePath)) return null;
	const head = readBoundedChunk(
		filePath,
		_internals.limits.headerMaxBytes + 64,
	);
	const manifest = parseManifestLine(head.text.split('\n')[0] ?? '');
	return manifest ? manifest.folded : null;
}

// ---------------------------------------------------------------------------
// Append seam
// ---------------------------------------------------------------------------

/** Typed store-busy error — the audit append path maps it onto its existing
 *  fail-open contract (catch + debug log; never block the tool call). */
export const SHELL_AUDIT_STORE_LOCKED = 'SHELL_AUDIT_STORE_LOCKED';
export const SHELL_AUDIT_LINE_TOO_LARGE = 'SHELL_AUDIT_LINE_TOO_LARGE';

/**
 * Append one serialized decision line to the store through the canonical
 * seam. The caller (audit-log.ts) has already validated the entry shape and
 * applied write-time redaction; this function owns framing, locking, and
 * retention.
 *
 * - Holds the store lock for the write; re-establishes line framing when a
 *   prior crash tore the tail (newline prefix).
 * - First write on a fresh store is atomic (manifest + one line) so a crash
 *   can never leave a torn header at line 1.
 * - A legacy header-less file is appended to as-is; the throttled maintenance
 *   pass migrates it manifest-first in bounded passes.
 * - Runs throttled maintenance (bounded compaction / legacy drain) every
 *   `checkInterval` appends, after the lock is released.
 *
 * Throws `SHELL_AUDIT_STORE_LOCKED` after bounded lock retry, or
 * `SHELL_AUDIT_LINE_TOO_LARGE` for oversized lines — the audit append path
 * catches both and logs non-fatally (logging failure never blocks a tool).
 */
export function appendShellAuditLineSync(
	directory: string,
	line: string,
): void {
	if (Buffer.byteLength(line) - 1 > _internals.limits.maxLineBytes) {
		throw new Error(SHELL_AUDIT_LINE_TOO_LARGE);
	}
	const filePath = shellAuditFilePath(directory);
	const sessionDir = path.join(directory, '.swarm', 'session');
	_internals.mkdirSync(sessionDir, { recursive: true });
	const wrote = withShellAuditStoreLock(directory, () => {
		if (!_internals.existsSync(filePath)) {
			// First write is atomic (header + one decision) so a crash can
			// never leave a torn header at line 1.
			const manifest = emptyManifest();
			atomicReplace(directory, `${JSON.stringify(manifest)}\n${line}`);
		} else {
			// Re-establish line framing if a prior crash tore the tail.
			const prefix = fileEndsWithNewline(filePath) ? '' : '\n';
			_internals.appendFileSync(filePath, `${prefix}${line}`, 'utf-8');
		}
		// RC-4: the byte ceiling binds at APPEND time, not only at the
		// throttled maintenance tick. Under the same lock, an over-ceiling
		// store folds immediately (one bounded pass re-establishes the
		// manifest+window bound) — the overshoot never survives the append.
		if (
			fileSizeOrZero(filePath) >
			_internals.limits.activeMaxBytes + _internals.limits.headerMaxBytes
		) {
			foldPass(directory, 'compaction', false);
		}
		return 'appended';
	});
	if (wrote === null) {
		throw new Error(SHELL_AUDIT_STORE_LOCKED);
	}
	if (shouldRunMaintenance()) {
		runMaintenance(directory);
	}
}

// ---------------------------------------------------------------------------
// Maintenance — compaction + bounded legacy cutover
// ---------------------------------------------------------------------------

/**
 * Shared fold pass. Folds at most compactMaxBytes of the oldest
 * non-retained lines into the manifest aggregate. `forceFull` folds
 * everything non-retained (close finalize). Atomic validated rewrite.
 *
 * Priority policy (issue #2040 requirement 2):
 *  1. AGE pass — ALLOWED-class (legacy shell) lines older than
 *     allowedAgeMaxMs fold; SECURITY-class (typed) lines are exempt; corrupt
 *     lines always fold (counted corrupt).
 *  2. BUDGET pass — the NEWEST lines that fit the per-class count caps and
 *     the sovereign activeMaxBytes byte ceiling are retained, scanning
 *     newest→oldest; class count-cap overflow skips that line (older lines
 *     of the OTHER class can still claim budget) while byte-cap overflow
 *     stops the scan (everything older folds).
 */
function foldPass(
	directory: string,
	trigger: 'compaction' | 'close',
	forceFull: boolean,
): void {
	const filePath = shellAuditFilePath(directory);
	if (!_internals.existsSync(filePath)) return;

	const view = readStoreFull(directory);
	// F12: a legacy file containing ONLY corrupt lines still migrates — the
	// rewrite below gives it a manifest header counting the corruption, so
	// close finalizes/bounds it instead of leaving it untouched.
	if (
		view.manifest === null &&
		view.lines.length === 0 &&
		view.corruptLines === 0 &&
		view.prefixFolded === null
	) {
		return;
	}
	const folded = view.manifest
		? cloneFolded(view.manifest.folded)
		: emptyFolded();
	// Merge the streaming reader's already-folded prefix (RC-2 oversized
	// legacy migration) so lifetime counters survive the cutover.
	if (view.prefixFolded !== null) {
		folded.totalDecisions += view.prefixFolded.totalDecisions;
		for (const [k, v] of Object.entries(view.prefixFolded.byType)) {
			folded.byType[k] = (folded.byType[k] ?? 0) + v;
		}
		folded.corrupt += view.prefixFolded.corrupt;
		folded.dropped += view.prefixFolded.dropped;
		if (
			view.prefixFolded.oldestTimestamp !== null &&
			(folded.oldestTimestamp === null ||
				view.prefixFolded.oldestTimestamp < folded.oldestTimestamp)
		) {
			folded.oldestTimestamp = view.prefixFolded.oldestTimestamp;
		}
		if (
			view.prefixFolded.newestTimestamp !== null &&
			(folded.newestTimestamp === null ||
				view.prefixFolded.newestTimestamp > folded.newestTimestamp)
		) {
			folded.newestTimestamp = view.prefixFolded.newestTimestamp;
		}
	}
	const now = _internals.now();

	// Age partition (allowed class only; security class is exempt).
	// NOTE: `event === null` (corrupt) branches below are defensive parity
	// with the #2039 foldPass — readStoreFull currently excludes corrupt
	// lines from `view.lines` (counting them in corruptLines instead), so
	// they cannot fire today; they keep this fold structurally identical to
	// the core-events precedent should the store view ever change.
	const agePruned = new Set<StoreLine>();
	const kept: StoreLine[] = [];
	for (const entry of view.lines) {
		if (entry.event === null) {
			agePruned.add(entry); // corrupt lines always fold (counted corrupt)
			continue;
		}
		if (decisionClassOf(entry.event) === 'security') {
			kept.push(entry);
			continue;
		}
		const ts = decisionTimestamp(entry.event);
		if (
			ts !== null &&
			now - Date.parse(ts) > _internals.limits.allowedAgeMaxMs
		) {
			agePruned.add(entry);
		} else {
			kept.push(entry);
		}
	}

	// Retain the NEWEST kept lines that fit the per-class count caps and the
	// sovereign byte ceiling, oldest-first folding for the rest.
	// (+1 for the manifest line's own trailing newline — review round PRR-020e.)
	const retained: StoreLine[] = [];
	let securityCount = 0;
	let allowedCount = 0;
	let bytes =
		Buffer.byteLength(JSON.stringify(view.manifest ?? emptyManifest())) + 1;
	for (let i = kept.length - 1; i >= 0; i -= 1) {
		const entry = kept[i]!;
		const lineBytes = Buffer.byteLength(entry.line) + 1;
		if (bytes + lineBytes > _internals.limits.activeMaxBytes) {
			break; // byte ceiling is sovereign — everything older folds
		}
		const cls = decisionClassOf(entry.event!);
		if (cls === 'security') {
			if (securityCount >= _internals.limits.securityMaxEntries) {
				continue; // security count cap — skip, keep scanning
			}
			securityCount += 1;
		} else {
			if (allowedCount >= _internals.limits.allowedMaxEntries) {
				continue; // allowed count cap — skip, keep scanning
			}
			allowedCount += 1;
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

	let dropped = 0;
	for (const cand of toFold) {
		if (cand.event === null) {
			folded.corrupt += 1;
		} else {
			foldLineInto(folded, cand.event);
			if (agePruned.has(cand)) dropped += 1;
		}
	}
	folded.dropped += dropped;
	folded.corrupt += view.corruptLines;

	const finalRetained: StoreLine[] = [];
	for (const entry of view.lines) {
		if (!toFold.has(entry)) finalRetained.push(entry);
	}

	const manifest: ShellAuditManifest = {
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
		accepted: folded.totalDecisions + finalRetained.length,
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

/** External compaction trigger. Fail-open. */
export function compactShellAudit(directory: string): void {
	try {
		withShellAuditStoreLock(directory, () => {
			foldPass(directory, 'compaction', false);
			return true;
		});
	} catch {
		warnThrottled('maintenance pass failed');
	}
}

/** Throttled maintenance dispatch (append path). Converges an over-budget
 *  store with bounded repeated fold passes. */
function runMaintenance(directory: string): void {
	try {
		const filePath = shellAuditFilePath(directory);
		if (!_internals.existsSync(filePath)) return;
		const drainThreshold =
			_internals.limits.activeMaxBytes +
			_internals.limits.headerMaxBytes +
			2048;
		withShellAuditStoreLock(directory, () => {
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
 * Close finalize (issue #2040 requirement 7): under one lock acquisition,
 * drain any legacy header-less file to convergence and fold the remaining
 * window into a defined, VALIDATED cut (the atomicReplace pre-rename
 * validation), which `/swarm close` then archives as part of the session
 * directory copy. Fail-open: never throws to the close pipeline. Releasing
 * the lock also unlinks it, so a stale lock file is never archived.
 *
 * `options.lineTransform` (review round F4): when provided, every retained
 * decision line is passed through it before the final validated rewrite —
 * the close pipeline supplies the CURRENT redaction policy so a legacy
 * record with weaker pre-#2040 redaction cannot bypass it in the archived
 * cut ("re-redact at the archive boundary").
 */
export function finalizeShellAuditForClose(
	directory: string,
	options?: { lineTransform?: (line: string) => string },
): void {
	try {
		const filePath = shellAuditFilePath(directory);
		if (!_internals.existsSync(filePath)) return;
		withShellAuditStoreLock(directory, () => {
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
			// Archive-boundary re-redaction: transform retained lines under the
			// same lock, then republish a validated cut. Transform failures on
			// individual lines keep the original line (parse-safe passthrough
			// is the transform's own contract).
			const transform = options?.lineTransform;
			if (transform !== undefined) {
				const view = readStoreFull(directory);
				if (view.manifest !== null) {
					const manifest: ShellAuditManifest = {
						...view.manifest,
						folded: cloneFolded(view.manifest.folded),
						updatedAt: new Date().toISOString(),
					};
					const outLines = [`${JSON.stringify(manifest)}`];
					for (const entry of view.lines) outLines.push(transform(entry.line));
					try {
						atomicReplace(directory, `${outLines.join('\n')}\n`);
					} catch {
						warnThrottled('archive re-redaction rewrite failed');
					}
				}
			}
			return true;
		});
	} catch {
		warnThrottled('finalize failed');
	}
}

// ---------------------------------------------------------------------------
// Health emission (counts only — no commands, no paths, no agents)
// ---------------------------------------------------------------------------

function emitShellAuditHealth(
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
	try {
		const healthPayload = {
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
		};
		telemetry.shellAuditHealth(healthPayload);
		// #2044: direct learning-health feed from the FIRST store event.
		observeStoreHealth({
			directory,
			kind: 'shell_audit_health',
			payload: healthPayload,
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

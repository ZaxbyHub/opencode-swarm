/**
 * Durable twin of the Stage B dispatch-generation bindings (issue #2829).
 *
 * `stageBDispatchGenerationsByCallID` (src/hooks/delegation-gate.ts) is a
 * closure-local `Map<callID, Map<taskId, generation>>` written at dispatch
 * time and read at settlement time; a plugin reload or host restart between
 * the two loses it and every post-restart foreground settlement arrives
 * `unbound` and is dropped fail-closed (issue #2817). This store is the
 * durable twin: `rememberStageBDispatchGenerations` persists the binding at
 * dispatch, and the settlement path reconstructs it lazily — feeding the
 * EXISTING `expectedGeneration` fence (`transitionTaskWorkflowEvidence`), so
 * a stale binding dies on `TASK_WORKFLOW_GENERATION_MISMATCH` exactly as an
 * in-process stale one would (AGENTS.md invariant 9: never the reverse).
 *
 * Layout: `.swarm/stage-b-dispatch-bindings/<sha256(sessionID).slice(0,24)>/
 * <callID>.json` — the scope-persistence path convention (hashed owner,
 * scope-persistence.ts:327-330); the raw sessionID never touches the path.
 * Writes are `atomicWriteSwarmFileSync` (temp-then-rename; a crash leaves
 * either the old complete record or no new one — the crash-window rule).
 * Reads are fail-closed: ANY anomaly (missing, oversized, unparsable,
 * wrong-version, wrong identity, TTL-stale) yields `null`, which keeps
 * today's unbound drop. No lockfile: single writer per (sessionID, callID),
 * and last-write-wins is the correct semantics (a re-dispatch under the same
 * callID replaces the binding).
 */

import { createHash } from 'node:crypto';
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmdirSync,
	rmSync,
	lstatSync,
	statSync,
} from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';

export const STAGE_B_BINDING_SCHEMA_VERSION = 1;
export const STAGE_B_BINDINGS_DIR = 'stage-b-dispatch-bindings';
/** Mirrors the in-memory per-callID cap (delegation-gate.ts MAX_PENDING_CODER_CHANGE_CONTEXTS). */
export const MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR = 128;
/** Independently bounded session-dir ceiling: 128 × 128 × ~256 B ≈ 4 MB worst case. */
export const MAX_STAGE_B_BINDING_SESSION_DIRS = 128;
export const STAGE_B_BINDING_MAX_BYTES = 64 * 1024;
export const STAGE_B_BINDING_TTL_MS = 24 * 60 * 60 * 1000;
/** Cross-session sweep cadence: the per-write cost stays bounded to the owning session dir. */
export const STAGE_B_BINDING_SWEEP_INTERVAL_MS = 60_000;
/**
 * Explicit bound for the process-global sweep throttle (AGENTS.md invariant
 * 8): one timestamp per distinct project root, FIFO-evicted past this many —
 * realistic processes see a handful of roots, but the cap must be explicit.
 */
export const MAX_STAGE_B_SWEEP_THROTTLE_ROOTS = 32;

const lastSweepCompletedAtByRoot = new Map<string, number>();

/**
 * r14 audit repair (P1-8): per-session-dir monotonic write-order counter
 * backing the persisted `seq`. FIFO-bounded per AGENTS.md invariant 8
 * (realistic processes see a handful of active session dirs).
 */
const MAX_SEQ_TRACKED_SESSION_DIRS = 512;
const lastSeqBySessionDir = new Map<string, number>();

function allocateSeq(sessionDir: string): number {
	const last = lastSeqBySessionDir.get(sessionDir) ?? 0;
	// r15 (P5) — corrected claim: the counter is strictly increasing WITHIN
	// a process (the increment covers same-tick bursts where Date.now() is
	// constant and mtimes collide). It is NOT monotonic across restarts: a
	// same-tick burst can push seq above the wall clock (W, W+1, ... W+127),
	// and a restarted process (empty map) floors its first seq at
	// Date.now() — potentially BELOW surviving pre-restart seqs. The seq is
	// therefore only a coarse-mtime TIE-BREAKER in the eviction sort, never
	// a global order; mtime stays the primary recency signal.
	const next = Math.max(last + 1, Date.now());
	lastSeqBySessionDir.delete(sessionDir);
	lastSeqBySessionDir.set(sessionDir, next);
	while (lastSeqBySessionDir.size > MAX_SEQ_TRACKED_SESSION_DIRS) {
		const oldest = lastSeqBySessionDir.keys().next().value;
		if (oldest === undefined) break;
		lastSeqBySessionDir.delete(oldest);
	}
	return next;
}

function rememberSweepCompletedAt(storeRoot: string, now: number): void {
	// delete-then-set refreshes recency (Map insertion order = FIFO order).
	lastSweepCompletedAtByRoot.delete(storeRoot);
	lastSweepCompletedAtByRoot.set(storeRoot, now);
	while (lastSweepCompletedAtByRoot.size > MAX_STAGE_B_SWEEP_THROTTLE_ROOTS) {
		const oldest = lastSweepCompletedAtByRoot.keys().next().value;
		if (oldest === undefined) break;
		lastSweepCompletedAtByRoot.delete(oldest);
	}
}

const WINDOWS_RESERVED = new Set([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	'COM1',
	'COM2',
	'COM3',
	'COM4',
	'COM5',
	'COM6',
	'COM7',
	'COM8',
	'COM9',
	'LPT1',
	'LPT2',
	'LPT3',
	'LPT4',
	'LPT5',
	'LPT6',
	'LPT7',
	'LPT8',
	'LPT9',
]);

export interface StageBDispatchBinding {
	taskId: string;
	generation: number;
}

interface PersistedStageBBindings {
	schemaVersion: number;
	sessionID: string;
	callID: string;
	recordedAt: number;
	/**
	 * r14 audit repair (P1-8, baseline defect) — corrected by r15 (P5):
	 * per-session-dir write-order key. On coarse-granularity filesystems a
	 * burst of writes lands within one mtime tick, so the eviction sort needs
	 * a deterministic tie-break. `seq` is allocated per session dir as
	 * max(lastSeq + 1, Date.now()) — strictly increasing WITHIN a process
	 * (bursts included). It is NOT monotonic across restarts: a same-tick
	 * burst can outrun a restarted process's Date.now() floor, so
	 * post-restart records may carry LOWER seqs than surviving pre-restart
	 * records. The eviction sort therefore orders by mtime FIRST and uses
	 * `seq` only as the tie-break WITHIN one mtime tick. Optional on read
	 * for legacy records; such records sort oldest within their tick.
	 */
	seq?: number;
	bindings: StageBDispatchBinding[];
}

/** Path safety never depends on the raw sessionID (the path is always the hash); this rejects pathological inputs only. */
export function isRecordableSessionId(
	sessionID: string | undefined | null,
): sessionID is string {
	if (
		typeof sessionID !== 'string' ||
		sessionID.length === 0 ||
		sessionID.length > 256
	) {
		return false;
	}
	return !WINDOWS_RESERVED.has(sessionID.split('.')[0]!.toUpperCase());
}

/** Single safe path segment only (final-critic round-1 finding 1): a callID containing a separator would nest directories that escape both the cap and TTL pruning — reject it outright, exactly like a non-recordable sessionID. */
export function isRecordableCallId(
	callID: string | undefined | null,
): callID is string {
	if (
		typeof callID !== 'string' ||
		callID.length === 0 ||
		callID.length > 256
	) {
		return false;
	}
	if (
		callID.includes('/') ||
		callID.includes('\\') ||
		callID === '.' ||
		callID === '..'
	) {
		return false;
	}
	return !WINDOWS_RESERVED.has(callID.split('.')[0]!.toUpperCase());
}

/**
 * Public single source of the per-session directory name (PR review finding:
 * reset paths hand-rolled this derivation — any drift would silently purge the
 * wrong subtree). `_internals.sessionDirName` aliases this for tests.
 */
export function stageBSessionDirName(sessionID: string): string {
	return createHash('sha256').update(sessionID).digest('hex').slice(0, 24);
}

const sessionDirName = stageBSessionDirName;

function recordPath(
	directory: string,
	sessionID: string,
	callID: string,
): string {
	return validateSwarmPath(
		directory,
		`${STAGE_B_BINDINGS_DIR}/${sessionDirName(sessionID)}/${callID}.json`,
	);
}

/**
 * Persist the binding durably at dispatch time. NON-FATAL by design: the
 * in-memory map remains the primary fence; the durable twin only ADDS restart
 * recovery, so a transient fs failure degrades to today's behavior (logged,
 * debug-gated) instead of failing a working dispatch. `nowMs` is injectable
 * for tests.
 */
export function recordStageBDispatchBindings(
	directory: string,
	entry: {
		sessionID: string;
		callID: string;
		bindings: ReadonlyArray<StageBDispatchBinding>;
	},
	options: { nowMs?: () => number; forceSweep?: boolean } = {},
): boolean {
	const { sessionID, callID } = entry;
	if (!isRecordableSessionId(sessionID) || !isRecordableCallId(callID)) {
		return false;
	}
	const bindings = entry.bindings.filter(
		(b) =>
			b &&
			typeof b.taskId === 'string' &&
			b.taskId.length > 0 &&
			Number.isFinite(b.generation) &&
			b.generation >= 0 &&
			Number.isInteger(b.generation),
	);
	if (bindings.length === 0) return false;
	const nowMs = options.nowMs ?? Date.now;
	const target = recordPath(directory, sessionID, callID);
	const record: PersistedStageBBindings = {
		schemaVersion: STAGE_B_BINDING_SCHEMA_VERSION,
		sessionID,
		callID,
		recordedAt: nowMs(),
		// r14 (P1-8): true write-order key — mtime bursts collide on coarse
		// filesystems; seq keeps the cap eviction's LRU correct.
		seq: allocateSeq(path.dirname(target)),
		bindings: bindings.map((b) => ({
			taskId: b.taskId,
			generation: b.generation,
		})),
	};
	try {
		atomicWriteSwarmFileSync(target, JSON.stringify(record));
		// Per-dispatch cost stays bounded (review finding 3): only the OWNING
		// session's directory is stat'd/pruned on every write; the
		// cross-session sweep is throttled to at most one pass per sweep
		// interval. Both are injectable via nowMs for deterministic tests.
		// r14 (P1-8): the just-written record is PROTECTED from cap eviction —
		// with colliding mtimes the old sort could evict it immediately.
		pruneSessionDir(directory, sessionID, nowMs(), { protectPath: target });
		// Final-critic round-1 finding 2: the session-dir cap must be
		// enforced on EVERY write — the 60 s sweep throttle alone let new
		// session dirs accumulate unbounded between sweeps. One cheap
		// readdir of the store root decides; over the cap, the full sweep
		// runs immediately regardless of the throttle (and the throttle is
		// keyed per project root, so one project's activity never starves
		// another's sweep in a shared process).
		const storeRoot = validateSwarmPath(directory, STAGE_B_BINDINGS_DIR);
		let sessionDirCount = 0;
		try {
			sessionDirCount = readdirSync(storeRoot, { withFileTypes: true }).filter(
				(e) => e.isDirectory(),
			).length;
		} catch {
			sessionDirCount = 0;
		}
		const now = nowMs();
		const lastSweep = lastSweepCompletedAtByRoot.get(storeRoot);
		if (
			options.forceSweep ||
			sessionDirCount > MAX_STAGE_B_BINDING_SESSION_DIRS ||
			lastSweep === undefined ||
			now - lastSweep >= STAGE_B_BINDING_SWEEP_INTERVAL_MS
		) {
			rememberSweepCompletedAt(storeRoot, now);
			pruneStore(directory, now);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Validated read for the settlement path. Returns the record ONLY when every
 * check passes (version, identity, size, parse, TTL); any anomaly → null
 * (fail-closed to today's unbound drop — a partially-written record never
 * validates). The per-task lookup mirrors the in-memory shape:
 * `record.bindings.find((b) => b.taskId === taskId)?.generation`; a malformed
 * per-task entry is not-present for that task without invalidating the rest.
 */
export function readStageBDispatchBindings(
	directory: string,
	sessionID: string,
	callID: string,
	options: { nowMs?: () => number } = {},
): PersistedStageBBindings | null {
	if (!isRecordableSessionId(sessionID) || !isRecordableCallId(callID)) {
		return null;
	}
	let filePath: string;
	try {
		filePath = recordPath(directory, sessionID, callID);
	} catch {
		return null;
	}
	let fd: number | undefined;
	try {
		// O_NOFOLLOW mirrors the readScopeFromDisk precedent (scope-persistence):
		// a planted symlink at the record path fails here instead of being read.
		// On Windows the flag is undefined and `| undefined` coerces to a no-op.
		fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.size > STAGE_B_BINDING_MAX_BYTES) return null;
		const buffer = Buffer.alloc(stats.size);
		let read = 0;
		while (read < stats.size) {
			const n = readSync(fd, buffer, read, stats.size - read, null);
			if (n <= 0) break;
			read += n;
		}
		const parsed = JSON.parse(
			buffer.subarray(0, read).toString('utf-8'),
		) as PersistedStageBBindings;
		if (
			parsed.schemaVersion !== STAGE_B_BINDING_SCHEMA_VERSION ||
			parsed.sessionID !== sessionID ||
			parsed.callID !== callID ||
			!Array.isArray(parsed.bindings)
		) {
			return null;
		}
		// Per-entry shape validation: a tampered on-disk record carrying a
		// malformed binding (non-integer or negative generation, empty taskId)
		// yields null here — the read-side defense, so the gate's
		// reconstruction never sees a corrupt generation. (The write path
		// already filters these; whole-record null keeps the failure loud
		// instead of per-task silent not-present.)
		if (
			!parsed.bindings.every(
				(b) =>
					b &&
					typeof b.taskId === 'string' &&
					b.taskId.length > 0 &&
					Number.isInteger(b.generation) &&
					b.generation >= 0,
			)
		) {
			return null;
		}
		const nowMs = options.nowMs ?? Date.now;
		if (
			typeof parsed.recordedAt !== 'number' ||
			nowMs() - parsed.recordedAt > STAGE_B_BINDING_TTL_MS
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed or inaccessible — nothing to do
			}
		}
	}
}

/** Settlement/cleanup eviction: unlink the record; missing is a no-op. */
export function deleteStageBDispatchBindings(
	directory: string,
	sessionID: string,
	callID: string,
): void {
	// Defense-in-depth (PR review finding): validate callID exactly like the
	// record/read paths — a crafted separator-bearing callID must not resolve
	// into a sibling session's subtree just because it is only ever deleted.
	if (!isRecordableSessionId(sessionID) || !isRecordableCallId(callID)) {
		return;
	}
	try {
		const filePath = recordPath(directory, sessionID, callID);
		if (existsSync(filePath)) rmSync(filePath, { force: true });
	} catch {
		// best-effort eviction; TTL prune bounds stragglers
	}
}

/**
 * Bound the store: per-session-dir file cap (mirrors the in-memory callID
 * cap) + cross-session-dir cap (LRU by newest record) + TTL staleness.
 * Called opportunistically after each record; never throws into the caller.
 */
/**
 * Cross-session sweep: TTL prune every session dir + the 128-dir LRU
 * ceiling. Throttled to STAGE_B_BINDING_SWEEP_INTERVAL_MS per process
 * (review finding 3: the per-dispatch path stays bounded to the owning
 * session's directory). Never throws into the caller.
 */
export function pruneStore(directory: string, nowMs: number): void {
	const storeRoot = validateSwarmPath(directory, STAGE_B_BINDINGS_DIR);
	let sessionDirs: string[];
	try {
		sessionDirs = readdirSync(storeRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return;
	}
	const survivors: Array<{ name: string; newest: number }> = [];
	for (const dir of sessionDirs) {
		const pruned = pruneDirEntries(path.join(storeRoot, dir), nowMs);
		if (pruned) survivors.push({ name: pruned.dirPath, newest: pruned.newest });
	}
	const live = survivors.filter((s) => s.newest > 0);
	if (live.length > MAX_STAGE_B_BINDING_SESSION_DIRS) {
		const ordered = live.sort((a, b) => a.newest - b.newest);
		for (const old of ordered.slice(
			0,
			live.length - MAX_STAGE_B_BINDING_SESSION_DIRS,
		)) {
			try {
				rmSync(old.name, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	}
}

/** TTL + per-session file-cap prune of ONE session directory (the per-write path). */
export function pruneSessionDir(
	directory: string,
	sessionID: string,
	nowMs: number,
	options: { protectPath?: string } = {},
): { dirPath: string; newest: number } | null {
	let dirPath: string;
	try {
		dirPath = path.dirname(recordPath(directory, sessionID, 'prune-probe'));
	} catch {
		return null;
	}
	return pruneDirEntries(dirPath, nowMs, options);
}

/**
 * r14 audit repair (P1-8): best-effort read of a record's persisted
 * write-order `seq` for the cap-eviction sort. Any anomaly (missing,
 * unparsable, no seq — legacy records) yields undefined; such records sort
 * oldest within their mtime tick, never newest. Never throws.
 *
 * r15 (P5): lstat — a symlinked `.json` must not be FOLLOWED into content
 * outside the store (unsafe symlink-follow in the pruning inspection); a
 * symlink is not a regular file and sorts as a legacy no-seq record. The
 * eviction itself only ever unlinks the LINK (rmSync never follows).
 */
function readRecordSeq(filePath: string): number | undefined {
	try {
		const stats = lstatSync(filePath);
		if (!stats.isFile() || stats.size > STAGE_B_BINDING_MAX_BYTES) {
			return undefined;
		}
		const parsed = JSON.parse(
			readFileSync(filePath, 'utf-8'),
		) as PersistedStageBBindings;
		return typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)
			? parsed.seq
			: undefined;
	} catch {
		return undefined;
	}
}

function pruneDirEntries(
	dirPath: string,
	nowMs: number,
	options: { protectPath?: string } = {},
): { dirPath: string; newest: number } | null {
	let entries: string[];
	try {
		entries = readdirSync(dirPath);
	} catch {
		return null;
	}	// Atomic-write temp files (target + suffix, always carrying `.tmp`) are
	// crash leftovers: TTL-prune them so they cannot accumulate outside every
	// bound, but NEVER while fresh — a fresh temp is an in-flight write and the
	// dir must be left alone for it.
	const temps = entries.filter((f) => f.includes('.tmp'));
	for (const temp of temps) {
		const tp = path.join(dirPath, temp);
		try {
			if (nowMs - statSync(tp).mtimeMs > STAGE_B_BINDING_TTL_MS) {
				rmSync(tp, { force: true });
			}
		} catch {
			// unreadable — leave it to TTL
		}
	}
	const files = entries.filter((f) => f.endsWith('.json'));
	const stamped: Array<{ file: string; mtime: number }> = [];
	for (const file of files) {
		const fp = path.join(dirPath, file);
		try {
			stamped.push({ file: fp, mtime: statSync(fp).mtimeMs });
		} catch {
			// unreadable — leave it to TTL
		}
	}
	const fresh = stamped.filter(
		(s) => nowMs - s.mtime <= STAGE_B_BINDING_TTL_MS,
	);
	for (const stale of stamped.filter(
		(s) => nowMs - s.mtime > STAGE_B_BINDING_TTL_MS,
	)) {
		try {
			rmSync(stale.file, { force: true });
		} catch {
			// best-effort
		}
	}
	if (fresh.length > MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR) {
		// r15 audit repair (P5): order by MTIME first (the real recency
		// signal), with the persisted write-order `seq` demoted to a
		// coarse-mtime TIE-BREAKER. seq is NOT monotonic across restarts (a
		// same-tick burst outruns a later process's Date.now() floor, so
		// post-restart records can carry LOWER seqs than surviving
		// pre-restart records) — a seq-primary sort evicted newer records
		// while retaining older ones. Within one mtime tick, seq is still a
		// deterministic, roughly-write-ordered tie-break (r14 P1-8's original
		// intent), and the path comparison keeps the order fully
		// deterministic. Bounded: at most cap+1 tiny reads, only when the cap
		// is actually exceeded. Legacy records without a seq sort oldest
		// within their mtime tick. The just-written record (protectPath) is
		// never evicted by the cap.
		const stampedWithSeq = fresh.map((entry) => ({
			...entry,
			seq: readRecordSeq(entry.file),
		}));
		const ordered = stampedWithSeq.sort((a, b) => {
			if (a.mtime !== b.mtime) return a.mtime - b.mtime;
			const seqA = a.seq ?? Number.NEGATIVE_INFINITY;
			const seqB = b.seq ?? Number.NEGATIVE_INFINITY;
			if (seqA !== seqB) return seqA - seqB;
			return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
		});
		const evictable = ordered.filter(
			(entry) => entry.file !== options.protectPath,
		);
		for (const old of evictable.slice(
			0,
			fresh.length - MAX_STAGE_B_BINDING_FILES_PER_SESSION_DIR,
		)) {
			try {
				rmSync(old.file, { force: true });
			} catch {
				// best-effort
			}
		}
	}
	const newest = fresh.reduce((max, s) => Math.max(max, s.mtime), 0);
	// Empty-dir GC (PR review finding, Copilot store:371): a session dir whose
	// records were all deleted or TTL-pruned must not linger — empty dirs
	// count toward the 128-dir cap on every write yet were invisible to LRU
	// removal, permanently forcing unthrottled full sweeps once 128 distinct
	// sessions had ever run. Removal is race-safe by construction: re-readdir,
	// then rmdirSync, which only succeeds on an EMPTY directory — a concurrent
	// writer that landed any entry (its .tmp first) makes rmdir fail
	// ENOTEMPTY/EACCES and we simply skip. The owning write of THIS call has
	// already renamed its .json into place before pruning, so a session dir is
	// never reaped out from under its own in-progress record call.
	if (newest === 0) {
		try {
			if (readdirSync(dirPath).length === 0) {
				rmdirSync(dirPath);
				return null;
			}
		} catch {
			// non-empty (in-flight temp), already gone, or platform refusal —
			// leave it; the next sweep retries
		}
	}
	return { dirPath, newest };
}

export const _internals = {
	recordPath,
	sessionDirName,
	pruneStore,
	pruneSessionDir,
};

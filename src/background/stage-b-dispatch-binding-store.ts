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
	statSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import * as logger from '../utils/logger.js';

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
 * 2026-11-25 swarm_communication_debug (layer 3 diagnosis): bounded, project-
 * visible write-failure trace for this store. The store's `catch { return
 * false }` discarded the failure CAUSE entirely, and the gate's always-emitted
 * criticalWarn goes to the host process's stderr — which `opencode serve
 * --service` pipes into a supervisor socket (stdout to /dev/null), leaving the
 * operator with zero diagnosable signal. Observed live: every Stage-B dispatch
 * in the consumer project left an empty session dir (mkdir succeeded, the
 * temp-write/rename phase failed) across days and server instances. The
 * diagnostics file lives in the store's own root so the next failing dispatch
 * leaves a durable trace the architect (and we) can read from the project.
 */
const WRITE_ERROR_DIAGNOSTICS_FILE = '.write-errors.jsonl';
const MAX_WRITE_ERROR_DIAGNOSTIC_LINES = 16;

function recordWriteDiagnostic(
	directory: string,
	sessionID: string,
	callID: string,
	error: unknown,
): void {
	try {
		const message = (
			error instanceof Error ? error.message : String(error)
		).slice(0, 256);
		const code = (error as NodeJS.ErrnoException | null)?.code;
		const entry = JSON.stringify({
			timestamp: new Date().toISOString(),
			sessionID: sessionID.slice(0, 64),
			callID: callID.slice(0, 128),
			error: message,
			...(typeof code === 'string' ? { code } : {}),
		});
		const root = validateSwarmPath(directory, STAGE_B_BINDINGS_DIR);
		const diagPath = path.join(root, WRITE_ERROR_DIAGNOSTICS_FILE);
		let lines: string[] = [];
		try {
			const existing = readFileSync(diagPath, 'utf8');
			lines = existing.split('\n').filter((line) => line.trim().length > 0);
		} catch {
			// Missing diagnostics file — start fresh.
		}
		lines.push(entry);
		while (lines.length > MAX_WRITE_ERROR_DIAGNOSTIC_LINES) lines.shift();
		// Deliberately NOT atomicWriteSwarmFileSync: the atomic writer is the
		// component whose failure is being diagnosed — a best-effort plain
		// write keeps the trace independent of the failing path.
		writeFileSync(diagPath, `${lines.join('\n')}\n`);
	} catch {
		// Best-effort by contract: a store root that cannot host the
		// diagnostics file cannot host bindings either — the gate's
		// criticalWarn remains the last resort.
	}
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
	const record: PersistedStageBBindings = {
		schemaVersion: STAGE_B_BINDING_SCHEMA_VERSION,
		sessionID,
		callID,
		recordedAt: nowMs(),
		bindings: bindings.map((b) => ({
			taskId: b.taskId,
			generation: b.generation,
		})),
	};
	try {
		const target = recordPath(directory, sessionID, callID);
		atomicWriteSwarmFileSync(target, JSON.stringify(record));
		// Per-dispatch cost stays bounded (review finding 3): only the OWNING
		// session's directory is stat'd/pruned on every write; the
		// cross-session sweep is throttled to at most one pass per sweep
		// interval. Both are injectable via nowMs for deterministic tests.
		pruneSessionDir(directory, sessionID, nowMs());
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
	} catch (error) {
		// 2026-11-25 (layer 3): surface the write failure's CAUSE. The previous
		// `catch { return false }` discarded the exception entirely — the gate's
		// criticalWarn (stderr, invisible under `serve --service`) was the only
		// signal, with no errno anywhere. Emit the always-visible warning WITH
		// the error code and append the bounded project-visible diagnostic.
		const message = error instanceof Error ? error.message : String(error);
		const code = (error as NodeJS.ErrnoException | null)?.code;
		logger.criticalWarn(
			`[stage-b-binding-store] durable binding write FAILED for call ${callID}: ${message.slice(0, 180)}${typeof code === 'string' ? ` (code=${code})` : ''} — restart recovery for this dispatch is unavailable; recorded to ${WRITE_ERROR_DIAGNOSTICS_FILE} in the store root`,
		);
		recordWriteDiagnostic(directory, sessionID, callID, error);
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
): { dirPath: string; newest: number } | null {
	let dirPath: string;
	try {
		dirPath = path.dirname(recordPath(directory, sessionID, 'prune-probe'));
	} catch {
		return null;
	}
	return pruneDirEntries(dirPath, nowMs);
}

function pruneDirEntries(
	dirPath: string,
	nowMs: number,
): { dirPath: string; newest: number } | null {
	let entries: string[];
	try {
		entries = readdirSync(dirPath);
	} catch {
		return null;
	}
	// Atomic-write temp files (target + suffix, always carrying `.tmp`) are
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
		const ordered = fresh.sort((a, b) => a.mtime - b.mtime);
		for (const old of ordered.slice(
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

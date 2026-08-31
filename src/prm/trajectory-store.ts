/**
 * TRAJECTORY STORE (Session-Level) — bounded (issue #2041)
 *
 * Per-session trajectory storage for PRM pattern detection.
 * Writes to .swarm/trajectories/{sessionId}.jsonl (+ a small
 * {sessionId}.jsonl.meta.json checkpoint and a transient {sessionId}.jsonl.lock).
 *
 * Bounded session-trajectory contract (mirrors the #2040 shell-audit store):
 * - ONE knob, `maxLines`, governs BOTH the in-memory cache trim and the disk
 *   compaction: over budget, the newest floor(maxLines/2) entries are retained
 *   (the cache has always used exactly this rule — the disk now matches it).
 * - The disk byte ceiling sessionMaxBytesFor(maxLines) is SOVEREIGN and is
 *   enforced at APPEND time (the stat needed for torn-tail re-framing doubles
 *   as the size probe): over ceiling, compaction runs before the append.
 * - A line-count check runs every `checkIntervalAppends` appends (the only
 *   part that needs a read; it is tail-bounded, never a whole-file read).
 * - Readers (`readTrajectory`, `getCurrentStep`) read a bounded tail window and
 *   disclose coverage; `getCurrentStep` also consults the atomically persisted
 *   checkpoint so a restart never scans history to continue step numbering.
 * - Crash semantics: compaction publishes via tmp+rename (a partial rewrite is
 *   never visible); the checkpoint is written after the data rewrite under the
 *   same lock, and merges `max(previous, observed)` so it can only ratchet UP.
 *   Compaction keeps the NEWEST entries, so the global max step always survives
 *   on disk — except when every retained line is corrupt, in which case the
 *   checkpoint alone preserves step continuity (that is why it exists).
 * - Two writers: an in-process per-key promise chain (same-process appends
 *   never burn the cross-process retry budget) plus a per-file `.lock`
 *   (wx existence create — the PID inside is diagnostic only, never
 *   liveness-checked — stale-break, bounded retry). Lock exhaustion skips the
 *   append with a warning — telemetry loss is preferred over file corruption
 *   in this best-effort store — and is counted into `trajectory_health`.
 *
 * Coexists with task-level trajectory-logger.ts which writes to
 * .swarm/evidence/{taskId}/trajectory.jsonl for audit/evidence (bounded by its
 * own write-side truncation; untouched by this contract).
 */

import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { observeStoreHealth } from '../health/learning-health.js';
import { validateSwarmPath } from '../hooks/utils';
import { telemetry } from '../telemetry.js';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import { compositeSessionKey, sessionKeySuffix } from '../utils/canonical-root';
import * as logger from '../utils/logger.js';
import type { TrajectoryEntry } from './types';

const MAX_TRACKED_TRAJECTORY_SESSIONS = 500;

/**
 * Hard budgets for the bounded session-trajectory contract (issue #2041).
 * Exported for tests and for the retention registry's documented contract.
 */
export const TRAJECTORY_LIMITS = {
	/** Line-count compaction check cadence (append-path, amortized). */
	checkIntervalAppends: 25,
	/** Tail-bounded read window for readTrajectoryWithCoverage. */
	readMaxBytes: 1024 * 1024,
	/** Tail-bounded read window for getCurrentStep (newest lines carry max step). */
	stepReadMaxBytes: 64 * 1024,
	/** Tail-bounded input window for compaction (legacy files may be huge). */
	compactMaxBytes: 1024 * 1024,
	/** A JSONL line longer than this is shed as oversize (append skips it). */
	maxLineBytes: 64 * 1024,
	/** Estimated bytes per entry used to derive the per-session byte ceiling. */
	estimatedLineBytes: 512,
	/** Floor for the derived per-session byte ceiling. */
	minSessionMaxBytes: 64 * 1024,
	/** Per-file cross-process lock: bounded retries, then skip + warn. */
	lockRetries: 20,
	lockRetryDelayMs: 5,
	/** A lock older than this is considered crashed and broken. */
	lockStaleMs: 5 * 60_000,
	/** Per-directory session-file count cap (age-sweep backstop). */
	maxFilesPerDir: 200,
	/** Unlinks per cleanup invocation (converges across runs). */
	maxDeletionsPerRun: 256,
	/** Default age sweep horizon for trajectories/ and replays/. */
	defaultMaxAgeDays: 7,
	/** Debounce for the lazily scheduled cleanup pass. */
	cleanupDebounceMs: 10 * 60_000,
	/** Cooldown for append_skip health events (lock-exhaust observability). */
	appendSkipEventCooldownMs: 60_000,
} as const;

/**
 * Sovereign per-session disk byte ceiling, derived from the same `maxLines`
 * knob that governs cache trimming and line-count compaction.
 */
export function sessionMaxBytesFor(maxLines: number): number {
	const lines = Math.max(1, Math.floor(maxLines));
	return Math.max(
		TRAJECTORY_LIMITS.minSessionMaxBytes,
		lines * TRAJECTORY_LIMITS.estimatedLineBytes,
	);
}

/** Test/DI seam — see `gitignore-warning.ts:_internals` for the convention. */
export const _internals: {
	telemetry: typeof telemetry;
} = {
	telemetry,
};

/** Cumulative lock-skipped appends since the last trajectory_health emission. */
let skippedLockAppends = 0;
let lastAppendSkipEventAtMs = 0;

function emitTrajectoryHealth(
	directory: string,
	data: {
		trigger: 'compaction' | 'cleanup' | 'append_skip';
		retained_count: number;
		dropped_count: number;
		corrupt_count: number;
		bytes: number;
		limit_bytes: number;
	},
): void {
	try {
		const healthPayload = {
			...data,
			skipped_lock_count: skippedLockAppends,
		};
		_internals.telemetry.trajectoryHealth(healthPayload);
		// #2044: direct learning-health feed from the FIRST store event.
		observeStoreHealth({
			directory,
			kind: 'trajectory_health',
			payload: healthPayload,
		});
	} catch {
		/* telemetry must never break the store */
	}
}

/**
 * Builds the validated absolute path to a session's trajectory file.
 */
function getTrajectoryPath(sessionId: string, directory: string): string {
	const relativePath = path.join('trajectories', `${sessionId}.jsonl`);
	return validateSwarmPath(directory, relativePath);
}

function getLockPath(trajectoryPath: string): string {
	return `${trajectoryPath}.lock`;
}

function getMetaPath(trajectoryPath: string): string {
	return `${trajectoryPath}.meta.json`;
}

// ─── In-memory trajectory cache (composite-keyed, bounded) ──────────────────

// Module-level in-memory trajectory cache per canonical root + sessionId.
// Populated on write by appendTrajectoryEntry, used by pattern detection.
// Eliminates full disk reads on every toolAfter call.
const _inMemoryTrajectoryCache = new Map<string, TrajectoryEntry[]>();

function setTrajectoryCache(
	key: string,
	entries: TrajectoryEntry[],
	maxLines: number = 1000,
): void {
	const boundedEntries =
		entries.length > maxLines
			? entries.slice(-Math.max(1, Math.floor(maxLines / 2)))
			: [...entries];

	if (!_inMemoryTrajectoryCache.has(key)) {
		while (_inMemoryTrajectoryCache.size >= MAX_TRACKED_TRAJECTORY_SESSIONS) {
			const oldestKey = _inMemoryTrajectoryCache.keys().next().value;
			if (oldestKey === undefined) break;
			_inMemoryTrajectoryCache.delete(oldestKey);
		}
	}

	_inMemoryTrajectoryCache.set(key, boundedEntries);
}

/**
 * Returns cached trajectory entries for a session (empty array if not cached).
 *
 * @param sessionId - Session identifier
 * @param directory - Workspace root that owns the session's trajectory file
 */
export function getInMemoryTrajectory(
	sessionId: string,
	directory: string,
): TrajectoryEntry[] {
	const cached = _inMemoryTrajectoryCache.get(
		compositeSessionKey(directory, sessionId),
	);
	return cached ? [...cached] : [];
}

/**
 * Clears trajectory cache (for test isolation or session cleanup).
 *
 * With a sessionId but no directory, every root's entry for that session is
 * cleared (suffix scan over the bounded map) — reset paths that legitimately
 * lack a directory still release the cached window.
 */
export function clearTrajectoryCache(sessionId?: string): void {
	if (sessionId !== undefined) {
		const suffix = sessionKeySuffix(sessionId);
		for (const key of _inMemoryTrajectoryCache.keys()) {
			if (key.endsWith(suffix)) _inMemoryTrajectoryCache.delete(key);
		}
		// Scope the bookkeeping clear to the SAME session: a wholesale wipe
		// here (fired by per-session reset paths, e.g. the delegation gate's
		// per-callID reset) would reset every OTHER session's compaction
		// check counters and let their files overshoot the line budget far
		// past the check interval (maintainer review #2395, finding 4).
		for (const key of appendChains.keys()) {
			if (key.endsWith(suffix)) appendChains.delete(key);
		}
		for (const key of appendCheckCounters.keys()) {
			if (key.endsWith(suffix)) appendCheckCounters.delete(key);
		}
	} else {
		_inMemoryTrajectoryCache.clear();
		appendChains.clear();
		appendCheckCounters.clear();
	}
}

// ─── In-process per-key serialization + per-file cross-process lock ─────────

const appendChains = new Map<string, Promise<unknown>>();
const appendCheckCounters = new Map<string, number>();

function setAppendCheckCounter(key: string, value: number): void {
	if (!appendCheckCounters.has(key)) {
		while (appendCheckCounters.size >= MAX_TRACKED_TRAJECTORY_SESSIONS) {
			const oldest = appendCheckCounters.keys().next().value;
			if (oldest === undefined) break;
			appendCheckCounters.delete(oldest);
		}
	}
	appendCheckCounters.set(key, value);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes async work per composite key WITHOUT same-process lock contention:
 * concurrent appends for one session queue on the chain instead of fighting
 * over the file lock (a same-process loser would burn the retry budget and
 * drop its append). The stored tail never rejects, so the chain cannot break.
 */
function chained<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const tail = appendChains.get(key) ?? Promise.resolve();
	const run = tail.then(fn, fn);
	if (!appendChains.has(key)) {
		while (appendChains.size >= MAX_TRACKED_TRAJECTORY_SESSIONS) {
			const oldest = appendChains.keys().next().value;
			if (oldest === undefined) break;
			appendChains.delete(oldest);
		}
	}
	appendChains.set(
		key,
		run.catch(() => {}),
	);
	return run;
}

interface TrajectoryLock {
	release: () => Promise<void>;
}

async function acquireTrajectoryLock(
	lockPath: string,
): Promise<TrajectoryLock> {
	for (let attempt = 0; attempt <= TRAJECTORY_LIMITS.lockRetries; attempt++) {
		let handle: FileHandle | null = null;
		try {
			handle = await fs.open(lockPath, 'wx');
			await handle.writeFile(String(process.pid), 'utf-8');
			await handle.close();
			handle = null;
			return {
				release: async () => {
					try {
						await fs.unlink(lockPath);
					} catch {
						/* already gone — release is best-effort */
					}
				},
			};
		} catch (err) {
			// A write/close failure after the wx-create leaves an orphaned lock
			// (and an open fd): close the fd and remove OUR own lock file so we
			// never gate this session's appends behind our own crashed create
			// until the stale-break. Only EEXIST (someone else won the race)
			// proceeds to the retry/backoff path.
			if (handle !== null) {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST') throw err;
			try {
				const stat = await fs.stat(lockPath);
				// Math.abs (not a clamp): a future-dated mtime (clock skew,
				// utimes manipulation) must ALSO stale-break, and a clamp would
				// make the diff non-negative so a far-future lock never goes
				// stale. Same pattern as skill-usage-pending.ts (PR #2347 FB-009).
				if (
					Math.abs(Date.now() - stat.mtimeMs) > TRAJECTORY_LIMITS.lockStaleMs
				) {
					await fs.unlink(lockPath).catch(() => {});
					continue;
				}
			} catch {
				/* lock vanished between open and stat — retry immediately */
				continue;
			}
			await sleep(TRAJECTORY_LIMITS.lockRetryDelayMs);
		}
	}
	throw new Error('trajectory store lock busy');
}

// ─── Bounded tail reads ──────────────────────────────────────────────────────

interface TailWindow {
	content: string;
	/** Byte offset the window starts at; > 0 means older bytes were not read. */
	offset: number;
	totalBytes: number;
}

/**
 * Positioned read of the newest `maxBytes` of a file. Never reads more than
 * `maxBytes` regardless of file size (issue #2041 Required 3). Returns null
 * when the file does not exist.
 */
async function readTailBytes(
	filePath: string,
	maxBytes: number,
): Promise<TailWindow | null> {
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(filePath, 'r');
		const stat = await handle.stat();
		if (stat.size === 0) {
			return { content: '', offset: 0, totalBytes: 0 };
		}
		const offset = Math.max(0, stat.size - maxBytes);
		const length = stat.size - offset;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, offset);
		return {
			content: buffer.toString('utf-8'),
			offset,
			totalBytes: stat.size,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}

interface ParsedWindow {
	entries: TrajectoryEntry[];
	/** Raw valid JSONL lines in file order (compaction rewrite input). */
	lines: string[];
	skippedMalformed: number;
	skippedOversize: number;
	maxStep: number;
}

function parseWindow(content: string, windowTruncated: boolean): ParsedWindow {
	let lines = content.split('\n');
	// The first line of a mid-file window is torn (it starts where the previous
	// line was cut); drop it. The final element after a trailing newline is ''.
	if (windowTruncated && lines.length > 0) {
		lines = lines.slice(1);
	}
	const parsed: ParsedWindow = {
		entries: [],
		lines: [],
		skippedMalformed: 0,
		skippedOversize: 0,
		maxStep: 0,
	};
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (Buffer.byteLength(trimmed, 'utf-8') > TRAJECTORY_LIMITS.maxLineBytes) {
			parsed.skippedOversize += 1;
			continue;
		}
		try {
			const entry = JSON.parse(trimmed) as TrajectoryEntry;
			parsed.entries.push(entry);
			parsed.lines.push(trimmed);
			if (typeof entry.step === 'number' && entry.step > parsed.maxStep) {
				parsed.maxStep = entry.step;
			}
		} catch {
			parsed.skippedMalformed += 1;
		}
	}
	return parsed;
}

// ─── Checkpoint (atomic step high-water mark) ────────────────────────────────

interface TrajectoryCheckpoint {
	version: 1;
	highestStep: number;
	droppedEntries: number;
	/**
	 * Cumulative bytes discarded whole — chiefly the pre-window portion of an
	 * oversized file that a tail-bounded compaction rewrote away (shed
	 * windowed entries also contribute their bytes here, alongside their
	 * counts in droppedEntries: the two metrics are independent dimensions
	 * of the same loss). Without this, a compaction whose window kept every
	 * windowed entry (droppedEntries delta 0) would silently erase megabytes
	 * beyond the window while coverage still reported `complete`. Optional
	 * on READ for checkpoints written before this field existed.
	 */
	droppedBytes?: number;
	compactedAt: string;
}

async function readCheckpointByPath(
	metaPath: string,
): Promise<TrajectoryCheckpoint | null> {
	try {
		// Bounded read (the checkpoint is a single ~100-byte JSON line); a
		// planted/oversized sidecar can never balloon memory here.
		const tail = await readTailBytes(metaPath, 64 * 1024);
		if (tail === null || tail.totalBytes === 0) return null;
		const parsed = JSON.parse(tail.content) as Partial<TrajectoryCheckpoint>;
		if (
			parsed.version !== 1 ||
			typeof parsed.highestStep !== 'number' ||
			typeof parsed.droppedEntries !== 'number' ||
			typeof parsed.compactedAt !== 'string'
		) {
			return null;
		}
		return {
			...parsed,
			droppedBytes:
				typeof parsed.droppedBytes === 'number' ? parsed.droppedBytes : 0,
		} as TrajectoryCheckpoint;
	} catch {
		return null;
	}
}

/**
 * Reads a session's persisted step checkpoint (null when absent/corrupt).
 *
 * Production consumers: `getCurrentStep` (restart continuity) and the consensus
 * corpus's default PRM coverage signal (dropped-by-compaction disclosure).
 */
export async function readTrajectoryCheckpoint(
	sessionId: string,
	directory: string,
): Promise<TrajectoryCheckpoint | null> {
	try {
		return await readCheckpointByPath(
			getMetaPath(getTrajectoryPath(sessionId, directory)),
		);
	} catch {
		return null;
	}
}

/**
 * One bounded stat of a session's trajectory file (null when absent).
 *
 * Production consumer: the consensus corpus's default PRM coverage verdict —
 * a file larger than the read window means the live bounded read was
 * window-truncated, exactly matching `readTrajectoryWithCoverage`'s coverage
 * semantics so the two paths cannot diverge (implementation-review round 1).
 */
export async function trajectoryFileBytes(
	sessionId: string,
	directory: string,
): Promise<number | null> {
	try {
		const stat = await fs.stat(getTrajectoryPath(sessionId, directory));
		return stat.size;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
}

// ─── Compaction (bounded reverse compaction) ─────────────────────────────────

interface CompactionOutcome {
	retained: number;
	dropped: number;
	corrupt: number;
	bytes: number;
}

/**
 * Rewrites the trajectory file keeping the newest `floor(maxLines/2)` valid
 * lines, then sheds oldest-kept while the retained byte total exceeds the
 * session ceiling (minimum 1 line). Input is the bounded tail window — a
 * legacy file larger than the window is compacted from its newest
 * `compactMaxBytes` without ever being read whole. Publishes via the canonical
 * atomic write (tmp+rename), then ratchets the checkpoint under the same lock.
 *
 * MUST be called while holding the file lock.
 */
async function compactTrajectoryFile(
	trajectoryPath: string,
	maxLines: number,
	directory: string,
): Promise<CompactionOutcome | null> {
	const tail = await readTailBytes(
		trajectoryPath,
		TRAJECTORY_LIMITS.compactMaxBytes,
	);
	if (!tail || tail.totalBytes === 0) return null;

	const parsed = parseWindow(tail.content, tail.offset > 0);
	const keepCount = Math.max(1, Math.floor(Math.max(1, maxLines) / 2));
	const limitBytes = sessionMaxBytesFor(maxLines);

	const keptLines: string[] = [];
	let keptBytes = 0;
	for (
		let i = parsed.lines.length - 1;
		i >= 0 && keptLines.length < keepCount;
		i--
	) {
		const line = parsed.lines[i] as string;
		keptLines.unshift(line);
		keptBytes += Buffer.byteLength(line, 'utf-8') + 1;
	}
	// The byte ceiling is sovereign: shed oldest-kept until within budget.
	while (keptLines.length > 1 && keptBytes > limitBytes) {
		const removed = keptLines.shift();
		if (removed === undefined) break;
		keptBytes -= Buffer.byteLength(removed, 'utf-8') + 1;
	}

	const dropped =
		parsed.entries.length +
		parsed.skippedMalformed +
		parsed.skippedOversize -
		keptLines.length;
	const corrupt = parsed.skippedMalformed + parsed.skippedOversize;

	const content = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
	// trajectoryPath came from getTrajectoryPath (validateSwarmPath), so the
	// atomic helper's .swarm-containment assert is satisfied by construction.
	atomicWriteSwarmFileSync(trajectoryPath, content);

	const previous = await readCheckpointByPath(getMetaPath(trajectoryPath));
	// Bytes discarded WHOLE: everything in the file that neither survived in
	// keptLines nor counted as a windowed entry/malformed line — chiefly the
	// pre-window portion when the file exceeded compactMaxBytes. Recording it
	// keeps coverage honest: a compaction that erases megabytes beyond its
	// read window must never report full fidelity (maintainer review #2395).
	const droppedBytes =
		(previous?.droppedBytes ?? 0) + Math.max(0, tail.totalBytes - keptBytes);
	const checkpoint: TrajectoryCheckpoint = {
		version: 1,
		highestStep: Math.max(parsed.maxStep, previous?.highestStep ?? 0),
		droppedEntries: Math.max(
			0,
			(previous?.droppedEntries ?? 0) + Math.max(0, dropped),
		),
		droppedBytes,
		compactedAt: new Date().toISOString(),
	};
	atomicWriteSwarmFileSync(
		getMetaPath(trajectoryPath),
		`${JSON.stringify(checkpoint)}\n`,
	);

	emitTrajectoryHealth(directory, {
		trigger: 'compaction',
		retained_count: keptLines.length,
		dropped_count: Math.max(0, dropped),
		corrupt_count: corrupt,
		bytes: keptBytes,
		limit_bytes: limitBytes,
	});
	skippedLockAppends = 0;

	return {
		retained: keptLines.length,
		dropped: Math.max(0, dropped),
		corrupt,
		bytes: keptBytes,
	};
}

// ─── Append (production write path — enforces the disk bound) ────────────────

/**
 * Appends a single TrajectoryEntry to the session's trajectory file, enforcing
 * the bounded session-trajectory contract on disk as well as in memory.
 *
 * @param sessionId - Session identifier
 * @param entry - Trajectory entry to append
 * @param directory - Base directory (workspace root)
 * @param maxLines - Line budget for BOTH the in-memory cache trim and disk
 *   compaction (compaction retains the newest floor(maxLines/2) entries; the
 *   derived byte ceiling sessionMaxBytesFor(maxLines) is sovereign)
 */
export async function appendTrajectoryEntry(
	sessionId: string,
	entry: TrajectoryEntry,
	directory: string,
	maxLines: number = 1000,
): Promise<void> {
	try {
		const key = compositeSessionKey(directory, sessionId);
		await chained(key, async () => {
			const line = `${JSON.stringify(entry)}\n`;
			if (Buffer.byteLength(line, 'utf-8') > TRAJECTORY_LIMITS.maxLineBytes) {
				// JSON cannot be safely truncated; shed the record whole. The
				// production writer's entries are ~300 B, so this only fires on
				// adversarial/direct calls.
				logger.warn(
					'[trajectory-store] Skipped oversize trajectory entry ' +
						`(${Buffer.byteLength(line, 'utf-8')} B > ${TRAJECTORY_LIMITS.maxLineBytes} B)`,
				);
				return;
			}

			const trajectoryPath = getTrajectoryPath(sessionId, directory);
			await fs.mkdir(path.dirname(trajectoryPath), { recursive: true });

			let lock: TrajectoryLock | null = null;
			try {
				lock = await acquireTrajectoryLock(getLockPath(trajectoryPath));

				// One positioned 1-byte read doubles as the torn-tail probe and
				// (via totalBytes) the append-time byte-ceiling check.
				const tail = await readTailBytes(trajectoryPath, 1);
				const needsReframe =
					tail !== null && tail.totalBytes > 0 && tail.content !== '\n';

				// Byte ceiling enforced at append time (shell-audit RC-4 lesson):
				// compaction runs BEFORE the append so the new entry is retained.
				if (tail !== null && tail.totalBytes > sessionMaxBytesFor(maxLines)) {
					await compactTrajectoryFile(trajectoryPath, maxLines, directory);
				}

				await fs.appendFile(
					trajectoryPath,
					needsReframe ? `\n${line}` : line,
					'utf-8',
				);

				// Line-count check on a bounded tail window, amortized over
				// checkIntervalAppends. (The byte ceiling above is checked on
				// every append; only the line budget needs the read.)
				const sinceCheck = (appendCheckCounters.get(key) ?? 0) + 1;
				if (sinceCheck >= TRAJECTORY_LIMITS.checkIntervalAppends) {
					setAppendCheckCounter(key, 0);
					const window = await readTailBytes(
						trajectoryPath,
						TRAJECTORY_LIMITS.readMaxBytes,
					);
					if (window !== null && window.totalBytes > 0) {
						const windowParsed = parseWindow(window.content, window.offset > 0);
						if (window.offset > 0 || windowParsed.entries.length > maxLines) {
							await compactTrajectoryFile(trajectoryPath, maxLines, directory);
						}
					}
				} else {
					setAppendCheckCounter(key, sinceCheck);
				}
			} finally {
				if (lock) await lock.release();
			}

			// Cache update AFTER the durable write: a failed write must not
			// create memory-only trajectory state that PRM treats as durable.
			const cached = _inMemoryTrajectoryCache.get(key) ?? [];
			setTrajectoryCache(key, [...cached, entry], maxLines);
		});
	} catch (err) {
		// Non-blocking: swallow errors to prevent PRM from breaking main flow.
		const busy = err instanceof Error && err.message.includes('lock busy');
		logger.log(`[trajectory-store] Failed to append trajectory entry: ${err}`);
		if (busy) {
			skippedLockAppends += 1;
			const now = Date.now();
			if (
				now - lastAppendSkipEventAtMs >=
				TRAJECTORY_LIMITS.appendSkipEventCooldownMs
			) {
				lastAppendSkipEventAtMs = now;
				emitTrajectoryHealth(directory, {
					trigger: 'append_skip',
					retained_count: 0,
					dropped_count: 0,
					corrupt_count: 0,
					bytes: 0,
					limit_bytes: 0,
				});
				skippedLockAppends = 0;
			}
		}
	}
}

// ─── Bounded reads with coverage disclosure ─────────────────────────────────

export type TrajectoryCoverage = 'complete' | 'truncated' | 'empty';

export interface TrajectoryReadWithCoverage {
	entries: TrajectoryEntry[];
	coverage: TrajectoryCoverage;
	/** Entries removed by prior compactions (persisted checkpoint total). */
	droppedByCompaction: number;
	skippedMalformed: number;
}

/**
 * Tail-bounded read of a session's trajectory with explicit coverage
 * disclosure (issue #2041 Required 3/4). Reads at most
 * TRAJECTORY_LIMITS.readMaxBytes regardless of file size; the returned entries
 * are the newest window in file order.
 *
 * `maxLines` is the SAME knob the append path uses: a cold read populates the
 * in-memory cache trimmed to the configured budget, so a legacy pre-fix file
 * cannot inflate the cache PRM pattern detection reads (review round 1).
 */
export async function readTrajectoryWithCoverage(
	sessionId: string,
	directory: string,
	maxLines: number = 1000,
): Promise<TrajectoryReadWithCoverage> {
	try {
		const trajectoryPath = getTrajectoryPath(sessionId, directory);
		const tail = await readTailBytes(
			trajectoryPath,
			TRAJECTORY_LIMITS.readMaxBytes,
		);
		const checkpoint = await readCheckpointByPath(getMetaPath(trajectoryPath));
		if (tail === null) {
			return {
				entries: [],
				coverage: 'empty',
				droppedByCompaction: checkpoint?.droppedEntries ?? 0,
				skippedMalformed: 0,
			};
		}
		const parsed = parseWindow(tail.content, tail.offset > 0);
		const key = compositeSessionKey(directory, sessionId);
		setTrajectoryCache(key, parsed.entries, maxLines);
		const dropped = checkpoint?.droppedEntries ?? 0;
		const droppedBytes = checkpoint?.droppedBytes ?? 0;
		const coverage: TrajectoryCoverage =
			parsed.entries.length === 0 && tail.totalBytes === 0
				? 'empty'
				: tail.offset > 0 || dropped > 0 || droppedBytes > 0
					? 'truncated'
					: 'complete';
		return {
			entries: parsed.entries,
			coverage,
			droppedByCompaction: dropped,
			skippedMalformed: parsed.skippedMalformed + parsed.skippedOversize,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				entries: [],
				coverage: 'empty',
				droppedByCompaction: 0,
				skippedMalformed: 0,
			};
		}
		logger.log(`[trajectory-store] Failed to read trajectory: ${err}`);
		return {
			entries: [],
			coverage: 'empty',
			droppedByCompaction: 0,
			skippedMalformed: 0,
		};
	}
}

/**
 * Reads the newest bounded window of TrajectoryEntry records from a session's
 * trajectory file.
 *
 * @param sessionId - Session identifier
 * @param directory - Base directory (workspace root)
 * @param maxLines - Optional cache-trim budget (same knob as the append path)
 * @returns Array of trajectory entries (empty array if file doesn't exist)
 */
export async function readTrajectory(
	sessionId: string,
	directory: string,
	maxLines?: number,
): Promise<TrajectoryEntry[]> {
	return (await readTrajectoryWithCoverage(sessionId, directory, maxLines))
		.entries;
}

export const _test_exports = {
	MAX_TRACKED_TRAJECTORY_SESSIONS,
	TRAJECTORY_LIMITS,
	sessionMaxBytesFor,
	// Test seams (writing-tests skill): direct access to bookkeeping the
	// public API deliberately hides.
	getCacheSize: () => _inMemoryTrajectoryCache.size,
	getChainSize: () => appendChains.size,
	/** Test isolation: the cleanup debounce is module-global state. */
	resetCleanupDebounce: () => {
		lastCleanupScheduledAtMs = 0;
	},
	/** Test isolation: lock-skip counters are module-global state. */
	resetLockSkipCounters: () => {
		skippedLockAppends = 0;
		lastAppendSkipEventAtMs = 0;
	},
	appendFileIsTorn: async (filePath: string): Promise<boolean> => {
		const tail = await readTailBytes(filePath, 1);
		return tail !== null && tail.totalBytes > 0 && tail.content !== '\n';
	},
} as const;

/**
 * Alias for readTrajectory - retrieves trajectory entries for a session.
 *
 * @param sessionId - Session identifier
 * @param directory - Base directory (workspace root)
 * @returns Array of trajectory entries
 */
export async function getTrajectoryForSession(
	sessionId: string,
	directory: string,
): Promise<TrajectoryEntry[]> {
	return readTrajectory(sessionId, directory);
}

/**
 * Returns the highest step number in the session's trajectory.
 * Used to determine the next step number when appending — the production
 * restart-seeding path in trajectory-logger.ts calls this before the first
 * mint of a session so step numbers stay monotonic across process restarts.
 *
 * Bounded: reads at most TRAJECTORY_LIMITS.stepReadMaxBytes of the file
 * (the newest lines carry the max step) and merges the atomically persisted
 * checkpoint, so a restart never scans unbounded history — and the high-water
 * mark survives even a fully-corrupt data file.
 *
 * @param sessionId - Session identifier
 * @param directory - Base directory (workspace root)
 * @returns Highest step number, or 0 if no trajectory exists
 */
export async function getCurrentStep(
	sessionId: string,
	directory: string,
): Promise<number> {
	try {
		const trajectoryPath = getTrajectoryPath(sessionId, directory);
		const checkpoint = await readCheckpointByPath(getMetaPath(trajectoryPath));
		let maxStep = checkpoint?.highestStep ?? 0;
		const tail = await readTailBytes(
			trajectoryPath,
			TRAJECTORY_LIMITS.stepReadMaxBytes,
		);
		if (tail !== null && tail.totalBytes > 0) {
			const parsed = parseWindow(tail.content, tail.offset > 0);
			if (parsed.maxStep > maxStep) maxStep = parsed.maxStep;
		}
		return maxStep;
	} catch (err) {
		// File doesn't exist or read error - return 0
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return 0;
		}
		logger.log(`[trajectory-store] Failed to get current step: ${err}`);
		return 0;
	}
}

// ─── Cleanup: age sweep + per-directory count cap (bounded, fail-open) ───────

let lastCleanupScheduledAtMs = 0;

interface CleanupCandidate {
	name: string;
	filePath: string;
	/** mtime clamped to now: clock skew can neither immortalize nor flash-kill. */
	effectiveMtimeMs: number;
}

/**
 * Debounced, fire-and-forget cleanup scheduling used by the PRM hook's
 * once-per-session trigger. The plugin's post-resolution init pass calls
 * `cleanupOldTrajectoryFiles` directly (the debounce must not suppress the
 * startup sweep).
 */
export function scheduleTrajectoryCleanup(directory: string): void {
	const now = Date.now();
	if (now - lastCleanupScheduledAtMs < TRAJECTORY_LIMITS.cleanupDebounceMs) {
		return;
	}
	lastCleanupScheduledAtMs = now;
	void cleanupOldTrajectoryFiles(directory).catch(() => {
		/* non-blocking */
	});
}

/**
 * Deletes aged trajectory and replay files, then enforces a per-directory
 * session-file count cap (oldest-first) so a hostile or skewed mtime cannot
 * grow `.swarm/trajectories/` or `.swarm/replays/` without bound. A session's
 * `.meta.json` checkpoint is removed with its `.jsonl`; orphan checkpoints and
 * stale atomic-write `*.tmp` leftovers age out on their own. Bounded to
 * maxDeletionsPerRun unlinks per invocation (converges across runs); every
 * failure is swallowed. Never touches `.swarm/evidence/` (task evidence is a
 * different directory tree governed by its own contract).
 *
 * Replays and trajectories are independent artifacts sharing this sweep: no
 * cross-linkage is enforced or implied.
 */
export async function cleanupOldTrajectoryFiles(
	directory: string,
	maxAgeDays: number = TRAJECTORY_LIMITS.defaultMaxAgeDays,
): Promise<void> {
	const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const now = Date.now();
	let removed = 0;
	let retained = 0;

	for (const subdir of ['trajectories', 'replays']) {
		if (removed >= TRAJECTORY_LIMITS.maxDeletionsPerRun) break;
		try {
			const dirPath = validateSwarmPath(directory, subdir);
			const entries = await fs.readdir(dirPath, { withFileTypes: true });

			const candidates: CleanupCandidate[] = [];
			for (const entry of entries) {
				if (!entry.isFile()) continue;
				// Transient locks are owned by their writers; never unlink one
				// from the sweeper (breaking a live lock would corrupt the very
				// serialization it exists for — stale locks are broken only by
				// a writer that lost the race, with the lock held).
				if (entry.name.endsWith('.lock')) continue;
				const filePath = path.join(dirPath, entry.name);
				try {
					const stat = await fs.stat(filePath);
					candidates.push({
						name: entry.name,
						filePath,
						effectiveMtimeMs: Math.min(stat.mtimeMs, now),
					});
				} catch {
					// Non-blocking
				}
			}

			const deleted = new Set<string>();
			const removeCandidate = async (candidate: CleanupCandidate) => {
				await fs.unlink(candidate.filePath);
				deleted.add(candidate.name);
				removed += 1;
				if (candidate.name.endsWith('.jsonl')) {
					const metaSibling = `${candidate.filePath}.meta.json`;
					await fs.unlink(metaSibling).catch(() => {});
				}
			};

			// 1. Age sweep (count cap is the adversarial-mtime backstop).
			for (const candidate of candidates) {
				if (removed >= TRAJECTORY_LIMITS.maxDeletionsPerRun) break;
				if (now - candidate.effectiveMtimeMs > cutoffMs) {
					await removeCandidate(candidate).catch(() => {});
				}
			}

			// 2. Count cap on remaining session `.jsonl` files, oldest first.
			const remainingJsonl = candidates
				.filter((c) => !deleted.has(c.name) && c.name.endsWith('.jsonl'))
				.sort((a, b) => b.effectiveMtimeMs - a.effectiveMtimeMs);
			retained += remainingJsonl.length;
			while (
				remainingJsonl.length > TRAJECTORY_LIMITS.maxFilesPerDir &&
				removed < TRAJECTORY_LIMITS.maxDeletionsPerRun
			) {
				const oldest = remainingJsonl.pop();
				if (oldest === undefined) break;
				await removeCandidate(oldest).catch(() => {});
				retained -= 1;
			}
		} catch {
			// Non-blocking (missing dir, permission, ...)
		}
	}

	if (removed > 0) {
		emitTrajectoryHealth(directory, {
			trigger: 'cleanup',
			retained_count: retained,
			dropped_count: removed,
			corrupt_count: 0,
			bytes: 0,
			limit_bytes: TRAJECTORY_LIMITS.maxFilesPerDir,
		});
		skippedLockAppends = 0;
	}
}

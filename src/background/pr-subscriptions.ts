/**
 * Durable PR monitoring subscription store (bounded checkpoint model, issue #2042).
 *
 * State lives under project-root `.swarm/pr-monitor/`:
 *
 *   - `subscriptions.checkpoint.json` — authoritative, versioned, atomically
 *     written (tmp+rename) snapshot of the latest validated record per
 *     `correlationId`, plus a bounded terminal-record set, migration cursor, and
 *     maintenance counters. Every read is bounded by the live set (~tens of
 *     records), never by history.
 *   - `subscriptions.audit.jsonl` — bounded transition audit tail (subscribe /
 *     unsubscribe / expire / compaction / migration / archive / recovery events
 *     only — NOT per-poll snapshots). High/low-water rewrite keeps the newest
 *     lines under hard line+byte bounds.
 *   - `subscriptions.jsonl` — LEGACY v1 append-only log. Before a checkpoint
 *     exists it is the read source (v1 semantics preserved); afterwards it is a
 *     migration source only. Migration folds it incrementally under bounded
 *     memory, persists a crash-resumable byte cursor, then renames the absorbed
 *     file to `subscriptions.legacy.jsonl` (deleted once older than
 *     `legacyArchiveTtlMs`). If the legacy file later changes (downgrade /
 *     external v1 writer), the tail is re-folded and absorbed — v1 append
 *     semantics keep working.
 *
 * Merge semantics (last-write-wins, v1-compatible):
 *   - within the legacy log, the later line wins per `correlationId` (v1 fold);
 *   - overlay merge against the checkpoint picks the greater `updatedAt`; on a
 *     tie the legacy-fold result wins (v1 positional semantics for same-ms
 *     external appends — pinned by tests/unit/state/pr-subscription-state.test.ts).
 *
 * Identity: the checkpoint is bound to its project root (`rootPath`). A copied
 * `.swarm` reads as empty (never starts the wrong monitor) and rebinds on the
 * next write; the displaced file is quarantined to a single
 * `subscriptions.checkpoint.foreign.json` slot. Corrupt checkpoints are
 * quarantined to `subscriptions.checkpoint.corrupt.json` and the store recovers
 * from the legacy log when present.
 *
 * Concurrency: all mutations (subscribe, unsubscribe, update, sweep, audit,
 * archive, migration, read-bootstrap) run under a single project-scoped
 * `withEvidenceLock` on the unchanged v1 lock key, so v1 and v2 writers
 * serialize across processes. Plain reads are lock-free; the one-time legacy
 * read-bootstrap may acquire the lock (short timeout) to persist the first
 * checkpoint so read-only installs also converge to bounded reads.
 *
 * Containment: every path is validated with `validateSwarmPath`, so nothing can
 * escape `.swarm/` (Invariant 4).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { withEvidenceLock } from '../evidence/lock.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { telemetry } from '../telemetry.js';
import { log } from '../utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write.js';

export const PR_SUBSCRIPTIONS_FILE = 'pr-monitor/subscriptions.jsonl';
export const PR_SUBSCRIPTIONS_CHECKPOINT_FILE =
	'pr-monitor/subscriptions.checkpoint.json';
export const PR_SUBSCRIPTIONS_AUDIT_FILE =
	'pr-monitor/subscriptions.audit.jsonl';

/** Legacy log archive (single slot, deleted after `legacyArchiveTtlMs`). */
const LEGACY_ARCHIVE_FILE = 'pr-monitor/subscriptions.legacy.jsonl';
/** Quarantine slots (single, overwritten — bounded by construction). */
const FOREIGN_CHECKPOINT_FILE =
	'pr-monitor/subscriptions.checkpoint.foreign.json';
const CORRUPT_CHECKPOINT_FILE =
	'pr-monitor/subscriptions.checkpoint.corrupt.json';

/** Lock + diagnostics identity for the project-scoped store lock. */
const STORE_LOCK_AGENT = 'pr-monitor';
const STORE_LOCK_TASK = 'pr-subscriptions';

/**
 * Hard bounds for the bounded subscription store (issue #2042 Required 2).
 * Mirrors the TRAJECTORY_LIMITS export pattern from src/prm/trajectory-store.ts.
 */
export const PR_SUBSCRIPTION_LIMITS = {
	/** Streaming read granularity — the legacy fold never materializes the file. */
	readChunkBytes: 64 * 1024,
	/** Per-line byte bound in the legacy fold; oversize lines are skipped+counted. */
	maxRecordBytes: 64 * 1024,
	/** Legacy-migration progress persistence granularity (crash-resume). */
	migrationChunkBytes: 1024 * 1024,
	/**
	 * Hard ceiling on legacy-log folding per store operation — the explicit
	 * finite migration work budget (issue #2042 Required 6). A legacy source
	 * larger than this is NEVER scanned (fail-safe refusal, loudly reported
	 * via health + the /swarm pr status footer with a repair hint, never
	 * silently dropped — the pending-delegations MAX_RECOVERY_LEDGER_BYTES
	 * precedent). Steady-state real files are ≤ a few MiB; anything near this
	 * ceiling already made every pre-fix operation multi-second.
	 */
	legacySourceMaxBytes: 64 * 1024 * 1024,
	/**
	 * Store-side live-subscription safety net when the caller omits
	 * `maxSubscriptions`. Production callers pass `config.max_subscriptions`
	 * (schema default 20, max 100 — src/config/schema.ts), so this only binds
	 * hypothetical callers that omit the field. Explicit values always win;
	 * `0` still disables the limit.
	 */
	defaultMaxActiveSubscriptions: 20,
	/** Hard guard on the checkpoint records map (100 max actives + 60 terminals + slack). */
	maxCheckpointRecords: 512,
	/** Pressure-reporting ceiling — active records are NEVER dropped for bytes. */
	maxCheckpointBytes: 256 * 1024,
	/**
	 * Hard READ-side ceiling (availability guard): a checkpoint file larger than
	 * this is rejected as invalid (quarantine + legacy recovery) instead of
	 * being synchronously loaded. Only external tampering or a caller bypassing
	 * the config-bounded subscribe cap (schema range 1–100) could produce one;
	 * steady state is ~tens of records, far under the 256 KiB pressure line.
	 */
	checkpointHardReadBytes: 1024 * 1024,
	/** Terminal (removed/expired) record retention watermarks + age ceiling. */
	terminalRecordsHigh: 60,
	terminalRecordsLow: 30,
	terminalMaxAgeMs: 30 * 86_400_000,
	/**
	 * Audit-tail watermarks. The BYTE pair is the absolute storage bound: the
	 * rewrite fires once the file passes `auditMaxBytesLow` and exceeds
	 * `auditMaxBytesHigh`. The LINE pair is the retention shape applied during
	 * that rewrite (keep the newest lines within both Low watermarks).
	 */
	auditMaxLinesHigh: 500,
	auditMaxLinesLow: 250,
	auditMaxBytesHigh: 128 * 1024,
	auditMaxBytesLow: 64 * 1024,
	/** Absorbed legacy archive is deleted once older than this. */
	legacyArchiveTtlMs: 7 * 86_400_000,
	/** Read-bootstrap lock timeout — short so contention cannot stall reads. */
	bootstrapLockTimeoutMs: 5_000,
} as const;

/**
 * Lazy-start callback — set by plugin init to start the PR monitor worker
 * when the first subscription is created. Decouples pr-subscriptions from
 * src/index.ts to avoid circular dependencies. Receives the full record so
 * the worker can extract session context for lazy initialization.
 */
let onSubscriptionCreated:
	| ((directory: string, record: PrSubscriptionRecord) => void)
	| null = null;

/**
 * Register the lazy-start callback invoked after a successful subscription.
 * Called once during plugin init to wire the PR monitor worker lifecycle.
 *
 * Contract: the callback MUST NOT call store operations synchronously — it
 * runs while the caller still holds the store's evidence lock, and
 * proper-lockfile has no in-process reentrancy, so a re-entering callback
 * would block until the lock times out.
 */
export function setOnSubscriptionCreated(
	callback: (directory: string, record: PrSubscriptionRecord) => void,
): void {
	onSubscriptionCreated = callback;
}

export type PrSubscriptionStatus = 'active' | 'removed' | 'expired';

/**
 * A durable PR monitoring subscription record. The checkpoint stores the
 * latest validated snapshot per `correlationId`.
 */
export interface PrSubscriptionRecord {
	/** Composite key: `${sessionID}::${repoFullName}::${prNumber}`. */
	correlationId: string;
	sessionID: string;
	prNumber: number;
	/** e.g. "owner/repo". */
	repoFullName: string;
	prUrl: string;
	headRefOid?: string;
	/** Epoch ms — last time the poller checked this PR. */
	lastCheckedAt: number;
	lastCommentId?: string;
	/** JSON stringified array of check names + conclusions. */
	lastCheckRunSet?: string;
	mergeableState?: string;
	/** Merge-group run status (e.g. "queued", "in_progress", "completed"). */
	mergeGroupRunStatus?: string;
	/** Merge-group run conclusion (e.g. "success", "failure"). */
	mergeGroupRunConclusion?: string;
	/** Merge-group run HTML URL for linking to the run. */
	mergeGroupRunHtmlUrl?: string;
	isWatching: boolean;
	/** Guard for cleanup sweep — subscriptions with unaddressed events are retained. */
	hasUnaddressedEvents: boolean;
	status: PrSubscriptionStatus;
	/** Epoch ms — when the subscription was first created. */
	createdAt: number;
	/** Epoch ms — when this snapshot was written. */
	updatedAt: number;
	errorCount: number;
	/** Per-PR poll-interval override (FR-017). */
	customPollIntervalSeconds?: number;
	customFailureThreshold?: number;
	customCooldownSeconds?: number;
}

export interface SubscribeInput {
	sessionID: string;
	prNumber: number;
	repoFullName: string;
	prUrl: string;
	/** Max active subscriptions allowed (for limit enforcement). */
	maxSubscriptions?: number;
}

const RecordSchema = z
	.object({
		correlationId: z.string().min(1),
		sessionID: z.string().min(1),
		prNumber: z.number().int().positive(),
		repoFullName: z
			.string()
			.regex(/^[^/]+\/[^/]+$/, 'Must be owner/repo format'),
		prUrl: z
			.string()
			.min(1)
			.regex(
				/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/,
				'Must be a valid GitHub PR URL',
			),
		headRefOid: z.string().optional(),
		lastCheckedAt: z.number(),
		lastCommentId: z.string().optional(),
		lastCheckRunSet: z.string().optional(),
		mergeableState: z.string().optional(),
		mergeGroupRunStatus: z.string().optional(),
		mergeGroupRunConclusion: z.string().optional(),
		mergeGroupRunHtmlUrl: z.string().optional(),
		isWatching: z.boolean(),
		hasUnaddressedEvents: z.boolean(),
		status: z.enum(['active', 'removed', 'expired']),
		createdAt: z.number(),
		updatedAt: z.number(),
		errorCount: z.number().int().min(0),
		customPollIntervalSeconds: z.number().int().positive().optional(),
		customFailureThreshold: z.number().int().min(0).optional(),
		customCooldownSeconds: z.number().int().positive().optional(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Checkpoint schema (issue #2042 Required 1)
// ---------------------------------------------------------------------------

export interface PrSubscriptionTerminalSummary {
	removed: number;
	expired: number;
	lastTerminalAt: number | null;
}

export interface PrSubscriptionMigrationState {
	/** Byte cursor of the incremental legacy fold (always a line boundary). */
	scannedBytes: number;
	/** Legacy size at the last scan (change detection). */
	sourceBytes: number;
	/**
	 * Legacy mtime at the last scan. Same-size recreation (a downgraded v1
	 * writer rewriting the log) is invisible to the size check alone, so the
	 * mtime is the second change-detection signal.
	 */
	sourceMtimeMs: number;
	/** Corrupt/oversize lines skipped during migration scanning. */
	corruptLines: number;
	done: boolean;
	archived: boolean;
	startedAt: number;
}

export interface PrSubscriptionMaintenance {
	compactions: number;
	droppedAuditTransitions: number;
	/** All-time corrupt/oversize legacy lines (migration + re-folds). */
	corruptLegacyRecords: number;
	lastCompactedAt: number | null;
	/** foreign-rebind + corrupt-quarantine recovery events. */
	resets: number;
}

export interface PrSubscriptionCheckpoint {
	schemaVersion: 1;
	sequence: number;
	rootPath: string;
	updatedAt: number;
	records: Record<string, PrSubscriptionRecord>;
	terminalSummary: PrSubscriptionTerminalSummary;
	migration: PrSubscriptionMigrationState | null;
	maintenance: PrSubscriptionMaintenance;
}

const TerminalSummarySchema = z
	.object({
		removed: z.number().int().min(0),
		expired: z.number().int().min(0),
		lastTerminalAt: z.number().int().nullable(),
	})
	.strict();

const MigrationSchema = z
	.object({
		scannedBytes: z.number().int().nonnegative(),
		sourceBytes: z.number().int().nonnegative(),
		sourceMtimeMs: z.number().nonnegative(),
		corruptLines: z.number().int().nonnegative(),
		done: z.boolean(),
		archived: z.boolean(),
		startedAt: z.number().int().nonnegative(),
	})
	.strict();

const MaintenanceSchema = z
	.object({
		compactions: z.number().int().nonnegative(),
		droppedAuditTransitions: z.number().int().nonnegative(),
		corruptLegacyRecords: z.number().int().nonnegative(),
		lastCompactedAt: z.number().int().nullable(),
		resets: z.number().int().nonnegative(),
	})
	.strict();

const CheckpointSchema = z
	.object({
		schemaVersion: z.literal(1),
		sequence: z.number().int().positive(),
		rootPath: z.string().min(1).max(4_096),
		updatedAt: z.number().int().nonnegative(),
		records: z.record(z.string(), RecordSchema),
		terminalSummary: TerminalSummarySchema,
		migration: MigrationSchema.nullable(),
		maintenance: MaintenanceSchema,
	})
	.strict();

type PrSubscriptionAuditKind =
	| 'subscribe'
	| 'unsubscribe'
	| 'expired'
	| 'compact'
	| 'migrate-complete'
	| 'archive'
	| 'foreign-rebind'
	| 'corrupt-quarantine'
	| 'reset';

interface AuditEvent {
	kind: PrSubscriptionAuditKind;
	correlationId?: string;
}

/**
 * Recovery source of a store view — mirrors the delegation-ledger
 * recovery-source disclosure (issue #2042 Required 8).
 */
export type PrSubscriptionRecoverySource =
	| 'checkpoint'
	| 'checkpoint+legacy'
	| 'legacy-log'
	| 'empty'
	| 'foreign'
	| 'corrupt-recovered';

/** Bounded store health (issue #2042 Required 8). Counts and bytes only. */
export interface PrSubscriptionHealth {
	schemaVersion: number;
	sequence: number;
	checkpointAgeMs: number | null;
	checkpointBytes: number;
	checkpointLimitBytes: number;
	pressurePct: number;
	activeCount: number;
	removedCount: number;
	expiredCount: number;
	terminalSummary: PrSubscriptionTerminalSummary;
	auditLines: number;
	auditBytes: number;
	auditLimitBytes: number;
	compactions: number;
	corruptLegacyRecords: number;
	droppedAuditTransitions: number;
	resets: number;
	recoverySource: PrSubscriptionRecoverySource;
	migration: {
		done: boolean;
		scannedBytes: number;
		sourceBytes: number;
	} | null;
	legacyArchiveBytes: number;
	/**
	 * True when a legacy source exceeds `legacySourceMaxBytes` and is being
	 * refused (never folded, never archived) — surfaced in the /swarm pr
	 * status footer with a repair hint.
	 */
	legacyOverLimit: boolean;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function storePath(directory: string): string {
	return validateSwarmPath(directory, PR_SUBSCRIPTIONS_FILE);
}

function checkpointPath(directory: string): string {
	return validateSwarmPath(directory, PR_SUBSCRIPTIONS_CHECKPOINT_FILE);
}

function auditPath(directory: string): string {
	return validateSwarmPath(directory, PR_SUBSCRIPTIONS_AUDIT_FILE);
}

function legacyArchivePath(directory: string): string {
	return validateSwarmPath(directory, LEGACY_ARCHIVE_FILE);
}

function foreignSlotPath(directory: string): string {
	return validateSwarmPath(directory, FOREIGN_CHECKPOINT_FILE);
}

function corruptSlotPath(directory: string): string {
	return validateSwarmPath(directory, CORRUPT_CHECKPOINT_FILE);
}

function ensureSwarmDir(directory: string): void {
	fs.mkdirSync(path.resolve(directory, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
}

/**
 * Build the composite correlation key from session, repo, and PR number.
 */
export function buildCorrelationId(
	sessionID: string,
	repoFullName: string,
	prNumber: number,
): string {
	return `${sessionID}::${repoFullName}::${prNumber}`;
}

/**
 * Project-root identity comparison for checkpoint replay (issue #2042
 * Required 5). Both sides are `path.resolve`d; POSIX compares exactly, win32
 * compares case-insensitively (drive-letter/segment case). No
 * realpath/UNC/8.3 normalization — an unresolved mismatch fails SAFE
 * (foreign → no monitor start, rebind on write, health-visible).
 *
 * This intentionally treats a MOVED project directory the same as a copied
 * `.swarm`: the stored rootPath no longer resolves to the current root, so
 * reads see nothing and the next write rebinds (the displaced checkpoint is
 * preserved in `subscriptions.checkpoint.foreign.json`). Re-create
 * subscriptions with `/swarm pr subscribe` after a move.
 */
function sameProjectRoot(recorded: string, current: string): boolean {
	const a = path.resolve(recorded);
	const b = path.resolve(current);
	if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
	return a === b;
}

function fileSizeOrNull(filePath: string): number | null {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return null;
	}
}

/** Bounded rename with Windows-transient retry (pending-delegations precedent). */
function renameWithRetry(from: string, to: string): void {
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (err) {
			lastError = err;
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') throw err;
			try {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
			} catch {
				/* bounded wait unavailable — retry immediately */
			}
		}
	}
	throw lastError;
}

// ---------------------------------------------------------------------------
// Legacy fold — streaming, bounded memory, byte-exact resume cursor
// (issue #2042 Required 3/6)
// ---------------------------------------------------------------------------

interface LegacyFoldResult {
	/** Latest record per correlationId in the folded region (later line wins). */
	folded: Map<string, PrSubscriptionRecord>;
	/** Byte offset after the last fully consumed line (always a line boundary). */
	nextByte: number;
	eof: boolean;
	corruptLines: number;
}

/**
 * Fold a byte region of the legacy JSONL log with bounded memory. Line
 * scanning is byte-level (a 0x0A newline can never occur inside a UTF-8
 * multibyte sequence), so complete lines decode exactly and `nextByte` is a
 * byte-exact resume boundary. Records are parsed, schema-validated, and
 * identity-checked (`correlationId` must compose from its parts); malformed,
 * oversize, and identity-mismatched lines are skipped and COUNTED — never
 * silently treated as removed or active (issue #2042 Required 5/6). A final
 * unterminated line is processed leniently (v1 `split('\n')` semantics).
 * `maxBytes` is a soft budget — the region extends to the end of the current
 * line so the cursor always lands on a boundary.
 */
function foldLegacyRegion(
	filePath: string,
	startByte: number,
	maxBytes: number,
): LegacyFoldResult {
	const folded = new Map<string, PrSubscriptionRecord>();
	let corruptLines = 0;
	let consumedTo = startByte;

	let fd: number;
	try {
		fd = fs.openSync(filePath, 'r');
	} catch {
		return { folded, nextByte: startByte, eof: true, corruptLines };
	}

	const processLineBytes = (line: Buffer): void => {
		if (line.length === 0) return;
		const text = line.toString('utf-8');
		const trimmed = text.trim();
		if (trimmed.length === 0) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			corruptLines += 1;
			return;
		}
		const result = RecordSchema.safeParse(parsed);
		if (!result.success) {
			corruptLines += 1;
			return;
		}
		const rec = result.data;
		if (
			rec.correlationId !==
			buildCorrelationId(rec.sessionID, rec.repoFullName, rec.prNumber)
		) {
			corruptLines += 1;
			return;
		}
		folded.set(rec.correlationId, rec);
	};

	try {
		const size = fs.fstatSync(fd).size;
		if (startByte >= size) {
			return { folded, nextByte: startByte, eof: true, corruptLines };
		}
		const chunk = Buffer.alloc(PR_SUBSCRIPTION_LIMITS.readChunkBytes);
		let pending: Buffer[] = [];
		let pendingLen = 0;
		let oversize = false;
		let pos = startByte;

		const flushPendingAtEof = (): LegacyFoldResult => {
			if (oversize) {
				corruptLines += 1;
			} else if (pendingLen > 0) {
				processLineBytes(Buffer.concat(pending));
			}
			// A final unterminated line was processed leniently — the cursor
			// covers every byte read so `sourceBytes` matches a later stat.
			consumedTo = Math.max(consumedTo, pos);
			pending = [];
			pendingLen = 0;
			oversize = false;
			return { folded, nextByte: consumedTo, eof: true, corruptLines };
		};

		while (true) {
			const want = Math.min(chunk.length, size - pos);
			if (want <= 0) return flushPendingAtEof();
			const n = fs.readSync(fd, chunk, 0, want, pos);
			if (n <= 0) return flushPendingAtEof();
			const data = chunk.subarray(0, n);
			const base = pos;
			pos += n;
			let scan = 0;
			while (scan < data.length) {
				const nl = data.indexOf(0x0a, scan);
				if (nl === -1) {
					// Copy: `chunk` is reused by the next read — a view would be
					// overwritten out from under the pending list.
					pending.push(Buffer.from(data.subarray(scan)));
					pendingLen += data.length - scan;
					break;
				}
				const lineLen = pendingLen + (nl - scan);
				if (oversize || lineLen > PR_SUBSCRIPTION_LIMITS.maxRecordBytes) {
					corruptLines += 1;
				} else {
					const pieces =
						pending.length > 0
							? [...pending, data.subarray(scan, nl)]
							: [data.subarray(scan, nl)];
					processLineBytes(Buffer.concat(pieces));
				}
				pending = [];
				pendingLen = 0;
				oversize = false;
				consumedTo = base + nl + 1;
				scan = nl + 1;
			}
			// Oversize guard: never buffer an unbounded partial line.
			if (!oversize && pendingLen > PR_SUBSCRIPTION_LIMITS.maxRecordBytes) {
				oversize = true;
				pending = [];
				pendingLen = 0;
			}
			if (consumedTo - startByte >= maxBytes && pendingLen === 0 && !oversize) {
				const eof = consumedTo >= size;
				return { folded, nextByte: consumedTo, eof, corruptLines };
			}
		}
	} catch (err) {
		log(
			`[pr-monitor] foldLegacyRegion failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { folded, nextByte: consumedTo, eof: true, corruptLines };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
	}
}

/**
 * Overlay-merge legacy fold results into a records view: greater `updatedAt`
 * wins; tie → legacy-fold result wins (v1 positional semantics — pinned by
 * tests/unit/state/pr-subscription-state.test.ts). Returns the number of
 * records actually replaced/added (dirty detection).
 */
function mergeFoldedRecords(
	view: Record<string, PrSubscriptionRecord>,
	overlay: Map<string, PrSubscriptionRecord>,
): number {
	let replaced = 0;
	for (const [key, rec] of overlay) {
		const base = view[key];
		if (!base || rec.updatedAt >= base.updatedAt) {
			view[key] = rec;
			replaced += 1;
		}
	}
	return replaced;
}

// ---------------------------------------------------------------------------
// Checkpoint read/write
// ---------------------------------------------------------------------------

type CheckpointRead =
	| { kind: 'absent' }
	| { kind: 'ok'; value: PrSubscriptionCheckpoint }
	| { kind: 'invalid'; reason: string };

function readCheckpoint(directory: string): CheckpointRead {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(checkpointPath(directory));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { kind: 'absent' };
		}
		return {
			kind: 'invalid',
			reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
		};
	}
	// Hard read-side bound: an over-ceiling checkpoint can only be external
	// tampering (or a caller bypassing the config-bounded subscribe cap) —
	// never synchronously load it (fail-safe quarantine + legacy recovery).
	if (stat.size > PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes) {
		return {
			kind: 'invalid',
			reason: `checkpoint exceeds hard read ceiling (${stat.size} > ${PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes} bytes)`,
		};
	}
	let raw: string;
	try {
		raw = fs.readFileSync(checkpointPath(directory), 'utf-8');
	} catch (err) {
		return {
			kind: 'invalid',
			reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			kind: 'invalid',
			reason: `malformed JSON (${err instanceof Error ? err.message : String(err)})`,
		};
	}
	const result = CheckpointSchema.safeParse(parsed);
	if (!result.success) {
		return { kind: 'invalid', reason: result.error.message };
	}
	const checkpoint = result.data;
	const recordCount = Object.keys(checkpoint.records).length;
	if (recordCount > PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords) {
		return {
			kind: 'invalid',
			reason: `records count ${recordCount} exceeds guard ${PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords}`,
		};
	}
	// Replay identity validation (issue #2042 Required 5): the checkpoint is
	// this store's own atomically-written artifact, so ANY record whose map key
	// or composite correlation key disagrees with its parts is tampering or
	// corruption — reject the whole checkpoint (quarantine + legacy recovery)
	// rather than expose an identity-invalid monitor.
	for (const [key, rec] of Object.entries(checkpoint.records)) {
		if (
			key !== rec.correlationId ||
			rec.correlationId !==
				buildCorrelationId(rec.sessionID, rec.repoFullName, rec.prNumber)
		) {
			return {
				kind: 'invalid',
				reason: `record identity mismatch at key "${key}"`,
			};
		}
	}
	return { kind: 'ok', value: checkpoint };
}

function freshCheckpoint(directory: string): PrSubscriptionCheckpoint {
	return {
		schemaVersion: 1,
		sequence: 0,
		rootPath: path.resolve(directory),
		updatedAt: Date.now(),
		records: {},
		terminalSummary: { removed: 0, expired: 0, lastTerminalAt: null },
		migration: null,
		maintenance: {
			compactions: 0,
			droppedAuditTransitions: 0,
			corruptLegacyRecords: 0,
			lastCompactedAt: null,
			resets: 0,
		},
	};
}

function cloneCheckpoint(
	cp: PrSubscriptionCheckpoint,
): PrSubscriptionCheckpoint {
	return JSON.parse(JSON.stringify(cp)) as PrSubscriptionCheckpoint;
}

/**
 * Validate a constructed record before it enters the store (v1 contract: the
 * append path validated every record; subscribe is the only raw-input creator).
 */
function validateRecord(record: PrSubscriptionRecord): void {
	const result = RecordSchema.safeParse(record);
	if (!result.success) {
		throw new Error(`Invalid subscription record: ${result.error.message}`);
	}
}

function writeCheckpointFile(
	directory: string,
	checkpoint: PrSubscriptionCheckpoint,
): void {
	const recordCount = Object.keys(checkpoint.records).length;
	if (recordCount > PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords) {
		// Writer-side enforcement of the replay guard: persisting a checkpoint
		// the reader would reject bricks the store (quarantine + reset), so
		// refuse the write instead. With terminal compaction applied first,
		// only a pathological active-set (config caps actives at 100) hits
		// this — loudly, with the operator remedy.
		throw new Error(
			`PR subscription store over checkpoint capacity: ${recordCount} records > ${PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords}. The folded state exceeds the bounded checkpoint — archive or split .swarm/pr-monitor/subscriptions.jsonl (subscriptions can be re-created with /swarm pr subscribe), then remove it.`,
		);
	}
	const content = `${JSON.stringify(checkpoint)}\n`;
	if (content.length > PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes) {
		throw new Error(
			`PR subscription store over checkpoint capacity: ${content.length} bytes > ${PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes}. The folded state exceeds the bounded checkpoint — archive or split .swarm/pr-monitor/subscriptions.jsonl (subscriptions can be re-created with /swarm pr subscribe), then remove it.`,
		);
	}
	if (content.length > PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes) {
		// Pressure signal only — active records are never dropped for bytes.
		log(
			`[pr-monitor] checkpoint pressure: ${content.length}/${PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes} bytes`,
		);
	}
	ensureSwarmDir(directory);
	atomicWriteSwarmFileSync(checkpointPath(directory), content);
}

function quarantineCheckpoint(
	directory: string,
	slot: 'foreign' | 'corrupt',
): boolean {
	const from = checkpointPath(directory);
	const to =
		slot === 'foreign'
			? foreignSlotPath(directory)
			: corruptSlotPath(directory);
	try {
		try {
			fs.unlinkSync(to);
		} catch {
			/* no previous slot */
		}
		renameWithRetry(from, to);
		return true;
	} catch (err) {
		log(
			`[pr-monitor] checkpoint quarantine (${slot}) failed: ${err instanceof Error ? err.message : String(err)} — the next checkpoint write replaces it`,
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Audit tail (issue #2042 Required 1/2/7)
// ---------------------------------------------------------------------------

function flushAuditEvents(
	directory: string,
	events: AuditEvent[],
	sequence: number,
	maintenance: PrSubscriptionMaintenance,
): void {
	if (events.length === 0) return;
	ensureSwarmDir(directory);
	const lines = events.map((event) =>
		JSON.stringify({
			ts: Date.now(),
			seq: sequence,
			kind: event.kind,
			...(event.correlationId ? { correlationId: event.correlationId } : {}),
		}),
	);
	try {
		fs.appendFileSync(auditPath(directory), `${lines.join('\n')}\n`, 'utf-8');
	} catch (err) {
		// Audit is diagnostic — a failed append never fails the store op and is
		// not counted in droppedAuditTransitions (which counts rewrite drops).
		log(
			`[pr-monitor] audit append failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	compactAuditTail(directory, maintenance);
}

function compactAuditTail(
	directory: string,
	maintenance: PrSubscriptionMaintenance,
): void {
	let size: number;
	try {
		size = fs.statSync(auditPath(directory)).size;
	} catch {
		return;
	}
	if (size <= PR_SUBSCRIPTION_LIMITS.auditMaxBytesLow) return;
	// Bounded read: only the newest 2×high-water bytes matter for a rewrite
	// that keeps the newest Low lines. An externally enlarged file must not
	// be loaded whole (same defense as auditStats).
	const windowBytes = 2 * PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh;
	let content: string;
	try {
		if (size > windowBytes) {
			const fd = fs.openSync(auditPath(directory), 'r');
			try {
				const tail = Buffer.alloc(windowBytes);
				const n = fs.readSync(fd, tail, 0, windowBytes, size - windowBytes);
				// Drop the first (almost certainly partial) line of the window.
				const text = tail.subarray(0, n).toString('utf-8');
				const firstNl = text.indexOf('\n');
				content = firstNl === -1 ? '' : text.slice(firstNl + 1);
			} finally {
				fs.closeSync(fd);
			}
		} else {
			content = fs.readFileSync(auditPath(directory), 'utf-8');
		}
	} catch {
		return;
	}
	const all = content.split('\n').filter((line) => line.trim().length > 0);
	if (
		all.length <= PR_SUBSCRIPTION_LIMITS.auditMaxLinesHigh &&
		size <= PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh
	) {
		return;
	}
	// Keep the newest lines (later file position = newer) under Low watermarks.
	const kept: string[] = [];
	let bytes = 0;
	for (let i = all.length - 1; i >= 0; i--) {
		const lineBytes = Buffer.byteLength(all[i], 'utf-8') + 1;
		if (
			kept.length >= PR_SUBSCRIPTION_LIMITS.auditMaxLinesLow ||
			bytes + lineBytes > PR_SUBSCRIPTION_LIMITS.auditMaxBytesLow
		) {
			break;
		}
		kept.unshift(all[i]);
		bytes += lineBytes;
	}
	const dropped = all.length - kept.length;
	try {
		atomicWriteSwarmFileSync(
			auditPath(directory),
			kept.length > 0 ? `${kept.join('\n')}\n` : '',
		);
		maintenance.droppedAuditTransitions += dropped;
	} catch (err) {
		log(
			`[pr-monitor] audit compaction failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function auditStats(directory: string): { lines: number; bytes: number } {
	try {
		const stat = fs.statSync(auditPath(directory));
		// The rewrite keeps the file bounded; an oversized file can only be
		// external tampering — count lines over a bounded prefix so the
		// diagnostic read stays bounded too (undercounted, bytes exact).
		let content: string;
		if (stat.size > 2 * PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh) {
			const fd = fs.openSync(auditPath(directory), 'r');
			try {
				const head = Buffer.alloc(2 * PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh);
				const n = fs.readSync(fd, head, 0, head.length, 0);
				content = head.subarray(0, n).toString('utf-8');
			} finally {
				fs.closeSync(fd);
			}
		} else {
			content = fs.readFileSync(auditPath(directory), 'utf-8');
		}
		return {
			lines: content.split('\n').filter((line) => line.trim().length > 0)
				.length,
			bytes: stat.size,
		};
	} catch {
		return { lines: 0, bytes: 0 };
	}
}

// ---------------------------------------------------------------------------
// Terminal compaction + legacy archive (issue #2042 Required 2/7)
// ---------------------------------------------------------------------------

function compactTerminalRecords(
	view: Record<string, PrSubscriptionRecord>,
	checkpoint: PrSubscriptionCheckpoint,
): AuditEvent | null {
	const now = Date.now();
	const terminals: Array<[string, PrSubscriptionRecord]> = Object.entries(view)
		.filter(([, rec]) => rec.status !== 'active')
		.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
	if (terminals.length === 0) return null;
	const hasAged = terminals.some(
		([, rec]) => now - rec.updatedAt > PR_SUBSCRIPTION_LIMITS.terminalMaxAgeMs,
	);
	if (
		!hasAged &&
		terminals.length <= PR_SUBSCRIPTION_LIMITS.terminalRecordsHigh
	) {
		return null;
	}
	let kept = 0;
	for (const [key, rec] of terminals) {
		const aged = now - rec.updatedAt > PR_SUBSCRIPTION_LIMITS.terminalMaxAgeMs;
		if (aged || kept >= PR_SUBSCRIPTION_LIMITS.terminalRecordsLow) {
			if (rec.status === 'removed') checkpoint.terminalSummary.removed += 1;
			else checkpoint.terminalSummary.expired += 1;
			checkpoint.terminalSummary.lastTerminalAt = Math.max(
				checkpoint.terminalSummary.lastTerminalAt ?? 0,
				rec.updatedAt,
			);
			delete view[key];
		} else {
			kept += 1;
		}
	}
	checkpoint.maintenance.compactions += 1;
	checkpoint.maintenance.lastCompactedAt = now;
	return { kind: 'compact' };
}

function maybeArchiveLegacy(
	directory: string,
	checkpoint: PrSubscriptionCheckpoint,
): AuditEvent | null {
	const migration = checkpoint.migration;
	if (!migration || !migration.done || migration.archived) return null;
	const legacy = storePath(directory);
	const size = fileSizeOrNull(legacy);
	if (size === null) {
		// Crash-after-rename repair: already gone → mark archived.
		migration.archived = true;
		return null;
	}
	if (size !== migration.sourceBytes) return null; // unstable — wait
	try {
		try {
			fs.unlinkSync(legacyArchivePath(directory));
		} catch {
			/* no previous archive */
		}
		renameWithRetry(legacy, legacyArchivePath(directory));
	} catch (err) {
		log(
			`[pr-monitor] legacy archive deferred: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
	migration.archived = true;
	return { kind: 'archive' };
}

function cleanupStaleLegacyArchive(directory: string): void {
	try {
		const stat = fs.statSync(legacyArchivePath(directory));
		if (Date.now() - stat.mtimeMs > PR_SUBSCRIPTION_LIMITS.legacyArchiveTtlMs) {
			fs.unlinkSync(legacyArchivePath(directory));
		}
	} catch {
		/* absent or already removed */
	}
}

function emitHealthTelemetry(
	trigger:
		| 'compact'
		| 'migrate-complete'
		| 'archive'
		| 'foreign-rebind'
		| 'corrupt-quarantine',
	checkpoint: PrSubscriptionCheckpoint,
): void {
	const records = Object.values(checkpoint.records);
	telemetry.prSubscriptionHealth({
		trigger,
		active_count: records.filter((r) => r.status === 'active').length,
		terminal_count: records.filter((r) => r.status !== 'active').length,
		compactions: checkpoint.maintenance.compactions,
		corrupt_count: checkpoint.maintenance.corruptLegacyRecords,
		dropped_audit_count: checkpoint.maintenance.droppedAuditTransitions,
		checkpoint_bytes: JSON.stringify(checkpoint).length,
		limit_bytes: PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes,
	});
}

// ---------------------------------------------------------------------------
// View loading
// ---------------------------------------------------------------------------

interface LoadedView {
	checkpoint: PrSubscriptionCheckpoint;
	/** Merged view (checkpoint records ∪ overlay). Ops mutate this. */
	view: Record<string, PrSubscriptionRecord>;
	/** Load-time transitions (foreign-rebind / corrupt-quarantine / migrate-complete). */
	audit: AuditEvent[];
	dirty: boolean;
}

/** Bounded once-per-directory over-limit warnings (diagnostic only). */
const legacyOverLimitWarned = new Map<string, boolean>();
function warnLegacyOverLimit(directory: string, size: number): void {
	if (legacyOverLimitWarned.has(directory)) return;
	if (legacyOverLimitWarned.size >= 32) {
		legacyOverLimitWarned.delete(legacyOverLimitWarned.keys().next().value!);
	}
	legacyOverLimitWarned.set(directory, true);
	log(
		`[pr-monitor] legacy subscriptions.jsonl is ${size} bytes (>${PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes}); refusing to fold it — archive or split the file so its subscriptions can be re-subscribed, then remove it (reported via /swarm pr status)`,
	);
}

/** Bounded once-per-directory migration-capacity warnings (diagnostic only). */
const migrationCapacityWarned = new Map<string, boolean>();
function warnMigrationCapacity(directory: string, records: number): void {
	if (migrationCapacityWarned.has(directory)) return;
	if (migrationCapacityWarned.size >= 32) {
		migrationCapacityWarned.delete(
			migrationCapacityWarned.keys().next().value!,
		);
	}
	migrationCapacityWarned.set(directory, true);
	log(
		`[pr-monitor] legacy subscriptions.jsonl folds to ${records} records (>checkpoint capacity ${PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords}); migration refused — archive or split the file so its subscriptions can be re-subscribed, then remove it`,
	);
}

/**
 * Overlay the legacy log onto checkpoint records per the migration state.
 * Shared by read and health paths. Bounded-memory streaming fold; the fold
 * work per invocation is bounded by `legacySourceMaxBytes` (over-limit
 * sources are refused, never scanned).
 */
function overlayLegacy(
	directory: string,
	checkpoint: PrSubscriptionCheckpoint,
): {
	view: Record<string, PrSubscriptionRecord>;
	usedLegacy: boolean;
	absorbed: number;
	corruptLines: number;
	overLimit: boolean;
} {
	const view: Record<string, PrSubscriptionRecord> = { ...checkpoint.records };
	const legacy = storePath(directory);
	let stat: fs.Stats | null = null;
	try {
		stat = fs.statSync(legacy);
	} catch {
		// Fresh store or post-archive — checkpoint only (O(1) stat).
	}
	if (stat === null) {
		return {
			view,
			usedLegacy: false,
			absorbed: 0,
			corruptLines: 0,
			overLimit: false,
		};
	}
	if (stat.size > PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes) {
		// Explicit finite work budget: refuse to fold an over-ceiling legacy
		// source; report it (health + status footer + one logged warning).
		warnLegacyOverLimit(directory, stat.size);
		return {
			view,
			usedLegacy: false,
			absorbed: 0,
			corruptLines: 0,
			overLimit: true,
		};
	}
	const migration = checkpoint.migration;
	if (migration === null || !migration.done) {
		let cursor = migration?.scannedBytes ?? 0;
		if (cursor > stat.size) cursor = 0; // regressed/recreated file — restart cursor
		const fold = foldLegacyRegion(legacy, cursor, Number.MAX_SAFE_INTEGER);
		const absorbed = mergeFoldedRecords(view, fold.folded);
		return {
			view,
			usedLegacy: true,
			absorbed,
			corruptLines: fold.corruptLines,
			overLimit: false,
		};
	}
	// Migration is done: consult the legacy file only when it changed. Size
	// alone cannot see a same-size rewrite, so mtime is the second signal.
	if (
		stat.size === migration.sourceBytes &&
		stat.mtimeMs === migration.sourceMtimeMs
	) {
		return {
			view,
			usedLegacy: false,
			absorbed: 0,
			corruptLines: 0,
			overLimit: false,
		};
	}
	// Changed (downgrade writer / recreated file) — full bounded-memory re-fold.
	const fold = foldLegacyRegion(legacy, 0, Number.MAX_SAFE_INTEGER);
	const absorbed = mergeFoldedRecords(view, fold.folded);
	return {
		view,
		usedLegacy: true,
		absorbed,
		corruptLines: fold.corruptLines,
		overLimit: false,
	};
}

/**
 * Load the folded view for READS (lock-free). When no checkpoint exists but a
 * legacy log does, the folded view is computed first and returned regardless;
 * then a one-time read-bootstrap persists the first checkpoint under a short
 * lock so read-only installs also converge to bounded reads (issue #2042
 * Required 3; plan-critic item 1).
 */
async function loadViewForRead(directory: string): Promise<{
	view: Record<string, PrSubscriptionRecord>;
	recoverySource: PrSubscriptionRecoverySource;
}> {
	const read = readCheckpoint(directory);
	if (read.kind === 'ok') {
		if (!sameProjectRoot(read.value.rootPath, directory)) {
			// Copied .swarm — reads see nothing; never start the wrong monitor.
			return { view: {}, recoverySource: 'foreign' };
		}
		const overlaid = overlayLegacy(directory, read.value);
		return {
			view: overlaid.view,
			recoverySource: overlaid.usedLegacy ? 'checkpoint+legacy' : 'checkpoint',
		};
	}
	if (read.kind === 'invalid') {
		// Corrupt checkpoint: reads stay pure (no quarantine here — the write
		// path or read-bootstrap quarantines); recover from the legacy log
		// within the finite fold budget.
		const legacy = storePath(directory);
		const view: Record<string, PrSubscriptionRecord> = {};
		const size = fileSizeOrNull(legacy);
		if (size !== null && size <= PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes) {
			const fold = foldLegacyRegion(legacy, 0, Number.MAX_SAFE_INTEGER);
			mergeFoldedRecords(view, fold.folded);
		} else if (size !== null) {
			warnLegacyOverLimit(directory, size);
		}
		return { view, recoverySource: 'corrupt-recovered' };
	}
	// No checkpoint.
	const legacyPath = storePath(directory);
	const legacySize = fileSizeOrNull(legacyPath);
	if (legacySize === null) {
		return { view: {}, recoverySource: 'empty' };
	}
	if (legacySize > PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes) {
		warnLegacyOverLimit(directory, legacySize);
		return { view: {}, recoverySource: 'legacy-log' };
	}
	const fold = foldLegacyRegion(legacyPath, 0, Number.MAX_SAFE_INTEGER);
	const view: Record<string, PrSubscriptionRecord> = {};
	mergeFoldedRecords(view, fold.folded);
	// One-time read-bootstrap (best-effort, bounded lock timeout).
	await bootstrapCheckpointFromLegacy(directory, view, fold);
	return { view, recoverySource: 'legacy-log' };
}

/**
 * Persist-if-absent checkpoint bootstrap from a legacy fold. The fold was
 * computed outside the lock; a writer that creates a checkpoint first wins
 * and the bootstrap skips (issue #2042 Required 3).
 */
async function bootstrapCheckpointFromLegacy(
	directory: string,
	foldedView: Record<string, PrSubscriptionRecord>,
	fold: LegacyFoldResult,
): Promise<void> {
	try {
		await withEvidenceLock(
			directory,
			PR_SUBSCRIPTIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				// Another process may have won the race — persist only if the
				// checkpoint is still absent (a corrupt file is left for the
				// write path to quarantine).
				if (readCheckpoint(directory).kind !== 'absent') return;
				const checkpoint = freshCheckpoint(directory);
				checkpoint.records = { ...foldedView };
				const terminals = Object.values(foldedView).filter(
					(rec) => rec.status !== 'active',
				);
				checkpoint.terminalSummary.lastTerminalAt = terminals.length
					? Math.max(...terminals.map((rec) => rec.updatedAt))
					: null;
				checkpoint.maintenance.corruptLegacyRecords = fold.corruptLines;
				let bootstrapMtime = 0;
				try {
					bootstrapMtime = fs.statSync(storePath(directory)).mtimeMs;
				} catch {
					/* vanished mid-bootstrap — cursor records what was folded */
				}
				// sourceBytes intentionally snapshots the FOLD-TIME size (the
				// fold cursor), not a fresh stat: if the legacy file changed
				// between the fold and this persist, the size/mtime mismatch is
				// detected on the next read and the change is re-folded — a
				// fresh (larger) size here could instead claim stability over
				// bytes that were never folded.
				checkpoint.migration = {
					scannedBytes: fold.nextByte,
					sourceBytes: fold.nextByte,
					sourceMtimeMs: bootstrapMtime,
					corruptLines: fold.corruptLines,
					done: true,
					archived: false,
					startedAt: Date.now(),
				};
				checkpoint.sequence = 1;
				checkpoint.updatedAt = Date.now();
				writeCheckpointFile(directory, checkpoint);
				flushAuditEvents(
					directory,
					[{ kind: 'migrate-complete' }],
					checkpoint.sequence,
					checkpoint.maintenance,
				);
				emitHealthTelemetry('migrate-complete', checkpoint);
			},
			PR_SUBSCRIPTION_LIMITS.bootstrapLockTimeoutMs,
		);
	} catch (err) {
		// Best-effort only — the read result was already computed.
		log(
			`[pr-monitor] read-bootstrap skipped: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Load the folded view for WRITES (called inside the evidence lock): handles
 * foreign/corrupt quarantine (quarantine → later checkpoint write ordering),
 * advances the incremental migration cursor with crash-resumable progress
 * persists, and absorbs changed legacy tails.
 */
function loadViewForWrite(directory: string): LoadedView {
	const audit: AuditEvent[] = [];
	let dirty = false;

	let checkpoint: PrSubscriptionCheckpoint;
	const read = readCheckpoint(directory);
	if (read.kind === 'ok' && sameProjectRoot(read.value.rootPath, directory)) {
		checkpoint = cloneCheckpoint(read.value);
	} else if (read.kind === 'ok') {
		// Foreign checkpoint: quarantine first, rebind to this root.
		quarantineCheckpoint(directory, 'foreign');
		checkpoint = freshCheckpoint(directory);
		checkpoint.maintenance.resets += 1;
		audit.push({ kind: 'foreign-rebind' });
		dirty = true;
	} else if (read.kind === 'invalid') {
		quarantineCheckpoint(directory, 'corrupt');
		checkpoint = freshCheckpoint(directory);
		checkpoint.maintenance.resets += 1;
		audit.push({ kind: 'corrupt-quarantine' });
		dirty = true;
	} else {
		checkpoint = freshCheckpoint(directory);
	}

	const legacy = storePath(directory);
	let legacyStat: fs.Stats | null = null;
	try {
		legacyStat = fs.statSync(legacy);
	} catch {
		/* no legacy source */
	}
	let view: Record<string, PrSubscriptionRecord>;

	if (legacyStat === null) {
		view = { ...checkpoint.records };
		// Crash-after-archive-rename repair.
		if (checkpoint.migration?.done && !checkpoint.migration.archived) {
			checkpoint.migration.archived = true;
			dirty = true;
		}
		return { checkpoint, view, audit, dirty };
	}

	if (legacyStat.size > PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes) {
		// Explicit finite work budget: an over-ceiling legacy source is never
		// folded and never archived (archiving unabsorbed data would lose it
		// silently). Refuse, report, and operate from the checkpoint state.
		warnLegacyOverLimit(directory, legacyStat.size);
		return { checkpoint, view: { ...checkpoint.records }, audit, dirty };
	}

	const legacySize = legacyStat.size;
	const legacyMtime = legacyStat.mtimeMs;
	const migration = checkpoint.migration;
	if (migration === null || !migration.done) {
		// Incremental migration with per-chunk progress persists. Size and
		// mtime are snapshotted before the loop: an external actor replacing
		// the legacy file MID-loop (bypassing the evidence lock) can produce a
		// mixed fold for this one op, but the persisted sourceBytes/mtime then
		// disagree with the new file, so the next op force-re-folds it and
		// converges (every record stays schema/identity validated).
		let cursor = migration?.scannedBytes ?? 0;
		if (cursor > legacySize) cursor = 0; // regressed/recreated file — restart cursor
		const startedAt = migration?.startedAt ?? Date.now();
		let corruptTotal = migration?.corruptLines ?? 0;
		view = { ...checkpoint.records };
		let capacityRefused = false;
		while (true) {
			const fold = foldLegacyRegion(
				legacy,
				cursor,
				PR_SUBSCRIPTION_LIMITS.migrationChunkBytes,
			);
			mergeFoldedRecords(view, fold.folded);
			checkpoint.maintenance.corruptLegacyRecords += fold.corruptLines;
			corruptTotal += fold.corruptLines;
			cursor = fold.nextByte;

			// The persisted state must stay within checkpoint replay capacity:
			// compact terminals first (drops most of a long-lived store's
			// history), then refuse to advance once the folded live set itself
			// exceeds the guard. A refused migration never completes and never
			// archives — reads keep folding the legacy source (correct, v1
			// cost, disclosed) and writes fail loudly with the capacity error.
			const compactEvent = compactTerminalRecords(view, checkpoint);
			if (compactEvent) audit.push(compactEvent);
			if (
				Object.keys(view).length > PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords
			) {
				capacityRefused = true;
				warnMigrationCapacity(directory, Object.keys(view).length);
				break;
			}

			if (!fold.eof) {
				// Crash-resumable progress persist. Total per-op fold work is
				// bounded by legacySourceMaxBytes (checked above).
				const progress = cloneCheckpoint(checkpoint);
				progress.records = { ...view };
				progress.migration = {
					scannedBytes: cursor,
					sourceBytes: legacySize,
					sourceMtimeMs: legacyMtime,
					corruptLines: corruptTotal,
					done: false,
					archived: false,
					startedAt,
				};
				progress.updatedAt = Date.now();
				progress.sequence += 1;
				writeCheckpointFile(directory, progress);
				checkpoint.sequence = progress.sequence;
				dirty = true;
				continue;
			}
			checkpoint.migration = {
				scannedBytes: cursor,
				sourceBytes: legacySize,
				sourceMtimeMs: legacyMtime,
				corruptLines: corruptTotal,
				done: true,
				archived: false,
				startedAt,
			};
			audit.push({ kind: 'migrate-complete' });
			dirty = true;
			break;
		}
		if (capacityRefused) {
			// Do not persist anything from a refused fold: the in-memory view
			// stays correct for THIS op, but the durable state must not claim
			// a scan the reader could never replay.
			return { checkpoint, view, audit, dirty: false };
		}
		return { checkpoint, view, audit, dirty };
	}

	// Migration done: absorb a changed legacy tail (downgrade writer /
	// recreated file) so future reads skip the re-fold; stable → checkpoint only.
	const overlaid = overlayLegacy(directory, checkpoint);
	view = overlaid.view;
	if (overlaid.usedLegacy) {
		// A changed source was folded. Settle the size+mtime fingerprint even
		// when no record won the merge — otherwise a source of losing/older
		// records (or pure garbage) would be re-folded on EVERY read forever.
		// Re-enter the archive path so the now-stable source gets archived.
		migration.sourceBytes = legacySize;
		migration.sourceMtimeMs = legacyMtime;
		migration.scannedBytes = legacySize;
		migration.archived = false;
		checkpoint.maintenance.corruptLegacyRecords += overlaid.corruptLines;
		dirty = true;
	}
	return { checkpoint, view, audit, dirty };
}

// ---------------------------------------------------------------------------
// Write finalization (order: compaction → archive → audit → checkpoint write)
// ---------------------------------------------------------------------------

function finalizeWrite(
	directory: string,
	loaded: LoadedView,
	opAudit: AuditEvent[],
): void {
	const { checkpoint } = loaded;
	const events: AuditEvent[] = [...loaded.audit, ...opAudit];

	const compactEvent = compactTerminalRecords(loaded.view, checkpoint);
	if (compactEvent) events.push(compactEvent);

	if (!loaded.dirty && events.length === 0) return;

	checkpoint.records = loaded.view;
	checkpoint.updatedAt = Date.now();
	checkpoint.rootPath = path.resolve(directory);
	checkpoint.sequence += 1;
	// Audit is flushed BEFORE the checkpoint write so compactAuditTail's
	// dropped-transition counter lands in the same persisted write. If the
	// checkpoint write then throws (ENOSPC/capacity), the audit tail keeps
	// lines for an op whose state never landed — acceptable: the tail is
	// diagnostic-only (no decision logic reads it) and bounded. Durable
	// state still comes first in the ordering that matters:
	// writeCheckpointFile enforces checkpoint replay capacity and throws
	// before the legacy archive rename, so a capacity violation can never
	// follow an already-archived legacy source (which would strand the only
	// copy of unabsorbed records).
	flushAuditEvents(
		directory,
		events,
		checkpoint.sequence,
		checkpoint.maintenance,
	);
	writeCheckpointFile(directory, checkpoint);

	// Safe to archive the stable legacy source now; a crash between the write
	// and this rename resumes archiving on the next op (or repairs via the
	// absent-file path in loadViewForWrite).
	const archiveEvent = maybeArchiveLegacy(directory, checkpoint);
	if (archiveEvent) {
		events.push(archiveEvent);
		// Persist the archived flag in the same op so on-disk state converges
		// immediately (a crash between the rename and this second write is
		// repaired by the absent-file path in loadViewForWrite).
		checkpoint.sequence += 1;
		flushAuditEvents(
			directory,
			[archiveEvent],
			checkpoint.sequence,
			checkpoint.maintenance,
		);
		writeCheckpointFile(directory, checkpoint);
	}
	cleanupStaleLegacyArchive(directory);

	for (const kind of [
		'compact',
		'migrate-complete',
		'archive',
		'foreign-rebind',
		'corrupt-quarantine',
	] as const) {
		if (events.some((event) => event.kind === kind)) {
			emitHealthTelemetry(kind, checkpoint);
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to PR monitoring. Creates a new `active` subscription record. If an
 * active subscription with the same correlationId already exists, returns the
 * existing record (idempotent). Throws if the number of active subscriptions
 * would exceed the limit — the explicit `maxSubscriptions` when provided, else
 * the store-side safety net (`PR_SUBSCRIPTION_LIMITS.defaultMaxActiveSubscriptions`).
 */
export async function subscribe(
	directory: string,
	input: SubscribeInput,
): Promise<PrSubscriptionRecord> {
	// Validate required inputs
	if (!directory || directory.trim() === '') {
		throw new Error('directory is required');
	}
	if (!input.sessionID || input.sessionID.trim() === '') {
		throw new Error('sessionID is required and must be non-empty');
	}
	if (!input.repoFullName || input.repoFullName.trim() === '') {
		throw new Error('repoFullName is required and must be non-empty');
	}
	if (!input.prUrl || input.prUrl.trim() === '') {
		throw new Error('prUrl is required and must be non-empty');
	}
	if (
		!input.prNumber ||
		!Number.isInteger(input.prNumber) ||
		input.prNumber <= 0
	) {
		throw new Error('prNumber is required and must be a positive integer');
	}

	const correlationId = buildCorrelationId(
		input.sessionID,
		input.repoFullName,
		input.prNumber,
	);
	const now = Date.now();

	return withEvidenceLock(
		directory,
		PR_SUBSCRIPTIONS_FILE,
		STORE_LOCK_AGENT,
		STORE_LOCK_TASK,
		async () => {
			const loaded = loadViewForWrite(directory);
			const match = Object.values(loaded.view).find(
				(r) => r.correlationId === correlationId && r.status === 'active',
			);
			if (match) {
				// Lazy-start trigger for existing subscription (e.g., after plugin restart)
				onSubscriptionCreated?.(directory, match);
				finalizeWrite(directory, loaded, []);
				return match;
			}

			// Enforce the live-subscription limit: the explicit value wins, `0`
			// (and negatives) disable, omitted falls back to the store-side net.
			if (input.maxSubscriptions === undefined || input.maxSubscriptions > 0) {
				const limit =
					input.maxSubscriptions !== undefined
						? input.maxSubscriptions
						: PR_SUBSCRIPTION_LIMITS.defaultMaxActiveSubscriptions;
				const activeCount = Object.values(loaded.view).filter(
					(r) => r.status === 'active',
				).length;
				if (activeCount >= limit) {
					throw new Error(
						`PR subscription limit reached: ${activeCount}/${limit}`,
					);
				}
			}

			const record: PrSubscriptionRecord = {
				correlationId,
				sessionID: input.sessionID,
				prNumber: input.prNumber,
				repoFullName: input.repoFullName,
				prUrl: input.prUrl,
				lastCheckedAt: now,
				isWatching: true,
				hasUnaddressedEvents: false,
				status: 'active',
				createdAt: now,
				updatedAt: now,
				errorCount: 0,
			};
			validateRecord(record);

			loaded.view[correlationId] = record;
			loaded.dirty = true;

			finalizeWrite(directory, loaded, [{ kind: 'subscribe', correlationId }]);

			// Lazy-start trigger: ensure the PR monitor worker is running
			// now that we have at least one active subscription.
			onSubscriptionCreated?.(directory, record);

			return record;
		},
	);
}

/**
 * Unsubscribe from PR monitoring. Transitions the active record for the given
 * correlationId to `status='removed'`. Returns the removed record, or null if
 * no active subscription was found.
 */
export async function unsubscribe(
	directory: string,
	correlationId: string,
): Promise<PrSubscriptionRecord | null> {
	if (!correlationId) return null;

	return withEvidenceLock(
		directory,
		PR_SUBSCRIPTIONS_FILE,
		STORE_LOCK_AGENT,
		STORE_LOCK_TASK,
		async () => {
			const loaded = loadViewForWrite(directory);
			const match = Object.values(loaded.view).find(
				(r) => r.correlationId === correlationId && r.status === 'active',
			);
			if (!match) {
				finalizeWrite(directory, loaded, []);
				return null;
			}

			const now = Date.now();
			const removed: PrSubscriptionRecord = {
				...match,
				status: 'removed',
				isWatching: false,
				updatedAt: now,
			};
			loaded.view[correlationId] = removed;
			loaded.dirty = true;
			finalizeWrite(directory, loaded, [
				{ kind: 'unsubscribe', correlationId },
			]);
			return removed;
		},
	);
}

/**
 * List all active subscriptions. Lock-free bounded read: checkpoint plus, while
 * a legacy source is pending, its folded tail.
 */
export async function listActive(
	directory: string,
): Promise<PrSubscriptionRecord[]> {
	const { view } = await loadViewForRead(directory);
	return Object.values(view).filter((r) => r.status === 'active');
}

/**
 * Look up an active subscription for a specific PR. Lock-free bounded read.
 */
export async function lookupByPr(
	directory: string,
	repoFullName: string,
	prNumber: number,
): Promise<PrSubscriptionRecord | null> {
	const { view } = await loadViewForRead(directory);
	for (const record of Object.values(view)) {
		if (
			record.status === 'active' &&
			record.repoFullName === repoFullName &&
			record.prNumber === prNumber
		) {
			return record;
		}
	}
	return null;
}

/**
 * Update the snapshot for a given correlationId. Merges `updates` into the
 * existing active record and persists the new snapshot. Returns the merged
 * record, or null if no active subscription was found.
 */
export async function updateSnapshot(
	directory: string,
	correlationId: string,
	updates: Partial<PrSubscriptionRecord>,
): Promise<PrSubscriptionRecord | null> {
	if (!correlationId) return null;

	return withEvidenceLock(
		directory,
		PR_SUBSCRIPTIONS_FILE,
		STORE_LOCK_AGENT,
		STORE_LOCK_TASK,
		async () => {
			const loaded = loadViewForWrite(directory);
			const match = Object.values(loaded.view).find(
				(r) => r.correlationId === correlationId && r.status === 'active',
			);
			if (!match) {
				finalizeWrite(directory, loaded, []);
				return null;
			}

			const updated: PrSubscriptionRecord = {
				...match,
				...updates,
				// Preserve all identity/lookup fields — never allow mutation via updates
				correlationId,
				sessionID: match.sessionID,
				repoFullName: match.repoFullName,
				prNumber: match.prNumber,
				prUrl: match.prUrl,
				createdAt: match.createdAt,
				updatedAt: Date.now(),
			};
			loaded.view[correlationId] = updated;
			loaded.dirty = true;
			// Per-poll snapshot updates are not transitions — no audit line.
			finalizeWrite(directory, loaded, []);
			return updated;
		},
	);
}

/**
 * Sweep stale subscriptions. Marks subscriptions as `expired` when:
 *   (a) They are `active` AND appear in the `mergedPrs` set (PR was merged/closed), OR
 *   (b) They have had no state change for `ttlDays` AND `hasUnaddressedEvents` is false.
 *
 * Subscriptions with `hasUnaddressedEvents === true` are NEVER swept unless the
 * PR is in the merged/closed set. Swept history is compacted by the bounded
 * checkpoint/audit model (terminal records and audit lines are bounded; active
 * records — including unaddressed-event actives — are never dropped).
 *
 * @param directory - Project root directory
 * @param ttlDays - Days of inactivity before considering a subscription stale
 * @param mergedPrs - Set of "repoFullName::prNumber" strings for merged/closed PRs
 * @returns Number of subscriptions swept
 */
export async function sweepStale(
	directory: string,
	ttlDays: number,
	mergedPrs?: ReadonlySet<string>,
): Promise<number> {
	if (!ttlDays || ttlDays <= 0) return 0;
	const ttlMs = ttlDays * 86_400_000;
	const now = Date.now();

	try {
		return await withEvidenceLock(
			directory,
			PR_SUBSCRIPTIONS_FILE,
			STORE_LOCK_AGENT,
			STORE_LOCK_TASK,
			async () => {
				const loaded = loadViewForWrite(directory);
				const opAudit: AuditEvent[] = [];
				let swept = 0;
				for (const record of Object.values(loaded.view)) {
					if (record.status !== 'active') continue;

					const prKey = `${record.repoFullName}::${record.prNumber}`;
					const isMerged = mergedPrs?.has(prKey) ?? false;
					const isStale = now - record.updatedAt > ttlMs;

					// Sweep merged/closed PRs regardless of events
					if (isMerged) {
						loaded.view[record.correlationId] = {
							...record,
							status: 'expired',
							isWatching: false,
							updatedAt: now,
						};
						swept += 1;
						opAudit.push({
							kind: 'expired',
							correlationId: record.correlationId,
						});
						loaded.dirty = true;
						log(`[pr-monitor] Swept subscription: merged/closed: ${prKey}`);
						continue;
					}

					// Sweep stale subscriptions only if no unaddressed events
					if (isStale && !record.hasUnaddressedEvents) {
						loaded.view[record.correlationId] = {
							...record,
							status: 'expired',
							isWatching: false,
							updatedAt: now,
						};
						swept += 1;
						opAudit.push({
							kind: 'expired',
							correlationId: record.correlationId,
						});
						loaded.dirty = true;
						log(
							`[pr-monitor] Swept subscription: stale (TTL ${ttlDays}d): ${prKey}`,
						);
					}
				}
				finalizeWrite(directory, loaded, opAudit);
				return swept;
			},
		);
	} catch (err) {
		log(
			`[pr-monitor] sweepStale failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 0;
	}
}

/**
 * Bounded store health (issue #2042 Required 8). Pure read — no bootstrap, no
 * quarantine, never throws.
 */
export async function getPrSubscriptionHealth(
	directory: string,
): Promise<PrSubscriptionHealth> {
	try {
		const read = readCheckpoint(directory);
		const audit = auditStats(directory);
		const archiveBytes = fileSizeOrNull(legacyArchivePath(directory)) ?? 0;
		const checkpointBytes = fileSizeOrNull(checkpointPath(directory)) ?? 0;
		const legacySize = fileSizeOrNull(storePath(directory));
		const legacyOverLimit =
			legacySize !== null &&
			legacySize > PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes;

		let health: PrSubscriptionHealth;
		if (
			read.kind === 'ok' &&
			!sameProjectRoot(read.value.rootPath, directory)
		) {
			health = emptyHealth();
			health.recoverySource = 'foreign';
		} else if (read.kind === 'invalid') {
			// Corrupt checkpoint: report recovery from the legacy log within
			// the finite fold budget (over-limit sources are never folded).
			if (legacySize !== null && !legacyOverLimit) {
				const fold = foldLegacyRegion(
					storePath(directory),
					0,
					Number.MAX_SAFE_INTEGER,
				);
				const view: Record<string, PrSubscriptionRecord> = {};
				mergeFoldedRecords(view, fold.folded);
				health = healthFromView(view, freshCheckpoint(directory));
				health.corruptLegacyRecords = fold.corruptLines;
			} else {
				health = emptyHealth();
			}
			health.recoverySource = 'corrupt-recovered';
		} else if (read.kind === 'absent') {
			if (legacySize === null || legacyOverLimit) {
				health = emptyHealth();
			} else {
				const fold = foldLegacyRegion(
					storePath(directory),
					0,
					Number.MAX_SAFE_INTEGER,
				);
				const view: Record<string, PrSubscriptionRecord> = {};
				mergeFoldedRecords(view, fold.folded);
				health = healthFromView(view, freshCheckpoint(directory));
				health.corruptLegacyRecords = fold.corruptLines;
			}
			health.recoverySource = legacySize === null ? 'empty' : 'legacy-log';
		} else {
			const overlaid = overlayLegacy(directory, read.value);
			health = healthFromView(overlaid.view, read.value);
			health.recoverySource = overlaid.usedLegacy
				? 'checkpoint+legacy'
				: 'checkpoint';
		}
		health.legacyOverLimit = legacyOverLimit;
		applyFileStats(health, checkpointBytes, audit, archiveBytes);
		return health;
	} catch (err) {
		log(
			`[pr-monitor] getPrSubscriptionHealth failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return emptyHealth();
	}
}

function applyFileStats(
	health: PrSubscriptionHealth,
	checkpointBytes: number,
	audit: { lines: number; bytes: number },
	archiveBytes: number,
): void {
	health.checkpointBytes = checkpointBytes;
	health.pressurePct =
		checkpointBytes === 0
			? 0
			: Math.round((checkpointBytes / health.checkpointLimitBytes) * 1000) / 10;
	health.auditLines = audit.lines;
	health.auditBytes = audit.bytes;
	health.legacyArchiveBytes = archiveBytes;
}

function emptyHealth(): PrSubscriptionHealth {
	return {
		schemaVersion: 1,
		sequence: 0,
		checkpointAgeMs: null,
		checkpointBytes: 0,
		checkpointLimitBytes: PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes,
		pressurePct: 0,
		activeCount: 0,
		removedCount: 0,
		expiredCount: 0,
		terminalSummary: { removed: 0, expired: 0, lastTerminalAt: null },
		auditLines: 0,
		auditBytes: 0,
		auditLimitBytes: PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh,
		compactions: 0,
		corruptLegacyRecords: 0,
		droppedAuditTransitions: 0,
		resets: 0,
		recoverySource: 'empty',
		migration: null,
		legacyArchiveBytes: 0,
		legacyOverLimit: false,
	};
}

function healthFromView(
	view: Record<string, PrSubscriptionRecord>,
	checkpoint: PrSubscriptionCheckpoint,
): PrSubscriptionHealth {
	const records = Object.values(view);
	const health = emptyHealth();
	health.sequence = checkpoint.sequence;
	health.checkpointAgeMs =
		checkpoint.sequence > 0 ? Date.now() - checkpoint.updatedAt : null;
	health.activeCount = records.filter((r) => r.status === 'active').length;
	health.removedCount = records.filter((r) => r.status === 'removed').length;
	health.expiredCount = records.filter((r) => r.status === 'expired').length;
	health.terminalSummary = { ...checkpoint.terminalSummary };
	health.compactions = checkpoint.maintenance.compactions;
	health.corruptLegacyRecords = checkpoint.maintenance.corruptLegacyRecords;
	health.droppedAuditTransitions =
		checkpoint.maintenance.droppedAuditTransitions;
	health.resets = checkpoint.maintenance.resets;
	health.migration = checkpoint.migration
		? {
				done: checkpoint.migration.done,
				scannedBytes: checkpoint.migration.scannedBytes,
				sourceBytes: checkpoint.migration.sourceBytes,
			}
		: null;
	return health;
}

/**
 * Dependency-injection seam for unit tests (repo convention — never
 * mock.module). Restore in afterEach.
 */
export const _internals = {
	foldLegacyRegion,
	mergeFoldedRecords,
	sameProjectRoot,
};

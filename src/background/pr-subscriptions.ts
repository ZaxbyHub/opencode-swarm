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
import { observeStoreHealth } from '../health/learning-health.js';
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
const FOREIGN_LEGACY_FILE = 'pr-monitor/subscriptions.legacy.foreign.jsonl';

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
	/** Maximum legacy bytes folded while one mutation holds the store lock. */
	migrationMaxBytesPerOperation: 8 * 1024 * 1024,
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
		customCooldownSeconds: z.number().int().min(0).optional(),
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
	/** Byte cursor; may sit inside an oversized line when discard state is true. */
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
	discardingOversizeLine: boolean;
	/** Native checkpoint authority captured before any legacy records are folded. */
	baselineRecords: Record<string, PrSubscriptionRecord>;
	baselineTerminalSummary: PrSubscriptionTerminalSummary;
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
		discardingOversizeLine: z.boolean().optional().default(false),
		baselineRecords: z.record(z.string(), RecordSchema).optional().default({}),
		baselineTerminalSummary: TerminalSummarySchema.optional().default({
			removed: 0,
			expired: 0,
			lastTerminalAt: null,
		}),
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

function legacyArchiveNextPath(directory: string): string {
	return `${legacyArchivePath(directory)}.next`;
}

function legacyArchivePreviousPath(directory: string): string {
	return `${legacyArchivePath(directory)}.previous`;
}

function fileExistsStrict(filePath: string): boolean {
	try {
		fs.statSync(filePath);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw err;
	}
}

function foreignSlotPath(directory: string): string {
	return validateSwarmPath(directory, FOREIGN_CHECKPOINT_FILE);
}

function corruptSlotPath(directory: string): string {
	return validateSwarmPath(directory, CORRUPT_CHECKPOINT_FILE);
}

function foreignLegacySlotPath(directory: string): string {
	return validateSwarmPath(directory, FOREIGN_LEGACY_FILE);
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
	/**
	 * True when the fold ended on an I/O error (open or mid-read failure)
	 * rather than a genuine end-of-file. Callers MUST NOT treat an aborted
	 * fold as fully scanned: never settle sourceBytes, never mark migration
	 * done, never archive on it.
	 */
	aborted: boolean;
	corruptLines: number;
	ioError: string | null;
	discardingOversizeLine: boolean;
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
 * `maxBytes` is a soft budget for valid-sized records — the region extends to
 * the end of the current line. Once a line exceeds `maxRecordBytes`, however,
 * its bytes are discarded incrementally and the cursor may resume inside that
 * corrupt line using `discardingOversizeLine`.
 */
function foldLegacyRegion(
	filePath: string,
	startByte: number,
	maxBytes: number,
	discardingOversizeLine = false,
): LegacyFoldResult {
	const folded = new Map<string, PrSubscriptionRecord>();
	let corruptLines = 0;
	let consumedTo = startByte;

	let fd: number;
	try {
		fd = fs.openSync(filePath, 'r');
	} catch (err) {
		return {
			folded,
			nextByte: startByte,
			eof: true,
			aborted: true,
			corruptLines,
			ioError: err instanceof Error ? err.message : String(err),
			discardingOversizeLine,
		};
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
		const size = _internals.legacyFstatSync(fd).size;
		if (startByte >= size) {
			return {
				folded,
				nextByte: startByte,
				eof: true,
				aborted: false,
				corruptLines,
				ioError: null,
				discardingOversizeLine: false,
			};
		}
		const chunk = Buffer.alloc(PR_SUBSCRIPTION_LIMITS.readChunkBytes);
		let pending: Buffer[] = [];
		let pendingLen = 0;
		let oversize = discardingOversizeLine;
		let pos = startByte;

		const flushPendingAtEof = (): LegacyFoldResult => {
			if (!oversize && pendingLen > 0) {
				processLineBytes(Buffer.concat(pending));
			}
			// A final unterminated line was processed leniently — the cursor
			// covers every byte read so `sourceBytes` matches a later stat.
			consumedTo = Math.max(consumedTo, pos);
			pending = [];
			pendingLen = 0;
			oversize = false;
			return {
				folded,
				nextByte: consumedTo,
				eof: true,
				aborted: false,
				corruptLines,
				ioError: null,
				discardingOversizeLine: false,
			};
		};

		while (true) {
			const want = Math.min(chunk.length, size - pos);
			if (want <= 0) return flushPendingAtEof();
			const n = _internals.readSync(fd, chunk, 0, want, pos);
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
					if (!oversize) {
						pending.push(Buffer.from(data.subarray(scan)));
						pendingLen += data.length - scan;
					}
					break;
				}
				const lineLen = pendingLen + (nl - scan);
				if (!oversize && lineLen > PR_SUBSCRIPTION_LIMITS.maxRecordBytes) {
					corruptLines += 1;
				} else if (!oversize) {
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
				if (consumedTo - startByte >= maxBytes) {
					return {
						folded,
						nextByte: consumedTo,
						eof: consumedTo >= size,
						aborted: false,
						corruptLines,
						ioError: null,
						discardingOversizeLine: false,
					};
				}
			}
			// Oversize guard: never buffer an unbounded partial line.
			if (!oversize && pendingLen > PR_SUBSCRIPTION_LIMITS.maxRecordBytes) {
				oversize = true;
				corruptLines += 1;
				pending = [];
				pendingLen = 0;
			}
			if (consumedTo - startByte >= maxBytes && pendingLen === 0 && !oversize) {
				const eof = consumedTo >= size;
				return {
					folded,
					nextByte: consumedTo,
					eof,
					aborted: false,
					corruptLines,
					ioError: null,
					discardingOversizeLine: false,
				};
			}
			if (oversize && pos - startByte >= maxBytes) {
				return {
					folded,
					nextByte: pos,
					eof: pos >= size,
					aborted: false,
					corruptLines,
					ioError: null,
					discardingOversizeLine: pos < size,
				};
			}
		}
	} catch (err) {
		log(
			`[pr-monitor] foldLegacyRegion failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return {
			folded: new Map(),
			nextByte: startByte,
			eof: true,
			aborted: true,
			corruptLines: 0,
			ioError: err instanceof Error ? err.message : String(err),
			discardingOversizeLine,
		};
	} finally {
		try {
			_internals.legacyCloseSync(fd);
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
	const filePath = checkpointPath(directory);
	let fd: number;
	let stat: fs.Stats;
	try {
		fd = fs.openSync(filePath, 'r');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return { kind: 'absent' };
		}
		return {
			kind: 'invalid',
			reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
		};
	}
	try {
		stat = fs.fstatSync(fd);
	} catch (err) {
		try {
			fs.closeSync(fd);
		} catch {
			/* best-effort descriptor cleanup */
		}
		return {
			kind: 'invalid',
			reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
		};
	}
	let raw: string;
	try {
		// The size check and bounded read use one open descriptor, eliminating the
		// stat/path-read replacement race. Growth after fstat cannot enlarge this
		// allocation or requested read length.
		if (stat.size > PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes) {
			return {
				kind: 'invalid',
				reason: `checkpoint exceeds hard read ceiling (${stat.size} > ${PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes} bytes)`,
			};
		}
		_internals.afterCheckpointFstat(filePath);
		const buffer = Buffer.alloc(stat.size);
		let bytesRead = 0;
		while (bytesRead < stat.size) {
			const read = _internals.readSync(
				fd,
				buffer,
				bytesRead,
				stat.size - bytesRead,
				bytesRead,
			);
			if (read <= 0) {
				throw new Error(
					`premature checkpoint EOF (${bytesRead}/${stat.size} bytes)`,
				);
			}
			bytesRead += read;
		}
		raw = buffer.subarray(0, bytesRead).toString('utf-8');
	} catch (err) {
		return {
			kind: 'invalid',
			reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`,
		};
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* read result remains valid/invalid; close failure must not escape */
		}
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
	if (checkpoint.migration !== null) {
		const baselineEntries = Object.entries(
			checkpoint.migration.baselineRecords,
		);
		if (baselineEntries.length > PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords) {
			return {
				kind: 'invalid',
				reason: `migration baseline count ${baselineEntries.length} exceeds guard ${PR_SUBSCRIPTION_LIMITS.maxCheckpointRecords}`,
			};
		}
		for (const [key, rec] of baselineEntries) {
			if (
				key !== rec.correlationId ||
				rec.correlationId !==
					buildCorrelationId(rec.sessionID, rec.repoFullName, rec.prNumber)
			) {
				return {
					kind: 'invalid',
					reason: `migration baseline identity mismatch at key "${key}"`,
				};
			}
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
	// Compare REAL UTF-8 bytes (the reader gates on stat.size) — string
	// .length counts UTF-16 code units and under-reports multibyte content.
	const contentBytes = Buffer.byteLength(content, 'utf-8');
	if (contentBytes > PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes) {
		throw new Error(
			`PR subscription store over checkpoint capacity: ${contentBytes} bytes > ${PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes}. The folded state exceeds the bounded checkpoint — archive or split .swarm/pr-monitor/subscriptions.jsonl (subscriptions can be re-created with /swarm pr subscribe), then remove it.`,
		);
	}
	if (contentBytes > PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes) {
		// Pressure signal only — active records are never dropped for bytes.
		log(
			`[pr-monitor] checkpoint pressure: ${contentBytes}/${PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes} bytes`,
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
		// Preserve the previous quarantined copy (bounded to one generation):
		// a second recovery event must not destroy the only copy of the first
		// event's state. The `.prev` slot is overwritten in place.
		try {
			fs.renameSync(to, `${to}.prev`);
		} catch {
			/* no previous slot */
		}
		_internals.renameWithRetry(from, to);
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
	_maintenance: PrSubscriptionMaintenance,
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
}

interface AuditCompactionPlan {
	content: string;
	dropped: number;
}

function storageErrorCode(err: unknown): string {
	if (typeof err === 'object' && err !== null && 'code' in err) {
		const code = (err as { code?: unknown }).code;
		if (typeof code === 'string' && code.length > 0) return code;
	}
	return 'unknown';
}

function planAuditCompaction(directory: string): AuditCompactionPlan | null {
	let size: number;
	try {
		size = fs.statSync(auditPath(directory)).size;
	} catch {
		return null;
	}
	if (size <= PR_SUBSCRIPTION_LIMITS.auditMaxBytesLow) return null;
	let content: string;
	let omittedPrefix = false;
	try {
		const filePath = auditPath(directory);
		const maxRead = PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh;
		const start = Math.max(0, size - maxRead);
		const length = Math.min(size, maxRead);
		const buffer = Buffer.alloc(length);
		const fd = fs.openSync(filePath, 'r');
		try {
			let bytesRead = 0;
			while (bytesRead < length) {
				const read = _internals.readSync(
					fd,
					buffer,
					bytesRead,
					length - bytesRead,
					start + bytesRead,
				);
				if (read <= 0) return null;
				bytesRead += read;
			}
			content = buffer.toString('utf-8');
		} finally {
			fs.closeSync(fd);
		}
		if (start > 0) {
			omittedPrefix = true;
			const firstNewline = content.indexOf('\n');
			content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
		}
	} catch {
		return null;
	}
	const all = content.split('\n').filter((line) => line.trim().length > 0);
	if (
		all.length <= PR_SUBSCRIPTION_LIMITS.auditMaxLinesHigh &&
		size <= PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh
	) {
		return null;
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
	// The exact line count of an omitted external prefix is intentionally not
	// scanned. Record a conservative lower bound while keeping I/O capped.
	const dropped = all.length - kept.length + (omittedPrefix ? 1 : 0);
	return {
		content: kept.length > 0 ? `${kept.join('\n')}\n` : '',
		dropped,
	};
}

function applyAuditCompaction(
	directory: string,
	plan: AuditCompactionPlan | null,
): boolean {
	if (!plan) return false;
	try {
		_internals.auditCompactionWrite(auditPath(directory), plan.content);
		return true;
	} catch (err) {
		log(
			`[pr-monitor] audit compaction failed (non-fatal): ${storageErrorCode(err)}`,
		);
		return false;
	}
}

function prepareAuditCompaction(directory: string): AuditCompactionPlan | null {
	const plan = planAuditCompaction(directory);
	return plan;
}

function persistCheckpointWithAuditCompaction(
	directory: string,
	checkpoint: PrSubscriptionCheckpoint,
	plan: AuditCompactionPlan | null,
): void {
	// Persist durable state before touching the diagnostic audit file. This keeps
	// a checkpoint-write failure from publishing an audit transition for a state
	// the caller never observed. A successful audit rewrite is accounted for by a
	// second checkpoint write. That accounting is diagnostic-only: once the
	// primary write has committed the requested mutation, a failed accounting
	// write must not make the caller observe a false mutation failure.
	_internals.writeCheckpointFile(directory, checkpoint);
	if (!applyAuditCompaction(directory, plan) || !plan) return;
	const previousDropped = checkpoint.maintenance.droppedAuditTransitions;
	checkpoint.maintenance.droppedAuditTransitions += plan.dropped;
	try {
		_internals.writeCheckpointFile(directory, checkpoint);
	} catch (err) {
		// Keep the live view aligned with the durable primary checkpoint. The
		// compacted audit stays valid, while its dropped-count metric conservatively
		// under-reports until a later successful compaction accounting write.
		checkpoint.maintenance.droppedAuditTransitions = previousDropped;
		log(
			`[pr-monitor] audit compaction accounting failed (non-fatal): ${storageErrorCode(err)}`,
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
	let stat: fs.Stats;
	try {
		stat = _internals.archiveStatSync(legacy);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			// Crash-after-rename repair: already gone → mark archived.
			migration.archived = true;
		} else {
			log(
				`[pr-monitor] legacy archive inspection deferred: ${storageErrorCode(err)}`,
			);
		}
		return null;
	}
	if (
		stat.size !== migration.sourceBytes ||
		stat.mtimeMs !== migration.sourceMtimeMs
	)
		return null; // unstable — wait
	_internals.beforeArchiveLegacy(directory);
	try {
		stat = _internals.archiveStatSync(legacy);
	} catch {
		return null;
	}
	if (
		stat.size !== migration.sourceBytes ||
		stat.mtimeMs !== migration.sourceMtimeMs
	)
		return null;
	const archive = legacyArchivePath(directory);
	const next = legacyArchiveNextPath(directory);
	const previous = legacyArchivePreviousPath(directory);
	try {
		_internals.beforeArchiveRename(directory);
		try {
			fs.unlinkSync(next);
		} catch {
			/* no abandoned candidate */
		}
		_internals.renameWithRetry(legacy, next);
		const archivedStat = _internals.archiveStatSync(next);
		if (
			archivedStat.size !== migration.sourceBytes ||
			archivedStat.mtimeMs !== migration.sourceMtimeMs
		) {
			// A legacy writer changed the source after preflight. Restore it so
			// the next operation re-folds those bytes instead of stranding them.
			_internals.renameWithRetry(next, legacy);
			return null;
		}
		// Retention begins when the verified archive candidate is created, not
		// when the legacy source was last written. Rename preserves source mtime,
		// which could otherwise make an old source expire immediately.
		const archivedAt = new Date();
		fs.utimesSync(next, archivedAt, archivedAt);
		let movedPrevious = false;
		try {
			fs.unlinkSync(previous);
		} catch {
			/* no stale backup */
		}
		try {
			_internals.renameWithRetry(archive, previous);
			movedPrevious = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		try {
			_internals.renameWithRetry(next, archive);
		} catch (err) {
			if (movedPrevious) _internals.renameWithRetry(previous, archive);
			_internals.renameWithRetry(next, legacy);
			throw err;
		}
		if (movedPrevious) {
			try {
				fs.unlinkSync(previous);
			} catch {
				/* bounded stale backup is safer than deleting the rollback copy */
			}
		}
	} catch (err) {
		// If any step after source -> candidate fails before replacement is
		// committed, put the candidate back at the authoritative legacy path.
		// This includes stat failures and failures while staging the old archive.
		try {
			if (fs.existsSync(next) && !fs.existsSync(legacy)) {
				_internals.renameWithRetry(next, legacy);
			}
		} catch {
			/* keep the bounded candidate for a later recovery attempt */
		}
		log(`[pr-monitor] legacy archive deferred: ${storageErrorCode(err)}`);
		return null;
	}
	// renameSync preserves the source mtime — an idle legacy log would have
	// its archive instantly past the TTL cleanup. Stamp the archive fresh so
	// it survives the full legacyArchiveTtlMs from the moment it was created.
	try {
		const now = Date.now() / 1000;
		fs.utimesSync(legacyArchivePath(directory), now, now);
	} catch {
		/* best-effort — worst case the archive is TTL-cleaned sooner */
	}
	migration.archived = true;
	return { kind: 'archive' };
}

/**
 * Repair bounded archive-replacement staging after an interrupted mutation.
 * The canonical archive is never displaced in favour of an unverified
 * candidate. When both generations survive, the candidate returns to the
 * legacy path for an ordinary re-fold and the prior archive stays canonical.
 */
function reconcileLegacyArchiveStaging(
	directory: string,
	migration: PrSubscriptionMigrationState,
): void {
	const legacy = storePath(directory);
	const archive = legacyArchivePath(directory);
	const next = legacyArchiveNextPath(directory);
	const previous = legacyArchivePreviousPath(directory);
	let legacyExists = fileExistsStrict(legacy);
	let archiveExists = fileExistsStrict(archive);
	let nextExists = fileExistsStrict(next);
	let previousExists = fileExistsStrict(previous);
	if (!nextExists && !previousExists) return;

	if (legacyExists) {
		// The authoritative source already exists. Staging files are bounded
		// crash residue; retain a previous archive only when no canonical one is
		// available for restoration.
		if (!archiveExists && previousExists) {
			_internals.renameWithRetry(previous, archive);
			archiveExists = true;
			previousExists = false;
		}
		if (!archiveExists && nextExists) {
			const candidate = fs.statSync(next);
			if (
				migration.done &&
				candidate.size === migration.sourceBytes &&
				candidate.mtimeMs === migration.sourceMtimeMs
			) {
				_internals.renameWithRetry(next, archive);
				archiveExists = true;
				nextExists = false;
			}
		}
		if (archiveExists && previousExists) fs.unlinkSync(previous);
		if (nextExists) fs.unlinkSync(next);
		return;
	}

	if (archiveExists) {
		// A prior canonical rollback copy exists, so an interrupted candidate
		// must be re-folded rather than replacing it implicitly.
		if (nextExists) {
			_internals.renameWithRetry(next, legacy);
			migration.archived = false;
			legacyExists = true;
			nextExists = false;
		}
		if (previousExists) fs.unlinkSync(previous);
		return;
	}

	if (previousExists) {
		// Crash after archive -> previous: restore the known-good canonical copy
		// before making the candidate visible again.
		_internals.renameWithRetry(previous, archive);
		archiveExists = true;
		previousExists = false;
		if (nextExists) {
			_internals.renameWithRetry(next, legacy);
			migration.archived = false;
			legacyExists = true;
			nextExists = false;
		}
		return;
	}

	if (nextExists) {
		const candidate = fs.statSync(next);
		if (
			migration.done &&
			candidate.size === migration.sourceBytes &&
			candidate.mtimeMs === migration.sourceMtimeMs
		) {
			// No older rollback generation exists and the candidate is exactly the
			// completed source. Finish the interrupted first-time archive.
			_internals.renameWithRetry(next, archive);
		} else {
			_internals.renameWithRetry(next, legacy);
			migration.archived = false;
		}
	}
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
	directory: string,
	trigger:
		| 'compact'
		| 'migrate-complete'
		| 'archive'
		| 'foreign-rebind'
		| 'corrupt-quarantine',
	checkpoint: PrSubscriptionCheckpoint,
): void {
	const records = Object.values(checkpoint.records);
	const healthPayload = {
		trigger,
		active_count: records.filter((r) => r.status === 'active').length,
		terminal_count: records.filter((r) => r.status !== 'active').length,
		compactions: checkpoint.maintenance.compactions,
		corrupt_count: checkpoint.maintenance.corruptLegacyRecords,
		dropped_audit_count: checkpoint.maintenance.droppedAuditTransitions,
		checkpoint_bytes: Buffer.byteLength(
			`${JSON.stringify(checkpoint)}\n`,
			'utf-8',
		),
		limit_bytes: PR_SUBSCRIPTION_LIMITS.maxCheckpointBytes,
		recovery_resets: checkpoint.maintenance.resets,
	};
	telemetry.prSubscriptionHealth(healthPayload);
	// #2044: direct learning-health feed from the FIRST store event.
	observeStoreHealth({
		directory,
		kind: 'pr_subscription_health',
		payload: healthPayload,
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
	/** True when a fold ran but ended on an I/O error — never settle/archive on it. */
	aborted: boolean;
} {
	let view: Record<string, PrSubscriptionRecord> = { ...checkpoint.records };
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
			aborted: false,
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
			aborted: false,
		};
	}
	const migration = checkpoint.migration;
	if (migration === null || !migration.done) {
		const baselineRecords = migration?.baselineRecords ?? {
			...checkpoint.records,
		};
		const sameGeneration =
			migration !== null &&
			stat.size === migration.sourceBytes &&
			stat.mtimeMs === migration.sourceMtimeMs;
		const cursor = sameGeneration ? migration.scannedBytes : 0;
		const discardingOversizeLine = sameGeneration
			? migration.discardingOversizeLine
			: false;
		if (!sameGeneration && migration !== null) {
			view = { ...baselineRecords };
		}
		const fold = foldLegacyRegion(
			legacy,
			cursor,
			Number.MAX_SAFE_INTEGER,
			discardingOversizeLine,
		);
		if (fold.ioError)
			return {
				view,
				usedLegacy: false,
				absorbed: 0,
				corruptLines: 0,
				overLimit: false,
				aborted: true,
			};
		const absorbed = mergeFoldedRecords(view, fold.folded);
		return {
			view,
			usedLegacy: true,
			absorbed,
			corruptLines: fold.corruptLines,
			overLimit: false,
			aborted: fold.aborted,
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
			aborted: false,
		};
	}
	// Changed (downgrade writer / recreated file) — full bounded-memory re-fold.
	const fold = foldLegacyRegion(legacy, 0, Number.MAX_SAFE_INTEGER);
	if (fold.ioError)
		return {
			view,
			usedLegacy: false,
			absorbed: 0,
			corruptLines: 0,
			overLimit: false,
			aborted: true,
		};
	const absorbed = mergeFoldedRecords(view, fold.folded);
	return {
		view,
		usedLegacy: true,
		absorbed,
		corruptLines: fold.corruptLines,
		overLimit: false,
		aborted: fold.aborted,
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
		// Corrupt checkpoint: reads stay pure (no quarantine here — the first
		// write heals by quarantining + rebinding); recover from the legacy
		// log within the finite fold budget. A read-only install re-folds on
		// every read until then — bounded (≤64 MiB) and self-healing on any
		// write op.
		const legacy = storePath(directory);
		const view: Record<string, PrSubscriptionRecord> = {};
		const size = fileSizeOrNull(legacy);
		if (size !== null && size <= PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes) {
			const fold = foldLegacyRegion(legacy, 0, Number.MAX_SAFE_INTEGER);
			if (!fold.ioError) mergeFoldedRecords(view, fold.folded);
		} else if (size !== null) {
			warnLegacyOverLimit(directory, size);
		}
		return { view, recoverySource: 'corrupt-recovered' };
	}
	// No checkpoint.
	const legacyPath = storePath(directory);
	let legacyStat: fs.Stats;
	try {
		legacyStat = fs.statSync(legacyPath);
	} catch {
		return { view: {}, recoverySource: 'empty' };
	}
	const legacySize = legacyStat.size;
	if (legacySize > PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes) {
		warnLegacyOverLimit(directory, legacySize);
		return { view: {}, recoverySource: 'legacy-log' };
	}
	const fold = foldLegacyRegion(legacyPath, 0, Number.MAX_SAFE_INTEGER);
	const view: Record<string, PrSubscriptionRecord> = {};
	if (fold.ioError) return { view, recoverySource: 'legacy-log' };
	mergeFoldedRecords(view, fold.folded);
	// One-time read-bootstrap (best-effort, bounded lock timeout). An ABORTED
	// fold (I/O failure) must not bootstrap a checkpoint that claims a
	// complete scan — the next read retries the fold instead.
	if (!fold.aborted) {
		_internals.beforeBootstrapLock(directory);
		await bootstrapCheckpointFromLegacy(directory);
	}
	return { view, recoverySource: 'legacy-log' };
}

/**
 * Persist-if-absent checkpoint bootstrap from a legacy fold. The fold was
 * computed outside the lock; a writer that creates a checkpoint first wins
 * and the bootstrap skips (issue #2042 Required 3). Attempted AT MOST ONCE
 * per directory per process: under persistent lock contention each read
 * would otherwise pay the same bounded lock wait again.
 */
const bootstrapAttempted = new Map<string, boolean>();
async function bootstrapCheckpointFromLegacy(directory: string): Promise<void> {
	if (bootstrapAttempted.has(directory)) return;
	if (bootstrapAttempted.size >= 32) {
		bootstrapAttempted.delete(bootstrapAttempted.keys().next().value!);
	}
	bootstrapAttempted.set(directory, true);
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
				let beforeFold: fs.Stats;
				try {
					beforeFold = fs.statSync(storePath(directory));
				} catch {
					return;
				}
				// Read-bootstrap is one-time convergence work. The source was already
				// admitted against the finite 64 MiB ceiling, and foldLegacyRegion keeps
				// memory bounded to a 64 KiB chunk plus the capped live set. Do not apply
				// the 8 MiB mutation budget here: admitted 8–64 MiB stores must still
				// converge to a checkpoint after a read-only install.
				const lockedFold = foldLegacyRegion(
					storePath(directory),
					0,
					PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes,
				);
				if (lockedFold.ioError) return;
				let afterFold: fs.Stats;
				try {
					afterFold = fs.statSync(storePath(directory));
				} catch {
					return;
				}
				if (
					afterFold.size !== beforeFold.size ||
					afterFold.mtimeMs !== beforeFold.mtimeMs
				)
					return;
				const foldedView: Record<string, PrSubscriptionRecord> = {};
				mergeFoldedRecords(foldedView, lockedFold.folded);
				const checkpoint = freshCheckpoint(directory);
				checkpoint.records = { ...foldedView };
				const terminals = Object.values(foldedView).filter(
					(rec) => rec.status !== 'active',
				);
				checkpoint.terminalSummary.lastTerminalAt = terminals.length
					? Math.max(...terminals.map((rec) => rec.updatedAt))
					: null;
				checkpoint.maintenance.corruptLegacyRecords = lockedFold.corruptLines;
				checkpoint.migration = {
					scannedBytes: lockedFold.nextByte,
					sourceBytes: beforeFold.size,
					sourceMtimeMs: beforeFold.mtimeMs,
					corruptLines: lockedFold.corruptLines,
					discardingOversizeLine: false,
					baselineRecords: {},
					baselineTerminalSummary: {
						removed: 0,
						expired: 0,
						lastTerminalAt: null,
					},
					done: true,
					archived: false,
					startedAt: Date.now(),
				};
				checkpoint.sequence = 1;
				checkpoint.updatedAt = Date.now();
				const auditCompaction = prepareAuditCompaction(directory);
				persistCheckpointWithAuditCompaction(
					directory,
					checkpoint,
					auditCompaction,
				);
				const archiveEvent = maybeArchiveLegacy(directory, checkpoint);
				if (archiveEvent) {
					checkpoint.sequence += 1;
					checkpoint.updatedAt = Date.now();
					_internals.writeCheckpointFile(directory, checkpoint);
				}
				flushAuditEvents(
					directory,
					[
						{ kind: 'migrate-complete' },
						...(archiveEvent ? [archiveEvent] : []),
					],
					checkpoint.sequence,
					checkpoint.maintenance,
				);
				emitHealthTelemetry(directory, 'migrate-complete', checkpoint);
				if (archiveEvent) emitHealthTelemetry(directory, 'archive', checkpoint);
			},
			PR_SUBSCRIPTION_LIMITS.bootstrapLockTimeoutMs,
		);
	} catch (err) {
		// Best-effort only — the read result was already computed.
		log(`[pr-monitor] read-bootstrap skipped: ${storageErrorCode(err)}`);
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
	let reboundForeign = false;

	let checkpoint: PrSubscriptionCheckpoint;
	const read = readCheckpoint(directory);
	if (read.kind === 'ok' && sameProjectRoot(read.value.rootPath, directory)) {
		checkpoint = cloneCheckpoint(read.value);
	} else if (read.kind === 'ok') {
		const displaced = Object.keys(read.value.records).length;
		// Quarantine a co-copied legacy source first. If the later checkpoint
		// quarantine fails, the still-present foreign checkpoint keeps reads and
		// subsequent writes fail-closed; the wrong legacy state cannot be adopted.
		const legacy = storePath(directory);
		let foreignLegacyExists = false;
		try {
			_internals.statSync(legacy);
			foreignLegacyExists = true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw new Error(
					`PR subscription foreign legacy log could not be inspected; refusing to rebind (${storageErrorCode(err)})`,
				);
			}
		}
		if (foreignLegacyExists) {
			const foreignLegacy = foreignLegacySlotPath(directory);
			try {
				try {
					fs.unlinkSync(foreignLegacy);
				} catch {
					/* no previous slot */
				}
				_internals.renameWithRetry(legacy, foreignLegacy);
			} catch (err) {
				throw new Error(
					`PR subscription foreign legacy log could not be quarantined; refusing to rebind (${storageErrorCode(err)})`,
				);
			}
		}
		if (!quarantineCheckpoint(directory, 'foreign')) {
			throw new Error(
				'PR subscription foreign checkpoint could not be quarantined; refusing to rebind',
			);
		}
		checkpoint = freshCheckpoint(directory);
		// Lifetime reset accounting: carry the displaced checkpoint's own
		// reset history forward so the counter is monotone across generations.
		checkpoint.maintenance.resets += read.value.maintenance.resets + 1;
		audit.push({ kind: 'foreign-rebind' });
		dirty = true;
		log(
			`[pr-monitor] foreign checkpoint quarantined (${displaced} displaced records, recorded root ${read.value.rootPath}); store rebound to ${directory}`,
		);
		reboundForeign = true;
	} else if (read.kind === 'invalid') {
		quarantineCheckpoint(directory, 'corrupt');
		checkpoint = freshCheckpoint(directory);
		checkpoint.maintenance.resets += 1;
		audit.push({ kind: 'corrupt-quarantine' });
		dirty = true;
		log(
			`[pr-monitor] corrupt checkpoint quarantined; store rebound to ${directory}`,
		);
	} else {
		checkpoint = freshCheckpoint(directory);
	}

	if (!reboundForeign && checkpoint.migration !== null) {
		try {
			reconcileLegacyArchiveStaging(directory, checkpoint.migration);
		} catch (err) {
			throw new Error(
				`PR subscription legacy archive staging could not be reconciled; refusing mutation (${storageErrorCode(err)})`,
			);
		}
	}

	const legacy = storePath(directory);
	let legacyStat: fs.Stats | null = null;
	try {
		legacyStat = _internals.statSync(legacy);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new Error(
				`PR subscription legacy store could not be inspected; refusing mutation (${storageErrorCode(err)})`,
			);
		}
	}
	let view: Record<string, PrSubscriptionRecord>;

	if (reboundForeign) legacyStat = null;

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
		// silently). Refuse before a checkpoint can shadow active legacy state.
		warnLegacyOverLimit(directory, legacyStat.size);
		throw new Error(
			`PR subscription legacy store exceeds the ${PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes}-byte migration ceiling; refusing mutation until the file is archived or split`,
		);
	}

	const legacySize = legacyStat.size;
	const legacyMtime = legacyStat.mtimeMs;
	const migration = checkpoint.migration;
	if (migration === null || !migration.done) {
		// Incremental migration with per-chunk progress persists.
		const baselineRecords = migration?.baselineRecords ?? {
			...checkpoint.records,
		};
		const baselineTerminalSummary = migration?.baselineTerminalSummary ?? {
			...checkpoint.terminalSummary,
		};
		const sameGeneration =
			migration !== null &&
			legacySize === migration.sourceBytes &&
			legacyMtime === migration.sourceMtimeMs;
		let cursor = sameGeneration ? migration.scannedBytes : 0;
		const startedAt = sameGeneration ? migration.startedAt : Date.now();
		let corruptTotal = sameGeneration ? migration.corruptLines : 0;
		let discardingOversizeLine = sameGeneration
			? migration.discardingOversizeLine
			: false;
		if (!sameGeneration && migration !== null) {
			checkpoint.records = { ...baselineRecords };
			checkpoint.terminalSummary = { ...baselineTerminalSummary };
			checkpoint.maintenance.corruptLegacyRecords = Math.max(
				0,
				checkpoint.maintenance.corruptLegacyRecords - migration.corruptLines,
			);
		}
		view = { ...checkpoint.records };
		let capacityRefused = false;
		let foldedThisOperation = 0;
		while (true) {
			const chunkStart = cursor;
			const remainingOperationBytes = Math.max(
				1,
				PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation -
					foldedThisOperation,
			);
			const fold = foldLegacyRegion(
				legacy,
				cursor,
				Math.min(
					PR_SUBSCRIPTION_LIMITS.migrationChunkBytes,
					remainingOperationBytes,
				),
				discardingOversizeLine,
			);
			if (fold.ioError) {
				throw new Error(
					'PR subscription legacy migration read failed (I/O error)',
				);
			}
			mergeFoldedRecords(view, fold.folded);
			checkpoint.maintenance.corruptLegacyRecords += fold.corruptLines;
			corruptTotal += fold.corruptLines;
			discardingOversizeLine = fold.discardingOversizeLine;
			cursor = fold.nextByte;
			foldedThisOperation += Math.max(0, cursor - chunkStart);

			if (fold.aborted) {
				// I/O failure mid-scan (EBUSY/EPERM-class — the same hazard
				// renameWithRetry retries for). Persist the REAL consumed
				// cursor as not-done progress so the next op retries the
				// fold; NEVER mark done, NEVER settle sourceBytes, NEVER
				// archive — an unread tail must not be renamed away.
				const progress = cloneCheckpoint(checkpoint);
				progress.records = { ...view };
				progress.migration = {
					scannedBytes: cursor,
					sourceBytes: legacySize,
					sourceMtimeMs: legacyMtime,
					corruptLines: corruptTotal,
					discardingOversizeLine,
					baselineRecords: { ...baselineRecords },
					baselineTerminalSummary: { ...baselineTerminalSummary },
					done: false,
					archived: false,
					startedAt,
				};
				progress.updatedAt = Date.now();
				progress.sequence += 1;
				writeCheckpointFile(directory, progress);
				checkpoint.sequence = progress.sequence;
				log(
					`[pr-monitor] legacy scan aborted by an I/O error after ${cursor} bytes — migration stays incomplete and will retry`,
				);
				dirty = true;
				return { checkpoint, view, audit, dirty };
			}

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
					discardingOversizeLine,
					baselineRecords: { ...baselineRecords },
					baselineTerminalSummary: { ...baselineTerminalSummary },
					done: false,
					archived: false,
					startedAt,
				};
				progress.updatedAt = Date.now();
				progress.sequence += 1;
				writeCheckpointFile(directory, progress);
				checkpoint.sequence = progress.sequence;
				dirty = true;
				if (
					foldedThisOperation >=
					PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation
				) {
					throw new Error(
						`PR subscription legacy migration is in progress (${cursor}/${legacySize} bytes); retry the operation to continue`,
					);
				}
				continue;
			}
			checkpoint.migration = {
				scannedBytes: cursor,
				sourceBytes: legacySize,
				sourceMtimeMs: legacyMtime,
				corruptLines: corruptTotal,
				discardingOversizeLine: false,
				baselineRecords: {},
				baselineTerminalSummary: {
					removed: 0,
					expired: 0,
					lastTerminalAt: null,
				},
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
	if (overlaid.usedLegacy && !overlaid.aborted) {
		// A changed source was folded completely. Settle the size+mtime
		// fingerprint even when no record won the merge — otherwise a source
		// of losing/older records (or pure garbage) would be re-folded on
		// EVERY read forever. Re-enter the archive path so the now-stable
		// source gets archived. An ABORTED fold never settles: the unchanged
		// fingerprint forces a full retry on the next op and keeps the
		// archive blocked.
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
// Write finalization (order: compaction → checkpoint → audit → archive)
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

	if (!loaded.dirty && events.length === 0) {
		const archiveEvent = maybeArchiveLegacy(directory, checkpoint);
		if (!archiveEvent) return;
		checkpoint.updatedAt = Date.now();
		checkpoint.sequence += 1;
		const auditCompaction = prepareAuditCompaction(directory);
		persistCheckpointWithAuditCompaction(
			directory,
			checkpoint,
			auditCompaction,
		);
		flushAuditEvents(
			directory,
			[archiveEvent],
			checkpoint.sequence,
			checkpoint.maintenance,
		);
		cleanupStaleLegacyArchive(directory);
		emitHealthTelemetry(directory, 'archive', checkpoint);
		return;
	}

	checkpoint.records = loaded.view;
	checkpoint.updatedAt = Date.now();
	checkpoint.rootPath = path.resolve(directory);
	checkpoint.sequence += 1;
	// Audit compaction is diagnostic-only. The helper preserves checkpoint-first
	// ordering while accounting dropped transitions only after a successful
	// atomic rewrite; a failed rewrite must not publish a false loss counter.
	const auditCompaction = prepareAuditCompaction(directory);
	persistCheckpointWithAuditCompaction(directory, checkpoint, auditCompaction);
	flushAuditEvents(
		directory,
		events,
		checkpoint.sequence,
		checkpoint.maintenance,
	);

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
		_internals.writeCheckpointFile(directory, checkpoint);
		flushAuditEvents(
			directory,
			[archiveEvent],
			checkpoint.sequence,
			checkpoint.maintenance,
		);
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
			emitHealthTelemetry(directory, kind, checkpoint);
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
			validateRecord(updated);
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
				if (!fold.ioError) mergeFoldedRecords(view, fold.folded);
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
				if (!fold.ioError) mergeFoldedRecords(view, fold.folded);
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
			`[pr-monitor] getPrSubscriptionHealth failed: ${storageErrorCode(err)}`,
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
	afterCheckpointFstat: (_filePath: string): void => {},
	archiveStatSync: fs.statSync,
	auditCompactionWrite: atomicWriteSwarmFileSync,
	beforeBootstrapLock: (_directory: string): void => {},
	beforeArchiveLegacy: (_directory: string): void => {},
	beforeArchiveRename: (_directory: string): void => {},
	foldLegacyRegion,
	legacyCloseSync: fs.closeSync,
	legacyFstatSync: fs.fstatSync,
	mergeFoldedRecords,
	readSync: fs.readSync,
	renameWithRetry,
	sameProjectRoot,
	statSync: fs.statSync,
	writeCheckpointFile,
};

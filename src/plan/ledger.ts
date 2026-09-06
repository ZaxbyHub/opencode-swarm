/**
 * Append-only Plan Ledger
 *
 * Provides durable, immutable audit trail of plan evolution events.
 * Each event is written as a JSON line to .swarm/plan-ledger.jsonl
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import {
	ExecutionProfileSchema,
	type Plan,
	PlanSchema,
	TaskStatusSchema,
} from '../config/plan-schema';
import { withEvidenceLock } from '../evidence/lock.js';
import { emit } from '../telemetry.js';
import { criticalWarn, log } from '../utils/logger';
import { assertProjectRoot } from '../utils/project-boundary';
import {
	appendSqliteLedger,
	clearSqliteLedger,
	cutoverSqliteLedger,
	getPlanLedgerState,
	hasSqliteLedger,
	importSqliteLedger,
	readSqliteLedgerEvents,
	readSqliteLedgerEventsReadOnly,
	recordSqliteLedgerParity,
	replaceSqliteLedger,
	SqliteLedgerStaleWriterError,
} from './ledger-sqlite';
import { normalizeExecutionProfileForHash } from './planning-profile';
import { derivePlanId, derivePlanIdentityHash } from './utils';

/**
 * Ledger schema version.
 *
 * v7.19.0: bumped from 1.0.0 → 1.1.0 with the addition of `task_removed`.
 * Older plugin readers throw on unknown event types (applyEventToPlan default
 * branch); restart any running OpenCode session after upgrade so the new
 * reader is loaded in-process.
 */
export const LEDGER_SCHEMA_VERSION = '1.1.0';

/**
 * Valid ledger event types
 */
export const LEDGER_EVENT_TYPES = [
	'plan_created',
	'task_added',
	'task_removed',
	'task_updated',
	'task_status_changed',
	'task_reordered',
	'phase_completed',
	'plan_rebuilt',
	'plan_exported',
	'plan_reset',
	'snapshot',
	'execution_profile_set',
	'execution_profile_locked',
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

/**
 * A ledger event representing a plan mutation.
 * All fields are required unless marked optional.
 */
export interface LedgerEvent {
	/** Monotonically increasing sequence number (starts at 1) */
	seq: number;
	/** ISO 8601 timestamp when event was recorded */
	timestamp: string;
	/** Unique identifier for the plan */
	plan_id: string;
	/** Type of event that occurred */
	event_type: LedgerEventType;
	/** Task ID when event relates to a specific task */
	task_id?: string;
	/** Phase ID when event relates to a specific phase */
	phase_id?: number;
	/** Previous status (for status change events) */
	from_status?: string;
	/** New status (for status change events) */
	to_status?: string;
	/** What triggered this event */
	source: string;
	/** SHA-256 hash of plan state before this event */
	plan_hash_before: string;
	/** SHA-256 hash of plan state after this event */
	plan_hash_after: string;
	/** Schema version for this ledger entry */
	schema_version: string;
	/** Optional payload for events that carry additional data */
	payload?: Record<string, unknown>;
}

/**
 * Input type for appendLedgerEvent (excludes auto-generated fields)
 */
export type LedgerEventInput = Omit<
	LedgerEvent,
	| 'seq'
	| 'timestamp'
	| 'plan_hash_before'
	| 'plan_hash_after'
	| 'schema_version'
>;

/**
 * Payload for snapshot ledger events.
 * Embeds the full Plan payload for ledger-only rebuild.
 */
export interface SnapshotEventPayload {
	plan: Plan;
	payload_hash: string;
	plan_epoch?: string;
	root_event_hash?: string;
}

interface PlanEpochAdoptionPayload extends SnapshotEventPayload {
	plan_epoch: string;
	root_event_hash: string;
}

export interface PlanEpochIdentity {
	planId: string;
	planIdentityHash: string;
	planEpoch: string;
	rootEventHash: string;
	payloadHash: string;
	source: 'root' | 'plan_epoch_adopted';
}

function resolvePlanEpochIdentity(
	events: LedgerEvent[],
	authoritativePlan: Plan,
): PlanEpochIdentity | null {
	const planId = derivePlanId(authoritativePlan);
	const planIdentityHash = derivePlanIdentityHash(authoritativePlan);
	const payloadHash = computePlanLedgerHash(authoritativePlan);
	const candidates = extractPlanEpochCandidates(events, planId);
	const distinctCandidateKeys = new Set(
		candidates.map(
			(candidate) => `${candidate.planEpoch}:${candidate.rootEventHash}`,
		),
	);
	if (distinctCandidateKeys.size > 1) {
		throw new Error(
			`Conflicting plan epoch metadata detected for ${planId}; refusing to continue.`,
		);
	}
	if (candidates.length === 0) {
		return null;
	}
	const existing = candidates[0]!;
	return {
		planId,
		planIdentityHash,
		planEpoch: existing.planEpoch,
		rootEventHash: existing.rootEventHash,
		payloadHash,
		source: existing.source,
	};
}

/**
 * Ledger file name
 */
const LEDGER_FILENAME = 'plan-ledger.jsonl';

/**
 * Relative path used as the project-scoped lock key for ledger append writes.
 * Must match the real runtime ledger path so every append caller coordinates
 * on the same proper-lockfile sentinel.
 */
const LEDGER_LOCK_PATH = path.join('.swarm', LEDGER_FILENAME);

/**
 * Plan JSON file name
 */
const PLAN_JSON_FILENAME = 'plan.json';

/**
 * Error thrown when a writer attempts to append to the ledger with stale state.
 * Indicates another writer has modified the ledger since the caller last read it.
 */
export class LedgerStaleWriterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LedgerStaleWriterError';
	}
}

/**
 * Get the path to the ledger file
 */
function getLedgerPath(directory: string): string {
	return path.join(directory, '.swarm', LEDGER_FILENAME);
}

/**
 * Get the path to plan.json
 */
function getPlanJsonPath(directory: string): string {
	return path.join(directory, '.swarm', PLAN_JSON_FILENAME);
}

/** Compare names by locale-independent UTF-16 code-unit order. */
function compareCodeUnits(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function readLedgerDirectory(directory: string): string[] {
	return fs.readdirSync(directory);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function isSha256Hex(value: string): boolean {
	return /^[a-f0-9]{64}$/i.test(value);
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function serializeLedgerEvent(event: LedgerEvent): string {
	return JSON.stringify(event);
}

function computeLedgerEventHash(event: LedgerEvent): string {
	return crypto
		.createHash('sha256')
		.update(serializeLedgerEvent(event), 'utf8')
		.digest('hex');
}

function extractPlanEpochCandidates(
	events: LedgerEvent[],
	expectedPlanId: string,
): Array<{
	planEpoch: string;
	rootEventHash: string;
	source: 'root' | 'plan_epoch_adopted';
}> {
	if (events.length === 0) {
		throw new Error('Plan ledger is empty; missing plan_created root.');
	}

	const rootEvent = events[0]!;
	if (rootEvent.event_type !== 'plan_created') {
		throw new Error(
			`Plan ledger root must be plan_created; found ${rootEvent.event_type} at seq ${rootEvent.seq}.`,
		);
	}
	if (rootEvent.plan_id !== expectedPlanId) {
		throw new Error(
			`Plan ledger identity mismatch: expected ${expectedPlanId} but found ${rootEvent.plan_id}.`,
		);
	}

	const rootEventHash = computeLedgerEventHash(rootEvent);
	const candidates: Array<{
		planEpoch: string;
		rootEventHash: string;
		source: 'root' | 'plan_epoch_adopted';
	}> = [];
	const rootPayload = asRecord(rootEvent.payload);
	const rootPlanEpoch = rootPayload?.plan_epoch;
	if (typeof rootPlanEpoch === 'string' && rootPlanEpoch.length > 0) {
		if (!isUuid(rootPlanEpoch)) {
			throw new Error('Plan ledger root carries an invalid plan_epoch.');
		}
		candidates.push({
			planEpoch: rootPlanEpoch,
			rootEventHash,
			source: 'root',
		});
	}

	for (const event of events) {
		if (
			event.event_type !== 'snapshot' ||
			event.source !== 'plan_epoch_adopted'
		) {
			continue;
		}
		if (event.plan_id !== expectedPlanId) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} belongs to ${event.plan_id}, expected ${expectedPlanId}.`,
			);
		}
		const payload = asRecord(event.payload);
		const planEpoch = payload?.plan_epoch;
		const rootHash = payload?.root_event_hash;
		const embeddedPlan = PlanSchema.safeParse(payload?.plan);
		if (!embeddedPlan.success) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} carries an invalid embedded plan.`,
			);
		}
		const payloadHash = payload?.payload_hash;
		if (typeof planEpoch !== 'string' || !isUuid(planEpoch)) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} has an invalid plan_epoch.`,
			);
		}
		if (typeof rootHash !== 'string' || !isSha256Hex(rootHash)) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} has an invalid root_event_hash.`,
			);
		}
		if (rootHash !== rootEventHash) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} does not match the canonical ledger root.`,
			);
		}
		if (typeof payloadHash !== 'string') {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} is missing payload_hash.`,
			);
		}
		if (derivePlanId(embeddedPlan.data) !== expectedPlanId) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} embeds a different plan identity.`,
			);
		}
		if (computePlanLedgerHash(embeddedPlan.data) !== payloadHash) {
			throw new Error(
				`Plan epoch adoption snapshot at seq ${event.seq} has a mismatched payload_hash.`,
			);
		}
		candidates.push({
			planEpoch,
			rootEventHash: rootHash,
			source: 'plan_epoch_adopted',
		});
	}

	return candidates;
}

/**
 * Durable atomic write: write `data` to `tempPath`, fsync the file descriptor so
 * the bytes are flushed to stable storage, then atomically rename it over
 * `targetPath`.
 *
 * WHY the fsync matters: a plain `writeFileSync` returns once the data is in the
 * OS page cache, not on disk. A crash/power-loss between the write and the
 * subsequent `rename` can publish a zero-length or partially-written temp file as
 * the canonical ledger — silent truncation that later reads cannot distinguish
 * from a legitimately short ledger. Forcing an fsync before the rename guarantees
 * the temp file's bytes are durable before it becomes the canonical file.
 *
 * NOTE: the containing-directory fsync (which would also durably persist the
 * rename's directory entry so the *rename itself* survives a crash) is
 * intentionally OMITTED. The rename is atomic on POSIX, and the ledger's
 * crash-consistency contract only requires that a published ledger never be
 * partially-written; it tolerates losing the very last rename on power-loss (the
 * prior canonical file is then still intact). Omitting the dir-fsync avoids the
 * portability and cost concerns of opening the directory as a file descriptor.
 */
function writeFileFsyncedThenRename(
	tempPath: string,
	targetPath: string,
	data: string | Uint8Array,
): void {
	const fd = fs.openSync(tempPath, 'w');
	try {
		fs.writeFileSync(fd, data, 'utf8');
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tempPath, targetPath);
}

function fsyncRecoveryDirectory(directory: string): void {
	let fd: number | undefined;
	try {
		fd = fs.openSync(directory, 'r');
		fs.fsyncSync(fd);
	} catch (error) {
		// Windows does not consistently permit directory handles through openSync.
		// The archive file itself is still fsynced before rename; only the directory
		// metadata barrier is unavailable on that platform. POSIX failures are not
		// safe to ignore because recovery must not replace canonical before the
		// archive rename is durable.
		const code = (error as NodeJS.ErrnoException).code;
		const unsupportedOnWindows =
			process.platform === 'win32' &&
			['EPERM', 'EACCES', 'EINVAL', 'EBADF', 'EISDIR', 'ENOTSUP'].includes(
				code ?? '',
			);
		if (unsupportedOnWindows) {
			log(
				`[ledger] Directory fsync unavailable for recovery archive ${directory}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		throw new Error(
			`Failed to fsync recovery archive directory before canonical replacement: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function findRawMalformedSuffix(content: Buffer): Buffer {
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let lineStart = 0;
	for (let index = 0; index <= content.length; index++) {
		if (index < content.length && content[index] !== 0x0a) continue;
		let lineEnd = index;
		if (lineEnd > lineStart && content[lineEnd - 1] === 0x0d) lineEnd--;
		const line = content.subarray(lineStart, lineEnd);
		if (line.length > 0) {
			try {
				JSON.parse(decoder.decode(line));
			} catch {
				return content.subarray(lineStart);
			}
		}
		lineStart = index + 1;
	}
	return Buffer.alloc(0);
}

interface FileLedgerRead {
	events: LedgerEvent[];
	lines: Uint8Array[];
	truncated: boolean;
	badSuffix: string | null;
}

function isStructurallyValidLedgerEvent(value: unknown): value is LedgerEvent {
	const event = asRecord(value);
	return (
		event !== null &&
		Number.isSafeInteger(event.seq) &&
		(event.seq as number) > 0 &&
		typeof event.timestamp === 'string' &&
		typeof event.plan_id === 'string' &&
		typeof event.event_type === 'string' &&
		typeof event.source === 'string' &&
		typeof event.plan_hash_before === 'string' &&
		typeof event.plan_hash_after === 'string' &&
		typeof event.schema_version === 'string'
	);
}

/** Read JSONL without replacement decoding and retain each exact event cell. */
function readFileLedgerExact(directory: string): FileLedgerRead {
	const ledgerPath = getLedgerPath(directory);
	if (!fs.existsSync(ledgerPath)) {
		return { events: [], lines: [], truncated: false, badSuffix: null };
	}
	const bytes = fs.readFileSync(ledgerPath);
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const events: LedgerEvent[] = [];
	const lines: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index <= bytes.length; index++) {
		if (index < bytes.length && bytes[index] !== 0x0a) continue;
		let end = index;
		if (end > start && bytes[end - 1] === 0x0d) end--;
		const line = bytes.subarray(start, end);
		if (line.length > 0) {
			try {
				const parsed: unknown = JSON.parse(decoder.decode(line));
				if (!isStructurallyValidLedgerEvent(parsed)) {
					throw new Error('invalid ledger event shape');
				}
				events.push(parsed);
				lines.push(new Uint8Array(line));
			} catch {
				return {
					events,
					lines,
					truncated: true,
					badSuffix: bytes.subarray(start).toString('utf8'),
				};
			}
		}
		start = index + 1;
	}
	return { events, lines, truncated: false, badSuffix: null };
}

function sqliteEventsAsLedger(directory: string): {
	events: LedgerEvent[];
	lines: Uint8Array[];
} {
	const rows = readSqliteLedgerEvents(directory).events;
	return {
		events: rows.map((row) => row.event as LedgerEvent),
		lines: rows.map((row) => row.canonicalEvent),
	};
}

function exactPrefix(prefix: Uint8Array[], complete: Uint8Array[]): boolean {
	return (
		prefix.length <= complete.length &&
		prefix.every((line, index) =>
			Buffer.from(line).equals(Buffer.from(complete[index]!)),
		)
	);
}

function eventsProjection(
	directory: string,
	events: LedgerEvent[],
): {
	replayHash: string;
	projectionHash: string;
	projection: Uint8Array;
} {
	const plan = reconstructPlanFromEvents(directory, structuredClone(events));
	const projection = new TextEncoder().encode(JSON.stringify(plan));
	return {
		replayHash: plan
			? computePlanLedgerHash(plan)
			: crypto.createHash('sha256').update(projection).digest('hex'),
		projectionHash: crypto
			.createHash('sha256')
			.update(projection)
			.digest('hex'),
		projection,
	};
}

function stateForEvents(
	directory: string,
	events: LedgerEvent[],
	authorityMode: 'file_shadow' | 'sqlite',
) {
	const terminal = eventsProjection(directory, events);
	const last = events.at(-1);
	return {
		authorityMode,
		shadowStartedVersion:
			getPlanLedgerState(directory)?.shadowStartedVersion ??
			packageJson.version,
		parityStatus: 'pending' as const,
		terminalProjectionHash: terminal.projectionHash,
		terminalProjection: terminal.projection,
		lastSeq: last?.seq ?? 0,
		planId: last?.plan_id ?? null,
		terminalPlanHash: last?.plan_hash_after ?? null,
	};
}

function writePortableLedger(directory: string, lines: Uint8Array[]): void {
	const ledgerPath = getLedgerPath(directory);
	fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
	const content = Buffer.concat(
		lines.flatMap((line) => [Buffer.from(line), Buffer.from('\n')]),
	);
	const tempPath = `${ledgerPath}.sqlite-export.${Date.now()}.${Math.floor(Math.random() * 1e9)}.tmp`;
	_internals.writeFileFsyncedThenRename(tempPath, ledgerPath, content);
}

function archiveLegacyLedger(
	directory: string,
	bytes: Buffer,
): {
	path: string;
	hash: string;
} {
	const hash = crypto.createHash('sha256').update(bytes).digest('hex');
	const archivePath = path.join(
		directory,
		'.swarm',
		`plan-ledger.legacy-archive.${hash}.jsonl`,
	);
	if (!fs.existsSync(archivePath)) {
		// The archive is content-addressed, but its staging file must still be
		// unique: concurrent first writers must never share a fixed `.tmp` path.
		const tempPath = `${archivePath}.tmp.${crypto.randomBytes(16).toString('hex')}`;
		try {
			_internals.writeFileFsyncedThenRename(tempPath, archivePath, bytes);
		} finally {
			try {
				fs.unlinkSync(tempPath);
			} catch {
				/* renamed or never created */
			}
		}
		fsyncRecoveryDirectory(path.dirname(archivePath));
	}
	return { path: archivePath, hash };
}

function importCanonicalIntoSqlite(
	directory: string,
	file: FileLedgerRead,
	legacy: boolean,
): void {
	if (file.truncated) return;
	const ledgerBytes = fs.readFileSync(getLedgerPath(directory));
	const archive = legacy ? archiveLegacyLedger(directory, ledgerBytes) : null;
	const terminal = eventsProjection(directory, file.events);
	importSqliteLedger(directory, {
		canonicalEvents: file.lines,
		state: {
			...stateForEvents(directory, file.events, 'file_shadow'),
			fileReplayHash: terminal.replayHash,
			sqliteReplayHash: terminal.replayHash,
			parityStatus: 'clean',
		},
		source: 'plan-ledger.jsonl',
		sourceHash: crypto.createHash('sha256').update(ledgerBytes).digest('hex'),
		archivePath: archive?.path ?? null,
		archiveHash: archive?.hash ?? null,
		archiveSize: archive ? ledgerBytes.length : null,
		archiveCreatedAt: archive ? new Date().toISOString() : null,
		mode: 'file_shadow',
		version: packageJson.version,
	});
}

/**
 * Reconcile the portable JSONL and SQLite streams only across exact byte
 * prefixes. Divergent committed prefixes are never merged or timestamp-picked.
 */
function coordinateLedger(directory: string): FileLedgerRead {
	// Reset publishes this marker before clearing SQLite. Readers that do not
	// share the lifecycle lock must not resurrect the old JSONL authority.
	if (fs.existsSync(path.join(directory, '.swarm', 'plan-ledger.resetting')))
		return { events: [], lines: [], truncated: false, badSuffix: null };
	const file = readFileLedgerExact(directory);
	if (!hasSqliteLedger(directory)) {
		if (file.events.length > 0 && !file.truncated) {
			importCanonicalIntoSqlite(directory, file, true);
		}
		return file;
	}

	let sqlite = sqliteEventsAsLedger(directory);
	const state = getPlanLedgerState(directory);
	if (!state)
		throw new Error('SQLite plan ledger has events but no authority state');

	if (state.authorityMode === 'file_shadow') {
		if (!fs.existsSync(getLedgerPath(directory))) {
			// The shadow contains a previously verified complete history. Recreate a
			// missing portable authority file rather than treating absence as an empty
			// plan or allowing plan.md to win.
			writePortableLedger(directory, sqlite.lines);
			return {
				events: sqlite.events,
				lines: sqlite.lines,
				truncated: false,
				badSuffix: null,
			};
		}
		if (file.truncated) {
			if (!exactPrefix(file.lines, sqlite.lines)) {
				throw new Error(
					'PLAN_LEDGER_DIVERGED: malformed file prefix differs from SQLite authority',
				);
			}
			writePortableLedger(directory, sqlite.lines);
			return {
				events: sqlite.events,
				lines: sqlite.lines,
				truncated: false,
				badSuffix: null,
			};
		}
		if (
			file.events[0]?.seq === 1 &&
			file.events[0]?.event_type === 'plan_created' &&
			sqlite.events[0]?.plan_id !== file.events[0]?.plan_id
		) {
			try {
				replaceSqliteLedger(directory, {
					canonicalEvents: file.lines,
					state: stateForEvents(directory, file.events, 'file_shadow'),
					source: 'plan_identity_reinitialized',
					mode: 'file_shadow',
					version: packageJson.version,
				});
				sqlite = sqliteEventsAsLedger(directory);
			} catch (error) {
				log(
					`[ledger] SQLite shadow re-root reconciliation deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
				return file;
			}
		}
		if (!exactPrefix(sqlite.lines, file.lines)) {
			throw new Error(
				'PLAN_LEDGER_DIVERGED: JSONL and SQLite committed prefixes differ',
			);
		}
		try {
			for (
				let index = sqlite.lines.length;
				index < file.lines.length;
				index++
			) {
				appendSqliteLedger(directory, {
					canonicalEvent: file.lines[index]!,
					expectedSeq: index,
					state: stateForEvents(
						directory,
						file.events.slice(0, index + 1),
						'file_shadow',
					),
				});
			}
		} catch (error) {
			// JSONL is still authoritative in shadow mode. The SQLite transaction
			// rolled back event+state together, so leave the exact file suffix for a
			// later read to retry rather than failing a committed plan save.
			log(
				`[ledger] SQLite shadow suffix repair deferred: ${error instanceof Error ? error.message : String(error)}`,
			);
			return file;
		}
		sqlite = sqliteEventsAsLedger(directory);
		const fileProjection = eventsProjection(directory, file.events);
		// SQLite parity is intentionally derived from its independently validated
		// typed rows and committed state, not by feeding both stores through the
		// same replay function. rowEvent() first proves every typed column matches
		// the canonical BLOB; the terminal typed plan hash can then be compared with
		// the file replay's reconstructed-plan hash.
		const current = getPlanLedgerState(directory)!;
		const sqliteReplayHash = sqlite.events.at(-1)?.plan_hash_after ?? '';
		const sqliteProjectionHash = current.terminalProjectionHash;
		const parityStatus =
			fileProjection.replayHash === sqliteReplayHash &&
			fileProjection.projectionHash === sqliteProjectionHash
				? 'clean'
				: 'diverged';
		if (
			current.parityStatus !== parityStatus ||
			current.fileReplayHash !== fileProjection.replayHash ||
			current.sqliteReplayHash !== sqliteReplayHash
		) {
			recordSqliteLedgerParity(directory, {
				fileReplayHash: fileProjection.replayHash,
				sqliteReplayHash,
				terminalProjectionHash: sqliteProjectionHash,
				parityStatus,
			});
		}
		const refreshed = getPlanLedgerState(directory)!;
		if (
			refreshed.parityStatus === 'clean' &&
			refreshed.shadowStartedVersion !== null &&
			refreshed.shadowStartedVersion !== packageJson.version
		) {
			cutoverSqliteLedger(directory, {
				expectedShadowStartedVersion: refreshed.shadowStartedVersion,
			});
		}
		return file;
	}

	// SQLite commits before publishing its optional JSONL export. Consequently,
	// no portable extension is trustworthy after cutover, even when it is a
	// syntactically valid exact prefix extension. SQLite is the only authority
	// here; any stale, truncated, divergent, or extended export is repaired below.
	if (
		file.truncated ||
		file.lines.length !== sqlite.lines.length ||
		!exactPrefix(file.lines, sqlite.lines)
	) {
		writePortableLedger(directory, sqlite.lines);
	}
	return {
		events: sqlite.events,
		lines: sqlite.lines,
		truncated: false,
		badSuffix: null,
	};
}

/**
 * Compute a SHA-256 digest of the FULL plan state for the ledger hash chain.
 * Uses deterministic JSON serialization for consistent hashing.
 *
 * This is the LEDGER digest, not an approval-baseline hash. It deliberately
 * INCLUDES `phase.status` and `task.status` because `plan_hash_after` pins the
 * exact persisted ledger state, execution progress included. Its output is
 * persisted on-disk (`plan_hash_after`, plan-epoch identity, snapshot
 * integrity, staleness detection), so its byte output must NEVER change.
 * For drift-baseline comparisons use {@link computePlanStructureHash}.
 *
 * IMPORTANT: Intentionally excludes `specMtime` and `specHash` fields.
 * These fields track changes to spec.md but do not affect plan execution or structure.
 * Including them would cause the plan hash to change whenever spec metadata changes,
 * invalidating cached plan state unnecessarily. Spec changes are tracked separately
 * in the ledger via `spec_updated` and acknowledgment events.
 *
 * Renamed in issue #2523 (retiring the old generic name) so that exactly one
 * name (`computePlanStructureHash`) identifies the plan-structure hash. The
 * rename is byte-identical — the normalization below is unchanged.
 *
 * @param plan - The plan to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function computePlanLedgerHash(plan: Plan): string {
	// Create deterministic representation by sorting keys
	const normalized = {
		schema_version: plan.schema_version,
		title: plan.title,
		swarm: plan.swarm,
		current_phase: plan.current_phase,
		migration_status: plan.migration_status,
		execution_profile: normalizeExecutionProfileForHash(plan.execution_profile),
		phases: plan.phases.map((phase) => ({
			id: phase.id,
			name: phase.name,
			status: phase.status,
			required_agents: phase.required_agents
				? [...phase.required_agents].sort()
				: undefined,
			tasks: phase.tasks.map((task) => ({
				id: task.id,
				phase: task.phase,
				status: task.status,
				size: task.size,
				description: task.description,
				depends: [...task.depends].sort(),
				acceptance: task.acceptance,
				files_touched: [...task.files_touched].sort(),
				evidence_path: task.evidence_path,
				blocked_reason: task.blocked_reason,
				// `task.fr_refs` (optional spec FR/SC mapping, #1687) is deliberately
				// EXCLUDED from this field list to preserve byte-identical output for
				// every plan persisted before this field existed. Do not add it here.
			})),
		})),
	};

	const jsonString = JSON.stringify(normalized);
	return crypto.createHash('sha256').update(jsonString, 'utf8').digest('hex');
}

/**
 * Compute a SHA-256 hash of the plan's STRUCTURE — THE single approval-baseline
 * hash (issue #2523). Excludes the transient execution-progress fields
 * (`phase.status` and `task.status`).
 *
 * DECISION (documented per issue #2523): task/phase status does NOT belong in
 * the baseline hash. The baseline exists to detect *plan edits* — content,
 * scope, dependencies, files — not execution progress. Every writer and reader
 * of an approval-baseline `payload_hash` uses this function:
 * - `takeSnapshotEvent` stores it as the `payload_hash` of every
 *   `source === 'critic_approved'` snapshot (the gate recorders in
 *   `src/hooks/delegation-gate.ts` and the drift-verifier approval in
 *   `src/tools/write-drift-evidence.ts`).
 * - `get_approved_plan` compares it against that stored hash to compute
 *   `drift_detected`.
 * - The scope/participation bindings persist it as `planStructureHash` and
 *   re-derive it with the same function at verification time.
 * A status-only change (e.g. `update_task_status` flipping a task to
 * `in_progress`/`completed`) must therefore NEVER trip a baseline comparison;
 * any structural change (description, acceptance, dependencies, files, added
 * or removed tasks/phases) always must.
 *
 * This mirrors {@link computePlanLedgerHash}'s normalization byte-for-byte
 * EXCEPT it omits the two status fields from the hashed payload. The two
 * functions are deliberately distinct: {@link computePlanLedgerHash} is
 * load-bearing for ledger replay and staleness/integrity detection (its
 * output is persisted on-disk as `plan_hash_after`), so its byte output must
 * never change. Do NOT collapse these two into a shared normalizer.
 *
 * @param plan - The plan to hash
 * @returns Hex-encoded SHA-256 hash of the status-excluded structure
 */
export function computePlanStructureHash(plan: Plan): string {
	// Deterministic representation matching computePlanLedgerHash, minus status fields.
	const normalized = {
		schema_version: plan.schema_version,
		title: plan.title,
		swarm: plan.swarm,
		current_phase: plan.current_phase,
		migration_status: plan.migration_status,
		execution_profile: normalizeExecutionProfileForHash(plan.execution_profile),
		phases: plan.phases.map((phase) => ({
			id: phase.id,
			name: phase.name,
			required_agents: phase.required_agents
				? [...phase.required_agents].sort()
				: undefined,
			tasks: phase.tasks.map((task) => ({
				id: task.id,
				phase: task.phase,
				size: task.size,
				description: task.description,
				depends: [...task.depends].sort(),
				acceptance: task.acceptance,
				files_touched: [...task.files_touched].sort(),
				evidence_path: task.evidence_path,
				blocked_reason: task.blocked_reason,
				// `task.fr_refs` (optional spec FR/SC mapping, #1687) is deliberately
				// EXCLUDED from this field list to preserve byte-identical output for
				// every plan persisted before this field existed. Do not add it here.
			})),
		})),
	};

	const jsonString = JSON.stringify(normalized);
	return crypto.createHash('sha256').update(jsonString, 'utf8').digest('hex');
}

/**
 * Read the current plan.json and compute its LEDGER digest (the
 * status-inclusive {@link computePlanLedgerHash}, not the approval-baseline
 * structure hash). Used for hash-chain bookkeeping (`plan_hash_before`,
 * concurrency-token refresh), never for drift baselines.
 *
 * @param directory - The working directory
 * @returns Hash of current plan.json, or empty string if not found
 */
export function computeCurrentPlanHash(directory: string): string {
	const planPath = getPlanJsonPath(directory);
	try {
		const content = fs.readFileSync(planPath, 'utf8');
		const plan: Plan = JSON.parse(content);
		return computePlanLedgerHash(plan);
	} catch {
		// If plan.json doesn't exist or is invalid, return empty hash
		return '';
	}
}

/**
 * Check if the ledger file exists.
 *
 * @param directory - The working directory
 * @returns true if ledger file exists
 */
export async function ledgerExists(directory: string): Promise<boolean> {
	const ledgerPath = getLedgerPath(directory);
	return fs.existsSync(ledgerPath) || hasSqliteLedger(directory);
}

/**
 * Get the latest sequence number in the ledger.
 *
 * @param directory - The working directory
 * @returns Highest seq value, or 0 if ledger is empty/doesn't exist
 */
export async function getLatestLedgerSeq(directory: string): Promise<number> {
	const coordinated = coordinateLedger(directory);
	return coordinated.events.reduce(
		(maximum, event) => Math.max(maximum, event.seq),
		0,
	);
}

/**
 * Read all events from the ledger.
 *
 * @param directory - The working directory
 * @returns Array of LedgerEvent sorted by seq
 */
export async function readLedgerEvents(
	directory: string,
): Promise<LedgerEvent[]> {
	const result = coordinateLedger(directory);
	return [...result.events].sort((a, b) => a.seq - b.seq);
}

/**
 * Initialize a new ledger with a plan_created event.
 * Only call this if the ledger doesn't exist.
 *
 * @param directory - The working directory
 * @param planId - Unique identifier for the plan
 */
export async function initLedger(
	directory: string,
	planId: string,
	initialPlanHash?: string,
	initialPlan?: Plan,
): Promise<void> {
	assertProjectRoot(directory);
	const ledgerPath = getLedgerPath(directory);
	const planJsonPath = getPlanJsonPath(directory);

	// Guard against double initialization
	if (fs.existsSync(ledgerPath)) {
		throw new Error(
			'Ledger already initialized. Use appendLedgerEvent to add events.',
		);
	}

	// Use the provided hash if available (fresh from in-memory plan).
	// Fall back to reading on-disk plan.json only when no hash is supplied
	// (e.g., direct calls from tests or external tooling).
	let planHashAfter = initialPlanHash ?? '';
	let embeddedPlan: Plan | undefined = initialPlan;
	if (!initialPlanHash) {
		try {
			if (fs.existsSync(planJsonPath)) {
				const content = fs.readFileSync(planJsonPath, 'utf8');
				const plan: Plan = JSON.parse(content);
				planHashAfter = computePlanLedgerHash(plan);
				if (!embeddedPlan) embeddedPlan = plan;
			}
		} catch {
			// If we can't read plan.json, use empty hash
		}
	}

	// Embed the full plan in the plan_created event payload so the ledger
	// is self-sufficient for replay without requiring plan.json (#444 item 4).
	const payload: Record<string, unknown> = {
		plan_epoch: crypto.randomUUID(),
		...(embeddedPlan
			? { plan: embeddedPlan, payload_hash: planHashAfter }
			: {}),
	};

	const event: LedgerEvent = {
		seq: 1,
		timestamp: new Date().toISOString(),
		plan_id: planId,
		event_type: 'plan_created',
		source: 'initLedger',
		plan_hash_before: '',
		plan_hash_after: planHashAfter,
		schema_version: LEDGER_SCHEMA_VERSION,
		...(payload ? { payload } : {}),
	};

	// Ensure .swarm/ directory exists
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });

	// Write to temp file then rename for atomicity. fsync the temp file before
	// the rename so a crash cannot publish a truncated ledger (see
	// writeFileFsyncedThenRename).
	const tempPath = `${ledgerPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	const line = `${JSON.stringify(event)}\n`;

	writeFileFsyncedThenRename(tempPath, ledgerPath, line);

	// New projects also spend the carrying release in file-shadow mode. Keeping
	// initialization on the same staged path as legacy projects exercises parity
	// before a later plugin version is allowed to cut over.
	const initialized = readFileLedgerExact(directory);
	if (hasSqliteLedger(directory)) {
		const priorMode =
			getPlanLedgerState(directory)?.authorityMode ?? 'file_shadow';
		try {
			replaceSqliteLedger(directory, {
				canonicalEvents: initialized.lines,
				state: stateForEvents(directory, initialized.events, priorMode),
				source: 'plan_identity_reinitialized',
				mode: priorMode,
				version: packageJson.version,
			});
		} catch (error) {
			if (priorMode !== 'file_shadow') throw error;
			log(
				`[ledger] SQLite shadow re-root deferred after file commit: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else {
		importCanonicalIntoSqlite(directory, initialized, false);
	}
}

/**
 * Read ledger events for plan-epoch identity resolution, failing closed on a
 * malformed line.
 *
 * `readLedgerEvents` silently skips unparseable lines. That is unsafe for epoch
 * resolution specifically: a corrupted `plan_epoch_adopted` snapshot would become
 * invisible to `extractPlanEpochCandidates`, whose conflict detection only compares
 * candidates that parsed, so a fresh duplicate epoch could be minted instead of the
 * corruption being surfaced.
 *
 * This is defense in depth for the exported, directly-callable surface
 * (`readPlanEpochIdentity`, `getOrAdoptPlanEpochUnderLock`). For the
 * MALFORMED-LINE case it is not a live behavior change on any current call
 * path: every in-tree route is already fenced by an earlier
 * `replayFromLedgerWithStatus` check that throws first —
 * `recoverPreparedTaskTerminal` (`TASK_TERMINAL_LEDGER_TRUNCATED`), which is the
 * shared callee of both `update_task_status` and the delegation-gate `toolBefore`
 * hook, and `loadAuthoritativePlan` in `close-terminal.ts`
 * (`CLOSE_TERMINAL_LEDGER_TRUNCATED`). The two checks share one predicate, since
 * both readers go through `readLedgerEventsWithIntegrity`, which flags the first
 * malformed line anywhere in the file rather than only a trailing suffix.
 *
 * That fence does NOT cover the second failure mode. When the ledger file
 * exists but cannot be READ (EACCES, EIO, …), `readLedgerEventsWithIntegrity`
 * returns `truncated: false` with zero events — byte-identical to an absent
 * ledger — so `replayFromLedgerWithStatus` yields `plan: null` and those callers
 * silently fall back to the derived plan.json projection. This reader therefore
 * passes `failClosedOnReadError: true` and surfaces `PLAN_LEDGER_UNREADABLE`
 * rather than mislabeling an unreadable ledger as an empty one.
 *
 * The three terminal-recovery `replayFromLedgerWithStatus` callers
 * (`close-terminal.ts`, `task-terminal.ts`, `task-repair.ts`) do NOT yet opt in,
 * and that is an accepted residual rather than a planned follow-up: on an
 * unreadable ledger they still fall back to the derived plan.json projection
 * without surfacing an error. Opting them in is a wider behavior change than
 * this reader, because `replayFromLedgerWithStatus` feeds `replayFromLedger`,
 * whose `manager.ts` and `phase-complete.ts` callers deliberately treat a null
 * replay as "no ledger yet, use plan.json" on ordinary save_plan/phase_complete
 * paths — several outside any recovery `try` — so a blanket opt-in would turn a
 * transient EIO into a hard failure of the primary planning tools. Do not widen
 * this without re-doing that caller analysis.
 *
 * These helpers are exported and must not depend on future callers repeating
 * that discipline.
 */
async function readLedgerEventsForEpoch(
	directory: string,
): Promise<LedgerEvent[]> {
	const integrity = await _internals.readLedgerEventsWithIntegrity(directory, {
		failClosedOnReadError: true,
	});
	if (integrity.truncated) {
		throw new Error(
			`PLAN_LEDGER_TRUNCATED: ${getLedgerPath(directory)} has a malformed line; plan epoch identity cannot be resolved. Preserve this file and quarantine the corrupted suffix before retrying.`,
		);
	}
	return integrity.events;
}

/**
 * Read and validate the current plan epoch identity without creating,
 * adopting, or appending any ledger state.
 *
 * Returns null when the ledger is absent or when a legacy ledger has not yet
 * adopted an epoch. Invalid or conflicting epoch metadata still fails closed.
 */
export async function readPlanEpochIdentity(
	directory: string,
	authoritativePlan: Plan,
): Promise<PlanEpochIdentity | null> {
	assertProjectRoot(directory);
	if (!(await ledgerExists(directory))) {
		return null;
	}
	const events = await readLedgerEventsForEpoch(directory);
	if (events.length === 0) {
		throw new Error('Plan ledger is empty; missing plan_created root.');
	}
	return resolvePlanEpochIdentity(events, authoritativePlan);
}

/**
 * Return the persisted plan epoch for the authoritative ledger root, adopting
 * one backward-readable snapshot when a legacy root predates the epoch field.
 *
 * The caller is expected to already hold the higher-level plan lock. This
 * helper acquires only the ledger append lock so concurrent adopters serialize
 * to one adoption snapshot.
 */
export async function getOrAdoptPlanEpochUnderLock(
	directory: string,
	authoritativePlan: Plan,
): Promise<PlanEpochIdentity> {
	assertProjectRoot(directory);
	const planId = derivePlanId(authoritativePlan);
	const planIdentityHash = derivePlanIdentityHash(authoritativePlan);
	const payloadHash = computePlanLedgerHash(authoritativePlan);
	let lastStaleWriterError: LedgerStaleWriterError | undefined;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (!(await ledgerExists(directory))) {
			try {
				await initLedger(directory, planId, payloadHash, authoritativePlan);
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						error.message.includes('Ledger already initialized')
					)
				) {
					throw error;
				}
			}
		}

		const events = await readLedgerEventsForEpoch(directory);
		const existing = resolvePlanEpochIdentity(events, authoritativePlan);
		if (existing) {
			return existing;
		}

		if (events.length === 0) {
			throw new Error('Plan ledger is empty; cannot adopt a plan epoch.');
		}

		const rootEvent = events[0]!;
		const rootEventHash = computeLedgerEventHash(rootEvent);
		const tail = events[events.length - 1]!;
		const planEpoch = _internals.randomUUID();
		const adoptionPayload: PlanEpochAdoptionPayload = {
			plan: authoritativePlan,
			payload_hash: payloadHash,
			plan_epoch: planEpoch,
			root_event_hash: rootEventHash,
		};

		try {
			const appended = await _internals.appendLedgerEvent(
				directory,
				{
					event_type: 'snapshot',
					source: 'plan_epoch_adopted',
					plan_id: planId,
					payload: adoptionPayload as unknown as Record<string, unknown>,
				},
				{
					expectedSeq: tail.seq,
					expectedLedgerHash: tail.plan_hash_after,
					planHashAfter: payloadHash,
				},
			);

			const verifiedEvents = await readLedgerEventsForEpoch(directory);
			const verified = verifiedEvents[verifiedEvents.length - 1];
			const verifiedPayload = asRecord(verified?.payload);
			if (
				!verified ||
				verified.seq !== appended.seq ||
				verified.event_type !== 'snapshot' ||
				verified.source !== 'plan_epoch_adopted' ||
				verified.plan_id !== planId ||
				verifiedPayload?.plan_epoch !== planEpoch ||
				verifiedPayload?.root_event_hash !== rootEventHash ||
				verifiedPayload?.payload_hash !== payloadHash
			) {
				throw new Error(
					`Plan epoch adoption read verification failed for ${planId}.`,
				);
			}

			return {
				planId,
				planIdentityHash,
				planEpoch,
				rootEventHash,
				payloadHash,
				source: 'plan_epoch_adopted',
			};
		} catch (error) {
			// Retries are bounded by the loop condition alone. Do not re-encode the
			// attempt ceiling here: the previous `attempt < 3` guard rethrew the raw
			// stale-writer error on the final attempt, which made the descriptive
			// exhaustion error below unreachable and coupled two literals that had to
			// be changed together.
			if (error instanceof LedgerStaleWriterError) {
				lastStaleWriterError = error;
				continue;
			}
			throw error;
		}
	}

	throw new Error(
		`Unable to settle plan epoch for ${planId} after repeated stale-writer retries.`,
		{ cause: lastStaleWriterError },
	);
}

/**
 * Append a new event to the ledger.
 * Uses atomic write: write to temp file then rename.
 *
 * @param directory - The working directory
 * @param eventInput - Event data to append (without seq, timestamp, hashes)
 * @param options - Optional concurrency control options
 * @returns The full LedgerEvent that was written
 */
export async function appendLedgerEvent(
	directory: string,
	eventInput: LedgerEventInput,
	options?: {
		expectedSeq?: number;
		expectedHash?: string;
		/**
		 * CAS against the durable ledger tail rather than plan.json. This is used
		 * only by stale-projection reconciliation, where plan.json intentionally
		 * differs from the ledger and a snapshot adopts that exact projection as
		 * the new authoritative state.
		 */
		expectedLedgerHash?: string;
		planHashAfter?: string;
	},
): Promise<LedgerEvent> {
	assertProjectRoot(directory);
	return withEvidenceLock(
		directory,
		LEDGER_LOCK_PATH,
		'plan-ledger',
		'append-ledger-event',
		async () => {
			const ledgerPath = getLedgerPath(directory);
			if (
				options?.expectedLedgerHash !== undefined &&
				options.expectedSeq === undefined
			) {
				throw new Error(
					'expectedLedgerHash requires expectedSeq so stale-projection recovery is bound to one exact ledger tail',
				);
			}

			// Get current state while holding the ledger write lock so concurrent
			// writers cannot observe the same seq and both rewrite the canonical file.
			const latestSeq = await getLatestLedgerSeq(directory);
			const nextSeq = latestSeq + 1;
			let ledgerHashBefore: string | undefined;
			if (options?.expectedLedgerHash !== undefined) {
				const events = await readLedgerEvents(directory);
				const tail = events[events.length - 1];
				if (!tail || tail.plan_hash_after !== options.expectedLedgerHash) {
					throw new LedgerStaleWriterError(
						`Stale writer: expected ledger hash ${options.expectedLedgerHash} but found ${tail?.plan_hash_after ?? '<missing>'}`,
					);
				}
				ledgerHashBefore = tail.plan_hash_after;
			}

			// Compute plan_hash_before from current plan.json
			const planHashBefore = computeCurrentPlanHash(directory);

			// Validate concurrency constraints if provided
			if (
				options?.expectedSeq !== undefined &&
				options.expectedSeq !== latestSeq
			) {
				throw new LedgerStaleWriterError(
					`Stale writer: expected seq ${options.expectedSeq} but found ${latestSeq}`,
				);
			}

			if (
				options?.expectedHash !== undefined &&
				options.expectedHash !== planHashBefore
			) {
				throw new LedgerStaleWriterError(
					`Stale writer: expected hash ${options.expectedHash} but found ${planHashBefore}`,
				);
			}

			// Use provided planHashAfter if available (allows caller to compute hash from
			// in-memory mutated plan before writing to disk), otherwise fall back to
			// computing from current plan.json (backward-compatible)
			const planHashAfter = options?.planHashAfter ?? planHashBefore;

			const event: LedgerEvent = {
				...eventInput,
				seq: nextSeq,
				timestamp: new Date().toISOString(),
				plan_hash_before: ledgerHashBefore ?? planHashBefore,
				plan_hash_after: planHashAfter,
				schema_version: LEDGER_SCHEMA_VERSION,
			};

			// Ensure .swarm/ directory exists
			fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
			const canonicalEvent = new TextEncoder().encode(
				serializeLedgerEvent(event),
			);
			const state = getPlanLedgerState(directory);
			if (!state) {
				throw new Error('Ledger not initialized. Call initLedger() first.');
			}

			if (state.authorityMode === 'sqlite') {
				try {
					const existing = sqliteEventsAsLedger(directory);
					appendSqliteLedger(directory, {
						canonicalEvent,
						expectedSeq: latestSeq,
						state: stateForEvents(
							directory,
							[...existing.events, event],
							'sqlite',
						),
					});
				} catch (error) {
					if (error instanceof SqliteLedgerStaleWriterError) {
						throw new LedgerStaleWriterError(error.message);
					}
					throw error;
				}
				try {
					writePortableLedger(directory, sqliteEventsAsLedger(directory).lines);
				} catch (error) {
					criticalWarn(
						`[ledger] SQLite committed event ${event.seq}, but refreshing the portable plan-ledger.jsonl export failed: ${error instanceof Error ? error.message : String(error)}. SQLite remains authoritative; a later read will retry the export.`,
					);
				}
			} else {
				// During the carrying release JSONL commits first. A shadow-store fault is
				// observable but cannot make a file-authoritative save look uncommitted;
				// the next read repairs the exact missing suffix transactionally.
				const tempPath = `${ledgerPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
				if (!fs.existsSync(ledgerPath)) {
					throw new Error('Ledger not initialized. Call initLedger() first.');
				}
				const existingContent = fs.readFileSync(ledgerPath);
				writeFileFsyncedThenRename(
					tempPath,
					ledgerPath,
					Buffer.concat([
						existingContent,
						Buffer.from(canonicalEvent),
						Buffer.from('\n'),
					]),
				);
				try {
					// The file is authoritative during the soak release. Mirror only the
					// newly committed canonical event into SQLite here; the next coordinated
					// read performs the full parity projection. This keeps append cost
					// constant instead of replaying the entire ledger for every event.
					appendSqliteLedger(directory, {
						canonicalEvent,
						expectedSeq: latestSeq,
						state: {
							authorityMode: 'file_shadow',
							parityStatus: 'pending',
						},
					});
				} catch (error) {
					log(
						`[ledger] SQLite shadow append deferred after file commit: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			return event;
		},
	);
}

/**
 * Append a ledger event with optimistic retry on stale-writer conflicts.
 *
 * When another writer advances the ledger between the caller's read and
 * their append, `appendLedgerEvent` throws `LedgerStaleWriterError`. This
 * helper wraps that call in a bounded retry loop, refreshing the
 * `expectedHash` concurrency token against the current plan.json before
 * each retry.
 *
 * IMPORTANT: refreshing the hash is only safe when the event input is
 * *still semantically valid* after the intervening write. For audit
 * events computed from an in-memory plan the caller is about to persist,
 * it is always valid. For `task_status_changed` events, pass a
 * `verifyValid` callback that returns false when the transition no
 * longer applies (e.g. the task's on-disk status already matches the
 * `to_status`, or has moved past it). When `verifyValid` returns false,
 * the retry loop exits and the helper returns `null` to signal that the
 * event was skipped — it is not an error.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param eventInput - Event to append (required fields minus auto-generated)
 * @param options - Concurrency and retry configuration:
 *   - expectedHash: the hash of plan.json the caller observed (REQUIRED)
 *   - planHashAfter: precomputed hash of the mutated plan
 *   - maxRetries: max stale-writer retries (default: 3)
 *   - backoffMs: base delay in milliseconds (default: 10; exponential)
 *   - verifyValid: callback invoked before each retry to confirm the
 *     event input is still meaningful. Returning false aborts and
 *     resolves the helper to `null`.
 * @returns The written LedgerEvent, or `null` if verifyValid aborted.
 * @throws LedgerStaleWriterError if retries are exhausted.
 */
export async function appendLedgerEventWithRetry(
	directory: string,
	eventInput: LedgerEventInput,
	options: {
		expectedHash: string;
		planHashAfter?: string;
		maxRetries?: number;
		backoffMs?: number;
		verifyValid?: () => Promise<boolean> | boolean;
	},
): Promise<LedgerEvent | null> {
	const maxRetries = options.maxRetries ?? 3;
	const backoffBase = options.backoffMs ?? 10;
	let currentExpected = options.expectedHash;
	let attempt = 0;

	while (true) {
		try {
			return await appendLedgerEvent(directory, eventInput, {
				expectedHash: currentExpected,
				planHashAfter: options.planHashAfter,
			});
		} catch (error) {
			if (!(error instanceof LedgerStaleWriterError) || attempt >= maxRetries) {
				throw error;
			}
			attempt++;
			// Exponential backoff: 10ms, 20ms, 40ms (default)
			const delayMs = backoffBase * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delayMs));

			if (options.verifyValid) {
				const stillValid = await options.verifyValid();
				if (!stillValid) {
					return null;
				}
			}
			// Refresh concurrency token against the latest on-disk plan.
			currentExpected = computeCurrentPlanHash(directory);
		}
	}
}

/**
 * Take a snapshot with bounded retry and always-visible warning logging (FR-004).
 * Retries up to 3 times with exponential backoff, then logs a visible warning.
 * Non-fatal — never throws. Shared by save-plan tool and plan manager.
 */
export async function takeSnapshotWithRetry(
	directory: string,
	plan: Plan,
	options?: { planHashAfter?: string; source?: string },
): Promise<void> {
	const MAX_RETRIES = 3;
	const TOTAL_ATTEMPTS = 1 + MAX_RETRIES;
	const telemetrySource = options?.source ?? 'save_plan_tool';
	// Pass only planHashAfter to takeSnapshotEvent — the source field is
	// telemetry-only and must not leak into the ledger event source.
	const snapshotOptions = { planHashAfter: options?.planHashAfter };
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= TOTAL_ATTEMPTS; attempt++) {
		try {
			await takeSnapshotEvent(directory, plan, snapshotOptions);
			return;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < TOTAL_ATTEMPTS) {
				await new Promise<void>((r) => setTimeout(r, 10 * 2 ** (attempt - 1)));
			}
		}
	}
	criticalWarn(
		`[takeSnapshotWithRetry] Snapshot failed after ${MAX_RETRIES} retries (${TOTAL_ATTEMPTS} attempts): ${lastError!.message}`,
	);
	try {
		emit('snapshot_failed', {
			error: lastError!.message,
			retries: MAX_RETRIES,
			source: telemetrySource,
		});
	} catch {
		// telemetry emit is non-fatal
	}
}

/**
 * Take a snapshot event and append it to the ledger.
 * The snapshot embeds the full Plan payload for ledger-only rebuild.
 *
 * @param directory - The working directory
 * @param plan - The current plan state to snapshot
 * @param options - Optional configuration:
 *   - planHashAfter: precomputed hash of the mutated plan (bypasses the
 *     on-disk plan.json read when available)
 *   - source: attribution string stored on the ledger event. Defaults to
 *     `'takeSnapshotEvent'`. Use `'critic_approved'` to mark a snapshot as
 *     the immutable phase-approved checkpoint readable by
 *     `loadLastApprovedPlan`.
 *   - approvalMetadata: optional free-form metadata embedded into the
 *     snapshot payload (e.g. phase number, verdict, summary) so that
 *     downstream readers can filter without decoding prompts.
 *   - payloadHashOverride: when supplied, stored as the snapshot payload's
 *     `payload_hash` INSTEAD of the source-derived default. The default for a
 *     `source === 'critic_approved'` snapshot is the status-excluded structure
 *     hash (`computePlanStructureHash`) — an approval baseline is, by
 *     definition (issue #2523), the plan's structure, so this is enforced here
 *     at the single write choke point and every approval-snapshot writer gets
 *     it without having to remember an override. Every other source defaults
 *     to the status-inclusive ledger digest (`computePlanLedgerHash`).
 *     Note this only changes the embedded snapshot `payload_hash`; the ledger
 *     event's hash-chain field `plan_hash_after` is unaffected (still governed
 *     by `planHashAfter` / on-disk plan.json), preserving replay integrity.
 * @returns The LedgerEvent that was written
 */
export async function takeSnapshotEvent(
	directory: string,
	plan: Plan,
	options?: {
		planHashAfter?: string;
		source?: string;
		approvalMetadata?: Record<string, unknown>;
		payloadHashOverride?: string;
		/** CAS binding for stale-projection recovery snapshots. */
		expectedSeq?: number;
		/** Previous durable hash used to preserve the ledger hash chain. */
		expectedLedgerHash?: string;
	},
): Promise<LedgerEvent> {
	const payloadHash =
		options?.payloadHashOverride ??
		(options?.source === 'critic_approved'
			? computePlanStructureHash(plan)
			: computePlanLedgerHash(plan));
	const snapshotPayload: SnapshotEventPayload & {
		approval?: Record<string, unknown>;
	} = {
		plan,
		payload_hash: payloadHash,
	};
	if (options?.approvalMetadata) {
		snapshotPayload.approval = options.approvalMetadata;
	}
	const planId = derivePlanId(plan);
	return appendLedgerEvent(
		directory,
		{
			event_type: 'snapshot',
			source: options?.source ?? 'takeSnapshotEvent',
			plan_id: planId,
			payload: snapshotPayload as unknown as Record<string, unknown>,
		},
		{
			planHashAfter: options?.planHashAfter,
			expectedSeq: options?.expectedSeq,
			expectedLedgerHash: options?.expectedLedgerHash,
		},
	);
}

export interface TruncatedLedgerRecoveryResult {
	archivePath: string;
	archiveSha256: string;
	recoveryRoot: LedgerEvent;
}

/**
 * Recover an explicitly verified stale projection from a malformed ledger.
 *
 * A snapshot appended after an unparsable line is not durable recovery because
 * integrity replay stops at that line after restart. This transaction first
 * writes and fsyncs a byte-for-byte archive of the complete canonical ledger,
 * then atomically replaces the canonical file with a new `plan_created` root
 * that embeds the verified projection and links to the preserved archive.
 * A crash therefore leaves either the old canonical ledger or the new complete
 * root; it never creates a missing-ledger window or silently discards history.
 */
export async function replaceTruncatedLedgerWithRecoveryRoot(
	directory: string,
	plan: Plan,
	expected: { seq: number; ledgerHash: string },
): Promise<TruncatedLedgerRecoveryResult> {
	assertProjectRoot(directory);
	const validated = PlanSchema.parse(plan);
	return withEvidenceLock(
		directory,
		LEDGER_LOCK_PATH,
		'plan-ledger',
		'reconcile-truncated-ledger',
		async () => {
			const ledgerPath = getLedgerPath(directory);
			if (!fs.existsSync(ledgerPath)) {
				throw new LedgerStaleWriterError(
					'Stale writer: canonical ledger disappeared before truncated-ledger recovery',
				);
			}

			const events = await readLedgerEvents(directory);
			const tail = events[events.length - 1];
			if (
				!tail ||
				tail.seq !== expected.seq ||
				tail.plan_hash_after !== expected.ledgerHash ||
				events[0]?.plan_id !== derivePlanId(validated)
			) {
				throw new LedgerStaleWriterError(
					'Stale writer: ledger identity or tail changed before truncated-ledger recovery',
				);
			}

			const integrity = await readLedgerEventsWithIntegrity(directory);
			if (!integrity.truncated || integrity.badSuffix === null) {
				throw new LedgerStaleWriterError(
					'Stale writer: ledger is no longer truncated; retry against its current tail',
				);
			}

			const originalBytes = fs.readFileSync(ledgerPath);
			const archiveSha256 = crypto
				.createHash('sha256')
				.update(originalBytes)
				.digest('hex');
			const swarmDir = path.dirname(ledgerPath);
			const archiveSuffix = `.${archiveSha256.slice(0, 12)}.jsonl`;
			let archiveName = `plan-ledger.reconcile-archive.${Date.now()}.${Math.floor(Math.random() * 1e9)}${archiveSuffix}`;
			let archivePath = path.join(swarmDir, archiveName);
			let archiveNeedsWrite = true;
			for (const candidate of _internals
				.readLedgerDirectory(swarmDir)
				.sort(compareCodeUnits)) {
				if (
					!candidate.startsWith('plan-ledger.reconcile-archive.') ||
					!candidate.endsWith(archiveSuffix)
				) {
					continue;
				}
				const candidatePath = path.join(swarmDir, candidate);
				if (fs.readFileSync(candidatePath).equals(originalBytes)) {
					archiveName = candidate;
					archivePath = candidatePath;
					archiveNeedsWrite = false;
					break;
				}
			}
			const archiveTempPath = `${archivePath}.tmp.${crypto.randomBytes(16).toString('hex')}`;
			const canonicalTempPath = `${ledgerPath}.reconcile.${crypto.randomBytes(16).toString('hex')}.tmp`;

			const planHash = computePlanLedgerHash(validated);
			const rawBadSuffix = findRawMalformedSuffix(originalBytes);
			if (rawBadSuffix.length === 0) {
				throw new LedgerStaleWriterError(
					'Stale writer: raw ledger bytes no longer contain the malformed suffix detected during replay',
				);
			}
			const badSuffixSha256 = crypto
				.createHash('sha256')
				.update(rawBadSuffix)
				.digest('hex');
			const recoveryRoot: LedgerEvent = {
				seq: 1,
				timestamp: new Date().toISOString(),
				plan_id: derivePlanId(validated),
				event_type: 'plan_created',
				source: 'save_plan_truncated_ledger_reconcile',
				plan_hash_before: '',
				plan_hash_after: planHash,
				schema_version: LEDGER_SCHEMA_VERSION,
				payload: {
					plan: validated,
					payload_hash: planHash,
					recovery: {
						kind: 'truncated_ledger_reconcile',
						archived_ledger: `.swarm/${archiveName}`,
						archived_sha256: archiveSha256,
						bad_suffix_sha256: badSuffixSha256,
						prior_tail_seq: expected.seq,
						prior_tail_hash: expected.ledgerHash,
					},
				},
			};

			try {
				// Archive durability precedes canonical replacement. If the process
				// stops here, the original canonical file is still untouched.
				if (archiveNeedsWrite) {
					_internals.writeFileFsyncedThenRename(
						archiveTempPath,
						archivePath,
						originalBytes,
					);
				}
				_internals.fsyncRecoveryDirectory(swarmDir);
				_internals.writeFileFsyncedThenRename(
					canonicalTempPath,
					ledgerPath,
					`${JSON.stringify(recoveryRoot)}\n`,
				);
			} finally {
				for (const tempPath of [archiveTempPath, canonicalTempPath]) {
					try {
						fs.unlinkSync(tempPath);
					} catch {
						/* renamed or never created */
					}
				}
			}

			return { archivePath, archiveSha256, recoveryRoot };
		},
	);
}

/** Clear authoritative plan-ledger rows after the reset command has archived them. */
export async function clearPlanLedgerForReset(
	directory: string,
): Promise<void> {
	assertProjectRoot(directory);
	// The reset command has completed its archive first. Serialize the database
	// clear and portable-export removal with readers/writers so an old JSONL file
	// cannot be re-imported between those two destructive steps.
	await withEvidenceLock(
		directory,
		LEDGER_LOCK_PATH,
		'plan-ledger',
		'reset-plan-ledger',
		async () => {
			const marker = path.join(directory, '.swarm', 'plan-ledger.resetting');
			fs.writeFileSync(marker, 'resetting\n', 'utf8');
			try {
				clearSqliteLedger(directory);
				try {
					fs.unlinkSync(getLedgerPath(directory));
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
				}
			} finally {
				try {
					fs.unlinkSync(marker);
				} catch {}
			}
		},
	);
}

/**
 * Re-root the authoritative history for an explicit checkpoint rollback.
 * Existing JSONL bytes are content-addressed before the SQLite transaction;
 * the portable export is published only after the new SQLite root commits.
 */
export async function replacePlanLedgerWithRoot(
	directory: string,
	plan: Plan,
	source: string,
): Promise<void> {
	assertProjectRoot(directory);
	const validated = PlanSchema.parse(plan);
	await withEvidenceLock(
		directory,
		LEDGER_LOCK_PATH,
		'plan-ledger',
		'replace-plan-ledger-root',
		async () => {
			const ledgerPath = getLedgerPath(directory);
			if (fs.existsSync(ledgerPath)) {
				archiveLegacyLedger(directory, fs.readFileSync(ledgerPath));
			}
			const planHash = computePlanLedgerHash(validated);
			const root: LedgerEvent = {
				seq: 1,
				timestamp: new Date().toISOString(),
				plan_id: derivePlanId(validated),
				event_type: 'plan_created',
				source,
				plan_hash_before: '',
				plan_hash_after: planHash,
				schema_version: LEDGER_SCHEMA_VERSION,
				payload: {
					plan: validated,
					payload_hash: planHash,
					plan_epoch: crypto.randomUUID(),
				},
			};
			const line = new TextEncoder().encode(serializeLedgerEvent(root));
			const priorMode =
				getPlanLedgerState(directory)?.authorityMode ?? 'file_shadow';
			if (priorMode === 'file_shadow') {
				writePortableLedger(directory, [line]);
				try {
					replaceSqliteLedger(directory, {
						canonicalEvents: [line],
						state: stateForEvents(directory, [root], priorMode),
						source:
							source === 'savePlan_identity_migration'
								? 'plan_identity_reinitialized'
								: 'checkpoint_rollback',
						mode: priorMode,
						version: packageJson.version,
					});
				} catch (error) {
					log(
						`[ledger] SQLite shadow re-root deferred after authoritative file commit: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
			}
			replaceSqliteLedger(directory, {
				canonicalEvents: [line],
				state: stateForEvents(directory, [root], priorMode),
				source: 'checkpoint_rollback',
				mode: priorMode,
				version: packageJson.version,
			});
			try {
				writePortableLedger(directory, [line]);
			} catch (error) {
				criticalWarn(
					`[ledger] SQLite committed rollback root, but refreshing the portable plan-ledger.jsonl export failed: ${error instanceof Error ? error.message : String(error)}. SQLite remains authoritative; a later read will retry the export.`,
				);
			}
		},
	);
}

/**
 * Options for replayFromLedger
 */
interface ReplayOptions {
	/** If true, use the latest snapshot to speed up replay */
	useSnapshot?: boolean;
}

/**
 * Result of a status-aware ledger replay.
 *
 * Threads the integrity verdict OUT of replay so callers (notably `loadPlan`)
 * can distinguish a full, clean reconstruction from a PREFIX-ONLY one produced
 * after a poison line. Overwriting canonical plan.json with a prefix-only
 * projection silently drops every durable event recorded after the corruption
 * (the M1 silent-rollback defect); `truncated === true` is the signal that must
 * gate any such overwrite.
 */
export interface ReplayStatusResult {
	/** Reconstructed plan, or null when replay cannot proceed / plan was reset. */
	plan: Plan | null;
	/**
	 * True when a malformed ledger line stopped the read before the tail, so
	 * `plan` reflects only the events BEFORE the corruption. Never overwrite the
	 * canonical plan.json with `plan` when this is true.
	 */
	truncated: boolean;
	/** Raw corrupted suffix (first bad line through EOF), or null when clean. */
	badSuffix: string | null;
}

/**
 * Replay ledger events to reconstruct plan state (status-discarding wrapper).
 *
 * Delegates to {@link replayFromLedgerWithStatus} and returns only the plan.
 * Retained as the stable, widely-called/mocked entry point; callers that must
 * react to ledger truncation (to avoid the M1 silent-rollback) should use
 * {@link replayFromLedgerWithStatus} instead.
 *
 * @param directory - The working directory
 * @param options - Optional replay options
 * @returns Reconstructed Plan from ledger events, or null if plan.json doesn't exist or ledger is empty
 */
export async function replayFromLedger(
	directory: string,
	options?: ReplayOptions,
): Promise<Plan | null> {
	const { plan } = await replayFromLedgerWithStatus(directory, options);
	return plan;
}

/**
 * Reconstruct a plan without repairing either ledger authority or its
 * projections. This is deliberately separate from `replayFromLedgerWithStatus`:
 * ordinary replay coordinates the file/SQLite shadows and quarantines corrupted
 * suffixes, both of which are writes. Lifecycle previews need a strictly
 * observational view even when plan.json is missing.
 */
export async function peekPlanFromLedger(
	directory: string,
	_options?: ReplayOptions,
): Promise<ReplayStatusResult> {
	if (fs.existsSync(path.join(directory, '.swarm', 'plan-ledger.resetting')))
		return { plan: null, truncated: false, badSuffix: null };
	const file = readFileLedgerExact(directory);
	let events = file.events;
	let truncated = file.truncated;
	let badSuffix = file.badSuffix;
	const sqliteReadOnly = readSqliteLedgerEventsReadOnly(directory);
	if (fs.existsSync(path.join(directory, '.swarm', 'plan-ledger.resetting')))
		return { plan: null, truncated: false, badSuffix: null };
	if (sqliteReadOnly.events.length > 0) {
		const sqlite = {
			events: sqliteReadOnly.events.map((row) => row.event as LedgerEvent),
		};
		const authority = sqliteReadOnly.state;
		// In SQLite mode the database is authoritative. In file-shadow mode the
		// portable JSONL remains canonical unless it is absent; the latter is the
		// ordinary post-crash case that normal replay would repair by exporting the
		// SQLite shadow, which a dry-run must not do.
		if (authority?.authorityMode === 'sqlite' || events.length === 0) {
			events = sqlite.events;
			truncated = false;
			badSuffix = null;
		}
	}

	if (events.length === 0) {
		return { plan: null, truncated, badSuffix };
	}
	return {
		plan: reconstructPlanFromEvents(directory, events),
		truncated,
		badSuffix,
	};
}

/**
 * Replay ledger events to reconstruct plan state, threading the integrity
 * verdict back to the caller.
 *
 * This is the folded successor to the former `replayWithIntegrity`: it performs
 * integrity-checked reading (stop-at-first-bad via
 * {@link readLedgerEventsWithIntegrity}), quarantines any corrupted suffix to a
 * UNIQUE non-overwriting side file (never rewriting/truncating the canonical
 * ledger), and reconstructs the plan from the clean prefix.
 *
 * IMPORTANT semantics preserved from `replayFromLedger` (do NOT regress):
 *  - The `plan_created` embedded-plan bootstrap branch (#444) is honored via
 *    {@link reconstructPlanFromEvents}.
 *  - `applyEventToPlan`'s "unhandled event type" throw is intentionally allowed
 *    to PROPAGATE to the caller (loadPlan's catch → critic-approved snapshot
 *    fallback). It is NOT swallowed into a null return here (that was
 *    `replayWithIntegrity`'s bug — it hid genuine replay failures).
 *
 * @param directory - The working directory
 * @param _options - Optional replay options (reserved)
 * @returns {@link ReplayStatusResult} with plan, truncated flag, and bad suffix
 */
export async function replayFromLedgerWithStatus(
	directory: string,
	_options?: ReplayOptions,
): Promise<ReplayStatusResult> {
	const { events, truncated, badSuffix } =
		await readLedgerEventsWithIntegrity(directory);

	// If no events, nothing to replay
	if (events.length === 0) {
		return { plan: null, truncated, badSuffix };
	}

	// Handle corruption: quarantine the bad suffix to a UNIQUE side file. This is
	// NON-DESTRUCTIVE — it never rewrites or truncates the canonical ledger. The
	// `truncated` flag is threaded back so the caller can refuse to overwrite
	// plan.json with the prefix-only projection.
	if (truncated && badSuffix !== null) {
		await quarantineLedgerSuffix(directory, badSuffix);
	}

	const plan = reconstructPlanFromEvents(directory, events);
	return { plan, truncated, badSuffix };
}

/**
 * Reconstruct plan state from an ordered list of already-integrity-checked
 * ledger events. Prefers an in-ledger snapshot, then a `plan_created` embedded
 * plan (#444 self-sufficient ledger), then plan.json as the legacy base.
 *
 * Throws propagate by design: `applyEventToPlan`'s "unhandled event type" error
 * is intentionally allowed to bubble up to the caller — it must NOT be swallowed
 * into a null here.
 *
 * @param directory - The working directory (for plan.json fallback)
 * @param events - Integrity-checked events in ascending seq order
 * @returns Reconstructed Plan, or null when replay cannot proceed / plan reset
 */
function reconstructPlanFromEvents(
	directory: string,
	events: LedgerEvent[],
): Plan | null {
	// Filter to the identity of the first event...
	const targetPlanId = events[0].plan_id;
	const relevantEvents = events.filter((e) => e.plan_id === targetPlanId);

	// Always check for in-ledger snapshot events first
	{
		// Find the latest snapshot event
		const snapshotEvents = relevantEvents.filter(
			(e) => e.event_type === 'snapshot',
		);
		if (snapshotEvents.length > 0) {
			const latestSnapshotEvent = snapshotEvents[snapshotEvents.length - 1];

			// Get the plan from the snapshot payload
			const snapshotPayload =
				latestSnapshotEvent.payload as unknown as SnapshotEventPayload;
			let plan: Plan | null = snapshotPayload.plan;

			// Replay events after the snapshot
			const eventsAfterSnapshot = relevantEvents.filter(
				(e) => e.seq > latestSnapshotEvent.seq,
			);

			for (const event of eventsAfterSnapshot) {
				plan = applyEventToPlan(plan, event);
				if (plan === null) {
					// plan_reset event
					return null;
				}
			}

			return plan;
		}
	}

	// Try to bootstrap from plan_created event payload (self-sufficient ledger, #444 item 4)
	const createdEvent = relevantEvents.find(
		(e) => e.event_type === 'plan_created',
	);
	if (
		createdEvent?.payload &&
		typeof createdEvent.payload === 'object' &&
		'plan' in createdEvent.payload
	) {
		// Validate the embedded plan to guard against corrupted/tampered ledger entries
		const parseResult = PlanSchema.safeParse(createdEvent.payload.plan);
		if (parseResult.success) {
			let plan: Plan | null = parseResult.data;
			// Apply events after the plan_created event
			const eventsAfterCreated = relevantEvents.filter(
				(e) => e.seq > createdEvent.seq,
			);
			for (const event of eventsAfterCreated) {
				if (plan === null) return null;
				plan = applyEventToPlan(plan, event);
			}
			return plan;
		}
		// Malformed embedded plan — fall through to plan.json-based bootstrap
	}

	// Fall back to plan.json as base state (legacy ledgers without embedded plan)
	const planJsonPath = getPlanJsonPath(directory);
	if (!fs.existsSync(planJsonPath)) {
		return null;
	}

	let plan: Plan | null;
	try {
		const content = fs.readFileSync(planJsonPath, 'utf8');
		plan = JSON.parse(content);
	} catch {
		return null;
	}

	// Apply events in sequence
	for (const event of relevantEvents) {
		if (plan === null) {
			// plan_reset event
			return null;
		}
		plan = applyEventToPlan(plan, event);
	}

	return plan;
}

/**
 * Apply a single ledger event to the plan state.
 * Returns null if the event indicates a full reset (plan_reset).
 *
 * @param plan - Current plan state
 * @param event - Event to apply
 * @returns Updated plan state, or null if plan should be reset
 */
function applyEventToPlan(plan: Plan, event: LedgerEvent): Plan | null {
	switch (event.event_type) {
		case 'plan_created':
			// If the plan_created event embeds a full plan payload (post-#444 fix),
			// use it as the base state. This makes the ledger self-sufficient for
			// replay without requiring plan.json. Legacy events without payload
			// fall through to the existing plan.json-based bootstrap.
			// Validate the embedded plan to guard against corrupted ledger entries.
			if (
				event.payload &&
				typeof event.payload === 'object' &&
				'plan' in event.payload
			) {
				const parsed = PlanSchema.safeParse(event.payload.plan);
				if (parsed.success) return parsed.data;
				// Malformed embedded plan — return existing plan unchanged
			}
			return plan;

		case 'task_status_changed':
			if (event.task_id && event.to_status) {
				// Validate to_status before applying — an invalid status from a corrupted
				// ledger event must not be written to the plan (would break schema validation).
				const parseResult = TaskStatusSchema.safeParse(event.to_status);
				if (!parseResult.success) {
					// Skip invalid status; return the plan unchanged (do NOT break — a break
					// exits the switch and causes an implicit `undefined` return which
					// would corrupt the replay loop in replayFromLedger).
					return plan;
				}
				for (const phase of plan.phases) {
					const task = phase.tasks.find((t) => t.id === event.task_id);
					if (task) {
						task.status = parseResult.data;
						break;
					}
				}
			}
			return plan;

		case 'phase_completed':
			if (event.phase_id) {
				const phase = plan.phases.find((p) => p.id === event.phase_id);
				if (phase) {
					phase.status = 'complete';
				}
			}
			return plan;

		case 'plan_exported':
			// Audit-only marker — no plan state to update
			return plan;

		case 'task_added':
			// Audit-only: task was added but is already in plan.json
			return plan;

		case 'task_removed':
			// Functional on replay (issue #853 post-merge): the ledger commit
			// precedes the plan.json rename, so a crash between the two leaves
			// plan.json stale. Rebuild-from-ledger must drop the task or the
			// removal silently resurrects. Symmetric with task_status_changed;
			// the post-removal planHashAfter matches replayed state.
			if (event.task_id) {
				for (const phase of plan.phases) {
					const idx = phase.tasks.findIndex((t) => t.id === event.task_id);
					if (idx !== -1) {
						phase.tasks.splice(idx, 1);
						break;
					}
				}
			}
			return plan;

		case 'task_updated':
			// Audit-only: task was updated but the update is already reflected in plan.json
			return plan;

		case 'plan_rebuilt':
			// Audit-only: plan was rebuilt from ledger, structure already reflected in plan.json
			return plan;

		case 'task_reordered':
			// Audit-only: task order was changed, structure already reflected in plan.json
			return plan;

		case 'snapshot':
			// Audit-only: snapshot embeds full plan state, already handled by replayFromLedger
			return plan;

		case 'plan_reset':
			// Reset means start fresh — nothing to replay after a reset
			return null;

		case 'execution_profile_set': {
			// Validate and apply the embedded execution_profile from the event payload.
			const rawProfile = (event.payload as Record<string, unknown> | undefined)
				?.execution_profile;
			if (rawProfile !== undefined) {
				const parsed = ExecutionProfileSchema.safeParse(rawProfile);
				if (parsed.success) {
					return { ...plan, execution_profile: parsed.data };
				}
				// Malformed profile in payload — leave plan unchanged (do not corrupt state)
			}
			return plan;
		}

		case 'execution_profile_locked': {
			// Lock the existing execution_profile in place. If no profile exists yet, no-op.
			if (plan.execution_profile) {
				return {
					...plan,
					execution_profile: { ...plan.execution_profile, locked: true },
				};
			}
			return plan;
		}

		default:
			// Unknown or unhandled event type — fail replay rather than silently produce wrong state
			throw new Error(
				`applyEventToPlan: unhandled event type "${event.event_type}" at seq ${event.seq}`,
			);
	}
}

/**
 * Result type for readLedgerEventsWithIntegrity
 */
export interface LedgerIntegrityResult {
	/** Valid events up to (but not including) the first malformed line */
	events: LedgerEvent[];
	/** True if a bad line was found and replay was stopped early */
	truncated: boolean;
	/** Raw content from the first bad line to end of file, for quarantine */
	badSuffix: string | null;
}

/**
 * Read ledger events with integrity checking.
 * Stops at the first malformed/unparseable line and returns the remainder for quarantine.
 *
 * @param directory - The working directory
 * @returns LedgerIntegrityResult with events, truncated flag, and bad suffix
 */
export async function readLedgerEventsWithIntegrity(
	directory: string,
	options?: { failClosedOnReadError?: boolean },
): Promise<LedgerIntegrityResult> {
	const ledgerPath = getLedgerPath(directory);

	if (!fs.existsSync(ledgerPath) && !hasSqliteLedger(directory)) {
		return { events: [], truncated: false, badSuffix: null };
	}

	try {
		const result = coordinateLedger(directory);
		return {
			events: [...result.events].sort((a, b) => a.seq - b.seq),
			truncated: result.truncated,
			badSuffix: result.badSuffix,
		};
	} catch (error) {
		// The ledger EXISTS but could not be read (EACCES, EIO, EISDIR, …).
		// Returning the absent-ledger shape here is indistinguishable from ENOENT,
		// which silently demotes the authoritative ledger to the derived plan.json
		// projection. Callers that must fail closed opt in.
		if (options?.failClosedOnReadError) {
			throw new Error(
				`PLAN_LEDGER_UNREADABLE: ${ledgerPath} exists but could not be read (${error instanceof Error ? error.message : String(error)}); plan state cannot be resolved. This is NOT an absent ledger — preserve the file and check permissions/filesystem health before retrying.`,
			);
		}
		// Preserve historical best-effort semantics only for filesystem read errors.
		// SQLite transaction/parity/cutover failures are durability failures and
		// must remain visible to the caller.
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code && ['EACCES', 'EIO', 'EISDIR', 'EPERM'].includes(code)) {
			return { events: [], truncated: false, badSuffix: null };
		}
		throw error;
	}
}

/**
 * Result of a {@link quarantineLedgerSuffix} call.
 */
export interface QuarantineResult {
	/** Absolute path the suffix was written to, or null if the write failed. */
	path: string | null;
	/**
	 * Count of individually-parseable JSON lines salvaged from the bad suffix.
	 * The suffix is discarded from the active replay, but these lines were still
	 * well-formed events sitting behind the poison line — surfacing the count
	 * makes the size of the sacrificed tail observable rather than silent.
	 */
	salvagedCount: number;
}

/**
 * Quarantine a corrupted ledger suffix to a separate, UNIQUE side file.
 *
 * Does NOT modify, rewrite, or truncate the canonical ledger file — it only
 * copies the bad suffix aside for forensic recovery.
 *
 * Uniqueness (M1 fix): the target filename embeds a timestamp AND a content
 * hash of the suffix, so a SECOND corruption cannot clobber the file written by
 * the FIRST. The previous fixed `plan-ledger.quarantine` path overwrote any
 * prior quarantine, permanently losing the earlier corrupted tail.
 *
 * Salvage: before returning, each line of the suffix is probed with JSON.parse
 * and the count of well-formed lines is reported. The suffix is still excluded
 * from the active replay (it lives behind a poison line and cannot be trusted as
 * a contiguous continuation), but the salvage count is logged and returned so
 * the loss is visible.
 *
 * @param directory - The working directory
 * @param badSuffix - The corrupted content to quarantine
 * @returns {@link QuarantineResult} with the written path (or null) and the
 *   number of parseable lines salvaged from the suffix
 */
export async function quarantineLedgerSuffix(
	directory: string,
	badSuffix: string,
): Promise<QuarantineResult> {
	// Salvage: count individually-parseable lines in the suffix so the size of
	// the sacrificed tail is observable rather than silently discarded.
	let salvagedCount = 0;
	for (const line of badSuffix.split('\n')) {
		if (line.trim() === '') continue;
		try {
			JSON.parse(line);
			salvagedCount++;
		} catch {
			// Non-parseable line — not salvageable.
		}
	}

	try {
		assertProjectRoot(directory);
		// Unique, non-overwriting side path: timestamp for ordering + content hash
		// for identity, so distinct corruptions never collide on the same filename.
		const hash = crypto
			.createHash('sha256')
			.update(badSuffix, 'utf8')
			.digest('hex')
			.slice(0, 12);
		const swarmDir = path.join(directory, '.swarm');

		// Dedup (F-002/F-009): the startup ledger check runs once per process, so
		// the SAME corruption is re-quarantined on every process restart while the
		// poison line persists. Each write used a fresh `Date.now()` prefix, so an
		// unchanged corrupted tail accumulated one duplicate file per restart. If a
		// quarantine file for this exact content (same `.<hash>` suffix, verified by
		// byte-comparing the content) already exists, reuse it instead of writing a
		// new one. Distinct corruptions still get their own file (different hash).
		try {
			const existing = _internals
				.readLedgerDirectory(swarmDir)
				.sort(compareCodeUnits)
				.filter(
					(name) =>
						name.startsWith('plan-ledger.quarantine.') &&
						name.endsWith(`.${hash}`),
				);
			for (const name of existing) {
				const existingPath = path.join(swarmDir, name);
				if (fs.readFileSync(existingPath, 'utf8') === badSuffix) {
					return { path: existingPath, salvagedCount };
				}
			}
		} catch {
			// readdir/read failure (dir missing, permission) — fall through and
			// attempt a fresh write below.
		}

		const quarantinePath = path.join(
			swarmDir,
			`plan-ledger.quarantine.${Date.now()}.${hash}`,
		);
		fs.writeFileSync(quarantinePath, badSuffix, 'utf8');
		log(
			`[ledger] Corrupted suffix quarantined to ${path.relative(directory, quarantinePath)} (salvageable events: ${salvagedCount})`,
		);
		return { path: quarantinePath, salvagedCount };
	} catch {
		// Silently fail if we can't write the quarantine file
		// The bad suffix has already been captured in memory for handling
		return { path: null, salvagedCount };
	}
}

/**
 * Metadata describing an approved snapshot recovered from the ledger.
 */
export interface ApprovedSnapshotInfo {
	/** The immutable plan payload captured at critic approval time */
	plan: Plan;
	/** The ledger sequence number of the snapshot event */
	seq: number;
	/** ISO 8601 timestamp of the snapshot event */
	timestamp: string;
	/** Arbitrary metadata the caller attached (phase, verdict, summary, ...) */
	approval?: Record<string, unknown>;
	/** Hash of the plan payload at snapshot time */
	payloadHash: string;
}

/**
 * Find the most recent critic-approved immutable plan snapshot in the ledger.
 *
 * Snapshots are tagged at write time with a distinguishing `source` string
 * (see `takeSnapshotEvent`). The `critic_approved` marker identifies snapshots
 * persisted by the orchestrator after a phase Critic returns APPROVED. This
 * function scans the ledger in reverse order and returns the first matching
 * snapshot, including its embedded plan payload and approval metadata.
 *
 * Intended for use as a fallback when plan.json is lost, overwritten, or
 * suspected of drift: the Architect can fall back to the last approved plan
 * and the Critic can drift-check against it.
 *
 * SAFETY: when `expectedPlanId` is supplied, only snapshots whose event
 * `plan_id` matches are considered. Callers MUST pass an expected identity
 * whenever they have one (e.g. from the ledger's first `plan_created` anchor)
 * to prevent cross-identity contamination: a stale `critic_approved` snapshot
 * left in a reused directory could otherwise be resurrected as the active plan.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param expectedPlanId - Optional plan identity filter. When provided, only
 *   snapshots whose ledger event `plan_id` matches are considered.
 * @returns The most recent approved snapshot info, or null if none exists
 */
export async function loadLastApprovedPlan(
	directory: string,
	expectedPlanId?: string,
): Promise<ApprovedSnapshotInfo | null> {
	const events = await readLedgerEvents(directory);
	return findLastApprovedSnapshot(events, expectedPlanId);
}

/**
 * Find the most recent PLAN-CRITIC-approved snapshot in the ledger.
 *
 * Like {@link loadLastApprovedPlan}, but additionally requires the snapshot's
 * embedded `approval.source === 'plan_critic_gate'`. This distinguishes the
 * plan-critic execution-gate approval (recorded by
 * `recordPlanCriticApprovalSnapshotIfApplicable` in the delegation gate) from
 * the UNRELATED per-phase drift-verification snapshots that
 * `src/tools/write-drift-evidence.ts` also writes with
 * `source: 'critic_approved'` (but `approval: {phase, verdict, summary}` and no
 * `plan_critic_gate` marker).
 *
 * Without this filter, a drift-verification snapshot landing AFTER a legitimate
 * plan-critic approval would shadow it (being more recent), causing the gate to
 * spuriously reject execution. This loader skips non-matching `critic_approved`
 * snapshots and keeps scanning backward to find the plan-critic approval.
 *
 * SAFETY: `loadLastApprovedPlan`'s default behavior is intentionally left
 * unchanged — other callers (`get-approved-plan`, restore/recovery paths) want
 * ANY `critic_approved` snapshot as a restore point regardless of approval shape.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param expectedPlanId - Optional plan identity filter (see loadLastApprovedPlan)
 * @returns The most recent plan-critic-approved snapshot info, or null
 */
export async function loadLastPlanCriticApprovedSnapshot(
	directory: string,
	expectedPlanId?: string,
): Promise<ApprovedSnapshotInfo | null> {
	const events = await readLedgerEvents(directory);
	return findLastApprovedSnapshot(
		events,
		expectedPlanId,
		(payload) => payload.approval?.source === 'plan_critic_gate',
	);
}

/**
 * Shared reverse-scan for the latest `critic_approved` snapshot event.
 *
 * @param events - Ledger events in ascending seq order
 * @param expectedPlanId - Optional plan identity filter
 * @param extraFilter - Optional additional predicate on the snapshot payload.
 *   When provided, a `critic_approved` snapshot that fails the predicate is
 *   SKIPPED and the scan continues backward (it is not treated as a stopping
 *   point), so an earlier snapshot satisfying the predicate can still match.
 * @returns The most recent matching snapshot info, or null
 */
function findLastApprovedSnapshot(
	events: LedgerEvent[],
	expectedPlanId: string | undefined,
	extraFilter?: (
		payload: SnapshotEventPayload & { approval?: Record<string, unknown> },
	) => boolean,
): ApprovedSnapshotInfo | null {
	if (events.length === 0) {
		return null;
	}

	// Scan in reverse for the latest critic-approved snapshot.
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.event_type !== 'snapshot') continue;
		if (event.source !== 'critic_approved') continue;

		// Identity filter: reject snapshots that belong to a different plan
		// identity than the caller expects. Without this, reusing a workspace
		// across swarms would allow a stale approved snapshot from an earlier
		// swarm to be resurrected as the current plan.
		if (expectedPlanId !== undefined && event.plan_id !== expectedPlanId) {
			continue;
		}

		const payload = event.payload as unknown as
			| (SnapshotEventPayload & { approval?: Record<string, unknown> })
			| undefined;
		if (!payload || typeof payload !== 'object' || !payload.plan) {
			continue;
		}

		// Belt-and-suspenders: the embedded plan's identity must also match
		// the event's plan_id. Guards against a snapshot whose payload was
		// mutated on disk out-of-band from the event metadata.
		if (expectedPlanId !== undefined) {
			const payloadPlanId = derivePlanId(payload.plan);
			if (payloadPlanId !== expectedPlanId) {
				continue;
			}
		}

		// Caller-supplied predicate (e.g. the plan-critic gate marker). A
		// failing snapshot is skipped so the scan keeps looking further back.
		if (extraFilter && !extraFilter(payload)) {
			continue;
		}

		return {
			plan: payload.plan,
			seq: event.seq,
			timestamp: event.timestamp,
			approval: payload.approval,
			payloadHash: payload.payload_hash,
		};
	}

	return null;
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals = {
	computePlanLedgerHash,
	computePlanStructureHash,
	computeCurrentPlanHash,
	ledgerExists,
	getLatestLedgerSeq,
	readLedgerEvents,
	initLedger,
	appendLedgerEvent,
	appendLedgerEventWithRetry,
	takeSnapshotEvent,
	replayFromLedger,
	replayFromLedgerWithStatus,
	peekPlanFromLedger,
	applyEventToPlan,
	readLedgerEventsWithIntegrity,
	quarantineLedgerSuffix,
	loadLastApprovedPlan,
	loadLastPlanCriticApprovedSnapshot,
	getLedgerPath,
	getPlanJsonPath,
	archiveLegacyLedger,
	writeFileFsyncedThenRename,
	fsyncRecoveryDirectory,
	readLedgerDirectory,
	randomUUID: () => crypto.randomUUID(),
};

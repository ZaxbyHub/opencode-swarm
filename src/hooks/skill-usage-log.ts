/**
 * Skill usage log — tracks skill delegations and compliance outcomes.
 *
 * Writes one JSONL line per skill-usage event to `.swarm/skill-usage.jsonl`.
 * Follows the same append-only JSONL pattern as knowledge-application.jsonl.
 *
 * Issue #2038 — the JSONL is the **operational** stream and is bounded by a
 * hard global byte/age/count budget (`SKILL_USAGE_LIMITS`). The
 * **authoritative** record of un-consumed feedback lives in the sidecar
 * `.swarm/skill-usage-pending.json` (see `skill-usage-pending.ts`), so
 * evicting from this stream can lose no correctness signal: every actionable
 * verdict is enqueued in the sidecar *before* it is appended here.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as logger from '../utils/logger.js';
import type { ConfidenceFloorOptions } from './knowledge-store.js';
import { bumpKnowledgeConfidenceBatchResult } from './knowledge-store.js';
import {
	acquireSkillUsageLock,
	applyTerminalOutcome,
	dequeueRecords,
	emitSkillUsageHealth,
	enforceQueueBounds,
	enqueueSkillUsageFeedback,
	isSkillUsageQueueUnderPressure,
	loadPendingDocument,
	markRecordsInFlight,
	mergePendingRecords,
	queueByteSize,
	readPendingManifest,
	releaseSkillUsageLock,
	resolveStaleInFlight,
	retainWithRetry,
	SKILL_USAGE_LIMITS,
	type SkillUsageCoverage,
	type SkillUsageEnqueueInput,
	type SkillUsagePendingDocument,
	type SkillUsagePendingRecord,
	savePendingDocument,
	selectConsumableRecords,
} from './skill-usage-pending.js';
import { validateSwarmPath } from './utils.js';

export {
	isSkillWindowTrustworthy,
	SKILL_USAGE_LIMITS,
	type SkillUsageCoverage,
	type SkillUsagePendingRecord,
} from './skill-usage-pending.js';

// ============================================================================
// Types
// ============================================================================

/** Single entry in the skill-usage audit log. */
export interface SkillUsageEntry {
	/** Auto-generated unique identifier (UUID v4). */
	id: string;
	/** Repo-relative path to the skill file. */
	skillPath: string;
	/** Name of the agent receiving the skill. */
	agentName: string;
	/** Plan task ID the skill was loaded for. */
	taskID: string;
	/** ISO 8601 timestamp of the event. */
	timestamp: string;
	/** Compliance outcome — 'compliant' | 'partial' | 'violated' | 'not_checked' | custom.
	 *  Legacy on-disk entries may carry the pre-fix spelling 'violation'; these are
	 *  normalized to 'violated' on the read path (see normalizeComplianceVerdict). */
	complianceVerdict: string;
	/** Optional free-text notes from the reviewer. */
	reviewerNotes?: string;
	/** Session identifier. */
	sessionID: string;
	/** Skill version at the time of this usage event (omitted for pre-versioning entries). */
	skillVersion?: number;
}

interface SkillFeedbackAppliedMarker {
	type: 'feedback_applied';
	timestamp: string;
	processedEntryIds: string[];
}

/** Filter options for reading skill-usage entries. */
export interface SkillUsageFilterOptions {
	/** Filter entries by session ID (exact match). */
	sessionID?: string;
	/** Filter entries by skill path (exact match). */
	skillPath?: string;
	/** Filter entries by agent name (exact match). */
	agentName?: string;
	/** Filter entries by plan task ID (exact match). */
	taskID?: string;
	/** Filter entries to timestamps within this ISO 8601 range (inclusive). */
	dateRange?: { start: string; end: string };
}

/** Return value from prune operations. */
export interface PruneResult {
	/** Number of entries removed. */
	pruned: number;
	/** Number of entries remaining in the log. */
	remaining: number;
	/**
	 * Error message when the compaction could not be published; absent on
	 * success. Set both when the stream write/rename fails and when the
	 * manifest save that now precedes the rewrite fails (issue #2038 residual
	 * R1) — in the latter case nothing was dropped, so `pruned` is 0.
	 */
	error?: string;
}

/**
 * What the window returned by a read can and cannot answer (issue #2038,
 * requirement 4 / BLK-5). `complete === false` means entries the caller might
 * have expected are not in `entries` — either this read was byte-truncated, or
 * compaction has evicted history.
 */
export interface SkillUsageReadCoverage extends SkillUsageCoverage {
	/** True when THIS read was bounded by `readMaxBytes` and saw only a suffix. */
	truncatedRead: boolean;
}

// ============================================================================
// Path resolver
// ============================================================================

/** Resolve the absolute path to `.swarm/skill-usage.jsonl`, with swarm-path validation. */
function resolveLogPath(directory: string): string {
	return validateSwarmPath(directory, 'skill-usage.jsonl');
}

// ============================================================================
// Verdict normalization (legacy backward-compat)
// ============================================================================

/**
 * Normalize a compliance verdict to the canonical spelling.
 * The sole producer (`skill-propagation-gate.ts`) lowercases the regex
 * capture, yielding 'violated'.  Pre-fix on-disk entries may carry the
 * legacy spelling 'violation'; this maps them to the canonical form so
 * that every downstream comparison can use a single string.
 *
 * Exported for unit-testing.
 */
export function normalizeComplianceVerdict(verdict: string): string {
	return verdict === 'violation' ? 'violated' : verdict;
}

/** The two verdicts that carry a correctness signal and must be enqueued. */
function isActionableVerdict(
	verdict: string,
): verdict is 'compliant' | 'violated' {
	return verdict === 'compliant' || verdict === 'violated';
}

// ============================================================================
// DI seam
// ============================================================================

/**
 * Test-only dependency-injection seam. Tests override these without
 * `mock.module` (which leaks across files in Bun's shared test-runner).
 * Restore in `afterEach`, and call `_resetSkillUsageMaintenanceState()` to
 * clear module-scoped maintenance counters.
 */
export const _internals = {
	generateId: (): string => crypto.randomUUID(),
	appendFileSync: fs.appendFileSync.bind(fs),
	readFileSync: fs.readFileSync.bind(fs),
	writeFileSync: fs.writeFileSync.bind(fs),
	renameSync: fs.renameSync.bind(fs),
	mkdirSync: fs.mkdirSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	statSync: fs.statSync.bind(fs),
	openSync: fs.openSync.bind(fs),
	readSync: fs.readSync.bind(fs),
	closeSync: fs.closeSync.bind(fs),
	unlinkSync: fs.unlinkSync.bind(fs),
	pruneSkillUsageLog,
	resolveSourceKnowledgeIds,
	applySkillUsageFeedback,
	/** Test seam: lets FB-008-style tests drive `failed:true` / partial-apply through the real consumption path without `mock.module`. */
	bumpKnowledgeConfidenceBatchResult,
	parseGeneratedFromKnowledge,
	computeComplianceByVersion,
	normalizeComplianceVerdict,
	appendFeedbackAppliedMarker,
	/**
	 * Streaming read seam (issue #2038, BLK-11). The one-time migration and the
	 * compaction pass must see EVERY line of a legacy file — they are bounded in
	 * peak memory and per-read chunk size, never byte-truncated — so they cannot
	 * use `readFileSync` and cannot use the byte-bounded steady-state funnel.
	 */
	streamLogLines,
	enqueueSkillUsageFeedback,
	isQueueUnderPressure: isSkillUsageQueueUnderPressure,
	readPendingManifest,
};

// ---------------------------------------------------------------------------
// Module-scoped maintenance state (AGENTS.md invariant 7: one reset seam)
// ---------------------------------------------------------------------------

let _appendCount = 0;
/**
 * Requirement-5 suppressions awaiting a durable home.
 *
 * **Process-local, deliberately (issue #2038 implementation review, F4.)** These
 * are folded into the durable `pressure` counter by the next locked maintenance
 * pass *in this process*; suppressions in a process that exits before taking the
 * lock are lost, so `pressure` UNDER-REPORTS across process boundaries. Making it
 * exact would mean taking the skill-usage lock and rewriting the whole sidecar on
 * every suppressed append — and suppression happens per skill path inside the hot
 * delegation loop, precisely the O(paths x queue) synchronous I/O that approved
 * plan §2.1 removed from that loop. An under-reported observability counter is
 * the cheaper error than a lock acquisition per optional append, so `pressure` is
 * a lower bound on suppressions, never an exact count. It is still non-zero
 * whenever sustained pressure exists, because sustained pressure implies a later
 * maintenance pass in some process.
 */
let _suppressedOptionalAppends = 0;
/**
 * Appends since the last full compaction pass, so the entry-count budget still
 * has an in-process backstop even when the byte-size gate never trips.
 *
 * **Process-local, deliberately (issue #2038 implementation review, F4.)** Hook
 * processes are short-lived, so this rarely reaches `maxEntries` (5,000) within
 * one process and the byte gate is in practice the only append-path trigger.
 * Persisting it in the sidecar — the obvious durable home — would require the
 * lock plus a full sidecar rewrite on EVERY append, including the `not_checked`
 * appends that approved plan §2.1 keeps lock-free; that cost is paid on the hot
 * path while the counter only advances a backstop, so it is not worth it.
 *
 * What holds cross-process instead, and is what the ceiling actually rests on:
 *  - the BYTE gate in {@link compactionTrigger}, which reads `statSync` and is
 *    therefore stateless — it fires in any process, in the first 50 appends; and
 *  - the unconditional `pruneSkillUsageLog(dir, 500)` at
 *    `src/tools/phase-complete.ts:1722`, which enforces the full global budget
 *    (entry count included) on every phase completion regardless of any counter.
 * The entry-count budget can therefore drift above `maxEntries` between phase
 * completions when rows are small enough that `maxBytes` never trips — bounded
 * by `maxBytes`, which is the budget requirement 1 actually cares about.
 */
let _appendsSinceCompaction = 0;

/**
 * Reset the throttled-maintenance counters so an unswept run in Bun's shared
 * test-runner process cannot shift a later test's first maintenance pass.
 */
export function _resetSkillUsageMaintenanceState(): void {
	_appendCount = 0;
	_suppressedOptionalAppends = 0;
	_appendsSinceCompaction = 0;
}

function normalizeSkillUsageEntry(raw: unknown): SkillUsageEntry {
	const entry = raw as SkillUsageEntry;
	return {
		...entry,
		complianceVerdict: normalizeComplianceVerdict(entry.complianceVerdict),
	};
}

function legacySkillUsageId(entry: Partial<SkillUsageEntry>): string {
	const stable = JSON.stringify({
		skillPath: entry.skillPath,
		agentName: entry.agentName,
		taskID: entry.taskID,
		timestamp: entry.timestamp,
		complianceVerdict: entry.complianceVerdict,
		sessionID: entry.sessionID,
		skillVersion: entry.skillVersion,
	});
	return `legacy:${crypto.createHash('sha256').update(stable).digest('hex')}`;
}

function parseSkillUsageEntry(raw: unknown): SkillUsageEntry | null {
	const entry = raw as Partial<SkillUsageEntry> & { type?: string };
	if (entry.type === 'feedback_applied') return null;
	if (
		typeof entry.skillPath !== 'string' ||
		typeof entry.agentName !== 'string' ||
		typeof entry.taskID !== 'string' ||
		typeof entry.timestamp !== 'string' ||
		typeof entry.complianceVerdict !== 'string' ||
		typeof entry.sessionID !== 'string'
	) {
		return null;
	}
	return normalizeSkillUsageEntry({
		...entry,
		id: typeof entry.id === 'string' ? entry.id : legacySkillUsageId(entry),
	});
}

function parseFeedbackMarker(raw: unknown): SkillFeedbackAppliedMarker | null {
	const marker = raw as Partial<SkillFeedbackAppliedMarker> & { type?: string };
	if (marker.type !== 'feedback_applied') return null;
	if (typeof marker.timestamp !== 'string') return null;
	if (!Array.isArray(marker.processedEntryIds)) return null;
	const processedEntryIds = marker.processedEntryIds.filter(
		(id): id is string => typeof id === 'string' && id.length > 0,
	);
	return {
		type: 'feedback_applied',
		timestamp: marker.timestamp,
		processedEntryIds,
	};
}

/**
 * Legacy acknowledgment writer.
 *
 * Post-migration, acknowledgment is the sidecar's job: consumption dequeues
 * the record instead of appending a marker line, which is what removes the
 * unbounded marker accumulation described in issue #2038. This function is
 * retained so that a pre-migration on-disk log written by an older build
 * still round-trips through the reader above.
 */
function appendFeedbackAppliedMarker(
	directory: string,
	processedEntryIds: string[],
): void {
	if (processedEntryIds.length === 0) return;
	const resolved = resolveLogPath(directory);
	const dir = path.dirname(resolved);
	if (!_internals.existsSync(dir)) {
		_internals.mkdirSync(dir, { recursive: true });
	}
	const marker: SkillFeedbackAppliedMarker = {
		type: 'feedback_applied',
		timestamp: new Date().toISOString(),
		processedEntryIds: [...new Set(processedEntryIds)],
	};
	_internals.appendFileSync(resolved, `${JSON.stringify(marker)}\n`, 'utf-8');
}

// ============================================================================
// Streaming reader (bounded peak memory, never byte-truncated)
// ============================================================================

/**
 * Read `filePath` in `chunkBytes` slices and hand each complete, non-empty
 * line to `onLine`. Peak resident memory is O(chunkBytes), independent of the
 * file size — the metric requirement 4 actually cares about for the one-time
 * migration and the compaction pass (BLK-11).
 *
 * A single line longer than 4x the chunk bound cannot be assembled without
 * unbounded buffering; it is dropped and reported through `onOverlongLine` so
 * the caller can fold it into the durable `corrupt` counter rather than
 * losing it silently.
 */
function streamLogLines(
	filePath: string,
	chunkBytes: number,
	onLine: (line: string) => void,
	onOverlongLine?: () => void,
): void {
	const size = Math.max(1024, Math.floor(chunkBytes));
	const fd = _internals.openSync(filePath, 'r');
	try {
		const buf = Buffer.alloc(size);
		const decoder = new StringDecoder('utf8');
		let carry = '';
		let position = 0;
		for (;;) {
			const bytesRead = _internals.readSync(fd, buf, 0, size, position);
			if (!bytesRead || bytesRead <= 0) break;
			position += bytesRead;
			const text = carry + decoder.write(buf.subarray(0, bytesRead));
			const parts = text.split('\n');
			carry = parts.pop() ?? '';
			for (const part of parts) {
				const trimmed = part.trim();
				if (trimmed) onLine(trimmed);
			}
			if (carry.length > size * 4) {
				carry = '';
				onOverlongLine?.();
			}
		}
		const tail = (carry + decoder.end()).trim();
		if (tail) onLine(tail);
	} finally {
		_internals.closeSync(fd);
	}
}

// ============================================================================
// Append
// ============================================================================

/** Per-skill FIFO depth. Kept at 500 so `phase-complete.ts` keeps its call shape. */
const SKILL_USAGE_LOG_MAX_ENTRIES_PER_SKILL = 500;

/**
 * Why a full compaction pass is warranted, or `null` for "not now".
 *
 * `unmigrated` is called out separately because a pass over an un-migrated
 * store is deliberately a NO-OP on the stream: `pruneSkillUsageLog` leaves the
 * JSONL byte-identical there, since its `feedback_applied` markers are the only
 * acknowledgment record that exists yet. Such a pass therefore enforces no
 * budget and must not be allowed to consume the count backstop.
 */
type CompactionTrigger = 'pressure' | 'append-count' | 'unmigrated' | 'bytes';

/**
 * Cheap precondition for a full compaction pass.
 *
 * `pruneSkillUsageLog` takes the lock, loads the sidecar and STREAMS THE WHOLE
 * log. Running that unconditionally every `checkInterval` appends is
 * O(filesize) work on a cadence, i.e. O(n^2/checkInterval) across an append
 * loop — real cost once the file approaches its 1.5 MiB budget. This gate is
 * modelled directly on `src/context-map/telemetry.ts:1163-1185`, which pairs
 * `checkInterval` with a `statSync` drain threshold rather than relying on the
 * cadence alone.
 *
 * Four ways in, and the order matters:
 *
 * 1. `_suppressedOptionalAppends > 0` — requirement-5 pressure is waiting to be
 *    folded into the durable counter; that must not be size-gated.
 * 2. The append-count backstop (see the tradeoff note below).
 * 3. **Migration is never size-gated (BLK-13).** `readPendingManifest` is the
 *    cheap, `statSync`-keyed manifest probe, so "not migrated yet" is answered
 *    without parsing anything on the steady-state path. This is the whole
 *    reason the old 1 MiB trigger was wrong: a 300 KB legacy file with un-acked
 *    feedback would never migrate.
 * 4. Otherwise the byte budget: compact once the stream exceeds `maxBytes`.
 *
 * **Tradeoff, stated deliberately — read this before changing the gate.**
 * A byte gate preserves the BYTE ceiling exactly: `maxBytes` plus at most
 * `checkInterval` appends of overshoot, unchanged from the ungated version.
 * The ENTRY-COUNT budget (`maxEntries`) is the one that gives ground — a file
 * of unusually small rows can hold more than `maxEntries` of them while
 * staying under `maxBytes`. That is the right thing to trade: issue #2038 is
 * about unbounded *growth*, and bytes are what bound growth.
 *
 * `_appendsSinceCompaction` bounds how far that can drift, and the precise
 * guarantee is narrower than "a compaction every `maxEntries` appends" in three
 * separate ways:
 *  1. **It is PROCESS-LOCAL** (issue #2038 implementation review, F4). The
 *     counter is module state reset by `_resetSkillUsageMaintenanceState`, so
 *     the guarantee reads "at most `maxEntries` appends **within one process**".
 *     Hook processes are short-lived, so in production this backstop rarely
 *     fires at all; see the declaration of `_appendsSinceCompaction` for what
 *     does hold across processes (the stateless byte gate, and the
 *     unconditional prune at `phase-complete.ts:1722`).
 *  2. An attempt can still decline to rewrite — the lock may be held (§9:
 *     skipped, never forced), or nothing may be over budget.
 *  3. An un-migrated store is excluded from the reset entirely, because there a
 *     pass provably enforces nothing.
 *
 * So the honest statement is: **at most `maxEntries` appends can pass within a
 * single process without a retention-enforcing pass being ATTEMPTED on a
 * migrated store.**
 */
function compactionTrigger(directory: string): CompactionTrigger | null {
	if (_suppressedOptionalAppends > 0) return 'pressure';
	if (_appendsSinceCompaction >= SKILL_USAGE_LIMITS.maxEntries) {
		return 'append-count';
	}
	if (!_internals.readPendingManifest(directory).migrated) return 'unmigrated';
	try {
		const resolved = resolveLogPath(directory);
		if (!_internals.existsSync(resolved)) return null;
		return _internals.statSync(resolved).size > SKILL_USAGE_LIMITS.maxBytes
			? 'bytes'
			: null;
	} catch {
		// A stat we cannot take is not evidence of a file within budget; let the
		// full pass decide (it re-checks existence and fails open itself).
		return 'bytes';
	}
}

/**
 * Throttled maintenance (approved plan §1 `checkInterval`).
 *
 * Fires on the first append of a process and every `checkInterval` appends
 * thereafter — then {@link compactionTrigger} decides whether the full
 * O(filesize) pass is actually needed, so a legacy file is never stranded
 * waiting for a size trigger while a comfortably-in-budget file is not
 * re-streamed every 50 appends.
 */
function maybeRunMaintenance(directory: string): void {
	const shouldRun = _appendCount % SKILL_USAGE_LIMITS.checkInterval === 0;
	_appendCount += 1;
	_appendsSinceCompaction += 1;
	if (!shouldRun) return;
	try {
		const trigger = compactionTrigger(directory);
		if (trigger === null) return;
		// An un-migrated store is excluded: the pass below leaves its stream
		// untouched, so counting it as "compacted" would silently retire the
		// backstop without any budget having been enforced.
		if (trigger !== 'unmigrated') _appendsSinceCompaction = 0;
		_internals.pruneSkillUsageLog(
			directory,
			SKILL_USAGE_LOG_MAX_ENTRIES_PER_SKILL,
		);
	} catch (err) {
		// Counted, not swallowed by a bare `catch {}` (BLK-13 item 3).
		logger.log(
			'[skill-usage-log] maintenance pass failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * Validate and append a single skill-usage entry to the JSONL log.
 *
 * The `id` field is auto-generated; callers provide all other fields.
 * Uses synchronous I/O for consistency with the JSONL append pattern.
 *
 * Two behaviors matter for issue #2038:
 *
 * 1. **Actionable verdicts are enqueued FIRST, then appended** (approved plan
 *    §2.2). A crash between the two leaves at worst an orphan queue record
 *    with no stats row — harmless, the record is self-sufficient. The reverse
 *    order leaves an authoritative gap. A failed enqueue **aborts the append
 *    and propagates**; the sole actionable caller already handles a throw.
 * 2. **The `not_checked` path is a hard no-op for the queue** — no lock, no
 *    queue read-modify-write. That keeps O(paths x queue) synchronous I/O out
 *    of the hot delegation loop, and it is safe because `not_checked` carries
 *    no correctness signal. Under queue pressure those optional appends stop
 *    entirely (requirement 5).
 */
export function appendSkillUsageEntry(
	directory: string,
	entry: Omit<SkillUsageEntry, 'id'>,
): void {
	const {
		skillPath,
		agentName,
		taskID,
		timestamp,
		complianceVerdict,
		sessionID,
		reviewerNotes,
		skillVersion,
	} = entry;

	// Validate required string fields
	if (!skillPath || typeof skillPath !== 'string') {
		throw new Error('skillPath is required and must be a non-empty string');
	}
	if (/\.\.[/\\]/.test(skillPath)) {
		throw new Error('skillPath contains path traversal sequence');
	}
	if (!agentName || typeof agentName !== 'string') {
		throw new Error('agentName is required and must be a non-empty string');
	}
	if (!taskID || typeof taskID !== 'string') {
		throw new Error('taskID is required and must be a non-empty string');
	}
	if (!timestamp || typeof timestamp !== 'string') {
		throw new Error('timestamp is required and must be a non-empty string');
	}
	if (!complianceVerdict || typeof complianceVerdict !== 'string') {
		throw new Error(
			'complianceVerdict is required and must be a non-empty string',
		);
	}
	if (!sessionID || typeof sessionID !== 'string') {
		throw new Error('sessionID is required and must be a non-empty string');
	}

	const resolved = validateSwarmPath(directory, 'skill-usage.jsonl');
	const dir = path.dirname(resolved);

	if (!_internals.existsSync(dir)) {
		_internals.mkdirSync(dir, { recursive: true });
	}

	const verdict = normalizeComplianceVerdict(complianceVerdict);
	const actionable = isActionableVerdict(verdict);

	// Canonicalize AFTER the traversal validation above, never before: the raw
	// check is the strictly broader one (`file:../x` and `..\x` both match it),
	// so the rejection surface is provably unchanged. Both the stream entry and
	// the queue record below use this one spelling — a queue record that
	// disagreed with its stream row would just move the DEFECT-2 mismatch one
	// layer down, since `applySkillUsageFeedback` groups by the RECORD's path.
	const canonicalPath = canonicalSkillPath(skillPath);

	// Requirement 5 as a POLICY, not just a counter: at the queue budget the
	// optional history stops so the authoritative queue keeps its headroom.
	// The suppression is folded into the durable `pressure` counter by the
	// next locked maintenance pass, so it is observable.
	if (!actionable && _internals.isQueueUnderPressure(directory)) {
		_suppressedOptionalAppends += 1;
		return;
	}

	const fullEntry: SkillUsageEntry = {
		id: _internals.generateId(),
		skillPath: canonicalPath,
		agentName,
		taskID,
		timestamp,
		complianceVerdict: verdict,
		sessionID,
		...(reviewerNotes !== undefined && { reviewerNotes }),
		...(skillVersion !== undefined && { skillVersion }),
	};

	// Enqueue FIRST. A throw here aborts the append by design.
	if (actionable) {
		_internals.enqueueSkillUsageFeedback(directory, {
			id: fullEntry.id,
			skillPath: canonicalPath,
			verdict,
			timestamp,
		});
	}

	_internals.appendFileSync(
		resolved,
		`${JSON.stringify(fullEntry)}\n`,
		'utf-8',
	);

	maybeRunMaintenance(directory);
}

// ============================================================================
// Read
// ============================================================================

/** Result of the bounded read funnel. */
interface LogSlice {
	text: string;
	truncated: boolean;
}

/**
 * The bounded read funnel every steady-state reader goes through
 * (requirement 4). A file within the global byte budget always reads
 * complete, because `readMaxBytes >= maxBytes`. A larger file — a legacy log
 * that has not been compacted yet — reads its most recent `readMaxBytes` and
 * reports `truncated`, so the caller can degrade its confidence instead of
 * silently scoring on a partial window.
 */
function readLogSlice(directory: string): LogSlice {
	const resolved = resolveLogPath(directory);
	if (!_internals.existsSync(resolved)) return { text: '', truncated: false };

	let size: number;
	try {
		size = _internals.statSync(resolved).size;
	} catch {
		return { text: '', truncated: false };
	}

	if (size <= SKILL_USAGE_LIMITS.readMaxBytes) {
		try {
			return {
				text: _internals.readFileSync(resolved, 'utf-8') as string,
				truncated: false,
			};
		} catch {
			return { text: '', truncated: false };
		}
	}

	try {
		const start = size - SKILL_USAGE_LIMITS.readMaxBytes;
		const fd = _internals.openSync(resolved, 'r');
		try {
			const buf = Buffer.alloc(size - start);
			_internals.readSync(fd, buf, 0, buf.length, start);
			const content = buf.toString('utf-8');
			const firstNewline = content.indexOf('\n');
			return {
				text: firstNewline >= 0 ? content.slice(firstNewline + 1) : '',
				truncated: true,
			};
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		return { text: '', truncated: true };
	}
}

function parseEntriesFromText(text: string): SkillUsageEntry[] {
	const entries: SkillUsageEntry[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = parseSkillUsageEntry(JSON.parse(trimmed));
			if (entry) entries.push(entry);
		} catch {
			// skip malformed line — consistent with knowledge-application pattern
		}
	}
	return entries;
}

function filterEntries(
	entries: SkillUsageEntry[],
	options?: SkillUsageFilterOptions,
): SkillUsageEntry[] {
	if (!options) return entries;
	return entries.filter((e) => {
		if (options.sessionID !== undefined && e.sessionID !== options.sessionID) {
			return false;
		}
		if (options.skillPath !== undefined && e.skillPath !== options.skillPath) {
			return false;
		}
		if (options.agentName !== undefined && e.agentName !== options.agentName) {
			return false;
		}
		if (options.taskID !== undefined && e.taskID !== options.taskID) {
			return false;
		}
		if (options.dateRange !== undefined) {
			if (e.timestamp < options.dateRange.start) return false;
			if (e.timestamp > options.dateRange.end) return false;
		}
		return true;
	});
}

/**
 * Read and parse skill-usage entries together with the coverage of the window
 * they came from (issue #2038, BLK-5).
 *
 * Additive: `readSkillUsageEntries` remains a wrapper returning `entries`
 * only, so the DI seams in `corpus.ts` / `curator.ts` that are typed as
 * `typeof readSkillUsageEntries` keep working unchanged.
 *
 * Takes no lock and never migrates — reads must stay cheap and must never
 * mutate the store.
 */
export function readSkillUsageEntriesWithCoverage(
	directory: string,
	options?: SkillUsageFilterOptions,
): { entries: SkillUsageEntry[]; coverage: SkillUsageReadCoverage } {
	const slice = readLogSlice(directory);
	const entries = filterEntries(parseEntriesFromText(slice.text), options);
	const manifest = readPendingManifest(directory).coverage;
	return {
		entries,
		coverage: {
			...manifest,
			truncatedRead: slice.truncated,
			complete: manifest.complete && !slice.truncated,
		},
	};
}

/**
 * Read and parse skill-usage entries from the JSONL log, optionally filtered.
 *
 * Malformed lines are silently skipped (no throw). Returns an empty array
 * if the log file does not exist. Bounded by `SKILL_USAGE_LIMITS.readMaxBytes`;
 * use {@link readSkillUsageEntriesWithCoverage} when the caller needs to know
 * whether the window it received is complete.
 */
export function readSkillUsageEntries(
	directory: string,
	options?: SkillUsageFilterOptions,
): SkillUsageEntry[] {
	return readSkillUsageEntriesWithCoverage(directory, options).entries;
}

// ============================================================================
// Bounded tail read
// ============================================================================

/** Default maximum bytes to read from the end of the log file. */
export const TAIL_BYTES_DEFAULT = 64 * 1024; // 64 KB — covers ~500 entries
/**
 * Ceiling for an explicitly requested tail size.
 *
 * Deliberately equal to `TAIL_BYTES_DEFAULT`: the tail reader exists to serve
 * the delegation dedup/scoring window, which is specified as 64 KiB, so an
 * oversized request is clamped rather than honored. Issue #2038 §5 required
 * that this ceiling and the global read budget must not disagree *in silence* —
 * they no longer do, because the bounded read funnel
 * ({@link readSkillUsageEntriesWithCoverage}) is routed around this constant
 * and bounds itself with `SKILL_USAGE_LIMITS.readMaxBytes`, reporting
 * `coverage.truncatedRead` when it cuts.
 */
export const MAX_TAIL_BYTES = TAIL_BYTES_DEFAULT;

/**
 * Read the last `maxBytes` of the skill-usage JSONL log and parse matching
 * entries. Much faster than `readSkillUsageEntries` for large logs because
 * it reads only a bounded number of bytes from the end of the file instead
 * of loading the entire file into memory.
 *
 * Uses low-level `openSync` / `readSync` / `closeSync` to seek to the last
 * `maxBytes` of the file. Skips the first (potentially partial) line that
 * results from starting mid-file. Best-effort: returns an empty array on any
 * I/O or parse error.
 */
export function readSkillUsageEntriesTail(
	directory: string,
	filters: { sessionID?: string },
	maxBytes: number = TAIL_BYTES_DEFAULT,
): SkillUsageEntry[] {
	const logPath = resolveLogPath(directory);
	if (!_internals.existsSync(logPath)) return [];
	try {
		const normalizedMaxBytes = Number.isFinite(maxBytes)
			? maxBytes
			: TAIL_BYTES_DEFAULT;
		const boundedMaxBytes = Math.min(
			Math.max(1, normalizedMaxBytes),
			MAX_TAIL_BYTES,
		);
		const stat = _internals.statSync(logPath);
		const start = Math.max(0, stat.size - boundedMaxBytes);
		const fd = _internals.openSync(logPath, 'r');
		try {
			const readLen = stat.size - start;
			if (readLen === 0) return [];
			const buf = Buffer.alloc(readLen);
			_internals.readSync(fd, buf, 0, buf.length, start);
			const content = buf.toString('utf-8');
			// Skip first partial line only when starting mid-file
			let usable: string;
			if (start > 0) {
				const firstNewline = content.indexOf('\n');
				usable = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
			} else {
				usable = content;
			}
			const entries: SkillUsageEntry[] = [];
			for (const line of usable.split('\n')) {
				if (!line.trim()) continue;
				try {
					const entry = parseSkillUsageEntry(JSON.parse(line));
					if (!entry) continue;
					if (
						filters.sessionID !== undefined &&
						entry.sessionID !== filters.sessionID
					) {
						continue;
					}
					entries.push(entry);
				} catch {
					// skip malformed line
				}
			}
			return entries;
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		return [];
	}
}

// ============================================================================
// Per-version compliance
// ============================================================================

export interface VersionComplianceStats {
	compliant: number;
	violation: number;
	total: number;
	rate: number;
}

export function computeComplianceByVersion(
	entries: SkillUsageEntry[],
	skillPath: string,
): Map<number | undefined, VersionComplianceStats> {
	const map = new Map<number | undefined, VersionComplianceStats>();
	const normalizedTarget = skillPath.replace(/^file:/, '').replace(/\\/g, '/');

	for (const e of entries) {
		let p = e.skillPath;
		if (p.startsWith('file:')) p = p.slice(5);
		const normalized = p.replace(/\\/g, '/');
		if (
			normalized !== normalizedTarget &&
			!normalizedTarget.endsWith(`/${normalized}`) &&
			!normalized.endsWith(`/${normalizedTarget}`)
		) {
			continue;
		}

		const version = e.skillVersion;
		let stats = map.get(version);
		if (!stats) {
			stats = { compliant: 0, violation: 0, total: 0, rate: 0 };
			map.set(version, stats);
		}
		stats.total += 1;
		if (e.complianceVerdict === 'compliant') stats.compliant += 1;
		if (normalizeComplianceVerdict(e.complianceVerdict) === 'violated') {
			stats.violation += 1;
		}
	}

	for (const stats of map.values()) {
		stats.rate = stats.total === 0 ? 0 : stats.compliant / stats.total;
	}

	return map;
}

// ============================================================================
// Retention policy (approved plan §5)
// ============================================================================

/**
 * The single canonical on-disk spelling of a skill path: no `file:` prefix,
 * forward slashes only.
 *
 * **Why this is applied at the WRITE site, not just for grouping.**
 * Producers genuinely emit both spellings — paths parsed out of a prompt
 * `SKILLS:` field arrive as `file:.claude/skills/x/SKILL.md`
 * (`skill-propagation-gate.ts`), while discovery emits the bare path. If the
 * stream keeps both, retention groups them as ONE skill (every curator
 * consumer matches fuzzily, so it must) while `skill-scoring.ts:758` /
 * `:973` / `:981` and `filterEntries` match RAW-EXACT and see TWO. That is not
 * cosmetic: the two spellings then share a single `floorPerSkill` guarantee
 * but occupy two scoring buckets, so one spelling can be starved to zero while
 * its sibling keeps its floor — the floor guarantees nothing to an exact-match
 * consumer (issue #2038 review, DEFECT 2).
 *
 * Normalizing on write collapses the two into one, and every reader that
 * cares already strips `file:` idempotently (`resolveSourceKnowledgeIds`,
 * `computeComplianceByVersion`, `curator.ts:444-455`), so exact-match
 * consumers strictly benefit and fuzzy consumers are unaffected. No consumer
 * anywhere in `src/` requires the prefix preserved — verified by an
 * independent sweep of every read site of `SkillUsageEntry.skillPath` and
 * `SkillUsagePendingRecord.skillPath`.
 *
 * **Do NOT move this into `parseSkillUsageEntry` / `normalizeSkillUsageEntry`.**
 * `legacySkillUsageId` content-hashes the RAW parsed entry (including its raw
 * `skillPath`) to mint a stable id for a legacy id-less row. Normalizing
 * before that hash would mint a different id than the one an earlier migration
 * already recorded in the sidecar, desyncing the id-based dedupe that
 * `mergePendingRecords`, the migration ack set, and `dequeueRecords` all rely
 * on. Read stays raw; only writes are canonicalized.
 */
function canonicalSkillPath(skillPath: string): string {
	const stripped = skillPath.startsWith('file:')
		? skillPath.slice(5)
		: skillPath;
	return stripped.replace(/\\/g, '/');
}

/**
 * Group key for retention.
 *
 * Identical to {@link canonicalSkillPath} — every entry this process writes is
 * already canonical, so grouping is exact for new data. It stays a
 * normalization for the sake of legacy rows written before the canonical write
 * path existed, which converge on the first compaction that rewrites them.
 */
function retentionKey(skillPath: string): string {
	return canonicalSkillPath(skillPath);
}

/** Newest-first, tie-broken by id for determinism. */
function compareNewestFirst(a: SkillUsageEntry, b: SkillUsageEntry): number {
	if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return 0;
}

/** Oldest-first, tie-broken by id — the order compaction writes (BLK-12). */
function compareOldestFirst(a: SkillUsageEntry, b: SkillUsageEntry): number {
	if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return 0;
}

interface RetentionOutcome {
	kept: SkillUsageEntry[];
	dropped: number;
	skillsDropped: number;
}

/**
 * The retention policy, in this exact order (approved plan §5):
 *
 * 1. Drop everything older than `maxAgeMs`.
 * 2. Guarantee each surviving skill `min(count, floorPerSkill)` most-recent entries.
 * 3. Distribute the remaining budget by **global recency (newest-first)** — NOT
 *    by group size. Largest-group-first attacks the highest-signal skill.
 * 4. If step 2 alone exceeds `maxEntries`, admit skills by **most-recent-use
 *    descending** until the budget is spent; skills not admitted are dropped
 *    whole and counted (`skills_dropped`).
 *
 * There is deliberately **no** "no skill starved to zero" guarantee: for N
 * distinct skills > `maxEntries`, keeping >= 1 entry per skill is
 * arithmetically impossible, and requirement 1 (hard ceiling) wins.
 *
 * **Age reference point.** The window is anchored to the newest entry in the
 * log, not to wall-clock `Date.now()`. The approved plan says "drop everything
 * older than `maxAgeMs`" without naming a reference; anchoring to the data
 * makes compaction deterministic and idempotent (needed for the repeated-cycle
 * `{processed: 0, bumps: 0}` contract) and keeps the retained window genuinely
 * bounded either way. Entries whose timestamp does not parse are kept, never
 * silently discarded on a formatting technicality.
 */
function applyRetention(
	entries: SkillUsageEntry[],
	maxEntriesPerSkill: number,
): RetentionOutcome {
	const total = entries.length;
	if (total === 0) return { kept: [], dropped: 0, skillsDropped: 0 };

	// 1. Age budget.
	let newestMs = Number.NEGATIVE_INFINITY;
	for (const entry of entries) {
		const ms = Date.parse(entry.timestamp);
		if (!Number.isNaN(ms) && ms > newestMs) newestMs = ms;
	}
	let aged = entries;
	if (newestMs !== Number.NEGATIVE_INFINITY) {
		const cutoff = newestMs - SKILL_USAGE_LIMITS.maxAgeMs;
		aged = entries.filter((entry) => {
			const ms = Date.parse(entry.timestamp);
			return Number.isNaN(ms) ? true : ms >= cutoff;
		});
	}

	// 2. Group on the normalized key, newest-first, per-skill FIFO applied.
	const perSkillCap = Math.max(1, maxEntriesPerSkill);
	const groups = new Map<string, SkillUsageEntry[]>();
	for (const entry of aged) {
		const key = retentionKey(entry.skillPath);
		const list = groups.get(key);
		if (list) list.push(entry);
		else groups.set(key, [entry]);
	}
	const ordered: SkillUsageEntry[][] = [];
	for (const list of groups.values()) {
		list.sort(compareNewestFirst);
		ordered.push(list.length > perSkillCap ? list.slice(0, perSkillCap) : list);
	}

	const floor = SKILL_USAGE_LIMITS.floorPerSkill;
	let reservedTotal = 0;
	for (const list of ordered) reservedTotal += Math.min(list.length, floor);

	const kept: SkillUsageEntry[] = [];
	let skillsDropped = 0;

	if (reservedTotal > SKILL_USAGE_LIMITS.maxEntries) {
		// 4. Admit by most-recent-use descending; the rest are dropped whole.
		ordered.sort((a, b) => compareNewestFirst(a[0], b[0]));
		let used = 0;
		let admitting = true;
		for (const list of ordered) {
			const share = Math.min(list.length, floor);
			if (admitting && used + share <= SKILL_USAGE_LIMITS.maxEntries) {
				for (let i = 0; i < share; i++) kept.push(list[i]);
				used += share;
			} else {
				admitting = false;
				skillsDropped += 1;
			}
		}
	} else {
		// 2 + 3. Floors first, then the remaining budget by global recency.
		const leftovers: SkillUsageEntry[] = [];
		for (const list of ordered) {
			const share = Math.min(list.length, floor);
			for (let i = 0; i < share; i++) kept.push(list[i]);
			for (let i = share; i < list.length; i++) leftovers.push(list[i]);
		}
		const budget = SKILL_USAGE_LIMITS.maxEntries - kept.length;
		if (budget > 0 && leftovers.length > 0) {
			leftovers.sort(compareNewestFirst);
			const take = Math.min(budget, leftovers.length);
			for (let i = 0; i < take; i++) kept.push(leftovers[i]);
		}
	}

	// 5. Byte budget — newest survive.
	kept.sort(compareNewestFirst);
	let bytes = 0;
	let cut = kept.length;
	for (let i = 0; i < kept.length; i++) {
		bytes += JSON.stringify(kept[i]).length + 1;
		if (bytes > SKILL_USAGE_LIMITS.maxBytes) {
			cut = i;
			break;
		}
	}
	const bounded = cut < kept.length ? kept.slice(0, cut) : kept;

	return { kept: bounded, dropped: total - bounded.length, skillsDropped };
}

// ============================================================================
// Migration (approved plan §6)
// ============================================================================

/**
 * Peak-memory bound for the migration's candidate buffer, in records.
 *
 * The migration buffers **entries**, never acknowledgments (see
 * {@link migrateLegacyLog}). Twice the queue budget gives the ack-removal pass
 * some slack to work with before the final trim, and is the same 2x threshold
 * `collectForCompaction` uses for its own rolling buffer.
 */
const MIGRATION_MAX_CANDIDATES = SKILL_USAGE_LIMITS.queueMaxRecords * 2;

/** `needsMigration` = sidecar absent OR `sidecar.migrated !== true`. */
function needsMigration(doc: SkillUsagePendingDocument): boolean {
	return doc.migrated !== true;
}

function toEnqueueInput(entry: SkillUsageEntry): SkillUsageEnqueueInput | null {
	if (!isActionableVerdict(entry.complianceVerdict)) return null;
	return {
		id: entry.id,
		// Canonical here too: a migrated legacy row must land in the same queue
		// group as a freshly-appended one for the same skill. The id is minted
		// upstream from the RAW entry, so dedupe against an earlier migration is
		// unaffected.
		skillPath: canonicalSkillPath(entry.skillPath),
		verdict: entry.complianceVerdict,
		timestamp: entry.timestamp,
	};
}

/**
 * Rewrite the JSONL without `feedback_applied` marker lines. Streaming in and
 * streaming out, so peak memory stays O(chunk). Best-effort: a failure here is
 * counted and leaves the markers in place for the next compaction pass to drop.
 */
function rewriteWithoutMarkers(resolved: string): boolean {
	const dir = path.dirname(resolved);
	const tmpPath = path.join(dir, `skill-usage-${Date.now()}.tmp`);
	try {
		_internals.writeFileSync(tmpPath, '', 'utf-8');
		let buffer = '';
		_internals.streamLogLines(
			resolved,
			SKILL_USAGE_LIMITS.migrationChunkBytes,
			(line) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					return; // malformed lines are counted by the caller's pass
				}
				if (parseFeedbackMarker(parsed)) return;
				buffer += `${line}\n`;
				if (buffer.length >= SKILL_USAGE_LIMITS.migrationChunkBytes) {
					_internals.appendFileSync(tmpPath, buffer, 'utf-8');
					buffer = '';
				}
			},
		);
		if (buffer.length > 0) _internals.appendFileSync(tmpPath, buffer, 'utf-8');
		_internals.renameSync(tmpPath, resolved);
		return true;
	} catch (err) {
		try {
			if (_internals.existsSync(tmpPath)) _internals.unlinkSync(tmpPath);
		} catch {
			// ignore cleanup failure
		}
		logger.log(
			'[skill-usage-log] marker-drop rewrite failed (markers retained):',
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
}

/**
 * Copy a pending document so the legacy migration can build its result
 * WITHOUT touching the caller's object until the sidecar write has actually
 * succeeded. See the ordering note at the top of {@link migrateLegacyLog}.
 */
function stagePendingDocument(
	doc: SkillUsagePendingDocument,
): SkillUsagePendingDocument {
	return {
		version: doc.version,
		migrated: doc.migrated,
		// Every record and both sub-objects are flat, so a one-level copy is a
		// full copy: nothing the staged document mutates is shared with `doc`.
		records: doc.records.map((record) => ({ ...record })),
		counters: { ...doc.counters },
		coverage: { ...doc.coverage },
	};
}

/** Publish a staged document into the caller's object, after it is durable. */
function adoptStagedDocument(
	target: SkillUsagePendingDocument,
	staged: SkillUsagePendingDocument,
): void {
	target.version = staged.version;
	target.migrated = staged.migrated;
	target.records = staged.records;
	target.counters = staged.counters;
	target.coverage = staged.coverage;
}

/**
 * One-time legacy migration. **Caller must hold the lock and must have
 * established `needsMigration(doc)`.**
 *
 * Migration set (BLK-6 — a `feedback_applied` marker is an ACKNOWLEDGMENT,
 * not pending work; enqueuing markers would re-apply already-applied deltas):
 *
 * ```
 * pendingRecords = { actionable legacy entries, verdict in {compliant, violated} }
 *                  MINUS { ids covered by any feedback_applied marker }
 * markers        = DROPPED, only after the queue is durable
 * ```
 *
 * Crash-safe order (BLK-7 — two files cannot be replaced atomically):
 * stream, publish the **sidecar** first, and only then rewrite the JSONL.
 * A crash between the two leaves a durable queue and a stream that still
 * carries dead marker lines, which the next compaction pass removes.
 *
 * **Bounded-ness: buffer the ENTRIES, never the acknowledgments (issue #2038
 * implementation review, F6).** Markers may follow the entries they ack, so one
 * of the two sides must be buffered across a pass. An earlier revision buffered
 * ack ids, which is the unbounded side by construction — a marker set grows with
 * everything ever processed — so it needed a 100,000-id ceiling above which the
 * pass refused to set `migrated: true`. That refusal was an ABSORBING state: the
 * markers that build the ack set are only ever dropped by the post-migration
 * rewrite below, so a store that tripped the ceiling could never migrate, and
 * `pruneSkillUsageLog`'s `if (!migrated)` early return then left its stream
 * untouched forever — on exactly the large accumulated logs this issue exists to
 * bound.
 *
 * Buffering candidates instead removes the ceiling rather than raising it. The
 * candidate set is bounded by the QUEUE budget, which the migration is capped by
 * anyway ({@link MIGRATION_MAX_CANDIDATES}), and pass 2 tests marker ids against
 * that bounded set with O(1) extra memory per marker. Peak memory is therefore
 * strictly lower than the old ack-set bound, every pass sees the WHOLE file
 * (never byte-truncated, BLK-11), and `migrated: true` is honest by construction
 * — there is no partial-input branch left to guard.
 *
 * The one behavior change: when a single legacy log holds more than
 * `MIGRATION_MAX_CANDIDATES` actionable entries, the newest ones are preferred
 * before acknowledgments are subtracted, so an *older* un-acked entry can now be
 * trimmed where the old order might have kept it. Every such discard is counted
 * into `dropped` — never silent — and the realistic ordering (acks cover the
 * older prefix, un-acked work is the recent tail) leaves the retained set
 * identical. Read that contribution to `dropped` as an UPPER bound on lost
 * pending work: an entry trimmed before the acknowledgment pass may well have
 * been acknowledged already, i.e. consumed rather than lost. Deciding which
 * would require buffering the ack set, which is the unbounded side this design
 * exists to avoid.
 *
 * Legacy entries without an `id` get the deterministic content hash from
 * `legacySkillUsageId`, so a repeated migration mints identical ids and the
 * id-dedupe is exact (BLK-10). Two byte-identical legacy entries collapse to
 * one id and under-count by one — a pre-existing property of the legacy
 * marker format itself, not something this pass introduces, and accepted.
 */
function migrateLegacyLog(
	directory: string,
	doc: SkillUsagePendingDocument,
): void {
	// (0) BLK-7 / approved plan §6 — "never drop markers before the queue is
	// durable" is an ordering statement about the IN-MEMORY document as much as
	// about the files. The whole migration therefore runs against a private
	// STAGED copy, and the caller's `doc` is published only after
	// `savePendingDocument` has returned. `ensureMigrated`'s catch reports
	// success off `doc.migrated`, and `pruneSkillUsageLog` then rewrites the
	// JSONL emitting only `input.kept` — which excludes every `feedback_applied`
	// line. Mutating `doc` before the save meant one failed sidecar write
	// destroyed the acknowledgments anyway and the next pass re-enqueued every
	// already-applied verdict (issue #2038 final critic, C1: proven — ten acked
	// entries came back as ten `pending` records, and `applyConfidenceDeltas`
	// (`knowledge-store.ts:1644-1646`) is purely additive for this path, so the
	// replay bumps confidence a second time).
	//
	// Staging rather than a narrow `catch { doc.migrated = false; }` is
	// deliberate: it also keeps the merged records and the `corrupt` / `dropped`
	// increments off the caller's document, so the `!migrated` branch below
	// cannot persist half a migration and re-inflate lifetime counters when the
	// next pass re-runs it. On any throw the caller's `doc` is byte-for-byte the
	// document that was loaded from disk.
	const staged = stagePendingDocument(doc);
	const resolved = resolveLogPath(directory);
	if (!_internals.existsSync(resolved)) {
		staged.migrated = true;
		savePendingDocument(directory, staged);
		adoptStagedDocument(doc, staged);
		return;
	}

	const chunk = SKILL_USAGE_LIMITS.migrationChunkBytes;

	// --- Pass 1: actionable candidates, newest-first, trimmed to
	//     MIGRATION_MAX_CANDIDATES as we go so peak memory is O(queue budget).
	let candidates: SkillUsageEnqueueInput[] = [];
	let markerCount = 0;
	let corruptLines = 0;
	let trimmed = 0;
	const trimCandidates = (limit: number): void => {
		if (candidates.length <= limit) return;
		candidates.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
		trimmed += candidates.length - limit;
		candidates = candidates.slice(0, limit);
	};

	_internals.streamLogLines(
		resolved,
		chunk,
		(line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				corruptLines += 1;
				return;
			}
			if (parseFeedbackMarker(parsed)) {
				markerCount += 1;
				return;
			}
			const entry = parseSkillUsageEntry(parsed);
			if (!entry) return;
			const input = toEnqueueInput(entry);
			if (!input) return;
			candidates.push(input);
			if (candidates.length > MIGRATION_MAX_CANDIDATES) {
				trimCandidates(MIGRATION_MAX_CANDIDATES);
			}
		},
		() => {
			corruptLines += 1;
		},
	);

	// --- Pass 2: subtract the acknowledged ids. Streaming and O(1) extra memory
	//     in the markers, because membership is tested against the BOUNDED
	//     candidate set instead of accumulating every id a marker ever acked.
	//     Skipped entirely when the file carries no marker line.
	if (markerCount > 0 && candidates.length > 0) {
		const candidateIds = new Set(candidates.map((c) => c.id));
		const acked = new Set<string>();
		_internals.streamLogLines(resolved, chunk, (line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return; // already counted in pass 1
			}
			const marker = parseFeedbackMarker(parsed);
			if (!marker) return;
			for (const id of marker.processedEntryIds) {
				if (candidateIds.has(id)) acked.add(id);
			}
		});
		if (acked.size > 0) {
			candidates = candidates.filter((c) => !acked.has(c.id));
		}
	}

	// Final trim runs AFTER acknowledgment removal, so the queue budget is spent
	// on genuinely un-consumed work rather than on rows that were already applied.
	trimCandidates(SKILL_USAGE_LIMITS.queueMaxRecords);

	mergePendingRecords(staged, candidates, new Date().toISOString());
	staged.counters.corrupt += corruptLines;
	staged.counters.dropped += trimmed;
	enforceQueueBounds(staged);
	staged.migrated = true;

	// (2) Sidecar FIRST — the queue must be durable before markers are dropped.
	//     A throw here leaves `doc` untouched, so `ensureMigrated` reports
	//     `migrated === false` and the markers survive to the next pass.
	savePendingDocument(directory, staged);

	// (2b) Durable — only now may the in-memory document claim to be migrated.
	adoptStagedDocument(doc, staged);

	// (3) Only then the JSONL. Left byte-identical when there is nothing to
	//     drop, so migration never perturbs tail semantics for a legacy file
	//     that is already within budget.
	if (markerCount > 0) {
		rewriteWithoutMarkers(resolved);
	}

	emitSkillUsageHealth(
		doc,
		'migration',
		{
			bytes: queueByteSize(doc),
			limitBytes: SKILL_USAGE_LIMITS.queueMaxBytes,
		},
		directory,
	);
}

/**
 * Run the migration if it is needed, converting any failure into a counted
 * event rather than propagating it (BLK-13 item 3: the old bare `catch {}`
 * made migration failures invisible). Returns true when the store is migrated.
 *
 * The returned flag is read off `doc`, which `migrateLegacyLog` publishes ONLY
 * after the sidecar is durable — so a failure here always answers `false` and
 * `pruneSkillUsageLog` takes its marker-preserving `!migrated` branch.
 *
 * **Why `criticalWarn` and not `log`** (issue #2038 final critic, C1): the
 * `corrupt` counter bumped below lives in the very sidecar the failure means we
 * could not write, and `logger.log` / `logger.warn` are both gated behind
 * `OPENCODE_SWARM_DEBUG=1`. Without an always-emitted signal the operator's only
 * evidence of a store that has stopped compacting would be the absence of
 * something. `criticalWarn` writes to stderr unconditionally, which is exactly
 * the class it documents itself for. No new counter key and no new
 * `skill_usage_health` trigger: a counter would be written to the sink that just
 * failed, and widening the trigger union would widen a contract this change does
 * not own (same reasoning as `recordCuratorSkips`, `curator.ts:381-384`).
 */
function ensureMigrated(
	directory: string,
	doc: SkillUsagePendingDocument,
): boolean {
	if (!needsMigration(doc)) return true;
	try {
		migrateLegacyLog(directory, doc);
	} catch (err) {
		doc.counters.corrupt += 1;
		logger.criticalWarn(
			`[skill-usage-log] legacy skill-usage migration failed; the feedback_applied markers are RETAINED and compaction of .swarm/skill-usage.jsonl is skipped until it succeeds: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	return doc.migrated === true;
}

// ============================================================================
// Prune / compaction
// ============================================================================

/** Streaming collection for the compaction pass. */
interface CompactionInput {
	kept: SkillUsageEntry[];
	total: number;
	markerCount: number;
	corruptLines: number;
	skillsDropped: number;
	/**
	 * True when at least one streamed row carried a non-canonical `skillPath`
	 * (issue #2038 review, DEFECT 2). Forces a rewrite even with nothing to
	 * drop, so a file written before the canonical write path existed converges
	 * on its first compaction instead of keeping two spellings forever.
	 */
	normalized: boolean;
}

/**
 * Stream the whole log and reduce it to the retained set with bounded peak
 * memory. The rolling buffer is flushed through `applyRetention` whenever it
 * exceeds twice the global entry budget, so resident entries never exceed
 * O(`maxEntries`) regardless of file size.
 *
 * An incremental pass can drop a skill that a later chunk revives, which makes
 * the result a subset of what a single global pass would keep. That is a
 * conservative loss inside an already-exceeded budget, and coverage is flagged
 * incomplete either way.
 */
function collectForCompaction(
	resolved: string,
	maxEntriesPerSkill: number,
): CompactionInput {
	let buffer: SkillUsageEntry[] = [];
	let total = 0;
	let markerCount = 0;
	let corruptLines = 0;
	let normalized = false;

	_internals.streamLogLines(
		resolved,
		SKILL_USAGE_LIMITS.migrationChunkBytes,
		(line) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				corruptLines += 1;
				return;
			}
			if (parseFeedbackMarker(parsed)) {
				markerCount += 1;
				return;
			}
			const entry = parseSkillUsageEntry(parsed);
			if (!entry) {
				corruptLines += 1;
				return;
			}
			total += 1;
			// Canonicalize AFTER `parseSkillUsageEntry`, which is where a legacy
			// id-less row gets its content-hashed id minted from the RAW fields.
			// Doing it here keeps that id stable while the row written back to
			// disk carries the single canonical spelling.
			const canonical = canonicalSkillPath(entry.skillPath);
			if (canonical !== entry.skillPath) {
				entry.skillPath = canonical;
				normalized = true;
			}
			buffer.push(entry);
			if (buffer.length > SKILL_USAGE_LIMITS.maxEntries * 2) {
				buffer = applyRetention(buffer, maxEntriesPerSkill).kept;
			}
		},
		() => {
			corruptLines += 1;
		},
	);

	const final = applyRetention(buffer, maxEntriesPerSkill);
	return {
		kept: final.kept,
		total,
		markerCount,
		corruptLines,
		skillsDropped: final.skillsDropped,
		normalized,
	};
}

/**
 * Prune the skill-usage log.
 *
 * Two budgets are enforced, in this order:
 * 1. the legacy per-skill FIFO (`maxEntriesPerSkill`, default 500), and
 * 2. the **hard global** byte / age / count ceiling from `SKILL_USAGE_LIMITS`.
 *
 * **BLK-3 — the highest-risk detail of issue #2038.** The old body returned
 * early with `if (pruned === 0) return ...` immediately after per-skill
 * pruning, so in the reported scenario — thousands of distinct skills, every
 * one of them under 500 entries — nothing was ever pruned, the file was never
 * rewritten, and the 1 MiB trigger simply re-fired on every append. The global
 * budget is now evaluated by `applyRetention` **before** any early return, and
 * the rewrite decision below is taken on the union of both budgets plus the
 * marker set. There is deliberately no `pruned === 0` short-circuit ahead of it.
 *
 * Writes atomically (temp file + rename) in **global timestamp order**
 * (BLK-12) so a rewrite can never push a live session's recent entries out of
 * the 64 KiB tail window that the delegation dedup preload depends on.
 *
 * @returns Stats about how many entries were pruned and how many remain.
 */
export function pruneSkillUsageLog(
	directory: string,
	maxEntriesPerSkill: number = 500,
): PruneResult {
	const resolved = resolveLogPath(directory);

	if (!_internals.existsSync(resolved)) {
		return { pruned: 0, remaining: 0 };
	}

	// Approved plan §9: maintenance is SKIPPED on lock failure, never forced.
	const handle = acquireSkillUsageLock(directory);
	if (!handle) {
		return {
			pruned: 0,
			remaining: readSkillUsageEntriesWithCoverage(directory).entries.length,
		};
	}

	try {
		const { doc } = loadPendingDocument(directory);

		// Migration is triggered on first touch by ANY lock-taking path, and is
		// NOT gated on a file-size check (BLK-13).
		const migrated = ensureMigrated(directory, doc);

		if (_suppressedOptionalAppends > 0) {
			doc.counters.pressure += _suppressedOptionalAppends;
			_suppressedOptionalAppends = 0;
		}

		const input = collectForCompaction(resolved, maxEntriesPerSkill);
		doc.counters.corrupt += input.corruptLines;

		const dropped = input.total - input.kept.length;

		// While the store is still un-migrated the `feedback_applied` markers are
		// the only acknowledgment record there is, so the stream is left strictly
		// alone: a rewrite would destroy them.
		if (!migrated) {
			if (input.corruptLines > 0) {
				try {
					savePendingDocument(directory, doc);
				} catch {
					// counters are best-effort
				}
			}
			return { pruned: 0, remaining: input.total };
		}

		// `input.normalized` is the third trigger (issue #2038 review, DEFECT 2):
		// a legacy file may be entirely within budget and marker-free yet still
		// hold both `file:x` and `x` for one skill. Without this it would never
		// be rewritten and the two spellings would stay two scoring buckets
		// forever. The flag is false once every row is canonical, so this
		// converges after exactly one extra rewrite and never loops.
		//
		// `input.corruptLines > 0` is the fourth, and it is what makes the BYTE
		// ceiling actually hard (issue #2038 implementation review, F1). The
		// trigger and the enforcement measure two different quantities:
		// `compactionTrigger` compares `statSync(...).size` — ALL bytes on disk,
		// unparseable ones included — against `maxBytes`, while `applyRetention`
		// sizes only the VALID entries it keeps. Without this clause a file whose
		// bulk is unparseable is never rewritten, the only thing that removes
		// corrupt lines never runs, and the state is absorbing: the trigger stays
		// permanently true, every `checkInterval` appends re-streams the whole
		// oversized file for nothing, and `readLogSlice` stays pinned at
		// `truncated: true`, which holds `coverage.complete` false forever and
		// silently raises the curator's retirement bar project-wide.
		//
		// Dropping those lines is what approved plan §10 already assumed ("today's
		// rewrite destroys corrupt lines each pass ... so a naive counter resets to
		// zero"): the durable LIFETIME `corrupt` counter in the sidecar — folded in
		// above, before any return — is the compensation, and it is why the
		// information is not lost when the bytes are. Convergence is exact: the
		// rewrite emits only `input.kept`, so the next pass sees
		// `corruptLines === 0` and this clause cannot re-fire.
		const needsRewrite =
			dropped > 0 ||
			input.markerCount > 0 ||
			input.normalized ||
			input.corruptLines > 0;
		if (!needsRewrite) {
			// No durable-counter flush here on purpose: `!needsRewrite` now implies
			// `input.corruptLines === 0` (the clause above), so there is nothing new
			// to persist. The un-migrated branch above keeps its own flush, because
			// that path deliberately declines to rewrite even with corrupt lines
			// present.
			return { pruned: 0, remaining: input.total };
		}

		// BLK-12: global timestamp order, tie-broken by id.
		const surviving = input.kept.slice().sort(compareOldestFirst);
		const dir = path.dirname(resolved);
		const tmpPath = path.join(dir, `skill-usage-${Date.now()}.tmp`);
		const content = surviving.map((e) => JSON.stringify(e)).join('\n');

		// Coverage and durable counters are persisted BEFORE the rewrite, using the
		// same stage-save-adopt discipline as `migrateLegacyLog` (issue #2038 final
		// critic, C1 / residual R1).
		//
		// This update used to run AFTER the rewrite as best-effort. That ordering is
		// unsafe in a way that is easy to miss: the rewrite has already dropped
		// entries by then, so if the sidecar save throws, the stream has lost history
		// while the sidecar on disk still says `coverage.complete === true`. The
		// curator's retirement gate reads exactly that flag, so a falsely-complete
		// coverage LOWERS the retirement bar and lets a skill be retired on a
		// truncated denominator — the very hazard the gate exists to prevent, and the
		// inverse of the F1 failure mode. The old catch used `logger.log`, which is
		// debug-gated, so it was also invisible in production.
		//
		// Persisting first makes the failure fail-safe: a throw aborts before any
		// entry is dropped, so the stream and the sidecar stay consistent and the next
		// pass simply retries. The residual trade is the opposite, benign direction —
		// if the sidecar save succeeds and the rewrite below then fails, the counters
		// over-report a compaction that did not happen and `coverage.complete` is
		// false when the history is in fact intact. That only makes the curator MORE
		// conservative, never less, which is the correct direction to be wrong in.
		const stagedManifest = stagePendingDocument(doc);
		stagedManifest.counters.compacted += 1;
		stagedManifest.counters.dropped += dropped;
		stagedManifest.counters.skills_dropped += input.skillsDropped;
		stagedManifest.coverage.entriesDropped += dropped;
		stagedManifest.coverage.skillsDropped += input.skillsDropped;
		if (dropped > 0) stagedManifest.coverage.complete = false;
		stagedManifest.coverage.oldestRetained =
			surviving.length > 0 ? surviving[0].timestamp : null;
		stagedManifest.coverage.newestRetained =
			surviving.length > 0 ? surviving[surviving.length - 1].timestamp : null;

		try {
			savePendingDocument(directory, stagedManifest);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.criticalWarn(
				'[skill-usage-log] compaction manifest write failed; skipping the rewrite so no history is dropped without its coverage record:',
				msg,
			);
			return { pruned: 0, remaining: input.total, error: msg };
		}

		try {
			_internals.writeFileSync(
				tmpPath,
				surviving.length > 0 ? `${content}\n` : '',
				'utf-8',
			);
			_internals.renameSync(tmpPath, resolved);
		} catch (writeErr) {
			const msg =
				writeErr instanceof Error ? writeErr.message : String(writeErr);
			// Best-effort cleanup of temp file on failure
			try {
				if (_internals.existsSync(tmpPath)) {
					_internals.writeFileSync(tmpPath, '', 'utf-8');
				}
			} catch {
				// ignore cleanup failure
			}
			return { pruned: 0, remaining: input.total, error: msg };
		}

		// The rewrite succeeded, so the manifest staged and persisted above is now
		// the truth. Publish it into the caller's document. `corruptLines` was
		// folded into the LIFETIME `corrupt` counter before any return, because the
		// rewrite destroys the corrupt lines and a counter recomputed from the file
		// would reset to zero every pass.
		adoptStagedDocument(doc, stagedManifest);

		emitSkillUsageHealth(
			doc,
			'compaction',
			{
				bytes: content.length + (surviving.length > 0 ? 1 : 0),
				limitBytes: SKILL_USAGE_LIMITS.maxBytes,
			},
			directory,
		);

		return { pruned: dropped, remaining: surviving.length };
	} finally {
		releaseSkillUsageLock(handle);
	}
}

// ============================================================================
// Frontmatter parsing — source knowledge IDs
// ============================================================================

/**
 * Read a SKILL.md file and extract the `generated_from_knowledge` UUIDs
 * from its YAML frontmatter.
 *
 * Expected frontmatter shape:
 * ```yaml
 * ---
 * name: some-skill
 * generated_from_knowledge:
 *   - uuid-1
 *   - uuid-2
 * ---
 * ```
 *
 * Returns an empty array if the file doesn't exist, has no frontmatter,
 * or the `generated_from_knowledge` key is absent.
 */
export async function resolveSourceKnowledgeIds(
	directory: string,
	skillPath: string,
): Promise<string[]> {
	try {
		// Strip file: protocol prefix from skill path (e.g., "file:.opencode/skills/...")
		let cleanPath = skillPath;
		if (cleanPath.startsWith('file:')) {
			cleanPath = cleanPath.slice(5);
		}

		// Reject path traversal sequences
		if (/\.\.[/\\]/.test(cleanPath)) {
			return [];
		}

		// Resolve to absolute and validate containment under directory
		const absolute = path.normalize(
			path.isAbsolute(cleanPath)
				? cleanPath
				: path.resolve(directory, cleanPath),
		);
		const baseDir = path.normalize(path.resolve(directory));

		// Ensure the resolved path starts with the project directory
		const isContained =
			process.platform === 'win32'
				? absolute.toLowerCase().startsWith((baseDir + path.sep).toLowerCase())
				: absolute.startsWith(baseDir + path.sep);

		if (!isContained) {
			return [];
		}

		if (!_internals.existsSync(absolute)) {
			return [];
		}

		const content = _internals.readFileSync(absolute, 'utf-8') as string;
		return parseGeneratedFromKnowledge(content);
	} catch (err) {
		logger.log(
			'[skill-usage-log] resolveSourceKnowledgeIds failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
		return [];
	}
}

/**
 * Pure helper: parse `generated_from_knowledge:` YAML list from frontmatter.
 * Uses a minimal regex-based parser — the SKILL.md format is well-known and narrow.
 * Does NOT use a full YAML parser to avoid adding a dependency.
 */
function parseGeneratedFromKnowledge(content: string): string[] {
	// Match frontmatter block (between --- delimiters at start of file)
	const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
	if (!frontmatterMatch) return [];

	const body = frontmatterMatch[1];
	const ids: string[] = [];

	// Match UUID-style entries under generated_from_knowledge:
	// Supports both "  - uuid" and "  - uuid  # comment" formats
	const sectionRegex =
		/generated_from_knowledge\s*:\s*\n((?:\s+-\s+\S+[^\n]*\n?)+)/;
	const sectionMatch = body.match(sectionRegex);
	if (!sectionMatch) return [];

	const lines = sectionMatch[1].split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('-')) continue;
		// Extract the UUID — take the first token after "- "
		const parts = trimmed.slice(1).trim().split(/\s+/);
		if (parts.length > 0 && parts[0].length > 0) {
			ids.push(parts[0]);
		}
	}

	return ids;
}

// ============================================================================
// Feedback bridge — wire skill usage to knowledge confidence
// ============================================================================

/** Confidence boost applied per compliant skill usage cycle. */
const COMPLIANCE_BOOST = 0.05;

/** Confidence decay applied per violation cycle. */
const VIOLATION_DECAY = 0.1;

/** What a consumption cycle claimed under the lock. */
interface FeedbackClaim {
	records: SkillUsagePendingRecord[];
}

/**
 * Phase A — claim, under the lock.
 *
 * Returns `null` when the lock is unavailable: consumption is SKIPPED, never
 * forced (approved plan §9). The lock is released before the asynchronous
 * bump so that a concurrent enqueue is not blocked behind it; the claimed
 * records are persisted as `in_flight` first, so a crash during the bump
 * leaves them recoverable rather than lost.
 */
function claimFeedbackRecords(
	directory: string,
	sinceTimestamp?: string,
): FeedbackClaim | null {
	const handle = acquireSkillUsageLock(directory);
	if (!handle) return null;
	try {
		const { doc, quarantined } = loadPendingDocument(directory);
		ensureMigrated(directory, doc);

		const now = Date.now();
		const before = doc.records.length;
		const resolved = resolveStaleInFlight(doc, now);
		enforceQueueBounds(doc, now);

		const records = selectConsumableRecords(doc, sinceTimestamp).map(
			(record) => ({ ...record }),
		);
		const dirty =
			quarantined ||
			resolved > 0 ||
			doc.records.length !== before ||
			records.length > 0;

		if (records.length > 0) {
			markRecordsInFlight(
				doc,
				records.map((record) => record.id),
			);
		}
		if (dirty) {
			savePendingDocument(directory, doc);
		}
		return { records };
	} finally {
		releaseSkillUsageLock(handle);
	}
}

interface FeedbackCommit {
	noSourceIds: string[];
	deltaBearingIds: string[];
	applied: number;
	failed: boolean;
	attempted: boolean;
}

/**
 * FB-005: `commitFeedbackOutcomes` re-acquires the lock and reloads the doc,
 * then mutates by an id-set that was computed in Phase A/B, before the lock
 * was released and re-acquired. A concurrent write (budget eviction, age
 * expiry, or a whole-document quarantine) can make one of those ids vanish in
 * that gap, and `applyTerminalOutcome` / `retainWithRetry` / `dequeueRecords`
 * silently no-op on an id that is no longer present.
 *
 * For budget eviction and age expiry this loss is usually ALREADY counted at
 * its own mutation site (`pending_evicted`, `dropped`, `uncertain_expired`
 * in `enforceQueueBounds`) — reusing one of those counters here would
 * double-count the same event. Whole-document quarantine
 * (`loadPendingDocument`) is the one path that is NOT counted per-record: it
 * increments `corrupt` by 1 regardless of how many records were discarded, so
 * a vanish caused by quarantine would otherwise be invisible at record
 * granularity.
 *
 * Rather than guess the cause (which this function cannot observe), any
 * mutation that touches fewer ids than it was asked to is folded into
 * `bump_unrecoverable` — the existing "this record's feedback is permanently
 * lost" bucket (`SkillUsageTerminalOutcome`), which nothing else in this file
 * increments for a vanished id, so this adds no double-count risk. A new,
 * dedicated counter would be more precise, but every consumer of
 * `SKILL_USAGE_COUNTER_KEYS` (the telemetry payload builder, the registry's
 * `healthSignal` prose, the event-contract doc) would need the new key added,
 * for one accounting-mismatch path that is itself only reachable under real
 * concurrent contention — precision that does not currently pay for the
 * vocabulary churn. This reuses the closest existing terminal-loss bucket
 * instead and documents the blend here; revisit if this path needs its own
 * signal (e.g. because it starts firing often enough to be worth
 * distinguishing from genuine permanent loss).
 */
function recordFeedbackAccountingMismatch(
	doc: SkillUsagePendingDocument,
	expectedCount: number,
	touchedCount: number,
): void {
	const missing = expectedCount - touchedCount;
	if (missing > 0) {
		doc.counters.bump_unrecoverable += missing;
	}
}

/**
 * Phase C — commit, under a re-acquired lock.
 *
 * If the re-acquire fails the records stay `in_flight` on disk. A live
 * concurrent reader treats `in_flight` as not consumable, and a restart
 * resolves it to `uncertain` — which survives, stays visible, and is never
 * replayed. That satisfies both clauses of "survives ... and is consumed at
 * most once" (approved plan §9).
 */
function commitFeedbackOutcomes(
	directory: string,
	commit: FeedbackCommit,
): void {
	const handle = acquireSkillUsageLock(directory);
	if (!handle) {
		logger.log(
			'[skill-usage-log] feedback commit could not re-acquire the lock; records left in_flight',
		);
		return;
	}
	try {
		const { doc } = loadPendingDocument(directory);

		// R2: 109 of 141 skills carry no `generated_from_knowledge` frontmatter and
		// can never be acknowledged. Terminal-dequeue them so the exempt set drains
		// instead of growing without bound. Terminal outcomes never increment
		// `processed` / `bumps` — only `skill_usage_health` sees them.
		if (commit.noSourceIds.length > 0) {
			const removed = applyTerminalOutcome(
				doc,
				commit.noSourceIds,
				'no_source_knowledge',
			);
			recordFeedbackAccountingMismatch(doc, commit.noSourceIds.length, removed);
		}

		if (commit.attempted && commit.deltaBearingIds.length > 0) {
			if (commit.failed) {
				// Transient (lock contention / I/O): retain and retry, bounded.
				const { retried, unrecoverable } = retainWithRetry(
					doc,
					commit.deltaBearingIds,
				);
				recordFeedbackAccountingMismatch(
					doc,
					commit.deltaBearingIds.length,
					retried.length + unrecoverable.length,
				);
			} else if (commit.applied === 0) {
				// Permanent: the source knowledge ids no longer exist anywhere.
				doc.counters.bump_applied_zero += 1;
				const removed = applyTerminalOutcome(
					doc,
					commit.deltaBearingIds,
					'no_matching_knowledge',
				);
				recordFeedbackAccountingMismatch(
					doc,
					commit.deltaBearingIds.length,
					removed,
				);
			} else {
				// Success path: the confidence delta was already applied by
				// `bumpKnowledgeConfidenceBatchResult` before this function ran, so a
				// record missing here loses nothing new. Do NOT route this through
				// `recordFeedbackAccountingMismatch` (Stage-B review, PR #2347):
				// that function folds a mismatch into `bump_unrecoverable`, which
				// is documented and consumed as "this record's feedback is
				// permanently lost" — incrementing it here for an event that lost
				// nothing would make the health telemetry over-report genuine
				// permanent loss. Just dequeue; nothing is missing to account for.
				dequeueRecords(doc, commit.deltaBearingIds);
			}
		}

		enforceQueueBounds(doc);
		savePendingDocument(directory, doc);
		emitSkillUsageHealth(
			doc,
			'consumption',
			{
				bytes: queueByteSize(doc),
				limitBytes: SKILL_USAGE_LIMITS.queueMaxBytes,
			},
			directory,
		);
	} finally {
		releaseSkillUsageLock(handle);
	}
}

/**
 * Consume pending skill-usage feedback and apply confidence bumps/decays to
 * the originating knowledge entries.
 *
 * Reads the **authoritative sidecar queue**, never the JSONL stream: the
 * compliant/violated counts and the per-skill delta are computed from queue
 * records only, so an entry evicted from the operational stream can never flip
 * a pending record's delta sign (approved plan §2 corollary).
 *
 * For each unique skillPath with at least one queued actionable record:
 * 1. Resolve source knowledge UUIDs from the skill's SKILL.md frontmatter.
 * 2. Count compliant and violated records for that skill.
 * 3. Compute net delta: if compliant count > violation count → +0.05; else → -0.1.
 * 4. Call `bumpKnowledgeConfidenceBatchResult` with the aggregated deltas.
 * 5. Dequeue, retain-with-retry, or terminal-dequeue each record per §3.
 *
 * @param directory       - Project root directory.
 * @param options.sinceTimestamp - Optional ISO 8601 cutoff; only process records after this time.
 * @returns Count of processed skills and total confidence bumps/decays applied.
 */
export async function applySkillUsageFeedback(
	directory: string,
	options?: {
		sinceTimestamp?: string;
		/** G2: forwarded to bumpKnowledgeConfidenceBatchResult. */
		floorOptions?: ConfidenceFloorOptions;
	},
): Promise<{ processed: number; bumps: number }> {
	let processed = 0;
	let bumps = 0;

	try {
		// --- Phase A: claim under the lock -----------------------------------
		const claim = claimFeedbackRecords(directory, options?.sinceTimestamp);
		if (!claim || claim.records.length === 0) {
			return { processed: 0, bumps: 0 };
		}

		// --- Phase B: resolve + bump, lock released --------------------------
		const groups = new Map<string, SkillUsagePendingRecord[]>();
		for (const record of claim.records) {
			const list = groups.get(record.skillPath);
			if (list) list.push(record);
			else groups.set(record.skillPath, [record]);
		}

		const allDeltas: Array<{ id: string; delta: number }> = [];
		const deltaBearingIds: string[] = [];
		const noSourceIds: string[] = [];

		for (const [skillPath, records] of Array.from(groups)) {
			let compliantCount = 0;
			let violationCount = 0;

			for (const record of records) {
				if (record.verdict === 'compliant') compliantCount++;
				else violationCount++;
			}

			if (compliantCount === 0 && violationCount === 0) continue;

			const delta =
				compliantCount > violationCount ? COMPLIANCE_BOOST : -VIOLATION_DECAY;

			// Resolve source knowledge IDs from the skill's SKILL.md
			const sourceIds = await resolveSourceKnowledgeIds(directory, skillPath);
			if (sourceIds.length === 0) {
				noSourceIds.push(...records.map((record) => record.id));
				continue;
			}

			for (const id of sourceIds) {
				allDeltas.push({ id, delta });
			}
			deltaBearingIds.push(...records.map((record) => record.id));

			processed++;
			bumps += sourceIds.length;
		}

		// Aggregate deltas by knowledge ID to prevent unbounded stacking
		// when the same knowledge ID appears in multiple skills' lists
		const aggregated = new Map<string, number>();
		for (const { id, delta } of allDeltas) {
			aggregated.set(id, (aggregated.get(id) ?? 0) + delta);
		}
		// Clamp each net delta to allowed per-cycle bounds [+0.05, -0.1]
		const clampedDeltas = Array.from(aggregated.entries()).map(
			([id, netDelta]) => ({
				id,
				delta: Math.max(-VIOLATION_DECAY, Math.min(COMPLIANCE_BOOST, netDelta)),
			}),
		);

		let applied = 0;
		let failed = false;
		const attempted = clampedDeltas.length > 0;
		if (attempted) {
			const result = await _internals.bumpKnowledgeConfidenceBatchResult(
				directory,
				clampedDeltas,
				options?.floorOptions,
			);
			applied = result.applied;
			failed = result.failed;
		}

		// --- Phase C: commit under a re-acquired lock ------------------------
		commitFeedbackOutcomes(directory, {
			noSourceIds,
			deltaBearingIds,
			applied,
			failed,
			attempted,
		});
	} catch (err) {
		logger.log(
			'[skill-usage-log] applySkillUsageFeedback failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
	}

	return { processed, bumps };
}

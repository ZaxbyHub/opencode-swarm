/**
 * Skill usage log — tracks skill delegations and compliance outcomes.
 *
 * Writes one JSONL line per skill-usage event to `.swarm/skill-usage.jsonl`.
 *
 * ISSUE #2038 (Observability PR 10/23): this store previously had NO hard
 * global ceiling — pruning was per-skill only (500 entries/skillPath),
 * `feedback_applied` marker lines were preserved unconditionally forever,
 * nothing evicted by age, and production readers parsed the whole file. It is
 * now a BOUNDED single-file store (the #2037 `src/context-map/telemetry.ts`
 * pattern):
 *
 *   Line 1:  `skill-usage-manifest` header (schemaVersion 1) carrying folded
 *            maintenance-lifetime counters (entries compacted / aged / corrupt,
 *            marker IDs pruned, pressure state, retained count).
 *   Line 2+: raw `SkillUsageEntry` JSONL + `feedback_applied` marker lines —
 *            the retained window, bounded by SKILL_USAGE_LIMITS
 *            (activeMaxBytes / activeMaxEntries / ageMaxMs, with the per-skill
 *            cap as a policy INSIDE the global ceiling).
 *
 * Marker lifecycle (issue #2038 requirement 2): entries with an actionable
 * verdict (`compliant`/`violated`) whose id is not yet covered by any
 * `feedback_applied.processedEntryIds` are CORRECTNESS-RELEVANT and survive
 * every compaction until consumed; everything else (not_checked/other verdicts,
 * processed actionable entries, malformed lines) is operational and follows the
 * bounded retention rule. Marker lines are rebuilt keeping only IDs that
 * reference SURVIVING entries, so markers age out with their entries and can
 * never reintroduce unbounded growth. `not_checked` entries can never be
 * correctness-class: `applySkillUsageFeedback` only processes compliant/
 * violated entries, so they are never acknowledged and would otherwise be
 * retained forever.
 *
 * Pressure (issue #2038 requirement 5): when the correctness class alone would
 * exceed the global envelope, compaction keeps every correctness entry, marks
 * `pressure: true` in the manifest, emits `skill_usage_health`, and the append
 * path stops OPTIONAL writes — operational-class appends are rejected with a
 * typed error (writer call sites already catch+warn, so skill injection fails
 * open) while correctness-class appends still land. Pressure clears at the next
 * maintenance pass that fits.
 *
 * Concurrency: mutations are guarded by an exclusive `.swarm/skill-usage.lock`
 * (`wx` create, stale-broken after 5 min). `appendSkillUsageEntry` appends
 * under the lock (a rename racing an append could silently discard the write);
 * `pruneSkillUsageLog` compacts under the lock; `applySkillUsageFeedback` runs
 * its whole read→bump→marker cycle under the async lock variant so concurrent
 * phase-completions cannot double-apply confidence. Locked entry points never
 * call other locked entry points — internal work uses the unlocked compaction.
 *
 * Readers are byte-bounded (`readMaxBytes` tail read) regardless of file size;
 * `getSkillUsageCoverage` discloses whether a read was complete. Because
 * filters are applied client-side after the bounded read, a file-level
 * 'complete' read means every filtered subset is complete. Reads return entries
 * in append order (stable/deterministic); consumers needing recency sort.
 *
 * All disk failures are fail-open for skill injection: `appendSkillUsageEntry`
 * throws typed errors that every writer call site catches and warns through.
 *
 * State lives exclusively under `.swarm/` (Invariant 4). No `process.cwd()`.
 * No `bun:` imports (Invariant 2). Synchronous I/O except the feedback bridge,
 * which awaits `bumpKnowledgeConfidenceBatch`.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { telemetry } from '../telemetry.js';
import { warn } from '../utils/logger.js';
import type { ConfidenceFloorOptions } from './knowledge-store.js';
import { bumpKnowledgeConfidenceBatch } from './knowledge-store.js';
import { validateSwarmPath } from './utils.js';

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
	/** Error message when the write/rename step fails; absent on success. */
	error?: string;
}

// ============================================================================
// Hard limits (issue #2038). Exported so tests can override small budgets via
// `_internals.limits` and restore in `afterEach`. Ceilings are documented
// constants, not user config keys (retention-registry precedent, #2036/#2037).
// ============================================================================

export interface SkillUsageLimits {
	/** Maintenance trigger on the append path (bytes). */
	compactTriggerBytes: number;
	/** HARD global ceiling on the retained window — entries + markers + manifest. */
	activeMaxBytes: number;
	/** HARD global ceiling on retained entries (all skills combined). */
	activeMaxEntries: number;
	/** Operational entry retention horizon. Correctness-class entries are exempt. */
	ageMaxMs: number;
	/** Hard documented read bound: no reader parses more than this, regardless
	 *  of file size. Must satisfy readMaxBytes >= activeMaxBytes + headerMaxBytes + 1 KiB. */
	readMaxBytes: number;
	/** Per-skill selection policy INSIDE the global ceilings. */
	maxEntriesPerSkill: number;
	/** Append-path maintenance migrates legacy (header-less) files up to this
	 *  size; larger legacy files defer migration to the phase-boundary path. */
	legacyCompactMaxBytes: number;
	/** Disk-pressure/failure warning cooldown. */
	warnCooldownMs: number;
	/** Upper bound for a serialized manifest header (single line). */
	headerMaxBytes: number;
	/** Appends between throttled maintenance checks (mirrors #2037's
	 *  checkInterval: amortizes compaction rewrites — one rewrite per
	 *  checkInterval appends in a saturated steady state, not one per
	 *  append). The atomic rollover allowance is bounded by checkInterval
	 *  entries plus one in-flight append. */
	checkInterval: number;
}

export const SKILL_USAGE_LIMITS: SkillUsageLimits = {
	compactTriggerBytes: 768 * 1024,
	activeMaxBytes: 1024 * 1024,
	activeMaxEntries: 5_000,
	ageMaxMs: 90 * 24 * 60 * 60 * 1000,
	readMaxBytes: 2 * 1024 * 1024,
	maxEntriesPerSkill: 500,
	legacyCompactMaxBytes: 8 * 1024 * 1024,
	warnCooldownMs: 60_000,
	headerMaxBytes: 8 * 1024,
	checkInterval: 20,
};

/** Default maximum bytes to read from the end of the log file. */
export const TAIL_BYTES_DEFAULT = 64 * 1024; // 64 KB — covers ~500 entries
export const MAX_TAIL_BYTES = TAIL_BYTES_DEFAULT;

// ============================================================================
// Manifest (header) shape — issue #2038
// ============================================================================

const MANIFEST_TYPE = 'skill-usage-manifest';
const MANIFEST_SCHEMA = 1;

/** Maintenance-lifetime counters persisted in the manifest header. They fold
 *  prior manifest values on every compaction. Drops that occurred before the
 *  first compaction of a legacy file are unknowable; the stream is
 *  registry-classified derived-rebuildable, so these are health counters, not
 *  data. */
interface SkillUsageManifest {
	v: 1;
	type: 'skill-usage-manifest';
	schemaVersion: 1;
	compactedTotal: number;
	droppedAgeTotal: number;
	corruptTotal: number;
	markerIdsPrunedTotal: number;
	droppedUnderPressureTotal: number;
	pressure: boolean;
	retainedCount: number;
	updatedAt: string;
}

function emptyManifest(): SkillUsageManifest {
	return {
		v: 1,
		type: MANIFEST_TYPE,
		schemaVersion: MANIFEST_SCHEMA,
		compactedTotal: 0,
		droppedAgeTotal: 0,
		corruptTotal: 0,
		markerIdsPrunedTotal: 0,
		droppedUnderPressureTotal: 0,
		pressure: false,
		retainedCount: 0,
		updatedAt: new Date().toISOString(),
	};
}

/** Header detection rule (issue #2038, mirrors #2037): "header present" iff
 *  line 1 parses to a JSON object with `type === 'skill-usage-manifest'`,
 *  `v === 1` and `schemaVersion === 1`. Neither a `SkillUsageEntry` (no
 *  `type` field) nor a `feedback_applied` marker can satisfy this. Defensive
 *  counter coercion so a hand-edited header can never produce NaN. */
function parseManifestLine(line: string): SkillUsageManifest | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const obj: unknown = JSON.parse(trimmed);
		if (typeof obj !== 'object' || obj === null) return null;
		const rec = obj as Record<string, unknown>;
		if (
			rec.type !== MANIFEST_TYPE ||
			rec.v !== 1 ||
			rec.schemaVersion !== MANIFEST_SCHEMA
		) {
			return null;
		}
		const num = (v: unknown): number =>
			typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
		const manifest = emptyManifest();
		manifest.compactedTotal = num(rec.compactedTotal);
		manifest.droppedAgeTotal = num(rec.droppedAgeTotal);
		manifest.corruptTotal = num(rec.corruptTotal);
		manifest.markerIdsPrunedTotal = num(rec.markerIdsPrunedTotal);
		manifest.droppedUnderPressureTotal = num(rec.droppedUnderPressureTotal);
		manifest.pressure = rec.pressure === true;
		manifest.retainedCount = num(rec.retainedCount);
		manifest.updatedAt =
			typeof rec.updatedAt === 'string'
				? rec.updatedAt
				: new Date().toISOString();
		return manifest;
	} catch {
		return null;
	}
}

// ============================================================================
// Coverage disclosure — issue #2038 requirement 4
// ============================================================================

export type SkillUsageCoverage = 'complete' | 'truncated' | 'empty';

export interface SkillUsageCoverageInfo {
	/** 'complete' = whole on-disk file was read (every filtered subset is then
	 *  complete — filters run client-side post-read); 'truncated' = on-disk
	 *  bytes exceeded readMaxBytes (unmigrated legacy tail or pressure state);
	 *  'empty' = file missing or zero parsed entries on disk. Filter
	 *  non-matches are NOT 'empty'. */
	coverage: SkillUsageCoverage;
	onDiskBytes: number;
	retainedEntries: number;
	readMaxBytes: number;
}

// ============================================================================
// Path resolvers
// ============================================================================

/** Resolve the absolute path to `.swarm/skill-usage.jsonl`, with swarm-path validation. */
function resolveLogPath(directory: string): string {
	return validateSwarmPath(directory, 'skill-usage.jsonl');
}

function lockPathFor(directory: string): string {
	return validateSwarmPath(directory, 'skill-usage.lock');
}

function tmpPathFor(directory: string): string {
	// PID-scoped so concurrent processes never collide on one temp name
	// (registered grammar `target-constant-tmp` in src/utils/atomic-write.ts).
	return path.join(
		path.dirname(resolveLogPath(directory)),
		`.skill-usage.jsonl.${process.pid}.tmp`,
	);
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

function isActionableVerdict(verdict: string): boolean {
	return verdict === 'compliant' || verdict === 'violated';
}

// ============================================================================
// DI seam
// ============================================================================

/**
 * Test-only dependency-injection seam. Tests override these without
 * `mock.module` (which leaks across files in Bun's shared test-runner).
 * Restore in `afterEach`. `limits` and `emitHealth` mirror the #2037
 * telemetry seam so tests can exercise small budgets and capture health
 * emissions; `withSkillUsageLock` is exposed for the lock regression tests
 * (production callers use the module-local binding).
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
	limits: SKILL_USAGE_LIMITS,
	emitHealth: emitSkillUsageHealth,
	withSkillUsageLock,
	withSkillUsageLockAsync,
	pruneSkillUsageLog,
	resolveSourceKnowledgeIds,
	applySkillUsageFeedback,
	parseGeneratedFromKnowledge,
	computeComplianceByVersion,
	normalizeComplianceVerdict,
	appendFeedbackAppliedMarker,
};

// ============================================================================
// Maintenance state (module-scoped, bounded — invariant 8)
// ============================================================================

const MAX_TRACKED_PRESSURE_DIRS = 32;
const _pressureDropsByDirectory = new Map<string, number>();
let _lastWarnAt = 0;
let _appendCount = 0;

/** Test seam (AGENTS.md invariant 7): resets module-scoped maintenance state
 *  so an unswept run in Bun's shared test-runner process cannot shift a later
 *  test's cooldown behavior. Restore is one call in `afterEach`. */
export function _resetMaintenanceState(): void {
	_pressureDropsByDirectory.clear();
	_lastWarnAt = 0;
	_appendCount = 0;
}

function shouldRunMaintenance(): boolean {
	_appendCount += 1;
	if (_appendCount >= _internals.limits.checkInterval) {
		_appendCount = 0;
		return true;
	}
	return false;
}

function recordPressureDrop(directory: string): void {
	if (_pressureDropsByDirectory.size >= MAX_TRACKED_PRESSURE_DIRS) {
		const oldest = _pressureDropsByDirectory.keys().next().value;
		if (oldest !== undefined) _pressureDropsByDirectory.delete(oldest);
	}
	_pressureDropsByDirectory.set(
		directory,
		(_pressureDropsByDirectory.get(directory) ?? 0) + 1,
	);
}

function takePressureDrops(directory: string): number {
	const n = _pressureDropsByDirectory.get(directory) ?? 0;
	_pressureDropsByDirectory.delete(directory);
	return n;
}

function warnThrottled(message: string): void {
	const now = Date.now();
	if (now - _lastWarnAt < _internals.limits.warnCooldownMs) return;
	_lastWarnAt = now;
	// Debug-gated logger (AGENTS.md invariant 10: no chat-visible noise).
	warn(`skill-usage: ${message}`);
}

// ============================================================================
// Entry parsing
// ============================================================================

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

// ============================================================================
// Bounded read helpers (issue #2038 requirement 4)
// ============================================================================

/**
 * O(1) maintenance predicate for the append path (issue #2038): with the file
 * already past the soft trigger, compaction is only needed when a HARD budget
 * is breached, the store is legacy (header-less), or pressure is flagged.
 * Reading the manifest header is a bounded headerMaxBytes read.
 */
function maintenanceDue(directory: string, size: number): boolean {
	if (size > _internals.limits.activeMaxBytes) return true;
	let header: SkillUsageManifest | null = null;
	try {
		header = readManifestHeader(directory);
	} catch {
		header = null;
	}
	return (
		header === null ||
		header.pressure ||
		header.retainedCount > _internals.limits.activeMaxEntries
	);
}

function fileSizeOrZero(filePath: string): number {
	try {
		if (!_internals.existsSync(filePath)) return 0;
		return _internals.statSync(filePath).size;
	} catch {
		return 0;
	}
}

/**
 * Read at most `maxBytes` from the END of a file. Skips the (potentially
 * partial) first line when the read starts mid-file. Fail-open: returns empty
 * text on I/O error (parsers then see zero entries, matching the historical
 * read-error behavior of `readSkillUsageEntries`).
 */
function readBoundedTail(
	filePath: string,
	maxBytes: number,
): { text: string; truncated: boolean; failed: boolean } {
	try {
		if (!_internals.existsSync(filePath)) {
			return { text: '', truncated: false, failed: false };
		}
		const size = _internals.statSync(filePath).size;
		const truncated = size > maxBytes;
		const start = Math.max(0, size - maxBytes);
		const len = size - start;
		if (len === 0) return { text: '', truncated, failed: false };
		const fd = _internals.openSync(filePath, 'r');
		try {
			const buf = Buffer.alloc(len);
			let read = 0;
			while (read < len) {
				const n = _internals.readSync(fd, buf, read, len - read, start + read);
				if (n <= 0) break;
				read += n;
			}
			const content = buf.toString('utf-8', 0, read);
			if (start > 0) {
				const firstNewline = content.indexOf('\n');
				return {
					text: firstNewline >= 0 ? content.slice(firstNewline + 1) : '',
					truncated,
					failed: false,
				};
			}
			return { text: content, truncated, failed: false };
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		warnThrottled('bounded read failed (transient I/O)');
		// `failed` preserves the uncertainty contract (issue #2038): a read
		// error on a non-empty file must disclose as partial coverage, never
		// as a confident "no history".
		return { text: '', truncated: false, failed: true };
	}
}

/** Read and parse the manifest header (line 1) if present — bounded to
 *  headerMaxBytes. Returns null when the file is missing, unreadable, or
 *  legacy (header-less). */
function readManifestHeader(directory: string): SkillUsageManifest | null {
	const resolved = resolveLogPath(directory);
	try {
		if (!_internals.existsSync(resolved)) return null;
		const fd = _internals.openSync(resolved, 'r');
		try {
			const buf = Buffer.alloc(_internals.limits.headerMaxBytes);
			const n = _internals.readSync(fd, buf, 0, buf.length, 0);
			const text = buf.toString('utf-8', 0, n);
			const firstNewline = text.indexOf('\n');
			const line = firstNewline >= 0 ? text.slice(0, firstNewline) : text;
			return parseManifestLine(line);
		} finally {
			_internals.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/**
 * True when the file's final byte is a newline (or the file is empty /
 * unreadable — fail-open true). Guards the append path against appending onto
 * a crash-torn final line (#2037 review F-4 pattern): without it, a mid-append
 * crash leaves an unterminated line and the NEXT append silently merges into
 * it, losing one record.
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

interface SkillUsageStoreView {
	manifest: SkillUsageManifest | null;
	entries: SkillUsageEntry[];
	markers: SkillFeedbackAppliedMarker[];
	corruptLines: number;
	truncated: boolean;
	/** True when the bounded read hit an I/O error — the view is a guess, and
	 *  coverage must disclose it (issue #2038 uncertainty contract). */
	readFailed: boolean;
}

/**
 * Parse the store. `bounded` reads at most readMaxBytes from the end (the
 * production read contract — issue #2038 requirement 4); the unbounded
 * variant is the MAINTENANCE-path read (compaction / feedback), identical in
 * cost to the pre-#2038 prune and bounded by the retention envelope in steady
 * state (a legacy tail is migrated once, then never exceeds it).
 */
function readSkillUsageStore(
	directory: string,
	bounded: boolean,
): SkillUsageStoreView {
	const resolved = resolveLogPath(directory);
	let text: string;
	let truncated = false;
	let readFailed = false;
	if (bounded) {
		const chunk = readBoundedTail(resolved, _internals.limits.readMaxBytes);
		text = chunk.text;
		truncated = chunk.truncated;
		readFailed = chunk.failed;
	} else {
		if (!_internals.existsSync(resolved)) {
			return {
				manifest: null,
				entries: [],
				markers: [],
				corruptLines: 0,
				truncated: false,
				readFailed: false,
			};
		}
		try {
			text = _internals.readFileSync(resolved, 'utf-8');
		} catch {
			return {
				manifest: null,
				entries: [],
				markers: [],
				corruptLines: 0,
				truncated: false,
				readFailed: true,
			};
		}
	}

	const lines = text.split('\n');
	const entries: SkillUsageEntry[] = [];
	const markers: SkillFeedbackAppliedMarker[] = [];
	let corruptLines = 0;
	let manifest: SkillUsageManifest | null = null;
	let sawFirstLine = false;

	for (const line of lines) {
		if (line.trim() === '') continue;
		if (!sawFirstLine) {
			sawFirstLine = true;
			// The manifest can only be the physical first line of the file; a
			// truncated tail read starts mid-file and never sees it.
			if (!truncated) {
				manifest = parseManifestLine(line);
				if (manifest) continue;
			}
		}
		try {
			const parsed: unknown = JSON.parse(line);
			const marker = parseFeedbackMarker(parsed);
			if (marker) {
				markers.push(marker);
				continue;
			}
			const entry = parseSkillUsageEntry(parsed);
			if (entry) {
				entries.push(entry);
				continue;
			}
			// Valid JSON but unrecognized shape — counted, never folded into data.
			corruptLines += 1;
		} catch {
			// Torn/partial line (bounded-read boundary or crash) — disclosed via
			// the corrupt counter, never folded into data.
			corruptLines += 1;
		}
	}
	return { manifest, entries, markers, corruptLines, truncated, readFailed };
}

// ============================================================================
// Lock — guards all mutations against a second process (issue #2038 req 3)
// ============================================================================

const LOCK_STALE_MS = 5 * 60_000;

function acquireSkillUsageLock(directory: string): boolean {
	const lockPath = lockPathFor(directory);
	// NOTE (accepted hazard, mirrors src/parallel/file-locks.ts mtime idiom):
	// the stale-break carries no owner identity, so a legitimate holder that
	// runs past LOCK_STALE_MS (pathological I/O inside the async feedback
	// section) can have its lock unlinked and its later release then removes
	// the USURPER's lock, briefly admitting a third writer. Bounded by the
	// 5-minute window and the single-writer reality of this store.
	try {
		_internals.mkdirSync(path.dirname(lockPath), { recursive: true });
		const fd = _internals.openSync(lockPath, 'wx');
		_internals.closeSync(fd);
		return true;
	} catch {
		// Lock held (EEXIST) — stale-break if ancient.
		try {
			const age = Date.now() - _internals.statSync(lockPath).mtimeMs;
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
			/* fallthrough */
		}
		return false;
	}
}

function releaseSkillUsageLock(directory: string): void {
	try {
		_internals.unlinkSync(lockPathFor(directory));
	} catch {
		/* ignore */
	}
}

/** Sync critical section. Returns null (fn NOT run) when the lock is busy. */
function withSkillUsageLock<T>(directory: string, fn: () => T): T | null {
	if (!acquireSkillUsageLock(directory)) return null;
	try {
		return fn();
	} finally {
		releaseSkillUsageLock(directory);
	}
}

/**
 * Async critical section (the feedback bridge awaits `bumpKnowledgeConfidenceBatch`).
 * Acquisition is synchronous and atomic within one event-loop turn, so both
 * cross-process AND same-process concurrent callers serialize; the body's
 * awaits happen while the on-disk lock is held. Returns null when busy.
 */
async function withSkillUsageLockAsync<T>(
	directory: string,
	fn: () => Promise<T>,
): Promise<T | null> {
	if (!acquireSkillUsageLock(directory)) return null;
	try {
		return await fn();
	} finally {
		releaseSkillUsageLock(directory);
	}
}

// ============================================================================
// Atomic publish (tmp + rename with bounded Windows retry — #2035 pattern)
// ============================================================================

const RENAME_RETRY_DELAYS_MS = [25, 50, 100] as const;

/** Portable synchronous sleep (src/utils/atomic-write.ts syncSleep precedent). */
function syncSleep(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const start = Date.now();
		while (Date.now() - start < ms) {
			/* bounded busy-wait fallback */
		}
	}
}

function renameWithRetry(tempPath: string, targetPath: string): void {
	let lastError: unknown;
	for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
		try {
			_internals.renameSync(tempPath, targetPath);
			return;
		} catch (err) {
			lastError = err;
			if (attempt < RENAME_RETRY_DELAYS_MS.length) {
				syncSleep(RENAME_RETRY_DELAYS_MS[attempt]);
			}
		}
	}
	throw lastError;
}

/**
 * Atomically replace the canonical file with a new text payload (write tmp +
 * rename). The original error propagates unchanged so callers (and pinned
 * tests) see the underlying fs failure message. Best-effort stale-tmp cleanup.
 */
function atomicReplaceSkillUsage(directory: string, content: string): void {
	const finalPath = resolveLogPath(directory);
	const tmpPath = tmpPathFor(directory);
	try {
		if (_internals.existsSync(tmpPath)) {
			try {
				_internals.unlinkSync(tmpPath);
			} catch {
				/* ignore */
			}
		}
		_internals.writeFileSync(tmpPath, content, 'utf-8');
		renameWithRetry(tmpPath, finalPath);
	} catch (err) {
		try {
			if (_internals.existsSync(tmpPath)) {
				_internals.unlinkSync(tmpPath);
			}
		} catch {
			/* ignore */
		}
		throw err;
	}
}

// ============================================================================
// Health emission (issue #2038 requirement 6 — counts only, bounded cardinality)
// ============================================================================

export type SkillUsageHealthTrigger =
	| 'append'
	| 'phase-boundary'
	| 'feedback'
	| 'deferred';

function emitSkillUsageHealth(
	_directory: string,
	payload: {
		trigger: SkillUsageHealthTrigger;
		acceptedCount: number;
		compactedCount: number;
		retainedCount: number;
		droppedAgeCount: number;
		corruptTotal: number;
		preservedMarkerCount: number;
		droppedMarkerIdsCount: number;
		droppedUnderPressureTotal: number;
		pressureCount: number;
		bytes: number;
		limitBytes: number;
	},
): void {
	try {
		telemetry.skillUsageHealth({
			trigger: payload.trigger,
			acceptedCount: payload.acceptedCount,
			compactedCount: payload.compactedCount,
			retainedCount: payload.retainedCount,
			droppedAgeCount: payload.droppedAgeCount,
			corruptTotal: payload.corruptTotal,
			preservedMarkerCount: payload.preservedMarkerCount,
			droppedMarkerIdsCount: payload.droppedMarkerIdsCount,
			droppedUnderPressureTotal: payload.droppedUnderPressureTotal,
			pressureCount: payload.pressureCount,
			bytes: payload.bytes,
			limitBytes: payload.limitBytes,
		});
	} catch {
		// Health telemetry must never break the store.
	}
}

// ============================================================================
// Compaction (maintenance — issue #2038 requirements 1, 2, 3, 5, 6)
// ============================================================================

const PRESSURE_REJECTION_MESSAGE =
	'skill-usage store under pressure — operational entry rejected (unprocessed feedback backlog exceeds the retention envelope)';

function stableNewestFirst(entries: SkillUsageEntry[]): SkillUsageEntry[] {
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			if (b.entry.timestamp > a.entry.timestamp) return 1;
			if (b.entry.timestamp < a.entry.timestamp) return -1;
			return b.index - a.index;
		})
		.map(({ entry }) => entry);
}

/**
 * Bounded compaction — the UNLOCKED core. Callers: the public locked
 * `pruneSkillUsageLog`, the append path's pre-append maintenance (outside its
 * own lock), and the feedback pass (inside its lock). Never call this while
 * holding the lock through a locked wrapper — use this directly.
 *
 * Policy (in order, OPERATIONAL entries only — the correctness class is
 * exempt from every budget): age → per-skill cap → global count → global
 * bytes. Survivors keep their original line order; markers are rebuilt to
 * reference only surviving entries. Crash-atomic single-file publish.
 */
function compactSkillUsageStoreUnlocked(
	directory: string,
	maxEntriesPerSkill: number,
	trigger: SkillUsageHealthTrigger,
): PruneResult {
	const resolved = resolveLogPath(directory);

	if (!_internals.existsSync(resolved)) {
		return { pruned: 0, remaining: 0 };
	}

	const size = fileSizeOrZero(resolved);
	// Legacy = header-less (pre-#2038) file. Hook-path maintenance defers
	// migrating an oversized legacy file to the phase-boundary path (issue
	// #2038: delegation latency must not pay the one-time full-parse of a huge
	// pre-#2038 tail).
	const legacy = size > 0 && readManifestHeader(directory) === null;
	if (
		legacy &&
		size > _internals.limits.legacyCompactMaxBytes &&
		trigger === 'append'
	) {
		_internals.emitHealth(directory, {
			trigger: 'deferred',
			acceptedCount: 0,
			compactedCount: 0,
			retainedCount: 0,
			droppedAgeCount: 0,
			corruptTotal: 0,
			preservedMarkerCount: 0,
			droppedMarkerIdsCount: 0,
			droppedUnderPressureTotal: 0,
			pressureCount: 0,
			bytes: size,
			limitBytes: _internals.limits.activeMaxBytes,
		});
		return { pruned: 0, remaining: 0 };
	}

	const view = readSkillUsageStore(directory, false);
	const prior = view.manifest ? view.manifest : null;

	const processedIds = new Set<string>();
	for (const marker of view.markers) {
		for (const id of marker.processedEntryIds) processedIds.add(id);
	}

	// Marker lifecycle classification (issue #2038 requirement 2).
	const correctness: SkillUsageEntry[] = [];
	const operational: SkillUsageEntry[] = [];
	for (const entry of view.entries) {
		if (
			isActionableVerdict(entry.complianceVerdict) &&
			!processedIds.has(entry.id)
		) {
			correctness.push(entry);
		} else {
			operational.push(entry);
		}
	}

	const now = Date.now();
	const dropped = new Set<SkillUsageEntry>();
	let droppedAge = 0;

	// 1. Age (operational only; unparseable/future timestamps are kept — the
	// safe direction under clock skew — and still bounded by count/bytes).
	const ageKept: SkillUsageEntry[] = [];
	for (const entry of operational) {
		const ts = Date.parse(entry.timestamp);
		if (!Number.isNaN(ts) && now - ts > _internals.limits.ageMaxMs) {
			dropped.add(entry);
			droppedAge += 1;
		} else {
			ageKept.push(entry);
		}
	}

	// 2. Per-skill cap (operational only — newest kept per skillPath).
	const bySkill = new Map<string, SkillUsageEntry[]>();
	for (const entry of ageKept) {
		const list = bySkill.get(entry.skillPath);
		if (list) list.push(entry);
		else bySkill.set(entry.skillPath, [entry]);
	}
	const perSkillKept: SkillUsageEntry[] = [];
	bySkill.forEach((skillEntries) => {
		if (skillEntries.length <= maxEntriesPerSkill) {
			perSkillKept.push(...skillEntries);
			return;
		}
		const kept = new Set(
			stableNewestFirst(skillEntries).slice(0, maxEntriesPerSkill),
		);
		for (const entry of skillEntries) {
			if (kept.has(entry)) perSkillKept.push(entry);
			else dropped.add(entry);
		}
	});

	// 3-4. Global count + bytes with an exact compose-verify loop: keep the
	// newest operational entries within the count budget, then drop the oldest
	// kept operational entry while the COMPOSED file (manifest + survivors +
	// rebuilt markers) exceeds the byte budget. Reserving the exact manifest
	// and marker bytes keeps the pressure flag strictly for the case the
	// issue defines — the correctness class ALONE above the envelope — instead
	// of tripping on a merely-full budget.
	const correctnessSet = new Set(correctness);
	const countBudget = Math.max(
		0,
		_internals.limits.activeMaxEntries - correctness.length,
	);
	const countDropped = new Set<SkillUsageEntry>();
	const keepSet = new Set<SkillUsageEntry>(
		stableNewestFirst(perSkillKept).slice(0, countBudget),
	);
	for (const entry of perSkillKept) {
		if (!keepSet.has(entry)) countDropped.add(entry);
	}
	for (const entry of countDropped) dropped.add(entry);

	const pressureDrops = takePressureDrops(directory);
	const baseManifest: SkillUsageManifest = prior
		? { ...prior }
		: emptyManifest();

	/** Rebuild markers against a survivor set (at-most-once contract). */
	const rebuildMarkers = (survivorIds: Set<string>) => {
		const rebuilt: SkillFeedbackAppliedMarker[] = [];
		const emitted = new Set<string>();
		let pruned = 0;
		for (const marker of view.markers) {
			const keptIds: string[] = [];
			for (const id of marker.processedEntryIds) {
				if (survivorIds.has(id) && !emitted.has(id)) {
					keptIds.push(id);
					emitted.add(id);
				} else {
					// Dead reference or duplicate marker ID (issue edge case) —
					// union-dedup keeps the ID exactly once across markers.
					pruned += 1;
				}
			}
			if (keptIds.length > 0) {
				rebuilt.push({
					type: 'feedback_applied',
					timestamp: marker.timestamp,
					processedEntryIds: keptIds,
				});
			}
		}
		return { rebuilt, pruned };
	};

	/**
	 * EXACT compose-verify loop (issue #2038, review R2): each iteration
	 * composes the complete final file — manifest with counters folded from
	 * the base + the CURRENT drop set (idempotent: always recomputed from
	 * `prior`, never accumulated in place) plus survivors plus rebuilt
	 * markers — and drops the oldest kept operational entry while the exact
	 * byte length exceeds the envelope. No byte estimation: the pressure flag
	 * can therefore only mean what the issue defines — the correctness class
	 * ALONE above the envelope.
	 */
	let finalContent = '';
	let survivors: SkillUsageEntry[] = [];
	let rebuiltMarkers: SkillFeedbackAppliedMarker[] = [];
	let markerIdsPrunedNow = 0;
	let manifest: SkillUsageManifest = { ...baseManifest };
	for (;;) {
		survivors = view.entries.filter(
			(entry) => correctnessSet.has(entry) || keepSet.has(entry),
		);
		const survivorIds = new Set(survivors.map((e) => e.id));
		const rebuilt = rebuildMarkers(survivorIds);
		const budgetDropped = Math.max(0, dropped.size - droppedAge);
		manifest = {
			...baseManifest,
			compactedTotal: baseManifest.compactedTotal + budgetDropped,
			droppedAgeTotal: baseManifest.droppedAgeTotal + droppedAge,
			corruptTotal: baseManifest.corruptTotal + view.corruptLines,
			markerIdsPrunedTotal: baseManifest.markerIdsPrunedTotal + rebuilt.pruned,
			droppedUnderPressureTotal:
				baseManifest.droppedUnderPressureTotal + pressureDrops,
			retainedCount: survivors.length,
			updatedAt: new Date().toISOString(),
			// Reset each compose: the flag is re-measured after the loop — a
			// stale true from a prior pass must never persist into a fitting
			// store (pressure-clear regression pins this).
			pressure: false,
		};
		finalContent = `${JSON.stringify(manifest)}\n`;
		for (const entry of survivors) finalContent += `${JSON.stringify(entry)}\n`;
		for (const marker of rebuilt.rebuilt)
			finalContent += `${JSON.stringify(marker)}\n`;
		if (
			Buffer.byteLength(finalContent) <= _internals.limits.activeMaxBytes ||
			keepSet.size === 0
		) {
			rebuiltMarkers = rebuilt.rebuilt;
			markerIdsPrunedNow = rebuilt.pruned;
			break;
		}
		// Drop the OLDEST kept operational entry and recompose.
		const oldestKept = stableNewestFirst([...keepSet]).pop();
		if (oldestKept === undefined) break;
		keepSet.delete(oldestKept);
		dropped.add(oldestKept);
	}

	// Pressure — the correctness class ALONE above the envelope (no
	// operational entry remains droppable). Exact: measured on finalContent.
	manifest.pressure =
		Buffer.byteLength(finalContent) > _internals.limits.activeMaxBytes &&
		keepSet.size === 0;
	const pressureCount = manifest.pressure ? correctness.length : 0;
	if (manifest.pressure) {
		// The pressure flag is part of the persisted header — recompose with it.
		finalContent = `${JSON.stringify(manifest)}\n`;
		for (const entry of survivors) finalContent += `${JSON.stringify(entry)}\n`;
		for (const marker of rebuiltMarkers)
			finalContent += `${JSON.stringify(marker)}\n`;
	}

	const changed =
		dropped.size > 0 ||
		markerIdsPrunedNow > 0 ||
		view.corruptLines > 0 ||
		pressureDrops > 0 ||
		// legacy upgrade materializes the manifest (an EMPTY store stays
		// untouched — pinned "no-op when file is empty" behavior)
		(prior === null && (view.entries.length > 0 || view.markers.length > 0));

	if (!changed) {
		// No-op fast path: nothing dropped, nothing folded, manifest current.
		return { pruned: 0, remaining: survivors.length };
	}

	const budgetDroppedFinal = Math.max(0, dropped.size - droppedAge);

	try {
		atomicReplaceSkillUsage(directory, finalContent);
	} catch (writeErr) {
		const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
		return { pruned: 0, remaining: view.entries.length, error: msg };
	}

	_internals.emitHealth(directory, {
		trigger,
		acceptedCount: view.entries.length,
		compactedCount: budgetDroppedFinal,
		retainedCount: survivors.length,
		droppedAgeCount: droppedAge,
		corruptTotal: manifest.corruptTotal,
		preservedMarkerCount: rebuiltMarkers.length,
		droppedMarkerIdsCount: markerIdsPrunedNow,
		droppedUnderPressureTotal: manifest.droppedUnderPressureTotal,
		pressureCount,
		bytes: fileSizeOrZero(resolved),
		limitBytes: _internals.limits.activeMaxBytes,
	});

	return { pruned: dropped.size, remaining: survivors.length };
}

// ============================================================================
// Append
// ============================================================================

/**
 * Validate and append a single skill-usage entry to the JSONL log.
 *
 * The `id` field is auto-generated; callers provide all other fields.
 * Maintenance (bounded compaction) triggers when the file exceeds
 * `compactTriggerBytes`. Under pressure (correctness backlog above the
 * envelope), operational-class entries are rejected with a typed error —
 * every writer call site catches and warns, so skill injection fails open
 * (issue #2038 requirement 5). Lock-busy and disk errors throw; callers
 * already treat them as non-blocking.
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

	const normalizedVerdict = normalizeComplianceVerdict(complianceVerdict);

	// Pressure gate (per append, cheap: one stat + one bounded header read,
	// and only while the file is past the soft trigger): stop OPTIONAL writes
	// (operational class) when the correctness backlog alone exceeds the
	// envelope. Small files cannot be pressurized (pressure requires >
	// activeMaxBytes > trigger).
	{
		const gateSize = fileSizeOrZero(resolved);
		if (gateSize > _internals.limits.compactTriggerBytes) {
			if (!isActionableVerdict(normalizedVerdict)) {
				let pressured = false;
				try {
					pressured = readManifestHeader(directory)?.pressure === true;
				} catch {
					pressured = false;
				}
				if (pressured) {
					recordPressureDrop(directory);
					warnThrottled('store under pressure — operational entry rejected');
					throw new Error(PRESSURE_REJECTION_MESSAGE);
				}
			}
		}
	}

	const fullEntry: SkillUsageEntry = {
		id: _internals.generateId(),
		skillPath,
		agentName,
		taskID,
		timestamp,
		complianceVerdict: normalizedVerdict,
		sessionID,
		...(reviewerNotes !== undefined && { reviewerNotes }),
		...(skillVersion !== undefined && { skillVersion }),
	};
	const line = JSON.stringify(fullEntry);

	const wrote = _internals.withSkillUsageLock(directory, () => {
		// Re-establish line framing if a prior crash tore the tail (#2037 F-4).
		const prefix = fileEndsWithNewline(resolved) ? '' : '\n';
		_internals.appendFileSync(resolved, `${prefix}${line}\n`, 'utf-8');
		return true;
	});
	if (wrote === null) {
		// Lock held by a concurrent maintenance/feedback pass in another
		// process: the write did NOT happen — report honestly instead of a
		// false success. Callers catch and warn; the next delegation retries.
		warnThrottled('store lock busy — skill-usage entry not written');
		throw new Error(
			'skill-usage store lock busy — entry not written (concurrent maintenance)',
		);
	}

	// Post-append throttled maintenance (#2037 recordTelemetry shape): every
	// `checkInterval` appends, stat + O(1) manifest predicate decides whether
	// a full compaction pass runs. This amortizes rewrites — one per
	// checkInterval appends in a saturated steady state — and bounds the
	// rollover allowance to checkInterval entries plus one in-flight append.
	// The pinned 1 MiB-trigger test forces checkInterval=1 via _internals.
	try {
		if (shouldRunMaintenance()) {
			const postSize = fileSizeOrZero(resolved);
			if (
				postSize > _internals.limits.compactTriggerBytes &&
				maintenanceDue(directory, postSize)
			) {
				_internals.pruneSkillUsageLog(
					directory,
					_internals.limits.maxEntriesPerSkill,
					'append',
				);
			}
		}
	} catch {
		// best-effort compaction — fail-open
	}
}

// ============================================================================
// Read
// ============================================================================

/**
 * Read and parse skill-usage entries from the JSONL log, optionally filtered.
 *
 * ISSUE #2038: the read is byte-bounded (`readMaxBytes` tail read) regardless
 * of file size; entries return in append order (deterministic). Within the
 * retention envelope this is byte-for-byte the same result as the historical
 * full read; beyond it (unmigrated legacy tail or pressure state) use
 * `getSkillUsageCoverage` to disclose truncation. Malformed lines are skipped
 * (counted as corrupt by maintenance). Returns an empty array if the log file
 * does not exist.
 */
export function readSkillUsageEntries(
	directory: string,
	options?: SkillUsageFilterOptions,
): SkillUsageEntry[] {
	const view = readSkillUsageStore(directory, true);
	const entries = view.entries;

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
 * Coverage disclosure (issue #2038 requirement 4). See SkillUsageCoverageInfo
 * for the semantics of each value.
 */
export function getSkillUsageCoverage(
	directory: string,
): SkillUsageCoverageInfo {
	const resolved = resolveLogPath(directory);
	const onDiskBytes = fileSizeOrZero(resolved);
	const readMaxBytes = _internals.limits.readMaxBytes;
	if (onDiskBytes === 0) {
		return { coverage: 'empty', onDiskBytes, retainedEntries: 0, readMaxBytes };
	}
	if (onDiskBytes > readMaxBytes) {
		return {
			coverage: 'truncated',
			onDiskBytes,
			retainedEntries: 0,
			readMaxBytes,
		};
	}
	const view = readSkillUsageStore(directory, true);
	if (view.readFailed) {
		// Uncertainty contract (issue #2038): a read error on a non-empty
		// file is disclosed as partial coverage — never a confident "no
		// history" — so decision consumers defer and surfaces disclose.
		return {
			coverage: 'truncated',
			onDiskBytes,
			retainedEntries: view.entries.length,
			readMaxBytes,
		};
	}
	if (view.entries.length === 0) {
		return { coverage: 'empty', onDiskBytes, retainedEntries: 0, readMaxBytes };
	}
	return {
		coverage: 'complete',
		onDiskBytes,
		retainedEntries: view.entries.length,
		readMaxBytes,
	};
}

// ============================================================================
// Bounded tail read
// ============================================================================

/**
 * Read the last `maxBytes` of the skill-usage JSONL log and parse matching
 * entries. Session-scoped scoring/dedup consumers use this reader (64 KiB
 * window — strictly inside the retention envelope, so budget eviction can
 * never remove a tail-visible entry; see the dedup-window invariant in the
 * module header).
 *
 * Uses low-level `openSync` / `readSync` / `closeSync` to seek to the last
 * `maxBytes` of the file. Skips the first (potentially partial) line that
 * results from starting mid-file. The manifest header, when it falls inside
 * the window, is transparent to this reader (parseSkillUsageEntry rejects
 * it). Best-effort: returns an empty array on any I/O or parse error.
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
// Prune (public locked wrapper — issue #2038 requirement 3)
// ============================================================================

/**
 * Prune the skill-usage log under the store lock.
 *
 * Keeps at most `maxEntriesPerSkill` entries per unique skillPath — a policy
 * INSIDE the hard global byte/count/age ceilings (SKILL_USAGE_LIMITS).
 * Unprocessed actionable entries (the correctness class) and the marker IDs of
 * surviving entries always survive; processed markers age out with their
 * entries. Legacy header-less files are migrated (manifest materialized) even
 * on a no-drop pass. Atomic publish; original error surfaces in `error`.
 *
 * @returns Stats about how many entries were pruned and how many remain.
 */
export function pruneSkillUsageLog(
	directory: string,
	maxEntriesPerSkill: number = _internals.limits.maxEntriesPerSkill,
	trigger: SkillUsageHealthTrigger = 'phase-boundary',
): PruneResult {
	const result = _internals.withSkillUsageLock(directory, () =>
		compactSkillUsageStoreUnlocked(directory, maxEntriesPerSkill, trigger),
	);
	if (result === null) {
		// Lock held by a concurrent pass: honest no-op, file untouched.
		warnThrottled('store lock busy — prune skipped');
		return { pruned: 0, remaining: 0, error: 'skill-usage store lock busy' };
	}
	return result;
}

// ============================================================================
// Feedback markers (read + append)
// ============================================================================

/** Append a feedback_applied marker. Callers must hold the store lock (the
 * feedback pass does); the torn-tail guard keeps the marker on its own line. */
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
	const prefix = fileEndsWithNewline(resolved) ? '' : '\n';
	_internals.appendFileSync(
		resolved,
		`${prefix}${JSON.stringify(marker)}\n`,
		'utf-8',
	);
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

		const content = _internals.readFileSync(absolute, 'utf-8');
		return parseGeneratedFromKnowledge(content);
	} catch (err) {
		warn(
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

/**
 * Read skill-usage entries, resolve source knowledge IDs for each skill,
 * and apply confidence bumps/decays to the originating knowledge entries.
 *
 * For each unique skillPath with at least one compliance or violated entry:
 * 1. Resolve source knowledge UUIDs from the skill's SKILL.md frontmatter.
 * 2. Count compliant and violated events for that skill.
 * 3. Compute net delta: if compliant count > violation count → +0.05; else → -0.1.
 * 4. Call `bumpKnowledgeConfidenceBatch` with the aggregated deltas.
 *
 * ISSUE #2038: the whole read→bump→marker cycle runs under the async store
 * lock so concurrent phase-completions cannot double-apply confidence, and a
 * busy lock means NO bump happens at all (honest {0,0}; the next phase
 * boundary retries — markers make re-processing idempotent). The pass
 * compacts first when the store exceeds the read bound; if coverage is still
 * not complete (pressure), it skips honestly rather than guess with a
 * partial marker view.
 *
 * @param directory       - Project root directory.
 * @param options.sinceTimestamp - Optional ISO 8601 cutoff; only process entries after this time.
 * @returns Count of processed skills and total confidence bumps/decays applied.
 */
export async function applySkillUsageFeedback(
	directory: string,
	options?: {
		sinceTimestamp?: string;
		/** G2: forwarded to bumpKnowledgeConfidenceBatch. */
		floorOptions?: ConfidenceFloorOptions;
	},
): Promise<{ processed: number; bumps: number }> {
	try {
		const result = await _internals.withSkillUsageLockAsync(
			directory,
			async () => {
				const resolved = resolveLogPath(directory);

				// Compact-first (issue #2038): migrate a legacy tail before the
				// pass reads, so the feedback view matches the compacted state.
				try {
					if (
						_internals.existsSync(resolved) &&
						fileSizeOrZero(resolved) > _internals.limits.readMaxBytes
					) {
						compactSkillUsageStoreUnlocked(
							directory,
							_internals.limits.maxEntriesPerSkill,
							'feedback',
						);
					}
				} catch {
					// best-effort — the full-store read below still fails safe
				}

				// MAINTENANCE-path FULL read (the #2037 honest-work model: the
				// cost scales with the store, which the retention envelope
				// bounds in steady state; legacy/pressure states pay once).
				// A bounded window here would be a LIVENESS HOLE: the oldest
				// unprocessed actionable entries sit at the head of the file,
				// a tail window can never see them, and a correctness backlog
				// beyond the window could never be consumed — pressure would
				// never clear (pinned by the pressure-clear regression test).
				// At-most-once is trivial under the full marker view + lock.
				const storeView = readSkillUsageStore(directory, false);
				const allEntries = storeView.entries;
				const alreadyProcessed = new Set<string>();
				for (const marker of storeView.markers) {
					for (const id of marker.processedEntryIds) alreadyProcessed.add(id);
				}

				// Filter to entries with actionable compliance verdicts
				const actionable = allEntries.filter((e) => {
					if (
						e.complianceVerdict !== 'compliant' &&
						e.complianceVerdict !== 'violated'
					) {
						return false;
					}
					if (
						options?.sinceTimestamp &&
						e.timestamp <= options.sinceTimestamp
					) {
						return false;
					}
					if (alreadyProcessed.has(e.id)) {
						return false;
					}
					return true;
				});

				if (actionable.length === 0) {
					return { processed: 0, bumps: 0 };
				}

				// Group by skillPath
				const groups = new Map<string, typeof actionable>();
				for (const entry of actionable) {
					const list = groups.get(entry.skillPath);
					if (list) list.push(entry);
					else groups.set(entry.skillPath, [entry]);
				}

				// Collect all deltas across all skills, then batch-apply once
				const allDeltas: Array<{ id: string; delta: number }> = [];
				const processedEntryIds: string[] = [];
				let processed = 0;
				let bumps = 0;

				for (const [skillPath, entries] of Array.from(groups)) {
					let compliantCount = 0;
					let violationCount = 0;

					for (const entry of entries) {
						if (entry.complianceVerdict === 'compliant') compliantCount++;
						else if (entry.complianceVerdict === 'violated') violationCount++;
					}

					// Skip skills with no actionable verdicts (shouldn't happen due to filter, but defensive)
					if (compliantCount === 0 && violationCount === 0) continue;

					const delta =
						compliantCount > violationCount
							? COMPLIANCE_BOOST
							: -VIOLATION_DECAY;

					// Resolve source knowledge IDs from the skill's SKILL.md
					const sourceIds = await resolveSourceKnowledgeIds(
						directory,
						skillPath,
					);
					if (sourceIds.length === 0) continue;

					for (const id of sourceIds) {
						allDeltas.push({ id, delta });
					}
					processedEntryIds.push(...entries.map((entry) => entry.id));

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
						delta: Math.max(
							-VIOLATION_DECAY,
							Math.min(COMPLIANCE_BOOST, netDelta),
						),
					}),
				);

				// Batch-apply clamped deltas in a single call, then mark consumed.
				// Marker-write failure does NOT roll back the bump: the ±0.05/−0.1
				// per-cycle clamps bound any re-bump on the next pass, while
				// inverting the order would permanently lose credit (a marked-but-
				// never-bumped entry can never be re-processed). The audit gap is
				// disclosed via health + warn.
				if (clampedDeltas.length > 0) {
					await bumpKnowledgeConfidenceBatch(
						directory,
						clampedDeltas,
						options?.floorOptions,
					);
					try {
						appendFeedbackAppliedMarker(directory, processedEntryIds);
					} catch (markerErr) {
						_internals.emitHealth(directory, {
							trigger: 'feedback',
							acceptedCount: allEntries.length,
							compactedCount: 0,
							retainedCount: allEntries.length,
							droppedAgeCount: 0,
							corruptTotal: 0,
							preservedMarkerCount: 0,
							droppedMarkerIdsCount: 0,
							droppedUnderPressureTotal: 0,
							pressureCount: 0,
							bytes: fileSizeOrZero(resolved),
							limitBytes: _internals.limits.activeMaxBytes,
						});
						warn(
							'[skill-usage-log] feedback marker append failed after bump (bounded drift, clamp-limited):',
							markerErr instanceof Error
								? markerErr.message
								: String(markerErr),
						);
					}
				}

				return { processed, bumps };
			},
		);

		if (result !== null) return result;
		// Lock busy — honest no-op; the next phase boundary retries.
		warnThrottled('store lock busy — skill-usage feedback skipped this cycle');
		return { processed: 0, bumps: 0 };
	} catch (err) {
		warn(
			'[skill-usage-log] applySkillUsageFeedback failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
	}
	return { processed: 0, bumps: 0 };
}

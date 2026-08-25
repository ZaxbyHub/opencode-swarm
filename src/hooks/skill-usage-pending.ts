/**
 * Skill-usage pending sidecar — `.swarm/skill-usage-pending.json` (issue #2038).
 *
 * Two files back the skill-usage subsystem:
 *
 * 1. `.swarm/skill-usage.jsonl` — the **OPERATIONAL** stream. Pure JSONL usage
 *    entries, no manifest header line, freely evictable under the global
 *    byte/age/count budget.
 * 2. `.swarm/skill-usage-pending.json` — this file, the **AUTHORITATIVE**
 *    sidecar. A single JSON document holding the pending-feedback queue *and*
 *    all manifest state: `{ version, migrated, records[], counters{}, coverage{} }`.
 *
 * The manifest lives here rather than in a JSONL header line so that
 * `parseSkillUsageEntry` stays header-free and the tail reader and the full
 * reader remain on one parser (approved plan §0).
 *
 * Evicting an entry from the JSONL can lose no correctness signal because
 * every actionable verdict (`compliant` / `violated`) is enqueued here
 * *before* it is appended to the stream (approved plan §2). The queue record
 * is self-sufficient: consumption computes compliant/violated counts and the
 * per-skill delta from queue records only, never from JSONL entries.
 *
 * All I/O is synchronous, matching `skill-usage-log.ts`. State lives only under
 * `.swarm/` resolved from the injected `directory` (never `process.cwd()`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { telemetry } from '../telemetry.js';
import * as logger from '../utils/logger.js';
import { validateSwarmPath } from './utils.js';

// ============================================================================
// Limits (approved plan §1) — values are load-bearing against existing fixtures
// ============================================================================

/**
 * The hard global budget for the skill-usage subsystem.
 *
 * | Key | Justification |
 * |---|---|
 * | `version` | requirement 1 "versioned"; stored in the sidecar |
 * | `maxEntries` | must exceed 500 so the per-skill 500-entry fixture still prunes nothing |
 * | `maxBytes` | must exceed the ~100 KB 600-entry fixture |
 * | `maxAgeMs` | the age budget |
 * | `floorPerSkill` | >= `curatorMinSample`, so the guaranteed window can still authorize a retirement |
 * | `curatorMinSample` | minimum per-skill sample before the curator may retire/revise |
 * | `readMaxBytes` | >= `maxBytes` + slack, so a bounded file always reads complete |
 * | `migrationChunkBytes` | **chunk/buffer bound, NOT a total-bytes cap** — migration is single-pass streaming and is never byte-truncated |
 * | `headerMaxBytes` | sidecar manifest-scalar bound |
 * | `queueMaxRecords` | requirement 1 applies to marker types too; an upper guard, NOT the binding cap (see below) |
 * | `queueMaxBytes` | **the binding cap** (see below) |
 * | `maxAttempts` | bounds transient-failure retention |
 * | `checkInterval` | throttled maintenance cadence, mirrors `telemetry.ts` |
 *
 * **Which queue cap binds, and why (issue #2038 review).** The approved plan
 * justified `queueMaxBytes` as "~5,000 x ~100 B". That estimate is wrong by a
 * factor of two. Measured `recordBytes` (`JSON.stringify(record).length + 1`,
 * which is what {@link queueByteSize} sums):
 *
 * | `skillPath` | bytes/record | `queueMaxBytes` binds at |
 * |---|---|---|
 * | `skill-x` (a test-length path) | 200 | 2,621 records |
 * | `.claude/skills/writing-tests/SKILL.md` | 230 | 2,279 records |
 * | `.claude/skills/engineering-conventions/SKILL.md` | 240 | 2,184 records |
 *
 * A 36-char UUID id and two ISO-8601 timestamps (`timestamp`, `enqueuedAt`)
 * are already 88 B of values before any key name. `queueMaxRecords` = 5,000
 * would need <= 104.9 B/record to be reachable, and 5,000 realistic records
 * would need a ~1,123 KiB byte budget.
 *
 * So `queueMaxBytes` (512 KiB) binds first, at roughly **2,200-2,600
 * records**, and `queueMaxRecords` (5,000) is **not reachable** in practice.
 * That is deliberate and left as-is: both numbers are published in
 * `docs/observability-retention-registry.md` and
 * `scripts/retention-registry.data.ts`, the byte budget is the one requirement
 * 1 actually cares about (unbounded *growth*), and the eviction ladder in
 * {@link enforceQueueBounds} is driven by `overBudget()`, which ORs the two —
 * so the ladder and every counted discard behave identically whichever cap
 * trips. `queueMaxRecords` remains as a cardinality guard for the degenerate
 * case of pathologically short records. Do not "fix" the record count by
 * shrinking the record: every field it carries has a consumer in
 * `applySkillUsageFeedback`.
 */
export const SKILL_USAGE_LIMITS = {
	version: 1,
	maxEntries: 5_000,
	maxBytes: 1.5 * 1024 * 1024,
	maxAgeMs: 90 * 24 * 60 * 60 * 1000,
	floorPerSkill: 20,
	curatorMinSample: 10,
	// 1.6 MiB, rounded up to a whole number of bytes: this value reaches
	// `Buffer.alloc`, which rejects a fractional length.
	readMaxBytes: 1_677_722,
	migrationChunkBytes: 256 * 1024,
	headerMaxBytes: 8 * 1024,
	queueMaxRecords: 5_000,
	queueMaxBytes: 512 * 1024,
	maxAttempts: 5,
	checkInterval: 50,
} as const;

/**
 * Stale-break window for `.swarm/skill-usage.lock`, mirroring
 * `src/context-map/telemetry.ts`. The knowledge-store bump holds its own
 * lock for at most 5 retries / 5 s, so it cannot push a consumption cycle
 * past this window.
 */
export const SKILL_USAGE_LOCK_STALE_MS = 5 * 60_000;

/** Attempts (and inter-attempt delay) for the enqueue path, which may not skip. */
const ENQUEUE_LOCK_ATTEMPTS = 5;
const ENQUEUE_LOCK_RETRY_MS = 10;

/** The single refusal message for a non-acquirable enqueue lock. */
const SKILL_USAGE_LOCK_UNAVAILABLE =
	'skill-usage pending queue lock unavailable; refusing to append an unqueued actionable verdict';

/** How long a cached pressure reading stays valid before a cheap `statSync` refresh. */
const PRESSURE_CACHE_MS = 5_000;

// ============================================================================
// Types
// ============================================================================

/** Lifecycle state of a queued feedback record. */
export type SkillUsagePendingState = 'pending' | 'in_flight' | 'uncertain';

/**
 * Terminal outcomes. Every one of these DEQUEUES the record and increments a
 * health counter; none of them increments `processed` / `bumps` on the
 * `applySkillUsageFeedback` return value (approved plan §3, E7).
 */
export type SkillUsageTerminalOutcome =
	| 'no_source_knowledge'
	| 'no_matching_knowledge'
	| 'bump_unrecoverable'
	| 'uncertain_expired';

/** A single queued actionable verdict awaiting a confidence bump. */
export interface SkillUsagePendingRecord {
	/** Same id as the JSONL entry it mirrors — the dedupe key. */
	id: string;
	/**
	 * Canonical skill path — no `file:` prefix, forward slashes only — the
	 * same spelling written to the stream for this id (issue #2038 review,
	 * DEFECT 2). Both writers normalize through
	 * `skill-usage-log.ts` `canonicalSkillPath`, so a record and its stream row
	 * can never disagree; `applySkillUsageFeedback` groups on THIS field, so a
	 * disagreement would split one skill's feedback into two groups.
	 * Records migrated from a pre-fix sidecar may still carry a raw spelling
	 * until they drain; every consumer of this field strips `file:`
	 * idempotently, so both forms resolve.
	 */
	skillPath: string;
	/** Actionable verdict only. */
	verdict: 'compliant' | 'violated';
	/** ISO 8601 timestamp of the usage event. */
	timestamp: string;
	/** ISO 8601 mint time — the reference for queue age bounds. */
	enqueuedAt: string;
	state: SkillUsagePendingState;
	/** Transient-failure retry counter, bounded by `maxAttempts`. */
	attempts: number;
	/** ISO 8601 time the record was claimed; only set while `in_flight`. */
	inFlightAt?: string;
}
// NOTE: the record deliberately carries only what consumption reads. Fields
// like `sessionID` / `agentName` / `taskID` / `skillVersion` have no consumer
// here (`applySkillUsageFeedback` groups by `skillPath` and counts verdicts),
// they remain available on the JSONL entry, and every byte they would add
// comes straight out of `queueMaxBytes` — the budget requirement 1 exists to
// enforce.

/** Durable lifetime counters. Fixed key set — bounded cardinality by construction. */
export const SKILL_USAGE_COUNTER_KEYS = [
	'accepted',
	'compacted',
	'dropped',
	'skills_dropped',
	'corrupt',
	'uncertain_expired',
	/**
	 * Actionable records (`pending` or `in_flight`) evicted by the QUEUE BUDGET,
	 * kept separate from `dropped` so the deliberate divergence from approved
	 * plan §4 is observable rather than implicit (issue #2038 implementation
	 * review, F3). `dropped` retains its other two meanings — age expiry of a
	 * non-`uncertain` record, and migration trim — so a non-zero
	 * `pending_evicted` is unambiguous evidence of budget pressure discarding
	 * actionable work.
	 */
	'pending_evicted',
	'no_source_knowledge',
	'no_matching_knowledge',
	'bump_retry',
	'bump_unrecoverable',
	'bump_applied_zero',
	'pressure',
	'curator_skipped',
] as const;

export type SkillUsageCounterKey = (typeof SKILL_USAGE_COUNTER_KEYS)[number];

/**
 * What the retained JSONL window can and cannot answer.
 *
 * Per-skill coverage is DERIVED from these global facts plus the retained
 * count for the skill (see {@link isSkillWindowTrustworthy}) rather than
 * stored per skill — a per-skill map would be an unbounded key set, which is
 * exactly the failure mode issue #2038 is about.
 */
export interface SkillUsageCoverage {
	/** True when no entry has ever been evicted by compaction. */
	complete: boolean;
	/** Oldest retained entry timestamp at the last compaction, or null. */
	oldestRetained: string | null;
	/** Newest retained entry timestamp at the last compaction, or null. */
	newestRetained: string | null;
	/** Cumulative entries evicted by compaction. */
	entriesDropped: number;
	/** Cumulative skills dropped whole by the admit-by-most-recent-use step. */
	skillsDropped: number;
	/** The floor guarantee in force, so consumers do not hardcode it. */
	floorPerSkill: number;
}

/** The whole sidecar document. */
export interface SkillUsagePendingDocument {
	version: number;
	/** False (or absent) means the legacy migration has not completed yet. */
	migrated: boolean;
	records: SkillUsagePendingRecord[];
	counters: Record<SkillUsageCounterKey, number>;
	coverage: SkillUsageCoverage;
}

/** An enqueue request — the caller supplies the id minted for the JSONL entry. */
export interface SkillUsageEnqueueInput {
	id: string;
	skillPath: string;
	verdict: 'compliant' | 'violated';
	timestamp: string;
}

/** Opaque handle for an acquired `.swarm/skill-usage.lock`. */
export interface SkillUsageLockHandle {
	readonly lockPath: string;
}

// ============================================================================
// DI seam
// ============================================================================

/**
 * Test-only dependency-injection seam. Tests override these without
 * `mock.module` (which leaks across files in Bun's shared test-runner).
 * Restore in `afterEach`, and call `_resetSkillUsagePendingState()` to clear
 * the module-scoped pressure cache.
 */
export const _internals = {
	existsSync: fs.existsSync.bind(fs),
	readFileSync: fs.readFileSync.bind(fs),
	writeFileSync: fs.writeFileSync.bind(fs),
	renameSync: fs.renameSync.bind(fs),
	mkdirSync: fs.mkdirSync.bind(fs),
	statSync: fs.statSync.bind(fs),
	openSync: fs.openSync.bind(fs),
	closeSync: fs.closeSync.bind(fs),
	unlinkSync: fs.unlinkSync.bind(fs),
	now: (): number => Date.now(),
	emitHealth: (payload: SkillUsageHealthPayload): void => {
		telemetry.skillUsageHealth(payload);
	},
};

// ---------------------------------------------------------------------------
// Module-scoped caches (AGENTS.md invariant 7: one reset seam, always in afterEach)
// ---------------------------------------------------------------------------

let _pressure = false;
let _pressureCheckedAt = 0;
let _pressureDirectory: string | null = null;

/**
 * **Hard cap on both derived caches below (issue #2038 review).**
 *
 * These are keyed by resolved sidecar path — one key per project directory the
 * process ever touches — so an uncapped `Map` would be exactly the unbounded
 * growth this issue exists to eliminate, inside the fix for it. Eviction is
 * least-recently-used, which is right for the real access pattern: a process
 * works one project at a time and revisits it repeatedly.
 *
 * Worst-case resident bytes are therefore bounded, not merely "small":
 * `_coverageCache` holds fixed-shape scalars (< 200 B/entry, so < 2 KiB
 * total), and `_documentCache` holds the serialized sidecar text, admitted
 * only when it is at or under {@link MAX_CACHED_DOCUMENT_BYTES} — so at most
 * `MAX_CACHED_PROJECTS * queueMaxBytes` = 8 x 512 KiB = 4 MiB.
 */
const MAX_CACHED_PROJECTS = 8;

/**
 * Admission limit for {@link _documentCache}. A sidecar within the queue byte
 * budget is cached; a larger one (a legacy or not-yet-bounded document) is
 * not, so an oversized file can never be pinned in memory.
 */
const MAX_CACHED_DOCUMENT_BYTES = SKILL_USAGE_LIMITS.queueMaxBytes;

/** LRU read: a hit is refreshed to the most-recent position. */
function cacheGet<V>(cache: Map<string, V>, key: string): V | undefined {
	const hit = cache.get(key);
	if (hit === undefined) return undefined;
	cache.delete(key);
	cache.set(key, hit);
	return hit;
}

/** LRU write, evicting least-recently-used keys down to the hard cap. */
function cacheSet<V>(cache: Map<string, V>, key: string, value: V): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > MAX_CACHED_PROJECTS) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

interface CoverageCacheEntry {
	fingerprint: string;
	coverage: SkillUsageCoverage;
	migrated: boolean;
}
const _coverageCache = new Map<string, CoverageCacheEntry>();

/**
 * The exact serialized bytes of a known sidecar version, so the enqueue path —
 * which runs before EVERY actionable append — does not re-read a document it
 * just wrote itself.
 *
 * This deliberately caches **text, not a parsed document**. Every hit still
 * goes through {@link parsePendingDocument}, so a cache hit and a disk read
 * produce independently-constructed objects that no caller can alias or
 * mutate into each other. An object cache would hand out a live document that
 * `mergePendingRecords` / `enforceQueueBounds` mutate BEFORE
 * {@link savePendingDocument} — and a save that then threw would leave the
 * cache holding records that are not on disk, which the next enqueue would
 * dedupe away by id. Losing an actionable verdict inside the fix for
 * "eviction must lose no correctness signal" is not an acceptable trade for
 * one avoided `JSON.parse`.
 */
interface DocumentCacheEntry {
	fingerprint: string;
	text: string;
}
const _documentCache = new Map<string, DocumentCacheEntry>();

/**
 * Identity of an exact file version: nanosecond mtime plus size.
 *
 * `mtimeMs` alone is too coarse to be safe here — a foreign writer could
 * replace the sidecar with a same-size document inside one millisecond tick
 * and the cache would serve stale records. `mtimeNs` is 100 ns-resolution on
 * NTFS and ext4 alike.
 *
 * **Fails closed.** `_internals.statSync` is a test seam, and a stub that
 * ignores the `bigint` option returns no `mtimeNs`; `undefined === undefined`
 * would otherwise be a false cache hit. A missing/non-bigint `mtimeNs` yields
 * `fingerprint: null`, which never matches and is never stored.
 */
function statFingerprint(resolved: string): {
	size: number;
	fingerprint: string | null;
} {
	const stat = _internals.statSync(resolved, { bigint: true }) as unknown as {
		size: number | bigint;
		mtimeNs?: unknown;
	};
	const size = Number(stat.size);
	return {
		size,
		fingerprint:
			typeof stat.mtimeNs === 'bigint' ? `${stat.mtimeNs}:${size}` : null,
	};
}

/**
 * Reset module-scoped caches so an unswept run in Bun's shared test-runner
 * process cannot shift a later test's first read or pressure decision.
 */
export function _resetSkillUsagePendingState(): void {
	_pressure = false;
	_pressureCheckedAt = 0;
	_pressureDirectory = null;
	_coverageCache.clear();
	_documentCache.clear();
}

// ============================================================================
// Paths
// ============================================================================

/** Absolute path to the authoritative sidecar. */
export function resolvePendingPath(directory: string): string {
	return validateSwarmPath(directory, 'skill-usage-pending.json');
}

/** Basename of the shared skill-usage lock file inside `.swarm/`. */
const SKILL_USAGE_LOCK_BASENAME = 'skill-usage.lock';

/** Absolute path to the shared skill-usage lock file. */
export function resolveSkillUsageLockPath(directory: string): string {
	return validateSwarmPath(directory, SKILL_USAGE_LOCK_BASENAME);
}

/**
 * A sibling of a path that has ALREADY been through `validateSwarmPath`.
 *
 * `resolved` is known to sit inside the real `.swarm` directory, so its
 * `dirname` IS that validated directory and joining a module-constant basename
 * onto it cannot escape — there is no caller-controlled component. This exists
 * purely because `validateSwarmPath` costs an `lstat` plus one or two
 * `realpath` calls, and the enqueue path runs before EVERY actionable append:
 * measured on Windows, resolving four `.swarm` paths per enqueue cost more
 * than the read, the write, and the rename put together. `pruneSkillUsageLog`
 * already derives its temp path exactly this way.
 *
 * Never pass caller-supplied text as `basename`.
 */
function siblingSwarmPath(resolved: string, basename: string): string {
	return path.join(path.dirname(resolved), basename);
}

function ensureSwarmDir(resolved: string): void {
	const dir = path.dirname(resolved);
	if (!_internals.existsSync(dir)) {
		_internals.mkdirSync(dir, { recursive: true });
	}
}

// ============================================================================
// Lock (approved plan §9)
// ============================================================================

/**
 * Synchronous sleep. `Atomics.wait` is the only precise option available in a
 * synchronous module; the busy-wait fallback bounds the damage if a runtime
 * refuses `SharedArrayBuffer`.
 */
function sleepSyncMs(ms: number): void {
	try {
		const view = new Int32Array(new SharedArrayBuffer(4));
		Atomics.wait(view, 0, 0, ms);
		return;
	} catch {
		// Bounded spin fallback for a runtime without `SharedArrayBuffer`.
		const until = Date.now() + ms;
		let spins = 0;
		while (Date.now() < until) spins += 1;
		void spins;
	}
}

function tryCreateLock(lockPath: string): boolean {
	try {
		const fd = _internals.openSync(lockPath, 'wx');
		_internals.closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function breakStaleLock(lockPath: string): boolean {
	try {
		const age = _internals.now() - _internals.statSync(lockPath).mtimeMs;
		// PR #2347 review (FB-009): `age` can be negative if the lock file's
		// mtime is in the future relative to this process's clock (skew, or a
		// bad wall clock at lock-creation time). A plain `age <= threshold`
		// treats any negative age as "fresh" and never breaks the lock, which
		// wedges every writer until real time catches up to that future
		// mtime — potentially far longer than the stale window. No writer here
		// ever legitimately produces a future mtime, so a large negative age is
		// itself the staleness signal; compare the magnitude, not the sign.
		if (Math.abs(age) <= SKILL_USAGE_LOCK_STALE_MS) return false;
	} catch {
		return false;
	}
	try {
		_internals.unlinkSync(lockPath);
	} catch {
		return false;
	}
	return tryCreateLock(lockPath);
}

/**
 * Non-blocking lock acquisition. Returns `null` when the lock is held by a
 * live holder — maintenance and consumption are then **skipped, never forced**.
 * Injection still fails open because nothing here throws.
 */
export function acquireSkillUsageLock(
	directory: string,
): SkillUsageLockHandle | null {
	let lockPath: string;
	try {
		lockPath = resolveSkillUsageLockPath(directory);
	} catch {
		return null;
	}
	return acquireSkillUsageLockAt(lockPath);
}

/** {@link acquireSkillUsageLock} against an already-validated lock path. */
function acquireSkillUsageLockAt(
	lockPath: string,
): SkillUsageLockHandle | null {
	try {
		ensureSwarmDir(lockPath);
	} catch {
		return null;
	}
	if (tryCreateLock(lockPath)) return { lockPath };
	if (breakStaleLock(lockPath)) return { lockPath };
	return null;
}

/**
 * Lock acquisition for the **enqueue** path, which is exempt from the
 * skip-not-force rule (approved plan §2.3, §9): a failed enqueue must abort
 * the append and propagate rather than silently drop a correctness signal.
 * Holders only perform a handful of synchronous file operations, so a short
 * bounded retry absorbs ordinary contention.
 */
export function acquireSkillUsageLockOrThrow(
	directory: string,
): SkillUsageLockHandle {
	let lockPath: string;
	try {
		lockPath = resolveSkillUsageLockPath(directory);
	} catch {
		// Preserve the pre-existing failure mode: an unresolvable lock path
		// reported the same "lock unavailable" refusal, not the path error.
		throw new Error(SKILL_USAGE_LOCK_UNAVAILABLE);
	}
	return acquireSkillUsageLockOrThrowAt(lockPath);
}

/** {@link acquireSkillUsageLockOrThrow} against an already-validated lock path. */
function acquireSkillUsageLockOrThrowAt(
	lockPath: string,
): SkillUsageLockHandle {
	for (let attempt = 0; attempt < ENQUEUE_LOCK_ATTEMPTS; attempt++) {
		const handle = acquireSkillUsageLockAt(lockPath);
		if (handle) return handle;
		if (attempt < ENQUEUE_LOCK_ATTEMPTS - 1) sleepSyncMs(ENQUEUE_LOCK_RETRY_MS);
	}
	throw new Error(SKILL_USAGE_LOCK_UNAVAILABLE);
}

/** Release a lock acquired above. Never throws. */
export function releaseSkillUsageLock(handle: SkillUsageLockHandle): void {
	try {
		_internals.unlinkSync(handle.lockPath);
	} catch {
		/* ignore — a stale-break will recover it */
	}
}

// ============================================================================
// Document construction / parsing
// ============================================================================

function emptyCounters(): Record<SkillUsageCounterKey, number> {
	const counters = {} as Record<SkillUsageCounterKey, number>;
	for (const key of SKILL_USAGE_COUNTER_KEYS) counters[key] = 0;
	return counters;
}

function emptyCoverage(): SkillUsageCoverage {
	return {
		complete: true,
		oldestRetained: null,
		newestRetained: null,
		entriesDropped: 0,
		skillsDropped: 0,
		floorPerSkill: SKILL_USAGE_LIMITS.floorPerSkill,
	};
}

/** A fresh, un-migrated document. */
export function createPendingDocument(): SkillUsagePendingDocument {
	return {
		version: SKILL_USAGE_LIMITS.version,
		migrated: false,
		records: [],
		counters: emptyCounters(),
		coverage: emptyCoverage(),
	};
}

function parseRecord(raw: unknown): SkillUsagePendingRecord | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const r = raw as Partial<SkillUsagePendingRecord>;
	if (typeof r.id !== 'string' || r.id.length === 0) return null;
	if (typeof r.skillPath !== 'string' || r.skillPath.length === 0) return null;
	if (r.verdict !== 'compliant' && r.verdict !== 'violated') return null;
	if (typeof r.timestamp !== 'string') return null;
	const state: SkillUsagePendingState =
		r.state === 'in_flight' || r.state === 'uncertain' ? r.state : 'pending';
	return {
		id: r.id,
		skillPath: r.skillPath,
		verdict: r.verdict,
		timestamp: r.timestamp,
		enqueuedAt:
			typeof r.enqueuedAt === 'string' ? r.enqueuedAt : (r.timestamp as string),
		state,
		attempts:
			typeof r.attempts === 'number' && r.attempts >= 0 ? r.attempts : 0,
		...(typeof r.inFlightAt === 'string' && { inFlightAt: r.inFlightAt }),
	};
}

function parsePendingDocument(raw: string): SkillUsagePendingDocument {
	const parsed = JSON.parse(raw) as Partial<SkillUsagePendingDocument>;
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('sidecar root is not an object');
	}
	if (!Array.isArray(parsed.records)) {
		throw new Error('sidecar `records` is not an array');
	}
	const doc = createPendingDocument();
	doc.version =
		typeof parsed.version === 'number'
			? parsed.version
			: SKILL_USAGE_LIMITS.version;
	doc.migrated = parsed.migrated === true;

	// Dedupe by id on load (approved plan BLK-10): a re-run migration or a
	// retried publish must not double-count a record.
	const seen = new Set<string>();
	for (const rawRecord of parsed.records) {
		const record = parseRecord(rawRecord);
		if (!record) continue;
		if (seen.has(record.id)) continue;
		seen.add(record.id);
		doc.records.push(record);
	}

	const counters = parsed.counters as
		| Partial<Record<SkillUsageCounterKey, number>>
		| undefined;
	if (counters && typeof counters === 'object') {
		for (const key of SKILL_USAGE_COUNTER_KEYS) {
			const value = counters[key];
			if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
				doc.counters[key] = value;
			}
		}
	}

	const coverage = parsed.coverage as Partial<SkillUsageCoverage> | undefined;
	if (coverage && typeof coverage === 'object') {
		doc.coverage = {
			complete: coverage.complete !== false,
			oldestRetained:
				typeof coverage.oldestRetained === 'string'
					? coverage.oldestRetained
					: null,
			newestRetained:
				typeof coverage.newestRetained === 'string'
					? coverage.newestRetained
					: null,
			entriesDropped:
				typeof coverage.entriesDropped === 'number'
					? coverage.entriesDropped
					: 0,
			skillsDropped:
				typeof coverage.skillsDropped === 'number' ? coverage.skillsDropped : 0,
			floorPerSkill: SKILL_USAGE_LIMITS.floorPerSkill,
		};
	}
	return doc;
}

// ============================================================================
// Load / quarantine / save
// ============================================================================

/** Result of loading the sidecar. */
export interface LoadPendingResult {
	doc: SkillUsagePendingDocument;
	/** True when a corrupt sidecar was renamed aside and a fresh one substituted. */
	quarantined: boolean;
	/** Absolute path the corrupt document was moved to, when quarantined. */
	quarantinePath?: string;
}

function quarantinePendingDocument(
	directory: string,
	resolved: string,
): string | undefined {
	const stamp = new Date(_internals.now()).toISOString().replace(/[:.]/g, '-');
	try {
		const target = validateSwarmPath(
			directory,
			`skill-usage-pending.corrupt-${stamp}.json`,
		);
		_internals.renameSync(resolved, target);
		return target;
	} catch (err) {
		logger.log(
			'[skill-usage-pending] quarantine failed (continuing with a fresh queue):',
			err instanceof Error ? err.message : String(err),
		);
		return undefined;
	}
}

/**
 * Read the sidecar.
 *
 * A corrupt or oversized document is **quarantined** (renamed aside) and
 * counted — never silently reset to `[]`. The replacement document carries
 * `migrated: false`, which makes the next lock-taking touch rebuild the queue
 * from whatever the JSONL stream still holds (approved plan §6, requirement 3).
 */
export function loadPendingDocument(directory: string): LoadPendingResult {
	return loadPendingDocumentAt(directory, resolvePendingPath(directory));
}

/**
 * {@link loadPendingDocument} against an already-validated sidecar path.
 *
 * `validateSwarmPath` costs an `lstat` plus one or two `realpath` calls, which
 * on Windows is more expensive than the rest of an enqueue combined. The
 * enqueue path resolves once and threads the result through load and save.
 */
function loadPendingDocumentAt(
	directory: string,
	resolved: string,
): LoadPendingResult {
	// One `statSync` answers all three of "does it exist", "is it within the
	// read budget", and "is my cached copy still the current version".
	// `existsSync` is itself a stat, and on the enqueue path — which runs
	// before every actionable append — each avoided syscall is real time.
	let size: number;
	let fingerprint: string | null;
	try {
		({ size, fingerprint } = statFingerprint(resolved));
	} catch {
		// ENOENT (or an unreadable path, which `existsSync` also reported as
		// absent) — start from a fresh, un-migrated document.
		return { doc: createPendingDocument(), quarantined: false };
	}

	if (size <= SKILL_USAGE_LIMITS.readMaxBytes) {
		try {
			const cached =
				fingerprint === null ? undefined : cacheGet(_documentCache, resolved);
			const raw =
				cached !== undefined && cached.fingerprint === fingerprint
					? cached.text
					: (_internals.readFileSync(resolved, 'utf-8') as string);
			// Parse FIRST: a document is only cached once it is known to parse,
			// so a corrupt read can never be replayed from memory.
			const doc = parsePendingDocument(raw);
			if (fingerprint !== null && raw.length <= MAX_CACHED_DOCUMENT_BYTES) {
				cacheSet(_documentCache, resolved, { fingerprint, text: raw });
			}
			return { doc, quarantined: false };
		} catch (err) {
			logger.log(
				'[skill-usage-pending] corrupt sidecar — quarantining:',
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	_documentCache.delete(resolved);
	const quarantinePath = quarantinePendingDocument(directory, resolved);
	const doc = createPendingDocument();
	doc.counters.corrupt += 1;
	return {
		doc,
		quarantined: true,
		...(quarantinePath !== undefined && { quarantinePath }),
	};
}

/**
 * Atomically replace the sidecar (temp file + rename). Throws on failure so
 * the enqueue path can abort its append and propagate (approved plan §2.3).
 */
export function savePendingDocument(
	directory: string,
	doc: SkillUsagePendingDocument,
): void {
	savePendingDocumentAt(directory, resolvePendingPath(directory), doc);
}

/** {@link savePendingDocument} against an already-validated sidecar path. */
function savePendingDocumentAt(
	directory: string,
	resolved: string,
	doc: SkillUsagePendingDocument,
): void {
	ensureSwarmDir(resolved);
	doc.version = SKILL_USAGE_LIMITS.version;
	doc.coverage.floorPerSkill = SKILL_USAGE_LIMITS.floorPerSkill;
	// `resolved` is already inside the validated `.swarm` directory, so a
	// module-generated sibling basename cannot escape it — the same derivation
	// `pruneSkillUsageLog` uses for its own temp file.
	const tmpPath = siblingSwarmPath(
		resolved,
		`skill-usage-pending-${process.pid}-${_internals.now()}.tmp`,
	);
	const serialized = JSON.stringify(doc);
	try {
		_internals.writeFileSync(tmpPath, serialized, 'utf-8');
		_internals.renameSync(tmpPath, resolved);
	} catch (err) {
		try {
			if (_internals.existsSync(tmpPath)) _internals.unlinkSync(tmpPath);
		} catch {
			/* ignore cleanup failure */
		}
		_documentCache.delete(resolved);
		throw err instanceof Error ? err : new Error(String(err));
	}
	// The document just changed on disk; invalidate the derived caches, and
	// re-seed the text cache with the bytes we know the file now holds so the
	// next enqueue does not read back its own write.
	_coverageCache.delete(resolved);
	try {
		const { fingerprint } = statFingerprint(resolved);
		if (
			fingerprint !== null &&
			serialized.length <= MAX_CACHED_DOCUMENT_BYTES
		) {
			cacheSet(_documentCache, resolved, { fingerprint, text: serialized });
		} else {
			_documentCache.delete(resolved);
		}
	} catch {
		_documentCache.delete(resolved);
	}
	// Pressure is measured against the whole sidecar, which is what the byte
	// budget actually bounds; reusing the bytes we just wrote avoids a second
	// O(records) serialization pass on every save.
	_pressureDirectory = directory;
	refreshPressureFromCounts(doc.records.length, serialized.length);
}

// ============================================================================
// Coverage read path (cheap, mtime-keyed)
// ============================================================================

/**
 * Read just the manifest scalars a reader needs, using a `statSync`-keyed
 * cache so the 8 steady-state read sites do not each re-parse the sidecar.
 */
export function readPendingManifest(directory: string): {
	coverage: SkillUsageCoverage;
	migrated: boolean;
} {
	let resolved: string;
	try {
		resolved = resolvePendingPath(directory);
	} catch {
		return { coverage: emptyCoverage(), migrated: false };
	}
	let fingerprint: string | null;
	try {
		if (!_internals.existsSync(resolved)) {
			return { coverage: emptyCoverage(), migrated: false };
		}
		({ fingerprint } = statFingerprint(resolved));
	} catch {
		return { coverage: emptyCoverage(), migrated: false };
	}

	if (fingerprint !== null) {
		const cached = cacheGet(_coverageCache, resolved);
		if (cached && cached.fingerprint === fingerprint) {
			return { coverage: cached.coverage, migrated: cached.migrated };
		}
	}

	try {
		const cachedText =
			fingerprint === null ? undefined : cacheGet(_documentCache, resolved);
		const raw =
			cachedText !== undefined && cachedText.fingerprint === fingerprint
				? cachedText.text
				: (_internals.readFileSync(resolved, 'utf-8') as string);
		const doc = parsePendingDocument(raw);
		if (fingerprint !== null) {
			cacheSet(_coverageCache, resolved, {
				fingerprint,
				coverage: doc.coverage,
				migrated: doc.migrated,
			});
		}
		return { coverage: doc.coverage, migrated: doc.migrated };
	} catch {
		// Do not quarantine from a read path — reads take no lock. The next
		// lock-taking touch will quarantine and rebuild.
		return { coverage: emptyCoverage(), migrated: false };
	}
}

/**
 * Per-skill coverage rule (approved plan §8 / BLK-8), derived rather than
 * stored so the key set stays bounded.
 *
 * A skill's retained window may be used for a retire/revise decision when:
 *   (i)  global coverage is COMPLETE — nothing has ever been evicted, so the
 *        retained window IS the whole history and there is nothing for this
 *        gate to protect against; OR
 *   (ii) coverage is incomplete AND the sample is at least `curatorMinSample`
 *        AND the retained window is at least the most-recent `floorPerSkill`
 *        entries — retention guarantees each surviving skill
 *        `min(count, floorPerSkill)` most-recent entries, so
 *        `retained >= floorPerSkill` establishes the window's shape by
 *        construction.
 *
 * **Why the minimum-sample floor sits behind `coverage.complete` (issue #2038
 * implementation review, F2).** An earlier revision tested the floor FIRST, so a
 * skill with 3 uses and 3 violations was never retired even on a fully complete,
 * untruncated window. That silently narrowed shipped #1770/#1822 behavior, where
 * the retire trigger was `violationRate > 0.3` with no sample floor, and it had
 * nothing to do with compaction coverage — which is all this gate exists to
 * judge. On complete coverage the sample IS the truth, so the pre-existing
 * behavior applies unchanged; the floor is a statement about a TRUNCATED window
 * and only applies to one.
 *
 * Note that under the shipped constants (`floorPerSkill` 20 >= `curatorMinSample`
 * 10) the explicit `curatorMinSample` test below is subsumed by the floor
 * comparison. It is kept because the constants are independently tunable and a
 * sidecar may carry an older, smaller `coverage.floorPerSkill`; do not read it as
 * load-bearing at today's values.
 *
 * Returns false when the decision must be skipped (and counted).
 */
export function isSkillWindowTrustworthy(
	coverage: SkillUsageCoverage,
	retainedCount: number,
): boolean {
	if (coverage.complete) return true;
	if (retainedCount < SKILL_USAGE_LIMITS.curatorMinSample) return false;
	const floor =
		coverage.floorPerSkill > 0
			? coverage.floorPerSkill
			: SKILL_USAGE_LIMITS.floorPerSkill;
	return retainedCount >= floor;
}

// ============================================================================
// Queue bounds (approved plan §4) — `uncertain` must not become unbounded
// ============================================================================

function recordBytes(record: SkillUsagePendingRecord): number {
	return JSON.stringify(record).length + 1;
}

/** Total serialized size of the queue records. */
export function queueByteSize(doc: SkillUsagePendingDocument): number {
	let total = 0;
	for (const record of doc.records) total += recordBytes(record);
	return total;
}

function ageMsOf(record: SkillUsagePendingRecord, nowMs: number): number {
	const parsed = Date.parse(record.enqueuedAt);
	if (Number.isNaN(parsed)) return 0;
	return nowMs - parsed;
}

/**
 * Eviction preference: `uncertain` first (never consumable anyway), then
 * `pending` oldest-first, then `in_flight`.
 *
 * **DELIBERATE DIVERGENCE FROM APPROVED PLAN §4 — read before changing this.**
 * The plan says the hard cap evicts "the oldest `uncertain` (**never a
 * `pending`**)". This code evicts a `pending` when that is the only way back
 * under budget, and that is the intended behavior: a ceiling that a backlog of
 * `pending` records can pin is not a ceiling at all, so honoring the plan
 * literally would convert requirement 1's hard bound into an unbounded queue —
 * the exact failure mode issue #2038 exists to eliminate. The eviction is
 * reachable: 512 KiB of undrained records is on the order of 2,000 of them
 * (measured 199-302 B per serialized record — 199 B for a short skill path with
 * a runtime UUID id, 302 B for a long path with the 71-character content-hash id
 * minted for a migrated legacy entry — so roughly 1,700-2,600). It is hit on a
 * long run that never reaches a `phase_complete`, or on the one-time migration of
 * a large legacy log, so it is a real behavior, not a theoretical branch.
 *
 * The divergence is paid for by making it observable rather than implicit:
 * every budget eviction of an actionable record increments the dedicated
 * `pending_evicted` counter **and** `pressure`, and `pending_evicted` is on the
 * `skill_usage_health` payload. It deliberately does NOT increment `dropped`,
 * which would blend it with age expiry and make the divergence unmeasurable.
 *
 * `in_flight` is evicted LAST and only as an absolute last resort, because a
 * live consumption cycle in another process may be about to commit it — its
 * `dequeueRecords` / `retainWithRetry` would then silently no-op on a vanished
 * id. That loss must never be invisible, so the `else` branch below counts an
 * evicted `in_flight` record as `pending_evicted` + `pressure` exactly like a
 * `pending` one: `pending_evicted` means "an actionable record was evicted by
 * the budget", covering both states. Do not special-case `in_flight` out of
 * that branch.
 */
function evictionRank(record: SkillUsagePendingRecord): number {
	if (record.state === 'uncertain') return 0;
	if (record.state === 'pending') return 1;
	return 2;
}

/**
 * Apply the queue budget: age, record count, and byte size — to every record
 * including `uncertain` ones. Every discard is counted; none is silent.
 */
export function enforceQueueBounds(
	doc: SkillUsagePendingDocument,
	nowMs: number = _internals.now(),
): void {
	// 1. Age budget. Referenced against `enqueuedAt` (mint time), not the usage
	//    timestamp — a legacy entry migrated today is fresh work, not stale work.
	const survivors: SkillUsagePendingRecord[] = [];
	for (const record of doc.records) {
		if (ageMsOf(record, nowMs) > SKILL_USAGE_LIMITS.maxAgeMs) {
			if (record.state === 'uncertain') doc.counters.uncertain_expired += 1;
			else doc.counters.dropped += 1;
			continue;
		}
		survivors.push(record);
	}
	doc.records = survivors;

	// 2. Record-count and byte budgets.
	let bytes = queueByteSize(doc);
	let count = doc.records.length;
	const overBudget = (): boolean =>
		count > SKILL_USAGE_LIMITS.queueMaxRecords ||
		bytes > SKILL_USAGE_LIMITS.queueMaxBytes;

	if (overBudget()) {
		// Oldest-first within the preferred eviction class.
		const order = doc.records
			.map((record, index) => ({ record, index }))
			.sort((a, b) => {
				const rank = evictionRank(a.record) - evictionRank(b.record);
				if (rank !== 0) return rank;
				if (a.record.enqueuedAt !== b.record.enqueuedAt) {
					return a.record.enqueuedAt < b.record.enqueuedAt ? -1 : 1;
				}
				return a.index - b.index;
			});
		const evicted = new Set<SkillUsagePendingRecord>();
		for (const { record } of order) {
			if (!overBudget()) break;
			evicted.add(record);
			count -= 1;
			bytes -= recordBytes(record);
			if (record.state === 'uncertain') doc.counters.uncertain_expired += 1;
			else {
				// Budget eviction of actionable work — its own counter, never
				// `dropped` (which age expiry above owns). See {@link evictionRank}
				// for the recorded divergence from approved plan §4.
				doc.counters.pending_evicted += 1;
				doc.counters.pressure += 1;
			}
		}
		if (evicted.size > 0) {
			doc.records = doc.records.filter((record) => !evicted.has(record));
		}
	}

	refreshPressureFromCounts(doc.records.length, bytes);
}

// ---------------------------------------------------------------------------
// Requirement 5 — pressure is a POLICY, not just a counter
// ---------------------------------------------------------------------------

function refreshPressureFromCounts(records: number, bytes: number): void {
	_pressure =
		records >= SKILL_USAGE_LIMITS.queueMaxRecords ||
		bytes >= SKILL_USAGE_LIMITS.queueMaxBytes;
	_pressureCheckedAt = _internals.now();
}

/**
 * Whether optional (`not_checked`) usage appends must stop.
 *
 * Deliberately cheap: the hot delegation loop appends one entry per skill
 * path, so this must not take the lock or parse the sidecar. It reuses the
 * value computed by the last write and otherwise refreshes from a `statSync`
 * at most once per {@link PRESSURE_CACHE_MS}.
 */
export function isSkillUsageQueueUnderPressure(directory: string): boolean {
	const now = _internals.now();
	if (
		_pressureDirectory === directory &&
		now - _pressureCheckedAt < PRESSURE_CACHE_MS
	) {
		return _pressure;
	}
	_pressureDirectory = directory;
	_pressureCheckedAt = now;
	try {
		const resolved = resolvePendingPath(directory);
		if (!_internals.existsSync(resolved)) {
			_pressure = false;
			return false;
		}
		_pressure =
			_internals.statSync(resolved).size >= SKILL_USAGE_LIMITS.queueMaxBytes;
	} catch {
		_pressure = false;
	}
	return _pressure;
}

// ============================================================================
// Record operations (all operate on an in-memory doc held under the lock)
// ============================================================================

/**
 * Merge records into the document, deduped by `id` (approved plan BLK-10).
 * Returns the number actually added.
 */
export function mergePendingRecords(
	doc: SkillUsagePendingDocument,
	incoming: SkillUsageEnqueueInput[],
	nowIso: string,
): number {
	const known = new Set(doc.records.map((r) => r.id));
	let added = 0;
	for (const input of incoming) {
		if (known.has(input.id)) continue;
		known.add(input.id);
		doc.records.push({
			id: input.id,
			skillPath: input.skillPath,
			verdict: input.verdict,
			timestamp: input.timestamp,
			enqueuedAt: nowIso,
			state: 'pending',
			attempts: 0,
		});
		added += 1;
	}
	doc.counters.accepted += added;
	return added;
}

/**
 * Enqueue one actionable verdict.
 *
 * **Must be called BEFORE the JSONL append** (approved plan §2.2): a crash
 * between the two then leaves at worst an orphan queue record with no stats
 * row — harmless, because the record is self-sufficient. The reverse order
 * leaves an authoritative gap.
 *
 * **Throws** on lock failure or write failure so the caller aborts the append
 * and propagates (§2.3). This is the one path exempt from the skip-not-force
 * rule; the sole actionable caller already handles a throw.
 */
export function enqueueSkillUsageFeedback(
	directory: string,
	input: SkillUsageEnqueueInput,
): void {
	// Resolve ONCE. `validateSwarmPath` is the single most expensive step in an
	// enqueue on Windows, and the naive shape called it four times per record
	// (lock, load, save, save-temp). Both paths below are derived from one
	// validation of the sidecar path.
	let resolved: string;
	try {
		resolved = resolvePendingPath(directory);
	} catch {
		throw new Error(SKILL_USAGE_LOCK_UNAVAILABLE);
	}
	const handle = acquireSkillUsageLockOrThrowAt(
		siblingSwarmPath(resolved, SKILL_USAGE_LOCK_BASENAME),
	);
	try {
		const { doc } = loadPendingDocumentAt(directory, resolved);
		mergePendingRecords(doc, [input], new Date(_internals.now()).toISOString());
		enforceQueueBounds(doc);
		savePendingDocumentAt(directory, resolved, doc);
	} finally {
		releaseSkillUsageLock(handle);
	}
}

/**
 * Resolve claims abandoned by a crashed cycle.
 *
 * An `in_flight` record whose claim is older than the lock stale-break window
 * becomes `uncertain`: it survives and stays visible, but is never replayed —
 * satisfying both clauses of "survives ... and is consumed at most once".
 * A claim younger than that window belongs to a cycle that may still be
 * running in another process and is left alone.
 */
export function resolveStaleInFlight(
	doc: SkillUsagePendingDocument,
	nowMs: number = _internals.now(),
): number {
	let resolved = 0;
	for (const record of doc.records) {
		if (record.state !== 'in_flight') continue;
		const claimedAt = record.inFlightAt ? Date.parse(record.inFlightAt) : NaN;
		const age = Number.isNaN(claimedAt)
			? Number.POSITIVE_INFINITY
			: nowMs - claimedAt;
		// PR #2347 review (FB-009): same clock-skew shape as breakStaleLock — a
		// `claimedAt` in the future (clock skew at claim time) makes `age`
		// negative, and `age <= threshold` alone treats that as "not stale",
		// pinning the record `in_flight` forever and blocking the at-most-once
		// guarantee's resolution path. Compare magnitude, not sign.
		if (Math.abs(age) <= SKILL_USAGE_LOCK_STALE_MS) continue;
		record.state = 'uncertain';
		record.inFlightAt = undefined;
		resolved += 1;
	}
	return resolved;
}

/** Records eligible for consumption. `in_flight` and `uncertain` are excluded. */
export function selectConsumableRecords(
	doc: SkillUsagePendingDocument,
	sinceTimestamp?: string,
): SkillUsagePendingRecord[] {
	return doc.records.filter((record) => {
		if (record.state !== 'pending') return false;
		if (sinceTimestamp !== undefined && record.timestamp <= sinceTimestamp) {
			return false;
		}
		return true;
	});
}

/** Mark records claimed. Persist before releasing the lock. */
export function markRecordsInFlight(
	doc: SkillUsagePendingDocument,
	ids: Iterable<string>,
	nowIso: string = new Date(_internals.now()).toISOString(),
): void {
	const wanted = new Set(ids);
	for (const record of doc.records) {
		if (!wanted.has(record.id)) continue;
		record.state = 'in_flight';
		record.inFlightAt = nowIso;
	}
}

/** Normal-path dequeue after a bump that actually applied. No terminal counter. */
export function dequeueRecords(
	doc: SkillUsagePendingDocument,
	ids: Iterable<string>,
): number {
	const wanted = new Set(ids);
	const before = doc.records.length;
	doc.records = doc.records.filter((record) => !wanted.has(record.id));
	return before - doc.records.length;
}

/**
 * Terminal dequeue. Counted in `skill_usage_health` only — terminal outcomes
 * never increment `processed` / `bumps` (approved plan §3, E7).
 */
export function applyTerminalOutcome(
	doc: SkillUsagePendingDocument,
	ids: Iterable<string>,
	outcome: SkillUsageTerminalOutcome,
): number {
	const removed = dequeueRecords(doc, ids);
	doc.counters[outcome] += removed;
	return removed;
}

/**
 * Transient-failure handling: the record stays `pending` and its attempt
 * counter advances. At `maxAttempts` it goes terminal `bump_unrecoverable`,
 * so a permanently-locked directory cannot retain records forever.
 */
export function retainWithRetry(
	doc: SkillUsagePendingDocument,
	ids: Iterable<string>,
): { retried: string[]; unrecoverable: string[] } {
	const wanted = new Set(ids);
	const retried: string[] = [];
	const unrecoverable: string[] = [];
	for (const record of doc.records) {
		if (!wanted.has(record.id)) continue;
		record.attempts += 1;
		record.state = 'pending';
		record.inFlightAt = undefined;
		if (record.attempts >= SKILL_USAGE_LIMITS.maxAttempts) {
			unrecoverable.push(record.id);
		} else {
			retried.push(record.id);
		}
	}
	doc.counters.bump_retry += retried.length;
	if (unrecoverable.length > 0) {
		applyTerminalOutcome(doc, unrecoverable, 'bump_unrecoverable');
	}
	return { retried, unrecoverable };
}

// ============================================================================
// Health signal (approved plan §10)
// ============================================================================

/**
 * Payload shape of `telemetry.skillUsageHealth`. Counts only — **no
 * `skillPath` and no per-skill identifier**: the adversarial case in issue
 * #2038 is thousands of one-off skill IDs, so a per-skill label would be an
 * unbounded label set and nothing in `check-event-contract.ts` would catch it.
 */
export interface SkillUsageHealthPayload {
	trigger: 'compaction' | 'migration' | 'consumption' | 'pressure';
	accepted: number;
	compacted: number;
	dropped: number;
	skills_dropped: number;
	corrupt: number;
	pending_retained: number;
	uncertain_retained: number;
	uncertain_expired: number;
	/** Actionable records discarded by the queue budget (issue #2038 F3). */
	pending_evicted: number;
	no_source_knowledge: number;
	no_matching_knowledge: number;
	bump_retry: number;
	bump_unrecoverable: number;
	bump_applied_zero: number;
	pressure: number;
	curator_skipped: number;
	bytes: number;
	limit_bytes: number;
	oldest_timestamp: string | null;
	newest_timestamp: string | null;
	coverage: boolean;
}

/** Build the health payload from durable counters plus live gauges. */
export function buildSkillUsageHealthPayload(
	doc: SkillUsagePendingDocument,
	trigger: SkillUsageHealthPayload['trigger'],
	gauges: { bytes: number; limitBytes: number },
): SkillUsageHealthPayload {
	let pendingRetained = 0;
	let uncertainRetained = 0;
	for (const record of doc.records) {
		if (record.state === 'uncertain') uncertainRetained += 1;
		else pendingRetained += 1;
	}
	return {
		trigger,
		accepted: doc.counters.accepted,
		compacted: doc.counters.compacted,
		dropped: doc.counters.dropped,
		skills_dropped: doc.counters.skills_dropped,
		corrupt: doc.counters.corrupt,
		pending_retained: pendingRetained,
		uncertain_retained: uncertainRetained,
		uncertain_expired: doc.counters.uncertain_expired,
		pending_evicted: doc.counters.pending_evicted,
		no_source_knowledge: doc.counters.no_source_knowledge,
		no_matching_knowledge: doc.counters.no_matching_knowledge,
		bump_retry: doc.counters.bump_retry,
		bump_unrecoverable: doc.counters.bump_unrecoverable,
		bump_applied_zero: doc.counters.bump_applied_zero,
		pressure: doc.counters.pressure,
		curator_skipped: doc.counters.curator_skipped,
		bytes: gauges.bytes,
		limit_bytes: gauges.limitBytes,
		oldest_timestamp: doc.coverage.oldestRetained,
		newest_timestamp: doc.coverage.newestRetained,
		coverage: doc.coverage.complete,
	};
}

/** Emit the health signal. Never throws — observability must not break a write. */
export function emitSkillUsageHealth(
	doc: SkillUsagePendingDocument,
	trigger: SkillUsageHealthPayload['trigger'],
	gauges: { bytes: number; limitBytes: number },
): void {
	try {
		_internals.emitHealth(buildSkillUsageHealthPayload(doc, trigger, gauges));
	} catch (err) {
		logger.log(
			'[skill-usage-pending] health emit failed (best-effort):',
			err instanceof Error ? err.message : String(err),
		);
	}
}

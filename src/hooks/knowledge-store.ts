/** Core storage layer for the opencode-swarm v6.17 two-tier knowledge system. */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	resolveHiveDataDir,
	resolveHiveEventsPath as resolveHiveEventsPathImpl,
	resolveHiveKnowledgePath as resolveHiveKnowledgePathImpl,
	resolveHiveRejectedPath as resolveHiveRejectedPathImpl,
} from '../knowledge/hive-paths.js';
import * as logger from '../utils/logger.js';
import { readCachedParsedFile } from '../utils/swarm-artifact-cache.js';
import { resolveKnowledgeStoreDir } from './knowledge-link.js';
import { reinforceSwarmKnowledgeEntry } from './knowledge-reinforcement.js';
import type {
	ActionableDirectiveFields,
	KnowledgeEntryBase,
	RejectedLesson,
	RetrievalOutcome,
	RewriteHistoryRecord,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';

const KNOWLEDGE_JSONL_CACHE_NAMESPACE = 'knowledge-jsonl:normalized:v1';

// ============================================================================
// Path Resolvers
// ============================================================================

// Returns the platform-specific config directory for opencode-swarm
export function getPlatformConfigDir(): string {
	const platform = process.platform;
	// Read $HOME live each call so test redirection via process.env.HOME works.
	// Bun caches os.homedir(), so changing $HOME after first call is ignored.
	const home = process.env.HOME || os.homedir();
	if (platform === 'win32') {
		return path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'config',
		);
	} else if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'opencode-swarm');
	} else {
		return path.join(
			process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
			'opencode-swarm',
		);
	}
}

// Returns path to knowledge.jsonl for the project directory. Redirects to the
// shared link store when the worktree is linked (resolveKnowledgeStoreDir);
// otherwise byte-identical to <directory>/.swarm/knowledge.jsonl.
export function resolveSwarmKnowledgePath(directory: string): string {
	return path.join(resolveKnowledgeStoreDir(directory), 'knowledge.jsonl');
}

// Returns path to knowledge-rejected.jsonl (link-aware).
export function resolveSwarmRejectedPath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-rejected.jsonl',
	);
}

// Returns path to knowledge-retractions.jsonl (link-aware).
export function resolveSwarmRetractionsPath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-retractions.jsonl',
	);
}

// Returns path to knowledge-rewrites.jsonl (link-aware, #1848 §3).
// Cohort-scoped append-only audit log of immutable before/after rewrite+merge
// history. NOT a KNOWLEDGE_FAMILY migration member (append-only audit, not
// id-mergeable); cohort-shared naturally via resolveKnowledgeStoreDir.
export function resolveRewriteHistoryPath(directory: string): string {
	return path.join(
		resolveKnowledgeStoreDir(directory),
		'knowledge-rewrites.jsonl',
	);
}

// Cross-project hive path resolution is centralized in
// `src/knowledge/hive-paths.ts` (issue #1847 §1) so the store, the rejected
// log, and the audit-event log always share one directory and one platform
// branch. Re-exported here to preserve the historical import surface.
export const resolveHiveKnowledgePath = resolveHiveKnowledgePathImpl;
export const resolveHiveRejectedPath = resolveHiveRejectedPathImpl;
export const resolveHiveEventsPath = resolveHiveEventsPathImpl;
export { resolveHiveDataDir };

// ============================================================================
// Read Functions
// ============================================================================

// Parse JSONL knowledge content, stopping after `max` valid entries. Skips
// unparseable lines (with a warning). Used by both the cached (uncapped) and
// bypass (capped) read paths.
function parseKnowledgeContent<T>(content: string, max: number): T[] {
	const results: T[] = [];
	for (const line of content.split('\n')) {
		if (Number.isFinite(max) && results.length >= max) break;
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			results.push(normalizeEntry(JSON.parse(trimmed) as T));
		} catch {
			logger.log(
				`[knowledge-store] Skipping corrupted JSONL line: ${trimmed.slice(
					0,
					80,
				)}`,
			);
		}
	}
	return results;
}

// Read JSONL file. Skip lines that fail JSON.parse (log a warning for each skipped line).
// Returns empty array if file does not exist.
// v2: each parsed entry is passed through normalizeEntry() so v1 entries get
// optional v2 fields filled in WITHOUT mutating on-disk JSONL.
//
// Optional maxEntries cap: when provided as a positive finite number, parsing stops
// after that many valid entries are collected, preventing unbounded memory growth
// when reading large files. Capped reads BYPASS the cache to prevent a capped read
// from poisoning the cache for uncapped callers (cache key does not include maxEntries).
export async function readKnowledge<T>(
	filePath: string,
	maxEntries?: number,
): Promise<T[]> {
	const resolvedPath = path.resolve(filePath);
	const cap =
		maxEntries !== undefined && maxEntries > 0 ? maxEntries : undefined;

	// Capped reads BYPASS the cache: the cache key does not include maxEntries,
	// so a capped read must not poison the cache for uncapped callers.
	if (cap !== undefined) {
		if (!existsSync(resolvedPath)) return [];
		const content = await readFile(resolvedPath, 'utf-8');
		return parseKnowledgeContent<T>(content, cap);
	}

	const entries = await readCachedParsedFile<T[]>(
		resolvedPath,
		KNOWLEDGE_JSONL_CACHE_NAMESPACE,
		async () => {
			if (!existsSync(resolvedPath)) return null;
			return await readFile(resolvedPath, 'utf-8');
		},
		(content) => parseKnowledgeContent<T>(content, Infinity),
	);
	return entries ?? [];
}

// v2: Normalize a parsed entry to the current shape in memory.
// Adds defaulted retrieval-outcome counters for v1 entries; leaves on-disk JSONL untouched.
// Pass-through for non-knowledge types (RejectedLesson) — only mutates objects with retrieval_outcomes.
export function normalizeEntry<T>(raw: T): T {
	if (!raw || typeof raw !== 'object') return raw;
	const obj = raw as unknown as Record<string, unknown>;
	if (!('retrieval_outcomes' in obj)) return raw;
	// Legacy entries may have retrieval_outcomes: null or a non-object value.
	// Replace null/non-object with an empty record so v2 backfill below runs
	// and the entry surfaces with deterministic counters.
	let ro = obj.retrieval_outcomes as Record<string, unknown> | null;
	if (!ro || typeof ro !== 'object') {
		ro = {};
		obj.retrieval_outcomes = ro;
	}
	// Migrate: legacy 'applied_count' represented "shown" before v2.
	// We preserve it as-is for backward compatibility, but ensure all v2
	// counters exist with sane defaults.
	if (typeof ro.shown_count !== 'number') {
		ro.shown_count =
			typeof ro.applied_count === 'number' ? ro.applied_count : 0;
	}
	if (typeof ro.acknowledged_count !== 'number') ro.acknowledged_count = 0;
	if (typeof ro.applied_explicit_count !== 'number') {
		ro.applied_explicit_count = 0;
	}
	if (typeof ro.ignored_count !== 'number') ro.ignored_count = 0;
	if (typeof ro.violated_count !== 'number') ro.violated_count = 0;
	if (typeof ro.contradicted_count !== 'number') ro.contradicted_count = 0;
	if (typeof ro.succeeded_after_shown_count !== 'number') {
		ro.succeeded_after_shown_count =
			typeof ro.succeeded_after_count === 'number'
				? ro.succeeded_after_count
				: 0;
	}
	if (typeof ro.failed_after_shown_count !== 'number') {
		ro.failed_after_shown_count =
			typeof ro.failed_after_count === 'number' ? ro.failed_after_count : 0;
	}
	// Backfill encounter_score for entries created before this field existed.
	// Legacy hive entries may lack encounter_score; default to 0 per spec FR-002.
	// try/catch guards against throwing getters (prototype pollution edge case).
	try {
		if (
			typeof obj.encounter_score !== 'number' ||
			Number.isNaN(obj.encounter_score)
		) {
			obj.encounter_score = 0;
		}
	} catch {
		// Throwing getter or Proxy trap — define own property directly
		// to bypass setter semantics on poisoned accessors
		try {
			Object.defineProperty(obj, 'encounter_score', {
				value: 0,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		} catch {
			// Completely frozen/sealed object — nothing we can do
		}
	}
	// G7 (#1716): default the demotion counter for entries created before this
	// field existed. `last_demotion_phase` and the G6 archive metadata
	// (`archived_from`, `archived_at`) are left `undefined` if absent — they're
	// optional and old entries simply haven't been archived/demoted yet.
	if (typeof obj.recent_negative_phase_count !== 'number') {
		obj.recent_negative_phase_count = 0;
	}
	// #1847 PRR-2: ensure confirmed_by is an array. Legacy/malformed on-disk
	// records may omit it (null/undefined), and hive promotion's confirmation
	// loop calls .push/.some on it directly — a missing array would throw
	// mid-transaction. Backfill to [] in memory; never synthesize cohort ids.
	if (!Array.isArray(obj.confirmed_by)) {
		obj.confirmed_by = [];
	}
	// Ensure actionable arrays are at least undefined-or-array (never wrong type).
	const arrayFields: Array<keyof ActionableDirectiveFields> = [
		'triggers',
		'required_actions',
		'forbidden_actions',
		'applies_to_agents',
		'applies_to_tools',
		'verification_checks',
		'source_refs',
		'source_knowledge_ids',
	];
	for (const f of arrayFields) {
		const v = obj[f as string];
		if (v !== undefined && !Array.isArray(v)) {
			delete obj[f as string];
		}
	}
	// Default a non-array tags field so downstream readers that access
	// `tags.length` (ranking, dedup) never throw on a malformed entry. We do NOT
	// coerce `lesson`: consumers like the curator legitimately handle an object
	// lesson (JSON.stringify), and the normalize() helper tolerates non-strings.
	if (!Array.isArray(obj.tags)) {
		obj.tags = [];
	}
	// #1848 §3 (v3): default the revision counter to 0 for legacy entries.
	// 0 means "no CAS history yet" — the first mutation (authorized separately
	// by the curation-policy layer) stamps revision 1. We deliberately do NOT
	// synthesize `producer` (absent = unknown-owner = protected), and we do NOT
	// compute `content_hash` here (computed at write/mutation time only to avoid
	// per-read SHA-256 over thousands of cohort entries — see C-7 fix).
	if (typeof obj.revision !== 'number' || Number.isNaN(obj.revision)) {
		obj.revision = 0;
	}
	return raw;
}

/**
 * Compute a 12-hex SHA-256 prefix of a lesson string (issue #1848 §3).
 * Used as the `content_hash` CAS token, stamped at write/mutation time only.
 * Mirrors the style of `lessonRevision()` in hive-promoter.ts.
 */
export function computeContentHash(lesson: string): string {
	return createHash('sha256').update(lesson, 'utf8').digest('hex').slice(0, 12);
}

// Reads from the swarm-level rejected lessons file
export async function readRejectedLessons(
	directory: string,
): Promise<RejectedLesson[]> {
	return readKnowledge<RejectedLesson>(resolveSwarmRejectedPath(directory));
}

export interface KnowledgeRetractionRecord {
	id: string;
	retracted_lesson: string;
	normalized_lesson: string;
	recorded_at: string;
	reported_by: 'architect' | 'user' | 'auto';
	matched_swarm_ids: string[];
	matched_hive_ids: string[];
}

export async function readRetractionRecords(
	directory: string,
): Promise<KnowledgeRetractionRecord[]> {
	return readKnowledge<KnowledgeRetractionRecord>(
		resolveSwarmRetractionsPath(directory),
	);
}

export async function appendRetractionRecord(
	directory: string,
	record: KnowledgeRetractionRecord,
): Promise<void> {
	await appendKnowledge(resolveSwarmRetractionsPath(directory), record);
}

/**
 * Append an immutable rewrite/merge history record to the cohort-scoped audit
 * log (issue #1848 §3). FIFO-capped at 2000 entries so the audit trail is
 * bounded. Fail-open: a history-append failure must not abort the mutation that
 * already committed (the mutation is the source of truth; history is audit).
 */
export async function appendRewriteHistory(
	directory: string,
	record: RewriteHistoryRecord,
): Promise<void> {
	const filePath = resolveRewriteHistoryPath(directory);
	const MAX_REWRITE_HISTORY = 2000;
	await transactKnowledge<RewriteHistoryRecord>(filePath, (entries) => {
		const next = [...entries, record];
		return next.length > MAX_REWRITE_HISTORY
			? next.slice(next.length - MAX_REWRITE_HISTORY)
			: next;
	}).catch((err) => {
		// Fail-open: history is audit, not source of truth.
		logger.log(
			`[knowledge-store] appendRewriteHistory failed (non-blocking): ${String(err)}`,
		);
	});
}

/**
 * Read rewrite/merge history records (issue #1848 §3). Used for audit/recovery.
 */
export async function readRewriteHistory(
	directory: string,
): Promise<RewriteHistoryRecord[]> {
	return readKnowledge<RewriteHistoryRecord>(
		resolveRewriteHistoryPath(directory),
	);
}

// ============================================================================
// Write Functions
// ============================================================================

// Append a single entry to a JSONL file, creating the directory if needed.
// Acquires the same directory-level lock as enforceKnowledgeCap and rewriteKnowledge
// to prevent TOCTOU races: a concurrent cap enforcement must not interleave with
// appends, and vice versa. The lock is on the directory (not the file) because
// proper-lockfile requires the target to exist; the directory is guaranteed to
// exist after mkdir.
export async function appendKnowledge<T>(
	filePath: string,
	entry: T,
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });

	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});
		await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — non-blocking */
			}
		}
	}
}

// Rewrite the entire JSONL file with a new array of entries.
// Uses proper-lockfile on the directory for concurrent-access safety.
// The file write itself uses atomic temp-file + rename so readers never observe a torn file.
// The lock is acquired on the DIRECTORY (not the file) because proper-lockfile requires
// the target to exist. The directory is guaranteed to exist after mkdir.
export async function rewriteKnowledge<T>(
	filePath: string,
	entries: T[],
): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });

	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});
		const content =
			entries.map((e) => JSON.stringify(e)).join('\n') +
			(entries.length > 0 ? '\n' : '');
		await atomicWriteFile(filePath, content);
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — log warning */
			}
		}
	}
}

// Generic atomic locked read-modify-write for any file type.
// Acquires a directory lock, reads data via `read`, calls `mutate()`, and if
// mutate returns non-null, writes via `write`. Returns true if a write occurred.
export async function transactFile<T>(
	filePath: string,
	read: (filePath: string) => Promise<T>,
	write: (filePath: string, data: T) => Promise<void>,
	mutate: (data: T) => T | null,
): Promise<boolean> {
	const dir = path.dirname(filePath);
	try {
		await mkdir(dir, { recursive: true });
	} catch {
		// Directory creation failed (path traversal, null byte, permissions, etc.)
		// Safe fallback: treat as no-op.
		return false;
	}

	let release: (() => Promise<void>) | null = null;
	try {
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});
		const data = await read(filePath);
		const result = mutate(data);
		if (result === null) return false;
		await write(filePath, result);
		return true;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — non-blocking */
			}
		}
	}
}

// Perform an atomic locked read-modify-write on a JSONL file.
// Acquires a directory lock, reads all entries, calls mutate() with them,
// and if mutate returns a non-null array, writes the result crash-atomically
// via temp-file + rename (atomicWriteFile). Returns true if the file was
// rewritten, false if mutate returned null (no-op).
//
// All callers that need a lock-before-read pattern (TOCTOU prevention) or
// crash-atomic writes (MF-5 prevention) MUST use this function.
// NOTE: Directory-level locking means all JSONL files in .swarm/ (knowledge.jsonl,
// knowledge-rejected.jsonl, knowledge-retractions.jsonl, etc.) share the same lock.
// This is an intentional correctness trade-off: it prevents TOCTOU races between
// concurrent operations on different files in the same directory, at the cost of
// serializing operations that could theoretically run in parallel. In practice,
// knowledge operations are infrequent enough that contention is not a concern.
export async function transactKnowledge<T>(
	filePath: string,
	mutate: (entries: T[]) => T[] | null,
): Promise<boolean> {
	return transactFile<T[]>(
		filePath,
		readKnowledge,
		async (fp, entries) => {
			const content =
				entries.map((e) => JSON.stringify(e)).join('\n') +
				(entries.length > 0 ? '\n' : '');
			await atomicWriteFile(fp, content);
		},
		mutate,
	);
}

/**
 * Compare-and-swap guarded mutation for a single entry (issue #1848 §3).
 *
 * Runs inside the existing directory lock (lock-before-read). Finds the entry
 * by `id`. If `expectedRevision`/`expectedContentHash` are provided and the
 * current entry's revision/content_hash do not match, the mutation is SKIPPED
 * and `{committed:false, casFailed:true}` is returned — a stale curator plan is
 * rejected, NOT silently applied. This closes the lost-update hazard where a
 * plan generated from a stale snapshot overwrites an entry a sibling worktree
 * just updated.
 *
 * On an accepted mutation: bumps `revision`, recomputes `content_hash`, stamps
 * `updated_at`, and (when `apply` returns a `RewriteHistoryRecord`) appends the
 * immutable before/after audit record. Authorization is the CALLER's
 * responsibility (run `authorizeCuration` BEFORE calling this); CAS enforces
 * the revision contract INSIDE the transaction.
 *
 * Legacy entry (revision 0/undefined): CAS with `expectedRevision === undefined`
 * is allowed (the first authorized mutation stamps revision 1). The
 * unknown-owner-protected case never reaches here because authorizeCuration
 * returns a proposal instead of authorizing.
 */
export async function transactKnowledgeWithCas<
	T extends {
		id: string;
		revision?: number;
		content_hash?: string;
		lesson?: string;
		updated_at?: string;
	},
>(
	directory: string,
	filePath: string,
	entryId: string,
	expectedRevision: number | undefined,
	expectedContentHash: string | undefined,
	apply: (entry: T) => {
		mutated: T;
		rewriteHistory?: RewriteHistoryRecord;
	} | null,
): Promise<{ committed: boolean; casFailed: boolean }> {
	let committed = false;
	let casFailed = false;
	const rewrote = await transactKnowledge<T>(filePath, (entries) => {
		const idx = entries.findIndex((e) => e?.id === entryId);
		if (idx === -1) return null; // entry not found — no-op
		const entry = entries[idx];
		// CAS check: if a revision/content-hash expectation was provided, the
		// current entry must match. A mismatch means the snapshot the plan was
		// built on is stale → skip, do NOT silently overwrite.
		if (
			expectedRevision !== undefined &&
			(entry.revision ?? 0) !== expectedRevision
		) {
			casFailed = true;
			return null;
		}
		if (
			expectedContentHash !== undefined &&
			(entry.content_hash ?? '') !== expectedContentHash
		) {
			casFailed = true;
			return null;
		}
		const result = apply(entry);
		if (result === null) return null;
		// Stamp the CAS revision + content hash on the accepted mutation.
		const stamped: T = {
			...result.mutated,
			revision: (entry.revision ?? 0) + 1,
			updated_at: new Date().toISOString(),
		};
		if (typeof stamped.lesson === 'string') {
			(stamped as { content_hash?: string }).content_hash = computeContentHash(
				stamped.lesson,
			);
		}
		// Append rewrite history (fire-and-forget after the txn commits — but
		// we capture the record here so it's consistent with the mutation).
		if (result.rewriteHistory) {
			// Queue the history append; the txn write is the source of truth.
			// We do this synchronously-captured but asynchronously-appended
			// below (outside the lock) to keep the critical section short.
			queueMicrotask(() => {
				appendRewriteHistory(directory, result.rewriteHistory!).catch(() => {});
			});
		}
		const next = entries.slice();
		next[idx] = stamped;
		committed = true;
		return next;
	});
	return { committed: committed && rewrote, casFailed };
}

// Read all archived/quarantined entry IDs from the swarm AND hive knowledge stores.
// Returns a Set of IDs whose status is 'archived' or 'quarantined'.
// Returns an empty set if neither file exists or is unreadable.
export async function getArchivedKnowledgeIds(
	directory: string,
): Promise<Set<string>> {
	const archived = new Set<string>();

	// Swarm entries
	const swarmPath = resolveSwarmKnowledgePath(directory);
	try {
		const content = await readFile(swarmPath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim());
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				// G4 (#1716): canonical helper — single source of truth for the
				// inactive set. Note this is "not active" rather than status ===
				// 'archived' so it agrees with retrieval filters end-to-end.
				if (!isActiveStatus(entry.status)) {
					archived.add(entry.id);
				}
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// file doesn't exist yet — return whatever we have
	}

	// Hive entries
	const hivePath = resolveHiveKnowledgePath();
	try {
		const content = await readFile(hivePath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim());
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (!isActiveStatus(entry.status)) {
					archived.add(entry.id);
				}
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// file doesn't exist yet — return whatever we have
	}

	return archived;
}

// Append a knowledge entry and enforce the cap in a single atomic transaction.
// This prevents the race condition where entry is appended but cap enforcement fails.
// Returns true if entry was appended and cap enforced, false if entry was not appended
// (e.g., would exceed cap even as a single entry - should not happen with normal configs).
export async function appendKnowledgeWithCapEnforcement<T>(
	filePath: string,
	entry: T,
	maxEntries: number,
): Promise<boolean> {
	return transactKnowledge<T>(filePath, (entries) => {
		// Add the new entry
		const updated = [...entries, entry as T];

		// Enforce the cap if needed
		if (updated.length > maxEntries) {
			return selectKnowledgeCapSurvivors(updated, maxEntries);
		}
		return updated;
	});
}

// Enforce a priority-aware max-entries cap on a JSONL file.
// If the file exceeds `maxEntries`, inactive and low-outcome entries are
// dropped first. Promoted entries are never evicted unless every entry is
// promoted, because promoted knowledge has already escaped swarm-local TTL.
// No-op when the file has fewer entries than the cap.
// The full read-modify-write cycle is atomic under a directory lock to
// prevent concurrent appendKnowledge from inserting entries that get
// silently dropped by the rewrite (TOCTOU race condition).
export async function enforceKnowledgeCap<T>(
	filePath: string,
	maxEntries: number,
): Promise<void> {
	await transactKnowledge<T>(filePath, (entries) => {
		if (entries.length <= maxEntries) return null;
		return selectKnowledgeCapSurvivors(entries, maxEntries);
	});
}

interface KnowledgeCapCandidate<T> {
	entry: T;
	index: number;
	status?: KnowledgeEntryBase['status'];
	outcomeSignal: number;
}

export function selectKnowledgeCapSurvivors<T>(
	entries: T[],
	maxEntries: number,
): T[] {
	if (entries.length <= maxEntries) return entries;
	if (maxEntries <= 0) return [];

	const candidates = entries.map((entry, index): KnowledgeCapCandidate<T> => {
		const maybeKnowledge = entry as Partial<KnowledgeEntryBase>;
		return {
			entry,
			index,
			status: maybeKnowledge.status,
			outcomeSignal: computeOutcomeSignal(maybeKnowledge.retrieval_outcomes),
		};
	});
	const allPromoted = candidates.every((c) => c.status === 'promoted');
	const evictable = allPromoted
		? candidates
		: candidates.filter((c) => c.status !== 'promoted');
	const targetDropCount = entries.length - maxEntries;
	const dropCount = Math.min(targetDropCount, evictable.length);
	if (dropCount <= 0) return entries;

	const drop = new Set(
		[...evictable]
			.sort((a, b) => {
				const inactiveDelta =
					getKnowledgeCapStatusPriority(a.status) -
					getKnowledgeCapStatusPriority(b.status);
				if (inactiveDelta !== 0) return inactiveDelta;
				const signalDelta = a.outcomeSignal - b.outcomeSignal;
				if (signalDelta !== 0) return signalDelta;
				return a.index - b.index;
			})
			.slice(0, dropCount)
			.map((c) => c.index),
	);

	return candidates.filter((c) => !drop.has(c.index)).map((c) => c.entry);
}

function getKnowledgeCapStatusPriority(
	status?: KnowledgeEntryBase['status'],
): number {
	// G4 (#1716): canonical helper. Inactive statuses get the lowest priority.
	if (!isActiveStatus(status)) {
		return 0;
	}
	return 1;
}

// Results from a sweep operation (aging or TODO removal)
export interface SweepResult {
	scanned: number;
	aged: number;
	archived: number;
	removed: number;
	skipped_promoted: number;
}

// Increment phases_alive on all non-archived, non-promoted entries and archive
// those exceeding their TTL. Archives entries by setting status='archived' and
// updated_at timestamp; does not remove them from the JSONL (FIFO cap removes later).
// Promoted entries are TTL-exempt but still skipped (no age bumping for promoted).
export async function sweepAgedEntries<T extends KnowledgeEntryBase>(
	filePath: string,
	defaultMaxPhases: number,
): Promise<SweepResult> {
	const result: SweepResult = {
		scanned: 0,
		aged: 0,
		archived: 0,
		removed: 0,
		skipped_promoted: 0,
	};

	await transactKnowledge<T>(filePath, (entries) => {
		result.scanned = entries.length;
		if (entries.length === 0) return null;

		const now = new Date().toISOString();
		let mutated = false;
		for (const entry of entries) {
			// Skip age bumps for archived entries (already dead, no churn)
			if (entry.status === 'archived') continue;

			// Skip promoted entries: do not increment age and do not archive them
			// (promoted entries have unlimited TTL per feature design).
			if (entry.status === 'promoted') {
				result.skipped_promoted++;
				continue;
			}

			// Bump age and test against TTL. Any age change must persist.
			entry.phases_alive = (entry.phases_alive ?? 0) + 1;
			result.aged++;
			mutated = true;

			const ttl = entry.max_phases ?? defaultMaxPhases;
			// max_phases=N means entry can live N complete phases; archive on N+1.
			if (entry.phases_alive > ttl) {
				// G6 (#1716): record prior status so `unarchiveEntry` can restore.
				// (Promoted entries never reach here — they skip the loop body.)
				entry.archived_from = entry.status;
				entry.archived_at = now;
				entry.status = 'archived';
				entry.updated_at = now;
				result.archived++;
			}
		}

		return mutated ? entries : null;
	});

	return result;
}

// Hard-remove todo-category entries that have aged past todoMaxPhases.
// Other entry categories are untouched; general aging is handled by sweepAgedEntries.
export async function sweepStaleTodos<T extends KnowledgeEntryBase>(
	filePath: string,
	todoMaxPhases: number,
): Promise<SweepResult> {
	const result: SweepResult = {
		scanned: 0,
		aged: 0,
		archived: 0,
		removed: 0,
		skipped_promoted: 0,
	};

	await transactKnowledge<T>(filePath, (entries) => {
		result.scanned = entries.length;
		if (entries.length === 0) return null;

		const kept = entries.filter((e) => {
			// Promoted entries are TTL-exempt per design, even for TODO category.
			if (e.category !== 'todo' || e.status === 'promoted') return true;
			const age = e.phases_alive ?? 0;
			if (age > todoMaxPhases) {
				result.removed++;
				return false;
			}
			return true;
		});

		return result.removed > 0 ? kept : null;
	});

	return result;
}

// Append a RejectedLesson, enforcing a FIFO max cap.
// The full read-check-write is atomic under a directory lock (transactKnowledge)
// to prevent concurrent callers from both reading below the cap and both appending,
// ending up with more than MAX entries or silently losing a lesson (CF-2 TOCTOU fix).
export async function appendRejectedLesson(
	directory: string,
	lesson: RejectedLesson,
	maxEntries = 20,
): Promise<void> {
	const filePath = resolveSwarmRejectedPath(directory);
	await transactKnowledge<RejectedLesson>(filePath, (existing) => {
		const updated = [...existing, lesson];
		if (updated.length > maxEntries) {
			return updated.slice(updated.length - maxEntries);
		}
		return updated;
	});
}

// ============================================================================
// Utility Functions (pure — no I/O)
// ============================================================================

// Normalize a string for comparison: lowercase, collapse whitespace, strip punctuation
export function normalize(text: string): string {
	// Tolerate non-string input (a malformed on-disk lesson) without throwing,
	// so a single corrupt entry can't fail an entire read. The stored entry is
	// left untouched — only this derived form is coerced.
	const s = typeof text === 'string' ? text : String(text ?? '');
	return s
		.toLowerCase()
		.replace(/[^\w\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Generate word bigrams from a string
export function wordBigrams(text: string): Set<string> {
	const words = normalize(text).split(' ').filter(Boolean);
	const bigrams = new Set<string>();
	for (let i = 0; i < words.length - 1; i++) {
		bigrams.add(`${words[i]} ${words[i + 1]}`);
	}
	return bigrams;
}

// Compute Jaccard similarity between two bigram sets
export function jaccardBigram(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1.0;
	const aArr = Array.from(a);
	const intersection = new Set(aArr.filter((x) => b.has(x)));
	const union = new Set([...aArr, ...Array.from(b)]);
	return intersection.size / union.size;
}

// Find a near-duplicate entry in an array. Returns the first entry with
// Jaccard bigram similarity >= threshold (default 0.6) or undefined if none found.
export function findNearDuplicate<T extends { lesson: string }>(
	candidate: string,
	entries: T[],
	threshold = 0.6,
): T | undefined {
	const candidateBigrams = wordBigrams(candidate);
	return entries.find((entry) => {
		const entryBigrams = wordBigrams(entry.lesson);
		return jaccardBigram(candidateBigrams, entryBigrams) >= threshold;
	});
}

// Compute a confidence score for a new swarm entry based on initial metadata.
// Starting confidence: 0.5 (unconfirmed candidate). Boosted by:
// +0.1 for each non-null confirmed_by record (up to 3 boosts = 0.8 max from this)
// +0.1 if auto_generated is false (human-originated)
export function computeConfidence(
	confirmedByCount: number,
	autoGenerated: boolean,
): number {
	let score = 0.5;
	score += Math.min(confirmedByCount, 3) * 0.1;
	if (!autoGenerated) score += 0.1;
	return Math.min(score, 1.0);
}

/**
 * Soft cap on the number of {@link PhaseConfirmationRecord}s retained per entry.
 * Distinct-phase COUNT is the signal that matters (skill-maturity gate,
 * `✓`/`✓✓` markers); the array itself only needs enough history to represent
 * realistic multi-phase confirmation. Capped for hygiene on long-lived entries;
 * oldest records are evicted. Issue #1768.
 */
export const MAX_CONFIRMED_BY = 50;

/**
 * Confirm that a set of knowledge entries was surfaced during a phase, by
 * appending a {@link PhaseConfirmationRecord} to each entry's `confirmed_by`
 * (issue #1768 defect 3). Retrieval/injection is the confirmation signal —
 * previously `confirmed_by` only grew on near-duplicate re-add, so the
 * skill-maturity `distinctPhases >= 2` gate was unsatisfiable in practice.
 *
 * Reuses {@link reinforceSwarmKnowledgeEntry} as the canonical writer so
 * `confidence` stays consistent with `confirmed_by` (it recomputes confidence
 * and applies the same-phase dedup + inactive-entry guard). All entries are
 * mutated in ONE locked `transactKnowledge` transaction (mirroring the curator
 * batch pattern) — never one lock per id. Fail-open: confirmation is
 * best-effort and must never break injection.
 */
export async function confirmEntriesPhase(
	directory: string,
	ids: string[],
	phaseNumber: number,
	projectName: string,
): Promise<void> {
	if (ids.length === 0) return;
	const knowledgePath = resolveSwarmKnowledgePath(directory);
	await transactKnowledge<SwarmKnowledgeEntry>(knowledgePath, (current) => {
		const idSet = new Set(ids);
		let changed = false;
		const now = new Date().toISOString();
		for (const entry of current) {
			if (!idSet.has(entry.id)) continue;
			const result = reinforceSwarmKnowledgeEntry(entry, {
				phase_number: phaseNumber,
				confirmed_at: now,
				project_name: projectName,
			});
			if (result.reinforced) {
				// Hygiene cap: evict oldest beyond MAX_CONFIRMED_BY so the array
				// cannot grow unbounded on long-lived entries.
				const records = entry.confirmed_by ?? [];
				if (records.length > MAX_CONFIRMED_BY) {
					entry.confirmed_by = [...records]
						.sort((a, b) => a.confirmed_at.localeCompare(b.confirmed_at))
						.slice(-MAX_CONFIRMED_BY);
					// Recompute confidence from the RETAINED set so the entry stays
					// internally consistent (reinforceSwarmKnowledgeEntry computed it
					// from the pre-cap array). distinctPhaseCount is what feeds
					// computeConfidence, and the cap preserves the most-recent
					// records, so in practice this only matters at the extreme tail.
					entry.confidence = computeConfidence(
						new Set(
							entry.confirmed_by
								.map((r) => r.phase_number)
								.filter((n) => Number.isInteger(n)),
						).size,
						entry.auto_generated ?? false,
					);
				}
				changed = true;
			}
		}
		return changed ? current : null;
	}).catch(() => {
		// Fail-open: retrieval confirmation is best-effort telemetry-grade work.
	});
}

// Laplace smoothing constant for computeOutcomeSignal. Pulls low-evidence entries
// toward 0 so a single applied/contradicted event can't dominate ranking or block
// promotion — meaningful influence needs a few corroborating outcomes.
export const OUTCOME_SIGNAL_SMOOTHING = 4;

// Event-sourced track-record signal in (-1, 1) derived from an entry's accumulated
// retrieval outcomes. Positive when the entry was applied / succeeded after being
// shown; negative when it was ignored / violated / contradicted / failed after.
// Returns 0 (neutral) when there is no outcome evidence, so entries that have never
// been acted on are neither boosted nor penalized. Reads only the v2/v3 outcome
// counters (NOT the frozen v1 applied_count), per the RetrievalOutcome contract.
export function computeOutcomeSignal(outcomes?: RetrievalOutcome): number {
	if (!outcomes) return 0;
	const positives =
		(outcomes.applied_explicit_count ?? 0) +
		(outcomes.succeeded_after_shown_count ?? 0);
	const negatives =
		(outcomes.ignored_count ?? 0) +
		(outcomes.violated_count ?? 0) +
		(outcomes.contradicted_count ?? 0) +
		(outcomes.failed_after_shown_count ?? 0);
	const total = positives + negatives;
	if (total === 0) return 0;
	return (positives - negatives) / (total + OUTCOME_SIGNAL_SMOOTHING);
}

// Infer tags from a lesson string. Returns lowercase tag strings.
// inferTags lives in knowledge-store.ts (NOT curator) to avoid circular dependency:
// curator imports validator, validator would need inferTags — so it lives here.
export function inferTags(lesson: string): string[] {
	const lower = lesson.toLowerCase();
	const tags: string[] = [];

	// Category + tag detection
	if (/(^|\s)(?:todo|remember|don't?(?:\s+)?forget)(?:\s|:|,|$)/i.test(lesson))
		tags.push('todo');

	// Tech/tool detection
	if (/\b(?:typescript|ts)\b/.test(lower)) tags.push('typescript');
	if (/\b(?:javascript|js)\b/.test(lower)) tags.push('javascript');
	if (/\b(?:python)\b/.test(lower)) tags.push('python');
	if (/\b(?:bun|node|deno)\b/.test(lower)) tags.push('runtime');
	if (/\b(?:react|vue|svelte|angular)\b/.test(lower)) tags.push('frontend');
	if (/\b(?:git|github|gitlab)\b/.test(lower)) tags.push('git');
	if (/\b(?:docker|kubernetes|k8s)\b/.test(lower)) tags.push('container');
	if (/\b(?:sql|postgres|mysql|sqlite)\b/.test(lower)) tags.push('database');
	if (/\b(?:test|spec|vitest|jest|mocha)\b/.test(lower)) tags.push('testing');
	if (/\b(?:ci|cd|pipeline|workflow|action)\b/.test(lower)) tags.push('ci-cd');
	if (/\b(?:security|auth|token|password|encrypt)\b/.test(lower))
		tags.push('security');
	if (/\b(?:performance|latency|throughput|cache)\b/.test(lower))
		tags.push('performance');
	if (/\b(?:api|rest|graphql|grpc|endpoint)\b/.test(lower)) tags.push('api');
	if (/\b(?:swarm|architect|agent|hook|plan)\b/.test(lower))
		tags.push('opencode-swarm');

	return Array.from(new Set(tags)); // deduplicate
}

// ============================================================================
// Feedback Bridge — Confidence Bumping
// ============================================================================

/** Confidence floor (below this, entries are considered unreliable). */
const CONFIDENCE_FLOOR = 0.1;

/** Confidence ceiling (maximum possible value). */
const CONFIDENCE_CEILING = 1.0;

/**
 * Batch-update confidence scores on knowledge entries identified by their UUIDs.
 *
 * For each delta, the function:
 * 1. Searches the swarm knowledge file for an entry with the given `id`.
 * 2. Falls back to the hive knowledge file if not found in swarm.
 * 3. Clamps the resulting confidence to [0.1, 1.0].
 * 4. Updates `confidence` and `updated_at`, then rewrites the file.
 *
 * The full read-modify-write cycle is atomic under a directory lock
 * (same pattern as `enforceKnowledgeCap`). Errors are logged but never
 * thrown — the function is fail-open.
 *
 * @param directory - Project root directory (used to resolve `.swarm/knowledge.jsonl`).
 * @param deltas    - Array of {id, delta} tuples. Delta may be positive (boost) or negative (decay).
 */
export async function bumpKnowledgeConfidenceBatch(
	directory: string,
	deltas: Array<{ id: string; delta: number }>,
	options?: ConfidenceFloorOptions,
): Promise<void> {
	if (deltas.length === 0) return;

	const swarmPath = resolveSwarmKnowledgePath(directory);
	const hivePath = resolveHiveKnowledgePath();

	const touchedSwarm: KnowledgeEntryBase[] = [];
	const touchedHive: KnowledgeEntryBase[] = [];

	try {
		// --- Swarm pass ---
		touchedSwarm.push(...(await applyConfidenceDeltas(swarmPath, deltas)));

		// --- Hive pass (only for IDs not found in swarm) ---
		const swarmIds = new Set(touchedSwarm.map((e) => e.id));
		// If a delta id was NOT touched in swarm it may live in hive; re-check
		// against the full swarm file too (some entries may not have received
		// a delta but the id set we care about is the deltas we tried to apply).
		const hiveOnly = deltas.filter((d) => !swarmIds.has(d.id));
		if (hiveOnly.length > 0) {
			touchedHive.push(...(await applyConfidenceDeltas(hivePath, hiveOnly)));
		}

		// --- G2: confidence-floor action (post-bump sweep) ---
		// Confidence used to dead-end at the floor with no consequence. Now an
		// entry clamped to the floor with a net-negative outcome signal is
		// demoted (default) or quarantined per config, closing the loop.
		await applyConfidenceFloorAction(
			directory,
			[...touchedSwarm, ...touchedHive],
			options,
		).catch((err) => {
			logger.log(
				'[knowledge-store] confidence-floor action sweep failed (best-effort):',
				err instanceof Error ? err.message : String(err),
			);
		});
	} catch (err) {
		logger.log(
			'[knowledge-store] bumpKnowledgeConfidenceBatch failed (fail-open):',
			err instanceof Error ? err.message : String(err),
		);
	}
}

/**
 * G2 (#1715): for each just-bumped entry at the confidence floor with a
 * net-negative outcome signal, fire the configured action (`demote` strips
 * retrieval `statusBoost` via the `confidence_floor_demoted` flag; `quarantine`
 * routes through `quarantineEntry`). Entries that recovered above the floor
 * have a stale `confidence_floor_demoted` flag cleared.
 *
 * Best-effort: any failure is caught by the caller; never throws.
 */
async function applyConfidenceFloorAction(
	directory: string,
	touched: KnowledgeEntryBase[],
	options?: ConfidenceFloorOptions,
): Promise<void> {
	const action = options?.floorAction ?? 'demote';
	if (action === 'none' || touched.length === 0) return;

	const minOutcomes = options?.floorMinOutcomes ?? 3;
	const signalThreshold = options?.floorSignalThreshold ?? 0; // net-negative

	// Floor-band epsilon: treat confidence within this distance of the floor as
	// "at the floor" (float compare safety).
	const FLOOR_EPSILON = 1e-9;
	const atFloor = touched.filter(
		(e) => e.confidence <= CONFIDENCE_FLOOR + FLOOR_EPSILON,
	);
	const recovered = touched.filter(
		(e) =>
			e.confidence > CONFIDENCE_FLOOR + FLOOR_EPSILON &&
			e.confidence_floor_demoted,
	);

	if (atFloor.length === 0 && recovered.length === 0) return;

	// Read the events rollup ONCE (the expensive re-read) — keyed by entry id.
	// Dynamic import avoids a static store↔events cycle (events already
	// dynamic-imports store for the bump itself; this mirrors that precedent).
	const { readKnowledgeCounterRollups, effectiveRetrievalOutcomes } =
		await import('./knowledge-events.js');
	const rollups = await readKnowledgeCounterRollups(directory);

	// Helper: persist the confidence_floor_demoted flag flip on a single entry
	// via a tiny locked transaction. Re-uses transactKnowledge for safety.
	const flagIds = new Set<string>();
	for (const e of atFloor) {
		const outcomes = effectiveRetrievalOutcomes(
			e.retrieval_outcomes,
			rollups?.get(e.id),
		);
		const signal = computeOutcomeSignal(outcomes);
		const totalEvidence =
			(outcomes.applied_explicit_count ?? 0) +
			(outcomes.succeeded_after_shown_count ?? 0) +
			(outcomes.ignored_count ?? 0) +
			(outcomes.violated_count ?? 0) +
			(outcomes.contradicted_count ?? 0) +
			(outcomes.failed_after_shown_count ?? 0);
		// Require net-negative signal AND enough evidence to act on.
		if (signal < signalThreshold && totalEvidence >= minOutcomes) {
			flagIds.add(e.id);
		}
	}
	for (const e of recovered) flagIds.add(e.id); // clear stale flag

	if (flagIds.size === 0) return;

	// Apply the flag flips + (optionally) quarantine via transactKnowledge.
	// For 'quarantine' action, route the floor-quarantines through
	// quarantineEntry after the flag transaction commits.
	const swarmPath = resolveSwarmKnowledgePath(directory);
	const hivePath = resolveHiveKnowledgePath();
	const toQuarantine: Array<{ id: string; tier: 'swarm' | 'hive' }> = [];

	await transactKnowledge<KnowledgeEntryBase>(swarmPath, (swarmEntries) => {
		const now = new Date().toISOString();
		for (const entry of swarmEntries) {
			if (!flagIds.has(entry.id)) continue;
			const atFloorEntry = atFloor.find((e) => e.id === entry.id);
			if (atFloorEntry) {
				entry.confidence_floor_demoted = true;
				if (action === 'quarantine') {
					toQuarantine.push({ id: entry.id, tier: 'swarm' });
				}
			} else {
				// recovered — clear stale flag
				entry.confidence_floor_demoted = false;
			}
			entry.updated_at = now;
		}
		return swarmEntries;
	}).catch((err) => {
		logger.log(
			'[knowledge-store] confidence-floor swarm flag transaction failed (best-effort):',
			err instanceof Error ? err.message : String(err),
		);
	});

	// Hive flag flips (separate transaction).
	// Note: quarantineEntry reads only the swarm knowledge file, so it cannot
	// quarantine hive-tier entries. For hive entries the confidence_floor_demoted
	// FLAG is the effective action (it's honored by search-knowledge.ts
	// regardless of tier); we deliberately do NOT push hive IDs into
	// toQuarantine, which would imply a quarantine that won't happen.
	const hiveFlagIds = new Set<string>();
	for (const e of atFloor) {
		if (e.tier === 'hive' && flagIds.has(e.id)) hiveFlagIds.add(e.id);
	}
	for (const e of recovered) {
		if (e.tier === 'hive' && flagIds.has(e.id)) hiveFlagIds.add(e.id);
	}
	if (hiveFlagIds.size > 0) {
		await transactKnowledge<KnowledgeEntryBase>(hivePath, (hiveEntries) => {
			const now = new Date().toISOString();
			for (const entry of hiveEntries) {
				if (!hiveFlagIds.has(entry.id)) continue;
				const atFloorEntry = atFloor.find((e) => e.id === entry.id);
				if (atFloorEntry) {
					entry.confidence_floor_demoted = true;
				} else {
					entry.confidence_floor_demoted = false;
				}
				entry.updated_at = now;
			}
			return hiveEntries;
		}).catch((err) => {
			logger.log(
				'[knowledge-store] confidence-floor hive flag transaction failed (best-effort):',
				err instanceof Error ? err.message : String(err),
			);
		});
	}

	// Route quarantine action (deferred until after the flag transaction).
	// Dynamic import avoids a static store↔validator cycle. Only swarm-tier
	// entries are collected (see hive note above).
	if (action === 'quarantine' && toQuarantine.length > 0) {
		const { quarantineEntry } = await import('./knowledge-validator.js');
		// #1848 §2: confidence-floor quarantine uses cohort-wide outcome signals
		// (the rollups are from the link-aware event log). Route through the
		// cohort-safe policy so unknown-owner legacy entries are protected.
		const { KnowledgeConfigSchema } = await import('../config/schema.js');
		// F-06: parse the project's real config so the cohort config-fingerprint
		// guard compares actual settings, not defaults-vs-defaults. Best-effort:
		// fall back to schema defaults on any load/parse error.
		let config: ReturnType<typeof KnowledgeConfigSchema.parse>;
		try {
			const { loadPluginConfigWithMeta } = await import('../config/index.js');
			const { config: loadedConfig } = loadPluginConfigWithMeta(directory);
			config = KnowledgeConfigSchema.parse(loadedConfig.knowledge ?? {});
		} catch {
			config = KnowledgeConfigSchema.parse({});
		}
		for (const { id } of toQuarantine) {
			await quarantineEntry(
				directory,
				id,
				'confidence_floor_negative_outcome',
				'auto',
				{
					input: {
						directory,
						action: 'quarantine',
						entryId: id,
						reason: 'confidence_floor_negative_outcome',
						evidenceScope: 'cohort-wide',
					},
					context: { config, entry: null },
				},
			).catch((err) => {
				logger.log(
					'[knowledge-store] confidence-floor quarantine failed (best-effort):',
					err instanceof Error ? err.message : String(err),
				);
			});
		}
	}
}

/** Options for the G2 confidence-floor action in bumpKnowledgeConfidenceBatch. */
export interface ConfidenceFloorOptions {
	/** Action when a just-bumped entry sits at the confidence floor with a
	 * net-negative outcome signal. `'none'` preserves the legacy dead-end
	 * behavior. Default `'demote'`. */
	floorAction?: 'none' | 'demote' | 'quarantine';
	/** Minimum total outcome-evidence count required before acting on a
	 * floor entry. Avoids demoting brand-new entries with one stray negative.
	 * Default 3. */
	floorMinOutcomes?: number;
	/** Outcome-signal threshold below which a floor entry is acted on
	 * (`computeOutcomeSignal` returns (-1, 1); net-negative is `< 0`).
	 * Default 0. */
	floorSignalThreshold?: number;
}

/**
 * Internal helper: apply a set of confidence deltas to a single JSONL file.
 * Acquires a directory lock for the full read-modify-write cycle.
 *
 * Returns the entries that received a delta (post-mutation, with the new
 * confidence), so the caller can run a post-bump sweep (e.g. the G2
 * confidence-floor action) without a separate re-read of the file.
 */
async function applyConfidenceDeltas(
	filePath: string,
	deltas: Array<{ id: string; delta: number }>,
): Promise<KnowledgeEntryBase[]> {
	const idDeltaMap = new Map<string, number>();
	for (const d of deltas) {
		const existing = idDeltaMap.get(d.id);
		idDeltaMap.set(d.id, existing !== undefined ? existing + d.delta : d.delta);
	}

	const touched: KnowledgeEntryBase[] = [];
	let release: (() => Promise<void>) | null = null;
	try {
		const dir = path.dirname(filePath);
		await mkdir(dir, { recursive: true });
		release = await lockfile.lock(dir, {
			retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
			stale: 5000,
		});

		const entries = await readKnowledge<KnowledgeEntryBase>(filePath);
		if (entries.length === 0) return [];

		const now = new Date().toISOString();
		let mutated = false;

		for (const entry of entries) {
			const delta = idDeltaMap.get(entry.id);
			if (delta === undefined) continue;

			entry.confidence = Math.max(
				CONFIDENCE_FLOOR,
				Math.min(CONFIDENCE_CEILING, entry.confidence + delta),
			);
			entry.updated_at = now;
			mutated = true;
			touched.push(entry);
		}

		if (mutated) {
			const content =
				entries.map((e) => JSON.stringify(e)).join('\n') +
				(entries.length > 0 ? '\n' : '');
			await atomicWriteFile(filePath, content);
		}
	} catch (err) {
		logger.log(
			`[knowledge-store] applyConfidenceDeltas failed on ${filePath} (fail-open):`,
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — non-blocking */
			}
		}
	}
	return touched;
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals: {
	getPlatformConfigDir: typeof getPlatformConfigDir;
	resolveSwarmKnowledgePath: typeof resolveSwarmKnowledgePath;
	resolveSwarmRejectedPath: typeof resolveSwarmRejectedPath;
	resolveHiveKnowledgePath: typeof resolveHiveKnowledgePath;
	resolveHiveRejectedPath: typeof resolveHiveRejectedPath;
	resolveHiveEventsPath: typeof resolveHiveEventsPath;
	readKnowledge: typeof readKnowledge;
	parseKnowledgeContent: typeof parseKnowledgeContent;
	readRejectedLessons: typeof readRejectedLessons;
	appendKnowledge: typeof appendKnowledge;
	rewriteKnowledge: typeof rewriteKnowledge;
	transactKnowledge: typeof transactKnowledge;
	enforceKnowledgeCap: typeof enforceKnowledgeCap;
	sweepAgedEntries: typeof sweepAgedEntries;
	sweepStaleTodos: typeof sweepStaleTodos;
	appendRejectedLesson: typeof appendRejectedLesson;
	normalize: typeof normalize;
	wordBigrams: typeof wordBigrams;
	jaccardBigram: typeof jaccardBigram;
	findNearDuplicate: typeof findNearDuplicate;
	computeConfidence: typeof computeConfidence;
	computeOutcomeSignal: typeof computeOutcomeSignal;
	selectKnowledgeCapSurvivors: typeof selectKnowledgeCapSurvivors;
	inferTags: typeof inferTags;
	bumpKnowledgeConfidenceBatch: typeof bumpKnowledgeConfidenceBatch;
	getArchivedKnowledgeIds: typeof getArchivedKnowledgeIds;
} = {
	getPlatformConfigDir,
	resolveSwarmKnowledgePath,
	resolveSwarmRejectedPath,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	resolveHiveEventsPath,
	readKnowledge,
	parseKnowledgeContent,
	readRejectedLessons,
	appendKnowledge,
	rewriteKnowledge,
	transactKnowledge,
	enforceKnowledgeCap,
	sweepAgedEntries,
	sweepStaleTodos,
	appendRejectedLesson,
	normalize,
	wordBigrams,
	jaccardBigram,
	findNearDuplicate,
	computeConfidence,
	computeOutcomeSignal,
	selectKnowledgeCapSurvivors,
	inferTags,
	bumpKnowledgeConfidenceBatch,
	getArchivedKnowledgeIds,
};

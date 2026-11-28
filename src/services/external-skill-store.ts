/**
 * External skill candidate quarantine store.
 *
 * Manages external skill candidates persisted as individual JSON files under
 * `.swarm/skills/candidates/<uuid>.json`.  Each candidate goes through a
 * quarantine lifecycle (pending → in_review → quarantined → passed/rejected →
 * promoted/revoked) before it can be activated as a generated skill.
 *
 * All writes are atomic (temp-file + rename) via `atomicWriteFile` from the
 * evidence subsystem.  File-system I/O is funnelled through `_internals` so
 * that tests can replace individual operations without cross-module mock
 * leakage (Bun's `mock.module` is intentionally avoided for I/O seams).
 *
 * Invariants:
 *   - Candidate IDs are UUID v4 (cryptographically random), never derived from
 *     user input, to prevent path-traversal attacks.
 *   - `passed`, `promoted`, and `revoked` candidates are NEVER evicted.
 *   - The store directory is derived from the injected `directory` parameter
 *     (typically `ctx.directory`); no `process.cwd()` calls.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
	ExternalSkillCandidate,
	ExternalSkillCandidateEvaluationVerdict,
} from '../config/schema';
import { withEvidenceLock } from '../evidence/lock';
import { atomicWriteFile } from '../evidence/task-file';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the store. */
export interface ExternalSkillStoreConfig {
	/** Maximum number of candidates before FIFO eviction kicks in. */
	max_candidates: number;
}

/** Optional filters for listing candidates. */
export interface ExternalSkillListFilter {
	/** Restrict to candidates with this evaluation verdict. */
	verdict?: ExternalSkillCandidateEvaluationVerdict;
	/** Restrict to candidates from this source type (e.g. 'github'). */
	source_type?: string;
	/** Restrict to candidates with this exact source URL. */
	source_url?: string;
	/** ISO datetime — only return candidates fetched at or after this time. */
	since?: string;
}

/** Patch fields accepted by `update`. */
export type ExternalSkillCandidatePatch = Partial<
	Pick<
		ExternalSkillCandidate,
		| 'evaluation_verdict'
		| 'risk_flags'
		| 'evaluation_history'
		| 'skill_name'
		| 'skill_description'
	>
>;

/**
 * Public interface returned by the factory function.
 *
 * Every method is scoped to the store directory derived at creation time.
 */
export interface ExternalSkillStore {
	/** Create a new candidate and persist it atomically. */
	add(
		candidate: Omit<ExternalSkillCandidate, 'id'>,
	): Promise<ExternalSkillCandidate>;
	/** Read a single candidate by UUID. Returns `null` if not found. */
	get(id: string): Promise<ExternalSkillCandidate | null>;
	/** List candidates with optional filters, sorted by `fetched_at` descending. */
	list(filter?: ExternalSkillListFilter): Promise<ExternalSkillCandidate[]>;
	/**
	 * Patch an existing candidate (read-modify-write). Appends to
	 * `evaluation_history`. With `options.maxRecordBytes`, the bound is
	 * enforced on the ACTUAL merged object immediately before the atomic
	 * write — an over-bound merge throws `RecordTooLargeError` and nothing
	 * is written.
	 */
	update(
		id: string,
		patch: ExternalSkillCandidatePatch,
		options?: UpdateOptions,
	): Promise<ExternalSkillCandidate | null>;
	/** Remove a candidate file. Returns `true` if the file existed and was deleted. */
	delete(id: string): Promise<boolean>;
	/**
	 * Evict the oldest `pending` or `rejected` candidates when the store
	 * exceeds `max_candidates`.  Never evicts `passed`, `promoted`, or
	 * `revoked` candidates.  Returns the number of evicted files.
	 */
	evictIfNeeded(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Regex matching a UUID v4 string (canonical lowercase, no braces). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Verdicts eligible for FIFO eviction. */
const EVICTABLE_VERDICTS = new Set<ExternalSkillCandidateEvaluationVerdict>([
	'pending',
	'rejected',
]);

/**
 * Validate that an ID looks like a UUID v4.
 *
 * This is a defense-in-depth guard: IDs are generated via `crypto.randomUUID()`
 * in production, but user-supplied IDs must be rejected early to prevent
 * path-traversal attacks (e.g. `../../etc/passwd`).
 */
function isValidCandidateId(id: string): boolean {
	return UUID_RE.test(id);
}

/**
 * Resolve the absolute file path for a candidate ID within the store directory.
 *
 * Returns `null` if the ID is not a valid UUID — callers must handle the
 * `null` case as "invalid input, operation rejected".
 */
function candidateFilePath(storePath: string, id: string): string | null {
	if (!isValidCandidateId(id)) {
		return null;
	}
	return path.join(storePath, `${id}.json`);
}

// ---------------------------------------------------------------------------
// DI seam
// ---------------------------------------------------------------------------

/**
 * Dependency-injection seam for testing.
 *
 * Tests can temporarily replace individual entries to exercise failure paths
 * (e.g. file-not-found, permission errors) without `mock.module` leakage.
 * Restore each entry in `afterEach` via the saved original reference.
 */
export const _internals = {
	/** UUID generator — default is `crypto.randomUUID()`. */
	randomUUID: crypto.randomUUID.bind(crypto),

	/** Async filesystem operations. */
	fs: {
		mkdir: fs.mkdir,
		readFile: fs.readFile,
		readdir: fs.readdir,
		unlink: fs.unlink,
	},

	/** Atomic write primitive (temp-file + rename). */
	atomicWriteFile,
};

// ---------------------------------------------------------------------------
// Patch application (shared with promote's pre-write record bound check)
// ---------------------------------------------------------------------------

/** Options for `ExternalSkillStore.update`. */
export interface UpdateOptions {
	/**
	 * Byte cap applied to the ACTUAL merged candidate serialization
	 * (`JSON.stringify(updated, null, '\t')`, UTF-8) immediately before the
	 * atomic write. When the merged record exceeds the cap, update() throws
	 * `RecordTooLargeError` and writes NOTHING. Omit to keep the historical
	 * unbounded behavior.
	 */
	maxRecordBytes?: number;
}

/**
 * Typed error thrown by `update({ maxRecordBytes })` when the merged record
 * exceeds the configured cap — the write is refused, the on-disk record is
 * unchanged, and the byte counts are carried for actionable reporting.
 */
export class RecordTooLargeError extends Error {
	constructor(
		public readonly byteLength: number,
		public readonly maxRecordBytes: number,
	) {
		super(
			`candidate record after merge is ${byteLength} bytes, exceeding the ${maxRecordBytes}-byte bound`,
		);
		this.name = 'RecordTooLargeError';
	}
}

/**
 * Pure patch application for `update` — builds the exact candidate object
 * the store will persist: applies the scalar patch fields and appends the
 * store-stamped system history entry (when the verdict CHANGES) followed by
 * any patch-supplied history entries, in the store's merge order.
 *
 * `external_skill_promote` calls this SAME builder to measure the exact
 * post-update record size BEFORE any write (Stage B round 5: a fixed reserve
 * could not bound the audit entry, which duplicates publisher/source_url
 * and prior evaluation details), so the measured bytes and the persisted
 * bytes cannot drift apart. `nowIso` is injectable because the real entry's
 * timestamp is always a fixed-length ISO string — the byte length is
 * identical regardless of the instant.
 */
export function applyCandidatePatch(
	existing: ExternalSkillCandidate,
	patch: ExternalSkillCandidatePatch,
	nowIso: string = new Date().toISOString(),
): ExternalSkillCandidate {
	const updated: ExternalSkillCandidate = { ...existing };

	if (
		patch.evaluation_verdict !== undefined &&
		patch.evaluation_verdict !== existing.evaluation_verdict
	) {
		const historyEntry = {
			verdict: patch.evaluation_verdict,
			timestamp: nowIso,
			actor: 'system',
			reason: undefined as string | undefined,
		};
		updated.evaluation_history = [...existing.evaluation_history, historyEntry];
	}

	if (patch.evaluation_verdict !== undefined) {
		updated.evaluation_verdict = patch.evaluation_verdict;
	}
	if (patch.risk_flags !== undefined) {
		updated.risk_flags = patch.risk_flags;
	}
	if (patch.skill_name !== undefined) {
		updated.skill_name = patch.skill_name;
	}
	if (patch.skill_description !== undefined) {
		updated.skill_description = patch.skill_description;
	}
	// evaluation_history from the patch is merged (appended), never replaces.
	if (patch.evaluation_history !== undefined) {
		updated.evaluation_history = [
			...updated.evaluation_history,
			...patch.evaluation_history,
		];
	}
	return updated;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an `ExternalSkillStore` scoped to the given project root directory.
 *
 * The store persists candidate files under
 * `<directory>/.swarm/skills/candidates/<uuid>.json`.
 *
 * @param directory — Project root (typically `ctx.directory`). Must NOT contain
 *                   user-controlled path components.
 * @param config   — Store configuration including capacity limits.
 */
export function createExternalSkillStore(
	directory: string,
	config: ExternalSkillStoreConfig,
): ExternalSkillStore {
	const storePath = path.join(directory, '.swarm', 'skills', 'candidates');

	// ---- add ---------------------------------------------------------------

	async function add(
		candidate: Omit<ExternalSkillCandidate, 'id'>,
	): Promise<ExternalSkillCandidate> {
		const id = _internals.randomUUID();
		const full: ExternalSkillCandidate = { ...candidate, id };
		const filePath = path.join(storePath, `${id}.json`);

		await _internals.fs.mkdir(storePath, { recursive: true });
		await _internals.atomicWriteFile(
			filePath,
			JSON.stringify(full, null, '\t'),
		);

		return full;
	}

	// ---- get ---------------------------------------------------------------

	async function get(id: string): Promise<ExternalSkillCandidate | null> {
		const filePath = candidateFilePath(storePath, id);
		if (filePath === null) {
			return null;
		}

		let raw: string;
		try {
			raw = await _internals.fs.readFile(filePath, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw err;
		}

		try {
			return JSON.parse(raw) as ExternalSkillCandidate;
		} catch {
			// Corrupted JSON — treat as not-found rather than crashing.
			return null;
		}
	}

	// ---- list --------------------------------------------------------------

	async function list(
		filter?: ExternalSkillListFilter,
	): Promise<ExternalSkillCandidate[]> {
		let entries: string[];
		try {
			entries = await _internals.fs.readdir(storePath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw err;
		}

		const candidates: ExternalSkillCandidate[] = [];

		for (const entry of entries) {
			if (!entry.endsWith('.json')) {
				continue;
			}

			const filePath = path.join(storePath, entry);
			let raw: string;
			try {
				raw = await _internals.fs.readFile(filePath, 'utf-8');
			} catch {
				// File disappeared between readdir and read — skip it.
				continue;
			}

			try {
				const parsed = JSON.parse(raw) as ExternalSkillCandidate;
				candidates.push(parsed);
			} catch {}
		}

		// Apply filters.
		const filtered = candidates.filter((c) => {
			if (
				filter?.verdict !== undefined &&
				c.evaluation_verdict !== filter.verdict
			) {
				return false;
			}
			if (
				filter?.source_type !== undefined &&
				c.source_type !== filter.source_type
			) {
				return false;
			}
			if (
				filter?.source_url !== undefined &&
				c.source_url !== filter.source_url
			) {
				return false;
			}
			if (filter?.since !== undefined && c.fetched_at < filter.since) {
				return false;
			}
			return true;
		});

		// Sort by fetched_at descending (newest first).
		filtered.sort((a, b) =>
			a.fetched_at > b.fetched_at ? -1 : a.fetched_at < b.fetched_at ? 1 : 0,
		);

		return filtered;
	}

	// ---- update ------------------------------------------------------------

	async function update(
		id: string,
		patch: ExternalSkillCandidatePatch,
		options?: UpdateOptions,
	): Promise<ExternalSkillCandidate | null> {
		const filePath = candidateFilePath(storePath, id);
		if (filePath === null) {
			return null;
		}

		// Per-candidate mutual exclusion (#3951 AC1): update() is an unlocked
		// read-merge-write — two overlapping updates on one record both read
		// the same snapshot and the last writer silently discards the other's
		// acknowledged fields. The store's records live under
		// `<directory>/.swarm/skills/candidates/`, so the repo's shared
		// `.swarm`-relative lock primitive (withEvidenceLock, bounded wait +
		// stale-holder recovery; non-evidence reuse precedent:
		// evidence/immutable-store.ts relativeLockPath) serializes the whole
		// RMW. A lock timeout surfaces as an explicit failure — callers
		// either land both acknowledged mutations or the conflicting one
		// fails loudly; a lost update is never acknowledged.
		return withCandidateLock(id, () =>
			updateLocked(id, filePath, patch, options),
		);
	}

	async function updateLocked(
		id: string,
		filePath: string,
		patch: ExternalSkillCandidatePatch,
		options?: UpdateOptions,
	): Promise<ExternalSkillCandidate | null> {
		const existing = await get(id);
		if (existing === null) {
			return null;
		}

		const updated = applyCandidatePatch(existing, patch);

		const serialized = JSON.stringify(updated, null, '\t');
		if (options?.maxRecordBytes !== undefined) {
			// Stage B round 6 — enforce the cap on the ACTUAL merged object
			// (the re-read candidate plus this patch), NOT on a caller's
			// earlier snapshot: a concurrent mutation between the caller's
			// read and this re-read can only be caught here. Refuse to write
			// and leave the on-disk record unchanged.
			const byteLength = Buffer.byteLength(serialized, 'utf8');
			if (byteLength > options.maxRecordBytes) {
				throw new RecordTooLargeError(byteLength, options.maxRecordBytes);
			}
		}

		await _internals.atomicWriteFile(filePath, serialized);

		return updated;
	}

	// ---- delete ------------------------------------------------------------

	async function deleteCandidate(id: string): Promise<boolean> {
		const filePath = candidateFilePath(storePath, id);
		if (filePath === null) {
			return false;
		}

		// Same per-candidate lock as update() (#3951): without it, an
		// acknowledged delete can be followed by an in-flight update's stale
		// write that RESURRECTS the record. The unlink is inlined under the
		// lock (not routed through the public locked deleteCandidate) so
		// eviction below never re-enters the same non-reentrant lock.
		return withCandidateLock(id, () => deleteLocked(filePath));
	}

	async function deleteLocked(filePath: string): Promise<boolean> {
		try {
			await _internals.fs.unlink(filePath);
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return false;
			}
			throw err;
		}
	}

	/**
	 * `.swarm`-relative lock key for one candidate record — the shared
	 * withEvidenceLock primitive keys its lock files by this path
	 * (`<directory>/.swarm/locks/<sha256>.lck` via src/parallel/file-locks.ts),
	 * so update() and delete() on the same record serialize against each
	 * other and across processes. `assertProjectRoot` accepts the store's
	 * project root (`.swarm` itself is the boundary marker), keeping
	 * temp-fixture stores working.
	 */
	function withCandidateLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
		return withEvidenceLock(
			directory,
			`skills/candidates/${id}.json`,
			'external-skill-store',
			id,
			fn,
		);
	}

	// ---- evictIfNeeded -----------------------------------------------------

	async function evictIfNeeded(): Promise<number> {
		const all = await list();
		if (all.length <= config.max_candidates) {
			return 0;
		}

		// Collect evictable candidates sorted by fetched_at ascending (oldest first).
		const evictable = all
			.filter((c) => EVICTABLE_VERDICTS.has(c.evaluation_verdict))
			.sort((a, b) =>
				a.fetched_at < b.fetched_at ? -1 : a.fetched_at > b.fetched_at ? 1 : 0,
			);

		const excess = all.length - config.max_candidates;
		const toEvict = evictable.slice(0, excess);
		let evicted = 0;

		for (const candidate of toEvict) {
			// Verdict re-validation under the victim's lock (#3951): the list
			// above is a snapshot — a verdict that became protected between
			// listing and eviction must abort THAT victim's eviction (skip to
			// the next candidate; never delete a protected record). The unlink
			// is inlined under the same lock rather than calling the public
			// locked deleteCandidate (no reentrant acquisition).
			const deleted = await withCandidateLock(candidate.id, async () => {
				const current = await get(candidate.id);
				if (current === null) return false;
				if (!EVICTABLE_VERDICTS.has(current.evaluation_verdict)) {
					return false;
				}
				return deleteLocked(candidateFilePath(storePath, candidate.id)!);
			});
			if (deleted) {
				evicted++;
			}
		}

		return evicted;
	}

	// ---- return interface ---------------------------------------------------

	return {
		add,
		get,
		list,
		update,
		delete: deleteCandidate,
		evictIfNeeded,
	};
}

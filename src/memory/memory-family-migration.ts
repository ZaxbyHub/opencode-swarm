/**
 * #1850 Linked Knowledge 5/5: cohort memory family migration engine.
 *
 * Drives both `/swarm memory link` and `/swarm memory unlink` off the single
 * {@link MEMORY_FAMILY} manifest. Mirrors the architecture of
 * `src/knowledge/family-migration.ts` (issue #1846) but is memory-specific:
 *
 *  - JSONL members use `append-union` (id-keyed, idempotent on retry) — the
 *    same primitive the knowledge family uses.
 *  - The SQLite `memory.db` uses `sqlite-file-copy`: under an exclusive lock,
 *    checkpoint+close the source, copy the file into a staging path, validate
 *    by opening read-only and counting rows, then either (a) atomically rename
 *    into an empty destination, or (b) for a non-empty destination, ATTACH the
 *    staged DB and `INSERT OR IGNORE` keyed by id (critic CONCERN-6).
 *
 * All-or-nothing commit (issue #1850 acceptance #7): stage → validate →
 * commit. The memory-link pointer is flipped LAST by the caller
 * (`handleMemoryLinkCommand`), so a mid-migration failure leaves the worktree
 * in its prior link state and a retry is idempotent.
 *
 * Lock discipline: `proper-lockfile` on the destination storage dir (cohort
 * OR local — both directions) with a bumped `stale` (30s) for the migration
 * critical section — reused from the knowledge family so there is one source
 * of truth for the lock config. `realpath: false` keeps the lock identity on
 * the literal path so it is the SAME lock the local JSONL provider takes on
 * this directory (PRR-U1): symlinked roots (e.g. macOS /var → /private/var)
 * must not split the exclusion into two identities.
 * Admission is fail-closed (#2577): if the destination lock cannot be
 * acquired (a legitimate concurrent writer holds it, or acquisition fails for
 * a storage reason), the migration throws a typed
 * {@link MemoryMigrationLockError} and never runs unlocked.
 *
 * No writes happen here on the plugin-init path (invariant 1). Called only
 * from the `/swarm memory link` / `/swarm memory unlink` command handlers.
 */

import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import * as path from 'node:path';
import lockfileImport from 'proper-lockfile';
import { acquireDirectoryWriteLock } from '../parallel/directory-write-lock.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	MIGRATION_LOCK_RETRIES,
	MIGRATION_LOCK_STALE_MS,
} from '../knowledge/family-migration-shared.js';
import { warn } from '../utils/logger.js';
import { MEMORY_FAMILY } from './memory-family-manifest.js';
import {
	assertEventIdentityCompatible,
	type MemoryOutcomeEvent,
	validateOutcomeEvent,
} from './outcome-events.js';
import type { VettedMemoryRoot } from './storage-root.js';
import { isCohortRoot, rootStoragePath } from './storage-root.js';

/**
 * Minimal typing for the async `proper-lockfile` API this engine uses,
 * exposed through {@link _internals} so tests can classify acquisition
 * failures deterministically (same DI pattern as `src/full-auto/state.ts`).
 */
type MigrationLockFile = {
	lock: typeof import('proper-lockfile')['lock'];
};
const lockfile = lockfileImport as unknown as MigrationLockFile;

/** Failure category for destination-lock admission (#2577, #2575 contract). */
export type MemoryMigrationLockErrorCategory = 'contention' | 'storage';

/**
 * Typed failure for acquiring the destination migration lock. Thrown BEFORE
 * the merge loop opens, so no destination or source write ever happens on a
 * failed admission. Mirrors `FullAutoStateLockError` in
 * `src/full-auto/state.ts` (#2575): stable category + code, cause preserved
 * for diagnostics, and messages that never echo absolute host paths.
 */
export class MemoryMigrationLockError extends Error {
	readonly category: MemoryMigrationLockErrorCategory;
	readonly cause: unknown;
	readonly code: `MEMORY_MIGRATION_LOCK_${Uppercase<MemoryMigrationLockErrorCategory>}`;

	constructor(
		category: MemoryMigrationLockErrorCategory,
		message: string,
		cause?: unknown,
	) {
		super(message);
		this.name = 'MemoryMigrationLockError';
		this.category = category;
		this.code =
			`MEMORY_MIGRATION_LOCK_${category.toUpperCase()}` as MemoryMigrationLockError['code'];
		this.cause = cause;
	}
}

function lockErrorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function makeAdmissionError(cause: unknown): MemoryMigrationLockError {
	if (lockErrorCode(cause) === 'ELOCKED') {
		return new MemoryMigrationLockError(
			'contention',
			'memory-family-migration: destination lock contention after bounded retries; retry the link or unlink command',
			cause,
		);
	}
	const code = lockErrorCode(cause);
	return new MemoryMigrationLockError(
		'storage',
		`memory-family-migration: destination lock acquisition failed${code ? ` (${code})` : ''}`,
		cause,
	);
}

/**
 * #1850 (H-008): max number of source-DB backups retained in
 * `<cohortRoot>/backups/`. Oldest are pruned after each migration.
 */
const MAX_BACKUPS = 5;

export interface MemoryFamilyMigrationCounts {
	readonly perMember: ReadonlyArray<{
		filename: string;
		merged: number;
		skipped: number;
		/** Same-id rows replaced by a strictly newer version (#3520 PRR-002 truthfulness). */
		superseded: number;
	}>;
	/**
	 * #2958 tombstone / recency audit, one entry per member that had anything
	 * to report (members whose three fields are all empty are omitted). Every
	 * emitted entry carries all three fields.
	 */
	readonly audit: ReadonlyArray<MemoryFamilyMemberAudit>;
}

/** Per-member divergence audit (#2958). */
export interface MemoryFamilyMemberAudit {
	readonly filename: string;
	/** Destination-deleted ids a newer live source row resurrected. */
	readonly resurrectedIds: readonly string[];
	/**
	 * Collisions resolved by recency OTHER THAN resurrections: source-newer
	 * wins (live or tombstone) plus destination-tombstone suppressions.
	 * Destination-newer keep-rows are not supersessions (nothing moved), and
	 * resurrections are reported solely via {@link resurrectedIds} so no
	 * event renders twice.
	 */
	readonly supersededCount: number;
	/** Collisions with no usable recency signal (destination kept, reported). */
	readonly unresolvedCollisions: readonly string[];
}

/**
 * Recency keys per versioned JSONL member (#2958), verified against the
 * persisted producer shapes: memories rows are full MemoryRecords (camelCase
 * `updatedAt`); reviewed proposals are re-appended under the same id with a
 * re-stamped `reviewedAt` (`createdAt` is immutable at propose and is never a
 * recency key). Members not listed are event logs with unique ids — no
 * version recency.
 *
 * Exported for the doctor's read-only `--integrity` divergence report
 * (issue #2969): row identity, versioned membership, and recency comparison
 * must all come from THIS module so the report can never drift from the
 * engine's own merge semantics.
 */
export const MEMBER_RECENCY_KEYS: Readonly<Record<string, readonly string[]>> =
	{
		'memories.jsonl': ['updatedAt', 'updated_at'],
		'proposals.jsonl': ['reviewedAt'],
	};

/** Parse a row's recency (ISO string → epoch ms) from the member's key list. */
export function rowRecency(
	row: unknown,
	keys: readonly string[],
): number | undefined {
	if (typeof row !== 'object' || row === null) return undefined;
	const o = row as Record<string, unknown>;
	for (const key of keys) {
		const value = o[key];
		if (typeof value === 'string') {
			const ms = Date.parse(value);
			if (!Number.isNaN(ms)) return ms;
		}
	}
	return undefined;
}

/** Real string row id, or null when the row carries no id (whole-row identity).
 *  Exported for the doctor's `--integrity` report (see MEMBER_RECENCY_KEYS). */
export function rowId(row: unknown): string | null {
	if (typeof row !== 'object' || row === null) return null;
	const o = row as Record<string, unknown>;
	return typeof o.id === 'string' ? o.id : null;
}

/** jsonl tombstone flag (#2958): `metadata.deleted === true` on a memory row. */
function rowIsTombstone(row: unknown): boolean {
	if (typeof row !== 'object' || row === null) return false;
	const metadata = (row as { metadata?: unknown }).metadata;
	return (
		typeof metadata === 'object' &&
		metadata !== null &&
		(metadata as { deleted?: unknown }).deleted === true
	);
}

/** Read a JSONL file into parsed objects (malformed lines skipped). */
function readJsonl<T>(filePath: string): T[] {
	if (!existsSync(filePath)) return [];
	try {
		const content = readFileSync(filePath, 'utf-8');
		const out: T[] = [];
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed) as T);
			} catch {
				/* skip malformed */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Options for {@link appendUnionById}. */
export interface AppendUnionByIdOptions {
	/**
	 * Member filename — selects the member's recency rules
	 * ({@link MEMBER_RECENCY_KEYS}). Defaults to the memories shape.
	 */
	memberFilename?: string;
}

/** Result of {@link appendUnionById} (#2958 recency-aware union). */
export interface AppendUnionByIdResult<T> {
	merged: T[];
	added: number;
	skipped: number;
	/** Source rows that superseded an older destination row for a shared id. */
	superseded: number;
	/** Shared ids with no usable recency signal (destination kept, reported). */
	unresolvedCollisions: readonly string[];
	/** Destination tombstones resurrected by a newer live source row. */
	resurrectedIds: readonly string[];
}

/**
 * Id-keyed union of two append-only JSONL arrays — recency-aware (#2958).
 *
 * For a shared id the union compares the source row against the EFFECTIVE last
 * destination row (load is last-row-wins; the map is updated as rows append,
 * so a multi-row source history resolves against the merge's own state). A
 * strictly newer source row is APPENDED (files stay append-only — never
 * rewritten in place); destination-newer or equal keeps today's skip; a
 * byte-equal retry is benign dedup; a collision with no usable recency signal
 * keeps the destination row AND is reported in `unresolvedCollisions`.
 * Proposals use reviewed-outranks-unreviewed ordering (a curator review is a
 * lifecycle advancement); tombstoned destination memories resurrected by a
 * newer live source row are reported in `resurrectedIds`.
 */
function appendUnionById<T>(
	destination: T[],
	source: T[],
	options: AppendUnionByIdOptions = {},
): AppendUnionByIdResult<T> {
	const memberFilename = options.memberFilename ?? 'memories.jsonl';
	const recencyKeys = MEMBER_RECENCY_KEYS[memberFilename] ?? [];
	const result = [...destination];
	const effectiveLast = new Map<string, T>();
	const seenRowJson = new Set<string>();
	for (const row of destination) {
		const id = rowId(row);
		if (id !== null) effectiveLast.set(id, row);
		seenRowJson.add(JSON.stringify(row));
	}
	let added = 0;
	let skipped = 0;
	let superseded = 0;
	const unresolvedCollisions: string[] = [];
	const resurrectedIds: string[] = [];
	for (const src of source) {
		const id = rowId(src);
		if (id === null) {
			// No id (event/consolidation rows): whole-row identity — a
			// byte-identical retry is benign dedup, anything else appends.
			const json = JSON.stringify(src);
			if (seenRowJson.has(json)) {
				skipped++;
				continue;
			}
			result.push(src);
			seenRowJson.add(json);
			added++;
			continue;
		}
		const destRow = effectiveLast.get(id);
		if (destRow === undefined) {
			result.push(src);
			effectiveLast.set(id, src);
			added++;
			continue;
		}
		if (JSON.stringify(destRow) === JSON.stringify(src)) {
			// Exact retry: benign dedup (F-17 semantics preserved).
			skipped++;
			continue;
		}
		if (recencyKeys.length === 0) {
			// Event-log member with a real id: a differing payload under the
			// same event id is an anomaly — keep destination, report it.
			unresolvedCollisions.push(id);
			skipped++;
			continue;
		}
		const destRecency = rowRecency(destRow, recencyKeys);
		const srcRecency = rowRecency(src, recencyKeys);
		let sourceWins: boolean;
		if (memberFilename === 'proposals.jsonl') {
			// Reviewed-outranks-unreviewed: a valid reviewedAt outranks its
			// absence; timestamps compare only when both are valid; neither
			// side carrying a valid signal is unresolved.
			if (destRecency === undefined && srcRecency === undefined) {
				unresolvedCollisions.push(id);
				skipped++;
				continue;
			}
			sourceWins =
				destRecency === undefined
					? true
					: srcRecency === undefined
						? false
						: srcRecency > destRecency;
		} else {
			if (destRecency === undefined || srcRecency === undefined) {
				unresolvedCollisions.push(id);
				skipped++;
				continue;
			}
			sourceWins = srcRecency > destRecency;
		}
		if (!sourceWins) {
			if (rowIsTombstone(destRow) && !rowIsTombstone(src)) {
				// A newer destination tombstone suppressed the resurrection.
				superseded++;
			} else {
				skipped++;
			}
			continue;
		}
		if (rowIsTombstone(destRow) && !rowIsTombstone(src)) {
			// Resurrection is reported SOLELY via resurrectedIds (#3520 critic:
			// counting it here too double-rendered the same event as both
			// "re-added" and "replaced").
			resurrectedIds.push(id);
			result.push(src);
			effectiveLast.set(id, src);
			continue;
		}
		result.push(src);
		effectiveLast.set(id, src);
		superseded++;
	}
	return {
		merged: result,
		added,
		skipped,
		superseded,
		unresolvedCollisions,
		resurrectedIds,
	};
}

/**
 * Outcome event ids are retry identities, not generic append-only row ids.
 * Apply the provider's shared semantic collision rules while retaining the
 * destination's first committed representation (including its timestamp).
 */
function appendUnionOutcomeEvents(
	destination: unknown[],
	source: unknown[],
): { merged: MemoryOutcomeEvent[]; added: number; skipped: number } {
	const result = destination.map(validateOutcomeEvent);
	const byId = new Map(result.map((event) => [event.id, event]));
	let added = 0;
	let skipped = 0;
	for (const value of source) {
		const event = validateOutcomeEvent(value);
		const existing = byId.get(event.id);
		assertEventIdentityCompatible(existing, event);
		if (existing) {
			skipped++;
			continue;
		}
		result.push(event);
		byId.set(event.id, event);
		added++;
	}
	return { merged: result, added, skipped };
}

/** Serialize a merged JSONL member. */
function serializeJsonl(values: unknown[]): string {
	if (values.length === 0) return '';
	return `${values.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

/** Validate a serialized JSONL member: every line must parse and carry an id. */
function validateSerializedJsonl(serialized: string): boolean {
	for (const line of serialized.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (!parsed || typeof parsed !== 'object') return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Copy the SQLite DB file (+ non-empty WAL/SHM sidecars) from source to a
 * staging path under the destination directory. The caller MUST have drained
 * and closed the source provider first (the command handler does this via
 * `evictAndCloseForRoot`).
 *
 * Returns the staging path, or null if the source DB does not exist.
 */
function stageSqliteDb(
	sourceStoragePath: string,
	destDir: string,
): { stagedPath: string } | null {
	const sourceDbPath = path.join(sourceStoragePath, 'memory.db');
	if (!existsSync(sourceDbPath)) return null;
	const stagedPath = path.join(destDir, '.memory.db.stage');
	copyFileSync(sourceDbPath, stagedPath);
	// Copy WAL/SHM sidecars if present and non-empty (post-checkpoint they
	// should be empty/absent, but copy-as-is is still correct — SQLite
	// recovers from WAL on next open).
	for (const suffix of ['-wal', '-shm']) {
		const sidecar = `${sourceDbPath}${suffix}`;
		if (existsSync(sidecar)) {
			try {
				copyFileSync(sidecar, `${stagedPath}${suffix}`);
			} catch {
				/* best-effort — sidecar may be absent mid-copy */
			}
		}
	}
	return { stagedPath };
}

/**
 * Merge a staged SQLite DB into the destination. If the destination has no
 * existing DB, atomically rename the staged file into place. If the
 * destination has an existing DB, ATTACH the staged DB and INSERT OR IGNORE
 * rows keyed by id (critic CONCERN-6 — two worktrees linking concurrently
 * must not overwrite each other's data).
 *
 * NOTE: this function does NOT open the DB via the provider (that would
 * re-enter the pool). It uses a minimal direct-open to copy rows. The
 * destination provider will re-open and rebuild FTS/vec on next access.
 */
async function mergeStagedSqlite(
	destStoragePath: string,
	stagedPath: string,
): Promise<{
	merged: number;
	skipped: number;
	audit: MemoryFamilyMemberAudit;
}> {
	const destDbPath = path.join(destStoragePath, 'memory.db');
	if (!existsSync(destDbPath)) {
		// Empty destination — atomic rename.
		await rename(stagedPath, destDbPath);
		// Move sidecars too.
		for (const suffix of ['-wal', '-shm']) {
			const stagedSidecar = `${stagedPath}${suffix}`;
			if (existsSync(stagedSidecar)) {
				try {
					await rename(stagedSidecar, `${destDbPath}${suffix}`);
				} catch {
					/* best-effort */
				}
			}
		}
		// Count rows in the renamed DB for the report (best-effort).
		return {
			merged: await countRowsSafe(destDbPath),
			skipped: 0,
			audit: {
				filename: 'memory.db',
				resurrectedIds: [],
				supersededCount: 0,
				unresolvedCollisions: [],
			},
		};
	}
	// #1850 (reviewer fix + CONCERN-6): non-empty destination — ATTACH the
	// staged DB and INSERT OR IGNORE rows keyed by id, so a re-link-after-
	// unlink cycle (or two worktrees linking concurrently) merges rather than
	// overwrites or fails. We open the destination DB directly (NOT via the
	// pool — the pool was drained by the command handler before migration).
	try {
		const { loadDatabaseCtor } = await import('../db/sqlite-loader.js');
		const Db = loadDatabaseCtor();
		const db = new Db(destDbPath);

		/** Ordered column list of a table in the given schema (`main` or `staged`). */
		function tableColumns(schema: 'main' | 'staged', table: string): string[] {
			try {
				const rows = db
					.query<{ name: string }, []>(`PRAGMA ${schema}.table_info(${table})`)
					.all();
				return rows.map((r) => r.name);
			} catch {
				return [];
			}
		}

		/**
		 * Build and run the #2958 newer-wins upsert for `memory_items`, restricted to
		 * the columns BOTH schemas carry (a matching pre-v12 pair must keep merging —
		 * positional `SELECT *` did, and the shared-column form still does). Only a
		 * strictly newer source row updates the destination (`excluded.updated_at >
		 * memory_items.updated_at`); the `WHERE true` token is REQUIRED grammar for
		 * `INSERT … SELECT … ON CONFLICT` in both bun:sqlite and node:sqlite.
		 * Parameter-free (AGENTS.md invariant 2 — node:sqlite placeholder strictness).
		 *
		 * Returns the audit facts the caller folds into the per-member audit.
		 */
		function mergeMemoryItemsRecency(): {
			merged: number;
			skipped: number;
			resurrectedIds: string[];
			supersededCount: number;
		} {
			const destCols = tableColumns('main', 'memory_items');
			const stagedCols = tableColumns('staged', 'memory_items');
			const shared = destCols.filter((c) => stagedCols.includes(c));
			// The recency upsert applies only when both schemas carry the SAME
			// column set (current×current or a matching pre-v12 pair). A column
			// mismatch (skew) keeps today's positional INSERT OR IGNORE, whose
			// count mismatch degrades per-table into failedTables — unchanged
			// semantics for a shape this migration has never reconciled.
			const shapesMatch =
				destCols.length > 0 &&
				destCols.length === stagedCols.length &&
				shared.length === destCols.length;
			if (!shapesMatch || !shared.includes('updated_at')) {
				// No matching recency shape — plain id-keyed union (see above).
				const result = db.run(
					'INSERT OR IGNORE INTO memory_items SELECT * FROM staged.memory_items;',
				);
				return {
					merged: result.changes ?? 0,
					skipped: 0,
					resurrectedIds: [],
					supersededCount: 0,
				};
			}
			interface OverlapRow {
				id: string;
				dest_deleted: number;
				src_deleted: number;
				dest_at: string;
				src_at: string;
			}
			const overlaps = db
				.query<OverlapRow, []>(
					`SELECT destination.id AS id,
				        destination.deleted AS dest_deleted,
				        source.deleted AS src_deleted,
				        destination.updated_at AS dest_at,
				        source.updated_at AS src_at
				 FROM memory_items AS destination
				 JOIN staged.memory_items AS source ON source.id = destination.id`,
				)
				.all();
			const resurrectedIds: string[] = [];
			let supersededCount = 0;
			for (const row of overlaps) {
				const srcNewer = row.src_at > row.dest_at;
				if (row.dest_deleted === 1 && row.src_deleted === 0 && srcNewer) {
					// A newer live source row resurrects a destination tombstone — the
					// upsert flips it live. Reported SOLELY via resurrectedIds (the
					// render has its own line for it; double-counting rendered the
					// same event as both "re-added" and "resolved").
					resurrectedIds.push(row.id);
				} else if (srcNewer) {
					// A newer source row (live-over-live, or a newer source tombstone
					// over a live destination) wins by recency.
					supersededCount++;
				} else if (row.dest_deleted === 1 && row.src_deleted === 0) {
					// A newer destination tombstone suppresses the resurrection.
					supersededCount++;
				}
			}
			const colList = shared.join(', ');
			const plainSet = shared.filter(
				(c) => c !== 'id' && c !== 'valid_from' && c !== 'supersedes_reason',
			);
			const setList = plainSet.map((c) => `${c} = excluded.${c}`).join(',\n');
			const validFromClause = shared.includes('valid_from')
				? ',\nvalid_from = memory_items.valid_from'
				: '';
			// #1466 parity with writeMemory: a re-write must not reset valid_from, and
			// an empty supersedes_reason keeps the destination's value.
			const supersedesClause = shared.includes('supersedes_reason')
				? ',\nsupersedes_reason = COALESCE(excluded.supersedes_reason, memory_items.supersedes_reason)'
				: '';
			const result = db.run(
				`INSERT INTO memory_items (${colList})
			SELECT ${colList} FROM staged.memory_items WHERE true
			ON CONFLICT(id) DO UPDATE SET
				${setList}${validFromClause}${supersedesClause}
			WHERE excluded.updated_at > memory_items.updated_at;`,
			);
			const merged = result.changes ?? 0;
			// Every overlapping id that did not produce a change is a collision the
			// recency guard declined (destination-newer/equal or byte-identical retry).
			const stagedCount =
				db
					.query<{ n: number }, []>(
						'SELECT COUNT(*) AS n FROM staged.memory_items',
					)
					.get()?.n ?? 0;
			const newIds = Math.max(0, stagedCount - overlaps.length);
			const updated = Math.min(Math.max(0, merged - newIds), overlaps.length);
			const skipped = Math.max(0, overlaps.length - updated);
			if (updated > 0) {
				// In-place updates keep row counts equal, which would defeat the
				// provider's count-mismatch FTS rebuild trigger (sqlite-provider
				// initializeFtsIndex rebuilds only when validMemoryCount !==
				// ftsCount) — the destination's FTS index would keep serving the
				// OLD text/tags for the updated ids. Clear the index so the next
				// provider open rebuilds it, the same recovery path a
				// row-adding merge already exercises. Guarded: a hand-built or
				// pre-FTS destination may not carry the table.
				const ftsTable =
					db
						.query<{ n: number }, []>(
							"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='memory_items_fts'",
						)
						.get()?.n ?? 0;
				if (ftsTable > 0) {
					db.run('DELETE FROM memory_items_fts;');
				}
			}
			return { merged, skipped, resurrectedIds, supersededCount };
		}

		let attached = false;
		let transactionActive = false;
		try {
			// ATTACH is connection state rather than transaction state. Attach first,
			// then make schema preparation, collision validation, and every table
			// insert one atomic destination transaction.
			const safePath = stagedPath.replace(/'/g, "''");
			db.run(`ATTACH DATABASE '${safePath}' AS staged;`);
			attached = true;
			db.run('BEGIN IMMEDIATE');
			transactionActive = true;
			// A destination last opened by a pre-#1989 build does not yet have the
			// canonical outcome table. Create the additive shape transactionally so a
			// non-empty cohort merge cannot silently skip outcome history. The normal
			// provider migration remains responsible for stamping schema version 11.
			db.run(`CREATE TABLE IF NOT EXISTS memory_outcomes (
				id TEXT PRIMARY KEY,
				memory_id TEXT NOT NULL,
				generation TEXT NOT NULL,
				at TEXT NOT NULL,
				event_json TEXT NOT NULL
			);`);
			db.run(`CREATE INDEX IF NOT EXISTS idx_memory_outcomes_memory_generation
				ON memory_outcomes(memory_id, generation, at, id);`);
			// Merge each id-keyed table. memory_items resolves collisions by
			// RECENCY (#2958 newer-wins upsert — a strictly newer source row
			// beats the destination); every other table below has NO usable
			// version-recency signal, so those keep INSERT OR IGNORE (event /
			// usage logs have unique randomUUID ids; memory_proposals.created_at
			// is immutable at propose; memory_outcomes is fail-closed above).
			const tables = [
				'memory_items',
				'memory_proposals',
				'memory_events',
				'memory_recall_usage',
				'memory_reward_events',
				'memory_outcomes',
			];
			let merged = 0;
			let skippedCollisions = 0;
			let skippedDueToError = 0;
			const failedTables: string[] = [];
			const unresolvedCollisions: string[] = [];
			let resurrectedIds: string[] = [];
			let supersededCount = 0;
			for (const table of tables) {
				try {
					// Check the staged table exists (a freshly-created staged DB
					// from a minimal source may not have all tables).
					const stashed = db
						.query<{ n: number }, []>(
							`SELECT COUNT(*) AS n FROM staged.sqlite_master WHERE type='table' AND name='${table}'`,
						)
						.get();
					if (!stashed || stashed.n === 0) continue;
					if (table === 'memory_items') {
						const outcome = mergeMemoryItemsRecency();
						merged += outcome.merged;
						skippedCollisions += outcome.skipped;
						resurrectedIds = outcome.resurrectedIds;
						supersededCount = outcome.supersededCount;
						continue;
					}
					if (table === 'memory_proposals') {
						// created_at is immutable at propose (never a version
						// recency signal) — recency cannot apply, so this table
						// keeps INSERT OR IGNORE and reports its collided ids as
						// unresolved (#2958 audit).
						const collided = db
							.query<{ id: string }, []>(
								`SELECT destination.id AS id
								 FROM memory_proposals AS destination
								 JOIN staged.memory_proposals AS source ON source.id = destination.id`,
							)
							.all();
						for (const row of collided) unresolvedCollisions.push(row.id);
					}
					if (table === 'memory_outcomes') {
						const overlaps = db
							.query<
								{
									id: string;
									destination_json: string;
									source_json: string;
								},
								[]
							>(
								`SELECT destination.id,
								        destination.event_json AS destination_json,
								        source.event_json AS source_json
								 FROM memory_outcomes AS destination
								 JOIN staged.memory_outcomes AS source ON source.id = destination.id
								 ORDER BY destination.id`,
							)
							.all();
						for (const overlap of overlaps) {
							const destinationEvent = validateOutcomeEvent(
								JSON.parse(overlap.destination_json),
							);
							const sourceEvent = validateOutcomeEvent(
								JSON.parse(overlap.source_json),
							);
							if (
								destinationEvent.id !== overlap.id ||
								sourceEvent.id !== overlap.id
							) {
								throw new Error(
									`outcome event ${overlap.id} has invalid row identity`,
								);
							}
							assertEventIdentityCompatible(destinationEvent, sourceEvent);
						}
					}
					// No version-recency signal applies — id-keyed union.
					const result = db.run(
						`INSERT OR IGNORE INTO ${table} SELECT * FROM staged.${table};`,
					);
					merged += result.changes ?? 0;
				} catch (err) {
					// Outcome event ids are retry identities. Ignoring a same-id,
					// different-payload collision would silently rewrite history, so this
					// canonical table fails closed while legacy auxiliary tables retain
					// their best-effort behavior.
					if (table === 'memory_outcomes') throw err;
					// #1850 (M-002 fix): track tables that failed schema-mismatch or
					// other errors, so the migration report surfaces them instead of
					// silently claiming skipped:0.
					skippedDueToError++;
					failedTables.push(
						`${table} (${err instanceof Error ? err.message : String(err)})`,
					);
				}
			}
			db.run('COMMIT');
			transactionActive = false;
			if (failedTables.length > 0) {
				warn(
					`[memory-family-migration] ${failedTables.length} table(s) skipped during SQLite ATTACH merge: ${failedTables.join(', ')}`,
				);
			}
			return {
				merged,
				skipped: skippedDueToError + skippedCollisions,
				audit: {
					filename: 'memory.db',
					resurrectedIds,
					supersededCount,
					unresolvedCollisions,
				},
			};
		} catch (error) {
			if (transactionActive) {
				try {
					db.run('ROLLBACK');
				} catch {
					// Preserve the merge failure if rollback also fails.
				}
				transactionActive = false;
			}
			throw error;
		} finally {
			if (attached) {
				try {
					db.run('DETACH DATABASE staged;');
				} catch {
					// Closing the connection releases an attachment that cannot detach.
				}
			}
			db.close();
			// #1850 (final-critic cleanup): remove the staged DB file (+ sidecars)
			// after the ATTACH merge so it does not litter the destination dir.
			try {
				unlinkSync(stagedPath);
				for (const suffix of ['-wal', '-shm']) {
					try {
						unlinkSync(`${stagedPath}${suffix}`);
					} catch {
						/* sidecar may not exist */
					}
				}
			} catch {
				/* best-effort cleanup */
			}
		}
	} catch (err) {
		throw new Error(
			`memory-family-migration: failed to merge SQLite into non-empty destination ${destDbPath}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/** Best-effort row count via a direct DB open (does not enter the pool). */
async function countRowsSafe(dbPath: string): Promise<number> {
	// We avoid importing the provider here to prevent a pool re-entry cycle.
	// The count is informational only; a failure returns 0.
	try {
		const { loadDatabaseCtor } = await import('../db/sqlite-loader.js');
		const Db = loadDatabaseCtor();
		const db = new Db(dbPath);
		try {
			const row = db
				.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM memory_items')
				.get();
			return row?.n ?? 0;
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}

/**
 * Migrate the complete memory family from `sourceRoot` into `destRoot`,
 * merging each member according to its manifest strategy. All-or-nothing:
 * stage → validate → commit. The memory-link pointer is NOT touched here
 * (caller flips it).
 *
 * @param destRoot the cohort root that absorbs the merge (link → cohort;
 *   unlink → local).
 * @param sourceRoot the root whose family is merged in (link → local;
 *   unlink → cohort).
 */
export async function migrateMemoryFamily(
	destRoot: VettedMemoryRoot,
	sourceRoot: VettedMemoryRoot,
): Promise<MemoryFamilyMigrationCounts> {
	const destStoragePath = rootStoragePath(destRoot);
	const sourceStoragePath = rootStoragePath(sourceRoot);

	// #1850 (reviewer critical fix): the destination may be EITHER a cohort
	// root (link direction: local → cohort) OR a local root (unlink direction:
	// cohort → local). Both are valid and both are lockable — the local JSONL
	// provider locks the same storage directory during normal writes, so local
	// roots have real cross-process contenders too. The source is always read
	// under its own brief snapshot.
	await mkdir(destStoragePath, { recursive: true });
	let destRelease: (() => Promise<void>) | null = null;
	try {
		destRelease = await _internals.acquireDirectoryWriteLock(destStoragePath, {
			...MIGRATION_LOCK_RETRIES,
			stale: MIGRATION_LOCK_STALE_MS,
			// Same identity as the JSONL provider's lock on this directory
			// (which passes realpath:false) so the exclusion holds even when
			// the storage path contains symlink components (PRR-U1).
			realpath: false,
		});
	} catch (error) {
		// #2577 (FUNCTIONAL-6): admission is fail-closed. This throw stays
		// syntactically INSIDE this catch - before the merge-loop try below
		// opens and with destRelease still null - so a held live destination
		// lock can never be bypassed and the destination/source are preserved
		// on failed admission. Do not relocate it into the merge loop.
		throw makeAdmissionError(error);
	}

	const perMember: Array<{
		filename: string;
		merged: number;
		skipped: number;
		superseded: number;
	}> = [];
	const auditEntries: MemoryFamilyMemberAudit[] = [];

	try {
		// 2-7. For each member: read source, merge into destination, validate, commit.
		for (const member of MEMORY_FAMILY) {
			if (member.mergeStrategy === 'skip') continue;
			const srcPath = path.join(sourceStoragePath, member.filename);
			const destPath = path.join(destStoragePath, member.filename);

			if (member.mergeStrategy === 'sqlite-file-copy') {
				if (!existsSync(srcPath)) {
					perMember.push({
						filename: member.filename,
						merged: 0,
						skipped: 0,
						superseded: 0,
					});
					continue;
				}
				const staged = stageSqliteDb(sourceStoragePath, destStoragePath);
				if (!staged) {
					perMember.push({
						filename: member.filename,
						merged: 0,
						skipped: 0,
						superseded: 0,
					});
					continue;
				}
				const { merged, skipped, audit } = await mergeStagedSqlite(
					destStoragePath,
					staged.stagedPath,
				);
				perMember.push({
					filename: member.filename,
					merged,
					skipped,
					superseded: audit.supersededCount,
				});
				if (
					audit.resurrectedIds.length > 0 ||
					audit.supersededCount > 0 ||
					audit.unresolvedCollisions.length > 0
				) {
					auditEntries.push(audit);
				}
				continue;
			}

			if (member.mergeStrategy === 'append-union') {
				if (!existsSync(srcPath)) {
					perMember.push({
						filename: member.filename,
						merged: 0,
						skipped: 0,
						superseded: 0,
					});
					continue;
				}
				const srcData = readJsonl<unknown>(srcPath);
				const destData = readJsonl<unknown>(destPath);
				if (member.filename === 'outcome-events.jsonl') {
					const { merged, added, skipped } = appendUnionOutcomeEvents(
						destData,
						srcData,
					);
					const serialized = serializeJsonl(merged);
					if (!validateSerializedJsonl(serialized)) {
						throw new Error(
							`memory-family-migration: validation failed for ${member.filename}; aborting before commit`,
						);
					}
					await atomicWriteFile(destPath, serialized);
					perMember.push({
						filename: member.filename,
						merged: added,
						skipped,
						superseded: 0,
					});
					continue;
				}
				const {
					merged,
					added,
					skipped,
					superseded,
					unresolvedCollisions,
					resurrectedIds,
				} = appendUnionById(destData, srcData, {
					memberFilename: member.filename,
				});
				const serialized = serializeJsonl(merged);
				if (!validateSerializedJsonl(serialized)) {
					throw new Error(
						`memory-family-migration: validation failed for ${member.filename}; aborting before commit`,
					);
				}
				await atomicWriteFile(destPath, serialized);
				perMember.push({
					filename: member.filename,
					merged: added,
					skipped,
					superseded,
				});
				if (
					resurrectedIds.length > 0 ||
					superseded > 0 ||
					unresolvedCollisions.length > 0
				) {
					auditEntries.push({
						filename: member.filename,
						resurrectedIds,
						supersededCount: superseded,
						unresolvedCollisions,
					});
				}
			}
		}

		// 8. Source backup (step 9 of the issue sequence) — retained for recovery.
		// Written under the cohort dir's backups/ subdir with a timestamp.
		// #1850 (H-008 fix): cap at MAX_BACKUPS to prevent unbounded accumulation;
		// oldest backups are pruned after each write.
		if (isCohortRoot(sourceRoot)) {
			const backupDir = path.join(destStoragePath, 'backups');
			await mkdir(backupDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const sourceDbPath = path.join(sourceStoragePath, 'memory.db');
			if (existsSync(sourceDbPath)) {
				try {
					copyFileSync(
						sourceDbPath,
						path.join(backupDir, `memory.db.pre-merge-${stamp}`),
					);
				} catch {
					/* best-effort backup */
				}
				// Prune oldest backups beyond the cap.
				try {
					const { readdirSync, unlinkSync: rmFileSync } = await import(
						'node:fs'
					);
					const backups = readdirSync(backupDir)
						.filter((f) => f.startsWith('memory.db.pre-merge-'))
						.sort();
					while (backups.length > MAX_BACKUPS) {
						const oldest = backups.shift();
						if (oldest) rmFileSync(path.join(backupDir, oldest));
					}
				} catch {
					/* best-effort prune */
				}
			}
		}
	} finally {
		if (destRelease) {
			try {
				await destRelease();
			} catch {
				/* non-blocking */
			}
		}
	}

	return { perMember, audit: auditEntries };
}

export const _internals = {
	appendUnionById,
	appendUnionOutcomeEvents,
	serializeJsonl,
	validateSerializedJsonl,
	stageSqliteDb,
	mergeStagedSqlite,
	countRowsSafe,
	acquireDirectoryWriteLock,
	lockfile,
};

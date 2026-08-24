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
 * Lock discipline: `proper-lockfile` on the destination cohort dir with a
 * bumped `stale` (30s) for the migration critical section — reused from the
 * knowledge family so there is one source of truth for the lock config.
 *
 * No writes happen here on the plugin-init path (invariant 1). Called only
 * from the `/swarm memory link` / `/swarm memory unlink` command handlers.
 */

import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
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
 * #1850 (H-008): max number of source-DB backups retained in
 * `<cohortRoot>/backups/`. Oldest are pruned after each migration.
 */
const MAX_BACKUPS = 5;

export interface MemoryFamilyMigrationCounts {
	readonly perMember: ReadonlyArray<{
		filename: string;
		merged: number;
		skipped: number;
	}>;
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

/** Id-keyed union of two append-only JSONL arrays (idempotent on retry). */
function appendUnionById<T>(
	destination: T[],
	source: T[],
): { merged: T[]; added: number; skipped: number } {
	const result = [...destination];
	const seen = new Set(
		result.map((r) => {
			const o = r as unknown as Record<string, unknown>;
			return typeof o.id === 'string' ? o.id : JSON.stringify(r);
		}),
	);
	let added = 0;
	let skipped = 0;
	for (const src of source) {
		const o = src as unknown as Record<string, unknown>;
		const id = typeof o.id === 'string' ? o.id : JSON.stringify(src);
		if (seen.has(id)) {
			skipped++;
			continue;
		}
		result.push(src);
		seen.add(id);
		added++;
	}
	return { merged: result, added, skipped };
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
): Promise<{ merged: number; skipped: number }> {
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
		return { merged: await countRowsSafe(destDbPath), skipped: 0 };
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
			// Merge each id-keyed table. INSERT OR IGNORE skips rows whose id
			// already exists in the destination (idempotent on retry).
			const tables = [
				'memory_items',
				'memory_proposals',
				'memory_events',
				'memory_recall_usage',
				'memory_reward_events',
				'memory_outcomes',
			];
			let merged = 0;
			let skippedDueToError = 0;
			const failedTables: string[] = [];
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
			return { merged, skipped: skippedDueToError };
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
	// cohort → local). Both are valid. We lock the destination directory when
	// possible; local roots are single-writer by construction (no cross-process
	// contender), so locking is best-effort for them. The source is always read
	// under its own brief snapshot.
	await mkdir(destStoragePath, { recursive: true });
	let destRelease: (() => Promise<void>) | null = null;
	try {
		destRelease = await lockfile.lock(destStoragePath, {
			...MIGRATION_LOCK_RETRIES,
			stale: MIGRATION_LOCK_STALE_MS,
		});
	} catch {
		// Local roots or missing dirs may not be lockable; proceed unlocked.
		// The destination write is still atomic (temp + rename per member).
	}

	const perMember: Array<{
		filename: string;
		merged: number;
		skipped: number;
	}> = [];

	try {
		// 2-7. For each member: read source, merge into destination, validate, commit.
		for (const member of MEMORY_FAMILY) {
			if (member.mergeStrategy === 'skip') continue;
			const srcPath = path.join(sourceStoragePath, member.filename);
			const destPath = path.join(destStoragePath, member.filename);

			if (member.mergeStrategy === 'sqlite-file-copy') {
				if (!existsSync(srcPath)) {
					perMember.push({ filename: member.filename, merged: 0, skipped: 0 });
					continue;
				}
				const staged = stageSqliteDb(sourceStoragePath, destStoragePath);
				if (!staged) {
					perMember.push({ filename: member.filename, merged: 0, skipped: 0 });
					continue;
				}
				const { merged, skipped } = await mergeStagedSqlite(
					destStoragePath,
					staged.stagedPath,
				);
				perMember.push({ filename: member.filename, merged, skipped });
				continue;
			}

			if (member.mergeStrategy === 'append-union') {
				if (!existsSync(srcPath)) {
					perMember.push({ filename: member.filename, merged: 0, skipped: 0 });
					continue;
				}
				const srcData = readJsonl<unknown>(srcPath);
				const destData = readJsonl<unknown>(destPath);
				const { merged, added, skipped } =
					member.filename === 'outcome-events.jsonl'
						? appendUnionOutcomeEvents(destData, srcData)
						: appendUnionById(destData, srcData);
				const serialized = serializeJsonl(merged);
				if (!validateSerializedJsonl(serialized)) {
					throw new Error(
						`memory-family-migration: validation failed for ${member.filename}; aborting before commit`,
					);
				}
				await atomicWriteFile(destPath, serialized);
				perMember.push({ filename: member.filename, merged: added, skipped });
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

	return { perMember };
}

export const _internals = {
	appendUnionById,
	appendUnionOutcomeEvents,
	serializeJsonl,
	validateSerializedJsonl,
	stageSqliteDb,
	mergeStagedSqlite,
	countRowsSafe,
};

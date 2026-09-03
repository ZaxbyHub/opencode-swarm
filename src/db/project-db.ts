/**
 * Per-project SQLite database for opencode-swarm.
 *
 * Owns `.swarm/swarm.db` in each project directory: the single durable
 * substrate of Workstream D (issue #2480). One cached instance per CANONICAL
 * project identity (`canonical-project.ts`): case-varied Windows spellings,
 * trailing separators, and symlinked roots of the same project share one
 * connection. Open failures are typed (`db-errors.ts`), failed migrations are
 * recorded for diagnosis and retried on the next open, and close runs a
 * best-effort WAL checkpoint. The durability-class policy for every table
 * lives in `durability.ts`.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write.js';
import {
	canonicalRootKeyFresh,
	lexicalRootAliasKey,
} from '../utils/canonical-root.js';
import { canonicalExistingFilesystemPath } from '../utils/filesystem-identity.js';
import { ProjectDbError } from './db-errors.js';
import { loadDatabaseCtor } from './sqlite-loader.js';

// The `import type { Database }` above is erased at build. The runtime driver is
// resolved by the shared, runtime-portable loader (`./sqlite-loader.ts`): native
// `bun:sqlite` under Bun, a `node:sqlite` adapter under Node (issue #1873 /
// invariant #2). Keeping the resolution lazy (via the loader) also preserves the
// issue #675 guarantee that the bundle has no top-level `bun:` import.

interface Migration {
	version: number;
	name: string;
	sql: string;
}

/** Cap on the recorded migration error text (bounded rows, bounded columns). */
const MIGRATION_FAILURE_ERROR_MAX_CHARS = 500;

/**
 * Name of the side-channel marker used when a migration fails before the
 * `migration_failures` table exists (i.e. a failure inside v14 itself) or when
 * the DB refuses the insert (disk full / read only). Removed on the next
 * successful migration run.
 */
const MIGRATION_FAILURE_MARKER = 'db-migration-failure.json';

/** Bounded retries for cross-process first-open migration contention. */
const MIGRATION_BUSY_RETRIES = 2;
const OPEN_CONTENTION_RETRIES = 4;

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: 'create_project_constraints',
		sql: `CREATE TABLE project_constraints (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			constraint_type TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
	},
	{
		version: 2,
		name: 'create_qa_gate_profile',
		sql: `CREATE TABLE qa_gate_profile (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			plan_id TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			project_type TEXT,
			gates TEXT NOT NULL DEFAULT '{}',
			locked_at TEXT,
			locked_by_snapshot_seq INTEGER
		)`,
	},
	{
		version: 3,
		name: 'create_qa_gate_profile_immutability_trigger',
		sql: `CREATE TRIGGER IF NOT EXISTS trg_qa_gate_profile_no_update_after_lock
			BEFORE UPDATE ON qa_gate_profile
			WHEN OLD.locked_at IS NOT NULL
			BEGIN
				SELECT RAISE(ABORT, 'qa_gate_profile row is locked and cannot be modified after critic approval');
			END`,
	},
	{
		version: 4,
		name: 'add_qa_gate_profile_raw_swarm',
		sql: 'ALTER TABLE qa_gate_profile ADD COLUMN raw_swarm TEXT',
	},
	{
		version: 5,
		name: 'add_qa_gate_profile_raw_title',
		sql: 'ALTER TABLE qa_gate_profile ADD COLUMN raw_title TEXT',
	},
	{
		version: 6,
		name: 'add_qa_gate_profile_identity_hash',
		sql: 'ALTER TABLE qa_gate_profile ADD COLUMN identity_hash TEXT',
	},
	{
		version: 7,
		name: 'create_qa_gate_profile_identity_hash_index',
		sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_gate_profile_identity_hash
			ON qa_gate_profile(identity_hash)
			WHERE identity_hash IS NOT NULL`,
	},
	{
		version: 8,
		name: 'create_qa_gate_profile_identity',
		sql: `CREATE TABLE qa_gate_profile_identity (
			identity_hash TEXT PRIMARY KEY,
			profile_id INTEGER NOT NULL UNIQUE REFERENCES qa_gate_profile(id) ON DELETE CASCADE,
			raw_swarm TEXT NOT NULL,
			raw_title TEXT NOT NULL,
			readable_plan_id TEXT NOT NULL
		)`,
	},
	{
		version: 9,
		name: 'create_qa_gate_profile_identity_readable_plan_index',
		sql: `CREATE INDEX idx_qa_gate_profile_identity_readable_plan_id
			ON qa_gate_profile_identity(readable_plan_id)`,
	},
	{
		version: 10,
		name: 'backfill_qa_gate_profile_identity_from_legacy_columns',
		sql: `INSERT INTO qa_gate_profile_identity (
				identity_hash,
				profile_id,
				raw_swarm,
				raw_title,
				readable_plan_id
			)
			SELECT
				identity_hash,
				id,
				raw_swarm,
				raw_title,
				plan_id
			FROM qa_gate_profile
			WHERE identity_hash IS NOT NULL
				AND raw_swarm IS NOT NULL
				AND raw_title IS NOT NULL
				AND NOT EXISTS (
					SELECT 1
					FROM qa_gate_profile_identity AS qi
					WHERE qi.profile_id = qa_gate_profile.id
				)`,
	},
	{
		version: 11,
		name: 'create_task_checkpoint_receipt',
		sql: `CREATE TABLE task_checkpoint_receipt (
			plan_identity_hash TEXT NOT NULL,
			task_id TEXT NOT NULL,
			label TEXT NOT NULL,
			state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'logged')),
			sha TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY(plan_identity_hash, task_id)
		)`,
	},
	{
		version: 12,
		name: 'add_task_checkpoint_receipt_completion_generation',
		sql: `ALTER TABLE task_checkpoint_receipt
			ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
		ALTER TABLE task_checkpoint_receipt
			ADD COLUMN completion_active INTEGER NOT NULL DEFAULT 1
			CHECK(completion_active IN (0, 1))`,
	},
	{
		version: 13,
		name: 'bind_task_checkpoint_receipt_to_completion_ledger_seq',
		sql: `ALTER TABLE task_checkpoint_receipt
			ADD COLUMN completion_ledger_seq INTEGER
			CHECK(completion_ledger_seq IS NULL OR completion_ledger_seq >= 0)`,
	},
	// Issue #2480 (Workstream D1): the durable-state foundation tables. Each
	// migration is a SINGLE statement so a partial application can never hide
	// behind a multi-statement string split across drivers.
	{
		version: 14,
		name: 'create_migration_failures',
		sql: `CREATE TABLE IF NOT EXISTS migration_failures (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			version INTEGER NOT NULL,
			name TEXT NOT NULL,
			error TEXT NOT NULL,
			failed_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
	},
	// Append-only event-stream pattern (issue #2480 table pattern 1):
	// PK (stream_id, version) is the UNIQUE(stream_id, version) contract; the
	// version is assigned MAX(version)+1 inside the appending transaction.
	{
		version: 15,
		name: 'create_insight_candidate_stream',
		sql: `CREATE TABLE IF NOT EXISTS insight_candidate (
			stream_id TEXT NOT NULL,
			version INTEGER NOT NULL,
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL,
			consumed_at TEXT,
			PRIMARY KEY(stream_id, version)
		)`,
	},
	// Partial index over the pending (unconsumed) half of the stream: the
	// consume transaction's SELECT stays O(pending) instead of O(history).
	{
		version: 16,
		name: 'create_insight_candidate_pending_index',
		sql: `CREATE INDEX IF NOT EXISTS idx_insight_candidate_pending
			ON insight_candidate(stream_id, version)
			WHERE consumed_at IS NULL`,
	},
	// Entity/KV pattern (issue #2480 table pattern 3): one row per
	// (kind, phase) with last-write-wins semantics.
	{
		version: 17,
		name: 'create_phase_report',
		sql: `CREATE TABLE IF NOT EXISTS phase_report (
			kind TEXT NOT NULL CHECK(kind IN ('curator_drift', 'design_doc_drift')),
			phase INTEGER NOT NULL,
			payload TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY(kind, phase)
		)`,
	},
	// Issue #2481 (Workstream D2): transactional coordination authority.
	{
		version: 18,
		name: 'create_coordination_event',
		sql: `CREATE TABLE IF NOT EXISTS coordination_event (
			stream_id TEXT NOT NULL,
			version INTEGER NOT NULL CHECK(version >= 1),
			idempotency_key TEXT NOT NULL,
			event_type TEXT NOT NULL,
			generation INTEGER NOT NULL CHECK(generation >= 0),
			payload TEXT NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY(stream_id, version),
			UNIQUE(stream_id, idempotency_key)
		)`,
	},
	{
		version: 19,
		name: 'create_coordination_event_type_index',
		sql: `CREATE INDEX IF NOT EXISTS idx_coordination_event_type
			ON coordination_event(event_type, created_at)`,
	},
	{
		version: 20,
		name: 'create_coordination_state',
		sql: `CREATE TABLE IF NOT EXISTS coordination_state (
			namespace TEXT NOT NULL,
			entity_key TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK(revision >= 1),
			generation INTEGER NOT NULL CHECK(generation >= 0),
			status TEXT NOT NULL,
			payload TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(namespace, entity_key)
		)`,
	},
	{
		version: 21,
		name: 'create_coordination_state_status_index',
		sql: `CREATE INDEX IF NOT EXISTS idx_coordination_state_status
			ON coordination_state(namespace, status, updated_at)`,
	},
	{
		version: 22,
		name: 'create_coordination_lease',
		sql: `CREATE TABLE IF NOT EXISTS coordination_lease (
			namespace TEXT NOT NULL,
			entity_key TEXT NOT NULL,
			generation INTEGER NOT NULL CHECK(generation >= 0),
			owner_token TEXT NOT NULL,
			lease_expires_at TEXT NOT NULL,
			payload TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(namespace, entity_key)
		)`,
	},
	{
		version: 23,
		name: 'create_coordination_lease_expiry_index',
		sql: `CREATE INDEX IF NOT EXISTS idx_coordination_lease_expiry
			ON coordination_lease(namespace, lease_expires_at)`,
	},
	{
		version: 24,
		name: 'create_coordination_import',
		sql: `CREATE TABLE IF NOT EXISTS coordination_import (
			source TEXT PRIMARY KEY,
			imported_at TEXT NOT NULL,
			source_digest TEXT NOT NULL,
			row_count INTEGER NOT NULL CHECK(row_count >= 0)
		)`,
	},
	{
		version: 25,
		name: 'create_coordination_event_created_index',
		sql: `CREATE INDEX IF NOT EXISTS idx_coordination_event_created
			ON coordination_event(created_at, stream_id, version)`,
	},
];

interface ProjectDbRecord {
	db: Database;
	primaryAlias: string;
	aliases: Set<string>;
}

const _projectDbs: Map<string, ProjectDbRecord> = new Map();
const _projectDbAliases: Map<string, string> = new Map();
const MAX_ALIASES_PER_PROJECT_DB = 128;

function lexicalAliasKey(directory: string): string {
	return lexicalRootAliasKey(directory);
}

function unbindAlias(alias: string, physicalKey: string): void {
	if (_projectDbAliases.get(alias) === physicalKey) {
		_projectDbAliases.delete(alias);
	}
	_projectDbs.get(physicalKey)?.aliases.delete(alias);
}

function bindAlias(
	record: ProjectDbRecord,
	physicalKey: string,
	alias: string,
): void {
	const previousKey = _projectDbAliases.get(alias);
	if (previousKey !== undefined && previousKey !== physicalKey) {
		unbindAlias(alias, previousKey);
	}
	record.aliases.delete(alias);
	record.aliases.add(alias);
	_projectDbAliases.set(alias, physicalKey);
	while (record.aliases.size > MAX_ALIASES_PER_PROJECT_DB) {
		const evicted = [...record.aliases].find(
			(candidate) => candidate !== record.primaryAlias && candidate !== alias,
		);
		if (evicted === undefined) break;
		unbindAlias(evicted, physicalKey);
	}
}

function closeRecord(physicalKey: string, record: ProjectDbRecord): void {
	record.db.close();
	_projectDbs.delete(physicalKey);
	for (const alias of [...record.aliases]) unbindAlias(alias, physicalKey);
}

/** Number of currently cached project DB handles (tests / observability). */
export function getOpenProjectDbCount(): number {
	return _projectDbs.size;
}

/**
 * Record a failed migration attempt for diagnosis. The failed migration's own
 * transaction has already rolled back, so this insert runs (and commits) on
 * its own. If the `migration_failures` table does not exist yet (a failure
 * inside v14 itself) or the DB refuses the write, fall back to a bounded
 * atomic marker file next to the DB; the marker is removed on the next
 * successful migration run.
 */
function recordMigrationFailure(
	db: Database,
	migration: Migration,
	err: unknown,
	markerDir: string | undefined,
): void {
	const errorText = String(err instanceof Error ? err.message : err).slice(
		0,
		MIGRATION_FAILURE_ERROR_MAX_CHARS,
	);
	try {
		db.run(
			'INSERT INTO migration_failures (version, name, error) VALUES (?, ?, ?)',
			[migration.version, migration.name, errorText],
		);
		return;
	} catch {
		// Table absent (v14 itself failed) or DB unwritable — marker fallback.
	}
	if (!markerDir) return;
	try {
		atomicWriteSwarmFileSync(
			join(markerDir, MIGRATION_FAILURE_MARKER),
			JSON.stringify(
				{
					schema_version: 1,
					version: migration.version,
					name: migration.name,
					error: errorText,
					failed_at: new Date().toISOString(),
				},
				null,
				2,
			),
		);
	} catch {
		// Best-effort: the typed `migration_failed` error rethrown by the
		// runner still carries the version and name for diagnosis.
	}
}

function removeMigrationFailureMarker(markerDir: string): void {
	const marker = join(markerDir, MIGRATION_FAILURE_MARKER);
	if (!existsSync(marker)) return;
	try {
		unlinkSync(marker);
	} catch {
		// Best-effort cleanup; a stale marker only re-surfaces in diagnose.
	}
}

/**
 * Detect "another process applied this migration concurrently" failures:
 * a UNIQUE constraint violation on schema_migrations.version, or an
 * "already exists" DDL error (table/index/trigger created by the winner).
 */
export function isConcurrentMigrationApply(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	if (msg.includes('unique constraint failed: schema_migrations')) return true;
	return (
		msg.includes('already exists') &&
		(msg.includes('table') || msg.includes('index') || msg.includes('trigger'))
	);
}

function isSqliteBusy(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return (
		msg.includes('sqlite_busy') ||
		msg.includes('database is locked') ||
		msg.includes('database is busy')
	);
}

function isConcurrentOpenContention(err: unknown, dbPath: string): boolean {
	if (isSqliteBusy(err)) return true;
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	// Bun/Windows can surface the first WAL-header race as SQLITE_IOERR rather
	// than SQLITE_BUSY. Only retry this broad category when another process has
	// already materialized the exact DB path, and retain the hard attempt cap.
	return msg.includes('disk i/o error') && existsSync(dbPath);
}

function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const startedAt = Date.now();
		while (Date.now() - startedAt < ms) {
			// Bounded portability fallback for runtimes that forbid Atomics.wait.
		}
	}
}

/** True when the recorded schema version has reached `version`. */
function currentVersionNowCovers(db: Database, version: number): boolean {
	const row = db
		.query<{ version: number | null }, []>(
			'SELECT MAX(version) as version FROM schema_migrations',
		)
		.get();
	return (row?.version ?? 0) >= version;
}

/** Best-effort variant for contention/error paths where the probe can itself be busy. */
function currentVersionNowCoversSafely(db: Database, version: number): boolean {
	try {
		return currentVersionNowCovers(db, version);
	} catch {
		return false;
	}
}

/**
 * Run all pending migrations on the provided database.
 * Idempotent: existing migrations are not re-applied. Each migration applies
 * in its own transaction; a failure rolls back, is recorded for diagnosis
 * (table row, or the marker fallback), and leaves the version un-bumped so
 * the next open retries it.
 */
export function runProjectMigrations(db: Database, markerDir?: string): void {
	db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`);

	const row = db
		.query<{ version: number | null }, []>(
			'SELECT MAX(version) as version FROM schema_migrations',
		)
		.get();
	const currentVersion = row?.version ?? 0;

	for (const migration of MIGRATIONS) {
		if (migration.version <= currentVersion) continue;
		const apply = db.transaction(() => {
			db.run(migration.sql);
			db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
				migration.version,
				migration.name,
			]);
		});
		let lastError: unknown;
		for (let attempt = 0; attempt <= MIGRATION_BUSY_RETRIES; attempt += 1) {
			try {
				apply();
				lastError = undefined;
				break;
			} catch (err) {
				lastError = err;
				if (currentVersionNowCoversSafely(db, migration.version)) {
					lastError = undefined;
					break;
				}
				if (!isSqliteBusy(err) || attempt === MIGRATION_BUSY_RETRIES) break;
				sleepSync(10 * (attempt + 1));
			}
		}
		if (lastError !== undefined) {
			const err = lastError;
			// #2480 review F-03: another process may have applied this same
			// migration concurrently (both read the same MAX(version); the
			// loser hits the schema_migrations PK or an "already exists" on
			// the DDL). That is not a failure of THIS database — the
			// migration IS applied; continue the loop instead of recording a
			// spurious failure (which previously also skipped marker cleanup).
			if (
				isConcurrentMigrationApply(err) &&
				currentVersionNowCoversSafely(db, migration.version)
			) {
				continue;
			}
			recordMigrationFailure(db, migration, err, markerDir);
			throw new ProjectDbError(
				'migration_failed',
				`swarm.db migration v${migration.version} (${migration.name}) failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	if (markerDir) removeMigrationFailureMarker(markerDir);
}

/**
 * Return the absolute path to `.swarm/swarm.db` for the given directory.
 * Does not create the file or any parent directory.
 */
export function projectDbPath(directory: string): string {
	return join(canonicalRootKeyFresh(directory), '.swarm', 'swarm.db');
}

/**
 * Return true iff the project DB file already exists on disk. Does not
 * open the DB, create `.swarm/`, or run migrations. Intended for
 * read-only callers (e.g. `getProfile`) that must avoid mutating the
 * workspace just to check for a missing record.
 */
export function projectDbExists(directory: string): boolean {
	return existsSync(projectDbPath(directory));
}

/**
 * Best-effort WAL checkpoint before close (issue #2480 checkpoint policy).
 *
 * `wal_checkpoint(TRUNCATE)` reports contention through its result row
 * (`busy = 1`) rather than blocking, so a contended checkpoint degrades to
 * PASSIVE and then gives up — close must never hang or throw. The WAL
 * sidecars surviving a contended checkpoint is safe: SQLite recovers them
 * on the next open.
 */
function checkpointWalBestEffort(db: Database): void {
	try {
		const row = db
			.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)')
			.get();
		if (row && row.busy === 1) {
			db.run('PRAGMA wal_checkpoint(PASSIVE);');
		}
	} catch {
		try {
			db.run('PRAGMA wal_checkpoint(PASSIVE);');
		} catch {
			// Best-effort by contract.
		}
	}
}

/**
 * Return the cached project database for the given directory, opening it
 * if needed. Creates `.swarm/` if absent and enables WAL + foreign keys.
 * The cache is keyed by canonical project identity, so case-varied Windows
 * spellings, trailing separators, and symlinked roots share ONE handle.
 * Open failures throw a typed `ProjectDbError` and never leave a
 * half-open handle cached.
 */
export function getProjectDb(directory: string): Database {
	// Preserve the existing create-on-first-open contract, but materialize the
	// root before choosing its resource identity. A missing child beneath a
	// symlink/junction parent otherwise changes from a lexical key to a physical
	// key after `.swarm/` creation and can strand a duplicate connection.
	mkdirSync(directory, { recursive: true });
	const key = canonicalRootKeyFresh(directory);
	const alias = lexicalAliasKey(directory);
	const existing = _projectDbs.get(key);
	if (existing) {
		bindAlias(existing, key, alias);
		return existing.db;
	}

	const swarmDir = join(key, '.swarm');
	try {
		mkdirSync(swarmDir, { recursive: true });
	} catch (err) {
		throw new ProjectDbError(
			'mkdir_failed',
			`Failed to create .swarm/ for project ${key}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	let db: Database | undefined;
	try {
		let Db: ReturnType<typeof loadDatabaseCtor>;
		try {
			Db = loadDatabaseCtor();
		} catch (err) {
			throw new ProjectDbError(
				'driver_unavailable',
				`Failed to resolve a SQLite driver for project ${key}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		const dbFile = join(swarmDir, 'swarm.db');
		for (let attempt = 0; attempt <= OPEN_CONTENTION_RETRIES; attempt += 1) {
			db = new Db(dbFile);
			try {
				// Install the busy handler before journal-mode negotiation: two fresh
				// processes can otherwise race on the first WAL pragma (#2481).
				db.run('PRAGMA busy_timeout = 5000;');
				db.run('PRAGMA journal_mode = WAL;');
				db.run('PRAGMA synchronous = NORMAL;');
				db.run('PRAGMA foreign_keys = ON;');
				runProjectMigrations(db, swarmDir);
				break;
			} catch (err) {
				try {
					db.close();
				} catch {
					// Best-effort between bounded attempts.
				}
				db = undefined;
				if (
					!isConcurrentOpenContention(err, dbFile) ||
					attempt === OPEN_CONTENTION_RETRIES
				)
					throw err;
				sleepSync(25 * (attempt + 1));
			}
		}
		if (!db)
			throw new Error('SQLite initialization exhausted its busy retry budget');
	} catch (err) {
		// Close the half-opened handle so a failed open never leaks a WAL
		// lock (the sqlite-provider open-failure precedent).
		if (db) {
			try {
				db.close();
			} catch {
				// already closed or unwritable — nothing further to do
			}
		}
		if (err instanceof ProjectDbError) throw err;
		throw new ProjectDbError(
			'open_failed',
			`Failed to open .swarm/swarm.db for project ${key}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	const record: ProjectDbRecord = {
		db,
		primaryAlias: alias,
		aliases: new Set(),
	};
	_projectDbs.set(key, record);
	bindAlias(record, key, alias);
	return db;
}

/**
 * Close and remove the cached project database for the given directory.
 * Runs a best-effort WAL checkpoint (TRUNCATE, PASSIVE fallback) first so the
 * close leaves a self-contained DB file where possible. Called by the
 * `/swarm close` clean stage before unlinking `swarm.db` (so a long-lived
 * WAL-mode connection releases its file lock and Windows `unlink` does not
 * fail with EBUSY), by the plugin dispose/exit close paths, and from tests.
 *
 * Callers that passed a different spelling of the same root (case variant on
 * Windows, symlink) share the canonical handle: closing it invalidates every
 * alias — which is the point (those aliases were previously silent duplicate
 * writers on one file). Reopening via `getProjectDb` always works.
 */
export function closeProjectDb(directory: string): void {
	const alias = lexicalAliasKey(directory);
	// Resolve the path again before consulting the alias table. The alias may
	// have been retargeted since it was opened; an older alias binding must not
	// close a different project's live connection when the new target is
	// cached. Keep the binding as a fallback for broken/deleted aliases, where
	// the physical target can no longer be resolved but the old connection
	// still needs to be released.
	const currentPath = canonicalExistingFilesystemPath(directory);
	if (currentPath !== null) {
		// Use the canonical-root formatter for the cache lookup so the key has
		// the same separator contract as getProjectDb. The existing-path proof
		// above still prevents a stale lexical alias from selecting an old DB.
		const currentKey = canonicalRootKeyFresh(directory);
		const currentRecord = _projectDbs.get(currentKey);
		if (currentRecord) closeRecord(currentKey, currentRecord);
		// The current physical target resolved successfully. If it is not
		// cached, do not fall back to a stale alias binding from an older target.
		return;
	}

	const previousKey = _projectDbAliases.get(alias);
	const previousRecord =
		previousKey === undefined ? undefined : _projectDbs.get(previousKey);
	if (previousKey !== undefined && previousRecord) {
		closeRecord(previousKey, previousRecord);
	}
}

/**
 * Close and remove all cached project databases.
 * Test-only.
 */
export function closeAllProjectDbs(): void {
	for (const record of _projectDbs.values()) {
		try {
			checkpointWalBestEffort(record.db);
			record.db.close();
		} catch {
			// ignore close errors during cleanup
		}
	}
	_projectDbs.clear();
	_projectDbAliases.clear();
}

export const _internals = {
	projectDbCount: () => _projectDbs.size,
	projectDbAliasCount: () => _projectDbAliases.size,
};

/**
 * Per-project SQLite database for opencode-swarm.
 *
 * Owns `.swarm/swarm.db` in each project directory. Stores per-project
 * constraints and QA gate profiles. One cached instance per normalized
 * directory path.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
];

const _projectDbs: Map<string, Database> = new Map();

/**
 * Run all pending migrations on the provided database.
 * Idempotent: existing migrations are not re-applied.
 */
export function runProjectMigrations(db: Database): void {
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
		apply();
	}
}

/**
 * Return the absolute path to `.swarm/swarm.db` for the given directory.
 * Does not create the file or any parent directory.
 */
export function projectDbPath(directory: string): string {
	return join(resolve(directory), '.swarm', 'swarm.db');
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
 * Return the cached project database for the given directory, opening it
 * if needed. Creates `.swarm/` if absent and enables WAL + foreign keys.
 */
export function getProjectDb(directory: string): Database {
	const key = resolve(directory);
	const existing = _projectDbs.get(key);
	if (existing) return existing;

	const swarmDir = join(key, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const Db = loadDatabaseCtor();
	const db = new Db(join(swarmDir, 'swarm.db'));
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA synchronous = NORMAL;');
	db.run('PRAGMA busy_timeout = 5000;');
	db.run('PRAGMA foreign_keys = ON;');
	runProjectMigrations(db);
	_projectDbs.set(key, db);
	return db;
}

/**
 * Close and remove the cached project database for the given directory.
 * Called by the `/swarm close` clean stage before unlinking `swarm.db` (so a
 * long-lived WAL-mode connection releases its file lock and Windows `unlink`
 * does not fail with EBUSY), and from tests.
 */
export function closeProjectDb(directory: string): void {
	const key = resolve(directory);
	const db = _projectDbs.get(key);
	if (db) {
		db.close();
		_projectDbs.delete(key);
	}
}

/**
 * Close and remove all cached project databases.
 * Test-only.
 */
export function closeAllProjectDbs(): void {
	for (const db of _projectDbs.values()) {
		try {
			db.close();
		} catch {
			// ignore close errors during cleanup
		}
	}
	_projectDbs.clear();
}

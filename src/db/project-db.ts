/**
 * Per-project SQLite database for opencode-swarm.
 *
 * Owns `.swarm/swarm.db` in each project directory. Stores per-project
 * constraints and QA gate profiles. One cached instance per normalized
 * directory path.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// `bun:sqlite` is a Bun built-in. A static `import { Database } from 'bun:sqlite'`
// is hoisted into the published bundle's top-level ESM imports and breaks plugin
// loading under any host whose dynamic `import()` goes through Node's default ESM
// resolver — which throws ERR_UNSUPPORTED_ESM_URL_SCHEME for the `bun:` scheme
// before any plugin code runs (issue #675). Resolve the constructor lazily so the
// module graph never references `bun:sqlite` at evaluation time. Bun supports
// `require('bun:sqlite')` synchronously, keeping our public API sync.
let _DatabaseCtor: typeof Database | null = null;
function loadDatabaseCtor(): typeof Database {
	if (_DatabaseCtor) return _DatabaseCtor;
	const req = createRequire(import.meta.url);
	_DatabaseCtor = (req('bun:sqlite') as { Database: typeof Database }).Database;
	return _DatabaseCtor;
}

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
 * Test-only.
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

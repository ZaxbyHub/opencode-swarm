/**
 * Global SQLite database singleton for opencode-swarm.
 *
 * Owns `global-rules.db` in the platform config directory. Stores cross-project
 * rules and agent prompt sections. Per-project QA gate profiles live in the
 * project DB (see `./project-db.ts`), not here.
 */

import type { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformConfigDir } from '../hooks/knowledge-store.js';
import { loadDatabaseCtor } from './sqlite-loader.js';

// The runtime SQLite driver comes from the shared, runtime-portable loader
// (`./sqlite-loader.ts`): native `bun:sqlite` under Bun, a `node:sqlite` adapter
// under Node (issue #1873 / invariant #2). The `import type { Database }` above is
// erased at build, so the bundle keeps no top-level `bun:` import (issue #675).

interface Migration {
	version: number;
	name: string;
	sql: string;
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: 'create_global_rules',
		sql: `CREATE TABLE global_rules (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			scope TEXT NOT NULL CHECK(scope IN ('global')),
			rule_type TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`,
	},
	{
		version: 2,
		name: 'create_agent_prompt_sections',
		sql: `CREATE TABLE agent_prompt_sections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			agent_name TEXT NOT NULL,
			section_key TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			UNIQUE(agent_name, section_key)
		)`,
	},
];

let _globalDb: Database | null = null;

/**
 * Run all pending migrations on the provided database.
 * Idempotent: existing migrations are not re-applied.
 */
export function runGlobalMigrations(db: Database): void {
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
 * Return the process-wide singleton global database, creating it on first call.
 * Directory is created if it does not exist. WAL mode is enabled immediately.
 */
export function getGlobalDb(): Database {
	if (_globalDb) return _globalDb;
	const configDir = getPlatformConfigDir();
	mkdirSync(configDir, { recursive: true });
	const Db = loadDatabaseCtor();
	const db = new Db(join(configDir, 'global-rules.db'));
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA synchronous = NORMAL;');
	db.run('PRAGMA busy_timeout = 5000;');
	runGlobalMigrations(db);
	_globalDb = db;
	return db;
}

/**
 * Close and clear the global database singleton. Test-only.
 */
export function closeGlobalDb(): void {
	if (_globalDb) {
		_globalDb.close();
		_globalDb = null;
	}
}

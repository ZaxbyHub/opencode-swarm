/**
 * project-db foundation hardening (issue #2480): typed open errors, canonical
 * cache identity, migration-failure recording + retry (crash-at-boundary),
 * and the close-path WAL checkpoint.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectDbError } from '../../../src/db/db-errors.js';
import {
	closeAllProjectDbs,
	closeProjectDb,
	getOpenProjectDbCount,
	getProjectDb,
	projectDbExists,
	runProjectMigrations,
} from '../../../src/db/project-db.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('projdb-hard-');
	mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	closeAllProjectDbs();
	rmSync(dir, { recursive: true, force: true });
});

describe('canonical connection cache', () => {
	test('case/trailing spellings of one root share ONE handle', () => {
		const a = getProjectDb(dir);
		const variant = `${dir}${path.sep}.${path.sep}`;
		const b = getProjectDb(variant);
		expect(b).toBe(a);
		if (process.platform === 'win32') {
			expect(getProjectDb(dir.toUpperCase())).toBe(a);
		}
	});

	test('close invalidates the shared canonical handle; reopen works', () => {
		const a = getProjectDb(dir);
		closeProjectDb(`${dir}${path.sep}.${path.sep}`);
		expect(() => a.query('SELECT 1').get()).toThrow();
		const b = getProjectDb(dir);
		expect(b).not.toBe(a);
	});

	test('open handle count is observable and bounded by distinct roots', () => {
		const before = getOpenProjectDbCount();
		getProjectDb(dir);
		expect(getOpenProjectDbCount()).toBe(before + 1);
		closeProjectDb(dir);
		expect(getOpenProjectDbCount()).toBe(before);
	});
});

describe('typed open failures', () => {
	test('read-only project root yields a typed ProjectDbError', () => {
		// Simulate an unwritable .swarm by making it a FILE (mkdir then EEXIST /
		// ENOTDIR surfaces as mkdir_failed).
		const roDir = canonicalMkdtemp('projdb-ro-');
		mkdirSync(path.join(roDir, '.swarm'));
		rmSync(path.join(roDir, '.swarm'), { recursive: true, force: true });
		mkdirSync(path.join(roDir, '.swarm')); // placeholder replaced below
		rmSync(path.join(roDir, '.swarm'), { recursive: true, force: true });
		// A FILE at the .swarm path makes mkdirSync throw ENOTDIR/EEXIST.
		writeFileSync(path.join(roDir, '.swarm'), 'not a dir');
		let caught: unknown;
		try {
			getProjectDb(roDir);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProjectDbError);
		expect((caught as ProjectDbError).category).toBe('mkdir_failed');
		rmSync(roDir, { recursive: true, force: true });
	});

	test('a corrupt swarm.db yields a typed open_failed error', () => {
		writeFileSync(
			path.join(dir, '.swarm', 'swarm.db'),
			'this is definitely not a sqlite database',
		);
		let caught: unknown;
		try {
			getProjectDb(dir);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProjectDbError);
		expect(['open_failed', 'migration_failed']).toContain(
			(caught as ProjectDbError).category,
		);
	});
});

describe('failed-migration recovery', () => {
	test('a failing migration records a migration_failures row and retries next run', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		// Force v16 to fail: its partial index references consumed_at, so an
		// insight_candidate table WITHOUT that column makes the migration fail.
		db.run('DELETE FROM schema_migrations WHERE version >= 16');
		db.run('DROP TABLE insight_candidate');
		db.run(`CREATE TABLE insight_candidate (
			stream_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
			created_at TEXT NOT NULL, PRIMARY KEY(stream_id, version))`);
		let caught: unknown;
		try {
			runProjectMigrations(db);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProjectDbError);
		expect((caught as ProjectDbError).category).toBe('migration_failed');
		// The failure was recorded for diagnosis…
		const failures = db
			.query<{ version: number; name: string; error: string }, []>(
				'SELECT version, name, error FROM migration_failures',
			)
			.all();
		expect(failures.length).toBeGreaterThanOrEqual(1);
		expect(failures[0].version).toBe(16);
		expect(failures[0].error.length).toBeGreaterThan(0);
		// …and the version stayed un-bumped so the retry path exists: repair
		// the column and the SAME migration applies on the next run.
		db.run('ALTER TABLE insight_candidate ADD COLUMN consumed_at TEXT');
		expect(() => runProjectMigrations(db)).not.toThrow();
		expect(
			db
				.query<{ version: number }, []>(
					'SELECT version FROM schema_migrations WHERE version = 16',
				)
				.get()?.version,
		).toBe(16);
		db.close();
	});

	test('v14+ foundation tables and the pending partial index exist', () => {
		const db = getProjectDb(dir);
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('migration_failures','insight_candidate','phase_report')",
			)
			.all()
			.map((r) => r.name)
			.sort();
		expect(tables).toEqual([
			'insight_candidate',
			'migration_failures',
			'phase_report',
		]);
		const indexes = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_insight_candidate_pending'",
			)
			.all();
		expect(indexes.length).toBe(1);
	});

	test('crash-at-migration-boundary: reopen after close completes pending migrations', () => {
		// v1 DB on disk, handle closed mid-history, reopen runs the remainder.
		const dbPath = path.join(dir, '.swarm', 'swarm.db');
		const first = new Database(dbPath);
		first.run(`CREATE TABLE schema_migrations (
			version INTEGER PRIMARY KEY, name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
		first.run(
			"INSERT INTO schema_migrations (version, name) VALUES (1, 'create_project_constraints')",
		);
		first.run(`CREATE TABLE project_constraints (
			id INTEGER PRIMARY KEY AUTOINCREMENT, constraint_type TEXT NOT NULL,
			content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
		first.close(); // "crash" — no WAL replay issue, plain close
		const reopened = getProjectDb(dir);
		const versions = reopened
			.query<{ version: number }, []>(
				'SELECT version FROM schema_migrations ORDER BY version',
			)
			.all()
			.map((r) => r.version);
		expect(versions[versions.length - 1]).toBe(17);
		expect(versions.length).toBe(17);
	});

	test('marker-file fallback: a v14 failure with no migration_failures table writes the marker, and the marker is removed on success', () => {
		// Simulate a DB whose v14 itself fails: a VIEW named migration_failures
		// makes v14's CREATE TABLE IF NOT EXISTS a no-op and any INSERT against
		// it throw — exactly the side-channel fallback case.
		const db = new Database(':memory:');
		db.run(`CREATE TABLE schema_migrations (
			version INTEGER PRIMARY KEY, name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
		db.run("INSERT INTO schema_migrations (version, name) VALUES (13, 'v13')");
		// A VIEW named migration_failures makes the failure-RECORDING insert
		// throw (the fallback trigger)…
		db.run('CREATE VIEW migration_failures AS SELECT 1 AS x');
		// …and an insight_candidate table without consumed_at makes v16's
		// partial index THROW (the failure itself).
		db.run(`CREATE TABLE insight_candidate (
			stream_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
			created_at TEXT NOT NULL, PRIMARY KEY(stream_id, version))`);

		const swarmDir = path.join(dir, '.swarm');
		let caught: unknown;
		try {
			runProjectMigrations(db, swarmDir);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(ProjectDbError);
		const marker = path.join(swarmDir, 'db-migration-failure.json');
		expect(existsSync(marker)).toBe(true);
		const parsed = JSON.parse(readFileSync(marker, 'utf-8')) as {
			version: number;
		};
		expect(parsed.version).toBeGreaterThanOrEqual(14);

		// The next successful migration run removes the marker.
		db.run('DROP VIEW migration_failures');
		db.run('ALTER TABLE insight_candidate ADD COLUMN consumed_at TEXT');
		expect(() => runProjectMigrations(db, swarmDir)).not.toThrow();
		expect(existsSync(marker)).toBe(false);
		db.close();
	});
});

describe('close-path WAL checkpoint', () => {
	test('close checkpoints the WAL (TRUNCATE best-effort) and never throws', () => {
		const db = getProjectDb(dir);
		db.run(
			"INSERT INTO project_constraints (constraint_type, content) VALUES ('x', 'y')",
		);
		expect(existsSync(path.join(dir, '.swarm', 'swarm.db-wal'))).toBe(true);
		expect(() => closeProjectDb(dir)).not.toThrow();
		// After a TRUNCATE checkpoint the WAL file exists but is zero-length
		// (or SQLite removed it); either way the DB is self-contained.
		const wal = path.join(dir, '.swarm', 'swarm.db-wal');
		if (existsSync(wal)) {
			expect(readFileSync(wal).length).toBe(0);
		}
		// Data survived.
		const reopened = getProjectDb(dir);
		const n = reopened
			.query<{ n: number }, []>('SELECT COUNT(*) as n FROM project_constraints')
			.get()?.n;
		expect(n).toBe(1);
	});
});

test('projectDbExists does not create the DB', () => {
	const fresh = canonicalMkdtemp('projdb-exists-');
	expect(projectDbExists(fresh)).toBe(false);
	expect(existsSync(path.join(fresh, '.swarm'))).toBe(false);
	rmSync(fresh, { recursive: true, force: true });
});

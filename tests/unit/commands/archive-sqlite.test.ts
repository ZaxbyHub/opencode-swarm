/**
 * Focused tests for the in-process VACUUM INTO snapshot engine
 * (src/commands/archive-sqlite.ts).
 *
 * These run under `bun test`, so `loadDatabaseCtor()` resolves to native
 * `bun:sqlite` — the real driver. The concurrent-uncommitted-writer and
 * loader-round-trip cases mirror the issue #2030 spike
 * (.zcode/issue-traces/2030/spike-vacuum-into.mjs), which also proved parity
 * under real Node `node:sqlite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	_internals as archiveInternals,
	archiveSqliteSnapshot,
} from '../../../src/commands/archive-sqlite.js';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';

let testDir: string;
let srcDir: string;
let destDir: string;

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'archive-sqlite-test-'));
	srcDir = path.join(testDir, 'src');
	destDir = path.join(testDir, 'dest');
	mkdirSync(srcDir, { recursive: true });
	mkdirSync(destDir, { recursive: true });
	// Reset the DI seam (a prior test may have injected a fake ctor).
	archiveInternals.DatabaseCtor = null;
});

afterEach(() => {
	archiveInternals.DatabaseCtor = null;
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

/**
 * Create a WAL-mode swarm.db-shaped source with the given committed
 * project_constraints rows + a fully-applied schema_migrations table.
 * Returns the absolute source path.
 */
function createWalSource(dbName: string, committedRows: number): string {
	const Db = loadDatabaseCtor();
	const srcPath = path.join(srcDir, dbName);
	const db = new Db(srcPath);
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA synchronous = NORMAL;');
	db.run('PRAGMA busy_timeout = 5000;');
	db.run(`CREATE TABLE project_constraints (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		constraint_type TEXT NOT NULL,
		content TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	db.run(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	for (let i = 0; i < committedRows; i++) {
		db.run(
			'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
			['type_a', `committed-row-${i}`],
		);
	}
	db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
		1,
		'create_project_constraints',
	]);
	db.close();
	return srcPath;
}

describe('archiveSqliteSnapshot — source absence', () => {
	it('reports absent + not_attempted when the source does not exist', async () => {
		const r = await archiveSqliteSnapshot({
			sourcePath: path.join(srcDir, 'missing.db'),
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('not_attempted');
		expect(r.source_disposition).toBe('absent');
		expect(r.reason_code).toBe('source_absent');
		expect(r.method).toBe('none');
		expect(r.validation).toBe('not_applicable');
		expect(existsSync(path.join(destDir, 'swarm.db'))).toBe(false);
	});
});

describe('archiveSqliteSnapshot — byte-budget preflight', () => {
	it('bails with source_over_budget and does no expensive work', async () => {
		const srcPath = createWalSource('swarm.db', 1);
		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
			// Absurdly small budget so even a tiny DB exceeds it.
			maxSourceBytes: 1,
		});
		expect(r.attempt).toBe('not_attempted');
		expect(r.reason_code).toBe('source_over_budget');
		expect(r.source_disposition).toBe('retained');
		expect(r.method).toBe('none');
		// Source untouched.
		expect(existsSync(srcPath)).toBe(true);
		// No destination published.
		expect(existsSync(path.join(destDir, 'swarm.db'))).toBe(false);
	});
});

describe('archiveSqliteSnapshot — happy path', () => {
	it('produces a single self-contained validated snapshot with committed rows', async () => {
		const srcPath = createWalSource('swarm.db', 5);
		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('succeeded');
		expect(r.validation).toBe('passed');
		expect(r.reason_code).toBe('ok');
		expect(r.method).toBe('vacuum_into');
		expect(r.destPath).toBe(path.join(destDir, 'swarm.db'));
		expect(r.rowCounts).toBeDefined();
		expect(r.rowCounts!.project_constraints).toBe(5);
		expect(r.rowCounts!.qa_gate_profile).toBe(0);
		expect(r.rowCounts!.schema_migrations_max_version).toBe(1);

		// Destination is a SINGLE file — no WAL/SHM sidecars.
		const destFiles = existsSync(path.join(destDir, 'swarm.db'));
		expect(destFiles).toBe(true);
		expect(existsSync(path.join(destDir, 'swarm.db-wal'))).toBe(false);
		expect(existsSync(path.join(destDir, 'swarm.db-shm'))).toBe(false);

		// Source is preserved (never deleted by the snapshot engine).
		expect(existsSync(srcPath)).toBe(true);
	});
});

describe('archiveSqliteSnapshot — concurrent uncommitted writer excluded', () => {
	it('snapshot contains committed rows and excludes the uncommitted row', async () => {
		const Db = loadDatabaseCtor();
		const srcPath = createWalSource('swarm.db', 3);

		// Open a SECOND connection, BEGIN IMMEDIATE, INSERT, do NOT commit.
		const writer = new Db(srcPath);
		writer.run('PRAGMA busy_timeout = 5000;');
		writer.run('BEGIN IMMEDIATE;');
		writer.run(
			'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
			['uncommitted', 'SHOULD-NOT-APPEAR-IN-SNAPSHOT'],
		);

		// Snapshot while the writer's transaction is open and uncommitted.
		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('succeeded');
		expect(r.rowCounts!.project_constraints).toBe(3);

		// Restore-query proof: open the destination via the SHARED loader and
		// verify committed rows are present and the uncommitted row is absent.
		const verify = new Db(r.destPath!);
		const committed = verify
			.query('SELECT COUNT(*) AS c FROM project_constraints')
			.get();
		const uncommitted = verify
			.query(
				"SELECT COUNT(*) AS c FROM project_constraints WHERE content = 'SHOULD-NOT-APPEAR-IN-SNAPSHOT'",
			)
			.get();
		const integrity = verify.query('PRAGMA integrity_check').get();
		verify.close();

		expect(Number((committed as { c: number }).c)).toBe(3);
		expect(Number((uncommitted as { c: number }).c)).toBe(0);
		// integrity_check row shape differs across drivers; assert it's 'ok'.
		const ic =
			(integrity as { integrity_check?: string }).integrity_check ?? '';
		expect(ic).toBe('ok');

		// Commit the writer and confirm the SOURCE now has 4 (proving the
		// snapshot excluded the uncommitted row, not that it was never written).
		writer.run('COMMIT;');
		const sourceAfter = new Db(srcPath);
		const sourceCount = sourceAfter
			.query('SELECT COUNT(*) AS c FROM project_constraints')
			.get();
		sourceAfter.close();
		expect(Number((sourceCount as { c: number }).c)).toBe(4);

		writer.close();
	});
});

describe('archiveSqliteSnapshot — corrupt source', () => {
	it('fails validation or snapshot without deleting the source', async () => {
		// Create a valid WAL source, then corrupt the main file by overwriting
		// its header bytes with garbage. VACUUM INTO / integrity_check will fail.
		const srcPath = createWalSource('swarm.db', 2);
		// Overwrite the first 32 bytes (SQLite header) with garbage. Using a
		// buffer handle so we can close it before snapshotting.
		const { openSync, writeSync, write } = await import('node:fs');
		const fd = openSync(srcPath, 'r+');
		writeSync(fd, Buffer.from('X'.repeat(32)), 0, 32, 0);
		closeSync(fd);

		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('failed');
		expect(r.source_disposition).toBe('retained');
		expect(['snapshot_failed', 'validation_failed']).toContain(r.reason_code);
		// Source preserved.
		expect(existsSync(srcPath)).toBe(true);
		// No destination published.
		expect(existsSync(path.join(destDir, 'swarm.db'))).toBe(false);
		// Suppress unused-import warning for dynamic write import.
		void write;
	});
});

describe('archiveSqliteSnapshot — schema mismatch', () => {
	it('reports schema_mismatch when schema_migrations table is absent', async () => {
		const Db = loadDatabaseCtor();
		const srcPath = path.join(srcDir, 'swarm.db');
		const db = new Db(srcPath);
		db.run('PRAGMA journal_mode = WAL;');
		// Create a valid DB but WITHOUT the schema_migrations table.
		db.run(
			'CREATE TABLE project_constraints (id INTEGER PRIMARY KEY, x TEXT);',
		);
		db.run('INSERT INTO project_constraints (x) VALUES (?);', ['row']);
		db.close();

		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('failed');
		expect(r.reason_code).toBe('schema_mismatch');
		expect(r.validation).toBe('failed');
		expect(r.source_disposition).toBe('retained');
		expect(existsSync(srcPath)).toBe(true);
		expect(existsSync(path.join(destDir, 'swarm.db'))).toBe(false);
	});
});

describe('archiveSqliteSnapshot — publish failure cleans temp', () => {
	it('cleans the temp file and reports publish_failed when rename throws', async () => {
		const srcPath = createWalSource('swarm.db', 1);
		// Inject a rename that throws (simulates Windows antivirus EPERM / ENOSPC).
		const realRename = archiveInternals.renameSync;
		archiveInternals.renameSync = (() => {
			throw new Error('simulated EPERM');
		}) as typeof realRename;

		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('failed');
		expect(r.reason_code).toBe('publish_failed');
		// Validation already passed before publish.
		expect(r.validation).toBe('passed');
		expect(r.source_disposition).toBe('retained');

		// No temp left behind in destDir, and no final destination published.
		const destEntries = existsSync(destDir)
			? require('node:fs').readdirSync(destDir)
			: [];
		expect(destEntries.length).toBe(0);
		expect(existsSync(path.join(destDir, 'swarm.db'))).toBe(false);

		archiveInternals.renameSync = realRename;
	});
});

describe('archiveSqliteSnapshot — failure injection via DatabaseCtor', () => {
	it('reports snapshot_failed when VACUUM INTO throws', async () => {
		const srcPath = createWalSource('swarm.db', 1);
		// Inject a fake ctor whose run() throws on VACUUM INTO.
		archiveInternals.DatabaseCtor = function (
			this: unknown,
			_filename: string,
		) {
			return {
				run: (sql: string) => {
					if (sql.startsWith('VACUUM INTO')) {
						throw new Error('injected snapshot failure');
					}
				},
				query: () => ({ get: () => ({ integrity_check: 'ok' }) }),
				close: () => {},
			};
		} as never;

		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('failed');
		expect(r.reason_code).toBe('snapshot_failed');
		expect(r.source_disposition).toBe('retained');
		expect(existsSync(srcPath)).toBe(true);
		expect(existsSync(path.join(destDir, 'swarm.db'))).toBe(false);
	});
});

describe('archiveSqliteSnapshot — zero-row-but-valid DB (archive_empty signal)', () => {
	it('succeeds with zero domain rows (not a failure)', async () => {
		const Db = loadDatabaseCtor();
		const srcPath = path.join(srcDir, 'swarm.db');
		const db = new Db(srcPath);
		db.run('PRAGMA journal_mode = WAL;');
		db.run(
			`CREATE TABLE project_constraints (id INTEGER PRIMARY KEY, x TEXT);`,
		);
		db.run(`CREATE TABLE qa_gate_profile (id INTEGER PRIMARY KEY, y TEXT);`);
		db.run(
			`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);`,
		);
		db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
			1,
			'create_project_constraints',
		]);
		db.close();

		const r = await archiveSqliteSnapshot({
			sourcePath: srcPath,
			destDir,
			destName: 'swarm.db',
		});
		expect(r.attempt).toBe('succeeded');
		expect(r.validation).toBe('passed');
		expect(r.rowCounts!.project_constraints).toBe(0);
		expect(r.rowCounts!.qa_gate_profile).toBe(0);
	});
});

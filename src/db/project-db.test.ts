/**
 * Tests for src/db/project-db.ts.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	closeAllProjectDbs,
	closeProjectDb,
	getProjectDb,
	runProjectMigrations,
} from './project-db.js';

let tempDir: string;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(process.cwd(), 'project-db-test-')),
	);
});

afterEach(() => {
	closeAllProjectDbs();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('project-db', () => {
	test('getProjectDb creates .swarm/swarm.db under the directory', () => {
		const db = getProjectDb(tempDir);
		expect(db).toBeDefined();
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'swarm.db'))).toBe(true);
	});

	test('getProjectDb caches per normalized directory path', () => {
		const a = getProjectDb(tempDir);
		const b = getProjectDb(tempDir);
		expect(a).toBe(b);
		// Trailing separator / relative segments resolve to the same path.
		const c = getProjectDb(path.join(tempDir, '.', ''));
		expect(c).toBe(a);
	});

	test('different directories get different cached instances', () => {
		const other = fs.realpathSync(
			fs.mkdtempSync(path.join(process.cwd(), 'project-db-test-b-')),
		);
		try {
			const a = getProjectDb(tempDir);
			const b = getProjectDb(other);
			expect(a).not.toBe(b);
		} finally {
			closeProjectDb(other);
			fs.rmSync(other, { recursive: true, force: true });
		}
	});

	test('closeProjectDb removes the cached instance', () => {
		const a = getProjectDb(tempDir);
		closeProjectDb(tempDir);
		const b = getProjectDb(tempDir);
		expect(a).not.toBe(b);
	});

	test('runProjectMigrations creates project_constraints and qa_gate_profile', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
		expect(tables).toContain('schema_migrations');
		expect(tables).toContain('project_constraints');
		expect(tables).toContain('qa_gate_profile');
		expect(tables).toContain('qa_gate_profile_identity');
		expect(tables).toContain('task_checkpoint_receipt');
		expect(tables).toContain('coordination_event');
		expect(tables).toContain('coordination_state');
		expect(tables).toContain('coordination_lease');
		expect(tables).toContain('coordination_import');
		expect(tables).toContain('coordination_event_fence');
		const indexes = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
		expect(indexes).toContain('idx_coordination_event_fence_stream_age');
		expect(indexes).toContain('idx_coordination_event_fence_global_age');
		db.close();
	});

	test('runProjectMigrations is idempotent', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		runProjectMigrations(db);
		const versions = db
			.query<{ version: number }, []>(
				'SELECT version FROM schema_migrations ORDER BY version',
			)
			.all()
			.map((r) => r.version);
		expect(versions).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
			22, 23, 24, 25, 26, 27, 28,
		]);
		db.close();
	});

	test('v12 preserves populated v11 receipts and initializes completion generation', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		db.run('DELETE FROM schema_migrations WHERE version >= 12');
		db.run(`CREATE TABLE task_checkpoint_receipt_v11 (
			plan_identity_hash TEXT NOT NULL,
			task_id TEXT NOT NULL,
			label TEXT NOT NULL,
			state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'logged')),
			sha TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY(plan_identity_hash, task_id)
		)`);
		db.run(`INSERT INTO task_checkpoint_receipt_v11
			(plan_identity_hash, task_id, label, state, sha)
			SELECT 'legacy-hash', '1.1', 'legacy-label', 'logged', 'abc123'`);
		db.run('DROP TABLE task_checkpoint_receipt');
		db.run(
			'ALTER TABLE task_checkpoint_receipt_v11 RENAME TO task_checkpoint_receipt',
		);

		runProjectMigrations(db);

		const receipt = db
			.query<
				{
					label: string;
					state: string;
					sha: string;
					generation: number;
					completion_active: number;
					completion_ledger_seq: number | null;
				},
				[]
			>(
				`SELECT label, state, sha, generation, completion_active,
					completion_ledger_seq
				 FROM task_checkpoint_receipt`,
			)
			.get();
		expect(receipt).toEqual({
			label: 'legacy-label',
			state: 'logged',
			sha: 'abc123',
			generation: 1,
			completion_active: 1,
			completion_ledger_seq: null,
		});
		db.close();
	});

	test('v13 preserves populated v12 receipts and leaves epoch binding nullable', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		// #2480: simulate a pre-v13 database (v14+ now exist above v13, so the
		// simulation must delete every later version too — MAX-based versioning).
		db.run('DELETE FROM schema_migrations WHERE version >= 13');
		db.run(`CREATE TABLE task_checkpoint_receipt_v12 (
			plan_identity_hash TEXT NOT NULL,
			task_id TEXT NOT NULL,
			label TEXT NOT NULL,
			state TEXT NOT NULL CHECK(state IN ('pending', 'committed', 'logged')),
			sha TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			generation INTEGER NOT NULL DEFAULT 1,
			completion_active INTEGER NOT NULL DEFAULT 1
				CHECK(completion_active IN (0, 1)),
			PRIMARY KEY(plan_identity_hash, task_id)
		)`);
		db.run(`INSERT INTO task_checkpoint_receipt_v12
			(plan_identity_hash, task_id, label, state, sha, generation, completion_active)
			VALUES ('v12-hash', '2.1', 'v12-label', 'logged', 'def456', 4, 1)`);
		db.run('DROP TABLE task_checkpoint_receipt');
		db.run(
			'ALTER TABLE task_checkpoint_receipt_v12 RENAME TO task_checkpoint_receipt',
		);

		runProjectMigrations(db);

		const receipt = db
			.query<
				{
					label: string;
					state: string;
					sha: string;
					generation: number;
					completion_active: number;
					completion_ledger_seq: number | null;
				},
				[]
			>(
				`SELECT label, state, sha, generation, completion_active,
					completion_ledger_seq
				 FROM task_checkpoint_receipt`,
			)
			.get();
		expect(receipt).toEqual({
			label: 'v12-label',
			state: 'logged',
			sha: 'def456',
			generation: 4,
			completion_active: 1,
			completion_ledger_seq: null,
		});
		db.close();
	});

	test('upgrades populated v3 QA profiles without changing legacy data or locks (TF-001)', () => {
		const db = new Database(':memory:');
		// Previous coverage migrated only an empty database from v0. Recreate the
		// exact pre-PR v3 schema so additive upgrades cannot silently lose existing
		// gate selections or weaken an already-approved row's lock.
		db.run(`CREATE TABLE schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.run(`CREATE TABLE project_constraints (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			constraint_type TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.run(`CREATE TABLE qa_gate_profile (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			plan_id TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			project_type TEXT,
			gates TEXT NOT NULL DEFAULT '{}',
			locked_at TEXT,
			locked_by_snapshot_seq INTEGER
		)`);
		db.run(`CREATE TRIGGER trg_qa_gate_profile_no_update_after_lock
			BEFORE UPDATE ON qa_gate_profile
			WHEN OLD.locked_at IS NOT NULL
			BEGIN
				SELECT RAISE(ABORT, 'qa_gate_profile row is locked and cannot be modified after critic approval');
			END`);
		for (const [version, name] of [
			[1, 'create_project_constraints'],
			[2, 'create_qa_gate_profile'],
			[3, 'create_qa_gate_profile_immutability_trigger'],
		] as const) {
			db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
				version,
				name,
			]);
		}
		db.run(
			`INSERT INTO qa_gate_profile (plan_id, project_type, gates)
			 VALUES ('legacy-open', 'ts', '{"reviewer":false,"drift_check":true}')`,
		);
		db.run(
			`INSERT INTO qa_gate_profile
			 (plan_id, project_type, gates, locked_at, locked_by_snapshot_seq)
			 VALUES ('legacy-locked', 'rust', '{"reviewer":true}', '2026-01-02T03:04:05.000Z', 17)`,
		);

		runProjectMigrations(db);

		const versions = db
			.query<{ version: number }, []>(
				'SELECT version FROM schema_migrations ORDER BY version',
			)
			.all()
			.map((row) => row.version);
		expect(versions).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
			22, 23, 24, 25, 26, 27, 28,
		]);
		const rows = db
			.query<
				{
					plan_id: string;
					project_type: string;
					gates: string;
					locked_at: string | null;
					locked_by_snapshot_seq: number | null;
					raw_swarm: string | null;
					raw_title: string | null;
					identity_hash: string | null;
				},
				[]
			>(
				`SELECT plan_id, project_type, gates, locked_at,
					locked_by_snapshot_seq, raw_swarm, raw_title, identity_hash
				 FROM qa_gate_profile ORDER BY plan_id`,
			)
			.all();
		expect(rows).toEqual([
			{
				plan_id: 'legacy-locked',
				project_type: 'rust',
				gates: '{"reviewer":true}',
				locked_at: '2026-01-02T03:04:05.000Z',
				locked_by_snapshot_seq: 17,
				raw_swarm: null,
				raw_title: null,
				identity_hash: null,
			},
			{
				plan_id: 'legacy-open',
				project_type: 'ts',
				gates: '{"reviewer":false,"drift_check":true}',
				locked_at: null,
				locked_by_snapshot_seq: null,
				raw_swarm: null,
				raw_title: null,
				identity_hash: null,
			},
		]);
		expect(
			db
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM qa_gate_profile_identity',
				)
				.get()?.count,
		).toBe(0);
		expect(() => {
			db.run(
				`UPDATE qa_gate_profile SET gates = '{}' WHERE plan_id = 'legacy-locked'`,
			);
		}).toThrow(/locked/i);
		db.run(
			`UPDATE qa_gate_profile SET gates = '{"reviewer":true}' WHERE plan_id = 'legacy-open'`,
		);
		expect(
			db
				.query<{ gates: string }, []>(
					"SELECT gates FROM qa_gate_profile WHERE plan_id = 'legacy-open'",
				)
				.get()?.gates,
		).toBe('{"reviewer":true}');
		db.close();
	});

	test('qa_gate_profile.plan_id is UNIQUE', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		db.run("INSERT INTO qa_gate_profile (plan_id, gates) VALUES ('p1', '{}')");
		expect(() => {
			db.run(
				"INSERT INTO qa_gate_profile (plan_id, gates) VALUES ('p1', '{}')",
			);
		}).toThrow();
		db.close();
	});

	test('qa_gate_profile.identity_hash is UNIQUE when present', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		db.run(
			"INSERT INTO qa_gate_profile (plan_id, identity_hash, gates) VALUES ('p1', 'hash-1', '{}')",
		);
		expect(() => {
			db.run(
				"INSERT INTO qa_gate_profile (plan_id, identity_hash, gates) VALUES ('p2', 'hash-1', '{}')",
			);
		}).toThrow();
		db.close();
	});

	test('task_checkpoint_receipt primary key is plan-scoped', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		db.run(
			"INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state) VALUES ('plan-a', '1.1', 'checkpoint-a', 'pending')",
		);
		db.run(
			"INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state) VALUES ('plan-b', '1.1', 'checkpoint-b', 'pending')",
		);
		expect(() => {
			db.run(
				"INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state) VALUES ('plan-a', '1.1', 'checkpoint-c', 'pending')",
			);
		}).toThrow();
		db.close();
	});

	test('task_checkpoint_receipt rejects invalid states', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		expect(() => {
			db.run(
				"INSERT INTO task_checkpoint_receipt (plan_identity_hash, task_id, label, state) VALUES ('plan-a', '1.1', 'checkpoint-a', 'invalid')",
			);
		}).toThrow();
		db.close();
	});

	test('immutability trigger aborts updates on locked rows', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		db.run(
			"INSERT INTO qa_gate_profile (plan_id, gates, locked_at, locked_by_snapshot_seq) VALUES ('p1', '{\"reviewer\":true}', datetime('now'), 42)",
		);
		expect(() => {
			db.run(
				"UPDATE qa_gate_profile SET gates = '{\"reviewer\":false}' WHERE plan_id = 'p1'",
			);
		}).toThrow(/locked/i);
		db.close();
	});

	test('immutability trigger allows updates on unlocked rows', () => {
		const db = new Database(':memory:');
		runProjectMigrations(db);
		db.run(
			"INSERT INTO qa_gate_profile (plan_id, gates) VALUES ('p1', '{\"reviewer\":true}')",
		);
		db.run(
			'UPDATE qa_gate_profile SET gates = \'{"reviewer":true,"sast_enabled":true}\' WHERE plan_id = \'p1\'',
		);
		const row = db
			.query<{ gates: string }, []>(
				"SELECT gates FROM qa_gate_profile WHERE plan_id = 'p1'",
			)
			.get();
		expect(row?.gates).toContain('sast_enabled');
		db.close();
	});
});

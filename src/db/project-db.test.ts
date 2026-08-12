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
		expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

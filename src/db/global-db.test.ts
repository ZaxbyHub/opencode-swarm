/**
 * Tests for src/db/global-db.ts.
 *
 * Uses XDG_CONFIG_HOME override so getPlatformConfigDir() resolves into
 * a temp directory (Linux only — this test suite is gated accordingly).
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalTmpDir } from '../../tests/helpers/tmpdir.js';
import {
	closeGlobalDb,
	getGlobalDb,
	runGlobalMigrations,
} from './global-db.js';

let tempDir: string;
let origXdg: string | undefined;
let origLocalAppData: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(canonicalTmpDir(), 'global-db-test-')),
	);
	origXdg = process.env.XDG_CONFIG_HOME;
	origLocalAppData = process.env.LOCALAPPDATA;
	origHome = process.env.HOME;
	process.env.XDG_CONFIG_HOME = tempDir;
	process.env.LOCALAPPDATA = tempDir;
	process.env.HOME = tempDir;
	closeGlobalDb();
});

afterEach(() => {
	closeGlobalDb();
	if (origXdg === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = origXdg;
	}
	if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = origLocalAppData;
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe('global-db', () => {
	test('getGlobalDb creates the config dir and DB file', () => {
		const db = getGlobalDb();
		expect(db).toBeDefined();
		// Linux path: $XDG_CONFIG_HOME/opencode-swarm/global-rules.db
		const expectedPath =
			process.platform === 'win32'
				? path.join(tempDir, 'opencode-swarm', 'config', 'global-rules.db')
				: process.platform === 'darwin'
					? path.join(
							tempDir,
							'Library',
							'Application Support',
							'opencode-swarm',
							'global-rules.db',
						)
					: path.join(tempDir, 'opencode-swarm', 'global-rules.db');
		expect(fs.existsSync(expectedPath)).toBe(true);
	});

	test('getGlobalDb returns the same singleton on repeat calls', () => {
		const a = getGlobalDb();
		const b = getGlobalDb();
		expect(a).toBe(b);
	});

	test('closeGlobalDb resets the singleton', () => {
		const a = getGlobalDb();
		closeGlobalDb();
		const b = getGlobalDb();
		expect(a).not.toBe(b);
	});

	test('runGlobalMigrations creates schema_migrations, global_rules, agent_prompt_sections', () => {
		const db = new Database(':memory:');
		runGlobalMigrations(db);
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r) => r.name);
		expect(tables).toContain('schema_migrations');
		expect(tables).toContain('global_rules');
		expect(tables).toContain('agent_prompt_sections');
		db.close();
	});

	test('runGlobalMigrations is idempotent', () => {
		const db = new Database(':memory:');
		runGlobalMigrations(db);
		runGlobalMigrations(db);
		const versions = db
			.query<{ version: number }, []>(
				'SELECT version FROM schema_migrations ORDER BY version',
			)
			.all()
			.map((r) => r.version);
		// No duplicates
		expect(versions).toEqual([1, 2]);
		db.close();
	});

	test('agent_prompt_sections UNIQUE(agent_name, section_key) is enforced', () => {
		const db = new Database(':memory:');
		runGlobalMigrations(db);
		db.run(
			"INSERT INTO agent_prompt_sections (agent_name, section_key, content) VALUES ('architect', 'mode:specify', 'one')",
		);
		expect(() => {
			db.run(
				"INSERT INTO agent_prompt_sections (agent_name, section_key, content) VALUES ('architect', 'mode:specify', 'two')",
			);
		}).toThrow();
		db.close();
	});

	test('global_rules.scope is constrained to "global"', () => {
		const db = new Database(':memory:');
		runGlobalMigrations(db);
		expect(() => {
			db.run(
				"INSERT INTO global_rules (scope, rule_type, content) VALUES ('project', 'test', 'x')",
			);
		}).toThrow();
		db.close();
	});
});

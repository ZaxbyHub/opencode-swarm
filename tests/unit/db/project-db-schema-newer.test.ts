/**
 * #3773: a database whose schema_migrations records a version NEWER than the
 * running client's highest supported migration refuses WRITABLE open with
 * the recorded and supported versions, preserving schema and rows; current
 * and supported-older versions keep opening/migrating; read-only and
 * archival/diagnostic paths stay available.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectDbError } from '../../../src/db/db-errors';
import { closeGlobalDb, getGlobalDb } from '../../../src/db/global-db';
import {
	closeProjectDb,
	getProjectDb,
	withProjectDbReadOnly,
} from '../../../src/db/project-db';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

function maxVersion(db: Database): number {
	const row = db
		.query<{ version: number | null }, []>(
			'SELECT MAX(version) as version FROM schema_migrations',
		)
		.get();
	return row?.version ?? 0;
}

function sqliteMaster(db: Database): string {
	return db
		.query<{ sql: string }[], []>(
			'SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name',
		)
		.all()
		.map((row) => row.sql)
		.join('\n');
}

function plantFutureRow(dbFile: string, version: number): void {
	const raw = new Database(dbFile);
	raw.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
		version,
		'future_migration_written_by_newer_client',
	]);
	raw.close();
}

describe('#3773 project-db newer-schema refusal', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('schema-newer-');
	});

	afterEach(() => {
		closeProjectDb(tempDir);
		removeTreeWithRetry(tempDir);
	});

	test('fresh open records the client highest version and is stable across reopen', () => {
		const db = getProjectDb(tempDir) as unknown as Database;
		const first = maxVersion(db);
		expect(first).toBeGreaterThan(0);
		closeProjectDb(tempDir);
		const db2 = getProjectDb(tempDir) as unknown as Database;
		expect(maxVersion(db2)).toBe(first);
	});

	test('one migration above supported: typed refusal naming both versions, schema and rows preserved', () => {
		const db = getProjectDb(tempDir) as unknown as Database;
		const supported = maxVersion(db);
		db.run(
			'CREATE TABLE sentinel_app_rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL)',
		);
		db.run(
			"INSERT INTO sentinel_app_rows (id, note) VALUES (7, 'preserve-me')",
		);
		const masterBefore = sqliteMaster(db);
		closeProjectDb(tempDir);
		plantFutureRow(path.join(tempDir, '.swarm', 'swarm.db'), supported + 1);

		let refusal: unknown;
		try {
			getProjectDb(tempDir);
			refusal = null;
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(ProjectDbError);
		const typed = refusal as ProjectDbError;
		expect(typed.category).toBe('schema_newer_than_supported');
		expect(typed.message).toContain(String(supported + 1));
		expect(typed.message).toContain(String(supported));

		const verify = new Database(path.join(tempDir, '.swarm', 'swarm.db'), {
			readonly: true,
		});
		expect(sqliteMaster(verify)).toBe(masterBefore);
		const sentinel = verify
			.query<{ note: string }, []>(
				'SELECT note FROM sentinel_app_rows WHERE id = 7',
			)
			.get();
		expect(sentinel?.note).toBe('preserve-me');
		expect(maxVersion(verify)).toBe(supported + 1);
		verify.close();
	});

	test('far-future version refuses identically', () => {
		const db = getProjectDb(tempDir) as unknown as Database;
		const supported = maxVersion(db);
		closeProjectDb(tempDir);
		plantFutureRow(path.join(tempDir, '.swarm', 'swarm.db'), supported + 999);
		let refusal: unknown;
		try {
			getProjectDb(tempDir);
			refusal = null;
		} catch (error) {
			refusal = error;
		}
		expect((refusal as ProjectDbError).category).toBe(
			'schema_newer_than_supported',
		);
		expect((refusal as ProjectDbError).message).toContain(
			String(supported + 999),
		);
	});

	test('zero-row schema_migrations on a populated DB keeps the pre-existing fail-closed refusal (not the newer-schema arm)', () => {
		const db = getProjectDb(tempDir) as unknown as Database;
		expect(maxVersion(db)).toBeGreaterThan(0);
		closeProjectDb(tempDir);
		const wipe = new Database(path.join(tempDir, '.swarm', 'swarm.db'));
		wipe.run('DELETE FROM schema_migrations');
		wipe.close();
		// Retained behavior: re-running v1's bare CREATE TABLE on the existing
		// schema fails closed with the typed migration_failed error (the
		// duplicate-column recovery arm covers only ALTER TABLE). The zero-row
		// case must NOT be misrouted into the newer-schema refusal.
		let refusal: unknown;
		try {
			getProjectDb(tempDir);
			refusal = null;
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(ProjectDbError);
		expect((refusal as ProjectDbError).category).toBe('migration_failed');
	});

	test('genuine older-schema migration: v40 table dropped and re-created, sentinel preserved', () => {
		const db = getProjectDb(tempDir) as unknown as Database;
		const supported = maxVersion(db);
		db.run(
			'CREATE TABLE legacy_sentinel (id INTEGER PRIMARY KEY, note TEXT NOT NULL)',
		);
		db.run("INSERT INTO legacy_sentinel (id, note) VALUES (3, 'old-data')");
		closeProjectDb(tempDir);
		const raw = new Database(path.join(tempDir, '.swarm', 'swarm.db'));
		raw.run('DROP TABLE IF EXISTS qa_gate_session_override');
		raw.run('DELETE FROM schema_migrations WHERE version = ?', [supported]);
		raw.close();

		const db2 = getProjectDb(tempDir) as unknown as Database;
		expect(maxVersion(db2)).toBe(supported);
		const recreated = db2
			.query<{ present: number }, []>(
				"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'qa_gate_session_override'",
			)
			.get();
		expect(recreated?.present).toBe(1);
		const sentinel = db2
			.query<{ note: string }, []>(
				'SELECT note FROM legacy_sentinel WHERE id = 3',
			)
			.get();
		expect(sentinel?.note).toBe('old-data');
	});

	test('read-only open on a newer-schema database stays available', () => {
		const db = getProjectDb(tempDir) as unknown as Database;
		const supported = maxVersion(db);
		closeProjectDb(tempDir);
		plantFutureRow(path.join(tempDir, '.swarm', 'swarm.db'), supported + 1);
		const observed = withProjectDbReadOnly(tempDir, (readOnly) =>
			maxVersion(readOnly as unknown as Database),
		);
		expect(observed).toBe(supported + 1);
	});
});

describe('#3773 global-db newer-schema refusal (public opener)', () => {
	let tempRoot: string;
	let origXdg: string | undefined;
	let origLocalAppData: string | undefined;
	let origHome: string | undefined;

	beforeEach(() => {
		tempRoot = canonicalMkdtemp('global-newer-');
		origXdg = process.env.XDG_CONFIG_HOME;
		origLocalAppData = process.env.LOCALAPPDATA;
		origHome = process.env.HOME;
		process.env.XDG_CONFIG_HOME = tempRoot;
		process.env.LOCALAPPDATA = tempRoot;
		process.env.HOME = tempRoot;
		closeGlobalDb();
	});

	afterEach(() => {
		closeGlobalDb();
		if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = origXdg;
		if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = origLocalAppData;
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		removeTreeWithRetry(tempRoot);
	});

	test('refuses through getGlobalDb, closes the raw handle, and retries cleanly', () => {
		const first = getGlobalDb() as unknown as Database;
		const supported = maxVersion(first);
		expect(supported).toBeGreaterThan(0);
		closeGlobalDb();
		// Locate the file the platform config dir resolved to.
		const dbFile = findGlobalDbFile(tempRoot);
		expect(dbFile).not.toBeNull();
		plantFutureRow(dbFile!, supported + 1);

		let refusal: unknown;
		try {
			getGlobalDb();
			refusal = null;
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain(String(supported + 1));
		expect((refusal as Error).message).toContain(String(supported));
		// Retry stays clean: same refusal, no leaked lock wedging the file.
		let secondRefusal: unknown;
		try {
			getGlobalDb();
			secondRefusal = null;
		} catch (error) {
			secondRefusal = error;
		}
		expect((secondRefusal as Error).message).toBe((refusal as Error).message);
	});
});

function findGlobalDbFile(root: string): string | null {
	const candidates: string[] = [];
	const walk = (current: string): void => {
		if (!fs.existsSync(current)) return;
		for (const entry of fs.readdirSync(current)) {
			const child = path.join(current, entry);
			if (fs.statSync(child).isDirectory()) walk(child);
			else if (entry === 'global-rules.db') candidates.push(child);
		}
	};
	walk(root);
	return candidates[0] ?? null;
}

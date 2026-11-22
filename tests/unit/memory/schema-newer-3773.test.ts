/**
 * #3773 memory-store legs (4.5 review finding 2): the SQLite memory
 * provider's PUBLIC opener refuses a newer-schema store and preserves rows,
 * a current store still initializes, and the memory-family merge refuses a
 * destination a newer client upgraded — before any mutation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import { migrateMemoryFamily } from '../../../src/memory/memory-family-migration';
import { evictAndClose } from '../../../src/memory/provider-pool';
import { SQLiteMemoryProvider } from '../../../src/memory/sqlite-provider';
import type { VettedMemoryRoot } from '../../../src/memory/storage-root';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

function maxVersion(dbPath: string): number {
	const Db = loadDatabaseCtor();
	const db = new Db(dbPath, { readonly: true });
	try {
		return (
			db
				.query<{ version: number | null }, []>(
					'SELECT MAX(version) as version FROM schema_migrations',
				)
				.get()?.version ?? 0
		);
	} finally {
		db.close();
	}
}

function plantFutureRow(dbPath: string, version: number): void {
	const Db = loadDatabaseCtor();
	const db = new Db(dbPath);
	db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
		version,
		'future_migration_written_by_newer_client',
	]);
	db.close();
}

function localRoot(directory: string): VettedMemoryRoot {
	return { kind: 'local', root: path.join(directory, '.swarm'), directory };
}

describe('#3773 memory provider newer-schema refusal (public opener)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('memory-newer-');
	});

	afterEach(() => {
		evictAndClose(tempDir);
		removeTreeWithRetry(tempDir);
	});

	test('current store initializes and re-opens (preserving leg)', async () => {
		const first = new SQLiteMemoryProvider(tempDir);
		await first.initialize();
		const dbPath = path.join(tempDir, '.swarm', 'memory', 'memory.db');
		const supported = maxVersion(dbPath);
		expect(supported).toBeGreaterThan(0);
		await first.close();
		const second = new SQLiteMemoryProvider(tempDir);
		await second.initialize();
		expect(maxVersion(dbPath)).toBe(supported);
		second.close?.();
	});

	test('newer-schema store refuses initialize, rows preserved', async () => {
		const seed = new SQLiteMemoryProvider(tempDir);
		await seed.initialize();
		seed.close?.();
		const dbPath = path.join(tempDir, '.swarm', 'memory', 'memory.db');
		const supported = maxVersion(dbPath);
		plantFutureRow(dbPath, supported + 1);

		const provider = new SQLiteMemoryProvider(tempDir);
		let refusal: unknown = null;
		try {
			await provider.initialize();
		} catch (error) {
			refusal = error;
		} finally {
			provider.close?.();
		}
		expect(refusal).toBeInstanceOf(Error);
		const message = (refusal as Error).message;
		expect(message).toContain(String(supported + 1));
		expect(message).toContain(String(supported));
		expect(maxVersion(dbPath)).toBe(supported + 1);
	});
});

describe('#3773 memory-family merge destination refusal', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('family-newer-');
	});

	afterEach(() => {
		evictAndClose(tempDir);
		for (const sub of ['dest', 'src', 'dest-ok', 'src-ok']) {
			evictAndClose(path.join(tempDir, sub));
		}
		removeTreeWithRetry(tempDir);
	});

	test('newer-schema destination refuses before mutation, rows preserved', async () => {
		const destDir = path.join(tempDir, 'dest');
		const srcDir = path.join(tempDir, 'src');
		// Build a real current destination through the provider's own writer
		// with a SENTINEL row, then upgrade it "by a newer client".
		const seed = new SQLiteMemoryProvider(destDir);
		await seed.initialize();
		seed.close?.();
		const destDb = path.join(destDir, '.swarm', 'memory', 'memory.db');
		insertSentinelRow(destDb, 'dest-sentinel-3773');
		const supported = maxVersion(destDb);
		plantFutureRow(destDb, supported + 1);
		// Source: a real current store with its own distinct row to merge.
		const src = new SQLiteMemoryProvider(srcDir);
		await src.initialize();
		src.close?.();
		insertSentinelRow(
			path.join(srcDir, '.swarm', 'memory', 'memory.db'),
			'src-row-3773',
		);

		let refusal: unknown = null;
		try {
			await migrateMemoryFamily(localRoot(destDir), localRoot(srcDir));
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(Error);
		const message = (refusal as Error).message;
		expect(message).toContain(String(supported + 1));
		expect(message).toContain(String(supported));
		// The recorded version is untouched AND the sentinel row survives.
		expect(maxVersion(destDb)).toBe(supported + 1);
		expect(hasRow(destDb, 'dest-sentinel-3773')).toBe(true);
		// The source row must NOT have arrived (the merge never ran).
		expect(hasRow(destDb, 'src-row-3773')).toBe(false);
	});

	test('current-version destination merges the source row (preserving leg)', async () => {
		const destDir = path.join(tempDir, 'dest-ok');
		const srcDir = path.join(tempDir, 'src-ok');
		const destSeed = new SQLiteMemoryProvider(destDir);
		await destSeed.initialize();
		destSeed.close?.();
		const srcSeed = new SQLiteMemoryProvider(srcDir);
		await srcSeed.initialize();
		srcSeed.close?.();
		insertSentinelRow(
			path.join(srcDir, '.swarm', 'memory', 'memory.db'),
			'src-merge-proof-3773',
		);

		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		expect(Array.isArray(result.perMember)).toBe(true);
		const destDb = path.join(destDir, '.swarm', 'memory', 'memory.db');
		// The transfer actually happened — the source row is in the
		// destination after a supported merge.
		expect(hasRow(destDb, 'src-merge-proof-3773')).toBe(true);
	});
});

function insertSentinelRow(dbPath: string, id: string): void {
	const Db = loadDatabaseCtor();
	const db = new Db(dbPath);
	try {
		db.run(
			`INSERT OR REPLACE INTO memory_items (id, scope_key, kind, updated_at, expires_at, superseded_by, deleted, record_json) VALUES (?, 'global', 'fact', '2026-01-01T00:00:00.000Z', NULL, NULL, 0, ?)`,
			[id, JSON.stringify({ id, sentinel: true })],
		);
	} finally {
		db.close();
	}
}

function hasRow(dbPath: string, id: string): boolean {
	const Db = loadDatabaseCtor();
	const db = new Db(dbPath, { readonly: true });
	try {
		return (
			db
				.query<{ present: number }, [string]>(
					'SELECT 1 AS present FROM memory_items WHERE id = ?',
				)
				.get(id)?.present === 1
		);
	} finally {
		db.close();
	}
}

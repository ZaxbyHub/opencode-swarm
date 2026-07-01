import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import {
	computeMemoryContentHash,
	createMemoryId,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { MIGRATIONS } from '../../../src/memory/sqlite-provider';

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-vec-')),
	);
	openProviders.length = 0;
});

afterEach(async () => {
	for (const provider of openProviders.splice(0)) {
		provider.close();
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: SQLiteMemoryProvider): SQLiteMemoryProvider {
	openProviders.push(provider);
	return provider;
}

async function providerRoot(): Promise<string> {
	const root = path.join(tmpDir, 'sqlite-vec-test');
	await fs.mkdir(root, { recursive: true });
	return root;
}

// ---------------------------------------------------------------------------
// Migration v6 — creates `embedding_config` marker table
// ---------------------------------------------------------------------------
describe('Migration v6: create_embedding_config table', () => {
	test('migration v6 runs and creates the embedding_config table', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		expect(existsSync(dbPath)).toBe(true);

		const db = new Database(dbPath, { readonly: true });
		try {
			// embedding_config table must exist
			const tables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.all()
				.map((r) => r.name);
			expect(tables).toContain('embedding_config');

			// Migration record must be present in schema_migrations
			const migrationRow = db
				.query<{ version: number; name: string }, []>(
					'SELECT version, name FROM schema_migrations WHERE name = ?',
				)
				.get('create_embedding_config_table');
			expect(migrationRow).toEqual({
				version: 6,
				name: 'create_embedding_config_table',
			});
		} finally {
			db.close();
		}
	});

	test('MAX(schema_migrations.version) advances to 6 after migration v6', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			const maxRow = db
				.query<{ version: number }, []>(
					'SELECT MAX(version) as version FROM schema_migrations',
				)
				.get();
			expect(maxRow?.version).toBe(6);
		} finally {
			db.close();
		}
	});

	test('embedding_config table is empty on fresh init (no vec0 writes yet)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query<{ key: string; value: string }, []>(
					'SELECT key, value FROM embedding_config',
				)
				.all();
			expect(rows).toHaveLength(0);
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// vecAvailable flag — degrades gracefully when sqlite-vec is absent
// ---------------------------------------------------------------------------
describe('vecAvailable — absent sqlite-vec graceful degradation', () => {
	// NOTE: sqlite-vec is an optional binary extension. On most dev machines it
	// will NOT be installed, so vecAvailable will be false. This is the
	// expected default state. The provider must still be fully functional for
	// lexical-only recall when vec is absent.
	//
	// The vecAvailable=true path cannot be tested without the actual sqlite-vec
	// binary installed. That path is intentionally untested pending binary.

	test('provider initializes WITHOUT throwing when sqlite-vec is absent', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);

		// Initialize must not throw even though vec is absent
		await expect(provider.initialize()).resolves.toBeUndefined();
		provider.close();
	});

	test('provider remains functional for lexical-only recall when vec is absent', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		// Write a memory record with properly-computed contentHash
		const scope = {
			type: 'repository' as const,
			repoId: 'vec-test',
			repoRoot: root,
		};
		const base = {
			scope,
			kind: 'repo_convention' as const,
			text: 'Lexical recall works even without vec.',
		};
		const record = {
			id: createMemoryId(base),
			...base,
			tags: ['test'],
			confidence: 0.9,
			stability: 'durable' as const,
			source: { type: 'file' as const, filePath: 'test.ts' },
			createdAt: '2026-05-24T12:00:00.000Z',
			updatedAt: '2026-05-24T12:00:00.000Z',
			contentHash: computeMemoryContentHash(base),
			metadata: {} as Record<string, unknown>,
		};
		await provider.upsert(record);

		// Recall must work via lexical/FTS path
		const results = await provider.recall({
			query: 'lexical recall works',
			scopes: [record.scope],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
		});
		expect(results.map((r) => r.record.id)).toContain(record.id);
		provider.close();
	});

	test('vecAvailable is false when sqlite-vec extension load fails (expected on most dev machines)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		// vecAvailable should be false (sqlite-vec not installed on most dev machines)
		// We access this via the internal state — the public API does not throw,
		// but the provider logs a non-fatal warning. We verify the provider
		// initialized correctly and vec is not available.
		expect(provider).toBeDefined();
		// Verify by attempting an operation — if vecAvailable were true, the
		// memory_items_vec virtual table would exist; since it should be false,
		// only the FTS-based path is used.
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			const vecTables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%vec%'",
				)
				.all()
				.map((r) => r.name);
			// vec table should NOT exist when extension failed to load
			expect(vecTables).toHaveLength(0);
		} finally {
			db.close();
		}
		provider.close();
	});
});

// ---------------------------------------------------------------------------
// MIGRATIONS array integrity (v6 included)
// ---------------------------------------------------------------------------
describe('MIGRATIONS array includes v6 (embedding_config)', () => {
	test('MIGRATIONS has a version 6 entry', () => {
		const versions = MIGRATIONS.map((m) => m.version);
		expect(versions).toContain(6);
	});

	test('MIGRATIONS[5] (index 5) is version 6 — create_embedding_config_table', () => {
		const v6 = MIGRATIONS.find((m) => m.version === 6);
		expect(v6).toBeDefined();
		expect(v6!.name).toBe('create_embedding_config_table');
		expect(v6!.sql).toContain('embedding_config');
	});

	test('MIGRATIONS versions are strictly monotonic', () => {
		for (let i = 1; i < MIGRATIONS.length; i++) {
			expect(MIGRATIONS[i - 1].version).toBeLessThan(MIGRATIONS[i].version);
		}
	});
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — boundary + error cases (task 1.2)
// ---------------------------------------------------------------------------
describe('ADVERSARIAL — initialize() double-call is idempotent', () => {
	test('calling initialize() twice does not throw and does not corrupt state', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);

		// First init
		await provider.initialize();

		// Second init — must be idempotent (early-return after this.initialized = true)
		await expect(provider.initialize()).resolves.toBeUndefined();

		// State should be valid after double-init
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			// schema_migrations should have exactly one entry per version (no duplicates)
			const counts = db
				.query<{ version: number; name: string; cnt: number }, []>(
					'SELECT version, name, COUNT(*) as cnt FROM schema_migrations GROUP BY version',
				)
				.all();
			for (const row of counts) {
				expect(row.cnt).toBe(1);
			}
			// memory_items table should exist
			const tables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.all()
				.map((r) => r.name);
			expect(tables).toContain('memory_items');
		} finally {
			db.close();
		}
		provider.close();
	});
});

describe('ADVERSARIAL — migration v6 is idempotent (CREATE TABLE IF NOT EXISTS)', () => {
	test('re-running init after v6 already applied does not throw or duplicate tables', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		// Re-open and re-init — migration v6 should be skipped (already at MAX version)
		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await expect(provider2.initialize()).resolves.toBeUndefined();
		provider2.close();

		// Verify only one v6 migration record exists
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			const v6Rows = db
				.query<{ version: number; name: string }, []>(
					"SELECT version, name FROM schema_migrations WHERE name = 'create_embedding_config_table'",
				)
				.all();
			expect(v6Rows).toHaveLength(1);
			expect(v6Rows[0].version).toBe(6);

			// embedding_config table should still exist and be valid
			const tables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
				.all()
				.map((r) => r.name);
			expect(tables).toContain('embedding_config');
		} finally {
			db.close();
		}
	});
});

describe('ADVERSARIAL — future schema_migrations version is skipped (linear skip)', () => {
	test('schema_migrations with future version 99 — initialize() skips it without throwing', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		// Manually insert a future version 99 into schema_migrations
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				"INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future_migration_test', datetime('now'))",
			);
		} finally {
			db.close();
		}

		// Re-init — the future version 99 should be skipped (migration.version <= currentVersion)
		// and the provider should still initialize without throwing
		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await expect(provider2.initialize()).resolves.toBeUndefined();
		provider2.close();

		// Verify MAX(version) is still 99 (future row preserved, not rolled back),
		// and no migration was re-run (no new entries beyond 99)
		const db2 = new Database(dbPath, { readonly: true });
		try {
			const maxRow = db2
				.query<{ version: number }, []>(
					'SELECT MAX(version) as version FROM schema_migrations',
				)
				.get();
			expect(maxRow?.version).toBe(99);

			// No new migration rows beyond v6 should exist
			const allMigrations = db2
				.query<{ version: number }, []>(
					'SELECT version FROM schema_migrations ORDER BY version',
				)
				.all();
			// Should have [1,2,3,4,5,6,99] — no duplicates of 1-6
			const versions = allMigrations.map((r) => r.version);
			expect(versions).toContain(99);
			// The count of migration rows should be exactly 7 (versions 1-6 + 99)
			// No v6 re-run, no new rows for 99
			const v6Count = db2
				.query<{ cnt: number }, []>(
					'SELECT COUNT(*) as cnt FROM schema_migrations WHERE version = 6',
				)
				.get();
			expect(v6Count?.cnt).toBe(1); // exactly one v6 entry
		} finally {
			db2.close();
		}
	});
});

describe('ADVERSARIAL — dimension=0 is clamped (Math.max guard) and init does not crash', () => {
	test('embeddings.dimension=0 — initialize() does not throw; clamped to 1 internally', async () => {
		const root = await providerRoot();
		// The Math.max(1, Math.trunc(0)) guard in initializeVecExtension should clamp to 1
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true, dimension: 0 },
			}),
		);

		// initialize() must NOT throw even when dimension=0 — Math.max clamps to 1
		await expect(provider.initialize()).resolves.toBeUndefined();

		// Provider must remain functional for lexical recall after zero-dimension init
		const scope = {
			type: 'repository' as const,
			repoId: 'dim-zero-test',
			repoRoot: root,
		};
		const base = {
			scope,
			kind: 'repo_convention' as const,
			text: 'Works after zero-dimension init.',
		};
		const record = {
			id: createMemoryId(base),
			...base,
			tags: ['test'],
			confidence: 0.9,
			stability: 'durable' as const,
			source: { type: 'file' as const, filePath: 'test.ts' },
			createdAt: '2026-05-24T12:00:00.000Z',
			updatedAt: '2026-05-24T12:00:00.000Z',
			contentHash: computeMemoryContentHash(base),
			metadata: {} as Record<string, unknown>,
		};
		await provider.upsert(record);
		const results = await provider.recall({
			query: 'zero-dimension init',
			scopes: [record.scope],
			maxItems: 5,
			tokenBudget: 1000,
			minScore: 0,
		});
		expect(results.map((r) => r.record.id)).toContain(record.id);
		provider.close();
	});

	test('embeddings.dimension=-5 — initialize() does not throw (negative clamped by Math.max to 1)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true, dimension: -5 },
			}),
		);

		// initialize() must NOT throw even when dimension=-5
		await expect(provider.initialize()).resolves.toBeUndefined();
		provider.close();
	});
});

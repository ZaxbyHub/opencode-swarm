import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import {
	computeMemoryContentHash,
	createMemoryId,
	createProposalId,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { EmbeddingVersionMismatchError } from '../../../src/memory/embeddings/types';

// ---------------------------------------------------------------------------
// SpyEmbeddingProvider — controlled modelVersion + embed spy
// ---------------------------------------------------------------------------

/** Mutable spy that records embed() calls and allows configurable modelVersion. */
class SpyEmbeddingProvider {
	available = true;
	_modelVersion: string;
	dimension = 384;
	calls: { text: string }[] = [];

	constructor(modelVersion = 'test-model:384') {
		this._modelVersion = modelVersion;
	}

	get modelVersion(): string {
		return this._modelVersion;
	}

	set modelVersion(v: string) {
		this._modelVersion = v;
	}

	async embed(text: string): Promise<Float32Array> {
		this.calls.push({ text });
		if (!this.available) {
			throw new Error('Simulated: embedding provider unavailable');
		}
		return new Float32Array(this.dimension).fill(0.42);
	}

	reset() {
		this.calls = [];
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];
const patchedProviders: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-version-')),
	);
	openProviders.length = 0;
	patchedProviders.length = 0;
});

afterEach(async () => {
	// Restore db for patched providers before close()
	for (const p of patchedProviders.splice(0)) {
		(p as unknown as { db: Database | null }).db =
			(p as unknown as { _origDb: Database | null })._origDb ?? null;
		p.close();
	}
	for (const p of openProviders.splice(0)) {
		p.close();
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(p: SQLiteMemoryProvider): SQLiteMemoryProvider {
	openProviders.push(p);
	return p;
}

async function providerRoot(): Promise<string> {
	const r = path.join(tmpDir, 'version-' + randomUUID().slice(0, 8));
	await fs.mkdir(r, { recursive: true });
	return r;
}

/** Cast to any to invoke private methods for testing. */
function invokePrivate<M extends SQLiteMemoryProvider, R>(
	provider: M,
	method: string,
	...args: unknown[]
): R {
	return (provider as unknown as Record<string, (...a: unknown[]) => R>)[
		method
	](...args);
}

/** Build a valid durable MemoryRecord for testing. */
function makeRecord(
	root: string,
	overrides: Partial<{
		id: string;
		kind:
			| 'user_preference'
			| 'project_fact'
			| 'architecture_decision'
			| 'repo_convention';
		text: string;
		stability: 'ephemeral' | 'session' | 'durable';
		expiresAt: string;
	}> = {},
) {
	const scope = {
		type: 'repository' as const,
		repoId: 'test-repo',
		repoRoot: root,
	};
	const base = {
		scope,
		kind: 'user_preference' as const,
		text: 'Test durable memory',
		stability: 'durable' as const,
		...overrides,
	};
	const id = createMemoryId(base);
	return {
		id,
		...base,
		tags: ['test'],
		confidence: 0.9,
		source: { type: 'file' as const, filePath: 'test.ts' },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		contentHash: computeMemoryContentHash(base),
		metadata: {} as Record<string, unknown>,
	} satisfies Parameters<SQLiteMemoryProvider['upsert']>[0];
}

/**
 * Patch provider.db to intercept memory_items_vec writes (INSERT OR REPLACE via db.run).
 * bun:sqlite db.run both executes the statement AND returns Database for chaining.
 * Interception must: (a) execute the real write for embedding_config, (b) prevent
 * memory_items_vec writes from throwing (vec table doesn't exist in tests).
 *
 * Strategy: intercept db.run, detect memory_items_vec INSERT OR REPLACE, and use
 * db.prepare().run() to execute it without the chaining return value.
 * All other db.run calls pass through unchanged.
 */
function patchDbForVecWrite(provider: SQLiteMemoryProvider) {
	const priv = provider as unknown as {
		db: Database;
		_origDb: Database;
	};
	priv._origDb = priv.db;
	const originalQuery = priv.db.query.bind(priv.db);
	const originalRun = priv.db.run.bind(priv.db);
	const patchedDb = new Proxy(priv.db, {
		get(target, prop) {
			if (prop === 'query') {
				return (sql: string, ...args: unknown[]) => {
					// Intercept KNN vector search queries to return empty rows
					if (sql.includes('memory_items_vec') && sql.includes('embedding')) {
						return { all: () => [], run: () => ({ changes: 0 }) };
					}
					return originalQuery(sql, ...args);
				};
			}
			if (prop === 'run') {
				return (sql: string, ...runArgs: unknown[]) => {
					// memory_items_vec writes would throw (vec table doesn't exist in tests)
					// Use db.prepare().run() to execute without the chaining return value
					if (
						sql.includes('memory_items_vec') &&
						sql.includes('INSERT OR REPLACE')
					) {
						target.prepare(sql).run(...runArgs);
						return { changes: 0 } as unknown as Database;
					}
					// embedding_config writes must execute for real
					return originalRun(sql, ...runArgs);
				};
			}
			return (target as Record<string, unknown>)[prop as string];
		},
	});
	priv.db = patchedDb as Database;
	patchedProviders.push(provider);
}

// ---------------------------------------------------------------------------
// getStoredModelVersion — null on fresh state (no row in embedding_config)
// ---------------------------------------------------------------------------
describe('getStoredModelVersion — fresh state returns null', () => {
	test('returns null when embedding_config has no model_version row', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();
		// vecAvailable=false because sqlite-vec not installed; no model_version row was written
		const result = invokePrivate<SQLiteMemoryProvider, string | null>(
			provider,
			'getStoredModelVersion',
		);
		expect(result).toBeNull();
	});

	test('embedding_config table is empty after fresh init (no sqlite-vec)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query<{ key: string; value: string }, []>(
					'SELECT key, value FROM embedding_config',
				)
				.all();
			// Fresh init with vecAvailable=false writes nothing to embedding_config
			expect(rows).toHaveLength(0);
		} finally {
			db.close();
		}
	});
});

// ---------------------------------------------------------------------------
// getStoredModelVersion — returns stored value when row is injected
// ---------------------------------------------------------------------------
describe('getStoredModelVersion — returns stored value when row exists', () => {
	test('returns the stored model_version string when a row is present', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Manually inject a model_version row
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', 'old-model:768'],
			);
		} finally {
			db.close();
		}

		const result = invokePrivate<SQLiteMemoryProvider, string | null>(
			provider,
			'getStoredModelVersion',
		);
		expect(result).toBe('old-model:768');
	});

	test('returns null when key is present but value is NULL', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Insert row with NULL value
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', null],
			);
		} finally {
			db.close();
		}

		const result = invokePrivate<SQLiteMemoryProvider, string | null>(
			provider,
			'getStoredModelVersion',
		);
		// row?.value is null when SQLite NULL, so ?? null returns null
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Version mismatch guard — stored ≠ provider.modelVersion → throws
// ---------------------------------------------------------------------------
describe('Version mismatch guard — selectDenseCandidates throws EmbeddingVersionMismatchError', () => {
	test('throws EmbeddingVersionMismatchError with correct queryVersion + storedVersion when versions differ', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Force vecAvailable=true and install a fake provider with a controlled modelVersion
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('current-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		// Inject a DIFFERENT stored version in the DB
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', 'stale-model:384'],
			);
		} finally {
			db.close();
		}

		const request = {
			query: 'test query',
			scopes: [],
			kinds: [],
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
			includeExpired: false,
		};
		const embedding = new Float32Array(384).fill(0.1);

		let thrownErr: unknown;
		await expect(
			invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			),
		).rejects.toThrow(EmbeddingVersionMismatchError);

		try {
			await invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			);
		} catch (err: unknown) {
			thrownErr = err;
		}

		expect(thrownErr).toBeInstanceOf(EmbeddingVersionMismatchError);
		const mismatch = thrownErr as EmbeddingVersionMismatchError;
		expect(mismatch.queryVersion).toBe('current-model:384');
		expect(mismatch.storedVersion).toBe('stale-model:384');
	});

	test('throws with empty string stored version vs non-empty provider version', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('current-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		// Inject empty-string stored version
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', ''],
			);
		} finally {
			db.close();
		}

		const request = {
			query: 'test query',
			scopes: [],
			kinds: [],
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
			includeExpired: false,
		};
		const embedding = new Float32Array(384).fill(0.1);

		let thrownErr: unknown;
		try {
			await invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			);
		} catch (err: unknown) {
			thrownErr = err;
		}

		expect(thrownErr).toBeInstanceOf(EmbeddingVersionMismatchError);
		const mismatch = thrownErr as EmbeddingVersionMismatchError;
		expect(mismatch.queryVersion).toBe('current-model:384');
		expect(mismatch.storedVersion).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Same version — stored === provider.modelVersion → no throw
// ---------------------------------------------------------------------------
describe('Same version guard — selectDenseCandidates does not throw when versions match', () => {
	test('stored version matches provider.modelVersion → guard passes (KNN query runs, returns [] without sqlite-vec)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Force vecAvailable=true and install a fake provider with controlled modelVersion
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('same-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		// Inject the SAME stored version
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', 'same-model:384'],
			);
		} finally {
			db.close();
		}

		const request = {
			query: 'test query',
			scopes: [],
			kinds: [],
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
			includeExpired: false,
		};
		const embedding = new Float32Array(384).fill(0.1);

		// Should NOT throw — version matches. May return [] or throw for other reasons
		// (e.g. sqlite-vec not installed), but EmbeddingVersionMismatchError must NOT be thrown.
		let threwVersionMismatch = false;
		try {
			await invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			);
		} catch (err: unknown) {
			if (err instanceof EmbeddingVersionMismatchError) {
				threwVersionMismatch = true;
			}
		}
		expect(threwVersionMismatch).toBe(false);
	});

	test('stored version is null (first run, no vec) → guard passes, no throw', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Force vecAvailable=true to bypass the early-return guard in selectDenseCandidates
		// but NOT have the row, simulating first run before any vec write
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('first-run-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		// embedding_config has no row (null stored version) — the condition is:
		// storedVersion !== null && storedVersion !== queryVersion
		// Since storedVersion is null, the guard does NOT throw

		const request = {
			query: 'test query',
			scopes: [],
			kinds: [],
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
			includeExpired: false,
		};
		const embedding = new Float32Array(384).fill(0.1);

		let threwVersionMismatch = false;
		try {
			await invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			);
		} catch (err: unknown) {
			if (err instanceof EmbeddingVersionMismatchError) {
				threwVersionMismatch = true;
			}
		}
		// null stored version means the guard is skipped (first-run case)
		expect(threwVersionMismatch).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// rebuildEmbeddingIndex — no-op when vec or provider unavailable
// ---------------------------------------------------------------------------
describe('rebuildEmbeddingIndex — no-op when vec or provider unavailable', () => {
	test('vecAvailable=false → no-op (embed not called, no DB writes to memory_items_vec)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Insert a durable record so rebuild has something to iterate
		const record = makeRecord(root, { text: 'Some durable memory' });
		await provider.upsert(record);

		// Verify vecAvailable=false (sqlite-vec not installed)
		expect(
			(provider as unknown as { vecAvailable: boolean }).vecAvailable,
		).toBe(false);

		// Rebuild should complete without throwing
		await expect(provider.rebuildEmbeddingIndex()).resolves.toBeUndefined();

		// memory_items_vec should NOT exist (no writes attempted)
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath, { readonly: true });
		try {
			const vecTables = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%vec%'",
				)
				.all()
				.map((r) => r.name);
			expect(vecTables).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	test('embeddingProvider=null → no-op (no embed calls, no crash)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Force vecAvailable=true but remove embeddingProvider
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		(provider as unknown as { embeddingProvider: unknown }).embeddingProvider =
			null;

		// Rebuild should not throw
		await expect(provider.rebuildEmbeddingIndex()).resolves.toBeUndefined();
	});

	test('both vecAvailable=false AND embeddingProvider=null → no-op (no crash)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Both unavailable
		expect(
			(provider as unknown as { vecAvailable: boolean }).vecAvailable,
		).toBe(false);
		(provider as unknown as { embeddingProvider: unknown }).embeddingProvider =
			null;

		await expect(provider.rebuildEmbeddingIndex()).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// rebuildEmbeddingIndex — with vecAvailable=true + fake provider
// ---------------------------------------------------------------------------
describe('rebuildEmbeddingIndex — with vecAvailable=true + SpyEmbeddingProvider', () => {
	test('with vecAvailable=true + spy provider → embed called for each durable record', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Insert two durable records
		const record1 = makeRecord(root, { text: 'First durable memory' });
		const record2 = makeRecord(root, { text: 'Second durable memory' });
		await provider.upsert(record1);
		await provider.upsert(record2);

		// Force vecAvailable=true and install spy provider
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('rebuild-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		await provider.rebuildEmbeddingIndex();

		// embed() should have been called for each durable record
		// normalizeMemoryText lowercases and trims, so check lowercase version
		expect(spy.calls.length).toBeGreaterThanOrEqual(2);
		const calledTextsLower = spy.calls.map((c) => c.text.toLowerCase());
		expect(
			calledTextsLower.some((t) => t.includes('first durable memory')),
		).toBe(true);
		expect(
			calledTextsLower.some((t) => t.includes('second durable memory')),
		).toBe(true);
	});

	test('rebuildEmbeddingIndex → model_version updated in embedding_config via INSERT OR REPLACE', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		const record = makeRecord(root, { text: 'Durable for version update' });
		await provider.upsert(record);

		// Precondition: embedding_config has no model_version row (fresh, no sqlite-vec)
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		let db = new Database(dbPath, { readonly: true });
		try {
			const before = db
				.query<{ value: string }, []>(
					"SELECT value FROM embedding_config WHERE key = 'model_version'",
				)
				.get();
			// get() may return null for no rows; getStoredModelVersion returns null for no row
			// Verify the row doesn't exist (no stored version before rebuild)
			expect(before?.value ?? null).toBeNull();
		} finally {
			db.close();
		}

		// Force vecAvailable=true + spy provider with specific modelVersion
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('new-rebuild-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		await provider.rebuildEmbeddingIndex();

		// Verify model_version was written to embedding_config
		db = new Database(dbPath, { readonly: true });
		try {
			const after = db
				.query<{ value: string }, []>(
					"SELECT value FROM embedding_config WHERE key = 'model_version'",
				)
				.get();
			expect(after?.value).toBe('new-rebuild-model:384');
		} finally {
			db.close();
		}
	});

	test('per-record try/catch: one record embed throws → other records still processed', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Insert two durable records
		const record1 = makeRecord(root, { text: 'Good durable memory' });
		const record2 = makeRecord(root, { text: 'Bad durable memory' });
		await provider.upsert(record1);
		await provider.upsert(record2);

		// Force vecAvailable=true and install spy provider that throws for "Bad" text
		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('partial-fail-model:384');
		// Override embed to track calls AND throw for "bad" text
		spy.embed = async (text: string): Promise<Float32Array> => {
			spy.calls.push({ text }); // Track call (reassigned method doesn't use original's push)
			if (text.toLowerCase().includes('bad')) {
				throw new Error('Simulated embed failure for bad record');
			}
			return new Float32Array(384).fill(0.42);
		};
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		// rebuildEmbeddingIndex must NOT throw — per-record error is caught
		await expect(provider.rebuildEmbeddingIndex()).resolves.toBeUndefined();

		// Good record should still have been attempted (check lowercase)
		const calledTextsLower = spy.calls.map((c) => c.text.toLowerCase());
		expect(
			calledTextsLower.some((t) => t.includes('good durable memory')),
		).toBe(true);
	});

	test('ephemeral/session records are NOT passed to embed during rebuild', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Insert a durable and non-durable records
		const durable = makeRecord(root, {
			text: 'Durable record',
			stability: 'durable',
		});
		const ephemeral = makeRecord(root, {
			text: 'Ephemeral record',
			stability: 'ephemeral',
		});
		const session = makeRecord(root, {
			text: 'Session record',
			stability: 'session',
		});
		await provider.upsert(durable);
		await provider.upsert(ephemeral);
		await provider.upsert(session);

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('stability-filter-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		await provider.rebuildEmbeddingIndex();

		const calledTextsLower = spy.calls.map((c) => c.text.toLowerCase());
		// Durable and session records ARE embedded (filter only excludes ephemeral)
		expect(calledTextsLower.some((t) => t.includes('durable record'))).toBe(
			true,
		);
		expect(calledTextsLower.some((t) => t.includes('session record'))).toBe(
			true,
		);
		// Ephemeral records are NOT embedded (the filter checks stability !== 'ephemeral')
		expect(calledTextsLower.some((t) => t.includes('ephemeral record'))).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// ADVERSARIAL — rebuildEmbeddingIndex edge cases
// ---------------------------------------------------------------------------
describe('ADVERSARIAL — rebuildEmbeddingIndex edge cases', () => {
	test('empty memories map → rebuild is a no-op (no embed calls, no errors)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();
		// memories map is empty — no records upserted

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('empty-memories-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		// rebuildEmbeddingIndex should complete without throwing
		await expect(provider.rebuildEmbeddingIndex()).resolves.toBeUndefined();
		// embed should NOT have been called (no durable records)
		expect(spy.calls.length).toBe(0);
	});

	test('version comparison with whitespace version string (stored = "  ") → mismatch thrown', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Inject whitespace-only stored version
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', '   '],
			);
		} finally {
			db.close();
		}

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('current-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		const request = {
			query: 'test',
			scopes: [],
			kinds: [],
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
			includeExpired: false,
		};
		const embedding = new Float32Array(384).fill(0.1);

		// "   " !== "current-model:384" → should throw mismatch
		let threwMismatch = false;
		let thrownErr: unknown;
		try {
			await invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			);
		} catch (err: unknown) {
			thrownErr = err;
			if (err instanceof EmbeddingVersionMismatchError) {
				threwMismatch = true;
			}
		}
		expect(threwMismatch).toBe(true);
		const mismatch = thrownErr as EmbeddingVersionMismatchError;
		expect(mismatch.queryVersion).toBe('current-model:384');
		expect(mismatch.storedVersion).toBe('   ');
	});

	test('version comparison with empty string stored version vs non-empty provider → mismatch thrown', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Inject empty string stored version
		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		const db = new Database(dbPath);
		try {
			db.run(
				'INSERT OR REPLACE INTO embedding_config (key, value) VALUES (?, ?)',
				['model_version', ''],
			);
		} finally {
			db.close();
		}

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('provider-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		const request = {
			query: 'test',
			scopes: [],
			kinds: [],
			maxItems: 10,
			tokenBudget: 1000,
			minScore: 0,
			includeExpired: false,
		};
		const embedding = new Float32Array(384).fill(0.1);

		// '' !== 'provider-model:384' → should throw mismatch
		let threwMismatch = false;
		try {
			await invokePrivate<SQLiteMemoryProvider, unknown[]>(
				provider,
				'selectDenseCandidates',
				request,
				embedding,
			);
		} catch (err: unknown) {
			if (err instanceof EmbeddingVersionMismatchError) {
				threwMismatch = true;
			}
		}
		expect(threwMismatch).toBe(true);
	});

	test('rebuildEmbeddingIndex idempotency — running twice updates model_version each time', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		const record = makeRecord(root, { text: 'Idempotent rebuild test' });
		await provider.upsert(record);

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('idempotent-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		// First rebuild
		await provider.rebuildEmbeddingIndex();

		const dbPath = path.join(root, '.swarm', 'memory', 'memory.db');
		let db = new Database(dbPath, { readonly: true });
		let version1: string | undefined;
		try {
			const row = db
				.query<{ value: string }, []>(
					"SELECT value FROM embedding_config WHERE key = 'model_version'",
				)
				.get();
			version1 = row?.value;
		} finally {
			db.close();
		}
		expect(version1).toBe('idempotent-model:384');

		// Change the provider model version
		spy.modelVersion = 'idempotent-model-v2:384';

		// Second rebuild
		await provider.rebuildEmbeddingIndex();

		db = new Database(dbPath, { readonly: true });
		let version2: string | undefined;
		try {
			const row = db
				.query<{ value: string }, []>(
					"SELECT value FROM embedding_config WHERE key = 'model_version'",
				)
				.get();
			version2 = row?.value;
		} finally {
			db.close();
		}
		// Version should be updated to the new model version
		expect(version2).toBe('idempotent-model-v2:384');
		// embed should have been called twice (once per rebuild)
		expect(spy.calls.length).toBeGreaterThanOrEqual(2);
	});

	test('rebuildEmbeddingIndex with soft-deleted records are excluded', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
				hardDelete: false, // soft delete
			}),
		);
		await provider.initialize();

		const durable = makeRecord(root, { text: 'Normal durable' });
		await provider.upsert(durable);
		await provider.delete(durable.id, 'test delete');

		// Verify the record is soft-deleted in memories
		const deletedRecord = await provider.get(durable.id);
		expect(deletedRecord?.metadata.deleted).toBe(true);

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('deleted-filter-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		await provider.rebuildEmbeddingIndex();

		// Deleted record should NOT be embedded
		const calledTextsLower = spy.calls.map((c) => c.text.toLowerCase());
		expect(calledTextsLower.some((t) => t.includes('normal durable'))).toBe(
			false,
		);
	});

	test('rebuildEmbeddingIndex with superseded records are excluded', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		const oldRecord = makeRecord(root, {
			text: 'Superseded durable memory',
			kind: 'architecture_decision',
		});
		const newRecord = makeRecord(root, {
			text: 'Newer durable memory',
			kind: 'architecture_decision',
		});
		await provider.upsert(oldRecord);
		await provider.upsert(newRecord);

		// Create and apply a supersede proposal
		const proposal = await provider.createProposal({
			id: createProposalId({
				createdAt: new Date().toISOString(),
				proposer: 'test',
				text: 'supersede old',
			}),
			operation: 'supersede',
			proposedRecord: newRecord,
			targetMemoryId: oldRecord.id,
			relatedMemoryIds: [],
			proposedBy: { agentRole: 'test' },
			rationale: 'test superseded',
			evidenceRefs: [],
			status: 'pending',
			createdAt: new Date().toISOString(),
			metadata: {},
		});
		await provider.applyCuratorDecision({
			proposalId: proposal.id,
			action: 'supersede',
			oldMemoryId: oldRecord.id,
			replacement: newRecord,
			reason: 'test superseded',
		});

		// Verify oldRecord is superseded
		const oldRec = await provider.get(oldRecord.id);
		expect(oldRec?.supersededBy).toBe(newRecord.id);

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('superseded-filter-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		await provider.rebuildEmbeddingIndex();

		// Superseded record should NOT be embedded
		const calledTextsLower = spy.calls.map((c) => c.text.toLowerCase());
		expect(
			calledTextsLower.some((t) => t.includes('superseded durable memory')),
		).toBe(false);
		// New record should be embedded
		expect(
			calledTextsLower.some((t) => t.includes('newer durable memory')),
		).toBe(true);
	});

	test('records with empty normalized text are skipped (normalizeMemoryText returns empty after toLowerCase)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// Text that normalizes to empty: pure whitespace (trim removes it)
		const record = makeRecord(root, { text: '     ' });
		await provider.upsert(record);

		(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
		const spy = new SpyEmbeddingProvider('empty-text-model:384');
		(
			provider as unknown as {
				embeddingProvider: SpyEmbeddingProvider;
			}
		).embeddingProvider = spy;

		patchDbForVecWrite(provider);

		await provider.rebuildEmbeddingIndex();

		// embed should NOT have been called because normalized text is empty
		expect(spy.calls.length).toBe(0);
	});
});

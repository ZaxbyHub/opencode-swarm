import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { EmbeddingCache } from '../../../src/memory/embeddings/cache';
import { LocalEmbeddingProvider } from '../../../src/memory/embeddings/local-provider';
import {
	CrossEncoderReranker,
	type RerankCandidate,
	shouldRerank,
} from '../../../src/memory/embeddings/reranker';
import type { EmbeddingCacheEntry } from '../../../src/memory/embeddings/types';
import { EmbeddingUnavailableError } from '../../../src/memory/embeddings/types';
import type { MemoryRecord, RecallRequest } from '../../../src/memory/types';
import { makeEntry } from './_test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMemoryRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // 1 day from now
	const base: Omit<MemoryRecord, 'id' | 'contentHash'> = {
		scope: { type: 'project', projectId: 'test-project' },
		kind: 'scratch',
		text: 'test memory text',
		tags: ['test'],
		confidence: 0.9,
		stability: 'session',
		source: { type: 'test' },
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		expiresAt,
		metadata: {},
	};
	const record = { ...base, ...overrides } as MemoryRecord;
	record.id = createMemoryId({
		scope: record.scope,
		kind: record.kind,
		text: record.text,
	});
	record.contentHash = computeMemoryContentHash({
		scope: record.scope,
		kind: record.kind,
		text: record.text,
	});
	return record;
}

function makeRecallRequest(query: string): RecallRequest {
	return {
		query,
		scopes: [{ type: 'project', projectId: 'test-project' }],
		maxItems: 10,
		tokenBudget: 1000,
	};
}

// ---------------------------------------------------------------------------
// 1. GRACEFUL DEGRADATION (FR-003)
// ---------------------------------------------------------------------------

describe('1. Graceful degradation — transformers/sqlite-vec absent', () => {
	// -----------------------------------------------------------------------
	// 1a. LocalEmbeddingProvider
	// -----------------------------------------------------------------------
	describe('LocalEmbeddingProvider — transformers absent', () => {
		test('available=false after construction, embed() rejects with EmbeddingUnavailableError', async () => {
			const provider = new LocalEmbeddingProvider({
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
			});

			expect(provider.available).toBe(false);

			let thrownError: unknown;
			try {
				await provider.embed('hello world');
			} catch (err) {
				thrownError = err;
			}

			expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
			expect(provider.available).toBe(false);
		});

		test('no uncaught exception during embed() failure', async () => {
			const provider = new LocalEmbeddingProvider({
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
			});

			let caught: unknown;
			try {
				await provider.embed('test input');
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(EmbeddingUnavailableError);
		});

		test('embedBatch() rejects with EmbeddingUnavailableError', async () => {
			const provider = new LocalEmbeddingProvider({
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
			});

			let thrownError: unknown;
			try {
				await provider.embedBatch(['hello', 'world']);
			} catch (err) {
				thrownError = err;
			}

			expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
			expect(provider.available).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// 1b. CrossEncoderReranker
	// -----------------------------------------------------------------------
	describe('CrossEncoderReranker — transformers absent', () => {
		test('rerank() returns candidates unchanged, no crash', async () => {
			const reranker = new CrossEncoderReranker({});

			const candidates: RerankCandidate[] = [
				{ id: 'a', text: 'alpha', score: 0.9 },
				{ id: 'b', text: 'beta', score: 0.7 },
				{ id: 'c', text: 'gamma', score: 0.5 },
			];

			const result = await reranker.rerank(candidates, 'test query', 2);

			expect(result).toEqual(candidates);
			expect(result.length).toBe(3);
		});

		test('available is false initially and after rerank()', async () => {
			const reranker = new CrossEncoderReranker({});

			expect(reranker.available).toBe(false);

			await reranker.rerank([{ id: 'x', text: 'test' }], 'query');

			expect(reranker.available).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// 1c. SQLiteMemoryProvider — sqlite-vec absent
	// -----------------------------------------------------------------------
	describe('SQLiteMemoryProvider — sqlite-vec absent, embeddings enabled', () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await fs.realpath(
				await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-embed-port-')),
			);
		});

		afterEach(async () => {
			try {
				await fs.rm(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		});

		test('vecAvailable=false when sqlite-vec is not installed', async () => {
			const provider = new SQLiteMemoryProvider(tmpDir, {
				enabled: true,
				provider: 'sqlite',
				embeddings: {
					enabled: true,
					model: 'Xenova/all-MiniLM-L6-v2',
					dimension: 384,
				},
			});

			await provider.initialize();

			expect(
				(provider as unknown as { vecAvailable: boolean }).vecAvailable,
			).toBe(false);
		});

		test('recall succeeds lexical-only when vecAvailable=false', async () => {
			const provider = new SQLiteMemoryProvider(tmpDir, {
				enabled: true,
				provider: 'sqlite',
				embeddings: {
					enabled: true,
					model: 'Xenova/all-MiniLM-L6-v2',
					dimension: 384,
				},
			});

			await provider.initialize();

			// Insert a memory record
			const record = makeMemoryRecord({ text: 'hello world test' });
			await provider.upsert(record);

			// Recall should succeed and return the record via lexical-only fallback
			const results = await provider.recall(makeRecallRequest('hello'));

			expect(Array.isArray(results)).toBe(true);
			expect(results.length).toBeGreaterThan(0);
			expect(results[0]?.record.id).toBe(record.id);
		});

		test('no crash during initialization with embeddings enabled but sqlite-vec absent', async () => {
			const provider = new SQLiteMemoryProvider(tmpDir, {
				enabled: true,
				provider: 'sqlite',
				embeddings: {
					enabled: true,
					model: 'Xenova/all-MiniLM-L6-v2',
					dimension: 384,
				},
			});

			await expect(provider.initialize()).resolves.toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// 2. LAZY-LOAD + BUNDLE PORTABILITY (AGENTS.md invariant 2)
// ---------------------------------------------------------------------------

describe('2. Lazy-load + bundle portability', () => {
	const srcDir = path.join(process.cwd(), 'src/memory/embeddings');

	test('local-provider.ts has NO module-scope @xenova/transformers import', () => {
		const source = readFileSync(
			path.join(srcDir, 'local-provider.ts'),
			'utf-8',
		);

		const lines = source.split('\n');
		const moduleScopeXenovaImports: string[] = [];

		let insideFunction = false;
		let functionDepth = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const trimmed = line.trim();

			if (line.startsWith('import ') && !/^\s+import\s/.test(line)) {
				if (trimmed.includes('@xenova/transformers')) {
					moduleScopeXenovaImports.push(`Line ${i + 1}: ${line}`);
				}
			}

			if (
				trimmed.match(/^(export\s+)?(async\s+)?function\s+/) ||
				trimmed.match(/^(export\s+)?(async\s+)?class\s+/)
			) {
				insideFunction = true;
				functionDepth = 1;
			} else if (insideFunction) {
				functionDepth += (trimmed.match(/{/g) || []).length;
				functionDepth -= (trimmed.match(/}/g) || []).length;
				if (functionDepth <= 0) {
					insideFunction = false;
					functionDepth = 0;
				}
			}
		}

		expect(moduleScopeXenovaImports).toEqual([]);
	});

	test('reranker.ts has NO module-scope @xenova/transformers import', () => {
		const source = readFileSync(path.join(srcDir, 'reranker.ts'), 'utf-8');

		const lines = source.split('\n');
		const moduleScopeXenovaImports: string[] = [];

		let insideFunction = false;
		let functionDepth = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			const trimmed = line.trim();

			if (line.startsWith('import ') && !/^\s+import\s/.test(line)) {
				if (trimmed.includes('@xenova/transformers')) {
					moduleScopeXenovaImports.push(`Line ${i + 1}: ${line}`);
				}
			}

			if (
				trimmed.match(/^(export\s+)?(async\s+)?function\s+/) ||
				trimmed.match(/^(export\s+)?(async\s+)?class\s+/)
			) {
				insideFunction = true;
				functionDepth = 1;
			} else if (insideFunction) {
				functionDepth += (trimmed.match(/{/g) || []).length;
				functionDepth -= (trimmed.match(/}/g) || []).length;
				if (functionDepth <= 0) {
					insideFunction = false;
					functionDepth = 0;
				}
			}
		}

		expect(moduleScopeXenovaImports).toEqual([]);
	});

	test('dist/index.js does NOT contain top-level @xenova/transformers or sqlite-vec static import (skipped if dist missing)', () => {
		const distPath = path.join(process.cwd(), 'dist/index.js');

		if (!existsSync(distPath)) {
			// dist is generated build output — skip with note
			return;
		}

		const bundle = readFileSync(distPath, 'utf-8');

		// Check for static import statements referencing @xenova/transformers or sqlite-vec
		// at the top level of the bundle. They should only appear inside lazy-load strings.
		const lines = bundle.split('\n');
		const badImports: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!.trim();
			// Match lines that look like static imports (not inside strings/comments)
			if (/^import\s+/.test(line) && !line.startsWith('//')) {
				if (
					line.includes('@xenova/transformers') ||
					line.includes('sqlite-vec')
				) {
					badImports.push(`Line ${i + 1}: ${line}`);
				}
			}
		}

		expect(badImports).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. CACHE INVALIDATION (FR-008)
// ---------------------------------------------------------------------------

describe('3. Cache invalidation (FR-008)', () => {
	test('clear() empties the cache: size=0, has()=false for all prior entries', () => {
		const cache = new EmbeddingCache(256);
		cache.set('v1', 'a', makeEntry('a'));
		cache.set('v1', 'b', makeEntry('b'));
		cache.set('v1', 'c', makeEntry('c'));

		expect(cache.size).toBe(3);

		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.has('v1', 'a')).toBe(false);
		expect(cache.has('v1', 'b')).toBe(false);
		expect(cache.has('v1', 'c')).toBe(false);
		expect(cache.get('v1', 'a')).toBeUndefined();
	});

	test('two EmbeddingCache instances are isolated (no cross-instance leakage)', () => {
		const cacheA = new EmbeddingCache(10);
		const cacheB = new EmbeddingCache(10);

		cacheA.set('v1', 'only-in-a', makeEntry('only-in-a'));
		cacheB.set('v1', 'only-in-b', makeEntry('only-in-b'));

		expect(cacheA.size).toBe(1);
		expect(cacheB.size).toBe(1);
		expect(cacheA.has('v1', 'only-in-a')).toBe(true);
		expect(cacheA.has('v1', 'only-in-b')).toBe(false);
		expect(cacheB.has('v1', 'only-in-a')).toBe(false);
		expect(cacheB.has('v1', 'only-in-b')).toBe(true);

		// Clear A — B must be unaffected
		cacheA.clear();
		expect(cacheA.size).toBe(0);
		expect(cacheB.size).toBe(1);
		expect(cacheB.has('v1', 'only-in-b')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 4. ADVERSARIAL
// ---------------------------------------------------------------------------

describe('4. Adversarial — concurrent construction and missing config', () => {
	test('concurrent LocalEmbeddingProvider construction + embed() — no crash, all degrade', async () => {
		const providers = Array.from(
			{ length: 5 },
			() =>
				new LocalEmbeddingProvider({
					model: 'Xenova/all-MiniLM-L6-v2',
					dimension: 384,
				}),
		);

		// Fire embed() on all providers concurrently
		const results = await Promise.allSettled(
			providers.map((p) => p.embed('concurrent test')),
		);

		// All must reject with EmbeddingUnavailableError
		for (const result of results) {
			expect(result.status).toBe('rejected');
			expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
				EmbeddingUnavailableError,
			);
		}

		// All providers must be degraded
		for (const p of providers) {
			expect(p.available).toBe(false);
		}
	});

	test('CrossEncoderReranker with empty options — graceful', async () => {
		const reranker = new CrossEncoderReranker({});

		const candidates: RerankCandidate[] = [
			{ id: 'a', text: 'alpha' },
			{ id: 'b', text: 'beta' },
		];

		const result = await reranker.rerank(candidates, 'query');

		expect(result).toEqual(candidates);
		expect(reranker.available).toBe(false);
	});

	test('LocalEmbeddingProvider with empty model string — graceful degradation', async () => {
		const provider = new LocalEmbeddingProvider({
			model: '',
			dimension: 384,
		});

		let thrownError: unknown;
		try {
			await provider.embed('test');
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
		expect(provider.available).toBe(false);
	});

	test('SQLiteMemoryProvider with minimal config — no crash', async () => {
		const tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-embed-minimal-')),
		);

		try {
			const provider = new SQLiteMemoryProvider(tmpDir, {
				enabled: true,
				provider: 'sqlite',
			});

			await expect(provider.initialize()).resolves.toBeUndefined();
			provider.close();
		} finally {
			try {
				await fs.rm(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});
});

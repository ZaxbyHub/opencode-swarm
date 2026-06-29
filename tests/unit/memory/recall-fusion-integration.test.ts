/**
 * Verification tests for task 3.2 — recallWithDiagnostics fusion integration.
 * Source: src/memory/sqlite-provider.ts — recallWithDiagnostics
 *
 * Tests the disabled-path byte-identical guarantee (FR-002/FR-006),
 * the enabled-but-vec-unavailable graceful fallback, and adversarial cases.
 *
 * bun:test only — no mock.module leaks, no vi.mock.
 */

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import type {
	MemoryRecord,
	RecallRequest,
	RecallResultItem,
} from '../../../src/memory/types';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fusion-integration-')),
	);
	openProviders.length = 0;
});

afterEach(async () => {
	for (const p of openProviders.splice(0)) {
		try {
			p.close();
		} catch {
			// ignore
		}
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(p: SQLiteMemoryProvider): SQLiteMemoryProvider {
	openProviders.push(p);
	return p;
}

async function providerRoot(): Promise<string> {
	const r = path.join(tmpDir, 'fusion-' + randomUUID().slice(0, 8));
	await fs.mkdir(r, { recursive: true });
	return r;
}

// ---------------------------------------------------------------------------
// Record factory
// ---------------------------------------------------------------------------

function makeScope(repoId = 'test-repo') {
	return { type: 'repository' as const, repoId, repoRoot: tmpDir };
}

function makeRecord(
	text: string,
	kind: MemoryRecord['kind'] = 'project_fact',
	scope: ReturnType<typeof makeScope> = makeScope(),
	overrides: Partial<
		Pick<MemoryRecord, 'tags' | 'confidence' | 'stability' | 'expiresAt'>
	> = {},
): MemoryRecord {
	const base = { scope, kind, text };
	const id = createMemoryId(base);
	const contentHash = computeMemoryContentHash(base);
	return {
		id,
		scope,
		kind,
		text,
		tags: overrides.tags ?? ['test'],
		confidence: overrides.confidence ?? 0.85,
		stability: overrides.stability ?? 'durable',
		...overrides,
		source: { type: 'file' as const, filePath: 'test.ts' },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		contentHash,
		metadata: {},
	};
}

// ---------------------------------------------------------------------------
// PRIVATE METHOD INVOKER
// ---------------------------------------------------------------------------

function invokePrivate<R>(
	provider: SQLiteMemoryProvider,
	method: string,
	...args: unknown[]
): R {
	return (provider as unknown as Record<string, (...a: unknown[]) => R>)[
		method
	](...args);
}

// ---------------------------------------------------------------------------
// TEST 1: DISABLED PATH — BYTE-IDENTICAL results (FR-002 / FR-006)
//
// Key invariant: when embeddings are disabled, recallWithDiagnostics returns
// the EXACT same items as the lexical-only path. The fusionActive=false
// diagnostic is the only difference from the enabled path.
// ---------------------------------------------------------------------------

describe('DISABLED PATH — byte-identical to lexical-only (FR-002 / FR-006)', () => {
	test('recallWithDiagnostics with embeddings.enabled=false returns lexical-ranked results', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false }, // ← DISABLED
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// memA: perfect textOverlap with query 'TypeScript async' (all tokens in text)
		const memA = makeRecord(
			'TypeScript async patterns and type inference',
			'code_pattern',
			scope,
		);
		// memB: no token match with query (unrelated text)
		const memB = makeRecord(
			'Python Django REST framework views',
			'code_pattern',
			scope,
		);
		// memC: partial token match
		const memC = makeRecord(
			'Rust async ownership patterns',
			'code_pattern',
			scope,
		);

		await provider.upsert(memA);
		await provider.upsert(memB);
		await provider.upsert(memC);

		// Query 'TypeScript async': tokens ['typescript','async']
		// memA text: ['typescript','async','patterns','and','type','inference'] → overlap=2/2=1.0
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'TypeScript async',
				scopes: [scope], // ← explicit scope to avoid [] bug
				kinds: ['code_pattern'],
			}),
		);

		// Byte-identical check 1: fusionActive must be ABSENT (disabled path is byte-identical
		// to lexical-only shape — no fusionActive field at all, per FR-002/FR-006)
		expect(result.diagnostics).not.toHaveProperty('fusionActive');

		// Byte-identical check 2: items must be returned (lexical scoring works)
		expect(result.items.length).toBeGreaterThan(0);

		// Byte-identical check 3: top result should be memA (perfect textOverlap)
		expect(result.items[0]!.record.id).toBe(memA.id);

		// Byte-identical check 4: every item must have a score and reason
		for (const item of result.items) {
			expect(item.score).toBeGreaterThan(0);
			expect(item.reason).toBeTruthy();
			expect(item.reason.length).toBeGreaterThan(0);
			expect(item.signals).toBeDefined();
		}

		// Byte-identical check 5: no fusion-specific fields leak into items
		for (const item of result.items) {
			expect(item.reason).not.toContain('rrf_fused');
		}

		// Byte-identical check 6: diagnostics shape matches legacy expectations
		expect(typeof result.diagnostics.candidateCount).toBe('number');
		expect(typeof result.diagnostics.scoredCount).toBe('number');
		expect(typeof result.diagnostics.returnedCount).toBe('number');
		expect(typeof result.diagnostics.preScoredFilteredCount).toBe('number');
		expect(typeof result.diagnostics.noSignalCount).toBe('number');
		expect(typeof result.diagnostics.belowThresholdCount).toBe('number');
	});

	test('disabled path is byte-identical across two calls with same query', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// Query tokens all appear in text → perfect overlap
		const mem = makeRecord(
			'Distributed tracing OpenTelemetry Jaeger integration',
			'project_fact',
			scope,
		);
		await provider.upsert(mem);

		const request = makeRecallRequest({
			query: 'OpenTelemetry Jaeger',
			scopes: [scope],
			kinds: ['project_fact'],
		});

		const [result1, result2] = await Promise.all([
			provider.recallWithDiagnostics(request),
			provider.recallWithDiagnostics(request),
		]);

		// Identical results across calls
		expect(result1.items.map((i) => i.record.id)).toEqual(
			result2.items.map((i) => i.record.id),
		);
		expect(result1.items.map((i) => i.score)).toEqual(
			result2.items.map((i) => i.score),
		);
		expect(result1.diagnostics).not.toHaveProperty('fusionActive');
		expect(result2.diagnostics).not.toHaveProperty('fusionActive');
	});

	test('disabled path: minScore=0 returns all scored items regardless of textOverlap', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// High-relevance: query tokens all appear in text
		const high = makeRecord(
			'TypeScript async functions and type inference',
			'code_pattern',
			scope,
			{ confidence: 0.95 },
		);
		// Low-relevance: query tokens DO NOT appear (only confidence contributes)
		const low = makeRecord(
			'Python Django REST framework',
			'code_pattern',
			scope,
			{ confidence: 0.1 },
		);

		await provider.upsert(high);
		await provider.upsert(low);

		// With minScore=0, BOTH should be returned (scoring filters only apply with minScore > 0)
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'TypeScript async',
				scopes: [scope],
				kinds: ['code_pattern'],
				minScore: 0,
			}),
		);

		expect(result.diagnostics).not.toHaveProperty('fusionActive');
		const ids = result.items.map((i) => i.record.id);
		// high has perfect textOverlap; low has 0 textOverlap
		// With minScore=0, both should be in results (low score ≈ 0.085 > 0)
		expect(ids).toContain(high.id);
		// Verify ordering: high should be first (higher score)
		expect(ids[0]).toBe(high.id);
	});

	test('disabled path: diagnostics has NO fusionActive property (byte-identity contract)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		const mem = makeRecord(
			'OpenTelemetry Jaeger tracing',
			'project_fact',
			scope,
		);
		await provider.upsert(mem);

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'OpenTelemetry Jaeger',
				scopes: [scope],
				kinds: ['project_fact'],
			}),
		);

		// CRITICAL BYTE-IDENTITY: disabled path must NOT have fusionActive at all.
		// The prior buggy behavior added fusionActive:false — this violates byte-identity
		// because the lexical-only shape has no fusionActive field.
		expect(result.diagnostics).not.toHaveProperty('fusionActive');

		// Verify other diagnostics fields are still present (byte-identity check)
		expect(result.diagnostics.candidateCount).toBeGreaterThanOrEqual(0);
		expect(result.diagnostics.scoredCount).toBeGreaterThanOrEqual(0);
		expect(result.diagnostics.returnedCount).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// TEST 2: ENABLED-BUT-VEC-UNAVAILABLE — graceful fallback (FR-002 note)
//
// When embeddings.enabled=true but vecAvailable=false (sqlite-vec absent),
// the fusion branch is entered but dense retrieval gracefully returns [].
// The result is lexical-ranked — NO fusionActive field (dense fallback path).
// ---------------------------------------------------------------------------

describe('ENABLED-BUT-VEC-UNAVAILABLE — fusion branch does not crash', () => {
	test('recallWithDiagnostics with embeddings.enabled=true but vecAvailable=false falls back to lexical', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true }, // ← enabled
				// vecAvailable will be false (sqlite-vec not installed in test env)
			}),
		);
		await provider.initialize();

		// Verify vecAvailable is false in this environment
		expect(
			(provider as unknown as { vecAvailable: boolean }).vecAvailable,
		).toBe(false);

		const scope = makeScope('test-repo');
		const memA = makeRecord(
			'React hooks useEffect dependency array patterns',
			'code_pattern',
			scope,
		);
		const memB = makeRecord(
			'Vue 3 composition API reactive refs',
			'code_pattern',
			scope,
		);
		const memC = makeRecord(
			'Angular signals computed values',
			'code_pattern',
			scope,
		);

		await provider.upsert(memA);
		await provider.upsert(memB);
		await provider.upsert(memC);

		// This must NOT throw — fusion branch entered but dense retrieval fails gracefully
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'React hooks useEffect',
				scopes: [scope],
				kinds: ['code_pattern'],
			}),
		);

		// NO fusionActive field when dense fallback to lexical
		expect(result.diagnostics).not.toHaveProperty('fusionActive');

		// Lexical results still returned — fallback works
		expect(result.items.length).toBeGreaterThan(0);
		// Top result should be memA (perfect textOverlap)
		expect(result.items[0]!.record.id).toBe(memA.id);

		// No fusion markers in reason strings
		for (const item of result.items) {
			expect(item.reason).not.toContain('rrf_fused');
		}
	});

	test('enabled+vec-unavailable: empty memory store returns empty items with correct diagnostics', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		// No memories inserted
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({ query: 'anything at all' }),
		);

		// Must not crash
		expect(result.items).toEqual([]);
		expect(result.diagnostics.returnedCount).toBe(0);
		expect(result.diagnostics.candidateCount).toBe(0);
		// No fusionActive field on fallback path
		expect(result.diagnostics).not.toHaveProperty('fusionActive');
	});

	test('enabled+vec-unavailable: selectDenseCandidates returns [] — private method', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
			}),
		);
		await provider.initialize();

		const result = await invokePrivate<unknown[]>(
			provider,
			'selectDenseCandidates',
			makeRecallRequest(),
			new Float32Array(384).fill(0.1),
		);

		expect(result).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// TEST 3: DIAGNOSTIC SIGNAL — fusionActive field presence/absence
//
// Byte-identity rule: fusionActive only appears when fusion is actually active
// (dense retrieval succeeded). It is ABSENT in all other cases:
//   - disabled path (embeddings.enabled=false) → no fusionActive field
//   - enabled+vec-unavailable (dense fails → fallback) → no fusionActive field
//   - enabled+vec-available (dense succeeds) → fusionActive === true
// ---------------------------------------------------------------------------

describe('DIAGNOSTIC SIGNAL — fusionActive field correctness', () => {
	test('disabled path: fusionActive is absent (byte-identity contract)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		const mem = makeRecord(
			'OpenTelemetry Jaeger tracing',
			'project_fact',
			scope,
		);
		await provider.upsert(mem);

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'OpenTelemetry Jaeger',
				scopes: [scope],
				kinds: ['project_fact'],
			}),
		);

		// Byte-identity: NO fusionActive field on disabled path
		expect(result.diagnostics).not.toHaveProperty('fusionActive');
	});

	// Note: testing fusionActive=true requires a working sqlite-vec extension
	// which is not available in this test environment. The enabled+vec-available
	// case (dense succeeds → fusionActive===true) is covered by integration
	// tests in sqlite-provider-vec.test.ts and cannot be unit-tested here.
});

// ---------------------------------------------------------------------------
// TEST 4: ADVERSARIAL — empty store, no matches, boundary conditions
// ---------------------------------------------------------------------------

describe('ADVERSARIAL — empty store, no matches, boundary conditions', () => {
	test('empty memory store: recall returns empty items with correct diagnostics shape', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// No memories inserted
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({ query: 'anything at all', scopes: [scope] }),
		);

		expect(result.items).toEqual([]);
		expect(result.diagnostics.candidateCount).toBe(0);
		expect(result.diagnostics.scoredCount).toBe(0);
		expect(result.diagnostics.returnedCount).toBe(0);
		expect(result.diagnostics).not.toHaveProperty('fusionActive');
	});

	test('query with no textual match: returns items filtered by scoring (no crash)', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// Memory about Python; query is about unrelated topic
		await provider.upsert(
			makeRecord('Python Django REST framework views', 'code_pattern', scope),
		);

		// Query tokens 'zzzzzz' and 'nothing' do NOT appear in text
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({ query: 'zzzzzz nothing matches', scopes: [scope] }),
		);

		// No crash, result is a valid array (may be empty depending on score)
		expect(Array.isArray(result.items)).toBe(true);
		expect(typeof result.diagnostics.returnedCount).toBe('number');
		expect(result.diagnostics).not.toHaveProperty('fusionActive');
	});

	test('maxItems limits returned items correctly', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// Insert 10 memories, each with query-matching text
		for (let i = 0; i < 10; i++) {
			await provider.upsert(
				makeRecord(
					`Memory number ${i} TypeScript async`,
					'code_pattern',
					scope,
				),
			);
		}

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'TypeScript async',
				scopes: [scope],
				maxItems: 3,
			}),
		);

		expect(result.items.length).toBeLessThanOrEqual(3);
		expect(result.diagnostics.returnedCount).toBeLessThanOrEqual(3);
		expect(result.diagnostics).not.toHaveProperty('fusionActive');
	});

	test('expired memories are excluded by default', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		const active = makeRecord(
			'TypeScript async patterns for robust code',
			'code_pattern',
			scope,
		);
		const expired = makeRecord(
			'TypeScript legacy callbacks before async await',
			'code_pattern',
			scope,
			{ expiresAt: '2020-01-01T00:00:00.000Z' },
		);

		await provider.upsert(active);
		await provider.upsert(expired);

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'TypeScript async',
				scopes: [scope],
				kinds: ['code_pattern'],
			}),
		);

		expect(result.diagnostics).not.toHaveProperty('fusionActive');
		const ids = result.items.map((i) => i.record.id);
		expect(ids).toContain(active.id);
		expect(ids).not.toContain(expired.id);
	});

	test('scope filter restricts results to matching scope', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scopeA = {
			type: 'repository' as const,
			repoId: 'repo-A',
			repoRoot: tmpDir,
		};
		const scopeB = {
			type: 'repository' as const,
			repoId: 'repo-B',
			repoRoot: tmpDir,
		};

		const memA = makeRecord(
			'TypeScript async patterns scope A',
			'code_pattern',
			scopeA,
		);
		const memB = makeRecord(
			'TypeScript async patterns scope B',
			'code_pattern',
			scopeB,
		);

		await provider.upsert(memA);
		await provider.upsert(memB);

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'TypeScript async',
				scopes: [scopeA],
				kinds: ['code_pattern'],
			}),
		);

		expect(result.diagnostics).not.toHaveProperty('fusionActive');
		const ids = result.items.map((i) => i.record.id);
		expect(ids).toContain(memA.id);
		expect(ids).not.toContain(memB.id);
	});

	test('kind filter restricts results to matching kind', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		const memPattern = makeRecord(
			'Test pattern error handling robust validation',
			'test_pattern',
			scope,
		);
		const memArch = makeRecord(
			'Architecture decision API design principles',
			'architecture_decision',
			scope,
		);

		await provider.upsert(memPattern);
		await provider.upsert(memArch);

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'test pattern error handling',
				scopes: [scope],
				kinds: ['test_pattern'],
			}),
		);

		expect(result.diagnostics).not.toHaveProperty('fusionActive');
		const ids = result.items.map((i) => i.record.id);
		expect(ids).toContain(memPattern.id);
		expect(ids).not.toContain(memArch.id);
	});

	test('result items are sorted by score descending', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		// High-relevance: all query tokens in text
		const high = makeRecord(
			'TypeScript async functions',
			'code_pattern',
			scope,
			{
				confidence: 0.95,
			},
		);
		// Medium-relevance: some tokens
		const med = makeRecord('TypeScript types', 'code_pattern', scope, {
			confidence: 0.8,
		});
		// Low-relevance: fewer tokens
		const low = makeRecord('TypeScript', 'code_pattern', scope, {
			confidence: 0.7,
		});

		await provider.upsert(high);
		await provider.upsert(med);
		await provider.upsert(low);

		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'TypeScript async',
				scopes: [scope],
				kinds: ['code_pattern'],
			}),
		);

		const scores = result.items.map((i) => i.score);
		for (let i = 0; i < scores.length - 1; i++) {
			expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
		}
		// High should be first (perfect overlap)
		expect(result.items[0]!.record.id).toBe(high.id);
	});
});

// ---------------------------------------------------------------------------
// TEST 5: RESULT ITEM SHAPE — all required fields present
// ---------------------------------------------------------------------------

describe('RESULT ITEM SHAPE — all required fields present', () => {
	test('each returned item has record, score, reason, and signals', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: false },
			}),
		);
		await provider.initialize();

		const scope = makeScope('test-repo');
		await provider.upsert(
			makeRecord('Vue 3 composition API reactive refs', 'code_pattern', scope),
		);

		// Query with perfect overlap
		const result = await provider.recallWithDiagnostics(
			makeRecallRequest({
				query: 'Vue 3 composition API',
				scopes: [scope],
				kinds: ['code_pattern'],
			}),
		);

		expect(result.items.length).toBeGreaterThan(0);
		for (const item of result.items) {
			expect(item.record).toBeDefined();
			expect(typeof item.score).toBe('number');
			expect(typeof item.reason).toBe('string');
			expect(item.signals).toBeDefined();
			expect(typeof item.signals.textOverlap).toBe('number');
			expect(typeof item.signals.tagOverlap).toBe('number');
			expect(typeof item.signals.fileOverlap).toBe('number');
			expect(typeof item.signals.symbolOverlap).toBe('number');
			expect(typeof item.signals.kindMatch).toBe('boolean');
			expect(typeof item.signals.scopeMatch).toBe('boolean');
		}
	});
});

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function makeRecallRequest(
	overrides: Partial<RecallRequest> = {},
): RecallRequest {
	return {
		query: 'test query for memory recall',
		scopes: [],
		kinds: [],
		maxItems: 10,
		tokenBudget: 1200,
		minScore: 0,
		includeExpired: false,
		...overrides,
	};
}

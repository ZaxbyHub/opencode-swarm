import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'path';
import {
	computeMemoryContentHash,
	createMemoryId,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';
import type { MemoryRecord, RecallRequest } from '../../../src/memory/types';

/**
 * C.1 reviewer fix — Fix 2: propagate `explored` through the sqlite RRF
 * fusion reconstruction (Stage 5 in `SQLiteMemoryProvider.recallWithDiagnostics`).
 *
 * `qLearning.explorationRate: 1` makes the C.1 exploration draw fire on every
 * recall deterministically (any real `Math.random()` draw in [0,1) is < 1),
 * so these tests do not need an injectable RNG seam.
 *
 * sqlite-vec is not installed in this test environment (confirmed by the
 * existing `sqlite-provider-dense-retrieval.test.ts` guard tests: `vecAvailable`
 * defaults to `false`), so the enabled/fusion path is exercised the same way
 * those tests do — by forcing `vecAvailable = true` and injecting a fake
 * embedding provider + a patched `db` that intercepts only the KNN query,
 * leaving every other query (list/FTS/etc.) on the real database.
 */

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];
const patchedProviders: SQLiteMemoryProvider[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-explore-fusion-')),
	);
	openProviders.length = 0;
	patchedProviders.length = 0;
});

afterEach(async () => {
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
	const r = path.join(tmpDir, 'explore-' + randomUUID().slice(0, 8));
	await fs.mkdir(r, { recursive: true });
	return r;
}

/** Fake embedding provider that never throws. */
class FakeEmbeddingProvider {
	dimension = 384;
	modelVersion = 'test:384';

	async embed(_text: string): Promise<Float32Array> {
		return new Float32Array(this.dimension).fill(0.1);
	}

	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		return texts.map(() => new Float32Array(this.dimension).fill(0.1));
	}
}

/**
 * Patch provider.db to return controlled KNN rows for the vec query only,
 * while every other query goes to the real database. Mirrors the pattern in
 * `sqlite-provider-dense-retrieval.test.ts`.
 */
function patchDbForKnn(
	provider: SQLiteMemoryProvider,
	fakeKnnRows: { id: string; distance: number }[],
) {
	const priv = provider as unknown as { db: Database; _origDb: Database };
	priv._origDb = priv.db;
	const originalQuery = priv.db.query.bind(priv.db);
	const patchedDb = new Proxy(priv.db, {
		get(target, prop) {
			if (prop === 'query') {
				return (sql: string, ...args: unknown[]) => {
					if (sql.includes('memory_items_vec') && sql.includes('embedding')) {
						return { all: () => fakeKnnRows };
					}
					return originalQuery(sql, ...args);
				};
			}
			return (target as Record<string, unknown>)[prop as string];
		},
	});
	priv.db = patchedDb as Database;
	patchedProviders.push(provider);
}

function makeScope(root: string) {
	return {
		type: 'repository' as const,
		repoId: 'repo-explore',
		repoRoot: root,
	};
}

function makeExplorableRecord(
	root: string,
	text: string,
	overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
	const base = {
		scope: makeScope(root),
		kind: 'repo_convention' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: [],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-24T12:00:00.000Z',
		updatedAt: '2026-05-24T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
		...overrides,
	};
}

function makeRecallRequest(
	root: string,
	overrides: Partial<RecallRequest> = {},
): RecallRequest {
	return {
		query: 'database pool timeout',
		scopes: [makeScope(root)],
		maxItems: 10,
		tokenBudget: 1000,
		minScore: 0,
		...overrides,
	};
}

async function enableFusion(
	provider: SQLiteMemoryProvider,
	denseRows: { id: string; distance: number }[],
) {
	(provider as unknown as { vecAvailable: boolean }).vecAvailable = true;
	(
		provider as unknown as { embeddingProvider: FakeEmbeddingProvider }
	).embeddingProvider = new FakeEmbeddingProvider();
	patchDbForKnn(provider, denseRows);
}

describe('C.1 reviewer fix — Fix 2: explored flag survives sqlite RRF fusion reconstruction', () => {
	test('with minScore:0 (nothing re-gated), the surfaced item retains explored:true after fusion', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
				qLearning: { ...DEFAULT_QLEARNING_CONFIG, explorationRate: 1 },
			}),
		);
		await provider.initialize();

		const normal = makeExplorableRecord(
			root,
			'The database pool timeout configuration is documented here in module one.',
		);
		const suppressed = makeExplorableRecord(
			root,
			'The database pool timeout configuration is documented here for exploration.',
			{ tags: ['database', 'pool', 'timeout'], metadata: { qValue: 0.05 } },
		);
		await provider.upsert(normal);
		await provider.upsert(suppressed);

		await enableFusion(provider, [{ id: normal.id, distance: 0.1 }]);

		const { items, diagnostics } = await provider.recallWithDiagnostics(
			makeRecallRequest(root, { minScore: 0 }),
		);

		expect(diagnostics.fusionActive).toBe(true);
		const exploredItems = items.filter((item) => item.explored === true);
		expect(exploredItems).toHaveLength(1);
		expect(exploredItems[0].record.id).toBe(suppressed.id);
		expect(diagnostics.exploredCount).toBe(1);
	});

	test('reconstruction copies explored:true onto the fused item even when it is NOT the dense-only branch', async () => {
		// Targeted assertion on the specific reconstruction bug described by the
		// reviewer: Stage 5 rebuilds RecallResultItem from `record`/`score`/
		// `reason`/`signals` only. This test isolates that the fused item for
		// the explored record's id is built from the `lexicalItem` branch (it
		// has real signals, not the dense-only zeroed-signals shape) AND still
		// carries `explored: true`.
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
				qLearning: { ...DEFAULT_QLEARNING_CONFIG, explorationRate: 1 },
			}),
		);
		await provider.initialize();

		const normal = makeExplorableRecord(
			root,
			'The database pool timeout configuration is documented here in module one.',
		);
		const suppressed = makeExplorableRecord(
			root,
			'The database pool timeout configuration is documented here for exploration.',
			{ tags: ['database', 'pool', 'timeout'], metadata: { qValue: 0.05 } },
		);
		await provider.upsert(normal);
		await provider.upsert(suppressed);

		// Dense channel returns ONLY the normal record — the explored item must
		// come through purely via the lexical channel + reconstruction.
		await enableFusion(provider, [{ id: normal.id, distance: 0.1 }]);

		const { items } = await provider.recallWithDiagnostics(
			makeRecallRequest(root, { minScore: 0 }),
		);

		const exploredItem = items.find((item) => item.record.id === suppressed.id);
		expect(exploredItem).toBeDefined();
		expect(exploredItem?.explored).toBe(true);
		// Real signals (not the dense-only zeroed shape) prove this came from
		// the `lexicalItem` reconstruction branch, not the dense-only branch.
		expect(exploredItem?.signals.tagOverlap).toBeGreaterThan(0);
	});

	test('KNOWN LIMITATION (pre-existing, not introduced by C.1): the fusion-stage minScore re-gate (line ~686) can drop the explored item on its own normalised-score scale before Fix 2 reconstruction ever runs — Fix 3 keeps diagnostics honest in that case', async () => {
		const root = await providerRoot();
		const provider = track(
			new SQLiteMemoryProvider(root, {
				enabled: true,
				provider: 'sqlite',
				embeddings: { enabled: true },
				qLearning: { ...DEFAULT_QLEARNING_CONFIG, explorationRate: 1 },
			}),
		);
		await provider.initialize();

		const normal = makeExplorableRecord(
			root,
			'The database pool timeout configuration is documented here in module one.',
		);
		const suppressed = makeExplorableRecord(
			root,
			'The database pool timeout configuration is documented here for exploration.',
			{ tags: ['database', 'pool', 'timeout'], metadata: { qValue: 0.05 } },
		);
		await provider.upsert(normal);
		await provider.upsert(suppressed);

		// Dense channel favors `normal` heavily (rank 1, explored absent) so
		// `normal` dominates the fused ranking on both lexical and dense
		// channels. With only 2 candidates, RRF's min-max normalisation forces
		// the worse-ranked one to an exact fusedScore of 0 — if that is the
		// explored item, a positive `minScore` (the provider default is 0.05,
		// see DEFAULT_MEMORY_CONFIG.recall.minScore) drops it at the fusion
		// re-gate BEFORE Stage 5 reconstruction runs.
		await enableFusion(provider, [{ id: normal.id, distance: 0.01 }]);

		const { items, diagnostics } = await provider.recallWithDiagnostics(
			makeRecallRequest(root, { minScore: undefined }),
		);

		// Confirmed empirically: with `normal` dominant on both lexical and
		// dense channels and only 2 fused candidates, min-max normalisation
		// forces the explored item's fusedScore to exactly 0, which the
		// provider's default `recall.minScore` (0.05) then excludes at the
		// Stage-5 re-gate. This is the residual gap this test documents.
		const exploredItems = items.filter((item) => item.explored === true);
		expect(exploredItems).toHaveLength(0);
		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe(normal.id);
		// Fix 3 invariant: diagnostics agree with the actual output — no
		// "exploredCount:1 but nothing surfaced" contradiction, even though the
		// item was dropped by this pre-existing, out-of-scope fusion re-gate.
		expect(diagnostics.exploredCount).toBe(0);
	});
});

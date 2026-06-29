import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createConfiguredMemoryProvider,
	createMemoryGateway,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	evaluateMemoryRecallFixtures,
	LocalJsonlMemoryProvider,
	loadRecallEvaluationFixtures,
	type MemoryRecord,
	type RecallRequest,
} from '../../../src/memory';

const fixtureDirectory = path.resolve('tests', 'fixtures', 'memory-recall');
const tmpRoots: string[] = [];

afterEach(async () => {
	for (const root of tmpRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe('memory recall evaluation harness', () => {
	test('loads the requested golden fixture set', async () => {
		const fixtures = await loadRecallEvaluationFixtures(fixtureDirectory);

		expect(fixtures.map((fixture) => fixture.name).sort()).toEqual([
			'adversarial-memory',
			'cross-repo-isolation',
			'paraphrase-auth',
			'paraphrase-concurrency',
			'paraphrase-deployment',
			'repo-conventions',
			'stale-memory',
			'testing-patterns',
		]);
	});

	test('returns no fixtures for an empty fixture directory', async () => {
		const emptyDirectory = await createFixtureDirectory({});

		await expect(loadRecallEvaluationFixtures(emptyDirectory)).resolves.toEqual(
			[],
		);
	});

	test('throws when the fixture directory is missing', async () => {
		await expect(
			loadRecallEvaluationFixtures(
				path.join(
					os.tmpdir(),
					`swarm-memory-recall-missing-${Date.now()}-${Math.random()}`,
				),
			),
		).rejects.toThrow();
	});

	test('regression: malformed fixture records fail with record-specific validation (F-001)', async () => {
		const malformedDirectory = await createFixtureDirectory({
			'malformed-records.json': {
				name: 'malformed-records',
				query: 'missing record fields',
				scopes: [{ type: 'repository', repoId: 'opencode-swarm' }],
				expectedLabels: ['x'],
				records: [{ label: 'x' }],
			},
		});

		await expect(
			loadRecallEvaluationFixtures(malformedDirectory),
		).rejects.toThrow(
			'memory recall fixture malformed-records.json record x is missing scope',
		);
	});

	test('regression: malformed fixture records report invalid kind and text precisely (F-001)', async () => {
		const invalidKindDirectory = await createFixtureDirectory({
			'invalid-kind.json': validFixture({
				kind: 'bogus',
			}),
		});
		const invalidTextDirectory = await createFixtureDirectory({
			'invalid-text.json': validFixture({
				text: 123,
			}),
		});

		await expect(
			loadRecallEvaluationFixtures(invalidKindDirectory),
		).rejects.toThrow(
			'memory recall fixture invalid-kind.json record x has invalid kind',
		);
		await expect(
			loadRecallEvaluationFixtures(invalidTextDirectory),
		).rejects.toThrow(
			'memory recall fixture invalid-text.json record x has invalid text',
		);
	});

	test('reports recall metrics across providers and recall modes as JSON-safe data', async () => {
		const report = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
		});

		expect(report.schema_version).toBe(1);
		expect(new Date(report.generated_at).toISOString()).toBe(
			report.generated_at,
		);
		expect(report.providers).toEqual(['local-jsonl', 'sqlite']);
		expect(report.modes).toEqual(['manual', 'injection', 'curator']);
		expect(report.summary.fixture_count).toBe(8);
		expect(report.summary.run_count).toBe(48);
		expect(report.summary.passed_run_count).toBeGreaterThanOrEqual(28);
		expect(report.summary.injection_count).toBeGreaterThan(0);
		expect(report.summary.noisy_injection_count).toBe(0);
		expect(report.summary.same_scope_noise_count).toBeGreaterThan(0);
		expect(report.summary.cross_scope_leak_count).toBe(0);
		expect(report.summary.stale_memory_count).toBe(0);
		expect(report.summary['precision@k']).toBeGreaterThan(0);

		const nonParaphraseRuns = report.runs.filter(
			(run) => !run.fixture.startsWith('paraphrase-'),
		);
		for (const run of nonParaphraseRuns) {
			expect(run.metrics['recall@k']).toBe(1);
			expect(run.metrics['precision@k']).toBeGreaterThan(0);
		}

		const reparsed = JSON.parse(JSON.stringify(report));
		expect(reparsed.summary).toMatchObject({
			fixture_count: 8,
			run_count: 48,
			noisy_injection_count: 0,
			same_scope_noise_count: report.summary.same_scope_noise_count,
			cross_scope_leak_count: 0,
			stale_memory_count: 0,
		});
		expect(reparsed.summary).toHaveProperty('precision@k');
		expect(reparsed.summary).toHaveProperty('recall@k');
	});

	test('regression: unrelated same-scope memories are not injected', async () => {
		const report = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['local-jsonl', 'sqlite'],
			modes: ['injection'],
		});
		const adversarialRuns = report.runs.filter(
			(run) => run.fixture === 'adversarial-memory',
		);

		expect(adversarialRuns).toHaveLength(2);
		for (const run of adversarialRuns) {
			expect(run.metrics.noisy_injection_count).toBe(0);
			expect(run.metrics.same_scope_noise_count).toBe(0);
			expect(run.retrieved_labels).toEqual(['injector-query-signal']);
		}
	});

	test('gateway recall path preserves mode-specific retrieval for the same provider seam', async () => {
		const root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-gateway-eval-')),
		);
		tmpRoots.push(root);
		const provider = new LocalJsonlMemoryProvider(root, { enabled: true });
		const gateway = createMemoryGateway(
			{
				directory: root,
				sessionID: 'eval-session',
				agentRole: 'coder',
				agentId: 'coder',
				runId: 'eval-session',
			},
			{ config: { enabled: true }, provider },
		);
		const repositoryScope = gateway
			.deriveAllowedScopes()
			.find((scope) => scope.type === 'repository');
		if (!repositoryScope) throw new Error('repository scope was not derived');
		const record = gateway.createRecord({
			scope: repositoryScope,
			kind: 'code_pattern',
			text: 'Gateway evaluation recall should find src/memory/evaluation.ts query signal records.',
			tags: ['gateway', 'evaluation', 'recall'],
			confidence: 0.95,
			source: { type: 'file', filePath: 'src/memory/evaluation.ts' },
			metadata: { files: ['src/memory/evaluation.ts'] },
		});
		await gateway.upsertCurated(record);

		try {
			for (const mode of ['manual', 'injection', 'curator'] as const) {
				const bundle = await gateway.recall({
					query: 'src memory evaluation query signal',
					task: 'Validate src/memory/evaluation.ts recall metrics.',
					mode,
					scopes: [repositoryScope],
					kinds: ['code_pattern'],
					maxItems: 3,
					tokenBudget: 1000,
					minScore: mode === 'injection' ? 0.25 : 0,
					requireQuerySignal: mode === 'injection',
				});
				expect(bundle.items.map((item) => item.record.id)).toEqual([record.id]);
				expect(bundle.promptBlock).toContain('Retrieved Swarm Memory');
			}
		} finally {
			await gateway.dispose();
		}
	});

	test('regression: cross-repo memories do not leak into scoped recall', async () => {
		const report = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['local-jsonl', 'sqlite'],
		});
		const isolationRuns = report.runs.filter(
			(run) => run.fixture === 'cross-repo-isolation',
		);

		expect(isolationRuns).toHaveLength(6);
		for (const run of isolationRuns) {
			expect(run.metrics.cross_scope_leak_count).toBe(0);
			expect(run.retrieved_labels).not.toContain('other-repo-basename-routing');
		}
	});

	test('regression: superseded, deleted, and expired memories do not appear', async () => {
		const report = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['local-jsonl', 'sqlite'],
		});
		const staleRuns = report.runs.filter(
			(run) => run.fixture === 'stale-memory',
		);

		expect(staleRuns).toHaveLength(6);
		for (const run of staleRuns) {
			expect(run.metrics.stale_memory_count).toBe(0);
			expect(run.retrieved_labels).toEqual(['current-memory-export']);
		}
	});

	test('paraphrase fixtures: precision@k == 0 with embeddings disabled (lexical-only)', async () => {
		const allFixtures = await loadRecallEvaluationFixtures(fixtureDirectory);
		const paraphraseFixtures = allFixtures.filter((fixture) =>
			fixture.name.startsWith('paraphrase-'),
		);
		expect(paraphraseFixtures.map((f) => f.name).sort()).toEqual([
			'paraphrase-auth',
			'paraphrase-concurrency',
			'paraphrase-deployment',
		]);

		for (const fixture of paraphraseFixtures) {
			const { precisionAtK } = await recallWithConfig(fixture, {
				...DEFAULT_MEMORY_CONFIG,
				enabled: true,
				provider: 'local-jsonl',
			});
			expect(precisionAtK).toBe(0);
		}
	});

	test('paraphrase fixtures: precision@k > 0 with embeddings enabled (conditional on sqlite-vec)', async () => {
		if (!isSqliteVecAvailable()) {
			console.log(
				'SKIP: sqlite-vec not available locally; embeddings-on paraphrase assertion skipped',
			);
			return;
		}

		const allFixtures = await loadRecallEvaluationFixtures(fixtureDirectory);
		const paraphraseFixtures = allFixtures.filter((fixture) =>
			fixture.name.startsWith('paraphrase-'),
		);

		for (const fixture of paraphraseFixtures) {
			const { precisionAtK } = await recallWithConfig(fixture, {
				...DEFAULT_MEMORY_CONFIG,
				enabled: true,
				provider: 'sqlite',
				embeddings: {
					...DEFAULT_MEMORY_CONFIG.embeddings,
					enabled: true,
				},
			});
			expect(precisionAtK).toBeGreaterThan(0);
		}
	});
});

const DEFAULT_TIMESTAMP = '2026-05-26T12:00:00.000Z';

function materializeParaphraseRecords(fixture: RecallEvaluationFixture): {
	records: MemoryRecord[];
	expectedIds: Set<string>;
} {
	const idsByLabel = new Map<string, string>();
	const records: MemoryRecord[] = [];
	for (const record of fixture.records) {
		const base = {
			scope: record.scope,
			kind: record.kind,
			text: record.text,
		};
		const id = createMemoryId(base);
		idsByLabel.set(record.label, id);
		records.push({
			id,
			...base,
			tags: record.tags ?? [],
			confidence: record.confidence ?? 0.8,
			stability: record.stability ?? 'durable',
			source: record.source ?? { type: 'manual', ref: fixture.name },
			createdAt: DEFAULT_TIMESTAMP,
			updatedAt: DEFAULT_TIMESTAMP,
			contentHash: computeMemoryContentHash(base),
			metadata: {
				...(record.metadata ?? {}),
				fixture: fixture.name,
				fixtureLabel: record.label,
			},
		});
	}
	const expectedIds = new Set(
		fixture.expectedLabels.map((label) => {
			const id = idsByLabel.get(label);
			if (!id) {
				throw new Error(
					`fixture ${fixture.name} expected unknown label ${label}`,
				);
			}
			return id;
		}),
	);
	return { records, expectedIds };
}

async function recallWithConfig(
	fixture: RecallEvaluationFixture,
	config: MemoryConfig,
): Promise<{
	precisionAtK: number;
	recallAtK: number;
	retrievedIds: string[];
}> {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-paraphrase-')),
	);
	tmpRoots.push(root);
	const provider = createConfiguredMemoryProvider(root, config);
	try {
		await provider.initialize?.();
		const { records, expectedIds } = materializeParaphraseRecords(fixture);
		for (const record of records) {
			await provider.upsert(record);
		}
		const request: RecallRequest = {
			query: fixture.query,
			task: fixture.task,
			agentRole: fixture.agentRole,
			mode: 'manual',
			scopes: fixture.scopes,
			kinds: fixture.kinds,
			maxItems: fixture.maxItems ?? fixture.k ?? 5,
			tokenBudget: fixture.tokenBudget ?? 1000,
			minScore: 0,
		};
		const items = await provider.recall(request);
		const retrievedIds = items.map((item) => item.record.id);
		const topK = retrievedIds.slice(0, request.maxItems);
		const relevantAtK = topK.filter((id) => expectedIds.has(id)).length;
		const precisionAtK = relevantAtK / Math.max(request.maxItems, 1);
		const recallAtK = relevantAtK / Math.max(expectedIds.size, 1);
		return { precisionAtK, recallAtK, retrievedIds };
	} finally {
		await provider.close?.();
	}
}

function isSqliteVecAvailable(): boolean {
	try {
		const req = createRequire(import.meta.url);
		req.resolve('@sqlite/sqlite-vec/package.json');
		return true;
	} catch {
		return false;
	}
}

async function createFixtureDirectory(
	files: Record<string, unknown>,
): Promise<string> {
	const root = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-fixtures-')),
	);
	tmpRoots.push(root);
	for (const [file, value] of Object.entries(files)) {
		await fs.writeFile(
			path.join(root, file),
			`${JSON.stringify(value, null, 2)}\n`,
			'utf-8',
		);
	}
	return root;
}

function validFixture(recordOverrides: Record<string, unknown>): unknown {
	return {
		name: 'invalid-record',
		query: 'invalid record fields',
		scopes: [{ type: 'repository', repoId: 'opencode-swarm' }],
		expectedLabels: ['x'],
		records: [
			{
				label: 'x',
				scope: { type: 'repository', repoId: 'opencode-swarm' },
				kind: 'test_pattern',
				text: 'Valid fixture text before override.',
				...recordOverrides,
			},
		],
	};
}

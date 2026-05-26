import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createMemoryGateway,
	evaluateMemoryRecallFixtures,
	loadRecallEvaluationFixtures,
	LocalJsonlMemoryProvider,
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
			'repo-conventions',
			'stale-memory',
			'testing-patterns',
		]);
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
		expect(report.summary.fixture_count).toBe(5);
		expect(report.summary.run_count).toBe(30);
		expect(report.summary.passed_run_count).toBeGreaterThanOrEqual(28);
		expect(report.summary.injection_count).toBeGreaterThan(0);
		expect(report.summary.noisy_injection_count).toBe(0);
		expect(report.summary.same_scope_noise_count).toBeGreaterThan(0);
		expect(report.summary.cross_scope_leak_count).toBe(0);
		expect(report.summary.stale_memory_count).toBe(0);
		expect(report.summary['precision@k']).toBeGreaterThan(0);
		expect(report.summary['recall@k']).toBe(1);

		const reparsed = JSON.parse(JSON.stringify(report));
		expect(reparsed.summary).toMatchObject({
			fixture_count: 5,
			run_count: 30,
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
				expect(bundle.items.map((item) => item.record.id)).toEqual([
					record.id,
				]);
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
});

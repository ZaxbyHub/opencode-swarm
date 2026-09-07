import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { evaluateMemoryRecallFixtures } from '../../../src/memory/evaluation';
import { withSafeTestDir } from '../../helpers/safe-test-dir';

const fixtureDirectory = path.resolve(
	import.meta.dir,
	'../../fixtures/memory-recall',
);

function dependencies() {
	const calls = { embed: 0, rerank: 0 };
	return {
		calls,
		dependencies: {
			embeddingProvider: {
				modelVersion: 'profile-isolation',
				dimension: 2,
				available: true,
				embed: async () => {
					calls.embed++;
					return new Float32Array([1, 0]);
				},
				embedBatch: async (texts: string[]) => {
					calls.embed += texts.length;
					return texts.map(() => new Float32Array([1, 0]));
				},
			},
			reranker: {
				modelVersion: 'profile-isolation-reranker',
				available: true,
				rerank: async <T>(candidates: T[]) => {
					calls.rerank++;
					return [...candidates];
				},
			},
		},
	};
}

describe('recall evaluation profile isolation', () => {
	test('a multi-profile run invokes reranking only for hybrid+rerank', async () => {
		const { calls, dependencies: injected } = dependencies();
		const report = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['sqlite'],
			modes: ['manual'],
			profiles: ['lexical', 'hybrid', 'hybrid+rerank'],
			dependencies: injected,
		});
		expect(calls.embed).toBeGreaterThan(0);
		expect(calls.rerank).toBe(8);
		expect(
			report.runs
				.filter((run) => run.profile === 'hybrid')
				.every((run) => run.status === 'complete'),
		).toBe(true);
		for (const run of report.runs) {
			const usage = run.resource_usage;
			expect(usage).toBeDefined();
			for (const value of Object.values(usage ?? {})) {
				expect(Number.isFinite(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
			}
			const cap = run.resource_cap?.candidate_count ?? 0;
			expect(usage?.lexical_candidate_count).toBeLessThanOrEqual(cap);
			expect(usage?.dense_candidate_count).toBeLessThanOrEqual(cap);
			expect(usage?.rerank_candidate_count).toBeLessThanOrEqual(cap);
			expect(usage?.returned_token_estimate).toBeGreaterThanOrEqual(0);
		}
	});

	test('profile order cannot reuse a prior profile query embedding cache', async () => {
		const profiles = ['lexical', 'hybrid', 'hybrid+rerank'] as const;
		const forward = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['sqlite'],
			modes: ['manual'],
			profiles: [...profiles],
			dependencies: dependencies().dependencies,
			resourceCaps: { candidate_count: 2, token_budget: 256 },
		});
		const reverse = await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['sqlite'],
			modes: ['manual'],
			profiles: [...profiles].reverse(),
			dependencies: dependencies().dependencies,
			resourceCaps: { candidate_count: 2, token_budget: 256 },
		});

		for (const report of [forward, reverse]) {
			for (const profile of ['hybrid', 'hybrid+rerank'] as const) {
				const profileRuns = report.runs.filter(
					(run) => run.profile === profile,
				);
				expect(profileRuns.length).toBeGreaterThan(0);
				expect(
					profileRuns.every(
						(run) => run.resource_usage?.query_embedding_invocation_count === 1,
					),
				).toBe(true);
			}
		}
	}, 15_000);

	test('quality profiles enforce the returned-token cap for an oversized record without changing no-profile recall', async () => {
		await withSafeTestDir(async (directory) => {
			await fs.writeFile(
				path.join(directory, 'oversized.json'),
				JSON.stringify({
					name: 'oversized-record',
					query: 'oversized recall target',
					scopes: [{ type: 'repository', repoId: 'token-cap-test' }],
					k: 1,
					maxItems: 1,
					tokenBudget: 32,
					expectedLabels: ['oversized'],
					records: [
						{
							label: 'oversized',
							scope: { type: 'repository', repoId: 'token-cap-test' },
							kind: 'code_pattern',
							text: `oversized recall target ${'x'.repeat(512)}`,
							source: { type: 'manual', ref: 'token-cap-test' },
						},
					],
				}),
			);
			const profiled = await evaluateMemoryRecallFixtures({
				fixtureDirectory: directory,
				providers: ['sqlite'],
				modes: ['manual'],
				profiles: ['lexical'],
				resourceCaps: { candidate_count: 1, token_budget: 32 },
			});
			const unprofiled = await evaluateMemoryRecallFixtures({
				fixtureDirectory: directory,
				providers: ['sqlite'],
				modes: ['manual'],
			});

			expect(
				profiled.runs[0]?.resource_usage?.returned_token_estimate,
			).toBeLessThanOrEqual(32);
			expect(profiled.runs[0]?.retrieved_labels).toEqual([]);
			expect(unprofiled.runs[0]?.retrieved_labels).toEqual(['oversized']);
		}, 'swarm-memory-evaluation-token-cap-');
	});
});

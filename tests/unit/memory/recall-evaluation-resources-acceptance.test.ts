/** Acceptance coverage for issue #2490 / AC10. */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { evaluateMemoryRecallFixtures } from '../../../src/memory/evaluation';

const fixtureDirectory = path.resolve(
	import.meta.dir,
	'../../fixtures/memory-recall',
);

function makeDependencies(): unknown {
	return {
		embeddingProvider: {
			modelVersion: 'acceptance-embedding-v1',
			dimension: 4,
			available: true,
			embed: async (text: string) =>
				new Float32Array([text.length, text.includes('memory') ? 1 : 0, 0, 1]),
			embedBatch: async (texts: string[]) =>
				texts.map(
					(text) =>
						new Float32Array([
							text.length,
							text.includes('memory') ? 1 : 0,
							0,
							1,
						]),
				),
		},
		reranker: {
			modelVersion: 'acceptance-reranker-v1',
			available: true,
			async rerank<T>(candidates: T[]): Promise<T[]> {
				return [...candidates].reverse();
			},
		},
	};
}

function nonEmpty(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

function finite(value: unknown): boolean {
	return typeof value === 'number' && Number.isFinite(value);
}

describe('issue #2490 AC10 — matched retrieval resource comparison', () => {
	test('compares profiles with metrics, caps, provenance, and degradation rows', async () => {
		const report = (await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['sqlite'],
			modes: ['manual'],
			profiles: ['lexical', 'hybrid', 'hybrid+rerank'],
			resourceCaps: { candidate_count: 8, token_budget: 256 },
			dependencies: makeDependencies(),
		} as unknown as Parameters<
			typeof evaluateMemoryRecallFixtures
		>[0])) as unknown as {
			runs: Array<Record<string, unknown>>;
		};
		const profiles = new Set(
			report.runs.map((run) => run.profile).filter((value) => value),
		);
		expect(profiles).toEqual(new Set(['lexical', 'hybrid', 'hybrid+rerank']));
		const caps = report.runs.map((run) => {
			const cap = run.resource_cap as Record<string, unknown> | undefined;
			expect(cap).toBeDefined();
			const candidates = cap?.candidate_count ?? cap?.candidates;
			const tokens = cap?.token_budget ?? cap?.tokens;
			expect(candidates).toBeGreaterThan(0);
			expect(tokens).toBeGreaterThan(0);
			return `${candidates}:${tokens}`;
		});
		expect(new Set(caps).size).toBe(1);
		for (const run of report.runs) {
			expect(['complete', 'degraded', 'skipped']).toContain(run.status);
			expect(nonEmpty(run.provenance)).toBe(true);
			const metrics = (run.metrics ?? {}) as Record<string, unknown>;
			const precision = run['precision@k'] ?? metrics['precision@k'];
			const recall = run['recall@k'] ?? metrics['recall@k'];
			const latency = run.latency_ms ?? metrics.latency_ms;
			const cost = run.cost as Record<string, unknown> | undefined;
			const costProvenance =
				run.cost_provenance ?? cost?.provenance ?? cost?.source;
			if (run.status === 'complete') {
				expect(finite(precision)).toBe(true);
				expect(finite(recall)).toBe(true);
				expect(finite(latency)).toBe(true);
				expect(nonEmpty(costProvenance)).toBe(true);
			} else {
				const reason = run.degradation_reason ?? run.reason;
				expect(nonEmpty(reason)).toBe(true);
			}
		}
	});
});

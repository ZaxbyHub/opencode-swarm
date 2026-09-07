/** Acceptance coverage for issue #2490 / AC7. */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import type { RecallEvaluationOptions } from '../../../src/memory/evaluation';
import { evaluateMemoryRecallFixtures } from '../../../src/memory/evaluation';

const fixtureDirectory = path.resolve(
	import.meta.dir,
	'../../fixtures/memory-recall',
);

type Counters = { embed: number; embedBatch: number; rerank: number };

function makeDependencies(): { counters: Counters; dependencies: unknown } {
	const counters: Counters = { embed: 0, embedBatch: 0, rerank: 0 };
	const embeddingProvider = {
		modelVersion: 'acceptance-embedding-v1',
		dimension: 4,
		available: true,
		embed: async (text: string) => {
			counters.embed++;
			return new Float32Array([
				text.length,
				text.includes('memory') ? 1 : 0,
				0,
				1,
			]);
		},
		embedBatch: async (texts: string[]) => {
			counters.embedBatch++;
			return Promise.all(texts.map((text) => embeddingProvider.embed(text)));
		},
	};
	const reranker = {
		modelVersion: 'acceptance-reranker-v1',
		available: true,
		async rerank<T extends { id: string }>(candidates: T[]): Promise<T[]> {
			counters.rerank++;
			return [...candidates].reverse();
		},
	};
	return { counters, dependencies: { embeddingProvider, reranker } };
}

async function runProfile(profile: string): Promise<{
	report: unknown;
	counters: Counters;
}> {
	const { counters, dependencies } = makeDependencies();
	const report = await evaluateMemoryRecallFixtures({
		fixtureDirectory,
		providers: ['sqlite'],
		modes: ['manual'],
		profiles: [profile],
		dependencies,
	} as unknown as RecallEvaluationOptions);
	return { report, counters };
}

function assertExplicitStatuses(
	report: unknown,
	expectedProfile: string,
): void {
	const runs = (report as { runs?: Array<Record<string, unknown>> }).runs ?? [];
	expect(runs.length).toBeGreaterThan(0);
	expect(new Set(runs.map((run) => run.profile))).toEqual(
		new Set([expectedProfile]),
	);
	for (const run of runs) {
		expect(['complete', 'degraded', 'skipped']).toContain(run.status);
		if (run.status === 'degraded' || run.status === 'skipped') {
			expect(typeof run.degradation_reason).toBe('string');
			expect((run.degradation_reason as string).trim()).not.toBe('');
		}
	}
}

describe('issue #2490 AC7 — evaluator retrieval profiles and injected providers', () => {
	test('runs lexical, hybrid, and hybrid+rerank without downloading models', async () => {
		const lexical = await runProfile('lexical');
		const hybrid = await runProfile('hybrid');
		const hybridRerank = await runProfile('hybrid+rerank');

		assertExplicitStatuses(lexical.report, 'lexical');
		assertExplicitStatuses(hybrid.report, 'hybrid');
		assertExplicitStatuses(hybridRerank.report, 'hybrid+rerank');

		// A report label alone is not evidence that the injected providers ran.
		expect(lexical.counters.embed + lexical.counters.embedBatch).toBe(0);
		expect(lexical.counters.rerank).toBe(0);
		expect(hybrid.counters.embed + hybrid.counters.embedBatch).toBeGreaterThan(
			0,
		);
		expect(hybrid.counters.rerank).toBe(0);
		expect(
			hybridRerank.counters.embed + hybridRerank.counters.embedBatch,
		).toBeGreaterThan(0);
		expect(hybridRerank.counters.rerank).toBeGreaterThan(0);
	});
});

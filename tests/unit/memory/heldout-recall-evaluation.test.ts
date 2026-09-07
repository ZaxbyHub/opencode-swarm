import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	evaluateMemoryRecallFixtures,
	validateRecallEvaluationManifest,
} from '../../../src/memory/evaluation';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const fixtureDirectory = path.resolve(
	import.meta.dir,
	'../../fixtures/memory-recall',
);

function ngramVector(text: string): Float32Array {
	const vector = new Float32Array(64);
	const normalized = `  ${text.toLowerCase()}  `;
	for (let index = 0; index < normalized.length - 2; index++) {
		const trigram = normalized.slice(index, index + 3);
		let hash = 0;
		for (const char of trigram) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
		vector[hash % vector.length] += 1;
	}
	return vector;
}

async function createCorpus(): Promise<string> {
	const root = canonicalMkdtemp('swarm-heldout-eval-');
	await fs.mkdir(path.join(root, 'sources'));
	const sources = [
		[
			'target.ts',
			'export function UserProfileDetails() { return accountMetadata; }',
		],
		['noise.ts', 'export function profileHandler() { return unrelatedValue; }'],
		['other.ts', 'export function deleteLegacyAccount() { return undefined; }'],
	] as const;
	for (const [file, content] of sources)
		await fs.writeFile(path.join(root, 'sources', file), content);
	const cases = sources.map(([file, content], index) => ({
		id: ['target', 'noise', 'other'][index],
		language: 'typescript',
		source_path: `sources/${file}`,
		content_hash: createHash('sha256').update(content).digest('hex'),
		expected_symbols: [
			index === 0
				? 'UserProfileDetails'
				: index === 1
					? 'profileHandler'
					: 'deleteLegacyAccount',
		],
		expected_edges: ['source -> target'],
		known_misses: ['legacy'],
		spurious_edges: ['source -> noise'],
		paraphrase:
			index === 0
				? 'find user profile details account metadata'
				: index === 1
					? 'profile handling flow'
					: 'remove legacy account',
		analyzer_id: 'backend:typescript:v1',
	}));
	await fs.writeFile(
		path.join(root, 'manifest.json'),
		JSON.stringify({
			corpus_id: 'shared-candidate-test',
			split: 'heldout',
			version: '1.0.0',
			thresholds: { precision_at_k: 0.1 },
			cases,
		}),
	);
	return root;
}

const dependencies = {
	embeddingProvider: {
		modelVersion: 'hashed-char-ngram-v1:64',
		dimension: 64,
		available: true,
		embed: async (text: string) => ngramVector(text),
		embedBatch: async (texts: string[]) => texts.map(ngramVector),
	},
	reranker: {
		modelVersion: 'identity-reranker',
		available: true,
		rerank: async <T>(candidates: T[]) => candidates,
	},
};

describe('held-out retrieval evaluation', () => {
	test('ranks paraphrases against a shared corpus with meaningful profile deltas', async () => {
		const heldoutCorpusDirectory = await createCorpus();
		try {
			const report = await evaluateMemoryRecallFixtures({
				fixtureDirectory,
				heldoutCorpusDirectory,
				providers: ['sqlite'],
				modes: ['manual'],
				profiles: ['lexical', 'hybrid', 'hybrid+rerank'],
				dependencies,
				resourceCaps: { candidate_count: 8, token_budget: 256 },
			});
			expect(() =>
				validateRecallEvaluationManifest(report.manifest),
			).not.toThrow();
			expect(() =>
				validateRecallEvaluationManifest({
					...report.manifest,
					variants: {
						lexical: {
							...report.manifest.variants?.lexical,
							config_hash: '',
						},
					},
				}),
			).toThrow('invalid variant identity');
			expect(report.runs).toHaveLength(9);
			expect(report.comparisons).toHaveLength(6);
			expect(
				report.runs.some(
					(run) => run.profile === 'lexical' && run.metrics['recall@k'] < 1,
				),
			).toBe(true);
			expect(
				report.comparisons.some(
					(comparison) => comparison.recall_at_k_delta > 0,
				),
			).toBe(true);
			for (const run of report.runs) {
				expect(run.resource_usage?.lexical_candidate_count).toBe(3);
				expect(run.scenario?.source_provenance).toBe('direct-source');
				expect(run.scenario?.index_state).toBe('not-measured');
				expect(run.identity?.config_hash).toMatch(/^[a-f0-9]{64}$/);
			}
		} finally {
			await fs.rm(heldoutCorpusDirectory, { recursive: true, force: true });
		}
	});
});

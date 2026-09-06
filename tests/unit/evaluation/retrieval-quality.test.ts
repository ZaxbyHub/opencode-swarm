import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { evaluateHeldoutGraphRetrievalQuality } from '../../../src/evaluation/retrieval-quality';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function makeCorpus(): Promise<string> {
	const root = canonicalMkdtemp('retrieval-quality-test-');
	roots.push(root);
	const source = [
		'export function actualProfile() {',
		'  return helper();',
		'}',
		'function helper() { return "ok"; }',
	].join('\n');
	await fs.mkdir(path.join(root, 'sources'), { recursive: true });
	await fs.writeFile(path.join(root, 'sources', 'fixture.js'), source, 'utf8');
	const hash = createHash('sha256').update(source).digest('hex');
	await fs.writeFile(
		path.join(root, 'manifest.json'),
		JSON.stringify({
			corpus_id: 'retrieval-quality-test-v1',
			split: 'heldout',
			version: '1.0.0',
			thresholds: { symbol_recall: 0.25 },
			cases: [
				{
					id: 'synthetic-js',
					language: 'javascript',
					source_path: 'sources/fixture.js',
					content_hash: hash.toUpperCase(),
					expected_symbols: ['inventedSymbol'],
					expected_edges: ['inventedSymbol -> helper'],
					known_misses: ['legacyProfile'],
					spurious_edges: ['actualProfile -> deleteProfile'],
					paraphrase: 'retrieve the profile helper',
					analyzer_id: 'backend:javascript:v1',
				},
			],
		}),
		'utf8',
	);
	return root;
}

describe('evaluateHeldoutGraphRetrievalQuality', () => {
	test('measures parser facts rather than echoing held-out expectations', async () => {
		const report = await evaluateHeldoutGraphRetrievalQuality({
			corpusDirectory: await makeCorpus(),
		});

		expect(report.schema_version).toBe(1);
		expect(report.corpus.split).toBe('heldout');
		expect(report.uncertainty.sample_count).toBe(1);
		const result = report.cases[0]!;
		// The manifest intentionally names a symbol that the supplied source does
		// not define. A decorative evaluator that copies expectations will fail
		// this assertion, while the production extractor reports its actual facts.
		expect(result.symbols.expected).toEqual(['inventedSymbol']);
		expect(result.symbols.observed).toContain('actualProfile');
		expect(result.symbols.observed).not.toContain('inventedSymbol');
		expect(result.symbols.recall).toBe(0);
		expect(result.symbols.false_negative).toEqual(['inventedSymbol']);
		expect(result.symbols.false_positive).toContain('actualProfile');
		expect(result.edges.observed).toContain('actualProfile -> helper');
		expect(result.edges.observed).not.toContain('inventedSymbol -> helper');
		expect(result.edges.false_negative).toEqual(['inventedSymbol -> helper']);
		expect(result.edges.false_positive).toContain('actualProfile -> helper');
		// Corpus declarations are annotations only: they cannot become measured
		// misses or spurious edges unless they overlap the extractor's real delta.
		expect(result.known_misses.declared).toEqual(['legacyProfile']);
		expect(result.known_misses.matching_measured_false_negatives).toEqual([]);
		expect(result.spurious_edges.matching_measured_false_positives).toEqual([]);
		expect(report.summary.symbols.false_negative_count).toBe(1);
		expect(report.summary.symbols.false_positive_count).toBeGreaterThan(0);
		expect(report.summary.edges.false_negative_count).toBe(1);
		expect(report.summary.edges.false_positive_count).toBeGreaterThan(0);
		expect(result.paraphrase.direct_source.provenance).toBe(
			'direct-source-fallback',
		);
		// The source path has no lexical overlap with this paraphrase. This proves
		// the direct fallback ranks the paraphrase itself, not the file hint that
		// indexed graph routing intentionally needs.
		expect(result.paraphrase.direct_source.positive_hit).toBe(true);
		expect(result.paraphrase.direct_source.status).toBe('complete');
		expect(result.paraphrase.direct_source.actions).toContain('lexical_search');
		if (report.resource_usage.indexed_storage_available) {
			expect(result.paraphrase.indexed_control.status).toBe('complete');
			expect(result.paraphrase.indexed_control.provenance).toBe(
				'fresh-indexed-subgraph',
			);
		} else {
			expect(result.paraphrase.indexed_control.status).toBe('skipped');
			expect(result.paraphrase.indexed_control.provenance).toBe('unavailable');
			expect(result.paraphrase.indexed_control.degradation_reason).toBeTruthy();
		}
	});

	test('corpus identity changes when evaluation semantics change', async () => {
		const corpusDirectory = await makeCorpus();
		const baseline = await evaluateHeldoutGraphRetrievalQuality({
			corpusDirectory,
		});
		const manifestPath = path.join(corpusDirectory, 'manifest.json');
		const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
			cases: Array<{ paraphrase: string; expected_symbols: string[] }>;
		};
		manifest.cases[0]!.paraphrase = 'a semantically distinct retrieval task';
		manifest.cases[0]!.expected_symbols = ['anotherExpectedSymbol'];
		await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
		const changed = await evaluateHeldoutGraphRetrievalQuality({
			corpusDirectory,
		});

		expect(changed.corpus.hash).not.toBe(baseline.corpus.hash);
	});
});

import * as path from 'node:path';
import {
	evaluateHeldoutGraphRetrievalQuality,
	type HeldoutGraphQualityReport,
} from '../src/evaluation';
import { languageDefinitions } from '../src/lang/registry';
import { LANGUAGE_REGISTRY } from '../src/lang/profiles';
import {
	evaluateMemoryRecallFixtures,
	validateRecallEvaluationManifest,
	type RecallEvaluationReport,
} from '../src/memory/evaluation';
import {
	loadHeldoutRecallEvaluationCorpus,
	type MemoryRecord,
	type MemoryReranker,
	type SQLiteRetrievalDependencies,
} from '../src/memory';
import type { RerankCandidate } from '../src/memory/embeddings/reranker';
import type { RecallRequest } from '../src/memory/types';

const ROOT = path.resolve(import.meta.dir, '..');
const CORPUS_ROOT = path.join(
	ROOT,
	'tests',
	'fixtures',
	'memory-recall-heldout',
);
const EVALUATION_FIXTURES = path.join(
	ROOT,
	'tests',
	'fixtures',
	'memory-recall',
);
const PROFILES = ['lexical', 'hybrid', 'hybrid+rerank'] as const;
const QUALITY_CANDIDATE_COUNT = 20;
const QUALITY_TOKEN_BUDGET = 256;

type HeldoutCase = {
	id: string;
	language: string;
	source_path: string;
	content_hash: string;
	expected_symbols: string[];
	expected_edges: Array<string | { from: string; to: string }>;
	known_misses: string[];
	spurious_edges: Array<string | { from: string; to: string }>;
	paraphrase: string;
	analyzer_id: string;
};

type HeldoutManifest = {
	corpus_id: string;
	split: string;
	version: string;
	supported_languages: string[];
	analyzer_extensions: Array<{ language: string; extractor_id: string }>;
	os_gates: Record<string, unknown>;
	thresholds: Record<string, number>;
	cases: HeldoutCase[];
};

function fail(message: string): never {
	throw new Error(`retrieval-quality: ${message}`);
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim() === '') fail(`${label} is empty`);
}

function assertCaseList(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
		fail(`${label} must be a non-empty string list`);
	}
}

function assertEdgeList(value: unknown, label: string): void {
	if (!Array.isArray(value) || value.length === 0) fail(`${label} must be non-empty`);
	for (const edge of value) {
		if (typeof edge === 'string') {
			if (!/\S+\s*(?:->|=>|::)\s*\S+/.test(edge)) fail(`${label} contains an invalid edge`);
			continue;
		}
		if (!edge || typeof edge !== 'object') fail(`${label} contains an invalid edge`);
		const candidate = edge as Record<string, unknown>;
		assertNonEmpty(candidate.from ?? candidate.source, `${label}.from`);
		assertNonEmpty(candidate.to ?? candidate.target, `${label}.to`);
	}
}

function isContained(candidate: string, root: string): boolean {
	const child = path.resolve(candidate);
	const parent = path.resolve(root);
	return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function loadHeldoutManifest(): Promise<HeldoutManifest> {
	const manifest = await loadHeldoutRecallEvaluationCorpus(CORPUS_ROOT) as HeldoutManifest;
	assertNonEmpty(manifest.corpus_id, 'corpus_id');
	if (manifest.split !== 'heldout') fail('manifest split must be heldout');
	assertNonEmpty(manifest.version, 'manifest version');
	if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) fail('manifest cases are empty');
	const authoritative = languageDefinitions.map((definition) => definition.id).sort();
	if (JSON.stringify([...manifest.supported_languages].sort()) !== JSON.stringify(authoritative)) {
		fail('manifest languages do not match the authoritative language registry');
	}
	const dispatch = LANGUAGE_REGISTRY.getAll().filter((profile) => !profile.parserOnly).map((profile) => profile.id).sort();
	const analyzerLanguages = manifest.analyzer_extensions.map((entry) => entry.language).sort();
	if (JSON.stringify(analyzerLanguages) !== JSON.stringify(dispatch)) fail('analyzer extension languages do not match dispatch registry');
	for (const platform of ['linux', 'macos', 'windows']) {
		const gate = manifest.os_gates?.[platform];
		if (!gate || typeof gate !== 'object' || !Object.values(gate as Record<string, unknown>).some((value) => typeof value === 'string' && value.trim())) {
			fail(`missing runnable ${platform} gate`);
		}
	}
	for (const [key, value] of Object.entries(manifest.thresholds ?? {})) {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`invalid threshold ${key}`);
	}
	if (typeof manifest.thresholds.direct_source_positive_hits !== 'number')
		fail('manifest is missing direct_source_positive_hits threshold');
	for (const entry of manifest.cases) {
		assertNonEmpty(entry.id, 'case id');
		assertNonEmpty(entry.language, `${entry.id}.language`);
		assertNonEmpty(entry.source_path, `${entry.id}.source_path`);
		if (!/^[a-f0-9]{64}$/i.test(entry.content_hash)) fail(`${entry.id}.content_hash is not SHA-256`);
		assertCaseList(entry.expected_symbols, `${entry.id}.expected_symbols`);
		assertEdgeList(entry.expected_edges, `${entry.id}.expected_edges`);
		assertCaseList(entry.known_misses, `${entry.id}.known_misses`);
		assertEdgeList(entry.spurious_edges, `${entry.id}.spurious_edges`);
		assertNonEmpty(entry.paraphrase, `${entry.id}.paraphrase`);
		assertNonEmpty(entry.analyzer_id, `${entry.id}.analyzer_id`);
		const source = path.resolve(CORPUS_ROOT, entry.source_path);
		if (!isContained(source, CORPUS_ROOT)) fail(`${entry.id}.source_path escapes corpus root`);
	}
	return manifest;
}

function canonicalize(value: unknown, key?: string): unknown {
	if (
		key === 'generated_at' ||
		key === 'latency_ms' ||
		key === 'latency_ms_delta' ||
		key === 'fixture_directory'
	)
		return undefined;
	if (Array.isArray(value)) return value.map((item) => canonicalize(item)).filter((item) => item !== undefined);
	if (value && typeof value === 'object') {
		const result: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			const normalized = canonicalize(entryValue, entryKey);
			if (normalized !== undefined) result[entryKey] = normalized;
		}
		return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
	}
	return value;
}

const EMBEDDING_DIMENSION = 64;

function deterministicEmbedding(text: string): Float32Array {
	const vector = new Float32Array(EMBEDDING_DIMENSION);
	const normalized = text.toLowerCase().replace(/\s+/g, ' ');
	for (const width of [2, 3, 4]) {
		for (let start = 0; start + width <= normalized.length; start++) {
			let hash = 2166136261;
			for (let index = start; index < start + width; index++) {
				hash ^= normalized.charCodeAt(index);
				hash = Math.imul(hash, 16777619) >>> 0;
			}
			vector[hash % EMBEDDING_DIMENSION] += width === 4 ? 0.5 : 1;
		}
	}
	const norm = Math.hypot(...vector);
	if (norm === 0) return vector;
	for (let index = 0; index < vector.length; index++) vector[index] /= norm;
	return vector;
}

function createDeterministicDependencies(): SQLiteRetrievalDependencies {
	const embeddingProvider = {
		modelVersion: 'retrieval-quality-embedding-v1',
		dimension: EMBEDDING_DIMENSION,
		available: true,
		embed: async (text: string) => deterministicEmbedding(text),
		embedBatch: async (texts: string[]) => texts.map(deterministicEmbedding),
	};
	const denseSelector = async (
		_request: RecallRequest,
		queryEmbedding: Float32Array,
		records: readonly MemoryRecord[],
	): Promise<MemoryRecord[]> =>
		[...records]
			.map((record) => ({
				record,
				score: cosineSimilarity(queryEmbedding, deterministicEmbedding(record.text)),
			}))
			.sort(
				(left, right) =>
					right.score - left.score || left.record.id.localeCompare(right.record.id),
			)
			.map(({ record }) => record);
	const reranker: MemoryReranker = {
		available: true,
		modelVersion: 'retrieval-quality-reranker-v1',
		rerank: async <T extends RerankCandidate>(candidates: T[], query?: string) => {
			// The injected reranker is intentionally conservative: it proves the
			// production reranker hook is invoked without replacing the dense
			// ranking with a label-aware oracle. Keeping the received order makes
			// hybrid+rerank a matched-resource non-regression control.
			void query;
			return [...candidates];
		},
	};
	return {
		embeddingProvider,
		denseSelector,
		reranker,
		now: () => 0,
	};
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		dot += left[index] * right[index];
		leftNorm += left[index] * left[index];
		rightNorm += right[index] * right[index];
	}
	return leftNorm === 0 || rightNorm === 0
		? 0
		: dot / Math.sqrt(leftNorm * rightNorm);
}

function enforceManifestThresholds(
	manifest: HeldoutManifest,
	report: RecallEvaluationReport,
): void {
	const precisionThreshold = manifest.thresholds.precision_at_k;
	const recallThreshold = manifest.thresholds.recall_at_k;
	const maxKnownMisses = manifest.thresholds.max_known_misses;
	const maxSpuriousEdges = manifest.thresholds.max_spurious_edges;
	if (
		typeof precisionThreshold !== 'number' ||
		report.summary['precision@k'] < precisionThreshold
	)
		fail(
			`precision@k ${report.summary['precision@k'].toFixed(3)} is below manifest threshold ${precisionThreshold}`,
		);
	if (
		typeof recallThreshold !== 'number' ||
		report.summary['recall@k'] < recallThreshold
	)
		fail(
			`recall@k ${report.summary['recall@k'].toFixed(3)} is below manifest threshold ${recallThreshold}`,
		);
	if (typeof maxKnownMisses !== 'number' || typeof maxSpuriousEdges !== 'number')
		fail('manifest is missing graph measurement thresholds');
	for (const entry of manifest.cases) {
		if (
			entry.known_misses.length > maxKnownMisses ||
			entry.spurious_edges.length > maxSpuriousEdges
		)
			fail(`case ${entry.id} exceeds manifest graph measurement thresholds`);
	}
}

function enforceProfileComparisons(
	manifest: HeldoutManifest,
	report: RecallEvaluationReport,
): void {
	const expectedComparisonCount = manifest.cases.length * (PROFILES.length - 1);
	if (report.comparisons.length !== expectedComparisonCount)
		fail(
			`expected ${expectedComparisonCount} lexical-to-profile comparisons, got ${report.comparisons.length}`,
		);
	const expectedFixtures = new Map(
		manifest.cases.map((entry) => [`heldout:${entry.id}`, entry]),
	);
	for (const comparison of report.comparisons) {
		if (
			comparison.baseline_profile !== 'lexical' ||
			!PROFILES.includes(comparison.variant_profile)
		)
			fail('comparison has an unsupported profile pairing');
		if (!Number.isFinite(comparison.precision_at_k_delta) || !Number.isFinite(comparison.recall_at_k_delta))
			fail('comparison has a non-finite paraphrase delta');
		if (!expectedFixtures.has(comparison.fixture))
			fail(`comparison references an unknown held-out fixture: ${comparison.fixture}`);
	}
	const hybridDeltas = report.comparisons.filter(
		(comparison) => comparison.variant_profile === 'hybrid',
	);
	if (!hybridDeltas.some((comparison) => comparison.recall_at_k_delta > 0))
		fail('held-out paraphrase evaluation found no positive hybrid recall delta');
	const averageRecall = (profile: (typeof PROFILES)[number]): number => {
		const runs = report.runs.filter((run) => run.profile === profile);
		return runs.reduce((total, run) => total + run.metrics['recall@k'], 0) /
			Math.max(runs.length, 1);
	};
	if (averageRecall('hybrid') < averageRecall('lexical'))
		fail('hybrid aggregate recall regressed against the lexical baseline');
	const runKeys = new Map<string, Set<string>>();
	for (const run of report.runs) {
		const expected = expectedFixtures.get(run.fixture);
		if (!expected) fail(`evaluation returned an unknown held-out fixture: ${run.fixture}`);
		if (run.query !== expected.paraphrase)
			fail(`evaluation did not use the held-out paraphrase for ${expected.id}`);
		if (!run.identity) fail(`evaluation row ${run.fixture} has no exact identity`);
		if (run.scenario?.index_state !== 'not-measured' || run.scenario.graph_measurement.status !== 'unmeasured')
			fail(`evaluation row ${run.fixture} made an unsupported graph measurement claim`);
		const key = `${run.fixture}\u0000${run.provider}\u0000${run.mode}`;
		const profiles = runKeys.get(key) ?? new Set<string>();
		if (run.profile) profiles.add(run.profile);
		runKeys.set(key, profiles);
	}
	for (const [key, profiles] of runKeys) {
		for (const profile of PROFILES) {
			if (!profiles.has(profile)) fail(`matched-resource profile set incomplete for ${key}`);
		}
	}
}

function enforceGraphReport(
	manifest: HeldoutManifest,
	report: HeldoutGraphQualityReport,
): void {
	if (report.schema_version !== 1 || report.corpus.split !== 'heldout')
		fail('graph report has an unsupported schema or split');
	if (report.corpus.id !== manifest.corpus_id)
		fail('graph report corpus identity does not match the held-out manifest');
	if (report.cases.length !== manifest.cases.length)
		fail('graph report case count does not match the held-out manifest');
	const expectedIds = new Set(manifest.cases.map((entry) => entry.id));
	for (const entry of report.cases) {
		if (!expectedIds.has(entry.id))
			fail(`graph report contains an unknown case: ${entry.id}`);
		if (entry.source.provenance !== 'direct-source')
			fail(`graph case ${entry.id} lacks direct-source provenance`);
		const direct = entry.paraphrase.direct_source;
		const indexed = entry.paraphrase.indexed_control;
		if (
			direct.provenance !== 'direct-source-fallback' ||
			(indexed.provenance !== 'fresh-indexed-subgraph' &&
				indexed.provenance !== 'unavailable')
		)
			fail(`graph case ${entry.id} has invalid paraphrase route provenance`);
		for (const [label, route] of [
			['direct-source', direct],
			['indexed-control', indexed],
		] as const) {
			if (typeof route.positive_hit !== 'boolean')
				fail(`graph case ${entry.id} ${label} route has no honest positive-hit field`);
			if ((route.status === 'complete') !== route.positive_hit)
				fail(`graph case ${entry.id} ${label} route status contradicts positive_hit`);
			if (route.positive_hit && route.matched_resource_count < 1)
				fail(`graph case ${entry.id} ${label} positive hit has no matched resource`);
			if (!route.positive_hit && !route.degradation_reason)
				fail(`graph case ${entry.id} ${label} miss has no degradation reason`);
		}
		if (
			!Number.isFinite(entry.symbols.precision) ||
			!Number.isFinite(entry.symbols.recall) ||
			!Number.isFinite(entry.edges.precision) ||
			!Number.isFinite(entry.edges.recall)
		)
			fail(`graph case ${entry.id} has non-finite exact measurements`);
	}
	if (report.resource_usage.case_count !== manifest.cases.length)
		fail('graph resource usage case count does not match the corpus');
	if (
		report.summary.direct_source_fallback_positive_hit_count <
		manifest.thresholds.direct_source_positive_hits
	)
		fail(
			`graph direct-source fallback positive hits ${report.summary.direct_source_fallback_positive_hit_count} are below manifest threshold ${manifest.thresholds.direct_source_positive_hits}`,
		);
	if (
		report.summary.direct_source_fallback_complete_count !==
		report.summary.direct_source_fallback_positive_hit_count
	)
		fail('graph direct-source completion count does not match honest positive-hit count');
	if (
		report.resource_usage.indexed_storage_available &&
		report.summary.fresh_indexed_control_complete_count < 1
	)
		fail('graph indexed control was available but produced no complete cases');
	for (const measurement of [report.summary.symbols, report.summary.edges]) {
		if (
			measurement.precision < manifest.thresholds.precision_at_k ||
			measurement.recall < manifest.thresholds.recall_at_k
		)
			fail('graph aggregate exact measurements are below manifest thresholds');
	}
}

function summarizeMemoryResourceUsage(report: RecallEvaluationReport) {
	return PROFILES.map((profile) => {
		const runs = report.runs.filter((run) => run.profile === profile);
		const usage = runs.map((run) => run.resource_usage!);
		const maximum = (field: keyof (typeof usage)[number]): number =>
			Math.max(...usage.map((item) => item[field]));
		return {
			profile,
			run_count: runs.length,
			resource_cap: {
				candidate_count: QUALITY_CANDIDATE_COUNT,
				token_budget: QUALITY_TOKEN_BUDGET,
			},
			max_lexical_candidates: maximum('lexical_candidate_count'),
			max_dense_candidates: maximum('dense_candidate_count'),
			max_rerank_candidates: maximum('rerank_candidate_count'),
			max_returned_count: maximum('returned_count'),
			max_returned_token_estimate: maximum('returned_token_estimate'),
		};
	});
}

async function evaluate(): Promise<{
	report: RecallEvaluationReport;
	graph: HeldoutGraphQualityReport;
	manifest: HeldoutManifest;
}> {
	const manifest = await loadHeldoutManifest();
	const dependencies = createDeterministicDependencies();
	const options = {
		fixtureDirectory: EVALUATION_FIXTURES,
		providers: ['sqlite'] as const,
		modes: ['manual'] as const,
		profiles: [...PROFILES],
		resourceCaps: {
			candidate_count: QUALITY_CANDIDATE_COUNT,
			token_budget: QUALITY_TOKEN_BUDGET,
		},
		heldoutCorpusDirectory: CORPUS_ROOT,
		dependencies,
	};
	const first = await evaluateMemoryRecallFixtures(options);
	const second = await evaluateMemoryRecallFixtures(options);
	const graphOptions = {
		corpusDirectory: CORPUS_ROOT,
		resourceCaps: {
			max_files: 64,
			walk_budget_ms: 1_000,
			max_tokens: 512,
			top_n: 5,
		},
	};
	const graph = await evaluateHeldoutGraphRetrievalQuality(graphOptions);
	const graphSecond = await evaluateHeldoutGraphRetrievalQuality(graphOptions);
	validateRecallEvaluationManifest(first.manifest);
	validateRecallEvaluationManifest(second.manifest);
	const firstCanonical = JSON.stringify(canonicalize(first));
	const secondCanonical = JSON.stringify(canonicalize(second));
	if (firstCanonical !== secondCanonical) fail('two evaluator runs are not canonical-deterministic');
	const firstGraphCanonical = JSON.stringify(canonicalize(graph));
	const secondGraphCanonical = JSON.stringify(canonicalize(graphSecond));
	if (firstGraphCanonical !== secondGraphCanonical)
		fail('two graph evaluator runs are not canonical-deterministic');
	enforceManifestThresholds(manifest, first);
	enforceProfileComparisons(manifest, first);
	enforceGraphReport(manifest, graph);
	for (const run of first.runs) {
		if (!run.profile || !PROFILES.includes(run.profile)) fail('evaluation omitted a requested profile');
		if (!run.resource_cap || run.resource_cap.candidate_count !== QUALITY_CANDIDATE_COUNT || run.resource_cap.token_budget !== QUALITY_TOKEN_BUDGET) fail('resource caps drifted across profile rows');
		const usage = run.resource_usage;
		if (!usage) fail(`evaluation row ${run.fixture} has no resource usage`);
		for (const [name, value] of Object.entries(usage)) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
				fail(`evaluation row ${run.fixture} has invalid ${name} resource usage`);
		}
		if (
			usage.lexical_candidate_count > QUALITY_CANDIDATE_COUNT ||
			usage.dense_candidate_count > QUALITY_CANDIDATE_COUNT ||
			usage.rerank_candidate_count > QUALITY_CANDIDATE_COUNT
		)
			fail(`evaluation row ${run.fixture} exceeded the matched candidate cap`);
		if (usage.returned_token_estimate > QUALITY_TOKEN_BUDGET)
			fail(`evaluation row ${run.fixture} exceeded the returned token budget`);
		if (!run.provenance?.trim()) fail('evaluation row has no provenance');
		if (run.status !== 'complete' && !run.degradation_reason?.trim()) fail('degraded/skipped row has no reason');
		if (run.profile !== 'lexical') {
			if (run.status !== 'complete' || run.provenance !== 'injected-dense')
				fail(`${run.profile} did not execute the deterministic injected dense path`);
			if (usage.dense_candidate_count < 1)
				fail(`${run.profile} reported no dense candidates`);
		}
		if (run.profile === 'hybrid+rerank' && usage.rerank_candidate_count < 1)
			fail('hybrid+rerank did not execute a rerank candidate set');
	}
	return { report: first, graph, manifest };
}

if (import.meta.main) {
	evaluate()
		.then(({ report, graph, manifest }) => {
			console.log(JSON.stringify({
				ok: true,
				corpus_id: manifest.corpus_id,
				case_count: manifest.cases.length,
				profiles: PROFILES,
				runs: report.runs.length,
				summary: report.summary,
				memory_resource_usage: summarizeMemoryResourceUsage(report),
				thresholds: manifest.thresholds,
				comparisons: report.comparisons,
				graph,
				graph_direct_hit_contract: {
					required_positive_hits: manifest.thresholds.direct_source_positive_hits,
					observed_positive_hits:
						graph.summary.direct_source_fallback_positive_hit_count,
					case_count: graph.cases.length,
				},
				canonical: true,
			}, null, 2));
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}

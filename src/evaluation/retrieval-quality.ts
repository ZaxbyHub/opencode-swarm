import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractFileSymbols, type FileSymbolFacts } from '../lang/symbol-graph';
import {
	type LoadedHeldoutRecallScenario,
	loadHeldoutRecallEvaluationScenarios,
} from '../memory/heldout-evaluation-corpus';
import { buildWorkspaceGraphAsync } from '../tools/repo-graph/builder';
import {
	closeRepoMemory,
	isIndexedStorageAvailable,
	loadSubgraphForFiles,
	queryNodeByFile,
} from '../tools/repo-graph/indexed-storage';
import {
	type RetrievalResult,
	routeRetrieval,
} from '../tools/repo-graph/retrieval-router';
import { saveGraph } from '../tools/repo-graph/storage';
import type { RepoGraph } from '../tools/repo-graph/types';

const DEFAULT_RESOURCE_CAPS = {
	max_files: 64,
	walk_budget_ms: 1_000,
	max_tokens: 512,
	top_n: 5,
} as const;

export interface RetrievalQualityResourceCaps {
	max_files: number;
	walk_budget_ms: number;
	max_tokens: number;
	top_n: number;
}

export interface RetrievalQualityOptions {
	corpusDirectory: string;
	resourceCaps?: Partial<RetrievalQualityResourceCaps>;
	/** Test-only diagnostic escape hatch. Production callers must clean up. */
	keepTempRoot?: boolean;
}

export type RetrievalQualityStatus = 'complete' | 'degraded' | 'skipped';

export interface ExactMeasurement {
	expected: string[];
	observed: string[];
	true_positive_count: number;
	false_negative: string[];
	false_positive: string[];
	precision: number;
	recall: number;
}

export interface RetrievalRouteMeasurement {
	status: RetrievalQualityStatus;
	provenance:
		| 'direct-source-fallback'
		| 'fresh-indexed-subgraph'
		| 'unavailable';
	degradation_reason?: string;
	graph_hit: boolean;
	positive_hit: boolean;
	fallback_reason: string | null;
	actions: string[];
	matched_resource_count: number;
}

export interface HeldoutGraphQualityCase {
	id: string;
	language: string;
	analyzer: {
		declared_id: string | null;
		implementation: 'extractFileSymbols';
	};
	source: {
		hash: string;
		provenance: 'direct-source';
	};
	status: RetrievalQualityStatus;
	degradation_reason?: string;
	symbols: ExactMeasurement;
	edges: ExactMeasurement;
	known_misses: {
		declared: string[];
		matching_measured_false_negatives: string[];
	};
	spurious_edges: {
		declared: string[];
		matching_measured_false_positives: string[];
	};
	paraphrase: {
		query: string;
		direct_source: RetrievalRouteMeasurement;
		indexed_control: RetrievalRouteMeasurement;
	};
	latency_ms: number;
}

export interface HeldoutGraphQualityReport {
	schema_version: 1;
	corpus: {
		id: string;
		version: string | null;
		hash: string;
		split: 'heldout';
	};
	generated_at: string;
	status: RetrievalQualityStatus;
	degradation_reasons: string[];
	resource_caps: RetrievalQualityResourceCaps;
	resource_usage: {
		case_count: number;
		graph_node_count: number;
		graph_edge_count: number;
		indexed_storage_available: boolean;
	};
	summary: {
		symbols: AggregateExactMeasurement;
		edges: AggregateExactMeasurement;
		complete_case_count: number;
		direct_source_fallback_complete_count: number;
		direct_source_fallback_positive_hit_count: number;
		fresh_indexed_control_complete_count: number;
	};
	thresholds: Record<string, number>;
	uncertainty: {
		method: 'deterministic-heldout-corpus';
		confidence: 0.95;
		sample_count: number;
	};
	cases: HeldoutGraphQualityCase[];
}

export interface AggregateExactMeasurement {
	expected_count: number;
	observed_count: number;
	true_positive_count: number;
	false_negative_count: number;
	false_positive_count: number;
	precision: number;
	recall: number;
}

/**
 * Measure the repository graph and retrieval router against the immutable
 * multilingual held-out corpus. This intentionally owns a disposable project
 * root: graph persistence remains under that root's `.swarm/`, never beside a
 * source fixture or a caller workspace.
 */
export async function evaluateHeldoutGraphRetrievalQuality(
	options: RetrievalQualityOptions,
): Promise<HeldoutGraphQualityReport> {
	const loaded = await loadHeldoutRecallEvaluationScenarios(
		options.corpusDirectory,
	);
	const caps = normalizeCaps(options.resourceCaps);
	const tempRoot = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-retrieval-quality-')),
	);
	let graph: RepoGraph | null = null;
	let indexedAvailable = false;
	let indexedWorkspace: string | null = null;
	let indexedReason: string | undefined;
	try {
		await materializeDisposableWorkspace(tempRoot, loaded.scenarios);
		graph = await buildWorkspaceGraphAsync(tempRoot, {
			maxFiles: caps.max_files,
			walkBudgetMs: caps.walk_budget_ms,
		});
		indexedAvailable = isIndexedStorageAvailable();
		if (indexedAvailable) {
			try {
				await saveGraph(tempRoot, graph);
				// Parser-only corpus entries may honestly have no graph node. The
				// index is fresh after saveGraph; node/subgraph availability is checked
				// per case so one parser limitation cannot skip every control.
				indexedWorkspace = tempRoot;
			} catch (error) {
				indexedReason = `indexed control failed: ${describeError(error)}`;
				indexedWorkspace = null;
			}
		} else {
			indexedReason = 'SQLite indexed storage is unavailable in this runtime';
		}

		const cases = await Promise.all(
			loaded.scenarios.map((scenario) =>
				measureScenario(
					scenario,
					graph!,
					indexedWorkspace,
					indexedReason,
					caps,
				),
			),
		);
		const degradationReasons = unique(
			cases.flatMap((item) =>
				[
					item.degradation_reason,
					item.paraphrase.indexed_control.degradation_reason,
				].filter((reason): reason is string => Boolean(reason)),
			),
		);
		return {
			schema_version: 1,
			corpus: {
				id: loaded.manifest.corpus_id,
				version: loaded.manifest.version ?? null,
				hash: hashCorpus(loaded.manifest, loaded.scenarios),
				split: 'heldout',
			},
			generated_at: new Date().toISOString(),
			status:
				degradationReasons.length === 0
					? 'complete'
					: cases.some((item) => item.status === 'complete')
						? 'degraded'
						: 'skipped',
			degradation_reasons: degradationReasons,
			resource_caps: caps,
			resource_usage: {
				case_count: cases.length,
				graph_node_count: graph.metadata.nodeCount,
				graph_edge_count: graph.metadata.edgeCount,
				indexed_storage_available: indexedAvailable,
			},
			summary: summarizeCases(cases),
			thresholds: loaded.manifest.thresholds ?? {},
			uncertainty: {
				method: 'deterministic-heldout-corpus',
				confidence: 0.95,
				sample_count: cases.length,
			},
			cases,
		};
	} finally {
		closeRepoMemory(tempRoot);
		if (!options.keepTempRoot)
			await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

async function measureScenario(
	scenario: LoadedHeldoutRecallScenario,
	graph: RepoGraph,
	indexedWorkspace: string | null,
	indexedReason: string | undefined,
	caps: RetrievalQualityResourceCaps,
): Promise<HeldoutGraphQualityCase> {
	const started = Date.now();
	const facts = await extractFileSymbols(
		scenario.language,
		scenario.source_text,
	);
	const observedSymbols = facts
		? unique(facts.defs.map((definition) => definition.name))
		: [];
	const observedEdges = facts ? observedFactEdges(facts) : [];
	const symbols = compareExact(scenario.expected_symbols, observedSymbols);
	const expectedEdges = scenario.expected_edges.map(normalizeEdge);
	const edges = compareExact(expectedEdges, observedEdges);
	const directSource = await routeScenario(
		graph,
		scenario,
		caps,
		'direct-source-fallback',
	);
	const indexedControl = await measureIndexedControl(
		indexedWorkspace,
		scenario,
		caps,
		indexedReason,
	);
	const parserReason = facts
		? undefined
		: 'extractFileSymbols returned no facts (parser unavailable, timed out, or rejected source)';
	return {
		id: scenario.id,
		language: scenario.language,
		analyzer: {
			declared_id: scenario.analyzer_id ?? null,
			implementation: 'extractFileSymbols',
		},
		source: {
			hash: scenario.source_hash,
			provenance: scenario.source_provenance,
		},
		status: facts ? 'complete' : 'degraded',
		...(parserReason ? { degradation_reason: parserReason } : {}),
		symbols,
		edges,
		known_misses: {
			declared: [...scenario.known_misses],
			matching_measured_false_negatives: scenario.known_misses.filter(
				(symbol) => symbols.false_negative.includes(symbol),
			),
		},
		spurious_edges: {
			declared: scenario.spurious_edges.map(normalizeEdge),
			matching_measured_false_positives: scenario.spurious_edges
				.map(normalizeEdge)
				.filter((edge) => edges.false_positive.includes(edge)),
		},
		paraphrase: {
			query: scenario.paraphrase,
			direct_source: directSource,
			indexed_control: indexedControl,
		},
		latency_ms: Math.max(0, Date.now() - started),
	};
}

async function routeScenario(
	graph: RepoGraph,
	scenario: LoadedHeldoutRecallScenario,
	caps: RetrievalQualityResourceCaps,
	provenance: RetrievalRouteMeasurement['provenance'],
): Promise<RetrievalRouteMeasurement> {
	const result = await routeRetrieval(
		provenance === 'direct-source-fallback' ? null : graph,
		{
			question: scenario.paraphrase,
			// Supplying a file makes routeRetrieval prioritize that literal over the
			// question. The direct-source benchmark deliberately exercises the
			// paraphrase fallback, while the indexed control remains file-targeted.
			file:
				provenance === 'direct-source-fallback'
					? undefined
					: scenario.source_path,
			maxTokens: caps.max_tokens,
			topN: caps.top_n,
		},
		async (request) => lexicalDirectSource(request.query, scenario),
		provenance === 'direct-source-fallback'
			? 'direct source evaluation intentionally has no graph'
			: undefined,
	);
	return routeMeasurement(result, provenance, scenario.paraphrase);
}

async function measureIndexedControl(
	workspace: string | null,
	scenario: LoadedHeldoutRecallScenario,
	caps: RetrievalQualityResourceCaps,
	reason: string | undefined,
): Promise<RetrievalRouteMeasurement> {
	if (!workspace || !scenario.source_path)
		return unavailableRoute(reason ?? 'fresh indexed subgraph unavailable');
	const sourcePath = path.join(workspace, scenario.source_path);
	try {
		if (!queryNodeByFile(workspace, sourcePath)) {
			return unavailableRoute(
				'fresh indexed control has no graph node for this source',
			);
		}
		const subgraph = loadSubgraphForFiles(workspace, [sourcePath], 1);
		if (!subgraph)
			return unavailableRoute(
				'fresh indexed subgraph was unavailable after sync',
			);
		return await routeScenario(
			subgraph,
			scenario,
			caps,
			'fresh-indexed-subgraph',
		);
	} catch (error) {
		return unavailableRoute(`indexed control failed: ${describeError(error)}`);
	}
}

function lexicalDirectSource(
	query: string,
	scenario: LoadedHeldoutRecallScenario,
) {
	const queryTerms = tokenize(query);
	const source = scenario.source_text.toLowerCase();
	const matchedTerms = queryTerms.filter((term) => source.includes(term));
	return Promise.resolve({
		matches:
			matchedTerms.length > 0
				? [{ source_path: scenario.source_path, matched_terms: matchedTerms }]
				: [],
		total: matchedTerms.length > 0 ? 1 : 0,
		engine: 'heldout-direct-source-lexical-control',
	});
}

function routeMeasurement(
	result: RetrievalResult,
	provenance: RetrievalRouteMeasurement['provenance'],
	query: string,
): RetrievalRouteMeasurement {
	const lexicalTotal = result.context
		.filter((item) => item.action === 'lexical_search')
		.reduce((count, item) => {
			const total =
				item.data && typeof item.data === 'object'
					? (item.data as { total?: unknown }).total
					: undefined;
			return count + (typeof total === 'number' && total > 0 ? total : 0);
		}, 0);
	const positiveHit = result.graphHit || lexicalTotal > 0;
	return {
		status: positiveHit ? 'complete' : 'degraded',
		provenance,
		...(positiveHit
			? {}
			: {
					degradation_reason: `retrieval produced no match for paraphrase: ${query.slice(0, 120)}`,
				}),
		graph_hit: result.graphHit,
		positive_hit: positiveHit,
		fallback_reason: result.fallbackReason,
		actions: result.actions,
		matched_resource_count: result.context.length,
	};
}

function unavailableRoute(reason: string): RetrievalRouteMeasurement {
	return {
		status: 'skipped',
		provenance: 'unavailable',
		degradation_reason: reason,
		graph_hit: false,
		positive_hit: false,
		fallback_reason: reason,
		actions: [],
		matched_resource_count: 0,
	};
}

async function materializeDisposableWorkspace(
	root: string,
	scenarios: LoadedHeldoutRecallScenario[],
): Promise<void> {
	await fs.mkdir(path.join(root, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(root, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ repo_graph: { storage: 'indexed' } }),
		'utf8',
	);
	for (const scenario of scenarios) {
		if (!scenario.source_path)
			throw new Error(`held-out case ${scenario.id} has no source path`);
		const destination = path.resolve(root, scenario.source_path);
		if (!isContained(root, destination))
			throw new Error(
				`held-out case ${scenario.id} source path escapes workspace`,
			);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, scenario.source_text, 'utf8');
	}
}

function observedFactEdges(facts: FileSymbolFacts): string[] {
	return unique(
		facts.refs
			.filter(
				(reference) =>
					reference.enclosingDecl &&
					reference.identifier !== reference.enclosingDecl,
			)
			.map(
				(reference) => `${reference.enclosingDecl} -> ${reference.identifier}`,
			),
	);
}

function compareExact(
	expected: string[],
	observed: string[],
): ExactMeasurement {
	const expectedSet = new Set(expected);
	const observedSet = new Set(observed);
	const truePositive = [...observedSet].filter((item) =>
		expectedSet.has(item),
	).length;
	return {
		expected: [...expected].sort(),
		observed: [...observedSet].sort(),
		true_positive_count: truePositive,
		false_negative: [...expectedSet]
			.filter((item) => !observedSet.has(item))
			.sort(),
		false_positive: [...observedSet]
			.filter((item) => !expectedSet.has(item))
			.sort(),
		precision: truePositive / Math.max(observedSet.size, 1),
		recall: truePositive / Math.max(expectedSet.size, 1),
	};
}

function summarizeCases(
	cases: HeldoutGraphQualityCase[],
): HeldoutGraphQualityReport['summary'] {
	return {
		symbols: summarizeExact(cases.map((item) => item.symbols)),
		edges: summarizeExact(cases.map((item) => item.edges)),
		complete_case_count: cases.filter((item) => item.status === 'complete')
			.length,
		direct_source_fallback_complete_count: cases.filter(
			(item) => item.paraphrase.direct_source.status === 'complete',
		).length,
		direct_source_fallback_positive_hit_count: cases.filter(
			(item) => item.paraphrase.direct_source.positive_hit,
		).length,
		fresh_indexed_control_complete_count: cases.filter(
			(item) => item.paraphrase.indexed_control.status === 'complete',
		).length,
	};
}

function summarizeExact(
	measurements: ExactMeasurement[],
): AggregateExactMeasurement {
	const expectedCount = measurements.reduce(
		(sum, measurement) => sum + measurement.expected.length,
		0,
	);
	const observedCount = measurements.reduce(
		(sum, measurement) => sum + measurement.observed.length,
		0,
	);
	const truePositiveCount = measurements.reduce(
		(sum, measurement) => sum + measurement.true_positive_count,
		0,
	);
	const falseNegativeCount = measurements.reduce(
		(sum, measurement) => sum + measurement.false_negative.length,
		0,
	);
	const falsePositiveCount = measurements.reduce(
		(sum, measurement) => sum + measurement.false_positive.length,
		0,
	);
	return {
		expected_count: expectedCount,
		observed_count: observedCount,
		true_positive_count: truePositiveCount,
		false_negative_count: falseNegativeCount,
		false_positive_count: falsePositiveCount,
		precision: truePositiveCount / Math.max(observedCount, 1),
		recall: truePositiveCount / Math.max(expectedCount, 1),
	};
}

function normalizeEdge(edge: string | { from: string; to: string }): string {
	if (typeof edge === 'string')
		return edge
			.split('->')
			.map((part) => part.trim())
			.join(' -> ');
	return `${edge.from.trim()} -> ${edge.to.trim()}`;
}

function normalizeCaps(
	input: Partial<RetrievalQualityResourceCaps> | undefined,
): RetrievalQualityResourceCaps {
	const bounded = (value: number | undefined, fallback: number, max: number) =>
		Math.max(1, Math.min(max, Math.trunc(value ?? fallback)));
	return {
		max_files: bounded(input?.max_files, DEFAULT_RESOURCE_CAPS.max_files, 256),
		walk_budget_ms: bounded(
			input?.walk_budget_ms,
			DEFAULT_RESOURCE_CAPS.walk_budget_ms,
			10_000,
		),
		max_tokens: bounded(
			input?.max_tokens,
			DEFAULT_RESOURCE_CAPS.max_tokens,
			4_096,
		),
		top_n: bounded(input?.top_n, DEFAULT_RESOURCE_CAPS.top_n, 25),
	};
}

function hashCorpus(
	manifest: unknown,
	scenarios: LoadedHeldoutRecallScenario[],
): string {
	return createHash('sha256')
		.update(
			stableStringify({
				manifest,
				loaded_sources: scenarios.map((scenario) => ({
					id: scenario.id,
					source_hash: scenario.source_hash,
					source_provenance: scenario.source_provenance,
				})),
			}),
		)
		.digest('hex');
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

function tokenize(value: string): string[] {
	return unique(value.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function isContained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function describeError(error: unknown): string {
	return error instanceof Error
		? error.message.slice(0, 240)
		: String(error).slice(0, 240);
}

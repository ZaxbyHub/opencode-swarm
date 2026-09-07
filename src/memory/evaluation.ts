import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import { createConfiguredMemoryProvider } from './gateway';
import {
	type LoadedHeldoutRecallScenario,
	loadHeldoutRecallEvaluationScenarios,
} from './heldout-evaluation-corpus';
import type { MemoryProvider } from './provider';
import { evictAndClose } from './provider-pool';
import {
	computeMemoryContentHash,
	createMemoryId,
	MemoryKindSchema,
	MemoryScopeRefSchema,
	stableScopeKey,
	validateMemoryRecordRules,
} from './schema';
import {
	type MemoryRecallQualityTrace,
	SQLiteMemoryProvider,
	type SQLiteRetrievalDependencies,
} from './sqlite-provider';
import type {
	MemoryKind,
	MemoryRecord,
	MemoryScopeRef,
	MemorySource,
	RecallMode,
	RecallRequest,
} from './types';

export type RecallEvaluationProviderName = 'local-jsonl' | 'sqlite';
export type RecallEvaluationMode = Extract<
	RecallMode,
	'manual' | 'injection' | 'curator'
>;
export type RecallEvaluationProfile = 'lexical' | 'hybrid' | 'hybrid+rerank';

export interface RecallEvaluationResourceCaps {
	candidate_count: number;
	token_budget: number;
}

export interface RecallEvaluationResourceUsage {
	lexical_candidate_count: number;
	dense_candidate_count: number;
	rerank_candidate_count: number;
	returned_count: number;
	query_embedding_invocation_count: number;
	/** Text-only estimate over actual returned records; prompt consumption is not measured here. */
	returned_token_estimate: number;
}

export interface RecallEvaluationManifest {
	version: '1.0.0';
	source_id: string;
	model_id: string;
	provider_id: string;
	config_hash: string;
	corpus_hash: string;
	profile_thresholds: Record<string, number>;
	sample_counts: Record<string, number>;
	metric_definitions: Record<string, string>;
	uncertainty: { method: string; confidence: number; sample_count: number };
	variants?: Record<string, RecallEvaluationIdentity>;
}

export interface RecallEvaluationIdentity {
	source_id: string;
	model_id: string;
	provider_id: string;
	config_hash: string;
}

export interface RecallEvaluationScenario {
	id: string;
	language: string;
	analyzer_id?: string;
	source_provenance: 'direct-source';
	/** Graph extraction/index querying is deliberately not claimed by memory recall. */
	index_state: 'not-measured';
	graph_measurement: {
		status: 'unmeasured';
		reason: string;
	};
	expected_symbols: string[];
	expected_edges: Array<string | { from: string; to: string }>;
	known_misses: string[];
	spurious_edges: Array<string | { from: string; to: string }>;
}

export interface RecallEvaluationComparison {
	fixture: string;
	provider: RecallEvaluationProviderName;
	mode: RecallEvaluationMode;
	baseline_profile: RecallEvaluationProfile;
	variant_profile: RecallEvaluationProfile;
	precision_at_k_delta: number;
	recall_at_k_delta: number;
	latency_ms_delta: number;
	cost_delta: null;
	cost_comparison: 'unavailable';
}

export interface RecallEvaluationOptions {
	fixtureDirectory: string;
	providers?: RecallEvaluationProviderName[];
	modes?: RecallEvaluationMode[];
	/** Omitted preserves the legacy provider × mode report. */
	profiles?: RecallEvaluationProfile[];
	/** Instance-owned offline dependencies; never used by normal agent recall. */
	dependencies?: SQLiteRetrievalDependencies;
	resourceCaps?: Partial<RecallEvaluationResourceCaps>;
	heldoutCorpusDirectory?: string;
	keepTempRoots?: boolean;
}

export interface RecallEvaluationMetrics {
	'precision@k': number;
	'recall@k': number;
	injection_count: number;
	noisy_injection_count: number;
	same_scope_noise_count: number;
	cross_scope_leak_count: number;
	stale_memory_count: number;
}

export interface RecallEvaluationRun {
	fixture: string;
	provider: RecallEvaluationProviderName;
	mode: RecallEvaluationMode;
	k: number;
	query: string;
	expected_labels: string[];
	expected_ids: string[];
	retrieved_labels: string[];
	retrieved_ids: string[];
	metrics: RecallEvaluationMetrics;
	passed: boolean;
	profile?: RecallEvaluationProfile;
	status?: 'complete' | 'degraded' | 'skipped';
	degradation_reason?: string;
	provenance?: string;
	resource_cap?: RecallEvaluationResourceCaps;
	resource_usage?: RecallEvaluationResourceUsage;
	latency_ms?: number;
	cost_provenance?: string;
	cost?: { provenance: string; amount: null };
	identity?: RecallEvaluationIdentity;
	scenario?: RecallEvaluationScenario;
}

export interface RecallEvaluationReport {
	schema_version: 1;
	generated_at: string;
	fixture_directory: string;
	providers: RecallEvaluationProviderName[];
	modes: RecallEvaluationMode[];
	summary: RecallEvaluationMetrics & {
		fixture_count: number;
		run_count: number;
		passed_run_count: number;
	};
	runs: RecallEvaluationRun[];
	comparisons: RecallEvaluationComparison[];
	/** Additive contract metadata; schema_version stays v1 for legacy callers. */
	manifest: RecallEvaluationManifest;
}

type FixtureRecordState = {
	deleted?: boolean;
	supersededByLabel?: string;
	expiresAt?: string;
};

interface FixtureRecord {
	label: string;
	scope: MemoryScopeRef;
	kind: MemoryKind;
	text: string;
	tags?: string[];
	confidence?: number;
	stability?: MemoryRecord['stability'];
	source?: MemorySource;
	metadata?: Record<string, unknown>;
	state?: FixtureRecordState;
}

interface RecallEvaluationFixture {
	name: string;
	query: string;
	task?: string;
	agentRole?: string;
	scopes: MemoryScopeRef[];
	kinds?: MemoryKind[];
	maxItems?: number;
	tokenBudget?: number;
	k?: number;
	expectedLabels: string[];
	records: FixtureRecord[];
	scenario?: RecallEvaluationScenario;
	sourceHash?: string;
}

const DEFAULT_PROVIDERS: RecallEvaluationProviderName[] = [
	'local-jsonl',
	'sqlite',
];
const DEFAULT_MODES: RecallEvaluationMode[] = [
	'manual',
	'injection',
	'curator',
];
const DEFAULT_TIMESTAMP = '2026-05-26T12:00:00.000Z';

export async function evaluateMemoryRecallFixtures(
	options: RecallEvaluationOptions,
): Promise<RecallEvaluationReport> {
	const fixtureDirectory = path.resolve(options.fixtureDirectory);
	const providers = options.providers ?? DEFAULT_PROVIDERS;
	const modes = options.modes ?? DEFAULT_MODES;
	const profiles = options.profiles;
	const resourceCaps: RecallEvaluationResourceCaps = {
		candidate_count: Math.max(
			1,
			Math.trunc(options.resourceCaps?.candidate_count ?? 20),
		),
		token_budget: Math.max(
			1,
			Math.trunc(options.resourceCaps?.token_budget ?? 1000),
		),
	};
	const generatedAt = new Date().toISOString();
	const heldout = options.heldoutCorpusDirectory
		? await loadHeldoutRecallEvaluationScenarios(options.heldoutCorpusDirectory)
		: undefined;
	const fixtures = heldout
		? (() => {
				// The candidate corpus is identical for every held-out scenario. Build
				// these immutable fixture records once instead of remapping the full
				// corpus for every scenario (the corpus itself remains bounded).
				const candidateRecords = materializeHeldoutCandidateRecords(
					heldout.scenarios,
				);
				return heldout.scenarios.map((scenario) =>
					materializeHeldoutScenario(scenario, candidateRecords),
				);
			})()
		: await loadRecallEvaluationFixtures(fixtureDirectory);
	const runs: RecallEvaluationRun[] = [];

	for (const fixture of fixtures) {
		const materialized = materializeFixture(fixture);
		for (const providerName of providers) {
			const runProfiles = profiles ?? [undefined];
			// Each profile owns a fresh provider/cache. Otherwise a preceding hybrid
			// run can prime its query embedding cache and make the next profile's
			// latency/invocation evidence order-dependent.
			for (const profile of runProfiles) {
				const tempRoot = await fs.realpath(
					await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-eval-')),
				);
				const provider = createEvaluationProvider(
					providerName,
					tempRoot,
					profile,
					options.dependencies,
				);
				try {
					await provider.initialize?.();
					for (const record of materialized.records) {
						await provider.upsert(record);
					}
					for (const mode of modes) {
						const request = buildRecallRequest(
							fixture,
							mode,
							profile ? resourceCaps : undefined,
						);
						if (profile)
							request.quality = {
								profile,
								candidateCap: resourceCaps.candidate_count,
							};
						const started = Date.now();
						const recallResult = provider.recallWithDiagnostics
							? await provider.recallWithDiagnostics(request)
							: { items: await provider.recall(request) };
						const retrievedIds = recallResult.items.map(
							(item) => item.record.id,
						);
						const trace = (
							recallResult as { qualityTrace?: MemoryRecallQualityTrace }
						).qualityTrace;
						const run = buildRun({
							fixture,
							provider: providerName,
							mode,
							k: fixture.k ?? request.maxItems,
							retrievedIds,
							materialized,
							profile,
							resourceCaps,
							trace,
							latencyMs: Math.max(0, Date.now() - started),
							identity: createRunIdentity({
								fixture,
								provider: providerName,
								profile,
								dependencies: options.dependencies,
								resourceCaps,
							}),
						});
						runs.push(run);
					}
				} finally {
					await provider.close?.();
					if (!options.keepTempRoots) {
						// Force-close THIS run's own pooled provider so its SQLite file
						// handle releases before deletion, without touching any other
						// directory's pooled entry (clearPool() would force-close every
						// in-process caller's provider, which is unsafe from a
						// production-reachable command like `/swarm memory evaluate`).
						evictAndClose(tempRoot);
						await rmTempRoot(tempRoot);
					}
				}
			}
		}
	}

	return {
		schema_version: 1,
		generated_at: generatedAt,
		fixture_directory: fixtureDirectory,
		providers,
		modes,
		summary: summarizeRuns(fixtures.length, runs),
		runs,
		manifest: createRecallEvaluationManifest({
			fixtureDirectory,
			providers,
			profiles,
			fixtures,
			dependencies: options.dependencies,
			resourceCaps,
			heldoutCorpusId: heldout?.manifest.corpus_id,
			minimumProfileThreshold: heldout?.manifest.thresholds?.precision_at_k,
		}),
		comparisons: buildProfileComparisons(runs),
	};
}

async function rmTempRoot(tempRoot: string): Promise<void> {
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			await fs.rm(tempRoot, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt === 9) throw err;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

export async function loadRecallEvaluationFixtures(
	fixtureDirectory: string,
): Promise<RecallEvaluationFixture[]> {
	const entries = await fs.readdir(fixtureDirectory, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b));
	const fixtures: RecallEvaluationFixture[] = [];
	for (const file of files) {
		const raw = await fs.readFile(path.join(fixtureDirectory, file), 'utf-8');
		fixtures.push(validateFixture(JSON.parse(raw), file));
	}
	return fixtures;
}

function materializeHeldoutScenario(
	scenario: LoadedHeldoutRecallScenario,
	candidateRecords: readonly FixtureRecord[],
): RecallEvaluationFixture {
	const scope: MemoryScopeRef = {
		type: 'repository',
		repoId: 'heldout-retrieval-corpus',
	};
	const label = `heldout:${scenario.id}`;
	return {
		name: label,
		query: scenario.paraphrase,
		task: scenario.paraphrase,
		scopes: [scope],
		kinds: ['code_pattern'],
		k: 1,
		maxItems: 1,
		tokenBudget: 512,
		expectedLabels: [label],
		// Every paraphrase ranks against the same bounded corpus. This prevents a
		// one-record scope from turning every profile into a vacuous perfect hit.
		records: [...candidateRecords],
		sourceHash: scenario.source_hash,
		scenario: {
			id: scenario.id,
			language: scenario.language,
			analyzer_id: scenario.analyzer_id,
			source_provenance: scenario.source_provenance,
			index_state: 'not-measured',
			graph_measurement: {
				status: 'unmeasured',
				reason:
					'held-out memory evaluation uses direct source retrieval; graph extraction/index controls require the repo-graph evaluator',
			},
			expected_symbols: scenario.expected_symbols,
			expected_edges: scenario.expected_edges,
			known_misses: scenario.known_misses,
			spurious_edges: scenario.spurious_edges,
		},
	};
}

function materializeHeldoutCandidateRecords(
	candidateCorpus: readonly LoadedHeldoutRecallScenario[],
): FixtureRecord[] {
	const scope: MemoryScopeRef = {
		type: 'repository',
		repoId: 'heldout-retrieval-corpus',
	};
	return candidateCorpus.map((candidate) => ({
		label: `heldout:${candidate.id}`,
		scope,
		kind: 'code_pattern' as const,
		// The direct source is what production recall indexes. Expected graph
		// evidence remains report metadata, never injected into scoring text.
		text: candidate.source_text,
		tags: [candidate.language, candidate.analyzer_id ?? 'direct-source'],
		confidence: 1,
		source: { type: 'file' as const, filePath: candidate.source_path },
		metadata: { sourceHash: candidate.source_hash },
	}));
}

function createEvaluationProvider(
	provider: RecallEvaluationProviderName,
	root: string,
	profile?: RecallEvaluationProfile,
	dependencies?: SQLiteRetrievalDependencies,
): MemoryProvider {
	const config: MemoryConfig = {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider,
		embeddings: {
			...DEFAULT_MEMORY_CONFIG.embeddings,
			enabled: profile === 'hybrid' || profile === 'hybrid+rerank',
		},
		retrieval: {
			...DEFAULT_MEMORY_CONFIG.retrieval,
			rerank: {
				...DEFAULT_MEMORY_CONFIG.retrieval.rerank,
				enabled: profile === 'hybrid+rerank',
			},
		},
	};
	if (provider === 'sqlite' && profile) {
		return new SQLiteMemoryProvider(root, config, undefined, dependencies);
	}
	return createConfiguredMemoryProvider(root, config);
}

function buildRecallRequest(
	fixture: RecallEvaluationFixture,
	mode: RecallEvaluationMode,
	resourceCaps?: RecallEvaluationResourceCaps,
): RecallRequest {
	const maxItems = Math.min(
		resourceCaps?.candidate_count ?? 5,
		fixture.maxItems ?? fixture.k ?? 5,
	);
	const base: RecallRequest = {
		query: fixture.query,
		task: fixture.task,
		agentRole: mode === 'curator' ? 'curator' : fixture.agentRole,
		mode,
		scopes: fixture.scopes,
		kinds: fixture.kinds,
		maxItems,
		tokenBudget: Math.min(
			resourceCaps?.token_budget ?? 1000,
			fixture.tokenBudget ?? 1000,
		),
		minScore: mode === 'injection' ? 0.25 : 0,
		requireQuerySignal: mode === 'injection',
	};
	return base;
}

function materializeFixture(fixture: RecallEvaluationFixture): {
	records: MemoryRecord[];
	idsByLabel: Map<string, string>;
	labelsById: Map<string, string>;
	expectedIds: Set<string>;
	staleIds: Set<string>;
	crossScopeIds: Set<string>;
	sameScopeNoiseIds: Set<string>;
} {
	const idsByLabel = new Map<string, string>();
	const labelsById = new Map<string, string>();
	const baseRecords = fixture.records.map((record) => {
		const base = {
			scope: record.scope,
			kind: record.kind,
			text: record.text,
		};
		const id = createMemoryId(base);
		idsByLabel.set(record.label, id);
		labelsById.set(id, record.label);
		return { input: record, id, base };
	});
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
	const allowedScopeKeys = new Set(fixture.scopes.map(stableScopeKey));
	const staleIds = new Set<string>();
	const crossScopeIds = new Set<string>();
	const sameScopeNoiseIds = new Set<string>();
	const records = baseRecords.map(({ input, id, base }) => {
		const supersededBy = input.state?.supersededByLabel
			? idsByLabel.get(input.state.supersededByLabel)
			: undefined;
		if (input.state?.supersededByLabel && !supersededBy) {
			throw new Error(
				`fixture ${fixture.name} record ${input.label} supersedes unknown label ${input.state.supersededByLabel}`,
			);
		}
		const metadata = {
			...(input.metadata ?? {}),
			fixture: fixture.name,
			fixtureLabel: input.label,
			...(input.state?.deleted ? { deleted: true } : {}),
		};
		const record: MemoryRecord = {
			id,
			...base,
			tags: input.tags ?? [],
			confidence: input.confidence ?? 0.8,
			stability: input.stability ?? 'durable',
			source: input.source ?? { type: 'manual', ref: fixture.name },
			createdAt: DEFAULT_TIMESTAMP,
			updatedAt: DEFAULT_TIMESTAMP,
			expiresAt: input.state?.expiresAt,
			supersededBy,
			contentHash: computeMemoryContentHash(base),
			metadata,
		};
		if (
			record.metadata.deleted === true ||
			record.supersededBy ||
			(record.expiresAt && Date.parse(record.expiresAt) <= Date.now())
		) {
			staleIds.add(record.id);
		}
		const inScope = allowedScopeKeys.has(stableScopeKey(record.scope));
		if (!inScope) {
			crossScopeIds.add(record.id);
		} else if (!expectedIds.has(record.id) && !staleIds.has(record.id)) {
			sameScopeNoiseIds.add(record.id);
		}
		return validateMemoryRecordRules(record, { rejectDurableSecrets: true });
	});
	return {
		records,
		idsByLabel,
		labelsById,
		expectedIds,
		staleIds,
		crossScopeIds,
		sameScopeNoiseIds,
	};
}

function buildRun(args: {
	fixture: RecallEvaluationFixture;
	provider: RecallEvaluationProviderName;
	mode: RecallEvaluationMode;
	k: number;
	retrievedIds: string[];
	materialized: ReturnType<typeof materializeFixture>;
	profile?: RecallEvaluationProfile;
	resourceCaps: RecallEvaluationResourceCaps;
	trace?: MemoryRecallQualityTrace;
	latencyMs: number;
	identity: RecallEvaluationIdentity;
}): RecallEvaluationRun {
	const {
		fixture,
		provider,
		mode,
		k,
		retrievedIds,
		materialized,
		profile,
		resourceCaps,
		trace,
		latencyMs,
		identity,
	} = args;
	const topK = retrievedIds.slice(0, k);
	const relevantAtK = topK.filter((id) =>
		materialized.expectedIds.has(id),
	).length;
	const crossScopeLeakCount = retrievedIds.filter((id) =>
		materialized.crossScopeIds.has(id),
	).length;
	const staleMemoryCount = retrievedIds.filter((id) =>
		materialized.staleIds.has(id),
	).length;
	const noisyInjectionCount =
		mode === 'injection'
			? retrievedIds.filter((id) => materialized.sameScopeNoiseIds.has(id))
					.length
			: 0;
	const sameScopeNoiseCount = retrievedIds.filter((id) =>
		materialized.sameScopeNoiseIds.has(id),
	).length;
	const metrics: RecallEvaluationMetrics = {
		'precision@k': relevantAtK / Math.max(k, 1),
		'recall@k': relevantAtK / Math.max(materialized.expectedIds.size, 1),
		injection_count: mode === 'injection' ? retrievedIds.length : 0,
		noisy_injection_count: noisyInjectionCount,
		same_scope_noise_count: sameScopeNoiseCount,
		cross_scope_leak_count: crossScopeLeakCount,
		stale_memory_count: staleMemoryCount,
	};
	const base: RecallEvaluationRun = {
		fixture: fixture.name,
		provider,
		mode,
		k,
		query: fixture.query,
		expected_labels: fixture.expectedLabels,
		expected_ids: fixture.expectedLabels.map(
			(label) => materialized.idsByLabel.get(label) ?? label,
		),
		retrieved_labels: retrievedIds.map(
			(id) => materialized.labelsById.get(id) ?? id,
		),
		retrieved_ids: retrievedIds,
		metrics,
		passed:
			metrics['recall@k'] >= 1 &&
			metrics.noisy_injection_count === 0 &&
			metrics.cross_scope_leak_count === 0 &&
			metrics.stale_memory_count === 0,
	};
	if (!profile) return base;
	const status =
		provider !== 'sqlite' && profile !== 'lexical'
			? ('skipped' as const)
			: (trace?.status ??
				(profile === 'lexical'
					? ('complete' as const)
					: ('degraded' as const)));
	return {
		...base,
		profile,
		status,
		...(status === 'complete'
			? {}
			: {
					degradation_reason:
						trace?.degradationReason ??
						(provider !== 'sqlite'
							? 'profile requires sqlite provider'
							: 'retrieval component unavailable'),
				}),
		provenance:
			trace?.provenance ?? (profile === 'lexical' ? 'lexical' : 'unavailable'),
		resource_cap: resourceCaps,
		resource_usage: normalizeResourceUsage(trace?.resourceUsage),
		latency_ms: Number.isFinite(trace?.latencyMs)
			? (trace?.latencyMs ?? latencyMs)
			: latencyMs,
		cost_provenance: 'offline-deterministic-unavailable',
		cost: { provenance: 'offline-deterministic-unavailable', amount: null },
		identity,
		...(fixture.scenario ? { scenario: fixture.scenario } : {}),
	};
}

function normalizeResourceUsage(
	usage: MemoryRecallQualityTrace['resourceUsage'] | undefined,
): RecallEvaluationResourceUsage | undefined {
	if (!usage) return undefined;
	const candidate = usage;
	const bounded = (value: number): number =>
		Number.isFinite(value) ? Math.max(0, value) : 0;
	return {
		lexical_candidate_count: bounded(candidate.lexical_candidate_count),
		dense_candidate_count: bounded(candidate.dense_candidate_count),
		rerank_candidate_count: bounded(candidate.rerank_candidate_count),
		returned_count: bounded(candidate.returned_count),
		query_embedding_invocation_count: bounded(
			candidate.query_embedding_invocation_count,
		),
		returned_token_estimate: bounded(candidate.returned_token_estimate),
	};
}

function createRecallEvaluationManifest(args: {
	fixtureDirectory: string;
	providers: RecallEvaluationProviderName[];
	profiles?: RecallEvaluationProfile[];
	fixtures: RecallEvaluationFixture[];
	dependencies?: SQLiteRetrievalDependencies;
	resourceCaps: RecallEvaluationResourceCaps;
	heldoutCorpusId?: string;
	minimumProfileThreshold?: number;
}): RecallEvaluationManifest {
	const corpusHash = createHash('sha256')
		.update(stableStringify(args.fixtures))
		.digest('hex');
	const configHash = createHash('sha256')
		.update(
			stableStringify({
				providers: args.providers,
				profiles: args.profiles ?? ['legacy'],
				resourceCaps: args.resourceCaps,
				embeddingModel:
					args.dependencies?.embeddingProvider?.modelVersion ?? 'disabled',
				rerankerModel: args.dependencies?.reranker?.modelVersion ?? 'disabled',
			}),
		)
		.digest('hex');
	return {
		version: '1.0.0',
		source_id: args.heldoutCorpusId
			? `heldout:${args.heldoutCorpusId}`
			: `fixtures:${corpusHash}`,
		model_id:
			args.profiles?.includes('hybrid') ||
			args.profiles?.includes('hybrid+rerank')
				? (args.dependencies?.embeddingProvider?.modelVersion ??
					'configured-embedding')
				: 'none',
		provider_id: `providers:${args.providers.join(',')}`,
		config_hash: configHash,
		corpus_hash: corpusHash,
		profile_thresholds: Object.fromEntries(
			(args.profiles ?? ['lexical']).map((profile) => [
				profile,
				typeof args.minimumProfileThreshold === 'number' &&
				Number.isFinite(args.minimumProfileThreshold) &&
				args.minimumProfileThreshold > 0
					? args.minimumProfileThreshold
					: 0.01,
			]),
		),
		sample_counts: { total: args.fixtures.length },
		metric_definitions: { precision: 'precision@k', recall: 'recall@k' },
		uncertainty: {
			method: 'deterministic-fixture',
			confidence: 0.95,
			sample_count: args.fixtures.length,
		},
		variants: Object.fromEntries(
			(args.profiles ?? ['lexical']).map((profile) => [
				profile,
				{
					source_id: args.heldoutCorpusId
						? `heldout:${args.heldoutCorpusId}`
						: `fixtures:${corpusHash}`,
					model_id:
						profile === 'lexical'
							? 'none'
							: (args.dependencies?.embeddingProvider?.modelVersion ??
								'configured-embedding'),
					provider_id: `profiles:${profile};providers:${args.providers.join(',')}`,
					config_hash: createHash('sha256')
						.update(
							stableStringify({ profile, resourceCaps: args.resourceCaps }),
						)
						.digest('hex'),
				},
			]),
		),
	};
}

function createRunIdentity(args: {
	fixture: RecallEvaluationFixture;
	provider: RecallEvaluationProviderName;
	profile?: RecallEvaluationProfile;
	dependencies?: SQLiteRetrievalDependencies;
	resourceCaps: RecallEvaluationResourceCaps;
}): RecallEvaluationIdentity {
	const profile = args.profile ?? 'legacy';
	const sourceId = args.fixture.scenario
		? `source:${args.fixture.scenario.id}:${args.fixture.sourceHash}`
		: `fixture:${args.fixture.name}:${createHash('sha256').update(args.fixture.query).digest('hex')}`;
	return {
		source_id: sourceId,
		model_id:
			profile === 'lexical'
				? 'none'
				: (args.dependencies?.embeddingProvider?.modelVersion ??
					'configured-embedding'),
		provider_id: args.provider,
		config_hash: createHash('sha256')
			.update(
				stableStringify({
					profile,
					resourceCaps: args.resourceCaps,
					model:
						args.dependencies?.embeddingProvider?.modelVersion ?? 'configured',
					reranker: args.dependencies?.reranker?.modelVersion ?? 'disabled',
				}),
			)
			.digest('hex'),
	};
}

function buildProfileComparisons(
	runs: RecallEvaluationRun[],
): RecallEvaluationComparison[] {
	const groups = new Map<string, RecallEvaluationRun[]>();
	for (const run of runs) {
		if (!run.profile) continue;
		const key = `${run.fixture}\u0000${run.provider}\u0000${run.mode}`;
		const group = groups.get(key) ?? [];
		group.push(run);
		groups.set(key, group);
	}
	const comparisons: RecallEvaluationComparison[] = [];
	for (const group of groups.values()) {
		const baseline = group.find((run) => run.profile === 'lexical');
		if (!baseline) continue;
		for (const variant of group) {
			if (variant === baseline || !variant.profile) continue;
			comparisons.push({
				fixture: baseline.fixture,
				provider: baseline.provider,
				mode: baseline.mode,
				baseline_profile: 'lexical',
				variant_profile: variant.profile,
				precision_at_k_delta:
					variant.metrics['precision@k'] - baseline.metrics['precision@k'],
				recall_at_k_delta:
					variant.metrics['recall@k'] - baseline.metrics['recall@k'],
				latency_ms_delta:
					(variant.latency_ms ?? 0) - (baseline.latency_ms ?? 0),
				cost_delta: null,
				cost_comparison: 'unavailable',
			});
		}
	}
	return comparisons.sort((a, b) =>
		`${a.fixture}:${a.variant_profile}`.localeCompare(
			`${b.fixture}:${b.variant_profile}`,
		),
	);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

/** Strict, filesystem-independent report metadata validation. */
export function validateRecallEvaluationManifest(
	value: unknown,
): asserts value is RecallEvaluationManifest {
	if (!value || typeof value !== 'object')
		throw new Error('recall evaluation manifest must be an object');
	const manifest = value as Record<string, unknown>;
	if (manifest.version !== '1.0.0')
		throw new Error('recall evaluation manifest has unsupported version');
	for (const key of ['source_id', 'model_id', 'provider_id'] as const) {
		if (typeof manifest[key] !== 'string' || !manifest[key].trim())
			throw new Error(`recall evaluation manifest has invalid ${key}`);
	}
	for (const key of ['config_hash', 'corpus_hash'] as const) {
		if (
			typeof manifest[key] !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(manifest[key])
		)
			throw new Error(`recall evaluation manifest has invalid ${key}`);
	}
	for (const key of [
		'profile_thresholds',
		'sample_counts',
		'metric_definitions',
	] as const) {
		const record = manifest[key];
		if (
			!record ||
			typeof record !== 'object' ||
			Array.isArray(record) ||
			Object.keys(record as object).length === 0
		)
			throw new Error(`recall evaluation manifest has invalid ${key}`);
	}
	if (
		Object.values(manifest.profile_thresholds as Record<string, unknown>).some(
			(v) => typeof v !== 'number' || !Number.isFinite(v) || v <= 0,
		)
	)
		throw new Error(
			'recall evaluation manifest has invalid profile_thresholds',
		);
	if (
		Object.values(manifest.sample_counts as Record<string, unknown>).some(
			(v) => typeof v !== 'number' || !Number.isInteger(v) || v <= 0,
		)
	)
		throw new Error('recall evaluation manifest has invalid sample_counts');
	if (
		Object.values(manifest.metric_definitions as Record<string, unknown>).some(
			(v) => typeof v !== 'string' || !v.trim(),
		)
	)
		throw new Error(
			'recall evaluation manifest has invalid metric_definitions',
		);
	const uncertainty = manifest.uncertainty as
		| Record<string, unknown>
		| undefined;
	if (
		!uncertainty ||
		typeof uncertainty.method !== 'string' ||
		!uncertainty.method.trim() ||
		typeof uncertainty.confidence !== 'number' ||
		!(uncertainty.confidence > 0 && uncertainty.confidence <= 1) ||
		typeof uncertainty.sample_count !== 'number' ||
		!Number.isInteger(uncertainty.sample_count) ||
		uncertainty.sample_count <= 0
	)
		throw new Error('recall evaluation manifest has invalid uncertainty');
	if (manifest.variants !== undefined) {
		if (
			!manifest.variants ||
			typeof manifest.variants !== 'object' ||
			Array.isArray(manifest.variants) ||
			Object.keys(manifest.variants as object).length === 0
		)
			throw new Error('recall evaluation manifest has invalid variants');
		for (const [name, identity] of Object.entries(
			manifest.variants as Record<string, unknown>,
		)) {
			if (!name.trim() || !identity || typeof identity !== 'object')
				throw new Error(
					'recall evaluation manifest has invalid variant identity',
				);
			const candidate = identity as Record<string, unknown>;
			for (const key of ['source_id', 'model_id', 'provider_id'] as const) {
				if (typeof candidate[key] !== 'string' || !candidate[key].trim())
					throw new Error(
						'recall evaluation manifest has invalid variant identity',
					);
			}
			if (
				typeof candidate.config_hash !== 'string' ||
				!/^[a-f0-9]{64}$/i.test(candidate.config_hash)
			)
				throw new Error(
					'recall evaluation manifest has invalid variant identity',
				);
		}
	}
}

function summarizeRuns(
	fixtureCount: number,
	runs: RecallEvaluationRun[],
): RecallEvaluationReport['summary'] {
	const total = runs.reduce(
		(acc, run) => {
			acc['precision@k'] += run.metrics['precision@k'];
			acc['recall@k'] += run.metrics['recall@k'];
			acc.injection_count += run.metrics.injection_count;
			acc.noisy_injection_count += run.metrics.noisy_injection_count;
			acc.same_scope_noise_count += run.metrics.same_scope_noise_count;
			acc.cross_scope_leak_count += run.metrics.cross_scope_leak_count;
			acc.stale_memory_count += run.metrics.stale_memory_count;
			if (run.passed) acc.passed_run_count++;
			return acc;
		},
		{
			'precision@k': 0,
			'recall@k': 0,
			injection_count: 0,
			noisy_injection_count: 0,
			same_scope_noise_count: 0,
			cross_scope_leak_count: 0,
			stale_memory_count: 0,
			passed_run_count: 0,
		},
	);
	const denominator = Math.max(runs.length, 1);
	return {
		fixture_count: fixtureCount,
		run_count: runs.length,
		passed_run_count: total.passed_run_count,
		'precision@k': total['precision@k'] / denominator,
		'recall@k': total['recall@k'] / denominator,
		injection_count: total.injection_count,
		noisy_injection_count: total.noisy_injection_count,
		same_scope_noise_count: total.same_scope_noise_count,
		cross_scope_leak_count: total.cross_scope_leak_count,
		stale_memory_count: total.stale_memory_count,
	};
}

function validateFixture(
	value: unknown,
	file: string,
): RecallEvaluationFixture {
	if (!value || typeof value !== 'object') {
		throw new Error(`memory recall fixture ${file} must be an object`);
	}
	const fixture = value as Record<string, unknown>;
	if (typeof fixture.name !== 'string' || !fixture.name) {
		throw new Error(`memory recall fixture ${file} is missing name`);
	}
	if (typeof fixture.query !== 'string' || fixture.query.length < 3) {
		throw new Error(`memory recall fixture ${file} has invalid query`);
	}
	if (!Array.isArray(fixture.scopes) || fixture.scopes.length === 0) {
		throw new Error(`memory recall fixture ${file} must define scopes`);
	}
	const scopes = fixture.scopes.map((scope, index) =>
		validateScope(scope, file, `scope #${index + 1}`),
	);
	if (
		!Array.isArray(fixture.expectedLabels) ||
		fixture.expectedLabels.length === 0
	) {
		throw new Error(`memory recall fixture ${file} must define expectedLabels`);
	}
	const expectedLabels = fixture.expectedLabels.map((label, index) => {
		if (typeof label !== 'string' || !label) {
			throw new Error(
				`memory recall fixture ${file} expectedLabels #${index + 1} must be a non-empty string`,
			);
		}
		return label;
	});
	if (!Array.isArray(fixture.records) || fixture.records.length === 0) {
		throw new Error(`memory recall fixture ${file} must define records`);
	}
	const records = fixture.records.map((record, index) =>
		validateFixtureRecord(record, file, index),
	);
	return {
		...(fixture as Omit<
			RecallEvaluationFixture,
			'name' | 'query' | 'scopes' | 'expectedLabels' | 'records'
		>),
		name: fixture.name,
		query: fixture.query,
		scopes,
		expectedLabels,
		records,
	};
}

function validateFixtureRecord(
	value: unknown,
	file: string,
	index: number,
): FixtureRecord {
	if (!value || typeof value !== 'object') {
		throw new Error(
			`memory recall fixture ${file} record #${index + 1} must be an object`,
		);
	}
	const record = value as Record<string, unknown>;
	const labelForError =
		typeof record.label === 'string' && record.label
			? record.label
			: `#${index + 1}`;
	if (typeof record.label !== 'string' || !record.label) {
		throw new Error(
			`memory recall fixture ${file} record ${labelForError} is missing label`,
		);
	}
	const scope = validateScope(record.scope, file, `record ${record.label}`);
	if (!('kind' in record) || record.kind === '') {
		throw new Error(
			`memory recall fixture ${file} record ${record.label} is missing kind`,
		);
	}
	if (typeof record.kind !== 'string') {
		throw new Error(
			`memory recall fixture ${file} record ${record.label} has invalid kind`,
		);
	}
	const parsedKind = MemoryKindSchema.safeParse(record.kind);
	if (!parsedKind.success) {
		throw new Error(
			`memory recall fixture ${file} record ${record.label} has invalid kind`,
		);
	}
	if (!('text' in record) || record.text === '') {
		throw new Error(
			`memory recall fixture ${file} record ${record.label} is missing text`,
		);
	}
	if (typeof record.text !== 'string') {
		throw new Error(
			`memory recall fixture ${file} record ${record.label} has invalid text`,
		);
	}
	return {
		...(record as Omit<FixtureRecord, 'label' | 'scope' | 'kind' | 'text'>),
		label: record.label,
		scope,
		kind: parsedKind.data,
		text: record.text,
	};
}

function validateScope(
	value: unknown,
	file: string,
	descriptor: string,
): MemoryScopeRef {
	if (!value || typeof value !== 'object') {
		throw new Error(
			`memory recall fixture ${file} ${descriptor} is missing scope`,
		);
	}
	const scope = value as Record<string, unknown>;
	if (typeof scope.type !== 'string') {
		throw new Error(
			`memory recall fixture ${file} ${descriptor} has invalid scope type`,
		);
	}
	const parsed = MemoryScopeRefSchema.safeParse(scope);
	if (!parsed.success) {
		throw new Error(
			`memory recall fixture ${file} ${descriptor} has invalid scope`,
		);
	}
	return parsed.data;
}

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import { createConfiguredMemoryProvider } from './gateway';
import type { MemoryProvider } from './provider';
import {
	computeMemoryContentHash,
	createMemoryId,
	stableScopeKey,
	validateMemoryRecordRules,
} from './schema';
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

export interface RecallEvaluationOptions {
	fixtureDirectory: string;
	providers?: RecallEvaluationProviderName[];
	modes?: RecallEvaluationMode[];
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
}

const DEFAULT_PROVIDERS: RecallEvaluationProviderName[] = [
	'local-jsonl',
	'sqlite',
];
const DEFAULT_MODES: RecallEvaluationMode[] = ['manual', 'injection', 'curator'];
const DEFAULT_TIMESTAMP = '2026-05-26T12:00:00.000Z';

export async function evaluateMemoryRecallFixtures(
	options: RecallEvaluationOptions,
): Promise<RecallEvaluationReport> {
	const fixtureDirectory = path.resolve(options.fixtureDirectory);
	const providers = options.providers ?? DEFAULT_PROVIDERS;
	const modes = options.modes ?? DEFAULT_MODES;
	const generatedAt = new Date().toISOString();
	const fixtures = await loadRecallEvaluationFixtures(fixtureDirectory);
	const runs: RecallEvaluationRun[] = [];

	for (const fixture of fixtures) {
		const materialized = materializeFixture(fixture);
		for (const providerName of providers) {
			const tempRoot = await fs.realpath(
				await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-eval-')),
			);
			const provider = createEvaluationProvider(providerName, tempRoot);
			try {
				await provider.initialize?.();
				for (const record of materialized.records) {
					await provider.upsert(record);
				}
				for (const mode of modes) {
					const request = buildRecallRequest(fixture, mode);
					const items = await provider.recall(request);
					const retrievedIds = items.map((item) => item.record.id);
					const run = buildRun({
						fixture,
						provider: providerName,
						mode,
						k: fixture.k ?? request.maxItems,
						retrievedIds,
						materialized,
					});
					runs.push(run);
				}
			} finally {
				await provider.close?.();
				if (!options.keepTempRoots) {
					await fs.rm(tempRoot, { recursive: true, force: true });
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
	};
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

function createEvaluationProvider(
	provider: RecallEvaluationProviderName,
	root: string,
): MemoryProvider {
	const config: MemoryConfig = {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider,
	};
	return createConfiguredMemoryProvider(root, config);
}

function buildRecallRequest(
	fixture: RecallEvaluationFixture,
	mode: RecallEvaluationMode,
): RecallRequest {
	const maxItems = fixture.maxItems ?? fixture.k ?? 5;
	const base: RecallRequest = {
		query: fixture.query,
		task: fixture.task,
		agentRole: mode === 'curator' ? 'curator' : fixture.agentRole,
		mode,
		scopes: fixture.scopes,
		kinds: fixture.kinds,
		maxItems,
		tokenBudget: fixture.tokenBudget ?? 1000,
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
}): RecallEvaluationRun {
	const { fixture, provider, mode, k, retrievedIds, materialized } = args;
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
	return {
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

function validateFixture(value: unknown, file: string): RecallEvaluationFixture {
	if (!value || typeof value !== 'object') {
		throw new Error(`memory recall fixture ${file} must be an object`);
	}
	const fixture = value as RecallEvaluationFixture;
	if (typeof fixture.name !== 'string' || !fixture.name) {
		throw new Error(`memory recall fixture ${file} is missing name`);
	}
	if (typeof fixture.query !== 'string' || fixture.query.length < 3) {
		throw new Error(`memory recall fixture ${file} has invalid query`);
	}
	if (!Array.isArray(fixture.scopes) || fixture.scopes.length === 0) {
		throw new Error(`memory recall fixture ${file} must define scopes`);
	}
	if (
		!Array.isArray(fixture.expectedLabels) ||
		fixture.expectedLabels.length === 0
	) {
		throw new Error(
			`memory recall fixture ${file} must define expectedLabels`,
		);
	}
	if (!Array.isArray(fixture.records) || fixture.records.length === 0) {
		throw new Error(`memory recall fixture ${file} must define records`);
	}
	return fixture;
}

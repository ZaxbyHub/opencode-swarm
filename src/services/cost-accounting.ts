import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CostSource = 'reported' | 'estimated' | 'unavailable';

export type ModelPricing = {
	input_per_million: number;
	output_per_million: number;
	reasoning_per_million?: number;
	cache_per_million?: number;
};

export type PricingConfig = {
	models?: Record<string, ModelPricing>;
};

export type TokenUsage = {
	tokens_input: number;
	tokens_output: number;
	tokens_reasoning: number;
	tokens_cache: number;
};

export type DelegationCostFields = TokenUsage & {
	cost_usd: number | null;
	cost_source: CostSource;
	model?: string;
	gate?: string;
	retry_index?: number;
};

export type DelegationCostInput = {
	raw?: unknown;
	model?: string;
	gate?: string;
	retry_index?: number;
	pricing?: PricingConfig;
};

export type CostSummary = {
	total_cost_usd: number;
	total_reported_usd: number;
	total_estimated_usd: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_reasoning_tokens: number;
	total_cache_tokens: number;
	delegations: number;
	unavailable_delegations: number;
	by_agent: CostSummaryRow[];
	by_task: CostSummaryRow[];
	by_gate: CostSummaryRow[];
	by_retry: CostSummaryRow[];
	by_source: Record<CostSource, { delegations: number; cost_usd: number }>;
};

export type CostSummaryRow = {
	name: string;
	delegations: number;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	reasoning_tokens: number;
	cache_tokens: number;
	unavailable_delegations: number;
};

const ZERO_USAGE: TokenUsage = {
	tokens_input: 0,
	tokens_output: 0,
	tokens_reasoning: 0,
	tokens_cache: 0,
};

// BUNDLED_MODEL_PRICING is intentionally empty. Cost estimation requires
// user-provided pricing via `pricing.models` in config (or provider-reported
// cost_usd). Without either, estimateCostUsd returns null and cost_source
// degrades to 'unavailable'. Bundled defaults are not shipped to avoid
// stale pricing and to keep the plugin side-effect free at import time.
export const BUNDLED_MODEL_PRICING: Record<string, ModelPricing> = {};

export function buildDelegationCostFields(
	input: DelegationCostInput = {},
): DelegationCostFields {
	const extracted = extractUsageAndCost(input.raw);
	const usage = extracted.usage;
	const model = extracted.model ?? input.model;
	const reportedCost = extracted.cost_usd;

	if (reportedCost !== null) {
		return {
			...usage,
			cost_usd: roundUsd(reportedCost),
			cost_source: 'reported',
			model,
			gate: input.gate,
			retry_index: input.retry_index,
		};
	}

	const estimated = estimateCostUsd(usage, model, input.pricing);
	if (estimated !== null) {
		return {
			...usage,
			cost_usd: roundUsd(estimated),
			cost_source: 'estimated',
			model,
			gate: input.gate,
			retry_index: input.retry_index,
		};
	}

	return {
		...usage,
		cost_usd: null,
		cost_source: 'unavailable',
		model,
		gate: input.gate,
		retry_index: input.retry_index,
	};
}

export function summarizeTelemetryCosts(directory: string): CostSummary {
	const summary = createEmptySummary();
	for (const event of readTelemetryEvents(directory)) {
		if (event.event !== 'delegation_end') continue;
		addDelegationEvent(summary, event);
	}
	return finalizeSummary(summary);
}

export function readTelemetryEvents(
	directory: string,
): Record<string, unknown>[] {
	const swarmDir = path.join(directory, '.swarm');
	const files = [
		path.join(swarmDir, 'telemetry.jsonl.1'),
		path.join(swarmDir, 'telemetry.jsonl'),
	];
	// Atomic snapshot: copy both files to a temp dir before reading to avoid
	// TOCTOU with rotateTelemetryIfNeeded renaming .jsonl -> .jsonl.1 between reads.
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-snapshot-'));
	const snapshotFiles: string[] = [];
	try {
		for (const file of files) {
			if (!fs.existsSync(file)) continue;
			const snap = path.join(tmpDir, path.basename(file));
			try {
				fs.copyFileSync(file, snap);
				snapshotFiles.push(snap);
			} catch {
				// If copy fails, skip this file (best-effort snapshot)
			}
		}
	} catch {
		// mkdtemp or copy failure — fall through to empty result
	}

	const events: Record<string, unknown>[] = [];
	for (const file of snapshotFiles) {
		let content = '';
		try {
			content = fs.readFileSync(file, 'utf-8');
		} catch {
			continue;
		}
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (isRecord(parsed)) events.push(parsed);
			} catch {}
		}
	}
	// Best-effort cleanup of snapshot dir
	try {
		for (const f of snapshotFiles) {
			try {
				fs.unlinkSync(f);
			} catch {}
		}
		fs.rmdirSync(tmpDir);
	} catch {}
	return events;
}

export function estimateCostUsd(
	usage: TokenUsage,
	model?: string,
	pricing?: PricingConfig,
): number | null {
	if (!model) return null;
	// NOTE: estimation requires user-provided pricing config (pricing.models)
	// or provider-reported cost. BUNDLED_MODEL_PRICING is empty by design.
	// NOTE: cache pricing limitation — readCacheTokens and readTelemetryEvents
	// collapse read+write cache tokens into a single `tokens_cache` value.
	// A single `cache_per_million` rate cannot represent asymmetric pricing
	// (different rates for cache read vs. cache write). The same rate is
	// applied to the combined total. This is a documented constraint.
	const table = { ...BUNDLED_MODEL_PRICING, ...(pricing?.models ?? {}) };
	const entry = table[model] ?? table[model.toLowerCase()];
	if (!entry) return null;
	const cost =
		(usage.tokens_input / 1_000_000) * entry.input_per_million +
		(usage.tokens_output / 1_000_000) * entry.output_per_million +
		(usage.tokens_reasoning / 1_000_000) *
			(entry.reasoning_per_million ?? entry.output_per_million) +
		(usage.tokens_cache / 1_000_000) *
			(entry.cache_per_million ?? entry.input_per_million);
	return cost > 0 ? cost : null;
}

function extractUsageAndCost(raw: unknown): {
	usage: TokenUsage;
	cost_usd: number | null;
	model?: string;
} {
	const candidates = collectCandidateRecords(raw);
	const usage: TokenUsage = { ...ZERO_USAGE };
	let cost_usd: number | null = null;
	let model: string | undefined;

	for (const candidate of candidates) {
		model ??= readModelIdentifier(candidate);
		cost_usd ??= readNumber(candidate, [
			'cost_usd',
			'total_cost_usd',
			'cost',
			'totalCost',
		]);

		const directInput = readNumber(candidate, [
			'tokens_input',
			'input_tokens',
			'input',
			'prompt_tokens',
		]);
		const directOutput = readNumber(candidate, [
			'tokens_output',
			'output_tokens',
			'output',
			'completion_tokens',
		]);
		const directReasoning = readNumber(candidate, [
			'tokens_reasoning',
			'reasoning_tokens',
			'reasoning',
		]);
		const directCache = readNumber(candidate, [
			'tokens_cache',
			'cache_tokens',
			'cache_read_input_tokens',
			'cached_input_tokens',
			'cache_write_input_tokens',
			'cache',
		]);
		const nestedCache = readCacheTokens(candidate);

		usage.tokens_input ||= directInput ?? 0;
		usage.tokens_output ||= directOutput ?? 0;
		usage.tokens_reasoning ||= directReasoning ?? 0;
		usage.tokens_cache ||= directCache ?? nestedCache ?? 0;
	}

	return { usage, cost_usd, model };
}

function collectCandidateRecords(raw: unknown): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	const visit = (value: unknown, depth: number) => {
		if (depth > 3 || !isRecord(value)) return;
		records.push(value);
		for (const key of [
			'usage',
			'tokens',
			'cache',
			'cost',
			'metadata',
			'data',
			'info',
			'message',
			'assistant',
			'task',
			'part',
			'response',
			'output',
		]) {
			visit(value[key], depth + 1);
		}
	};
	visit(raw, 0);
	return records;
}

function readNumber(
	record: Record<string, unknown>,
	keys: readonly string[],
): number | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
			return value;
		if (typeof value === 'string' && value.trim() !== '') {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed >= 0) return parsed;
		}
	}
	return null;
}

function readString(
	record: Record<string, unknown>,
	keys: readonly string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim();
	}
	return undefined;
}

function readModelIdentifier(
	record: Record<string, unknown>,
): string | undefined {
	const direct = readString(record, ['model', 'model_id']);
	if (direct) return direct;
	const modelID = readString(record, ['modelID']);
	const providerID = readString(record, ['providerID']);
	if (modelID && providerID) return `${providerID}/${modelID}`;
	return modelID;
}

function readCacheTokens(record: Record<string, unknown>): number | null {
	const cacheRecord = isRecord(record.cache) ? record.cache : record;
	const read = readNumber(cacheRecord, ['read', 'cache_read_input_tokens']);
	const write = readNumber(cacheRecord, [
		'write',
		'cache_write_input_tokens',
		'write_input_tokens',
	]);
	if (read === null && write === null) return null;
	return (read ?? 0) + (write ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createEmptySummary(): CostSummary {
	return {
		total_cost_usd: 0,
		total_reported_usd: 0,
		total_estimated_usd: 0,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_reasoning_tokens: 0,
		total_cache_tokens: 0,
		delegations: 0,
		unavailable_delegations: 0,
		by_agent: [],
		by_task: [],
		by_gate: [],
		by_retry: [],
		by_source: {
			reported: { delegations: 0, cost_usd: 0 },
			estimated: { delegations: 0, cost_usd: 0 },
			unavailable: { delegations: 0, cost_usd: 0 },
		},
	};
}

function addDelegationEvent(
	summary: CostSummary,
	event: Record<string, unknown>,
): void {
	const costSource = parseCostSource(event.cost_source);
	const cost = readNumber(event, ['cost_usd']) ?? 0;
	const usage = {
		tokens_input: readNumber(event, ['tokens_input']) ?? 0,
		tokens_output: readNumber(event, ['tokens_output']) ?? 0,
		tokens_reasoning: readNumber(event, ['tokens_reasoning']) ?? 0,
		tokens_cache: readNumber(event, ['tokens_cache']) ?? 0,
	};

	summary.delegations++;
	summary.total_cost_usd += cost;
	summary.total_input_tokens += usage.tokens_input;
	summary.total_output_tokens += usage.tokens_output;
	summary.total_reasoning_tokens += usage.tokens_reasoning;
	summary.total_cache_tokens += usage.tokens_cache;
	summary.by_source[costSource].delegations++;
	summary.by_source[costSource].cost_usd += cost;
	if (costSource === 'reported') summary.total_reported_usd += cost;
	if (costSource === 'estimated') summary.total_estimated_usd += cost;
	if (costSource === 'unavailable') summary.unavailable_delegations++;

	addRow(
		summary.by_agent,
		String(event.agentName ?? event.agent ?? 'unknown'),
		{
			cost,
			costSource,
			usage,
		},
	);
	addRow(summary.by_task, String(event.taskId ?? event.task_id ?? 'unknown'), {
		cost,
		costSource,
		usage,
	});
	addRow(summary.by_gate, String(event.gate ?? 'unknown'), {
		cost,
		costSource,
		usage,
	});
	addRow(
		summary.by_retry,
		String(readNumber(event, ['retry_index', 'retryIndex']) ?? 0),
		{
			cost,
			costSource,
			usage,
		},
	);
}

function addRow(
	rows: CostSummaryRow[],
	name: string,
	input: { cost: number; costSource: CostSource; usage: TokenUsage },
): void {
	let row = rows.find((candidate) => candidate.name === name);
	if (!row) {
		row = {
			name,
			delegations: 0,
			cost_usd: 0,
			input_tokens: 0,
			output_tokens: 0,
			reasoning_tokens: 0,
			cache_tokens: 0,
			unavailable_delegations: 0,
		};
		rows.push(row);
	}
	row.delegations++;
	row.cost_usd += input.cost;
	row.input_tokens += input.usage.tokens_input;
	row.output_tokens += input.usage.tokens_output;
	row.reasoning_tokens += input.usage.tokens_reasoning;
	row.cache_tokens += input.usage.tokens_cache;
	if (input.costSource === 'unavailable') row.unavailable_delegations++;
}

function finalizeSummary(summary: CostSummary): CostSummary {
	summary.total_cost_usd = roundUsd(summary.total_cost_usd);
	summary.total_reported_usd = roundUsd(summary.total_reported_usd);
	summary.total_estimated_usd = roundUsd(summary.total_estimated_usd);
	for (const source of Object.values(summary.by_source)) {
		source.cost_usd = roundUsd(source.cost_usd);
	}
	for (const rows of [
		summary.by_agent,
		summary.by_task,
		summary.by_gate,
		summary.by_retry,
	]) {
		for (const row of rows) row.cost_usd = roundUsd(row.cost_usd);
		rows.sort(
			(a, b) => b.cost_usd - a.cost_usd || b.delegations - a.delegations,
		);
	}
	return summary;
}

function parseCostSource(value: unknown): CostSource {
	return value === 'reported' ||
		value === 'estimated' ||
		value === 'unavailable'
		? value
		: 'unavailable';
}

export function roundUsd(value: number): number {
	return Math.round(value * 1_000_000) / 1_000_000;
}

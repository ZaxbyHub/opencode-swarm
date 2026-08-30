import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../utils/logger.js';

export type CostSource = 'reported' | 'estimated' | 'unavailable';

export type CostEvidenceKind = 'provider_reported' | 'normalized_estimate';
export type CostEvidenceStatus = 'complete' | 'inconclusive';
export type CostCurrency = 'USD' | 'unknown' | (string & {});
export type CostEvidenceReason =
	| 'authoritative'
	| 'missing_cost'
	| 'invalid_number'
	| 'pricing_missing'
	| 'unsupported_currency'
	| 'conflict'
	| 'unbilled'
	| 'join_miss'
	| 'legacy'
	| 'unreadable'
	| 'partial';

/** Fixed, non-provider-controlled paths accepted by the evidence adapter. */
export type CostEvidenceSourcePath =
	| 'assistant.cost'
	| 'step-finish.cost'
	| 'response.info.cost'
	| 'response.cost'
	| 'legacy.cost'
	| 'pricing.model';

export type CostEvidence = {
	kind: CostEvidenceKind;
	amount_usd: number | null;
	currency: CostCurrency;
	source_path: CostEvidenceSourcePath;
	reason: CostEvidenceReason;
	usage: TokenUsage;
	model?: string;
	pricing_version?: string;
	pricing_effective_at?: string;
	billing_basis?: string;
	/** A bounded canonical digest is useful to correction producers. */
	digest?: string;
};

export type CostCandidate = {
	kind: CostEvidenceKind;
	amount: number | null;
	currency: CostCurrency;
	source_path: CostEvidenceSourcePath;
	usage: TokenUsage;
	model?: string;
	reason?: CostEvidenceReason;
};

export type ModelPricing = {
	input_per_million: number;
	output_per_million: number;
	reasoning_per_million?: number;
	cache_per_million?: number;
};

export type PricingConfig = {
	models?: Record<string, ModelPricing>;
	/** Currency of normalized table rows. Defaults to USD for compatibility. */
	currency?: string;
	version?: string;
	effective_at?: string;
	billing_basis?: string;
	/** Explicit provider declarations; reported currency is never inferred. */
	reported_cost_currency?: Record<string, string>;
	subscription_unbilled?: boolean;
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
	cost_evidence?: CostEvidence[];
	evidence_status?: CostEvidenceStatus;
	evidence_reason?: CostEvidenceReason;
	record_id?: string;
	identity_fingerprint?: string;
	child_session_digest?: string;
	parent_session_digest?: string;
	version?: number;
	currency?: CostCurrency;
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
	reported_cost_currency?: string;
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
	total_legacy_usd: number;
	conflict_count: number;
	legacy_count: number;
	join_miss_count: number;
	telemetry_error_count: number;
	accepted_corrections: number;
	rejected_corrections: number;
	duplicate_corrections: number;
	evidence_status: CostEvidenceStatus;
	currencies: string[];
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

const MAX_EVIDENCE_ITEMS = 8;
const MAX_COST_STRING_LENGTH = 128;
const MAX_PROVIDER_REPORTED_COST_USD = 1_000_000_000;
const MAX_TELEMETRY_FILE_BYTES = 4 * 1024 * 1024;
const ASYNC_TELEMETRY_READ_TIMEOUT_MS = 500;

// BUNDLED_MODEL_PRICING is intentionally empty. Cost estimation requires
// user-provided pricing via `pricing.models` in config (or provider-reported
// cost_usd). Without either, estimateCostUsd returns null and cost_source
// degrades to 'unavailable'. Bundled defaults are not shipped to avoid
// stale pricing and to keep the plugin side-effect free at import time.
export const BUNDLED_MODEL_PRICING: Record<string, ModelPricing> = {};

export function buildDelegationCostFields(
	input: DelegationCostInput = {},
): DelegationCostFields {
	const evidence = extractCostEvidence(input.raw, input);
	const projection = projectCostEvidence(evidence);
	const usage = evidence.reduce(mergeUsage, { ...ZERO_USAGE });
	const model = evidence.find((item) => item.model)?.model ?? input.model;
	return {
		...usage,
		cost_usd: projection.cost_usd,
		cost_source: projection.cost_source,
		cost_evidence: evidence,
		evidence_status: projection.evidence_status,
		evidence_reason: projection.reason,
		currency: projection.currency,
		model,
		gate: input.gate,
		retry_index: input.retry_index,
	};
}

/**
 * Extract only the pinned SDK shapes. The old generic traversal was
 * intentionally removed: a wrapper's default cost must not shadow a child
 * AssistantMessage/StepFinishPart report.
 */
export function extractCostEvidence(
	raw: unknown,
	input: Pick<
		DelegationCostInput,
		'model' | 'pricing' | 'reported_cost_currency'
	> = {},
): CostEvidence[] {
	const candidates = collectPinnedCandidates(raw, input);
	const reports = candidates.filter(
		(candidate) => candidate.kind === 'provider_reported',
	);
	const evidence: CostEvidence[] = [];
	for (const candidate of reports.slice(0, MAX_EVIDENCE_ITEMS)) {
		evidence.push({
			kind: candidate.kind,
			amount_usd: candidate.amount,
			currency: candidate.currency,
			source_path: candidate.source_path,
			reason:
				candidate.reason ??
				(candidate.amount === null ? 'invalid_number' : 'authoritative'),
			usage: candidate.usage,
			model: candidate.model,
		});
	}

	const usage = mergeUsage(
		candidates.reduce(mergeUsage, { ...ZERO_USAGE }),
		readLegacyUsage(raw),
	);
	const model =
		candidates.find((candidate) => candidate.model)?.model ?? input.model;
	const estimate = estimateCostUsd(usage, model, input.pricing);
	if (estimate !== null || input.pricing?.subscription_unbilled) {
		evidence.push({
			kind: 'normalized_estimate',
			amount_usd: input.pricing?.subscription_unbilled ? null : estimate,
			currency: normalizeCurrency(input.pricing?.currency ?? 'USD'),
			source_path: 'pricing.model',
			reason: input.pricing?.subscription_unbilled
				? 'unbilled'
				: 'authoritative',
			usage,
			model,
			pricing_version: boundedCostLabel(input.pricing?.version),
			pricing_effective_at: boundedCostLabel(input.pricing?.effective_at),
			billing_basis: boundedCostLabel(input.pricing?.billing_basis),
		});
	}
	if (evidence.length === 0) {
		evidence.push({
			kind: 'provider_reported',
			amount_usd: null,
			currency: 'unknown',
			source_path: 'legacy.cost',
			reason:
				input.pricing?.models && model ? 'pricing_missing' : 'missing_cost',
			usage,
			model,
		});
	}
	return evidence.slice(0, MAX_EVIDENCE_ITEMS);
}

export type CostProjection = {
	cost_usd: number | null;
	cost_source: CostSource;
	evidence_status: CostEvidenceStatus;
	reason: CostEvidenceReason;
	currency: CostCurrency;
};

/** Project additive evidence to the legacy scalar fields. Unknown is never zero. */
export function projectCostEvidence(
	evidence: readonly CostEvidence[],
): CostProjection {
	// A pinned token-bearing SDK shape with no `cost` is usage evidence, not a
	// monetary provider report. It must not suppress a configured estimate.
	const reports = evidence.filter(
		(item) =>
			item.kind === 'provider_reported' && item.reason !== 'missing_cost',
	);
	const compatibleReports = reports.filter(
		(item) =>
			item.amount_usd !== null &&
			item.amount_usd <= MAX_PROVIDER_REPORTED_COST_USD &&
			item.currency === 'USD',
	);
	const incompatibleReport = reports.some(
		(item) =>
			item.amount_usd !== null &&
			item.amount_usd <= MAX_PROVIDER_REPORTED_COST_USD &&
			(item.currency !== 'USD' || item.reason !== 'authoritative'),
	);
	const reportConflict = hasReportConflict(reports);
	if (!reportConflict && !incompatibleReport && compatibleReports.length > 0) {
		return {
			cost_usd: roundUsd(compatibleReports[0].amount_usd ?? 0),
			cost_source: 'reported',
			evidence_status: 'complete',
			reason: 'authoritative',
			currency: 'USD',
		};
	}
	const estimate = evidence.find(
		(item) =>
			item.kind === 'normalized_estimate' &&
			item.amount_usd !== null &&
			item.currency === 'USD' &&
			item.reason === 'authoritative',
	);
	const hasHardIncompatibleReport = reports.some(
		(item) =>
			item.amount_usd !== null &&
			item.amount_usd <= MAX_PROVIDER_REPORTED_COST_USD &&
			(item.currency !== 'USD' || item.reason === 'unsupported_currency'),
	);
	if (!reportConflict && !hasHardIncompatibleReport && estimate) {
		return {
			cost_usd: roundUsd(estimate.amount_usd ?? 0),
			cost_source: 'estimated',
			evidence_status: 'complete',
			reason: 'authoritative',
			currency: 'USD',
		};
	}
	return {
		cost_usd: null,
		cost_source: 'unavailable',
		evidence_status: 'inconclusive',
		reason: reportConflict
			? 'conflict'
			: incompatibleReport
				? (reports[0]?.reason ?? 'unsupported_currency')
				: 'missing_cost',
		currency: reports[0]?.currency ?? 'unknown',
	};
}

export function isCostEvidenceComplete(
	evidence: readonly CostEvidence[] | undefined,
): boolean {
	return Boolean(
		evidence &&
			evidence.length > 0 &&
			projectCostEvidence(evidence).evidence_status === 'complete',
	);
}

export function summarizeTelemetryCosts(directory: string): CostSummary {
	const summary = createEmptySummary();
	const folded = foldTelemetryEvents(readTelemetryEvents(directory));
	summary.conflict_count = folded.stats.conflict_count;
	summary.join_miss_count = folded.stats.join_miss_count;
	summary.telemetry_error_count = folded.stats.telemetry_error_count;
	if (
		folded.stats.join_miss_count > 0 ||
		folded.stats.telemetry_error_count > 0
	) {
		summary.evidence_status = 'inconclusive';
	}
	if (
		folded.stats.rejected_corrections > 0 ||
		folded.stats.conflict_count > 0
	) {
		summary.evidence_status = 'inconclusive';
	}
	summary.accepted_corrections = folded.stats.accepted_corrections;
	summary.rejected_corrections = folded.stats.rejected_corrections;
	summary.duplicate_corrections = folded.stats.duplicate_corrections;
	for (const event of folded.events) {
		if (event.event !== 'delegation_end') continue;
		addDelegationEvent(summary, event);
	}
	return finalizeSummary(summary);
}

export type CostFoldStats = {
	conflict_count: number;
	join_miss_count: number;
	telemetry_error_count: number;
	accepted_corrections: number;
	rejected_corrections: number;
	duplicate_corrections: number;
};

export type FoldedCostTelemetry = {
	events: Record<string, unknown>[];
	stats: CostFoldStats;
	versions: Record<string, number>;
};

/**
 * Fold append-only cost corrections into one effective delegation snapshot.
 * Corrections are buffered and replayed in version order so telemetry arrival
 * order cannot permanently discard a valid correction. Invalid/orphan
 * corrections remain diagnostics and can never create a row.
 */
export function foldTelemetryEvents(
	events: readonly Record<string, unknown>[],
): FoldedCostTelemetry {
	const stats: CostFoldStats = {
		conflict_count: 0,
		join_miss_count: 0,
		telemetry_error_count: 0,
		accepted_corrections: 0,
		rejected_corrections: 0,
		duplicate_corrections: 0,
	};
	const rows = new Map<string, Record<string, unknown>>();
	const states = new Map<
		string,
		{ version: number; digest?: string; fingerprint?: string }
	>();
	const legacy: Record<string, unknown>[] = [];
	const corrections: Record<string, unknown>[] = [];
	for (const event of events) {
		const eventKind = event.event;
		if (eventKind === 'delegation_cost_join' && event.reason === 'join_miss') {
			stats.join_miss_count++;
			continue;
		}
		if (
			eventKind === 'delegation_cost_join' &&
			(event.reason === 'unreadable' || event.reason === 'malformed')
		) {
			stats.telemetry_error_count++;
			continue;
		}
		if (
			eventKind !== 'delegation_end' &&
			eventKind !== 'delegation_cost_correction'
		)
			continue;
		if (eventKind === 'delegation_end') {
			const recordId = boundedId(event.record_id ?? event.recordId);
			if (!recordId) {
				legacy.push(event);
				continue;
			}
			const fingerprint = boundedDigest(event.identity_fingerprint);
			const initialVersion = validVersion(event.version);
			if (!fingerprint || initialVersion !== 1) {
				legacy.push(event);
				stats.rejected_corrections++;
				continue;
			}
			const snapshot = { ...event, record_id: recordId };
			const digest =
				boundedDigest(event.digest) ?? costSnapshotDigest(snapshot);
			if (rows.has(recordId)) {
				// A second initial is not allowed to replace the first one.
				stats.rejected_corrections++;
				continue;
			}
			rows.set(recordId, snapshot);
			states.set(recordId, {
				version: initialVersion,
				digest,
				fingerprint,
			});
			if (parseCostSource(event.cost_source) === 'unavailable') {
				const evidence = readEventEvidence(event);
				if (evidence.some((item) => item.reason === 'conflict'))
					stats.conflict_count++;
			}
			continue;
		}
		corrections.push(event);
	}
	// A crash or concurrent writer can leave correction lines out of order. A
	// bounded in-memory replay by record/version lets a later line satisfy the
	// exact-next-version check without weakening fingerprint or upgrade guards.
	corrections.sort((left, right) => {
		const leftRecord = boundedId(left.record_id ?? left.recordId) ?? '';
		const rightRecord = boundedId(right.record_id ?? right.recordId) ?? '';
		if (leftRecord !== rightRecord)
			return leftRecord.localeCompare(rightRecord);
		return (
			(validVersion(left.version) ?? Number.MAX_SAFE_INTEGER) -
			(validVersion(right.version) ?? Number.MAX_SAFE_INTEGER)
		);
	});
	for (const event of corrections) {
		const recordId = boundedId(event.record_id ?? event.recordId);
		const state = recordId ? states.get(recordId) : undefined;
		const current = recordId ? rows.get(recordId) : undefined;
		if (!recordId || !state || !current) {
			stats.rejected_corrections++;
			continue;
		}
		const fingerprint = boundedDigest(event.identity_fingerprint);
		if (!fingerprint || fingerprint !== state.fingerprint) {
			stats.rejected_corrections++;
			continue;
		}
		const nextVersion = validVersion(event.version);
		if (nextVersion === null || nextVersion !== state.version + 1) {
			stats.rejected_corrections++;
			continue;
		}
		const replacement = {
			...current,
			event: 'delegation_end',
			record_id: recordId,
			version: event.version,
			digest: event.digest,
			cost_evidence: event.cost_evidence,
			evidence_status: event.evidence_status,
			evidence_reason: event.evidence_reason,
			currency: event.currency,
			cost_usd: event.cost_usd,
			cost_source: event.cost_source,
			tokens_input: event.tokens_input,
			tokens_output: event.tokens_output,
			tokens_reasoning: event.tokens_reasoning,
			tokens_cache: event.tokens_cache,
		};
		const digest =
			boundedDigest(event.digest) ?? costSnapshotDigest(replacement);
		if (digest === state.digest) {
			stats.duplicate_corrections++;
			states.set(recordId, {
				version: nextVersion,
				digest: state.digest,
				fingerprint: state.fingerprint,
			});
			continue;
		}
		const currentEvidence = readEventEvidence(current);
		const nextEvidence = readEventEvidence(replacement);
		if (hasReportConflict(nextEvidence)) {
			stats.conflict_count++;
			stats.rejected_corrections++;
			continue;
		}
		if (!isCostUpgrade(currentEvidence, nextEvidence)) {
			stats.rejected_corrections++;
			continue;
		}
		rows.set(recordId, replacement);
		states.set(recordId, {
			version: nextVersion,
			digest,
			fingerprint: state.fingerprint,
		});
		stats.accepted_corrections++;
	}
	return {
		events: [...legacy, ...rows.values()],
		stats,
		versions: Object.fromEntries(
			[...states].map(([recordId, state]) => [recordId, state.version]),
		),
	};
}

function boundedId(value: unknown): string | null {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value)
		? value
		: null;
}

function boundedDigest(value: unknown): string | undefined {
	return typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value)
		? value
		: undefined;
}

function validVersion(value: unknown): number | null {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 100_000
		? value
		: null;
}

function readEventEvidence(event: Record<string, unknown>): CostEvidence[] {
	const value = event.cost_evidence ?? event.evidence;
	if (!Array.isArray(value)) return legacyEventEvidence(event);
	return value.slice(0, MAX_EVIDENCE_ITEMS).flatMap((item): CostEvidence[] => {
		if (!isRecord(item)) return [];
		const kind =
			item.kind === 'provider_reported' || item.kind === 'normalized_estimate'
				? item.kind
				: null;
		const sourcePath = isCostSourcePath(item.source_path)
			? item.source_path
			: null;
		const amount = readBoundedReportedCost(item.amount_usd);
		const usage = isRecord(item.usage)
			? readPinnedTokens(item.usage)
			: { ...ZERO_USAGE };
		if (!kind || !sourcePath) return [];
		return [
			{
				kind,
				amount_usd: amount,
				currency: normalizeCurrency(item.currency),
				source_path: sourcePath,
				reason: isCostEvidenceReason(item.reason)
					? item.reason
					: amount === null
						? 'missing_cost'
						: 'authoritative',
				usage,
				model:
					typeof item.model === 'string'
						? item.model.slice(0, MAX_COST_STRING_LENGTH)
						: undefined,
				digest: boundedDigest(item.digest),
			},
		];
	});
}

function legacyEventEvidence(event: Record<string, unknown>): CostEvidence[] {
	const amount = readBoundedReportedCost(event.cost_usd);
	return [
		{
			kind:
				parseCostSource(event.cost_source) === 'estimated'
					? 'normalized_estimate'
					: 'provider_reported',
			amount_usd: amount,
			currency: 'USD',
			source_path: 'legacy.cost',
			reason: amount === null ? 'legacy' : 'authoritative',
			usage: {
				tokens_input: readFiniteNonNegative(event.tokens_input) ?? 0,
				tokens_output: readFiniteNonNegative(event.tokens_output) ?? 0,
				tokens_reasoning: readFiniteNonNegative(event.tokens_reasoning) ?? 0,
				tokens_cache: readFiniteNonNegative(event.tokens_cache) ?? 0,
			},
		},
	];
}

function isCostSourcePath(value: unknown): value is CostEvidenceSourcePath {
	return (
		value === 'assistant.cost' ||
		value === 'step-finish.cost' ||
		value === 'response.info.cost' ||
		value === 'response.cost' ||
		value === 'legacy.cost' ||
		value === 'pricing.model'
	);
}

function isCostEvidenceReason(value: unknown): value is CostEvidenceReason {
	return (
		value === 'authoritative' ||
		value === 'missing_cost' ||
		value === 'invalid_number' ||
		value === 'pricing_missing' ||
		value === 'unsupported_currency' ||
		value === 'conflict' ||
		value === 'unbilled' ||
		value === 'join_miss' ||
		value === 'legacy' ||
		value === 'unreadable' ||
		value === 'partial'
	);
}

function costSnapshotDigest(event: Record<string, unknown>): string {
	// This is intentionally a stable, bounded digest rather than persisted raw
	// provider data. A cryptographic hash is supplied when available by the
	// runtime; this deterministic fallback remains safe for fold-only readers.
	const canonical = JSON.stringify({
		cost_usd: event.cost_usd ?? null,
		cost_source: parseCostSource(event.cost_source),
		tokens_input: readFiniteNonNegative(event.tokens_input) ?? 0,
		tokens_output: readFiniteNonNegative(event.tokens_output) ?? 0,
		tokens_reasoning: readFiniteNonNegative(event.tokens_reasoning) ?? 0,
		tokens_cache: readFiniteNonNegative(event.tokens_cache) ?? 0,
		cost_evidence: Array.isArray(event.cost_evidence)
			? event.cost_evidence.slice(0, MAX_EVIDENCE_ITEMS)
			: undefined,
	});
	let hash = 2166136261;
	for (let i = 0; i < canonical.length; i++)
		hash = Math.imul(hash ^ canonical.charCodeAt(i), 16777619);
	return `${(hash >>> 0).toString(16).padStart(8, '0')}${canonical.length.toString(16).padStart(8, '0')}`.slice(
		0,
		32,
	);
}

function evidenceAuthority(evidence: readonly CostEvidence[]): number {
	const projection = projectCostEvidence(evidence);
	return projection.cost_source === 'reported'
		? 2
		: projection.cost_source === 'estimated'
			? 1
			: 0;
}

export function isCostUpgrade(
	current: readonly CostEvidence[],
	next: readonly CostEvidence[],
): boolean {
	const currentProjection = projectCostEvidence(current);
	const nextProjection = projectCostEvidence(next);
	const currentAuthority = evidenceAuthority(current);
	const nextAuthority = evidenceAuthority(next);
	if (nextAuthority > currentAuthority) return true;
	if (nextAuthority < currentAuthority) return false;
	if (currentProjection.cost_usd !== nextProjection.cost_usd) return true;
	const currentUsage = current.reduce(mergeUsage, { ...ZERO_USAGE });
	const nextUsage = next.reduce(mergeUsage, { ...ZERO_USAGE });
	return Object.keys(currentUsage).some(
		(key) =>
			nextUsage[key as keyof TokenUsage] >
			currentUsage[key as keyof TokenUsage],
	);
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
	let tmpDir: string;
	try {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-snapshot-'));
	} catch {
		return [{ event: 'delegation_cost_join', reason: 'unreadable' }];
	}
	const snapshotFiles: string[] = [];
	let telemetryErrors = 0;
	try {
		for (const file of files) {
			if (!fs.existsSync(file)) continue;
			const snap = path.join(tmpDir, path.basename(file));
			try {
				const stat = fs.statSync(file);
				if (!stat.isFile() || stat.size > MAX_TELEMETRY_FILE_BYTES) {
					telemetryErrors++;
					continue;
				}
				fs.copyFileSync(file, snap);
				snapshotFiles.push(snap);
			} catch {
				// If copy fails, skip this file (best-effort snapshot)
				telemetryErrors++;
			}
		}
	} catch {
		// mkdtemp or copy failure — fall through to empty result
		telemetryErrors++;
	}

	const events: Record<string, unknown>[] = [];
	// Issue #2349 sweep: an unreadable snapshot silently undercounted cost with
	// no signal at all, so a systematic cause (permissions, a partial copy)
	// looked identical to "there was nothing to read". Count and name the first
	// failure so the undercount is observable under OPENCODE_SWARM_DEBUG=1
	// (`warn` is debug-gated; this is not promoted to criticalWarn because the
	// site is advisory, not an operator-must-see signal).
	let unreadableSnapshots = 0;
	let firstUnreadableReason = '';
	for (const file of snapshotFiles) {
		let content = '';
		try {
			content = fs.readFileSync(file, 'utf-8');
		} catch (err) {
			unreadableSnapshots += 1;
			if (!firstUnreadableReason) {
				firstUnreadableReason =
					err instanceof Error ? err.message : String(err);
			}
			continue;
		}
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (isRecord(parsed)) events.push(parsed);
			} catch {
				telemetryErrors++;
			}
		}
	}
	if (unreadableSnapshots > 0) {
		telemetryErrors += unreadableSnapshots;
		warn(
			`[cost-accounting] ${unreadableSnapshots} of ${snapshotFiles.length} snapshot file(s) were unreadable; cost totals undercount. First reason: ${firstUnreadableReason}`,
		);
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
	if (telemetryErrors > 0) {
		events.push({ event: 'delegation_cost_join', reason: 'unreadable' });
	}
	return events;
}

/**
 * Bounded asynchronous telemetry reader for live recovery paths. The status
 * service and offline summaries retain the atomic synchronous snapshot above;
 * recovery must not block event delivery on a full-file synchronous read.
 */
export async function readTelemetryEventsAsync(
	directory: string,
): Promise<Record<string, unknown>[]> {
	const swarmDir = path.join(directory, '.swarm');
	const files = [
		path.join(swarmDir, 'telemetry.jsonl.1'),
		path.join(swarmDir, 'telemetry.jsonl'),
	];
	let telemetryErrors = 0;
	const contents = await Promise.all(
		files.map(async (file) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const stat = await Promise.race([
					fsp.stat(file),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('telemetry stat timeout')),
							ASYNC_TELEMETRY_READ_TIMEOUT_MS,
						);
					}),
				]);
				if (!stat.isFile() || stat.size > MAX_TELEMETRY_FILE_BYTES) {
					telemetryErrors++;
					return '';
				}
				if (timer) clearTimeout(timer);
				timer = undefined;
				const content = await Promise.race([
					fsp.readFile(file, 'utf8'),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error('telemetry read timeout')),
							ASYNC_TELEMETRY_READ_TIMEOUT_MS,
						);
					}),
				]);
				return content;
			} catch {
				telemetryErrors++;
				return '';
			} finally {
				if (timer) clearTimeout(timer);
			}
		}),
	);
	const events: Record<string, unknown>[] = [];
	for (const content of contents) {
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (isRecord(parsed)) events.push(parsed);
			} catch {
				telemetryErrors++;
			}
		}
	}
	if (telemetryErrors > 0) {
		events.push({ event: 'delegation_cost_join', reason: 'unreadable' });
	}
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
	const hasUsage = Object.values(usage).some((value) => value > 0);
	return hasUsage && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function collectPinnedCandidates(
	raw: unknown,
	input: Pick<
		DelegationCostInput,
		'model' | 'pricing' | 'reported_cost_currency'
	>,
): CostCandidate[] {
	if (!isRecord(raw)) return [];
	const candidates: CostCandidate[] = [];
	const add = (
		value: unknown,
		pathName: CostEvidenceSourcePath,
		pinned: boolean,
	): void => {
		if (!isRecord(value)) return;
		const model = readModelIdentifier(value) ?? input.model;
		const tokens = readPinnedTokens(value);
		const rawCost = value.cost;
		if (rawCost === undefined && pinned) {
			// A pinned shape with no cost is still useful token evidence, but it is
			// not a monetary report.
			candidates.push({
				kind: 'provider_reported',
				amount: null,
				currency: 'unknown',
				source_path: pathName,
				usage: tokens,
				model,
				reason: 'missing_cost',
			});
			return;
		}
		if (rawCost === undefined) return;
		const amount = readBoundedReportedCost(rawCost);
		const currency = pinned ? reportedCurrency(model, input) : 'USD'; // Legacy scalar records were historically interpreted as USD.
		candidates.push({
			kind: 'provider_reported',
			amount,
			currency,
			source_path: pathName,
			usage: tokens,
			model,
			reason: amount === null ? 'invalid_number' : undefined,
		});
	};

	// AssistantMessage and StepFinishPart are deliberately guarded by their
	// discriminators. Only these fixed paths are provider authority.
	if (raw.role === 'assistant') add(raw, 'assistant.cost', true);
	if (isRecord(raw.assistant) && raw.assistant.role === 'assistant')
		add(raw.assistant, 'assistant.cost', true);
	if (raw.type === 'step-finish') add(raw, 'step-finish.cost', true);
	if (isRecord(raw.part) && raw.part.type === 'step-finish')
		add(raw.part, 'step-finish.cost', true);

	const data = isRecord(raw.data) ? raw.data : undefined;
	const info =
		data && isRecord(data.info)
			? data.info
			: isRecord(raw.info)
				? raw.info
				: undefined;
	if (info) add(info, 'response.info.cost', true);
	if (data && (data.type === 'assistant' || data.role === 'assistant'))
		add(data, 'response.cost', true);

	if (candidates.length === 0) {
		// Keep old producer payloads readable, but do not recursively inspect
		// arbitrary metadata. This compatibility branch is intentionally one
		// level deep and never outranks a pinned candidate.
		const legacy = isRecord(raw.output) ? raw.output : raw;
		const usageRecord = isRecord(legacy.usage) ? legacy.usage : legacy;
		const usage = readPinnedTokens(usageRecord);
		const amount = readBoundedReportedCost(
			legacy.cost_usd ?? legacy.total_cost_usd ?? legacy.cost,
		);
		if (
			amount !== null ||
			legacy.cost_usd !== undefined ||
			legacy.cost !== undefined
		) {
			candidates.push({
				kind: 'provider_reported',
				amount,
				currency: 'USD',
				source_path: 'legacy.cost',
				usage,
				model: readModelIdentifier(legacy) ?? input.model,
				reason: amount === null ? 'invalid_number' : undefined,
			});
		}
	}
	return candidates.slice(0, MAX_EVIDENCE_ITEMS);
}

function readPinnedTokens(record: Record<string, unknown>): TokenUsage {
	const tokens = isRecord(record.tokens)
		? record.tokens
		: isRecord(record.usage)
			? record.usage
			: record;
	return {
		tokens_input:
			readFiniteNonNegative(
				tokens.tokens_input ??
					tokens.input ??
					tokens.input_tokens ??
					tokens.prompt_tokens,
			) ?? 0,
		tokens_output:
			readFiniteNonNegative(
				tokens.tokens_output ??
					tokens.output ??
					tokens.output_tokens ??
					tokens.completion_tokens,
			) ?? 0,
		tokens_reasoning:
			readFiniteNonNegative(
				tokens.tokens_reasoning ?? tokens.reasoning ?? tokens.reasoning_tokens,
			) ?? 0,
		tokens_cache:
			readFiniteNonNegative(tokens.tokens_cache) ??
			readCacheTokens(tokens) ??
			0,
	};
}

function readLegacyUsage(raw: unknown): TokenUsage {
	if (!isRecord(raw)) return { ...ZERO_USAGE };
	const output = isRecord(raw.output) ? raw.output : raw;
	const usage = isRecord(output.usage) ? output.usage : output;
	return readPinnedTokens(usage);
}

function mergeUsage(
	total: TokenUsage,
	next: { usage?: TokenUsage } | TokenUsage,
): TokenUsage {
	const usage =
		'usage' in next && next.usage ? next.usage : (next as TokenUsage);
	return {
		tokens_input: Math.max(total.tokens_input, usage.tokens_input),
		tokens_output: Math.max(total.tokens_output, usage.tokens_output),
		tokens_reasoning: Math.max(total.tokens_reasoning, usage.tokens_reasoning),
		tokens_cache: Math.max(total.tokens_cache, usage.tokens_cache),
	};
}

function readFiniteNonNegative(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function readBoundedReportedCost(value: unknown): number | null {
	const amount = readFiniteNonNegative(value);
	return amount !== null && amount <= MAX_PROVIDER_REPORTED_COST_USD
		? amount
		: null;
}

function normalizeCurrency(value: unknown): CostCurrency {
	if (typeof value !== 'string' || value.trim() === '') return 'unknown';
	const currency = value.trim().slice(0, MAX_COST_STRING_LENGTH).toUpperCase();
	return currency || 'unknown';
}

function boundedCostLabel(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== ''
		? value.trim().slice(0, MAX_COST_STRING_LENGTH)
		: undefined;
}

function reportedCurrency(
	model: string | undefined,
	input: Pick<DelegationCostInput, 'pricing' | 'reported_cost_currency'>,
): CostCurrency {
	if (input.reported_cost_currency)
		return normalizeCurrency(input.reported_cost_currency);
	const provider = model?.split('/')[0];
	const configured = input.pricing?.reported_cost_currency;
	const value = provider ? configured?.[provider] : undefined;
	return normalizeCurrency(value);
}

function hasReportConflict(reports: readonly CostEvidence[]): boolean {
	const monetary = reports.filter(
		(item) => item.kind === 'provider_reported' && item.amount_usd !== null,
	);
	for (let i = 0; i < monetary.length; i++) {
		for (let j = i + 1; j < monetary.length; j++) {
			const left = monetary[i];
			const right = monetary[j];
			if (left.currency !== right.currency) return true;
			if (
				left.currency === 'USD' &&
				!withinCostTolerance(left.amount_usd ?? 0, right.amount_usd ?? 0)
			)
				return true;
		}
	}
	return false;
}

function withinCostTolerance(left: number, right: number): boolean {
	return (
		Math.abs(left - right) <=
		Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 1e-6)
	);
}

function _extractUsageAndCost(raw: unknown): {
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
	const read = readNumber(cacheRecord, [
		'read',
		'cache_read_input_tokens',
		'cached_input_tokens',
	]);
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
		total_legacy_usd: 0,
		conflict_count: 0,
		legacy_count: 0,
		join_miss_count: 0,
		telemetry_error_count: 0,
		accepted_corrections: 0,
		rejected_corrections: 0,
		duplicate_corrections: 0,
		evidence_status: 'complete',
		currencies: [],
	};
}

function addDelegationEvent(
	summary: CostSummary,
	event: Record<string, unknown>,
): void {
	const legacyCostSource = parseCostSource(event.cost_source);
	const legacyCost = readNumber(event, ['cost_usd']) ?? 0;
	const hasRecord = boundedId(event.record_id ?? event.recordId) !== null;
	const evidence = readEventEvidence(event);
	const projection = projectCostEvidence(evidence);
	const costSource = hasRecord ? projection.cost_source : legacyCostSource;
	const cost = hasRecord ? (projection.cost_usd ?? 0) : legacyCost;
	if (!hasRecord) {
		summary.legacy_count++;
		summary.total_legacy_usd += legacyCost;
		summary.evidence_status = 'inconclusive';
	}
	if (projection.evidence_status === 'inconclusive')
		summary.evidence_status = 'inconclusive';
	for (const item of evidence) {
		if (
			item.currency !== 'unknown' &&
			!summary.currencies.includes(item.currency)
		)
			summary.currencies.push(item.currency);
	}
	const legacyUsage = {
		tokens_input: readNumber(event, ['tokens_input']) ?? 0,
		tokens_output: readNumber(event, ['tokens_output']) ?? 0,
		tokens_reasoning: readNumber(event, ['tokens_reasoning']) ?? 0,
		tokens_cache: readNumber(event, ['tokens_cache']) ?? 0,
	};
	// Report and estimate evidence commonly carry the same usage snapshot, so
	// take the per-component maximum rather than summing duplicate copies.
	const evidenceUsage = evidence.reduce<TokenUsage>(
		(acc, item) => ({
			tokens_input: Math.max(acc.tokens_input, item.usage.tokens_input),
			tokens_output: Math.max(acc.tokens_output, item.usage.tokens_output),
			tokens_reasoning: Math.max(
				acc.tokens_reasoning,
				item.usage.tokens_reasoning,
			),
			tokens_cache: Math.max(acc.tokens_cache, item.usage.tokens_cache),
		}),
		{ ...ZERO_USAGE },
	);
	const usage = hasRecord ? evidenceUsage : legacyUsage;

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
	summary.total_legacy_usd = roundUsd(summary.total_legacy_usd);
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

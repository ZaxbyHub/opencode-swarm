/**
 * Schemas and helpers for the hierarchical architecture-summary system (issue #893).
 *
 * Three tiers roll up task -> phase -> project:
 *  - AgentWorkSummary: short, structured "what I did" emitted by each worker/architect
 *    at task completion (stored as a `note` evidence entry, payload under metadata).
 *  - PhaseArchitectureSummary: cheap-model compression of all agent summaries in a phase
 *    (written as a raw sidecar, like phase-council.json).
 *  - ArchitectureSupervisorReport: the expensive read-only critic's verdict over the
 *    compressed summaries (also a raw sidecar so top-level fields survive).
 *
 * Caps are enforced by truncation (not rejection) to match the repo's lenient evidence
 * style; callers use the normalize* helpers before validation and surface a `truncated`
 * flag in metadata.
 */

import { z } from 'zod';

export const SUMMARY_SCHEMA_VERSION = '1.0.0';

/** Default caps (config can lower these per-feature; schemas use them as hard bounds). */
export const MAX_AGENT_SUMMARY_WORDS = 100;
export const MAX_PHASE_SUMMARY_WORDS = 250;
export const MAX_LIST_ITEMS = 5;

/** Verdict vocabulary — mirrors the phase-council gate (APPROVE | CONCERNS | REJECT). */
export const SupervisorVerdictSchema = z.enum([
	'APPROVE',
	'CONCERNS',
	'REJECT',
]);
export type SupervisorVerdict = z.infer<typeof SupervisorVerdictSchema>;

/** Count whitespace-delimited words in a string. */
export function countWords(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\s+/).length;
}

/** Truncate to `maxWords`, appending an ellipsis marker when content was dropped. */
export function truncateWords(
	text: string,
	maxWords: number,
): { text: string; truncated: boolean } {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { text: trimmed, truncated: false };
	const words = trimmed.split(/\s+/);
	if (words.length <= maxWords) return { text: trimmed, truncated: false };
	return { text: `${words.slice(0, maxWords).join(' ')}…`, truncated: true };
}

/** Cap an array to `maxItems`, reporting whether anything was dropped. */
export function capArray<T>(
	items: T[],
	maxItems: number,
): { items: T[]; truncated: boolean } {
	if (items.length <= maxItems) return { items, truncated: false };
	return { items: items.slice(0, maxItems), truncated: true };
}

// ---------------------------------------------------------------------------
// Tier 1: per-agent work summary
// ---------------------------------------------------------------------------

export const AgentWorkSummarySchema = z.object({
	schema_version: z.literal(SUMMARY_SCHEMA_VERSION),
	phase: z.number().int().min(0).max(999),
	task_id: z.string().min(1).optional(),
	session_id: z.string().min(1),
	agent: z.string().min(1),
	parent_agent: z.string().min(1).optional(),
	summary: z.string().min(1),
	key_decisions: z.array(z.string().min(1)).max(MAX_LIST_ITEMS).default([]),
	constraints_observed: z
		.array(z.string().min(1))
		.max(MAX_LIST_ITEMS)
		.default([]),
	constraints_violated: z
		.array(z.string().min(1))
		.max(MAX_LIST_ITEMS)
		.default([]),
	assumptions: z.array(z.string().min(1)).max(MAX_LIST_ITEMS).default([]),
	risks: z.array(z.string().min(1)).max(MAX_LIST_ITEMS).default([]),
	files_touched: z.array(z.string().min(1)).max(50).optional(),
	evidence_refs: z.array(z.string().min(1)).max(20).default([]),
	created_at: z.string().datetime(),
	/** Set when caps forced truncation; advisory only. */
	truncated: z.boolean().optional(),
});
export type AgentWorkSummary = z.infer<typeof AgentWorkSummarySchema>;

/**
 * Raw, pre-validation fields a caller supplies. Caps are applied here, then the result
 * is validated against AgentWorkSummarySchema. Returns the normalized summary plus a
 * `truncated` flag aggregated across all fields.
 */
export interface AgentWorkSummaryInput {
	phase: number;
	task_id?: string;
	session_id: string;
	agent: string;
	parent_agent?: string;
	summary: string;
	key_decisions?: string[];
	constraints_observed?: string[];
	constraints_violated?: string[];
	assumptions?: string[];
	risks?: string[];
	files_touched?: string[];
	evidence_refs?: string[];
	created_at?: string;
}

export function normalizeAgentWorkSummary(
	input: AgentWorkSummaryInput,
	maxSummaryWords: number = MAX_AGENT_SUMMARY_WORDS,
): AgentWorkSummary {
	let truncated = false;
	const sum = truncateWords(input.summary, maxSummaryWords);
	truncated ||= sum.truncated;

	const cap = (items: string[] | undefined) => {
		const r = capArray(items ?? [], MAX_LIST_ITEMS);
		truncated ||= r.truncated;
		return r.items;
	};

	const candidate = {
		schema_version: SUMMARY_SCHEMA_VERSION as typeof SUMMARY_SCHEMA_VERSION,
		phase: input.phase,
		task_id: input.task_id,
		session_id: input.session_id,
		agent: input.agent,
		parent_agent: input.parent_agent,
		summary: sum.text,
		key_decisions: cap(input.key_decisions),
		constraints_observed: cap(input.constraints_observed),
		constraints_violated: cap(input.constraints_violated),
		assumptions: cap(input.assumptions),
		risks: cap(input.risks),
		files_touched: input.files_touched
			? capArray(input.files_touched, 50).items
			: undefined,
		evidence_refs: capArray(input.evidence_refs ?? [], 20).items,
		created_at: input.created_at ?? new Date().toISOString(),
		truncated: truncated || undefined,
	};

	return AgentWorkSummarySchema.parse(candidate);
}

// ---------------------------------------------------------------------------
// Tier 2: per-phase architecture summary (cheap-model rollup)
// ---------------------------------------------------------------------------

export const PhaseArchitectureSummarySchema = z.object({
	schema_version: z.literal(SUMMARY_SCHEMA_VERSION),
	phase: z.number().int().min(0).max(999),
	summary: z.string().default(''),
	agents_seen: z.array(z.string().min(1)).default([]),
	tasks_seen: z.array(z.string().min(1)).default([]),
	key_decisions: z.array(z.string().min(1)).default([]),
	conflicts: z.array(z.string().min(1)).default([]),
	unresolved_risks: z.array(z.string().min(1)).default([]),
	constraint_violations: z.array(z.string().min(1)).default([]),
	evidence_refs: z.array(z.string().min(1)).default([]),
	created_at: z.string().datetime(),
});
export type PhaseArchitectureSummary = z.infer<
	typeof PhaseArchitectureSummarySchema
>;

// ---------------------------------------------------------------------------
// Tier 3: architecture-supervisor report (expensive critic verdict)
// ---------------------------------------------------------------------------

export const SupervisorFindingSchema = z.object({
	severity: z.enum(['low', 'medium', 'high', 'critical']),
	category: z.string().min(1),
	agents: z.array(z.string().min(1)).default([]),
	tasks: z.array(z.string().min(1)).default([]),
	evidence_refs: z.array(z.string().min(1)).default([]),
	description: z.string().min(1),
	recommendation: z.string().default(''),
});
export type SupervisorFinding = z.infer<typeof SupervisorFindingSchema>;

export const KnowledgeRecommendationSchema = z.object({
	lesson: z.string().min(1),
	target_agents: z.array(z.string().min(1)).default([]),
	confidence: z.number().min(0).max(1).default(0.5),
	evidence_refs: z.array(z.string().min(1)).default([]),
});
export type KnowledgeRecommendation = z.infer<
	typeof KnowledgeRecommendationSchema
>;

export const ArchitectureSupervisorReportSchema = z.object({
	schema_version: z.literal(SUMMARY_SCHEMA_VERSION),
	phase: z.number().int().min(0).max(999),
	verdict: SupervisorVerdictSchema,
	findings: z.array(SupervisorFindingSchema).default([]),
	knowledge_recommendations: z.array(KnowledgeRecommendationSchema).default([]),
	created_at: z.string().datetime(),
});
export type ArchitectureSupervisorReport = z.infer<
	typeof ArchitectureSupervisorReportSchema
>;

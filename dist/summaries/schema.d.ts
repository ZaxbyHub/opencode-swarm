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
export declare const SUMMARY_SCHEMA_VERSION = "1.0.0";
/** Default caps (config can lower these per-feature; schemas use them as hard bounds). */
export declare const MAX_AGENT_SUMMARY_WORDS = 100;
export declare const MAX_PHASE_SUMMARY_WORDS = 250;
export declare const MAX_LIST_ITEMS = 5;
/** Verdict vocabulary — mirrors the phase-council gate (APPROVE | CONCERNS | REJECT). */
export declare const SupervisorVerdictSchema: z.ZodEnum<{
    APPROVE: "APPROVE";
    REJECT: "REJECT";
    CONCERNS: "CONCERNS";
}>;
export type SupervisorVerdict = z.infer<typeof SupervisorVerdictSchema>;
/** Count whitespace-delimited words in a string. */
export declare function countWords(text: string): number;
/** Truncate to `maxWords`, appending an ellipsis marker when content was dropped. */
export declare function truncateWords(text: string, maxWords: number): {
    text: string;
    truncated: boolean;
};
/** Cap an array to `maxItems`, reporting whether anything was dropped. */
export declare function capArray<T>(items: T[], maxItems: number): {
    items: T[];
    truncated: boolean;
};
export declare const AgentWorkSummarySchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"1.0.0">;
    phase: z.ZodNumber;
    task_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodString;
    agent: z.ZodString;
    parent_agent: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    key_decisions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    constraints_observed: z.ZodDefault<z.ZodArray<z.ZodString>>;
    constraints_violated: z.ZodDefault<z.ZodArray<z.ZodString>>;
    assumptions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    risks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    files_touched: z.ZodOptional<z.ZodArray<z.ZodString>>;
    evidence_refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    created_at: z.ZodString;
    truncated: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
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
export declare function normalizeAgentWorkSummary(input: AgentWorkSummaryInput, maxSummaryWords?: number): AgentWorkSummary;
export declare const PhaseArchitectureSummarySchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"1.0.0">;
    phase: z.ZodNumber;
    summary: z.ZodDefault<z.ZodString>;
    agents_seen: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tasks_seen: z.ZodDefault<z.ZodArray<z.ZodString>>;
    key_decisions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    conflicts: z.ZodDefault<z.ZodArray<z.ZodString>>;
    unresolved_risks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    constraint_violations: z.ZodDefault<z.ZodArray<z.ZodString>>;
    evidence_refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    created_at: z.ZodString;
}, z.core.$strip>;
export type PhaseArchitectureSummary = z.infer<typeof PhaseArchitectureSummarySchema>;
export declare const SupervisorFindingSchema: z.ZodObject<{
    severity: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        critical: "critical";
    }>;
    category: z.ZodString;
    agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
    tasks: z.ZodDefault<z.ZodArray<z.ZodString>>;
    evidence_refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    description: z.ZodString;
    recommendation: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SupervisorFinding = z.infer<typeof SupervisorFindingSchema>;
export declare const KnowledgeRecommendationSchema: z.ZodObject<{
    lesson: z.ZodString;
    target_agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
    confidence: z.ZodDefault<z.ZodNumber>;
    evidence_refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type KnowledgeRecommendation = z.infer<typeof KnowledgeRecommendationSchema>;
export declare const ArchitectureSupervisorReportSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"1.0.0">;
    phase: z.ZodNumber;
    verdict: z.ZodEnum<{
        APPROVE: "APPROVE";
        REJECT: "REJECT";
        CONCERNS: "CONCERNS";
    }>;
    findings: z.ZodDefault<z.ZodArray<z.ZodObject<{
        severity: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
            critical: "critical";
        }>;
        category: z.ZodString;
        agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
        tasks: z.ZodDefault<z.ZodArray<z.ZodString>>;
        evidence_refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
        description: z.ZodString;
        recommendation: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    knowledge_recommendations: z.ZodDefault<z.ZodArray<z.ZodObject<{
        lesson: z.ZodString;
        target_agents: z.ZodDefault<z.ZodArray<z.ZodString>>;
        confidence: z.ZodDefault<z.ZodNumber>;
        evidence_refs: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    created_at: z.ZodString;
}, z.core.$strip>;
export type ArchitectureSupervisorReport = z.infer<typeof ArchitectureSupervisorReportSchema>;

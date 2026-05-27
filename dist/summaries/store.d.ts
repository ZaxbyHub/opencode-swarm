/**
 * Persistence for the architecture-summary tiers (issue #893).
 *
 * Storage strategy (verified against the evidence system):
 *  - Per-agent summaries are stored as `note` evidence entries via saveEvidence(), with
 *    the structured payload under `metadata` (EvidenceBundleSchema parses entries through
 *    a discriminated union and strips unknown top-level keys, so the payload MUST live in
 *    metadata).
 *  - Phase summaries and the supervisor report are written as raw sidecar bundles
 *    (temp-file + rename), mirroring submit-phase-council-verdicts.ts, so the gate can
 *    read top-level fields (verdict, phase_number, timestamp) without zod stripping them.
 */
import { type AgentWorkSummary, type ArchitectureSupervisorReport, type PhaseArchitectureSummary } from './schema';
export declare const AGENT_SUMMARY_METADATA_KIND = "agent_summary";
/**
 * Persist a per-agent work summary as a `note` evidence entry. The structured payload
 * lives entirely under metadata so it survives EvidenceBundleSchema validation.
 * Keyed by the agent's task_id when present, else a synthetic phase-scoped bucket.
 */
export declare function writeAgentSummary(directory: string, summary: AgentWorkSummary): Promise<string>;
export interface ListAgentSummariesFilter {
    phase?: number;
    session?: string;
}
/**
 * Scan all evidence bundles and return the agent work summaries matching the filter.
 * Malformed payloads are skipped (logged, never thrown) so aggregation stays fail-open.
 */
export declare function listAgentSummaries(directory: string, filter?: ListAgentSummariesFilter): Promise<AgentWorkSummary[]>;
export declare function writePhaseArchitectureSummary(directory: string, summary: PhaseArchitectureSummary): string;
export declare function readPhaseArchitectureSummary(directory: string, phase: number): PhaseArchitectureSummary | null;
/**
 * Write the supervisor report as a raw sidecar bundle whose single entry carries
 * top-level `verdict`, `phase_number`, and `timestamp` — exactly the shape the
 * phase-complete gate reads via fs.readFileSync + JSON.parse (mirrors phase-council).
 */
export declare function writeSupervisorReport(directory: string, report: ArchitectureSupervisorReport): string;
/** A single raw supervisor entry as read back from the sidecar (untyped JSON). */
export interface RawSupervisorEntry {
    type: string;
    phase_number?: number;
    timestamp?: string;
    verdict?: string;
    findings?: unknown[];
    knowledge_recommendations?: unknown[];
}
/**
 * Read the supervisor report sidecar raw (no zod), returning the supervisor entry or
 * null when the file is missing/malformed. This is the read path the gate uses.
 */
export declare function readSupervisorReportRaw(directory: string, phase: number): RawSupervisorEntry | null;

/**
 * Phase-level aggregation of per-agent work summaries (issue #893, Chunk B).
 *
 * Deterministic, cheap rollup that runs in the non-blocking phase-monitor hook: it reads
 * the agent summaries for a completed phase, unions their decisions/risks/violations, and
 * surfaces cross-agent contradictions (a constraint one agent observed but another
 * violated). The result is written as a raw sidecar that the architecture-supervisor
 * critic reviews in Chunk C. No LLM call here — keeps the hook fast and side-effect-light.
 */
import { type PhaseArchitectureSummary } from './schema';
export interface AggregatePhaseOptions {
    /** Override the timestamp source (tests). */
    now?: () => string;
    /** Word cap for the rollup summary text. */
    maxPhaseSummaryWords?: number;
}
/**
 * Aggregate all agent summaries for `phase` into a PhaseArchitectureSummary and persist
 * it as a sidecar. Returns the summary, or null when there are no agent summaries for the
 * phase (nothing to roll up — the sidecar is not written in that case).
 */
export declare function aggregatePhaseSummary(directory: string, phase: number, options?: AggregatePhaseOptions): Promise<PhaseArchitectureSummary | null>;

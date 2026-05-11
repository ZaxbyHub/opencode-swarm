import { type LaneEvidence, listLaneEvidence, readPhaseEvidence } from './evidence';
/**
 * Configuration options for phase critic dispatch.
 */
export interface LeanTurboPhaseCriticConfig {
    /**
     * Override the critic agent name.
     * Default: derived from `generatedAgentNames` via `{swarmId}_critic` pattern
     * when a swarm has multiple critics, or `critic` for the default swarm.
     */
    criticAgent?: string;
    /**
     * Timeout in milliseconds for the critic dispatch.
     * Default: no timeout (critic is awaited indefinitely).
     */
    timeoutMs?: number;
}
/**
 * Result of a phase critic dispatch.
 */
export interface PhaseCriticResult {
    /** Critic verdict */
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
    /** Human-readable reason for the verdict */
    reason?: string;
    /** Path to the persisted critic evidence file */
    evidencePath: string;
}
/**
 * Reviewer evidence record (lean-turbo-reviewer.json).
 */
interface ReviewerEvidence {
    phase: number;
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    reason?: string | null;
    timestamp: string;
}
/**
 * Resolves the default critic agent name from the generated agent names.
 *
 * Uses the `{swarmId}_critic` pattern for named swarms and bare `critic`
 * for the default swarm. Follows the same suffix-based resolution used by
 * `getCanonicalAgentRole` so that arbitrary swarm prefixes are handled correctly.
 */
declare function resolveDefaultCriticAgent(generatedAgentNames: string[]): string;
/**
 * Reads the reviewer evidence from .swarm/evidence/{phase}/lean-turbo-reviewer.json.
 *
 * @returns Parsed reviewer evidence, or null if file does not exist or is invalid
 */
declare function readReviewerEvidence(directory: string, phase: number): Promise<ReviewerEvidence | null>;
/**
 * Compiles a structured boundary review package from reviewer and phase evidence.
 */
interface CriticPackage {
    phase: number;
    sessionID: string;
    /** Reviewer verdict if available */
    reviewerVerdict?: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    /** Whether reviewer evidence was missing or invalid */
    reviewerMissing: boolean;
    /** Safety concerns noted during compilation */
    safetyConcerns: string[];
    laneSummaries: Array<{
        laneId: string;
        taskIds: string[];
        files: string[];
        status: LaneEvidence['status'];
        agent?: string;
    }>;
    filesChanged: string[];
    testResults: {
        totalLanes: number;
        completedLanes: number;
        failedLanes: number;
    };
    degradationSummary: {
        totalDegraded: number;
        resolvedDegraded: number;
        pendingDegraded: number;
    };
}
declare function compileCriticPackage(directory: string, phase: number, sessionID: string): Promise<CriticPackage>;
/**
 * Parses a critic verdict from the agent's text response.
 *
 * Looks for a verdict marker line: `VERDICT: APPROVED`, `VERDICT: NEEDS_REVISION`,
 * `VERDICT: REJECTED`, or `VERDICT: ESCALATE_TO_HUMAN` (case-insensitive).
 * Returns null if no marker is found.
 *
 * The optional reason is extracted from a `REASON:` marker line that follows
 * the verdict marker on a subsequent line.
 */
declare function parseCriticVerdict(responseText: string): {
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN';
    reason?: string;
} | null;
/**
 * Writes the critic verdict to the evidence file.
 * Uses atomic write (temp file + rename) to prevent partial-file artifacts.
 */
declare function writeCriticEvidence(directory: string, phase: number, verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED' | 'ESCALATE_TO_HUMAN', reason?: string): Promise<string>;
/**
 * Test-only dependency-injection seam.
 * Allows tests to intercept critic dispatch without mock.module leakage.
 */
export declare const _internals: {
    compileCriticPackage: typeof compileCriticPackage;
    parseCriticVerdict: typeof parseCriticVerdict;
    writeCriticEvidence: typeof writeCriticEvidence;
    dispatchCriticAgent: (directory: string, pkg: CriticPackage, agentName: string, timeoutMs: number) => Promise<string>;
    resolveDefaultCriticAgent: typeof resolveDefaultCriticAgent;
    readReviewerEvidence: typeof readReviewerEvidence;
    listLaneEvidence: typeof listLaneEvidence;
    readPhaseEvidence: typeof readPhaseEvidence;
};
/**
 * Dispatch a read-only critic agent to evaluate boundary conditions for a completed Lean Turbo phase.
 *
 * Steps:
 *  1. Read reviewer evidence from `.swarm/evidence/{phase}/lean-turbo-reviewer.json`
 *  2. Read lane and phase evidence from `.swarm/evidence/{phase}/lean-turbo/`
 *  3. Compile a boundary review package with safety concerns noted
 *  4. Dispatch a read-only critic agent (tools: write=false, edit=false, patch=false)
 *  5. Parse the verdict from the agent's response
 *  6. Write the verdict to `.swarm/evidence/{phase}/lean-turbo-critic.json`
 *  7. Return the result
 *
 * @param directory - Project root directory
 * @param phase - Phase number being reviewed
 * @param sessionID - Lean Turbo session ID
 * @param config - Optional configuration overrides
 * @returns PhaseCriticResult with verdict, optional reason, and evidence path
 * @throws Error if dispatch fails or response cannot be parsed (fail-closed)
 */
export declare function dispatchPhaseCritic(directory: string, phase: number, sessionID: string, config?: LeanTurboPhaseCriticConfig): Promise<PhaseCriticResult>;
export {};

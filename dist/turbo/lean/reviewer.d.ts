import { type LaneEvidence, listLaneEvidence, readPhaseEvidence } from './evidence';
import { readPersisted } from './state';
/**
 * Configuration options for phase reviewer dispatch.
 */
export interface LeanTurboPhaseReviewerConfig {
    /**
     * Override the reviewer agent name.
     * Default: derived from `generatedAgentNames` via `{swarmId}_reviewer` pattern
     * when a swarm has multiple reviewers, or `reviewer` for the default swarm.
     */
    reviewerAgent?: string;
    /**
     * Timeout in milliseconds for the reviewer dispatch.
     * Default: no timeout (reviewer is awaited indefinitely).
     */
    timeoutMs?: number;
    /**
     * Require a diff summary in the compiled review package.
     * When true, the package must include an `integratedDiffSummary` field.
     * Default: false.
     */
    requireDiffSummary?: boolean;
}
/**
 * Result of a phase reviewer dispatch.
 */
export interface PhaseReviewerResult {
    /** Reviewer verdict */
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    /** Human-readable reason for the verdict */
    reason?: string;
    /** Path to the persisted reviewer evidence file */
    evidencePath: string;
}
/**
 * Resolves the default reviewer agent name from the generated agent names.
 *
 * Uses the `{swarmId}_reviewer` pattern for named swarms and bare `reviewer`
 * for the default swarm. Follows the same suffix-based resolution used by
 * `getCanonicalAgentRole` so that arbitrary swarm prefixes are handled correctly.
 */
declare function resolveDefaultReviewerAgent(generatedAgentNames: string[]): string;
/**
 * Compiles a structured review package from lane and phase evidence.
 */
interface ReviewPackage {
    phase: number;
    sessionID: string;
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
    buildStatus: 'unknown' | 'passed' | 'failed';
    degradationSummary: {
        totalDegraded: number;
        resolvedDegraded: number;
        pendingDegraded: number;
    };
    integratedDiffSummary?: string;
}
declare function compileReviewPackage(directory: string, phase: number, sessionID: string, requireDiffSummary: boolean): Promise<ReviewPackage>;
/**
 * Parses a reviewer verdict from the agent's text response.
 *
 * Looks for a verdict marker line: `VERDICT: APPROVED`, `VERDICT: NEEDS_REVISION`,
 * or `VERDICT: REJECTED` (case-insensitive). Returns null if no marker is found.
 *
 * The optional reason is extracted from a `REASON:` marker line that follows
 * the verdict marker on a subsequent line.
 */
declare function parseReviewerVerdict(responseText: string): {
    verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED';
    reason?: string;
} | null;
/**
 * Writes the reviewer verdict to the evidence file.
 * Uses atomic write (temp file + rename) to prevent partial-file artifacts.
 */
declare function writeReviewerEvidence(directory: string, phase: number, verdict: 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED', reason?: string): Promise<string>;
/**
 * Test-only dependency-injection seam.
 * Allows tests to intercept reviewer dispatch without mock.module leakage.
 */
export declare const _internals: {
    compileReviewPackage: typeof compileReviewPackage;
    parseReviewerVerdict: typeof parseReviewerVerdict;
    writeReviewerEvidence: typeof writeReviewerEvidence;
    dispatchReviewerAgent: (directory: string, pkg: ReviewPackage, agentName: string, timeoutMs: number) => Promise<string>;
    resolveDefaultReviewerAgent: typeof resolveDefaultReviewerAgent;
    listLaneEvidence: typeof listLaneEvidence;
    readPhaseEvidence: typeof readPhaseEvidence;
    readPersisted: typeof readPersisted | null;
};
/**
 * Dispatch a read-only reviewer agent to evaluate a completed Lean Turbo phase.
 *
 * Steps:
 *  1. Read all lane evidence from `.swarm/evidence/{phase}/lean-turbo/`
 *  2. Read phase evidence from `.swarm/evidence/{phase}/lean-turbo/lean-turbo-phase.json`
 *  3. Compile a combined review package
 *  4. Dispatch a read-only reviewer agent (tools: write=false, edit=false, patch=false)
 *  5. Parse the verdict from the agent's response
 *  6. Write the verdict to `.swarm/evidence/{phase}/lean-turbo-reviewer.json`
 *  7. Return the result
 *
 * @param directory - Project root directory
 * @param phase - Phase number being reviewed
 * @param sessionID - Lean Turbo session ID
 * @param config - Optional configuration overrides
 * @returns PhaseReviewerResult with verdict, optional reason, and evidence path
 * @throws Error if dispatch fails or response cannot be parsed (fail-closed)
 */
export declare function dispatchPhaseReviewer(directory: string, phase: number, sessionID: string, config?: LeanTurboPhaseReviewerConfig): Promise<PhaseReviewerResult>;
export {};

/**
 * Write drift evidence tool for persisting drift verification results.
 * Accepts phase, verdict, and summary from the Architect and writes
 * a gate-contract formatted evidence file.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the write_drift_evidence tool
 */
export interface WriteDriftEvidenceArgs {
    /** The phase number for the drift verification */
    phase: number;
    /** Verdict of the drift verification: 'APPROVED' or 'NEEDS_REVISION' */
    verdict: 'APPROVED' | 'NEEDS_REVISION';
    /** Human-readable summary of the drift verification */
    summary: string;
    /** Requirement coverage report from req_coverage tool */
    requirementCoverage?: string;
}
/**
 * Execute the write_drift_evidence tool.
 * Validates input, builds a gate-contract entry, and writes to disk.
 * @param args - The write drift evidence arguments
 * @param directory - Working directory
 * @returns JSON string with success status and details
 */
export declare function executeWriteDriftEvidence(args: WriteDriftEvidenceArgs, directory: string): Promise<string>;
/**
 * Tool definition for write_drift_evidence
 */
export declare const write_drift_evidence: ToolDefinition;

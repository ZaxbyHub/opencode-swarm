/**
 * Write hallucination evidence tool for persisting hallucination verification results.
 * Accepts phase, verdict, and summary from the Architect and writes
 * a gate-contract formatted evidence file.
 *
 * Unlike write_drift_evidence, this tool does NOT lock the QA gate profile or
 * write a plan snapshot — those side-effects belong to drift verification only.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the write_hallucination_evidence tool
 */
export interface WriteHallucinationEvidenceArgs {
    /** The phase number for the hallucination verification */
    phase: number;
    /** Verdict of the hallucination verification: 'APPROVED' or 'NEEDS_REVISION' */
    verdict: 'APPROVED' | 'NEEDS_REVISION';
    /** Human-readable summary of the hallucination verification */
    summary: string;
    /** Optional bullet list of FABRICATED/DRIFTED/UNSUPPORTED/BROKEN findings */
    findings?: string;
}
/**
 * Execute the write_hallucination_evidence tool.
 */
export declare function executeWriteHallucinationEvidence(args: WriteHallucinationEvidenceArgs, directory: string): Promise<string>;
/**
 * Tool definition for write_hallucination_evidence
 */
export declare const write_hallucination_evidence: ToolDefinition;

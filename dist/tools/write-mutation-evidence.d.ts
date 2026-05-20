/**
 * Write mutation evidence tool for persisting mutation testing gate results.
 * Accepts phase, verdict, killRate, adjustedKillRate, and summary from the Architect
 * and writes a gate-contract formatted evidence file.
 *
 * Unlike write_drift_evidence, this tool does NOT lock the QA gate profile or
 * write a plan snapshot — those side-effects belong to drift verification only.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the write_mutation_evidence tool
 */
export interface WriteMutationEvidenceArgs {
    /** The phase number for the mutation gate */
    phase: number;
    /** Verdict of the mutation gate: 'PASS', 'WARN', 'FAIL', or 'SKIP' */
    verdict: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
    /** The raw kill rate (e.g., 0.85) */
    killRate?: number;
    /** The adjusted kill rate accounting for timeout survived mutants (e.g., 0.87) */
    adjustedKillRate?: number;
    /** Human-readable summary of the mutation gate result */
    summary: string;
    /** Optional JSON-serialized list of survived mutants */
    survivedMutants?: string;
}
/**
 * Execute the write_mutation_evidence tool.
 */
export declare function executeWriteMutationEvidence(args: WriteMutationEvidenceArgs, directory: string): Promise<string>;
/**
 * Tool definition for write_mutation_evidence
 */
export declare const write_mutation_evidence: ToolDefinition;

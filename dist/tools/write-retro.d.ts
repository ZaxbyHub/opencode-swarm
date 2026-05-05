/**
 * Write retro tool for persisting retrospective evidence bundles.
 * Accepts flat retro fields from the Architect and wraps them correctly
 * in a RetrospectiveEvidence entry before calling saveEvidence().
 * This fixes the bug where Architect was writing flat JSON that failed EvidenceBundleSchema.parse().
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the write_retro tool
 * User-supplied fields (the Architect provides these)
 */
export interface WriteRetroArgs {
    /** The phase number being completed (maps to phase_number in schema) */
    phase: number;
    /** Human-readable phase summary (maps to summary in BaseEvidenceSchema) */
    summary: string;
    /** Count of tasks completed */
    task_count: number;
    /** Task complexity level */
    task_complexity: 'trivial' | 'simple' | 'moderate' | 'complex';
    /** Total number of tool calls in the phase */
    total_tool_calls: number;
    /** Number of coder revisions made */
    coder_revisions: number;
    /** Number of reviewer rejections received */
    reviewer_rejections: number;
    loop_detections?: number;
    circuit_breaker_trips?: number;
    /** Number of test failures encountered */
    test_failures: number;
    /** Number of security findings */
    security_findings: number;
    /** Number of integration issues */
    integration_issues: number;
    /** Optional lessons learned (max 5) */
    lessons_learned?: string[];
    /** Optional top rejection reasons */
    top_rejection_reasons?: string[];
    /** Optional task ID (defaults to retro-{phase}) */
    task_id?: string;
    /** Optional metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Execute the write_retro tool.
 * Validates input, builds a RetrospectiveEvidence entry, and saves to disk.
 * @param args - The write retro arguments
 * @param directory - Working directory
 * @returns JSON string with success status and details
 */
export declare function executeWriteRetro(args: WriteRetroArgs, directory: string): Promise<string>;
/**
 * Tool definition for write_retro
 */
export declare const write_retro: ToolDefinition;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 * Uses getter for write_retro to avoid circular reference at module load time.
 */
export declare const _internals: {
    executeWriteRetro: typeof executeWriteRetro;
    write_retro: typeof write_retro;
};

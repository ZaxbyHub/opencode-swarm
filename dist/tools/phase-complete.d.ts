/**
 * Phase completion tool for tracking and validating phase completion.
 * Core implementation - gathers data, enforces policy, writes event, resets state.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the phase_complete tool
 */
export interface PhaseCompleteArgs {
    /** The phase number being completed */
    phase: number;
    /** Optional summary of the phase */
    summary?: string;
    /** Session ID to track state (optional, defaults to current session context) */
    sessionID?: string;
}
export declare const MAX_OUTPUT_BYTES = 512000;
/**
 * Execute the phase_complete tool
 * Gathers data, enforces policy, writes event, resets state
 */
export declare function executePhaseComplete(args: PhaseCompleteArgs, workingDirectory?: string, directory?: string): Promise<string>;
/** @internal exported for testing only */
export declare function _buildOutputJson(outputData: {
    phase: number;
    success: boolean;
    status: string;
    message?: string;
    agentsDispatched?: string[];
    agentsMissing?: string[];
    warnings?: string[];
    timestamp: string;
    duration_ms: number;
    [key: string]: unknown;
}): string;
/**
 * Tool definition for phase_complete
 */
export declare const phase_complete: ToolDefinition;

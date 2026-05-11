/**
 * Lean Turbo Status Tool.
 * Returns Lean Turbo configuration and active status for the current session.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the lean_turbo_status tool
 */
export interface LeanTurboStatusArgs {
    directory: string;
    sessionID: string;
}
/**
 * Lean Turbo configuration that would be active
 */
export interface LeanTurboStatusConfig {
    max_parallel_coders: number;
    require_declared_scope: boolean;
    degrade_on_risk: boolean;
    conflict_policy: 'degrade' | 'serialize';
}
/**
 * Result from executing lean_turbo_status
 */
export interface LeanTurboStatusResult {
    success: boolean;
    strategy?: 'lean';
    leanActive?: boolean;
    config?: LeanTurboStatusConfig;
    status?: string;
    phase?: number;
    lanes?: number;
    degradedTasks?: number;
    errors?: string[];
}
/**
 * Execute the lean_turbo_status tool.
 * Returns Lean Turbo configuration and active status.
 */
export declare function executeLeanTurboStatus(args: LeanTurboStatusArgs): Promise<LeanTurboStatusResult>;
/**
 * Tool definition for lean_turbo_status
 */
export declare const lean_turbo_status: ToolDefinition;

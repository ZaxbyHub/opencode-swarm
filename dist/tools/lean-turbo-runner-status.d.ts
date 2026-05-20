/**
 * Lean Turbo Runner Status Tool.
 * Reads Lean Turbo run state from .swarm/turbo-state.json.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { type LeanTurboRunState } from '../turbo/lean/state';
/**
 * Arguments for the lean_turbo_runner_status tool
 */
export interface LeanTurboRunnerStatusArgs {
    directory: string;
    sessionID: string;
}
/**
 * Result from executing lean_turbo_runner_status
 */
export interface LeanTurboRunnerStatusResult {
    success: boolean;
    status?: LeanTurboRunState['status'];
    phase?: number;
    lanes?: LeanTurboRunState['lanes'];
    degradedTasks?: LeanTurboRunState['degradedTasks'];
    maxParallelCoders?: number;
    sessionID?: string;
    strategy?: 'lean';
    errors?: string[];
}
/**
 * Execute the lean_turbo_runner_status tool.
 * Reads Lean Turbo run state from .swarm/turbo-state.json.
 */
export declare function executeLeanTurboRunnerStatus(args: LeanTurboRunnerStatusArgs): Promise<LeanTurboRunnerStatusResult>;
/**
 * Tool definition for lean_turbo_runner_status
 */
export declare const lean_turbo_runner_status: ToolDefinition;

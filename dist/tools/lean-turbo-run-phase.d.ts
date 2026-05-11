/**
 * Lean Turbo Run Phase Tool.
 * Wraps LeanTurboRunner to execute a phase using Lean Turbo parallel lane execution.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config';
import type { LaneResult } from '../turbo/lean/runner';
import { LeanTurboRunner as LeanTurboRunner_import } from '../turbo/lean/runner';
/**
 * Arguments for the lean_turbo_run_phase tool
 */
export interface LeanTurboRunPhaseArgs {
    directory: string;
    phase: number;
    sessionID: string;
}
/**
 * Result from executing lean_turbo_run_phase
 */
export interface LeanTurboRunPhaseResult {
    success: boolean;
    lanes?: LaneResult[];
    degradedTasks?: string[];
    serializedTasks?: string[];
    reason?: string;
    errors?: string[];
}
/**
 * Test-only dependency-injection seam.
 * Allows tests to inject mocks without mock.module leakage.
 */
export declare const _internals: {
    LeanTurboRunner: typeof LeanTurboRunner_import;
    loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta_import;
};
/**
 * Execute the lean_turbo_run_phase tool.
 * Creates a LeanTurboRunner and executes the specified phase.
 */
export declare function executeLeanTurboRunPhase(args: LeanTurboRunPhaseArgs): Promise<LeanTurboRunPhaseResult>;
/**
 * Tool definition for lean_turbo_run_phase
 */
export declare const lean_turbo_run_phase: ToolDefinition;

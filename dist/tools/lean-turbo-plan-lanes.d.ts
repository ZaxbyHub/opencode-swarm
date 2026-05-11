/**
 * Lean Turbo Plan Lanes Tool.
 * Wraps planLeanTurboLanes from src/turbo/lean/planner.
 * Partitions phase tasks into parallel lanes based on file-scope conflicts.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import type { LeanTurboLanePlan } from '../turbo/lean/planner';
/**
 * Arguments for the lean_turbo_plan_lanes tool
 */
export interface LeanTurboPlanLanesArgs {
    directory: string;
    phase: number;
    scopes?: Record<string, string[]>;
}
/**
 * Result from executing lean_turbo_plan_lanes
 */
export interface LeanTurboPlanLanesResult {
    success: boolean;
    plan?: LeanTurboLanePlan;
    lanes?: LeanTurboLanePlan['lanes'];
    degradedTasks?: LeanTurboLanePlan['degradedTasks'];
    serializedTasks?: LeanTurboLanePlan['serializedTasks'];
    errors?: string[];
}
/**
 * Execute the lean_turbo_plan_lanes tool.
 * Partitions phase tasks into parallel lanes based on file-scope conflicts.
 */
export declare function executeLeanTurboPlanLanes(args: LeanTurboPlanLanesArgs): Promise<LeanTurboPlanLanesResult>;
/**
 * Tool definition for lean_turbo_plan_lanes
 */
export declare const lean_turbo_plan_lanes: ToolDefinition;

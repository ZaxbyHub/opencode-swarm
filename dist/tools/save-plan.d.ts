/**
 * Save plan tool for persisting validated implementation plans.
 * Allows the Architect agent to save structured plans to .swarm/plan.json and .swarm/plan.md.
 */
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Arguments for the save_plan tool
 */
export interface SavePlanArgs {
    title: string;
    swarm_id: string;
    phases: Array<{
        id: number;
        name: string;
        tasks: Array<{
            id: string;
            description: string;
            size?: 'small' | 'medium' | 'large';
            depends?: string[];
            acceptance?: string;
        }>;
    }>;
    /**
     * Must be the project root directory. When provided, it anchors all .swarm directory
     * creation and plan file operations to the project root (issue #577).
     * Omit to use the fallback directory (injected by createSwarmTool, typically process.cwd()).
     */
    working_directory?: string;
    /**
     * When true, all task statuses are reset to 'pending' and existing completed
     * statuses are NOT preserved.  Use this when creating a fresh revision of a
     * plan where prior completion state should no longer apply (e.g., re-planning
     * after a failed phase).  Defaults to false (existing statuses preserved).
     */
    reset_statuses?: boolean;
    /**
     * Issue #853: tasks that are present in the prior plan but intentionally
     * being removed by this save. Every task missing from `phases` must be
     * enumerated here, otherwise save_plan rejects with
     * `PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED`.
     */
    removed_task_ids?: string[];
    /**
     * Human-readable reason for the removals listed in `removed_task_ids`.
     * Must be non-empty when `removed_task_ids` is non-empty. Recorded on
     * each `task_removed` ledger event for audit.
     */
    removal_reason?: string;
    /**
     * Required when both `reset_statuses` is true AND at least one task is
     * missing from the new plan. Without this flag set, save_plan rejects to
     * prevent a destructive reset from silently dropping unfinished work.
     */
    confirm_destructive_reset?: boolean;
    /**
     * Architect-facing concurrency controls for this plan.
     * When execution_profile.locked is true the profile is immutable — subsequent
     * save_plan calls that try to change it will be rejected (fail-closed).
     * Omit to leave the current profile unchanged.
     */
    execution_profile?: {
        parallelization_enabled?: boolean;
        max_concurrent_tasks?: number;
        council_parallel?: boolean;
        locked?: boolean;
    };
}
/**
 * Result from executing save_plan
 */
export interface SavePlanResult {
    success: boolean;
    message: string;
    plan_path?: string;
    phases_count?: number;
    tasks_count?: number;
    errors?: string[];
    warnings?: string[];
    recovery_guidance?: string;
    /** The resolved execution_profile that was persisted, if any. */
    execution_profile?: {
        parallelization_enabled: boolean;
        max_concurrent_tasks: number;
        council_parallel: boolean;
        locked: boolean;
    };
}
/**
 * Detect template placeholder content (e.g., [task], [Project], [description], [N]).
 * These patterns indicate the LLM reproduced template examples literally rather than
 * filling in real content from the specification.
 * @param args - The save plan arguments to validate
 * @returns Array of issue strings describing found placeholders
 */
export declare function detectPlaceholderContent(args: SavePlanArgs): string[];
/**
 * Validate target workspace path.
 * Rejects missing, empty, whitespace-only, and traversal-style paths.
 * @param target - The target workspace path to validate
 * @param source - Description of the source (for error messages)
 * @returns Error message if invalid, undefined if valid
 */
export declare function validateTargetWorkspace(target: string | undefined, source: string): string | undefined;
/**
 * Execute the save_plan tool.
 * Validates for placeholder content, builds a Plan object, and saves to disk.
 * @param args - The save plan arguments
 * @returns SavePlanResult with success status and details
 */
export declare function executeSavePlan(args: SavePlanArgs, fallbackDir?: string): Promise<SavePlanResult>;
/**
 * Tool definition for save_plan
 */
export declare const save_plan: ToolDefinition;

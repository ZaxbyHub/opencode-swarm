import { z } from 'zod';
export declare const ExecutionProfileSchema: z.ZodObject<{
    parallelization_enabled: z.ZodDefault<z.ZodBoolean>;
    max_concurrent_tasks: z.ZodDefault<z.ZodNumber>;
    council_parallel: z.ZodDefault<z.ZodBoolean>;
    locked: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export declare const TaskStatusSchema: z.ZodEnum<{
    pending: "pending";
    in_progress: "in_progress";
    completed: "completed";
    blocked: "blocked";
    closed: "closed";
}>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export declare const TaskSizeSchema: z.ZodEnum<{
    small: "small";
    medium: "medium";
    large: "large";
}>;
export type TaskSize = z.infer<typeof TaskSizeSchema>;
export declare const PhaseStatusSchema: z.ZodEnum<{
    pending: "pending";
    in_progress: "in_progress";
    completed: "completed";
    blocked: "blocked";
    closed: "closed";
    complete: "complete";
}>;
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;
/**
 * Normalize phase status - 'completed' maps to 'complete'.
 * @param status - The phase status to normalize
 * @returns Normalized status ('completed' becomes 'complete')
 */
export declare function normalizePhaseStatus(status: PhaseStatus): PhaseStatus;
/**
 * Check if a phase status represents completion.
 * @param status - The phase status to check
 * @returns true if status is 'complete' or 'completed'
 */
export declare function isPhaseComplete(status: PhaseStatus): boolean;
export declare const MigrationStatusSchema: z.ZodEnum<{
    native: "native";
    migrated: "migrated";
    migration_failed: "migration_failed";
}>;
export type MigrationStatus = z.infer<typeof MigrationStatusSchema>;
export declare const TaskSchema: z.ZodObject<{
    id: z.ZodString;
    phase: z.ZodNumber;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        in_progress: "in_progress";
        completed: "completed";
        blocked: "blocked";
        closed: "closed";
    }>>;
    size: z.ZodDefault<z.ZodEnum<{
        small: "small";
        medium: "medium";
        large: "large";
    }>>;
    description: z.ZodString;
    depends: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acceptance: z.ZodOptional<z.ZodString>;
    files_touched: z.ZodDefault<z.ZodArray<z.ZodString>>;
    evidence_path: z.ZodOptional<z.ZodString>;
    blocked_reason: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type Task = z.infer<typeof TaskSchema>;
export declare const PhaseSchema: z.ZodObject<{
    id: z.ZodNumber;
    name: z.ZodString;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        in_progress: "in_progress";
        completed: "completed";
        blocked: "blocked";
        closed: "closed";
        complete: "complete";
    }>>;
    tasks: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        phase: z.ZodNumber;
        status: z.ZodDefault<z.ZodEnum<{
            pending: "pending";
            in_progress: "in_progress";
            completed: "completed";
            blocked: "blocked";
            closed: "closed";
        }>>;
        size: z.ZodDefault<z.ZodEnum<{
            small: "small";
            medium: "medium";
            large: "large";
        }>>;
        description: z.ZodString;
        depends: z.ZodDefault<z.ZodArray<z.ZodString>>;
        acceptance: z.ZodOptional<z.ZodString>;
        files_touched: z.ZodDefault<z.ZodArray<z.ZodString>>;
        evidence_path: z.ZodOptional<z.ZodString>;
        blocked_reason: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    type: z.ZodOptional<z.ZodEnum<{
        code: "code";
        "non-code": "non-code";
    }>>;
    required_agents: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type Phase = z.infer<typeof PhaseSchema>;
export declare const PlanSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"1.0.0">;
    title: z.ZodString;
    swarm: z.ZodString;
    current_phase: z.ZodOptional<z.ZodNumber>;
    phases: z.ZodArray<z.ZodObject<{
        id: z.ZodNumber;
        name: z.ZodString;
        status: z.ZodDefault<z.ZodEnum<{
            pending: "pending";
            in_progress: "in_progress";
            completed: "completed";
            blocked: "blocked";
            closed: "closed";
            complete: "complete";
        }>>;
        tasks: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            phase: z.ZodNumber;
            status: z.ZodDefault<z.ZodEnum<{
                pending: "pending";
                in_progress: "in_progress";
                completed: "completed";
                blocked: "blocked";
                closed: "closed";
            }>>;
            size: z.ZodDefault<z.ZodEnum<{
                small: "small";
                medium: "medium";
                large: "large";
            }>>;
            description: z.ZodString;
            depends: z.ZodDefault<z.ZodArray<z.ZodString>>;
            acceptance: z.ZodOptional<z.ZodString>;
            files_touched: z.ZodDefault<z.ZodArray<z.ZodString>>;
            evidence_path: z.ZodOptional<z.ZodString>;
            blocked_reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        type: z.ZodOptional<z.ZodEnum<{
            code: "code";
            "non-code": "non-code";
        }>>;
        required_agents: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    migration_status: z.ZodOptional<z.ZodEnum<{
        native: "native";
        migrated: "migrated";
        migration_failed: "migration_failed";
    }>>;
    specMtime: z.ZodOptional<z.ZodString>;
    specHash: z.ZodOptional<z.ZodString>;
    execution_profile: z.ZodOptional<z.ZodObject<{
        parallelization_enabled: z.ZodDefault<z.ZodBoolean>;
        max_concurrent_tasks: z.ZodDefault<z.ZodNumber>;
        council_parallel: z.ZodDefault<z.ZodBoolean>;
        locked: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Plan = z.infer<typeof PlanSchema>;
/**
 * Runtime plan with spec staleness tracking.
 * Extends Plan with runtime-only fields that are not persisted.
 *
 * `_midLoadRemovals` is attached by loadPlan-recovery paths that auto-
 * acknowledged task removals (issue #853) so the system-enhancer Layer A
 * can disclose the count to the model without re-reading the ledger.
 */
export type RuntimePlan = Plan & {
    _specStale?: boolean;
    _specStaleReason?: string;
    _midLoadRemovals?: {
        count: number;
        source: string;
    };
};
/**
 * Find the first phase that is in progress.
 * @param phases - Array of phases
 * @returns Phase number of first in-progress phase, or first phase if none
 */
export declare function findFirstActivePhase(phases: Phase[]): number | undefined;
/**
 * Get the current phase from a plan, with fallback inference.
 * @param plan - The plan object
 * @returns The current phase number, or inferred value, or 1 as last resort
 */
export declare function getCurrentPhase(plan: Plan): number;

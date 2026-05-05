import type { Plan } from '../config/plan-schema';
/**
 * Swarm File Extractors
 *
 * Pure parsing functions for extracting structured data from .swarm/ files.
 * Used by system-enhancer and compaction-customizer hooks.
 */
/**
 * Extracts the current phase information from plan content.
 */
export declare function extractCurrentPhase(planContent: string): string | null;
/**
 * Extracts the first incomplete task from the current IN PROGRESS phase.
 */
export declare function extractCurrentTask(planContent: string): string | null;
/**
 * Extracts decisions section from context content.
 */
export declare function extractDecisions(contextContent: string, maxChars?: number): string | null;
/**
 * Extracts incomplete tasks from plan content under the current IN PROGRESS phase.
 */
export declare function extractIncompleteTasks(planContent: string, maxChars?: number): string | null;
/**
 * Extracts patterns section from context content.
 */
export declare function extractPatterns(contextContent: string, maxChars?: number): string | null;
/**
 * Extracts current phase info from a Plan object.
 */
export declare function extractCurrentPhaseFromPlan(plan: Plan): string | null;
/**
 * Extracts the first incomplete task from the current phase of a Plan object.
 */
export declare function extractCurrentTaskFromPlan(plan: Plan): string | null;
/**
 * Extracts incomplete tasks from the current phase of a Plan object.
 */
export declare function extractIncompleteTasksFromPlan(plan: Plan, maxChars?: number): string | null;
/**
 * Extracts plan cursor - a concise summary of current phase, current task,
 * and lookahead tasks for context-aware agent communication.
 *
 * @param planContent - The raw plan markdown content
 * @param options - Optional configuration
 * @param options.maxTokens - Target max tokens (default 1500, ~6000 chars)
 * @param options.lookaheadTasks - Number of lookahead tasks (default 2)
 * @returns A [SWARM PLAN CURSOR] block with phase summaries and task details
 */
export declare function extractPlanCursor(planContent: string, options?: {
    maxTokens?: number;
    lookaheadTasks?: number;
}): string;
export declare const _internals: {
    extractCurrentPhase: typeof extractCurrentPhase;
    extractCurrentTask: typeof extractCurrentTask;
    extractDecisions: typeof extractDecisions;
    extractIncompleteTasks: typeof extractIncompleteTasks;
    extractPatterns: typeof extractPatterns;
    extractCurrentPhaseFromPlan: typeof extractCurrentPhaseFromPlan;
    extractCurrentTaskFromPlan: typeof extractCurrentTaskFromPlan;
    extractIncompleteTasksFromPlan: typeof extractIncompleteTasksFromPlan;
    extractPlanCursor: typeof extractPlanCursor;
};

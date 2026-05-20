/**
 * Risk Classification for Lean Turbo Tasks.
 *
 * This module provides risk assessment for tasks based on their file scopes,
 * determining whether tasks can execute in parallel or must be serialized/degraded.
 *
 * ## Risk Categories
 *
 * - **normal**: Regular scoped files that can be parallelized
 * - **global**: Tasks touching global files (affects all coders) → always degraded
 * - **protected**: Tasks touching protected paths → degraded or serialized based on config
 * - **no-scope**: Tasks without declared scope when `require_declared_scope` is true → serialized
 * - **invalid-scope**: Tasks with invalid scope entries → serialized
 */
import type { LeanTurboConfig } from '../../config/schema';
/**
 * Risk category classification for a task.
 */
export type TaskRiskCategory = 'normal' | 'global' | 'protected' | 'no-scope' | 'invalid-scope';
/**
 * Result of risk assessment for a task.
 */
export interface TaskRiskAssessment {
    /** The risk category */
    category: TaskRiskCategory;
    /** Human-readable reason for the classification (undefined for 'normal') */
    reason?: string;
    /** Files that contributed to the risk assessment */
    files: string[];
}
/**
 * Assess the risk category of a task based on its file scope.
 *
 * Classification priority (first match wins):
 * 1. Global files → 'global' (always degraded)
 * 2. Protected paths → 'protected' (degraded if degrade_on_risk, else serialized)
 * 3. Invalid scope entries → 'invalid-scope' (serialized)
 * 4. No declared scope (when required) → 'no-scope' (serialized)
 * 5. Otherwise → 'normal'
 *
 * @param files - The task's file scope (already validated and normalized)
 * @param hasDeclaredScope - Whether the task has an explicit declared scope
 * @param hasInvalidScope - Whether the scope contains invalid/unsafe entries
 * @param config - Lean Turbo configuration
 * @returns Risk assessment with category, reason, and contributing files
 */
export declare function assessTaskRisk(files: string[], hasDeclaredScope: boolean, hasInvalidScope: boolean, config: LeanTurboConfig): TaskRiskAssessment;

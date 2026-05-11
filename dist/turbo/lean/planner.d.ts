/**
 * Lane Planning Engine for Lean Turbo.
 *
 * Lean Turbo is a parallel execution strategy that dispatches up to N non-conflicting
 * coder lanes concurrently. This module implements the lane planner that partitions
 * phase tasks into parallel lanes based on file-scope conflicts.
 *
 * ## Lane Planning Algorithm
 *
 * The planner operates in several phases:
 *
 * 1. **Task Extraction**: Extract tasks for the specified phase, filtering out
 *    already-completed tasks.
 *
 * 2. **Scope Resolution**: For each task, resolve its file scope:
 *    - Use provided scopes map if available
 *    - Otherwise, read from `.swarm/scopes/scope-{taskId}.json`
 *    - Fall back to `files_touched` from plan.json if `require_declared_scope` is false
 *    - If no scope available and `require_declared_scope` is true, serialize the task
 *
 * 3. **Conflict Detection**: Classify each task's files into:
 *    - **Global files**: High-risk files that affect all coders (package.json, etc.)
 *      → marked as degraded with reason "global file conflict"
 *    - **Protected paths**: Paths containing security-sensitive patterns
 *      → marked as degraded with reason "protected path" (if `degrade_on_risk` is true)
 *      → serialized otherwise
 *    - **Normal files**: Regular scoped files that need conflict checking
 *
 * 4. **Lane Assignment**:
 *    - Sort tasks by dependency order (tasks with no deps first)
 *    - For each non-conflicting task group, create a lane (up to `max_parallel_coders`)
 *    - Tasks with conflicts are serialized or degraded based on `conflict_policy`
 *
 * 5. **Counter Population**: Track planned lanes, serialized tasks, and degraded tasks.
 *
 * ## Conflict Detection Rules
 *
 * Two tasks conflict if:
 * - They touch the **same file**
 * - One task touches a **parent directory** of a file the other task touches
 *   (e.g., `src/auth/` vs `src/auth/login.ts`)
 * - A task touches a **global file** (affects all coders)
 * - A task touches a **protected path** (security-sensitive areas)
 *
 * ## Path Normalization
 *
 * All paths are normalized to POSIX-style (forward slashes, no trailing slash)
 * before conflict detection. This ensures consistent behavior across platforms.
 */
import type { LeanTurboConfig } from '../../config/schema';
import type { LeanTurboCounters, LeanTurboDegradedTask, LeanTurboLane } from './state';
export { GLOBAL_FILES_LIST, isGlobalFile, isPathSafe, isProtectedPath, normalizePath, PROTECTED_PATTERNS_LIST, pathsConflict, readTaskScopes, } from './conflicts';
/**
 * A single task within a plan phase.
 * Matches the structure stored in .swarm/plan.json.
 */
export interface PlanTask {
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    depends?: string[];
    files_touched?: string[];
}
/**
 * A phase within a plan, containing multiple tasks.
 */
export interface PlanPhase {
    id: number;
    name: string;
    tasks: PlanTask[];
}
/**
 * The complete lane plan produced by `planLeanTurboLanes`.
 * Describes how phase tasks are partitioned into parallel lanes.
 */
export interface LeanTurboLanePlan {
    /** The phase number this plan covers */
    phase: number;
    /** Unique identifier for this lane plan (planId from run state) */
    planId: string;
    /** The computed parallel lanes */
    lanes: LeanTurboLane[];
    /** Tasks that were degraded (risk conditions detected) */
    degradedTasks: LeanTurboDegradedTask[];
    /** Tasks that were serialized (conflicts resolved by ordering) */
    serializedTasks: string[];
    /** Human-readable summary when all tasks are degraded */
    degradationSummary?: string;
    /** Execution counters for this planning run */
    counters: LeanTurboCounters;
    /** Map of taskId -> array of dependency taskIds that are in other lanes.
     *  The runner must serialize execution of these tasks until the referenced
     *  dependencies complete. */
    crossLaneDependencies: Record<string, string[]>;
}
/**
 * Partition phase tasks into parallel lanes based on file-scope conflicts.
 *
 * This is the main entry point for Lean Turbo lane planning. It:
 * 1. Extracts tasks for the specified phase
 * 2. Resolves file scopes for each task
 * 3. Detects conflicts between tasks
 * 4. Assigns non-conflicting tasks to parallel lanes
 * 5. Serializes or degrades conflicting tasks based on config
 *
 * @param directory - Project root directory
 * @param phaseNumber - Phase number to plan
 * @param plan - The full plan object (from .swarm/plan.json)
 * @param config - Lean Turbo configuration
 * @param scopes - Optional pre-loaded scopes map (taskId -> file paths)
 * @returns Complete lane plan with lanes, degraded tasks, and counters
 */
export declare function planLeanTurboLanes(directory: string, phaseNumber: number, plan: {
    phases: PlanPhase[];
}, config: LeanTurboConfig, scopes?: Record<string, string[]>): LeanTurboLanePlan;

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
import { pathsConflict } from './conflicts';
import {
	getReadyTasks,
	makeDependencySatisfactionChecker,
	type PlanPhase,
	runPartitionPreflight,
} from './partition-common';
import type {
	LeanTurboCounters,
	LeanTurboDegradedTask,
	LeanTurboLane,
} from './state';

// Re-export for backwards compatibility with tests
export {
	GLOBAL_FILES_LIST,
	isGlobalFile,
	isPathSafe,
	isProtectedPath,
	normalizePath,
	PROTECTED_PATTERNS_LIST,
	pathsConflict,
	readTaskScopes,
} from './conflicts';

// Re-export plan types from partition-common for backward compatibility
// with consumers that import them from `planner` (e.g. lean-turbo-plan-lanes.ts).
export type { PlanPhase, PlanTask } from './partition-common';

// ─── Output Types ────────────────────────────────────────────────────────────

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

// ─── Main Planning Function ──────────────────────────────────────────────────

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
 * @param isUpstreamCommitted - Optional Rule-3 predicate (greenfield-smart
 *        redesign). When supplied, a cross-batch dependency (a `depends:`
 *        upstream not present in this planning call's task set — typically
 *        completed in a prior phase) is treated as satisfied **only** if
 *        the predicate returns `true`. Production lean callers supply it via
 *        `resolveLeanRule3Predicate(directory, taskIds)`
 *        (`src/turbo/lean/upstream-committed.ts`) ONLY while an Epic is open
 *        for the project — `swarm(task <id>):` landing commits exist only
 *        under Epic Mode, so wiring it unconditionally would wrongly degrade
 *        every healthy pure-lean cross-phase dependent. When undefined (no
 *        open Epic) the planner falls back to its legacy behavior (cross-batch
 *        deps are implicitly satisfied) for backward compatibility.
 * @returns Complete lane plan with lanes, degraded tasks, and counters
 */
export function planLeanTurboLanes(
	directory: string,
	phaseNumber: number,
	plan: { phases: PlanPhase[] },
	config: LeanTurboConfig,
	scopes?: Record<string, string[]>,
	isUpstreamCommitted?: (taskId: string) => boolean,
): LeanTurboLanePlan {
	const phase = plan.phases.find((p) => p.id === phaseNumber);

	if (!phase) {
		return createEmptyPlan(phaseNumber, '');
	}

	// Filter out completed tasks
	const pendingTasks = phase.tasks.filter((t) => t.status !== 'completed');

	if (pendingTasks.length === 0) {
		return createEmptyPlan(phaseNumber, '');
	}

	// Steps 1–3: scope resolution + risk classification + topological sort.
	// Shared with the wave planner; see `partition-common.ts`.
	const { sortedTasks, taskMap, tasksInCycle } = runPartitionPreflight(
		directory,
		pendingTasks,
		config,
		scopes,
	);

	// Step 4: Build lanes using greedy assignment
	const lanes: LeanTurboLane[] = [];
	const serializedTasks: string[] = [];
	const degradedTasks: LeanTurboDegradedTask[] = [];
	const maxLanes = config.max_parallel_coders;

	// Track which files are already claimed by a lane
	const claimedFiles = new Set<string>();
	// Track which task IDs are already assigned (to a lane or serialized)
	const assignedTasks = new Set<string>();
	// Track which lane a task is assigned to (lane index, or -1 for serialized)
	const taskToLane = new Map<string, number>();
	// Track cross-lane dependencies: taskId -> [dependency taskIds in other lanes]
	const crossLaneDependencies: Record<string, string[]> = {};

	// Pre-populate serializedTasks with cycle tasks (fail-closed)
	for (const taskId of tasksInCycle) {
		serializedTasks.push(taskId);
		assignedTasks.add(taskId);
		taskToLane.set(taskId, -1);
	}

	// Dependency-satisfaction predicate: shared with the wave planner.
	// Rule 3 (greenfield-smart) is encoded by the predicate when supplied.
	const isSatisfied = makeDependencySatisfactionChecker(
		taskMap,
		assignedTasks,
		isUpstreamCommitted,
	);

	// Process tasks in waves: each wave only includes tasks whose dependencies are satisfied
	// This ensures B (depending on A) is never in a parallel lane with A
	while (true) {
		const readyTasks = getReadyTasks(sortedTasks, assignedTasks, isSatisfied);
		if (readyTasks.length === 0) {
			break;
		}

		// Assign ready tasks to lanes (respecting file conflicts)
		// Tasks that can't be assigned to a lane will be serialized
		for (const classified of readyTasks) {
			// Skip if already assigned (safety check - should never trigger)
			if (assignedTasks.has(classified.task.id)) {
				continue;
			}

			// Handle non-normal tasks based on category and policy
			if (classified.category === 'global') {
				// Global files always degrade
				degradedTasks.push({
					taskId: classified.task.id,
					reason: 'global file conflict',
					files: classified.files,
					requiredMode: 'balanced',
				});
				assignedTasks.add(classified.task.id);
				continue;
			}

			if (classified.category === 'protected') {
				if (config.degrade_on_risk) {
					degradedTasks.push({
						taskId: classified.task.id,
						reason: 'protected path',
						files: classified.files,
						requiredMode: 'balanced',
					});
				} else {
					serializedTasks.push(classified.task.id);
					taskToLane.set(classified.task.id, -1);
				}
				assignedTasks.add(classified.task.id);
				continue;
			}

			if (
				classified.category === 'no-scope' ||
				classified.category === 'invalid-scope'
			) {
				// No scope or invalid scope → serialize
				serializedTasks.push(classified.task.id);
				taskToLane.set(classified.task.id, -1);
				assignedTasks.add(classified.task.id);
				continue;
			}

			// Normal task: check for conflicts with claimed files
			const hasConflict = classified.files.some((file) =>
				claimedFiles.has(file),
			);

			if (hasConflict) {
				// Conflict detected - resolve based on policy
				if (config.conflict_policy === 'degrade') {
					degradedTasks.push({
						taskId: classified.task.id,
						reason: 'file conflict with parallel task',
						files: classified.files,
						requiredMode: 'balanced',
					});
				} else {
					serializedTasks.push(classified.task.id);
					taskToLane.set(classified.task.id, -1);
				}
				assignedTasks.add(classified.task.id);
				continue;
			}

			// Check for parent/child conflicts with claimed files
			let hasParentChildConflict = false;
			for (const file of classified.files) {
				for (const claimed of Array.from(claimedFiles)) {
					if (pathsConflict(file, claimed)) {
						hasParentChildConflict = true;
						break;
					}
				}
				if (hasParentChildConflict) break;
			}

			if (hasParentChildConflict) {
				if (config.conflict_policy === 'degrade') {
					degradedTasks.push({
						taskId: classified.task.id,
						reason: 'file conflict with parallel task',
						files: classified.files,
						requiredMode: 'balanced',
					});
				} else {
					serializedTasks.push(classified.task.id);
					taskToLane.set(classified.task.id, -1);
				}
				assignedTasks.add(classified.task.id);
				continue;
			}

			// Step 1: Find candidate lane (check for file conflicts with existing lanes)
			let candidateLaneIndex = -1;

			for (let i = 0; i < lanes.length; i++) {
				const lane = lanes[i];
				// Check if this task conflicts with any file in this lane
				const conflictsWithLane = lane.files.some((laneFile) =>
					classified.files.some((taskFile) =>
						pathsConflict(laneFile, taskFile),
					),
				);

				if (!conflictsWithLane) {
					candidateLaneIndex = i;
					break;
				}
			}

			// If no existing lane works and we can create a new one, candidate is new lane
			if (candidateLaneIndex === -1 && lanes.length < maxLanes) {
				candidateLaneIndex = lanes.length;
			}

			// Step 2: Check cross-lane dependencies against candidate
			if (candidateLaneIndex !== -1) {
				const depsInOtherLanes: string[] = [];
				const deps = classified.task.depends ?? [];
				for (const dep of deps) {
					if (!taskMap.has(dep)) continue; // Skip deps not in our task set
					const depLane = taskToLane.get(dep);
					// depLane is in a different lane if it's a valid lane index !== candidateLaneIndex
					if (
						depLane !== undefined &&
						depLane !== -1 &&
						depLane !== candidateLaneIndex
					) {
						depsInOtherLanes.push(dep);
					}
				}

				if (depsInOtherLanes.length > 0) {
					// Dependency in a different lane → serialize
					serializedTasks.push(classified.task.id);
					assignedTasks.add(classified.task.id);
					taskToLane.set(classified.task.id, -1);
					crossLaneDependencies[classified.task.id] = depsInOtherLanes;
					continue;
				}

				// No cross-lane conflicts - place in candidate lane
				if (candidateLaneIndex < lanes.length) {
					// Add to existing lane
					const lane = lanes[candidateLaneIndex];
					lane.taskIds.push(classified.task.id);
					lane.files.push(...classified.files);
					assignedTasks.add(classified.task.id);
					taskToLane.set(classified.task.id, candidateLaneIndex);
				} else {
					// Create new lane
					lanes.push({
						laneId: `lane-${lanes.length + 1}`,
						taskIds: [classified.task.id],
						files: [...classified.files],
						status: 'pending',
					});
					assignedTasks.add(classified.task.id);
					taskToLane.set(classified.task.id, lanes.length - 1);
				}

				// Update claimed files
				for (const file of classified.files) {
					claimedFiles.add(file);
				}
			} else {
				// No candidate lane available (max lanes reached) - serialize
				serializedTasks.push(classified.task.id);
				assignedTasks.add(classified.task.id);
				taskToLane.set(classified.task.id, -1);
			}
		}
	}

	// Note: Task order within lanes is already deterministic because:
	// 1. Tasks are processed in waves (getReadyTasks returns lexicographically sorted tasks)
	// 2. Within each wave, tasks are added to lanes in that sorted order
	// 3. Final lexicographic sort was removed to preserve dependency ordering

	// Rule 3 leftover-cleanup. When `isUpstreamCommitted` rejects a task's
	// cross-batch dep, `getReadyTasks()` will keep skipping that task forever
	// (the dep isn't going to commit during this dispatch) and the wave loop
	// will eventually terminate with the task unassigned. We must surface
	// those — silently dropping a planned task is the worst possible
	// outcome.
	//
	// Reason attribution matters: a task can be left over because (a) a
	// cross-batch upstream wasn't committed (Rule-3 specific) OR (b) an
	// in-batch upstream wasn't assigned to a wave (already-degraded /
	// already-serialized / cycle-broken). Attributing every leftover to
	// Rule 3 misleads the architect into chasing the wrong fix. So we
	// inspect each leftover's deps and choose the most-specific reason.
	//
	// Skipped when the predicate is not supplied (legacy Lean Turbo path)
	// because legacy semantics guarantee no leftovers from the dep-check
	// branch.
	if (isUpstreamCommitted) {
		for (const classified of sortedTasks) {
			if (assignedTasks.has(classified.task.id)) continue;
			const deps = classified.task.depends ?? [];
			const uncommittedCrossBatch: string[] = [];
			const unassignedInBatch: string[] = [];
			for (const dep of deps) {
				if (taskMap.has(dep)) {
					if (!assignedTasks.has(dep)) unassignedInBatch.push(dep);
				} else if (!isUpstreamCommitted(dep)) {
					uncommittedCrossBatch.push(dep);
				}
			}
			let reason: string;
			if (uncommittedCrossBatch.length > 0) {
				// Rule-3 specific reason; list the offending deps so the
				// architect can commit them and re-run.
				const sample = uncommittedCrossBatch.slice(0, 3).join(', ');
				const more =
					uncommittedCrossBatch.length > 3
						? `, +${uncommittedCrossBatch.length - 3} more`
						: '';
				reason = `cross-batch upstream not committed (greenfield-smart Rule 3): ${sample}${more}`;
			} else if (unassignedInBatch.length > 0) {
				// In-batch dep was never assigned (degraded/serialized/cycle).
				// Surface that instead of mislabeling as Rule-3.
				const sample = unassignedInBatch.slice(0, 3).join(', ');
				const more =
					unassignedInBatch.length > 3
						? `, +${unassignedInBatch.length - 3} more`
						: '';
				reason = `unresolved in-batch dependency: ${sample}${more}`;
			} else {
				// No identifiable blocker — should be unreachable. Surface
				// generically so the task is never silently dropped.
				reason = 'planning leftover (no identifiable blocker)';
			}
			degradedTasks.push({
				taskId: classified.task.id,
				reason,
				files: classified.files,
				requiredMode: 'balanced',
			});
			assignedTasks.add(classified.task.id);
			taskToLane.set(classified.task.id, -1);
		}
	}

	// Generate degradation summary if all tasks degraded
	let degradationSummary: string | undefined;
	if (
		degradedTasks.length > 0 &&
		degradedTasks.length + serializedTasks.length === pendingTasks.length
	) {
		const reasons = Array.from(new Set(degradedTasks.map((t) => t.reason)));
		const rule3Count = degradedTasks.filter((t) =>
			t.reason.includes('greenfield-smart Rule 3'),
		).length;
		// If Rule-3 dominates the degradations, lead with a targeted
		// remediation — "consider running in serial mode" is misleading when
		// the actual fix is "ensure upstream phases produced git commits".
		if (rule3Count > 0 && rule3Count >= degradedTasks.length / 2) {
			degradationSummary = `All ${pendingTasks.length} tasks degraded. ${rule3Count} blocked by greenfield-smart Rule 3 — cross-batch upstream(s) not in git history. Remediation: verify Epic Mode commit-on-completion is succeeding for upstream phases, or commit those tasks manually before re-running.`;
		} else {
			degradationSummary = `All ${pendingTasks.length} tasks degraded. Reasons: ${reasons.join(', ')}. Consider running in standard (serial) mode.`;
		}
	}

	// Build counters
	const counters: LeanTurboCounters = {
		lanesPlanned: lanes.length,
		lanesStarted: 0,
		lanesCompleted: 0,
		lanesFailed: 0,
		tasksSerialized: serializedTasks.length,
		tasksDegraded: degradedTasks.length,
	};

	// Generate plan ID from phase and timestamp
	const planId = `plan-${phaseNumber}-${Date.now()}`;

	return {
		phase: phaseNumber,
		planId,
		lanes,
		degradedTasks,
		serializedTasks,
		degradationSummary,
		counters,
		crossLaneDependencies,
	};
}

/**
 * Create an empty lane plan for edge cases (no phase, no tasks).
 */
function createEmptyPlan(
	phaseNumber: number,
	planId: string,
): LeanTurboLanePlan {
	return {
		phase: phaseNumber,
		planId,
		lanes: [],
		degradedTasks: [],
		serializedTasks: [],
		counters: {
			lanesPlanned: 0,
			lanesStarted: 0,
			lanesCompleted: 0,
			lanesFailed: 0,
			tasksSerialized: 0,
			tasksDegraded: 0,
		},
		crossLaneDependencies: {},
	};
}

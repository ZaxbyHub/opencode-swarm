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
import {
	isPathSafe,
	normalizePath,
	pathsConflict,
	readTaskScopes,
} from './conflicts';
import { assessTaskRisk, type TaskRiskAssessment } from './risk';
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

// ─── Plan JSON Types ─────────────────────────────────────────────────────────

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

/**
 * Get the files for a task, validating and normalizing them.
 *
 * NOTE: Symlink containment is NOT enforced at planning time.
 * Symlinks are resolved by the lock system at lock acquisition time.
 * This allows tasks to declare scopes with symlinks for convenience,
 * but ensures actual file safety is validated before execution.
 *
 * @param files - Raw array of file paths
 * @param directory - Project root directory
 * @returns Tuple of [validFiles, invalidCount]
 */
function getValidatedFiles(
	files: string[],
	directory: string,
): [string[], number] {
	const validFiles: string[] = [];
	let invalidCount = 0;

	for (const file of files) {
		// Prepend directory to paths that are NOT already absolute (don't start with / or a drive letter)
		// This ensures relative paths like 'src/a.ts' become project-root-relative like '/repo/src/a.ts'
		// while preserving any absolute paths that are already under the project directory
		let pathToCheck: string;
		if (file.startsWith('/') || file.match(/^[a-zA-Z]:/)) {
			// Absolute path - use as-is (will be validated by isPathSafe)
			pathToCheck = file;
		} else {
			// Relative path - prepend directory to make it project-root-relative
			pathToCheck = `${directory}/${file}`;
		}

		if (!isPathSafe(pathToCheck)) {
			invalidCount++;
			continue;
		}

		const normalized = normalizePath(pathToCheck);
		validFiles.push(normalized);
	}

	return [validFiles, invalidCount];
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
 * @returns Complete lane plan with lanes, degraded tasks, and counters
 */
export function planLeanTurboLanes(
	directory: string,
	phaseNumber: number,
	plan: { phases: PlanPhase[] },
	config: LeanTurboConfig,
	scopes?: Record<string, string[]>,
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

	// Step 1: Resolve scopes for all tasks
	type TaskWithScope = {
		task: PlanTask;
		files: string[];
		hasDeclaredScope: boolean;
		hasInvalidScope: boolean;
	};

	const tasksWithScopes: TaskWithScope[] = [];

	for (const task of pendingTasks) {
		let files: string[] = [];
		let hasDeclaredScope = false;

		// Try provided scopes first
		if (scopes && task.id in scopes) {
			files = scopes[task.id];
			hasDeclaredScope = true;
		} else {
			// Try reading from scope file
			const scopeFiles = readTaskScopes(directory, task.id);
			if (scopeFiles !== null) {
				files = scopeFiles;
				hasDeclaredScope = true;
			}
		}

		// Fall back to files_touched if not requiring declared scope
		if (!hasDeclaredScope && !config.require_declared_scope) {
			files = task.files_touched ?? [];
			hasDeclaredScope = false; // Using plan fallback, not declared
		}

		// Validate and normalize paths, tracking invalid entries
		const [validFiles, invalidCount] = getValidatedFiles(files, directory);
		const hasInvalidScope = invalidCount > 0;

		tasksWithScopes.push({
			task,
			files: validFiles,
			hasDeclaredScope,
			hasInvalidScope,
		});
	}

	// Step 2: Classify tasks and detect conflicts
	type ClassifiedTask = {
		task: PlanTask;
		files: string[];
		hasDeclaredScope: boolean;
		category: TaskRiskAssessment['category'];
		conflictReason?: string;
	};

	const classifiedTasks: ClassifiedTask[] = [];

	for (const tws of tasksWithScopes) {
		const assessment = assessTaskRisk(
			tws.files,
			tws.hasDeclaredScope,
			tws.hasInvalidScope,
			config,
		);

		classifiedTasks.push({
			task: tws.task,
			files: tws.files,
			hasDeclaredScope: tws.hasDeclaredScope,
			category: assessment.category,
			conflictReason: assessment.reason,
		});
	}

	// Step 3: Topological sort with cycle detection
	// Uses Kahn's algorithm with fail-closed cycle handling
	const taskMap = new Map<string, ClassifiedTask>();
	for (const ct of classifiedTasks) {
		taskMap.set(ct.task.id, ct);
	}

	// Build in-degree map and adjacency list
	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	for (const ct of classifiedTasks) {
		inDegree.set(ct.task.id, 0);
		adjacency.set(ct.task.id, []);
	}

	for (const ct of classifiedTasks) {
		const deps = ct.task.depends ?? [];
		for (const dep of deps) {
			// Only consider dependencies that exist in our task set
			if (taskMap.has(dep)) {
				adjacency.get(dep)!.push(ct.task.id);
				inDegree.set(ct.task.id, (inDegree.get(ct.task.id) ?? 0) + 1);
			}
		}
	}

	// Kahn's algorithm with cycle detection
	const sortedTasks: ClassifiedTask[] = [];
	const tasksInCycle = new Set<string>();

	// Start with tasks that have no dependencies (in-degree 0)
	const queue: string[] = [];
	for (const [taskId, degree] of inDegree) {
		if (degree === 0) {
			queue.push(taskId);
		}
	}

	// Sort queue lexicographically for deterministic ordering
	queue.sort((a, b) => a.localeCompare(b));

	while (queue.length > 0) {
		const current = queue.shift()!;
		const task = taskMap.get(current)!;
		sortedTasks.push(task);

		for (const neighbor of adjacency.get(current) ?? []) {
			const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				// Insert in sorted position to maintain lexicographic order
				const insertIdx = queue.findIndex(
					(id) => id.localeCompare(neighbor) > 0,
				);
				if (insertIdx === -1) {
					queue.push(neighbor);
				} else {
					queue.splice(insertIdx, 0, neighbor);
				}
			}
		}
	}

	// Detect cycle: any task with in-degree > 0 is part of a cycle
	for (const [taskId, degree] of inDegree) {
		if (degree > 0) {
			tasksInCycle.add(taskId);
		}
	}

	// If cycle detected, fail-closed: serialize all tasks in the cycle
	// These will be moved from sortedTasks to serializedTasks later

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

	// Helper: check if all dependencies of a task are already assigned
	// A dependency is satisfied if it's in assignedTasks (either serialized or in a lane)
	const allDependenciesSatisfied = (task: ClassifiedTask): boolean => {
		const deps = task.task.depends ?? [];
		for (const dep of deps) {
			// Only check dependencies that exist in our task set
			if (taskMap.has(dep) && !assignedTasks.has(dep)) {
				return false;
			}
		}
		return true;
	};

	// Helper: find tasks whose dependencies are all satisfied but haven't been assigned yet
	// Returns tasks sorted lexicographically for determinism within the same dependency wave
	const getReadyTasks = (): ClassifiedTask[] => {
		const ready: ClassifiedTask[] = [];
		for (const classified of sortedTasks) {
			if (
				!assignedTasks.has(classified.task.id) &&
				allDependenciesSatisfied(classified)
			) {
				ready.push(classified);
			}
		}
		// Sort lexicographically for deterministic ordering within dependency waves
		ready.sort((a, b) => a.task.id.localeCompare(b.task.id));
		return ready;
	};

	// Process tasks in waves: each wave only includes tasks whose dependencies are satisfied
	// This ensures B (depending on A) is never in a parallel lane with A
	while (true) {
		const readyTasks = getReadyTasks();
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

	// Generate degradation summary if all tasks degraded
	let degradationSummary: string | undefined;
	if (
		degradedTasks.length > 0 &&
		degradedTasks.length + serializedTasks.length === pendingTasks.length
	) {
		const reasons = Array.from(new Set(degradedTasks.map((t) => t.reason)));
		degradationSummary = `All ${pendingTasks.length} tasks degraded. Reasons: ${reasons.join(', ')}. Consider running in standard (serial) mode.`;
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

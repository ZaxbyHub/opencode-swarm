/**
 * Shared partition primitives for Lean Turbo's lane planner AND Epic Mode's
 * wave planner. Both planners run the same three preflight steps:
 *
 *   1. Resolve declared scopes (or files_touched fallback) per pending task.
 *   2. Classify each task by file risk (global / protected / no-scope / normal).
 *   3. Topologically sort with cycle detection so a downstream task can never
 *      be released before its upstream.
 *
 * They diverge only at the assignment step:
 *   - Lane planner: greedy fill into a fixed number of serial chains.
 *   - Wave planner: emit ordered concurrent groups whose membership is gated
 *     by inter-task scope disjointness.
 *
 * Owning the preflight in one place guarantees both planners produce
 * identical classifications and sort orders for the same inputs.
 */

import * as path from 'node:path';
import type { LeanTurboConfig } from '../../config/schema';
import { criticalWarn } from '../../utils/logger.js';
import { isPathSafe, normalizePath, readTaskScopes } from './conflicts';
import { assessTaskRisk, type TaskRiskAssessment } from './risk';

// ─── Plan JSON Types ─────────────────────────────────────────────────────────

/**
 * A single task within a plan phase. Matches `.swarm/plan.json`.
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

// ─── Classified Task ─────────────────────────────────────────────────────────

export type ClassifiedTask = {
	task: PlanTask;
	files: string[];
	hasDeclaredScope: boolean;
	category: TaskRiskAssessment['category'];
	conflictReason?: string;
};

// ─── Preflight Result ────────────────────────────────────────────────────────

export interface PartitionPreflight {
	/** Topologically sorted, lexicographically tie-broken. */
	sortedTasks: ClassifiedTask[];
	/** taskId -> ClassifiedTask for O(1) lookup. */
	taskMap: Map<string, ClassifiedTask>;
	/** Tasks whose deps form a cycle. Callers must fail-closed: serialize them. */
	tasksInCycle: Set<string>;
}

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Validate and normalize a task's declared scope.
 *
 * Symlink containment is NOT enforced here — the lock layer resolves symlinks
 * at acquisition time. This lets architects declare scopes with symlinks for
 * convenience without compromising actual file-write safety.
 *
 * @returns Tuple of [validFiles, invalidCount]
 */
export function getValidatedFiles(
	files: string[],
	directory: string,
): [string[], number] {
	const validFiles: string[] = [];
	let invalidCount = 0;

	for (const file of files) {
		let pathToCheck: string;
		if (file.startsWith('/') || file.match(/^[a-zA-Z]:/)) {
			pathToCheck = file;
		} else {
			pathToCheck = `${directory}/${file}`;
		}

		if (!isPathSafe(pathToCheck)) {
			invalidCount++;
			continue;
		}

		// Risk classification operates on repository-relative scope paths. Passing
		// the absolute workspace prefix through here makes macOS temp roots such
		// as /private/var look like a protected project path, so every normal
		// scope is incorrectly degraded before worktree provisioning can begin.
		const relativePath = path.relative(
			path.resolve(directory),
			path.resolve(pathToCheck),
		);
		if (
			!relativePath ||
			!isPathSafe(relativePath) ||
			path.isAbsolute(relativePath)
		) {
			invalidCount++;
			continue;
		}

		validFiles.push(normalizePath(relativePath));
	}

	return [validFiles, invalidCount];
}

/**
 * Run the shared preflight: resolve scopes, classify by risk, topo-sort with
 * cycle detection.
 *
 * The same `(directory, pendingTasks, config, scopes)` produces the same
 * `PartitionPreflight` from both planners.
 */
export function runPartitionPreflight(
	directory: string,
	pendingTasks: PlanTask[],
	config: LeanTurboConfig,
	scopes?: Record<string, string[]>,
): PartitionPreflight {
	// ── Step 1: Resolve scopes ────────────────────────────────────────────────
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

		if (scopes && task.id in scopes) {
			files = scopes[task.id];
			hasDeclaredScope = true;
		} else {
			const scopeFiles = readTaskScopes(directory, task.id);
			if (scopeFiles !== null) {
				files = scopeFiles;
				hasDeclaredScope = true;
			}
		}

		// Defensive: `declare_scope` rejects empty `files` at the boundary,
		// but the `scopes?: Record<string, string[]>` map passed directly to
		// `planLeanTurboLanes` / `planEpicWaves` bypasses that validation. An
		// empty declared scope would otherwise classify as `normal` (the
		// later risk check sees `hasDeclaredScope: true` and `files: []`),
		// silently admitting the task to a wave with zero scope claim — a
		// misdispatch with no enforcement. Treat empty-declared as
		// effectively undeclared so it falls through to the no-scope path.
		if (hasDeclaredScope && files.length === 0) {
			hasDeclaredScope = false;
		}

		if (!hasDeclaredScope && !config.require_declared_scope) {
			files = task.files_touched ?? [];
			hasDeclaredScope = false;
		}

		// Even after the `files_touched` fallback, the scope may still be
		// empty (no declared scope AND no `files_touched` in plan.json).
		// `assessTaskRisk` only fires the no-scope rule when
		// `require_declared_scope: true`, so under `false` such a task
		// would silently classify as `normal` and be admitted to a wave
		// with zero claims — a misdispatch. Treat it as invalid-scope
		// (serialized) instead. The semantic stretch ("no files declared"
		// vs "files were declared but failed validation") is intentional:
		// from a safety perspective both leave the runtime with no
		// authority boundary for the coder, so both must serialize.
		if (files.length === 0 && !hasDeclaredScope) {
			tasksWithScopes.push({
				task,
				files: [],
				hasDeclaredScope: false,
				hasInvalidScope: true,
			});
			continue;
		}

		const [validFiles, invalidCount] = getValidatedFiles(files, directory);
		const hasInvalidScope = invalidCount > 0;

		tasksWithScopes.push({
			task,
			files: validFiles,
			hasDeclaredScope,
			hasInvalidScope,
		});
	}

	// ── Step 2: Classify by risk ──────────────────────────────────────────────
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

	// ── Step 3: Topological sort (Kahn's algorithm, cycle-aware) ──────────────
	// Defensive: duplicate task ids in plan.json would silently lose one
	// task because `taskMap.set` overwrites. Warn the operator and keep
	// the first occurrence; later duplicates fall through to topo with
	// inconsistent in-degree state. The plan-validity story is upstream
	// (save_plan / spec linter) but the planner must not silently drop.
	const taskMap = new Map<string, ClassifiedTask>();
	const duplicateIds: string[] = [];
	for (const ct of classifiedTasks) {
		if (taskMap.has(ct.task.id)) {
			duplicateIds.push(ct.task.id);
			continue;
		}
		taskMap.set(ct.task.id, ct);
	}
	if (duplicateIds.length > 0) {
		criticalWarn(
			`[partition-common] plan.json has duplicate task id(s): ${Array.from(
				new Set(duplicateIds),
			).join(
				', ',
			)}. The first occurrence wins; later duplicates are dropped from planning. Fix the plan file to avoid silent task loss.`,
		);
	}

	const inDegree = new Map<string, number>();
	const adjacency = new Map<string, string[]>();

	// Iterate the deduplicated set so duplicate-id entries don't reset
	// in-degree state (would cause downstream tasks to appear ready
	// prematurely).
	for (const ct of taskMap.values()) {
		inDegree.set(ct.task.id, 0);
		adjacency.set(ct.task.id, []);
	}

	for (const ct of taskMap.values()) {
		const deps = ct.task.depends ?? [];
		for (const dep of deps) {
			if (taskMap.has(dep)) {
				adjacency.get(dep)!.push(ct.task.id);
				inDegree.set(ct.task.id, (inDegree.get(ct.task.id) ?? 0) + 1);
			}
		}
	}

	const sortedTasks: ClassifiedTask[] = [];
	const tasksInCycle = new Set<string>();

	const queue: string[] = [];
	for (const [taskId, degree] of inDegree) {
		if (degree === 0) {
			queue.push(taskId);
		}
	}
	queue.sort((a, b) => a.localeCompare(b));

	while (queue.length > 0) {
		const current = queue.shift()!;
		const task = taskMap.get(current)!;
		sortedTasks.push(task);

		for (const neighbor of adjacency.get(current) ?? []) {
			const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
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

	for (const [taskId, degree] of inDegree) {
		if (degree > 0) {
			tasksInCycle.add(taskId);
		}
	}

	return { sortedTasks, taskMap, tasksInCycle };
}

/**
 * Build the predicate that a task's dependencies are all satisfied.
 *
 * Rule 3 (greenfield-smart): when `isUpstreamCommitted` is supplied, a
 * cross-batch dependency (a `depends:` upstream NOT in the current planning
 * call's task set — typically completed in a prior phase) is treated as
 * satisfied **only** if the predicate returns `true`. Without the predicate
 * the legacy semantics apply: cross-batch deps are implicitly satisfied.
 */
export function makeDependencySatisfactionChecker(
	taskMap: Map<string, ClassifiedTask>,
	assignedTasks: Set<string>,
	isUpstreamCommitted?: (taskId: string) => boolean,
): (task: ClassifiedTask) => boolean {
	return (task: ClassifiedTask): boolean => {
		const deps = task.task.depends ?? [];
		for (const dep of deps) {
			if (taskMap.has(dep)) {
				if (!assignedTasks.has(dep)) return false;
			} else if (isUpstreamCommitted && !isUpstreamCommitted(dep)) {
				return false;
			}
		}
		return true;
	};
}

/**
 * Return the next group of tasks ready for assignment: not yet assigned and
 * all dependencies satisfied. Lexicographically sorted for determinism.
 */
export function getReadyTasks(
	sortedTasks: ClassifiedTask[],
	assignedTasks: Set<string>,
	isSatisfied: (task: ClassifiedTask) => boolean,
): ClassifiedTask[] {
	const ready: ClassifiedTask[] = [];
	for (const classified of sortedTasks) {
		if (!assignedTasks.has(classified.task.id) && isSatisfied(classified)) {
			ready.push(classified);
		}
	}
	ready.sort((a, b) => a.task.id.localeCompare(b.task.id));
	return ready;
}

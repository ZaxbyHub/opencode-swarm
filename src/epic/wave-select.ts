/**
 * Epic v2 C2/C5 — choose the NEXT wave of the current phase.
 *
 * `epic_next_wave` issues one wave at a time. This module decides which
 * tasks that wave contains with the Epic component planner
 * (`components.ts`: conflict graph → components → modes → greedy wave). It
 * never writes: the caller freezes the result into the epic record.
 *
 * Inputs and rules:
 *   - batch = the phase's tasks that are not completed / closed / blocked;
 *   - a dependency OUTSIDE the batch is satisfied only when that task is
 *     `completed` in the plan AND (under git) its commit is on the epic
 *     branch (`isCommitted`: its epic task ref is an ancestor of HEAD, see
 *     `markers.ts`, or it was completed before the epic started); a
 *     dependency on a closed or removed task, on a later-phase task, or a
 *     completed task without that evidence makes the dependent
 *     `predecessor-missing` (the plan must be fixed — it can never run);
 *   - scopes: the live `declare_scope` binding, else `files_touched` (an
 *     estimate); the chosen members must all have a live binding, otherwise
 *     the result is `declare-scopes` (suggested files = `files_touched`);
 *   - components over the batch: a task touching a global file, a
 *     protected path or a learned hot file (`learning.ts`), or with no
 *     usable scope, is exclusive and runs ALONE first; other tasks are
 *     grouped into conflict components (path ∪ co-change, the wave
 *     verdict's predicate, with each scope expanded by learned co-writes
 *     for the path half — stricter than the verdict, never looser) and a
 *     densely coupled component
 *     (`serial-component`) contributes at most one task per wave;
 *   - the wave records every batch task's component and each component's
 *     mode (`components`), shown by `/swarm epic status`; past waves'
 *     records age components so none starves.
 */

import type { Plan } from '../config/plan-schema.js';
import type { LeanTurboConfig } from '../config/schema.js';
import { normalizePath } from '../turbo/lean/conflicts.js';
import type { PlanTask as PartitionTask } from '../turbo/lean/partition-common.js';
import {
	type EpicCochangeSignal,
	type EpicWaveComponents,
	type EpicWaveHistoryEntry,
	planNextEpicWave,
	toWaveComponents,
} from './components.js';
import type { EpicCoWriteIndex } from './learning.js';
import type { EpicCochangePair } from './lifecycle.js';

/** Max co-change pairs frozen into one wave record. */
export const MAX_WAVE_COCHANGE_PAIRS = 256;

type PlanTask = Plan['phases'][number]['tasks'][number];

export interface EpicWaveSelectionInput {
	directory: string;
	plan: Plan;
	phaseId: number;
	/** Live declared scope per task (`[]` = no live binding). */
	liveScopes: Record<string, string[]>;
	maxParallel: number;
	leanConfig: LeanTurboConfig;
	/**
	 * Predecessor evidence for a completed out-of-batch task (git: its task
	 * ref is an ancestor of HEAD; non-git: always true). Precomputed by the
	 * caller, which maps a git failure to `git-failed`.
	 */
	isCommitted: (taskId: string) => boolean;
	/** Learned hot files (`learning.ts`); tasks declaring them run alone. */
	hotFiles: readonly string[];
	/** Learned co-writes expanding scopes in the conflict graph (null: none). */
	coWrites: EpicCoWriteIndex | null;
	/** Co-change signal (null = disabled by config). */
	cochange: EpicCochangeSignal | null;
	/** Intra-component density above which a component runs serially. */
	densityThreshold: number;
	/** This phase's earlier waves, oldest first (component ages). */
	waveHistory: readonly EpicWaveHistoryEntry[];
}

export interface EpicPredecessorProblem {
	taskId: string;
	dependency: string;
	why: 'removed' | 'closed' | 'later-phase' | 'not-committed' | 'cycle';
}

export type EpicWaveSelection =
	| {
			kind: 'wave';
			waveKind: 'parallel' | 'exclusive' | 'serial-component';
			taskIds: string[];
			files: Record<string, string[]>;
			cochangePairs: EpicCochangePair[];
			components: EpicWaveComponents;
	  }
	| {
			kind: 'declare-scopes';
			tasks: { taskId: string; suggestedFiles: string[] }[];
	  }
	| { kind: 'task-blocked'; taskIds: string[] }
	| { kind: 'predecessor-missing'; problems: EpicPredecessorProblem[] }
	| { kind: 'none' };

function isResolved(status: string | undefined): boolean {
	return status === 'completed' || status === 'closed';
}

/** The plan-scoped task index: id → task + owning phase id. */
function indexPlan(
	plan: Plan,
): Map<string, { task: PlanTask; phaseId: number }> {
	const index = new Map<string, { task: PlanTask; phaseId: number }>();
	for (const phase of plan.phases) {
		for (const task of phase.tasks ?? []) {
			if (!index.has(task.id)) index.set(task.id, { task, phaseId: phase.id });
		}
	}
	return index;
}

function pathMatches(scopePath: string, cochangePath: string): boolean {
	return scopePath === cochangePath || scopePath.endsWith(`/${cochangePath}`);
}

/** Threshold-passing pairs whose both files lie within `files`. */
export function cochangePairsWithin(
	files: readonly string[],
	cochange: EpicCochangeSignal,
): EpicCochangePair[] {
	const normalized = files.map(normalizePath);
	const within = (file: string) => normalized.some((f) => pathMatches(f, file));
	return cochange.pairs
		.filter(
			(pair) =>
				pair.coChangeCount >= cochange.threshold.minCoChanges &&
				pair.npmi >= cochange.threshold.npmi &&
				within(pair.fileA) &&
				within(pair.fileB),
		)
		.sort((a, b) => b.npmi - a.npmi || a.fileA.localeCompare(b.fileA))
		.slice(0, MAX_WAVE_COCHANGE_PAIRS)
		.map((pair) => ({
			fileA: pair.fileA,
			fileB: pair.fileB,
			npmi: pair.npmi,
			coChangeCount: pair.coChangeCount,
		}));
}

/** Choose the next wave of `phaseId` (see the module header). */
export function selectNextEpicWave(
	input: EpicWaveSelectionInput,
): EpicWaveSelection {
	const phase = input.plan.phases.find((p) => p.id === input.phaseId);
	if (!phase) return { kind: 'none' };
	const index = indexPlan(input.plan);
	const tasks = phase.tasks ?? [];
	const blocked = tasks.filter((t) => t.status === 'blocked').map((t) => t.id);
	const batch = tasks.filter(
		(t) => !isResolved(t.status) && t.status !== 'blocked',
	);
	if (batch.length === 0) {
		return blocked.length > 0
			? { kind: 'task-blocked', taskIds: blocked }
			: { kind: 'none' };
	}
	const batchIds = new Set(batch.map((t) => t.id));

	// Out-of-batch dependency satisfaction (evidence read lazily, once).
	const satisfiedOutside = (dep: string): boolean => {
		const found = index.get(dep);
		return found?.task.status === 'completed' && input.isCommitted(dep);
	};

	const problems: EpicPredecessorProblem[] = [];
	for (const task of batch) {
		for (const dep of task.depends ?? []) {
			if (batchIds.has(dep)) continue;
			const found = index.get(dep);
			if (!found) {
				problems.push({ taskId: task.id, dependency: dep, why: 'removed' });
			} else if (found.task.status === 'closed') {
				problems.push({ taskId: task.id, dependency: dep, why: 'closed' });
			} else if (found.task.status === 'completed') {
				if (!input.isCommitted(dep)) {
					problems.push({
						taskId: task.id,
						dependency: dep,
						why: 'not-committed',
					});
				}
			} else if (found.phaseId !== input.phaseId) {
				// Phases are iterations: an earlier phase is complete by the time
				// this phase runs, so an unresolved cross-phase dep is a later one.
				problems.push({ taskId: task.id, dependency: dep, why: 'later-phase' });
			}
		}
	}
	if (problems.length > 0) return { kind: 'predecessor-missing', problems };

	const estimated: Record<string, string[]> = Object.create(null);
	for (const task of batch) {
		const live = input.liveScopes[task.id] ?? [];
		estimated[task.id] = live.length > 0 ? live : (task.files_touched ?? []);
	}
	const { partition, choice } = planNextEpicWave({
		directory: input.directory,
		tasks: batch as unknown as PartitionTask[],
		scopes: estimated,
		leanConfig: input.leanConfig,
		hotFiles: input.hotFiles,
		coWrites: input.coWrites,
		cochange: input.cochange,
		maxParallel: input.maxParallel,
		densityThreshold: input.densityThreshold,
		satisfiedOutside,
		history: input.waveHistory,
	});
	const chosen = choice?.taskIds ?? [];

	if (chosen.length === 0) {
		if (blocked.length > 0) return { kind: 'task-blocked', taskIds: blocked };
		// Nothing runnable and nothing blocked: a dependency cycle (or a
		// planner leftover) — the plan must be fixed.
		return {
			kind: 'predecessor-missing',
			problems: batch
				.map((task) => ({
					taskId: task.id,
					dependency: (task.depends ?? [])
						.filter((d) => batchIds.has(d))
						.join(', '),
					why: 'cycle' as const,
				}))
				.filter((problem) => problem.dependency.length > 0),
		};
	}

	const undeclared = chosen.filter(
		(id) => (input.liveScopes[id] ?? []).length === 0,
	);
	if (undeclared.length > 0) {
		return {
			kind: 'declare-scopes',
			tasks: undeclared.map((taskId) => ({
				taskId,
				suggestedFiles: [...(index.get(taskId)?.task.files_touched ?? [])],
			})),
		};
	}

	const files: Record<string, string[]> = Object.create(null);
	for (const id of chosen) files[id] = [...(input.liveScopes[id] ?? [])];
	return {
		kind: 'wave',
		waveKind: choice?.kind ?? 'parallel',
		taskIds: chosen,
		files,
		cochangePairs: input.cochange
			? cochangePairsWithin(Object.values(files).flat(), input.cochange)
			: [],
		components: toWaveComponents(partition, chosen),
	};
}

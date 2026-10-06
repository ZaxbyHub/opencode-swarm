/**
 * Epic v2 C7 — THE plan sizing (pure), shared by `/swarm epic start` and
 * plan shaping (`shaping.ts`), bounded by a work budget.
 *
 * T pending tasks (status ∉ {completed, closed}), C of them with an
 * estimated scope (live declared scope, else `files_touched`), L = Σ over
 * phases of the dry-run steps of the component planner
 * (`dryRunEpicPhase`, `components.ts`: waves + tasks it can never
 * schedule), then `evaluateEpicSizing` (`sizing.ts`: S = T / L, Amdahl
 * S_eff). Cross-phase dependencies count as satisfied (phases run in order).
 *
 * Bounded: every dry-run step is charged its deterministic cost
 * (`epicWaveWork`, ≈ path comparisons) against `maxWork`; when the budget
 * runs out the remaining tasks count as one serial step each (a
 * pessimistic L — never an optimistic one) and the sizing is `aborted`.
 * Without `maxWork` the sizing is unbounded and exact.
 *
 * Pure except {@link isDirectoryOnDisk}, the one bounded stat callers pass
 * to shaping for scope entries without an extension.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../config/constants.js';
import type { LeanTurboConfig, PluginConfig } from '../config/schema.js';
import type { PlanTask as PartitionTask } from '../turbo/lean/partition-common.js';
import { dryRunEpicPhase } from './components.js';
import { resolveEpicConfig } from './config.js';
import type { EpicPlanningSignals } from './planning-signals.js';
import {
	type EpicSizingThresholds,
	type EpicSizingVerdict,
	evaluateEpicSizing,
	resolveEpicSizingThresholds,
} from './sizing.js';

/**
 * Work units `/swarm epic start` may spend sizing a plan (≈ 1.5 s on a
 * laptop; plan shaping's own allowance is `MAX_SHAPING_WORK`). Beyond it
 * the remaining tasks count as serial and the refusal says the plan was
 * too large to size exactly.
 */
export const MAX_START_SIZING_WORK = 60_000_000;

/**
 * Is the project-relative scope `entry` a directory on disk? One `statSync`
 * (false on any error or an escaping path).
 */
export function isDirectoryOnDisk(directory: string, entry: string): boolean {
	const target = path.resolve(directory, entry);
	const relative = path.relative(path.resolve(directory), target);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** The plan view sizing and shaping read (a structural subset of `Plan`). */
export interface EpicShapingTask {
	id: string;
	status?: string;
	size?: string;
	description?: string;
	depends?: readonly string[];
	files_touched?: readonly string[];
}

export interface EpicShapingPhase {
	id: number;
	tasks?: readonly EpicShapingTask[];
}

/** Pending = still to run (the sizing's T): not completed and not closed. */
export function isEpicPendingStatus(status: string | undefined): boolean {
	return status !== 'completed' && status !== 'closed';
}

export interface EpicScopeEstimate {
	/** Pending task id → estimated scope. */
	scopes: Record<string, string[]>;
	pendingIds: string[];
	/** Pending tasks with a non-empty estimated scope. */
	scoped: number;
}

/**
 * Estimated scope of every pending task: the live declared scope, else
 * `files_touched` (declarations are per phase and expire, so most tasks
 * are estimated from the plan).
 */
export function estimateEpicScopes(
	phases: readonly EpicShapingPhase[],
	declared: Readonly<Record<string, readonly string[]>>,
): EpicScopeEstimate {
	const scopes: Record<string, string[]> = Object.create(null);
	const pendingIds: string[] = [];
	let scoped = 0;
	for (const phase of phases) {
		for (const task of phase.tasks ?? []) {
			if (!isEpicPendingStatus(task.status)) continue;
			pendingIds.push(task.id);
			const live = declared[task.id] ?? [];
			scopes[task.id] =
				live.length > 0 ? [...live] : [...(task.files_touched ?? [])];
			if (scopes[task.id].length > 0) scoped += 1;
		}
	}
	return { scopes, pendingIds, scoped };
}

/** Everything the dry run needs besides the tasks and their scopes. */
export interface EpicPlanSizingContext {
	directory: string;
	leanConfig: LeanTurboConfig;
	signals: EpicPlanningSignals;
	maxParallel: number;
	thresholds: EpicSizingThresholds;
}

/**
 * The epic's wave width: `turbo.lean.max_parallel_coders` (default 4) in a
 * git project; 1 otherwise (a non-git epic runs serially).
 */
export function epicWaveWidth(
	config: Pick<PluginConfig, 'turbo'>,
	isGitRepo: boolean,
): number {
	if (!isGitRepo) return 1;
	return Math.max(
		1,
		config.turbo?.lean?.max_parallel_coders ??
			DEFAULT_LEAN_TURBO_CONFIG.max_parallel_coders,
	);
}

/** The sizing context of `config` (lean risk policy + sizing thresholds). */
export function epicSizingContextFor(
	directory: string,
	config: Pick<PluginConfig, 'turbo' | 'epic'>,
	maxParallel: number,
	signals: EpicPlanningSignals,
): EpicPlanSizingContext {
	return {
		directory,
		leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG, ...(config.turbo?.lean ?? {}) },
		signals,
		maxParallel,
		thresholds: resolveEpicSizingThresholds(resolveEpicConfig(config)?.sizing),
	};
}

/** One phase's dry run as the sizing counts it. */
export interface EpicPhaseRun {
	/** Serial steps: waves + unscheduled tasks. */
	steps: number;
	/** Tasks the run could not schedule (cycle, blocked, or budget). */
	unscheduled: number;
	/** Work units spent. */
	work: number;
	/** The run stopped at its work budget. */
	aborted: boolean;
}

/** The pending tasks of a phase, as the planner reads them. */
export function pendingTasksOf(phase: EpicShapingPhase): PartitionTask[] {
	return (phase.tasks ?? []).filter((task) =>
		isEpicPendingStatus(task.status),
	) as unknown as PartitionTask[];
}

/** Dry-run one phase's `tasks` (bounded by `maxWork` when given). */
export function runEpicPhase(
	context: EpicPlanSizingContext,
	tasks: readonly PartitionTask[],
	scopes: Record<string, string[]>,
	maxWork?: number,
): EpicPhaseRun {
	if (tasks.length === 0) {
		return { steps: 0, unscheduled: 0, work: 0, aborted: false };
	}
	const dryRun = dryRunEpicPhase({
		directory: context.directory,
		tasks,
		scopes,
		leanConfig: context.leanConfig,
		hotFiles: context.signals.hotFiles,
		coWrites: context.signals.coWrites,
		cochange: context.signals.cochange,
		maxParallel: context.maxParallel,
		densityThreshold: context.signals.densityThreshold,
		...(maxWork !== undefined ? { maxWork } : {}),
	});
	return {
		steps: dryRun.waves.length + dryRun.unscheduled.length,
		unscheduled: dryRun.unscheduled.length,
		work: dryRun.work,
		aborted: dryRun.aborted,
	};
}

export interface EpicPlanSizing {
	verdict: EpicSizingVerdict;
	/** Phase id → its dry run (phases with pending tasks only). */
	phases: Map<number, EpicPhaseRun>;
	/** Work units spent over all phases. */
	work: number;
	/** A phase's dry run stopped at the budget: L is pessimistic. */
	aborted: boolean;
}

/**
 * THE sizing of a plan (see the module header). `maxWork` bounds the total
 * work over every phase.
 */
export function sizeEpicPlan(
	context: EpicPlanSizingContext,
	phases: readonly EpicShapingPhase[],
	estimate: EpicScopeEstimate,
	maxWork?: number,
): EpicPlanSizing {
	const runs = new Map<number, EpicPhaseRun>();
	let serialSteps = 0;
	let work = 0;
	let aborted = false;
	for (const phase of phases) {
		const pending = pendingTasksOf(phase);
		if (pending.length === 0) continue;
		const run = runEpicPhase(
			context,
			pending,
			estimate.scopes,
			maxWork === undefined ? undefined : Math.max(0, maxWork - work),
		);
		runs.set(phase.id, run);
		serialSteps += run.steps;
		work += run.work;
		aborted ||= run.aborted;
	}
	return {
		verdict: evaluateEpicSizing(
			{
				pendingTasks: estimate.pendingIds.length,
				scopedTasks: estimate.scoped,
				serialSteps,
			},
			context.thresholds,
		),
		phases: runs,
		work,
		aborted,
	};
}

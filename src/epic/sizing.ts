/**
 * Epic sizing (Epic v2 C1a) — pure.
 *
 * Decides whether a plan is worth running as an epic. Inputs are counted by
 * the caller (`src/epic/start.ts`):
 *   T  = pending tasks (status ∉ {completed, closed}) across the plan
 *   C  = pending tasks with a non-empty scope (live declared scope, else
 *        `files_touched`)
 *   L  = serial steps of a dry-run of the Epic component planner
 *        (`components.ts`) over every phase with pending tasks (waves + tasks
 *        it can never schedule), under the epic's own wave-width cap
 *
 *   coverage = C / T,  S = T / L,  S_eff = 1 / ((1 − c) + c / S)   (Amdahl)
 *
 * where c = `epic.sizing.coder_fraction` is the share of a task's
 * wall-clock that parallel coders actually overlap (Stage A/B QA and the
 * architect's turns stay serial). Epic-sized ⇔ T ≥ min_tasks ∧
 * coverage ≥ min_scope_coverage ∧ S_eff ≥ min_effective_speedup.
 */

/** Resolved thresholds (config keys `epic.sizing.*`). */
export interface EpicSizingThresholds {
	minTasks: number;
	minScopeCoverage: number;
	minEffectiveSpeedup: number;
	coderFraction: number;
}

export const DEFAULT_EPIC_SIZING_THRESHOLDS: EpicSizingThresholds = {
	minTasks: 6,
	minScopeCoverage: 0.8,
	minEffectiveSpeedup: 1.25,
	coderFraction: 0.6,
};

export type EpicSizingReason =
	| 'too-few-tasks'
	| 'insufficient-scope-coverage'
	| 'insufficient-parallelism';

export interface EpicSizingInput {
	pendingTasks: number;
	scopedTasks: number;
	serialSteps: number;
}

export interface EpicSizingVerdict {
	epicSized: boolean;
	reasons: EpicSizingReason[];
	pendingTasks: number;
	scopedTasks: number;
	scopeCoverage: number;
	serialSteps: number;
	/** Raw concurrency S = T / L (1 when L = 0). */
	concurrency: number;
	/** Amdahl-adjusted speedup S_eff. */
	effectiveSpeedup: number;
	thresholds: EpicSizingThresholds;
}

/** S_eff = 1 / ((1 − c) + c / S). S ≤ 1 or c ≤ 0 ⇒ 1. */
export function computeEffectiveSpeedup(
	concurrency: number,
	coderFraction: number,
): number {
	const c = Math.min(1, Math.max(0, coderFraction));
	if (!(concurrency > 1) || c === 0) return 1;
	return 1 / (1 - c + c / concurrency);
}

/** Config view consumed by {@link resolveEpicSizingThresholds}. */
export interface EpicSizingConfigView {
	min_tasks?: number;
	min_scope_coverage?: number;
	min_effective_speedup?: number;
	coder_fraction?: number;
}

export function resolveEpicSizingThresholds(
	sizing: EpicSizingConfigView | undefined,
): EpicSizingThresholds {
	const d = DEFAULT_EPIC_SIZING_THRESHOLDS;
	return {
		minTasks: sizing?.min_tasks ?? d.minTasks,
		minScopeCoverage: sizing?.min_scope_coverage ?? d.minScopeCoverage,
		minEffectiveSpeedup: sizing?.min_effective_speedup ?? d.minEffectiveSpeedup,
		coderFraction: sizing?.coder_fraction ?? d.coderFraction,
	};
}

export function evaluateEpicSizing(
	input: EpicSizingInput,
	thresholds: EpicSizingThresholds = DEFAULT_EPIC_SIZING_THRESHOLDS,
): EpicSizingVerdict {
	const pendingTasks = Math.max(0, Math.trunc(input.pendingTasks));
	const scopedTasks = Math.min(
		pendingTasks,
		Math.max(0, Math.trunc(input.scopedTasks)),
	);
	const serialSteps = Math.max(0, Math.trunc(input.serialSteps));
	const scopeCoverage = pendingTasks > 0 ? scopedTasks / pendingTasks : 0;
	const concurrency = serialSteps > 0 ? pendingTasks / serialSteps : 1;
	const effectiveSpeedup = computeEffectiveSpeedup(
		concurrency,
		thresholds.coderFraction,
	);
	const reasons: EpicSizingReason[] = [];
	if (pendingTasks < thresholds.minTasks) reasons.push('too-few-tasks');
	if (scopeCoverage < thresholds.minScopeCoverage) {
		reasons.push('insufficient-scope-coverage');
	}
	if (effectiveSpeedup < thresholds.minEffectiveSpeedup) {
		reasons.push('insufficient-parallelism');
	}
	return {
		epicSized: reasons.length === 0,
		reasons,
		pendingTasks,
		scopedTasks,
		scopeCoverage,
		serialSteps,
		concurrency,
		effectiveSpeedup,
		thresholds,
	};
}

const REASON_TEXT: Record<EpicSizingReason, (v: EpicSizingVerdict) => string> =
	{
		'too-few-tasks': (v) =>
			`too-few-tasks: ${v.pendingTasks} pending task(s) < min_tasks ${v.thresholds.minTasks}`,
		'insufficient-scope-coverage': (v) =>
			`insufficient-scope-coverage: ${v.scopedTasks}/${v.pendingTasks} pending task(s) have a declared scope or files_touched (${(v.scopeCoverage * 100).toFixed(0)}% < ${(v.thresholds.minScopeCoverage * 100).toFixed(0)}%)`,
		'insufficient-parallelism': (v) =>
			`insufficient-parallelism: effective speedup ${v.effectiveSpeedup.toFixed(2)}× < min_effective_speedup ${v.thresholds.minEffectiveSpeedup.toFixed(2)}× (${v.pendingTasks} task(s) in ${v.serialSteps} serial step(s), coder_fraction ${v.thresholds.coderFraction})`,
	};

export function describeEpicSizingReason(
	reason: EpicSizingReason,
	verdict: EpicSizingVerdict,
): string {
	return REASON_TEXT[reason](verdict);
}

/** One-line summary for start/status/report output. */
export function summarizeEpicSizing(verdict: EpicSizingVerdict): string {
	return `${verdict.pendingTasks} pending task(s), scope coverage ${(verdict.scopeCoverage * 100).toFixed(0)}%, ${verdict.serialSteps} serial step(s), concurrency ${verdict.concurrency.toFixed(2)}, effective speedup ${verdict.effectiveSpeedup.toFixed(2)}×`;
}

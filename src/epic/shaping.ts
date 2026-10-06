/**
 * Epic v2 C7 — plan shaping (pure).
 *
 * Tells the architect HOW a plan could run better as an epic, with the same
 * model `/swarm epic start` sizes it with (`shaping-sizing.ts`: a dry run
 * of the component planner, `components.ts`, then `sizing.ts`):
 *
 *   1. baseline: the plan's sizing (T, C, L, S_eff) — passed in by
 *      `/swarm epic start` (its own sizing), computed otherwise;
 *   2. the conflict graph of each phase and the files DRIVING its edges (a
 *      path overlap between two expanded scopes is driven by the shorter
 *      path); edge share = edges a file drives / all edges of the plan;
 *      global/hot files also count the tasks they make exclusive;
 *   3. what-ifs (`shaping-suggestions.ts`): each suggestion is a concrete
 *      save_plan patch, applied to its phase and dry-run again → ΔS_eff;
 *      a patch that would leave more tasks unschedulable (a cycle) is
 *      rejected;
 *   4. suggestions, capped at {@link MAX_SHAPING_SUGGESTIONS}: scope advice
 *      first — `declare-scope` (tasks with no scope run alone) and
 *      `narrow-scope` (a directory entry driving conflicts: it cannot be
 *      extracted) — then by ΔS_eff: `extract-prerequisite` (a hub file of
 *      ≥ 3 tasks with edge share ≥ 0.25 or ΔS_eff ≥ 0.25 moved into a new
 *      prerequisite task), `isolate-hot-file` (a learned hot file of fewer
 *      tasks, same patch), `split-task` (an articulation task, one part per
 *      cluster), `merge-tasks` (two small tasks with scope Jaccard ≥ 0.8;
 *      offered at ΔS_eff ≥ 0 — they serialize anyway and one task saves a
 *      QA cycle).
 *
 * Verdicts: `acceptable` (epic-sized; nothing worth changing),
 * `improvable` (a suggestion makes the plan epic-sized, improves an
 * epic-sized plan by ≥ {@link MIN_USEFUL_DELTA}, or scope advice applies),
 * `not-epic-sized` (no suggestion makes it epic-sized — run it in Balanced),
 * `skipped-budget` (over {@link MAX_SHAPING_TASKS} pending tasks or
 * {@link MAX_SHAPING_FILES} distinct scope files, or the baseline did not
 * fit the work budget, or no what-if did).
 *
 * Bounded by WORK, not by a clock: one {@link MAX_SHAPING_WORK} meter
 * (deterministic units ≈ path comparisons, `epicWaveWork`) is charged for
 * the baseline dry runs (each step before it runs), the graph builds, the
 * edge-driver lookups, the merge pair scan and every what-if dry run; when
 * it runs out the rest is skipped. Calibrated so the worst plan within the
 * caps adds ≈ 0.3 s to a save_plan on a laptop. A synchronous computation
 * cannot be interrupted by a timeout (`withTimeout` would only stop
 * waiting), so there is no timeout verdict — the budget is the bound.
 *
 * Analysis only: nothing here is write authorization or plan state.
 */

import { normalizePath } from '../turbo/lean/conflicts.js';
import type { PlanTask as PartitionTask } from '../turbo/lean/partition-common.js';
import {
	type EpicPlanSizing,
	type EpicPlanSizingContext,
	type EpicShapingPhase,
	estimateEpicScopes,
	sizeEpicPlan,
} from './shaping-sizing.js';
import {
	articulationPoints,
	dependencyIndex,
	type EpicShapingSuggestion,
	EpicWorkMeter,
	fileSuggestion,
	isDirectoryEntry,
	jaccard,
	MERGE_MIN_JACCARD,
	mergeSuggestion,
	modelPhase,
	narrowScopeSuggestion,
	type PhaseModel,
	type ShapingBase,
	splitSuggestion,
} from './shaping-suggestions.js';
import { describeEpicSizingReason, type EpicSizingVerdict } from './sizing.js';

/** Plans with more pending tasks are not shaped (`skipped-budget`). */
export const MAX_SHAPING_TASKS = 200;
/** Plans whose pending scopes name more distinct files are not shaped. */
export const MAX_SHAPING_FILES = 500;
/** File what-ifs (extract / isolate), top candidates only. */
export const MAX_WHAT_IF_FILES = 10;
/** Split-task what-ifs (articulation tasks, highest degree first). */
export const MAX_WHAT_IF_SPLITS = 3;
/** Merge-tasks what-ifs (highest Jaccard first). */
export const MAX_WHAT_IF_MERGES = 3;
/**
 * Work units for one whole shaping (baseline + analysis + what-ifs) — the
 * save_plan latency bound (see the module header).
 */
export const MAX_SHAPING_WORK = 6_000_000;
/** Suggestions returned. */
export const MAX_SHAPING_SUGGESTIONS = 5;
/** An epic-sized plan is `improvable` only for a gain at least this. */
export const MIN_USEFUL_DELTA = 0.05;
/** Task ids listed by one `declare-scope` suggestion. */
const MAX_LISTED_TASKS = 20;

export type EpicShapingVerdictKind =
	| 'acceptable'
	| 'improvable'
	| 'not-epic-sized'
	| 'skipped-budget';

export interface EpicShapingReport {
	verdict: EpicShapingVerdictKind;
	/** Baseline sizing (null when it was not (fully) computed). */
	sizing: EpicSizingVerdict | null;
	suggestions: EpicShapingSuggestion[];
	budget: {
		tasks: number;
		files: number;
		maxTasks: number;
		maxFiles: number;
		whatIfs: number;
		/** Work units spent and the allowance. */
		work: number;
		maxWork: number;
		/** Something was skipped because the work budget ran out. */
		truncated: boolean;
	};
}

export interface EpicShapingInput extends EpicPlanSizingContext {
	phases: readonly EpicShapingPhase[];
	/** Live declared scope per task id (`[]`/absent ⇒ `files_touched`). */
	declared: Readonly<Record<string, readonly string[]>>;
	/**
	 * The caller's own sizing of this plan with these inputs (the start's) —
	 * reused instead of a second baseline. An aborted one ⇒ skipped-budget.
	 */
	baseline?: EpicPlanSizing;
	/** On-disk directory check for no-extension scope entries (optional). */
	isDirectory?: (entry: string) => boolean;
	/** Work allowance (default {@link MAX_SHAPING_WORK}). */
	maxWork?: number;
}

const TYPE_ORDER: Record<EpicShapingSuggestion['type'], number> = {
	'declare-scope': 0,
	'narrow-scope': 1,
	'extract-prerequisite': 2,
	'isolate-hot-file': 3,
	'split-task': 4,
	'merge-tasks': 5,
};

const isScopeAdvice = (s: EpicShapingSuggestion) =>
	s.type === 'declare-scope' || s.type === 'narrow-scope';

/** Shape one plan (see the module header). */
export function shapeEpicPlan(input: EpicShapingInput): EpicShapingReport {
	const estimate = estimateEpicScopes(input.phases, input.declared);
	const files = new Set<string>();
	for (const id of estimate.pendingIds) {
		for (const entry of estimate.scopes[id] ?? []) {
			files.add(normalizePath(entry));
		}
	}
	const meter = new EpicWorkMeter(input.maxWork ?? MAX_SHAPING_WORK);
	const budget = {
		tasks: estimate.pendingIds.length,
		files: files.size,
		maxTasks: MAX_SHAPING_TASKS,
		maxFiles: MAX_SHAPING_FILES,
		whatIfs: 0,
		work: 0,
		maxWork: meter.max,
		truncated: false,
	};
	const skipped = (sizing: EpicSizingVerdict | null): EpicShapingReport => ({
		verdict: 'skipped-budget',
		sizing,
		suggestions: [],
		budget: { ...budget, work: meter.spent, truncated: true },
	});
	if (budget.tasks > MAX_SHAPING_TASKS || budget.files > MAX_SHAPING_FILES) {
		return skipped(null);
	}
	let sizing = input.baseline;
	if (!sizing) {
		sizing = sizeEpicPlan(input, input.phases, estimate, meter.left);
		meter.charge(Math.min(sizing.work, meter.left));
	}
	if (sizing.aborted) return skipped(null);

	const { dependsOf, dependents } = dependencyIndex(input.phases);
	const usedIds = new Set<string>(dependsOf.keys());
	const base: ShapingBase = {
		context: input,
		phases: input.phases,
		estimate,
		sizing,
		hot: new Set(input.signals.hotFiles.map(normalizePath)),
		usedIds,
		dependsOf,
		dependents,
		...(input.isDirectory ? { isDirectory: input.isDirectory } : {}),
		meter,
	};

	const suggestions: EpicShapingSuggestion[] = [];
	const unscoped = estimate.pendingIds.filter(
		(id) => (estimate.scopes[id] ?? []).length === 0,
	);
	if (unscoped.length > 0) {
		const listed = unscoped.slice(0, MAX_LISTED_TASKS);
		suggestions.push({
			type: 'declare-scope',
			taskIds: listed,
			count: unscoped.length,
			deltaEffectiveSpeedup: null,
			whatIf: null,
			summary: `Give ${unscoped.length} task(s) a scope (files_touched in save_plan): ${listed.join(', ')}${unscoped.length > listed.length ? ', …' : ''} — a task without a scope always runs alone.`,
		});
	}

	const models: PhaseModel[] = [];
	for (const phase of input.phases) {
		const model = modelPhase(base, phase);
		if (model) models.push(model);
	}
	const totalEdges = models.reduce((sum, m) => sum + m.edgeCount, 0);
	let attempted = 0;

	// File candidates: edges driven + tasks made exclusive, top N; directory
	// entries become scope advice instead of a what-if.
	const allPaths = files;
	const candidates: Array<{ model: PhaseModel; file: string; score: number }> =
		[];
	for (const model of models) {
		const fileSet = new Set([
			...model.driven.keys(),
			...model.exclusiveCaused.keys(),
			...[...base.hot].filter((file) =>
				model.tasks.some((task) =>
					(estimate.scopes[task.id] ?? []).some(
						(entry) => normalizePath(entry) === file,
					),
				),
			),
		]);
		for (const file of fileSet) {
			const score =
				(model.driven.get(file) ?? 0) + (model.exclusiveCaused.get(file) ?? 0);
			if (score > 0 || base.hot.has(file)) {
				candidates.push({ model, file, score });
			}
		}
	}
	candidates.sort(
		(a, b) =>
			b.score - a.score ||
			a.model.phase.id - b.model.phase.id ||
			a.file.localeCompare(b.file),
	);
	for (const candidate of candidates.slice(0, MAX_WHAT_IF_FILES)) {
		const owners = candidate.model.tasks.filter((task) =>
			(estimate.scopes[task.id] ?? []).some(
				(entry) => normalizePath(entry) === candidate.file,
			),
		);
		const raw = owners.flatMap((task) =>
			(estimate.scopes[task.id] ?? []).filter(
				(entry) => normalizePath(entry) === candidate.file,
			),
		);
		if (
			owners.length > 0 &&
			isDirectoryEntry(base, candidate.file, raw, allPaths)
		) {
			suggestions.push(
				narrowScopeSuggestion(
					candidate.model.phase,
					candidate.file,
					owners.map((task) => task.id),
				),
			);
			continue;
		}
		if (meter.left === 0) break;
		attempted += 1;
		const suggestion = fileSuggestion(
			base,
			candidate.model,
			candidate.file,
			totalEdges,
		);
		if (suggestion) suggestions.push(suggestion);
	}

	// Split candidates: articulation tasks, highest degree first.
	const splits: Array<{ model: PhaseModel; id: string; degree: number }> = [];
	for (const model of models) {
		if (!meter.charge(model.edgeCount + model.tasks.length)) break;
		for (const id of articulationPoints(model.graph)) {
			const task = model.tasks.find((t) => t.id === id);
			if (task?.status !== 'pending') continue;
			splits.push({
				model,
				id,
				degree: model.graph.adjacency.get(id)?.size ?? 0,
			});
		}
	}
	splits.sort(
		(a, b) =>
			b.degree - a.degree ||
			a.model.phase.id - b.model.phase.id ||
			a.id.localeCompare(b.id),
	);
	for (const split of splits.slice(0, MAX_WHAT_IF_SPLITS)) {
		if (meter.left === 0) break;
		attempted += 1;
		const suggestion = splitSuggestion(base, split.model, split.id);
		if (suggestion) suggestions.push(suggestion);
	}

	// Merge candidates: small pending pairs with near-identical scopes.
	const merges: Array<{
		model: PhaseModel;
		keep: PartitionTask;
		absorb: PartitionTask;
		similarity: number;
	}> = [];
	for (const model of models) {
		const small = model.tasks.filter(
			(task) =>
				task.status === 'pending' &&
				((task as { size?: string }).size ?? 'small') === 'small' &&
				(estimate.scopes[task.id] ?? []).length > 0,
		);
		const sets = new Map(
			small.map((task) => [
				task.id,
				new Set((estimate.scopes[task.id] ?? []).map(normalizePath)),
			]),
		);
		const avg =
			small.reduce((sum, task) => sum + (sets.get(task.id)?.size ?? 0), 0) /
			Math.max(1, small.length);
		if (
			!meter.charge(
				Math.ceil(((small.length * (small.length - 1)) / 2) * (avg + 1)),
			)
		) {
			break;
		}
		for (let i = 0; i < small.length; i += 1) {
			for (let j = i + 1; j < small.length; j += 1) {
				const similarity = jaccard(
					sets.get(small[i].id) ?? new Set(),
					sets.get(small[j].id) ?? new Set(),
				);
				if (similarity < MERGE_MIN_JACCARD) continue;
				const [keep, absorb] =
					(model.graph.topoIndex.get(small[i].id) ?? 0) <=
					(model.graph.topoIndex.get(small[j].id) ?? 0)
						? [small[i], small[j]]
						: [small[j], small[i]];
				merges.push({ model, keep, absorb, similarity });
			}
		}
	}
	merges.sort(
		(a, b) =>
			b.similarity - a.similarity ||
			a.model.phase.id - b.model.phase.id ||
			a.keep.id.localeCompare(b.keep.id) ||
			a.absorb.id.localeCompare(b.absorb.id),
	);
	for (const merge of merges.slice(0, MAX_WHAT_IF_MERGES)) {
		if (meter.left === 0) break;
		attempted += 1;
		const suggestion = mergeSuggestion(
			base,
			merge.model.phase,
			merge.keep,
			merge.absorb,
			merge.similarity,
		);
		if (suggestion) suggestions.push(suggestion);
	}

	suggestions.sort(
		(a, b) =>
			(isScopeAdvice(a) ? 0 : 1) - (isScopeAdvice(b) ? 0 : 1) ||
			(b.deltaEffectiveSpeedup ?? 0) - (a.deltaEffectiveSpeedup ?? 0) ||
			TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
			a.summary.localeCompare(b.summary),
	);
	const ranked = suggestions.slice(0, MAX_SHAPING_SUGGESTIONS);
	const finalBudget = {
		...budget,
		whatIfs: attempted,
		work: meter.spent,
		truncated: meter.truncated,
	};
	// The budget ran out before anything could be judged: say so.
	if (meter.truncated && ranked.length === 0 && !sizing.verdict.epicSized) {
		return {
			verdict: 'skipped-budget',
			sizing: sizing.verdict,
			suggestions: [],
			budget: finalBudget,
		};
	}
	return {
		verdict: verdictOf(sizing.verdict, ranked),
		sizing: sizing.verdict,
		suggestions: ranked,
		budget: finalBudget,
	};
}

function verdictOf(
	sizing: EpicSizingVerdict,
	suggestions: readonly EpicShapingSuggestion[],
): EpicShapingVerdictKind {
	const scopeAdvice = suggestions.some(isScopeAdvice);
	if (sizing.epicSized) {
		const useful = suggestions.some(
			(s) => (s.deltaEffectiveSpeedup ?? 0) >= MIN_USEFUL_DELTA,
		);
		return useful || scopeAdvice ? 'improvable' : 'acceptable';
	}
	if (suggestions.some((s) => s.whatIf?.epicSized === true))
		return 'improvable';
	// Scopes may change everything — unless the plan is simply too small.
	if (scopeAdvice && !sizing.reasons.includes('too-few-tasks')) {
		return 'improvable';
	}
	return 'not-epic-sized';
}

/** Why shaping was skipped (`skipped-budget`). */
export function describeEpicShapingSkip(report: EpicShapingReport): string {
	const { budget } = report;
	if (budget.tasks > budget.maxTasks || budget.files > budget.maxFiles) {
		return `Plan shaping skipped: ${budget.tasks} pending task(s) / ${budget.files} scope file(s) exceed the shaping budget (${budget.maxTasks} tasks / ${budget.maxFiles} files).`;
	}
	if (report.sizing === null) {
		return `Plan shaping skipped: the plan (${budget.tasks} pending task(s), ${budget.files} scope file(s)) is too large or densely coupled to size within the shaping work budget.`;
	}
	return `Plan shaping skipped: the plan is too densely coupled to evaluate suggestions within the shaping work budget (effective speedup ${report.sizing.effectiveSpeedup.toFixed(2)}×, ${report.sizing.pendingTasks} task(s) in ${report.sizing.serialSteps} serial step(s)${report.sizing.epicSized ? '' : ' — not epic-sized'}).`;
}

/** `<reason>; <reason>` — the sizing reasons as one line. */
export function describeEpicShapingReasons(sizing: EpicSizingVerdict): string {
	return sizing.reasons
		.map((reason) => describeEpicSizingReason(reason, sizing))
		.join('; ');
}

const VERDICT_TEXT: Record<EpicShapingVerdictKind, string> = {
	acceptable: 'epic-sized, nothing worth reshaping',
	improvable: 'the suggestions below would help',
	'not-epic-sized':
		'not epic-sized, and no suggestion makes it epic-sized — run it in Balanced',
	'skipped-budget': 'skipped (budget)',
};

function depList(ids: readonly string[]): string {
	return `[${ids.join(', ')}]`;
}

/** Markdown lines of the advisory (`/swarm coupling --suggest`, start). */
export function formatEpicShapingLines(
	report: EpicShapingReport,
	options: { maxSuggestions?: number } = {},
): string[] {
	if (report.verdict === 'skipped-budget') {
		return [describeEpicShapingSkip(report)];
	}
	const sizing = report.sizing;
	const lines: string[] = [
		`Plan shaping: **${report.verdict}** — ${VERDICT_TEXT[report.verdict]}${sizing ? ` (effective speedup ${sizing.effectiveSpeedup.toFixed(2)}×, ${sizing.pendingTasks} task(s) in ${sizing.serialSteps} serial step(s))` : ''}.`,
	];
	const shown = report.suggestions.slice(
		0,
		options.maxSuggestions ?? MAX_SHAPING_SUGGESTIONS,
	);
	shown.forEach((suggestion, index) => {
		lines.push(`${index + 1}. [${suggestion.type}] ${suggestion.summary}`);
		const editText = (
			edits: readonly {
				taskId: string;
				files_touched?: string[];
				depends: string[];
			}[],
		) =>
			edits
				.map(
					(edit) =>
						`${edit.taskId}: ${edit.files_touched ? `files_touched ${depList(edit.files_touched)}, ` : ''}depends ${depList(edit.depends)}`,
				)
				.join('; ');
		if (
			suggestion.type === 'extract-prerequisite' ||
			suggestion.type === 'isolate-hot-file'
		) {
			const { newTask, edits } = suggestion.patch;
			lines.push(
				`   Patch: add task ${newTask.id} to phase ${newTask.phase} (files_touched ${depList(newTask.files_touched)}, depends ${depList(newTask.depends)}); ${editText(edits)}.`,
			);
		} else if (suggestion.type === 'split-task') {
			const { newTasks, edits } = suggestion.patch;
			lines.push(
				`   Patch: add ${newTasks.map((t) => `task ${t.id} (files_touched ${depList(t.files_touched)})`).join(', ')} to phase ${suggestion.phase}; ${editText(edits)}.`,
			);
		} else if (suggestion.type === 'merge-tasks') {
			lines.push(
				`   Patch: removed_task_ids [${suggestion.absorb}] (removal_reason given); ${editText(suggestion.patch.edits)}.`,
			);
		}
	});
	if (report.suggestions.length > shown.length) {
		lines.push(
			`(${report.suggestions.length - shown.length} more — \`/swarm coupling --suggest\` lists all.)`,
		);
	}
	return lines;
}

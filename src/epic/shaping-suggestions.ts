/**
 * Epic v2 C7 — plan-shaping suggestion builders (pure; orchestrated by
 * `shapeEpicPlan` in `shaping.ts`).
 *
 * Every suggestion that changes the plan is a CONCRETE `save_plan` patch
 * (complete resulting `files_touched` / `depends` per touched task, new
 * task ids unused and valid) and is judged by a what-if: the patch applied
 * to the phase, the phase dry-run again (`runEpicPhase`), L and S_eff
 * recomputed. A what-if is rejected when it leaves more tasks unschedulable
 * than the baseline (a dependency cycle the patch would create), when it
 * does not finish within the work budget, or when it does not help.
 *
 * Work is metered ({@link EpicWorkMeter}): graph builds, edge-driver
 * lookups, merge pair scans and every dry run are charged their
 * deterministic cost; when the meter runs out the remaining candidates are
 * skipped (`truncated`).
 */

import {
	isGlobalFile,
	normalizePath,
	pathsConflict,
} from '../turbo/lean/conflicts.js';
import type { PlanTask as PartitionTask } from '../turbo/lean/partition-common.js';
import {
	buildEpicConflictGraph,
	type EpicConflictGraph,
	epicWaveWork,
} from './components.js';
import { expandEpicScope } from './learning.js';
import {
	type EpicPlanSizing,
	type EpicPlanSizingContext,
	type EpicScopeEstimate,
	type EpicShapingPhase,
	pendingTasksOf,
	runEpicPhase,
} from './shaping-sizing.js';
import { evaluateEpicSizing } from './sizing.js';

/** Hub rule: a file declared by at least this many tasks… */
export const HUB_MIN_TASKS = 3;
/** …driving at least this share of the plan's conflict edges… */
export const HUB_MIN_EDGE_SHARE = 0.25;
/** …or whose extraction gains at least this much S_eff. */
export const HUB_MIN_DELTA = 0.25;
/** Merge rule: scope Jaccard similarity at least this. */
export const MERGE_MIN_JACCARD = 0.8;

/** Deterministic work meter (units ≈ path comparisons, `epicWaveWork`). */
export class EpicWorkMeter {
	spent = 0;
	truncated = false;
	constructor(readonly max: number) {}
	get left(): number {
		return Math.max(0, this.max - this.spent);
	}
	/** Spend `cost` if it fits; otherwise mark the meter truncated. */
	charge(cost: number): boolean {
		if (this.spent + cost > this.max) {
			this.truncated = true;
			return false;
		}
		this.spent += cost;
		return true;
	}
}

/** What a suggestion would do to the sizing (the changed plan's sizing). */
export interface EpicShapingWhatIf {
	effectiveSpeedup: number;
	serialSteps: number;
	pendingTasks: number;
	epicSized: boolean;
}

/** One task edit of a patch; the resulting fields are complete. */
export interface EpicShapingTaskEdit {
	taskId: string;
	/** The task's complete `depends` after the edit. */
	depends: string[];
	/** The task's complete `files_touched` after the edit (when changed). */
	files_touched?: string[];
	/** Delta view of the same edit (extract / isolate). */
	remove_files?: string[];
	add_depends?: string[];
}

export interface EpicShapingNewTask {
	id: string;
	phase: number;
	description: string;
	files_touched: string[];
	depends: string[];
}

/** extract-prerequisite / isolate-hot-file: add `newTask`, apply `edits`. */
export interface EpicShapingPatch {
	newTask: EpicShapingNewTask;
	edits: EpicShapingTaskEdit[];
}

interface SuggestionBase {
	summary: string;
	/** ΔS_eff of the what-if (null: not computable — scope advice). */
	deltaEffectiveSpeedup: number | null;
	whatIf: EpicShapingWhatIf | null;
}

export type EpicShapingSuggestion =
	| (SuggestionBase & {
			type: 'declare-scope';
			taskIds: string[];
			count: number;
	  })
	| (SuggestionBase & {
			type: 'narrow-scope';
			phase: number;
			/** The directory entry that conflicts with every task under it. */
			entry: string;
			taskIds: string[];
	  })
	| (SuggestionBase & {
			type: 'extract-prerequisite' | 'isolate-hot-file';
			phase: number;
			file: string;
			fileKind: 'global-file' | 'hot-file' | 'hub-file';
			taskIds: string[];
			edgeShare: number;
			patch: EpicShapingPatch;
	  })
	| (SuggestionBase & {
			type: 'split-task';
			phase: number;
			taskId: string;
			/** One file set per part (part 1 keeps the task id). */
			parts: string[][];
			patch: { newTasks: EpicShapingNewTask[]; edits: EpicShapingTaskEdit[] };
	  })
	| (SuggestionBase & {
			type: 'merge-tasks';
			phase: number;
			keep: string;
			absorb: string;
			jaccard: number;
			patch: {
				removed_task_ids: string[];
				removal_reason: string;
				edits: EpicShapingTaskEdit[];
			};
	  });

/** Everything a builder needs about the baseline. */
export interface ShapingBase {
	context: EpicPlanSizingContext;
	phases: readonly EpicShapingPhase[];
	estimate: EpicScopeEstimate;
	sizing: EpicPlanSizing;
	hot: ReadonlySet<string>;
	/** Every task id of the plan, any status (new ids must be unused). */
	usedIds: ReadonlySet<string>;
	/** Task id → depends, every task of the plan. */
	dependsOf: ReadonlyMap<string, readonly string[]>;
	/** Task id → the tasks that depend on it, every task of the plan. */
	dependents: ReadonlyMap<string, readonly string[]>;
	/** Optional on-disk directory check for scope entries (no-extension names). */
	isDirectory?: (entry: string) => boolean;
	meter: EpicWorkMeter;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

const cmpKey = (p: string) =>
	process.platform === 'win32' ? p.toLowerCase() : p;

/** Ancestor directories of a normalized path, nearest first. */
function ancestors(p: string): string[] {
	const out: string[] = [];
	for (let k = p.lastIndexOf('/'); k > 0; k = p.lastIndexOf('/', k - 1)) {
		out.push(p.slice(0, k));
	}
	return out;
}

/** Next unused `<phase>.<n>` task id (and reserve it in `taken`). */
export function nextTaskId(phaseId: number, taken: Set<string>): string {
	let max = 0;
	const prefix = `${phaseId}.`;
	for (const id of taken) {
		if (!id.startsWith(prefix)) continue;
		const minor = Number.parseInt(id.slice(prefix.length).split('.')[0], 10);
		if (Number.isInteger(minor) && minor > max) max = minor;
	}
	let candidate = max + 1;
	while (taken.has(`${phaseId}.${candidate}`)) candidate += 1;
	const id = `${phaseId}.${candidate}`;
	taken.add(id);
	return id;
}

/** Does `from` (transitively, through `depends`) depend on `target`? */
export function dependsOnTransitively(
	base: ShapingBase,
	from: string,
	target: string,
): boolean {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const dep of base.dependsOf.get(id) ?? []) stack.push(dep);
	}
	return false;
}

// ─── Phase model: graph + edge drivers ─────────────────────────────────────

export interface PhaseModel {
	phase: EpicShapingPhase;
	tasks: PartitionTask[];
	graph: EpicConflictGraph;
	edgeCount: number;
	/** File → edges it drives (path overlaps; the shorter path drives). */
	driven: Map<string, number>;
	/** File → tasks it makes exclusive (global / hot). */
	exclusiveCaused: Map<string, number>;
}

/** Model one phase, or null (no pending task, or out of budget). */
export function modelPhase(
	base: ShapingBase,
	phase: EpicShapingPhase,
): PhaseModel | null {
	const scopes = base.estimate.scopes;
	const tasks = pendingTasksOf(phase).filter((t) => t.status !== 'blocked');
	if (tasks.length === 0) return null;
	if (
		!base.meter.charge(
			epicWaveWork(
				tasks.map((t) => (scopes[t.id] ?? []).length),
				0,
			),
		)
	) {
		return null;
	}
	const graph = buildEpicConflictGraph({
		directory: base.context.directory,
		tasks,
		scopes,
		leanConfig: base.context.leanConfig,
		hotFiles: base.context.signals.hotFiles,
		coWrites: base.context.signals.coWrites,
		cochange: base.context.signals.cochange,
	});
	// Index each vertex's expanded scope once: drivers by lookup, not |a|×|b|.
	const index = new Map<
		string,
		{ files: string[]; paths: Map<string, string>; dirs: Map<string, string> }
	>();
	for (const id of graph.adjacency.keys()) {
		const files = expandEpicScope(
			scopes[id] ?? [],
			base.context.signals.coWrites,
		);
		const paths = new Map<string, string>();
		const dirs = new Map<string, string>();
		for (const file of files) {
			paths.set(cmpKey(file), file);
			for (const dir of ancestors(file)) dirs.set(cmpKey(dir), dir);
		}
		index.set(id, { files, paths, dirs });
	}
	let edgeCount = 0;
	const driven = new Map<string, number>();
	for (const [a, neighbours] of graph.adjacency) {
		for (const b of neighbours) {
			if (a >= b) continue;
			edgeCount += 1;
			const ia = index.get(a);
			const ib = index.get(b);
			if (!ia || !ib) continue;
			if (!base.meter.charge(ia.files.length * 4 + 1)) return null;
			const drivers = new Set<string>();
			for (const x of ia.files) {
				const key = cmpKey(x);
				if (ib.paths.has(key) || ib.dirs.has(key)) drivers.add(x);
				for (const dir of ancestors(x)) {
					const hit = ib.paths.get(cmpKey(dir));
					if (hit !== undefined) drivers.add(hit);
				}
			}
			for (const file of drivers) {
				driven.set(file, (driven.get(file) ?? 0) + 1);
			}
		}
	}
	const exclusiveCaused = new Map<string, number>();
	for (const [id, reason] of graph.exclusive) {
		if (reason !== 'global-file' && reason !== 'hot-file') continue;
		for (const file of new Set((scopes[id] ?? []).map(normalizePath))) {
			if (isGlobalFile(file) || base.hot.has(file)) {
				exclusiveCaused.set(file, (exclusiveCaused.get(file) ?? 0) + 1);
			}
		}
	}
	return { phase, tasks, graph, edgeCount, driven, exclusiveCaused };
}

// ─── What-if ────────────────────────────────────────────────────────────────

/**
 * Sizing with ONE phase's pending tasks replaced by `phaseTasks` (scopes
 * from `scopes`); null when the what-if is invalid (more unschedulable
 * tasks than the baseline — a cycle) or out of budget.
 */
function whatIf(
	base: ShapingBase,
	phase: EpicShapingPhase,
	phaseTasks: PartitionTask[],
	scopes: Record<string, string[]>,
): EpicShapingWhatIf | null {
	const baseline = base.sizing.phases.get(phase.id);
	if (!baseline) return null;
	const run = runEpicPhase(base.context, phaseTasks, scopes, base.meter.left);
	base.meter.charge(Math.min(run.work, base.meter.left));
	if (run.aborted) {
		base.meter.truncated = true;
		return null;
	}
	if (run.unscheduled > baseline.unscheduled) return null;
	const before = pendingTasksOf(phase);
	const scopedIn = (
		list: readonly { id: string }[],
		map: Record<string, string[]>,
	) => list.filter((task) => (map[task.id] ?? []).length > 0).length;
	const verdict = evaluateEpicSizing(
		{
			pendingTasks:
				base.estimate.pendingIds.length + phaseTasks.length - before.length,
			scopedTasks:
				base.estimate.scoped -
				scopedIn(before, base.estimate.scopes) +
				scopedIn(phaseTasks, scopes),
			serialSteps: base.sizing.verdict.serialSteps - baseline.steps + run.steps,
		},
		base.context.thresholds,
	);
	return {
		effectiveSpeedup: verdict.effectiveSpeedup,
		serialSteps: verdict.serialSteps,
		pendingTasks: verdict.pendingTasks,
		epicSized: verdict.epicSized,
	};
}

function gainOf(base: ShapingBase, result: EpicShapingWhatIf): number {
	return round3(result.effectiveSpeedup - base.sizing.verdict.effectiveSpeedup);
}

function speedupText(base: ShapingBase, result: EpicShapingWhatIf): string {
	return `effective speedup ${base.sizing.verdict.effectiveSpeedup.toFixed(2)}× → ${result.effectiveSpeedup.toFixed(2)}×`;
}

/** The tasks of `phaseTasks` with `depends` replaced per `edits`. */
function withDepends(
	phaseTasks: readonly PartitionTask[],
	edits: ReadonlyMap<string, readonly string[]>,
): PartitionTask[] {
	return phaseTasks.map((task) => {
		const depends = edits.get(task.id);
		return depends ? { ...task, depends: [...depends] } : task;
	});
}

// ─── Directory entries ──────────────────────────────────────────────────────

/**
 * A scope entry that names a directory: a trailing separator, a prefix of
 * another scope path of the plan, or (no extension) a directory on disk
 * when the caller can check — without a checker a name without an
 * extension counts as a directory.
 */
export function isDirectoryEntry(
	base: ShapingBase,
	entry: string,
	rawEntries: readonly string[],
	allPaths: ReadonlySet<string>,
): boolean {
	if (rawEntries.some((raw) => /[\\/]$/.test(raw))) return true;
	for (const dir of allPaths) {
		if (
			dir !== entry &&
			pathsConflict(entry, dir) &&
			dir.length > entry.length
		) {
			return true;
		}
	}
	const name = entry.slice(entry.lastIndexOf('/') + 1);
	if (name.includes('.')) return false;
	return base.isDirectory ? base.isDirectory(entry) : true;
}

export function narrowScopeSuggestion(
	phase: EpicShapingPhase,
	entry: string,
	taskIds: string[],
): EpicShapingSuggestion {
	return {
		type: 'narrow-scope',
		phase: phase.id,
		entry,
		taskIds,
		deltaEffectiveSpeedup: null,
		whatIf: null,
		summary: `Narrow the directory scope ${entry} of task(s) ${taskIds.join(', ')} to the files they actually change (files_touched in save_plan) — a directory entry conflicts with every task under it, so it cannot be extracted.`,
	};
}

// ─── extract-prerequisite / isolate-hot-file ───────────────────────────────

export function fileSuggestion(
	base: ShapingBase,
	model: PhaseModel,
	file: string,
	totalEdges: number,
): EpicShapingSuggestion | null {
	const { phase } = model;
	const scopes = base.estimate.scopes;
	const owners = model.tasks.filter(
		(task) =>
			task.status === 'pending' &&
			(scopes[task.id] ?? []).some((entry) => normalizePath(entry) === file),
	);
	if (owners.length === 0) return null;
	const ownerIds = owners.map((task) => task.id);
	const taken = new Set(base.usedIds);
	const newId = nextTaskId(phase.id, taken);
	// The prerequisite inherits the owners' outside dependencies — except
	// those that (transitively) depend on an owner: newId → d → owner →
	// newId would be a cycle.
	const prereqDepends = [
		...new Set(owners.flatMap((task) => task.depends ?? [])),
	]
		.filter(
			(dep) =>
				!ownerIds.includes(dep) &&
				!ownerIds.some((owner) => dependsOnTransitively(base, dep, owner)),
		)
		.sort((a, b) => a.localeCompare(b));
	const edits: EpicShapingTaskEdit[] = owners.map((task) => {
		const scope = scopes[task.id] ?? [];
		const removed = scope.filter((entry) => normalizePath(entry) === file);
		const rest = scope.filter((entry) => normalizePath(entry) !== file);
		// A task whose whole scope is f keeps it (it must still edit f).
		const keep = rest.length === 0;
		return {
			taskId: task.id,
			remove_files: keep ? [] : removed,
			add_depends: [newId],
			files_touched: keep ? [...scope] : rest,
			depends: [...(task.depends ?? []), newId],
		};
	});
	const description = `Prepare ${file} for tasks ${ownerIds.join(', ')}: make every change they need in ${file} first (extracted shared prerequisite), so they can run in parallel without touching it.`;
	const nextScopes: Record<string, string[]> = { ...scopes, [newId]: [file] };
	for (const edit of edits) nextScopes[edit.taskId] = edit.files_touched ?? [];
	const phaseTasks: PartitionTask[] = [
		...withDepends(
			pendingTasksOf(phase),
			new Map(edits.map((edit) => [edit.taskId, edit.depends])),
		),
		{
			id: newId,
			description,
			status: 'pending',
			depends: prereqDepends,
			files_touched: [file],
		},
	];
	const result = whatIf(base, phase, phaseTasks, nextScopes);
	if (!result) return null;
	const gain = gainOf(base, result);
	if (!(gain > 0)) return null;
	const edgeShare =
		totalEdges > 0 ? round3((model.driven.get(file) ?? 0) / totalEdges) : 0;
	const isHot = base.hot.has(file);
	const fileKind = isGlobalFile(file)
		? 'global-file'
		: isHot
			? 'hot-file'
			: 'hub-file';
	let type: 'extract-prerequisite' | 'isolate-hot-file';
	if (
		owners.length >= HUB_MIN_TASKS &&
		(edgeShare >= HUB_MIN_EDGE_SHARE || gain >= HUB_MIN_DELTA)
	) {
		type = 'extract-prerequisite';
	} else if (isHot) {
		type = 'isolate-hot-file';
	} else {
		return null;
	}
	const verb =
		type === 'extract-prerequisite'
			? `Extract ${fileKind} ${file} (declared by ${ownerIds.length} tasks, ${Math.round(edgeShare * 100)}% of conflict edges) into prerequisite task ${newId}`
			: `Isolate hot file ${file} into its own task ${newId} (so ${ownerIds.join(', ')} stop running alone)`;
	return {
		type,
		phase: phase.id,
		file,
		fileKind,
		taskIds: ownerIds,
		edgeShare,
		patch: {
			newTask: {
				id: newId,
				phase: phase.id,
				description,
				files_touched: [file],
				depends: prereqDepends,
			},
			edits,
		},
		deltaEffectiveSpeedup: gain,
		whatIf: result,
		summary: `${verb}: ${speedupText(base, result)}.`,
	};
}

// ─── split-task ─────────────────────────────────────────────────────────────

/** Articulation points of the non-exclusive conflict graph (Tarjan). */
export function articulationPoints(graph: EpicConflictGraph): string[] {
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const points = new Set<string>();
	let counter = 0;
	const visit = (node: string, parent: string | null): void => {
		index.set(node, counter);
		low.set(node, counter);
		counter += 1;
		let children = 0;
		for (const next of graph.adjacency.get(node) ?? []) {
			if (!index.has(next)) {
				children += 1;
				visit(next, node);
				low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
				if (parent !== null && (low.get(next) ?? 0) >= (index.get(node) ?? 0)) {
					points.add(node);
				}
			} else if (next !== parent) {
				low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
			}
		}
		if (parent === null && children > 1) points.add(node);
	};
	const nodes = [...graph.adjacency.keys()].sort((a, b) => a.localeCompare(b));
	for (const node of nodes) if (!index.has(node)) visit(node, null);
	return [...points];
}

/** Clusters of t's component without t (each reached from a neighbour). */
function clustersAround(graph: EpicConflictGraph, taskId: string): string[][] {
	const seen = new Set<string>([taskId]);
	const clusters: string[][] = [];
	const neighbours = [...(graph.adjacency.get(taskId) ?? [])].sort((a, b) =>
		a.localeCompare(b),
	);
	for (const start of neighbours) {
		if (seen.has(start)) continue;
		const cluster: string[] = [];
		const queue = [start];
		seen.add(start);
		while (queue.length > 0) {
			const node = queue.shift() as string;
			cluster.push(node);
			for (const next of graph.adjacency.get(node) ?? []) {
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		clusters.push(cluster.sort((a, b) => a.localeCompare(b)));
	}
	return clusters;
}

export function splitSuggestion(
	base: ShapingBase,
	model: PhaseModel,
	taskId: string,
): EpicShapingSuggestion | null {
	const { phase } = model;
	const scopes = base.estimate.scopes;
	const own = scopes[taskId] ?? [];
	if (own.length < 2) return null;
	const clusters = clustersAround(model.graph, taskId);
	if (clusters.length < 2) return null;
	const clusterFiles = clusters.map((cluster) =>
		cluster.flatMap((id) =>
			expandEpicScope(scopes[id] ?? [], base.context.signals.coWrites),
		),
	);
	if (!base.meter.charge(own.length * clusterFiles.flat().length + 1)) {
		return null;
	}
	const parts: string[][] = clusters.map(() => []);
	const loose: string[] = [];
	for (const entry of own) {
		const file = normalizePath(entry);
		const at = clusterFiles.findIndex((files) =>
			files.some((other) => pathsConflict(file, other)),
		);
		if (at === -1) loose.push(entry);
		else parts[at].push(entry);
	}
	const nonEmpty = parts.filter((part) => part.length > 0);
	if (nonEmpty.length < 2) return null;
	nonEmpty[0].push(...loose);
	// The ids the patch assigns: part 1 keeps the task id, the others take
	// the next unused ids of the phase, in order.
	const taken = new Set(base.usedIds);
	const partIds = nonEmpty.map((_, i) =>
		i === 0 ? taskId : nextTaskId(phase.id, taken),
	);
	const task = model.tasks.find((t) => t.id === taskId);
	const ownDepends = [...(task?.depends ?? [])];
	const newTasks: EpicShapingNewTask[] = nonEmpty.slice(1).map((files, i) => ({
		id: partIds[i + 1],
		phase: phase.id,
		description: `Part ${i + 2} of task ${taskId}: its work in ${files.join(', ')} (split out so it no longer joins two conflict clusters).`,
		files_touched: files,
		depends: ownDepends,
	}));
	// Every dependent of the task must wait for every part.
	const edits: EpicShapingTaskEdit[] = [
		{ taskId, depends: ownDepends, files_touched: nonEmpty[0] },
		...(base.dependents.get(taskId) ?? []).map((dependent) => ({
			taskId: dependent,
			depends: [...(base.dependsOf.get(dependent) ?? []), ...partIds.slice(1)],
		})),
	];
	const editDepends = new Map(edits.map((edit) => [edit.taskId, edit.depends]));
	const nextScopes: Record<string, string[]> = { ...scopes };
	nonEmpty.forEach((files, i) => {
		nextScopes[partIds[i]] = files;
	});
	const phaseTasks: PartitionTask[] = [
		...withDepends(pendingTasksOf(phase), editDepends),
		...newTasks.map((part) => ({
			id: part.id,
			description: part.description,
			status: 'pending' as const,
			depends: part.depends,
			files_touched: part.files_touched,
		})),
	];
	const result = whatIf(base, phase, phaseTasks, nextScopes);
	if (!result) return null;
	const gain = gainOf(base, result);
	if (!(gain > 0)) return null;
	return {
		type: 'split-task',
		phase: phase.id,
		taskId,
		parts: nonEmpty,
		patch: { newTasks, edits },
		deltaEffectiveSpeedup: gain,
		whatIf: result,
		summary: `Split task ${taskId} (it joins ${nonEmpty.length} conflict clusters) into ${partIds.join(', ')}, one per cluster: ${nonEmpty.map((files) => `[${files.join(', ')}]`).join(' / ')}; every task depending on ${taskId} must depend on all parts — ${speedupText(base, result)}.`,
	};
}

// ─── merge-tasks ────────────────────────────────────────────────────────────

export function jaccard(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): number {
	let both = 0;
	for (const file of a) if (b.has(file)) both += 1;
	const union = a.size + b.size - both;
	return union === 0 ? 0 : both / union;
}

/**
 * Merge `absorb` into `keep`. Skipped when one reaches the other through
 * another task (the merged task would depend on itself); a direct
 * dependency between them is fine (it disappears).
 */
export function mergeSuggestion(
	base: ShapingBase,
	phase: EpicShapingPhase,
	keep: PartitionTask,
	absorb: PartitionTask,
	similarity: number,
): EpicShapingSuggestion | null {
	const keepDeps = base.dependsOf.get(keep.id) ?? [];
	const absorbDeps = base.dependsOf.get(absorb.id) ?? [];
	if (
		absorbDeps.some(
			(dep) => dep !== keep.id && dependsOnTransitively(base, dep, keep.id),
		) ||
		keepDeps.some(
			(dep) => dep !== absorb.id && dependsOnTransitively(base, dep, absorb.id),
		)
	) {
		return null;
	}
	const scopes = base.estimate.scopes;
	const files: string[] = [];
	const seen = new Set<string>();
	for (const entry of [
		...(scopes[keep.id] ?? []),
		...(scopes[absorb.id] ?? []),
	]) {
		const key = normalizePath(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		files.push(entry);
	}
	const depends = [...new Set([...keepDeps, ...absorbDeps])].filter(
		(dep) => dep !== keep.id && dep !== absorb.id,
	);
	const edits: EpicShapingTaskEdit[] = [
		{ taskId: keep.id, depends, files_touched: files },
		...(base.dependents.get(absorb.id) ?? [])
			.filter((dependent) => dependent !== keep.id)
			.map((dependent) => ({
				taskId: dependent,
				depends: [
					...new Set(
						(base.dependsOf.get(dependent) ?? []).map((dep) =>
							dep === absorb.id ? keep.id : dep,
						),
					),
				],
			})),
	];
	const nextScopes: Record<string, string[]> = { ...scopes, [keep.id]: files };
	delete nextScopes[absorb.id];
	const phaseTasks = withDepends(
		pendingTasksOf(phase).filter((task) => task.id !== absorb.id),
		new Map(edits.map((edit) => [edit.taskId, edit.depends])),
	);
	const result = whatIf(base, phase, phaseTasks, nextScopes);
	if (!result) return null;
	const gain = gainOf(base, result);
	// A merge is offered even at zero gain: the two tasks serialize anyway,
	// and one task saves a whole QA cycle.
	if (gain < 0) return null;
	return {
		type: 'merge-tasks',
		phase: phase.id,
		keep: keep.id,
		absorb: absorb.id,
		jaccard: round3(similarity),
		patch: {
			removed_task_ids: [absorb.id],
			removal_reason: `Merged into ${keep.id} (plan shaping: ${Math.round(similarity * 100)}% scope overlap).`,
			edits,
		},
		deltaEffectiveSpeedup: gain,
		whatIf: result,
		summary: `Merge task ${absorb.id} into ${keep.id} (small tasks, ${Math.round(similarity * 100)}% scope overlap — they serialize anyway; one task saves a QA cycle): save_plan without ${absorb.id} (removed_task_ids + removal_reason), ${keep.id} with the union scope, dependents re-pointed to ${keep.id} — ${speedupText(base, result)}.`,
	};
}

/** Every task of the plan: id → depends, and id → dependents. */
export function dependencyIndex(phases: readonly EpicShapingPhase[]): {
	dependsOf: Map<string, readonly string[]>;
	dependents: Map<string, string[]>;
} {
	const dependsOf = new Map<string, readonly string[]>();
	const dependents = new Map<string, string[]>();
	for (const phase of phases) {
		for (const task of phase.tasks ?? []) {
			const deps = [...(task.depends ?? [])];
			dependsOf.set(task.id, deps);
			for (const dep of deps) {
				const list = dependents.get(dep);
				if (list) list.push(task.id);
				else dependents.set(dep, [task.id]);
			}
		}
	}
	return { dependsOf, dependents };
}

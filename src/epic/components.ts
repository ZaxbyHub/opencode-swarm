/**
 * Epic v2 C5 — per-component parallelism (pure).
 *
 * The Epic wave planner. Over the pending tasks of ONE phase it builds the
 * conflict graph, splits it into connected components, gives every
 * component a mode, and picks the next wave ({@link planNextEpicWave}).
 * `epic_next_wave` (`wave-select.ts`) issues the wave it picks;
 * `/swarm epic start`'s sizing dry-run ({@link dryRunEpicPhase}) repeats
 * that same step over the tasks still pending, wave after wave, so it
 * replays exactly the waves `epic_next_wave` would issue while every live
 * scope equals the planning scope (`files_touched` until declared).
 *
 * ONE conflict predicate — `epicPairConflict(...).conflict` (path ∪
 * co-change, `cochange-conflict.ts`) — is the edge relation here (computed
 * through a pair index that is the same relation, see `cochangePartners`)
 * and the pair relation of THE wave verdict (`computeEpicWaveVerdict`
 * in `gate-policy.ts` → `computeParallelVerdict`, which the delegation gate
 * repeats at dispatch). Both are `epicPairConflict(scopeA, scopeB, pairs,
 * threshold).conflict` over the tasks' scopes:
 *   - the scopes are the same strings: a task enters a multi-task wave only
 *     with a live declared scope, and that live scope is what the wave
 *     freezes and the verdict reads;
 *   - the co-change pairs the wave freezes (`cochangePairsWithin`) are a
 *     SUBSET of the pairs used here, and `epicPairConflict` is monotone in
 *     its pairs (fewer pairs ⇒ fewer conflicts), so no edge here ⇒ no
 *     conflict in the verdict;
 *   - a task with no usable scope (the verdict's `unknown`) is exclusive
 *     here, so it never shares a wave.
 *   - learned scope expansion (Epic v2 C6, `learning.ts`) only ADDS edges:
 *     the path half runs over scope*(t) = scope(t) ∪ the files tasks
 *     declaring scope(t) were learned to co-write, a superset of the
 *     declared scope the verdict reads (path overlap is monotone in the
 *     scopes); the co-change half keeps the declared scopes (its rule is
 *     not monotone in the scope). The planner is stricter than the verdict.
 * Hence every wave of ≥ 2 tasks picked here is `all_disjoint` under the
 * verdict (`epic_next_wave` still asserts it before issuing).
 *
 * Model:
 *   - exclusive task: its scope touches a global file or a protected path
 *     (`isGlobalFile` / `isProtectedPath`, classified by the shared
 *     partition preflight), has no usable scope, or its declared scope
 *     lists a learned hot file (`learning.ts`; exact normalized path). It is its own component
 *     (mode `exclusive`) and
 *     always runs ALONE, before any other ready task;
 *   - every other task is a vertex; E = pairs that conflict (above, over
 *     the learned scope* for the path half);
 *     C = connected components of (vertices, E) (union-find);
 *   - density d_C = |E_C| / (|C| choose 2) (0 for a single task);
 *   - mode(C) = `serial-component` when d_C > `epic.mode.
 *     activation_threshold` (default 0.3): a densely coupled cluster — a hub
 *     file most of its tasks touch — runs ONE task per wave; otherwise
 *     `parallel`: its tasks share a wave whenever they have no edge (a
 *     sparse chain is one component whose non-adjacent tasks still run
 *     together).
 * A hub file therefore costs one serial cluster, never the whole phase:
 * tasks outside the cluster keep filling waves in parallel.
 *
 * Next wave (readiness via the shared partition preflight + `getReadyTasks`,
 * cycle-safe topological order):
 *   1. a ready exclusive task, alone;
 *   2. otherwise greedy over the ready tasks — oldest component first
 *      (waves since the component last had a task issued: no component
 *      starves), then topological order: add t when it has no edge to a
 *      chosen task, its component has no chosen task yet if the component
 *      is `serial-component`, and the wave is below `maxParallel`.
 */

import type { LeanTurboConfig } from '../config/schema.js';
import type { CoChangeEntry } from '../tools/co-change-analyzer.js';
import { normalizePath, pathsConflict } from '../turbo/lean/conflicts.js';
import {
	getReadyTasks,
	makeDependencySatisfactionChecker,
	type PartitionPreflight,
	type PlanTask as PartitionTask,
	runPartitionPreflight,
} from '../turbo/lean/partition-common.js';
import type { CoChangeThreshold } from './cochange-conflict.js';
import { type EpicCoWriteIndex, expandEpicScope } from './learning.js';

/** Default intra-component density threshold (`mode.activation_threshold`). */
export const DEFAULT_EPIC_DENSITY_THRESHOLD = 0.3;

/** Max task → component entries recorded per wave (wave tasks always kept). */
export const MAX_WAVE_COMPONENT_TASKS = 256;

export type EpicComponentMode = 'exclusive' | 'serial-component' | 'parallel';

export type EpicExclusiveReason =
	| 'global-file'
	| 'protected-path'
	| 'no-scope'
	| 'hot-file';

/** Co-change signal (null = disabled by config ⇒ path-only conflicts). */
export interface EpicCochangeSignal {
	pairs: CoChangeEntry[];
	threshold: CoChangeThreshold;
}

/** The components recorded with a wave (`EpicWaveRecord.components`). */
export interface EpicWaveComponents {
	/** Pending task of the phase at issue time → its component id. */
	byTask: Record<string, string>;
	/** Component id → mode. */
	modes: Record<string, EpicComponentMode>;
	/** Component id → intra-component density d_C. */
	density: Record<string, number>;
	/** Component id → why its (single) task is exclusive. */
	exclusive: Record<string, EpicExclusiveReason>;
	/** The density threshold in force. */
	threshold: number;
	/** True when `byTask` was capped at {@link MAX_WAVE_COMPONENT_TASKS}. */
	truncated: boolean;
}

/** What a past wave contributes to component ages. */
export interface EpicWaveHistoryEntry {
	taskIds: readonly string[];
	components?: Pick<EpicWaveComponents, 'byTask'>;
}

export interface EpicConflictGraphInput {
	/** Project root (scope paths are validated relative to it; no I/O). */
	directory: string;
	/** The phase's pending tasks. */
	tasks: readonly PartitionTask[];
	/** Scope per task: the live declared scope, else `files_touched`. */
	scopes: Record<string, string[]>;
	/** Lean config (risk policy of the shared preflight). */
	leanConfig: LeanTurboConfig;
	/** Learned hot files (`learning.ts`): tasks declaring them are exclusive. */
	hotFiles: readonly string[];
	/**
	 * Learned co-writes (`learning.ts`): the path half of the conflict graph
	 * runs over each task's expanded scope*. Null ⇒ no expansion.
	 */
	coWrites: EpicCoWriteIndex | null;
	cochange: EpicCochangeSignal | null;
}

export interface EpicConflictGraph {
	/** Shared preflight: classification + cycle-safe topological order. */
	preflight: PartitionPreflight;
	/** Exclusive tasks and why. */
	exclusive: Map<string, EpicExclusiveReason>;
	/** Conflict edges among the non-exclusive tasks (symmetric). */
	adjacency: Map<string, Set<string>>;
	/** Task id → position in the topological order. */
	topoIndex: Map<string, number>;
}

function exclusiveReasonOf(
	category: string,
	scope: readonly string[],
	hotFiles: readonly string[],
): EpicExclusiveReason | null {
	if (category === 'global') return 'global-file';
	if (category === 'protected') return 'protected-path';
	if (category !== 'normal' || scope.length === 0) return 'no-scope';
	if (hotFiles.length > 0) {
		// Exact (normalized) path: a hot file never makes its directory hot.
		const hot = new Set(hotFiles.map(normalizePath));
		if (scope.some((file) => hot.has(normalizePath(file)))) return 'hot-file';
	}
	return null;
}

/** The path half of `epicPairConflict` over normalized scopes. */
function pathOverlap(a: readonly string[], b: readonly string[]): boolean {
	return a.some((x) => b.some((y) => pathsConflict(x, y)));
}

/**
 * Per task, the co-change pair sides it owns EXCLUSIVELY (`<pair>:A` — its
 * scope matches the pair's `fileA` but not `fileB` — or `<pair>:B`), and
 * the partner sides that would cross-couple with it (`<pair>:B` for an
 * owned `A`, and vice versa). Exactly `epicPairConflict`'s co-change rule:
 * a threshold-passing pair couples two scopes when each exclusively owns
 * one side; a scope path matches a pair file when it equals it or ends
 * with `/<file>` (so the matched pair files of a path are the path and
 * each of its `/`-bounded suffixes). Indexing the pairs by file once makes
 * the graph O(tasks² + pairs) instead of O(tasks² × pairs).
 */
function cochangePartners(
	ids: readonly string[],
	normalized: ReadonlyMap<string, string[]>,
	cochange: EpicCochangeSignal | null,
): Map<string, { owned: Set<string>; wanted: Set<string> }> {
	const result = new Map<string, { owned: Set<string>; wanted: Set<string> }>();
	if (!cochange) return result;
	const byFile = new Map<string, Array<[number, 'A' | 'B']>>();
	const add = (file: string, entry: [number, 'A' | 'B']) => {
		const list = byFile.get(file);
		if (list) list.push(entry);
		else byFile.set(file, [entry]);
	};
	cochange.pairs.forEach((pair, index) => {
		if (
			pair.coChangeCount < cochange.threshold.minCoChanges ||
			pair.npmi < cochange.threshold.npmi
		) {
			return;
		}
		add(pair.fileA, [index, 'A']);
		add(pair.fileB, [index, 'B']);
	});
	if (byFile.size === 0) return result;
	for (const id of ids) {
		const touched = new Map<number, { A: boolean; B: boolean }>();
		for (const scopePath of normalized.get(id) ?? []) {
			const candidates = [scopePath];
			for (
				let k = scopePath.indexOf('/');
				k !== -1;
				k = scopePath.indexOf('/', k + 1)
			) {
				candidates.push(scopePath.slice(k + 1));
			}
			for (const file of candidates) {
				for (const [index, side] of byFile.get(file) ?? []) {
					const sides = touched.get(index) ?? { A: false, B: false };
					sides[side] = true;
					touched.set(index, sides);
				}
			}
		}
		const owned = new Set<string>();
		const wanted = new Set<string>();
		for (const [index, sides] of touched) {
			if (sides.A === sides.B) continue; // both or neither: internal
			const mine = sides.A ? 'A' : 'B';
			owned.add(`${index}:${mine}`);
			wanted.add(`${index}:${mine === 'A' ? 'B' : 'A'}`);
		}
		if (owned.size > 0) result.set(id, { owned, wanted });
	}
	return result;
}

function crossCoupled(
	a: { owned: Set<string>; wanted: Set<string> } | undefined,
	b: { owned: Set<string>; wanted: Set<string> } | undefined,
): boolean {
	if (!a || !b) return false;
	const [small, large] =
		a.wanted.size <= b.owned.size ? [a.wanted, b.owned] : [b.owned, a.wanted];
	for (const key of small) if (large.has(key)) return true;
	return false;
}

/** Build the conflict graph of one phase's pending tasks. */
export function buildEpicConflictGraph(
	input: EpicConflictGraphInput,
): EpicConflictGraph {
	const scopes: Record<string, string[]> = Object.create(null);
	for (const task of input.tasks) scopes[task.id] = input.scopes[task.id] ?? [];
	// Every task's scope is passed explicitly: the preflight reads nothing.
	const preflight = runPartitionPreflight(
		input.directory,
		[...input.tasks],
		input.leanConfig,
		scopes,
	);
	const exclusive = new Map<string, EpicExclusiveReason>();
	const vertices: string[] = [];
	for (const classified of preflight.taskMap.values()) {
		const id = classified.task.id;
		const reason = exclusiveReasonOf(
			classified.category,
			scopes[id] ?? [],
			input.hotFiles,
		);
		if (reason) exclusive.set(id, reason);
		else vertices.push(id);
	}
	const normalized = new Map<string, string[]>();
	const expanded = new Map<string, string[]>();
	for (const id of vertices) {
		normalized.set(id, scopes[id].map(normalizePath));
		expanded.set(id, expandEpicScope(scopes[id], input.coWrites));
	}
	const partners = cochangePartners(vertices, normalized, input.cochange);
	const adjacency = new Map<string, Set<string>>();
	for (const id of vertices) adjacency.set(id, new Set());
	for (let i = 0; i < vertices.length; i += 1) {
		for (let j = i + 1; j < vertices.length; j += 1) {
			const a = vertices[i];
			const b = vertices[j];
			if (
				pathOverlap(expanded.get(a) ?? [], expanded.get(b) ?? []) ||
				crossCoupled(partners.get(a), partners.get(b))
			) {
				adjacency.get(a)?.add(b);
				adjacency.get(b)?.add(a);
			}
		}
	}
	const topoIndex = new Map<string, number>();
	preflight.sortedTasks.forEach((classified, index) => {
		topoIndex.set(classified.task.id, index);
	});
	// Cycle members are absent from the sorted order: rank them last, by id.
	const inCycle = [...preflight.tasksInCycle].sort((a, b) =>
		a.localeCompare(b),
	);
	for (const id of inCycle) {
		if (!topoIndex.has(id)) topoIndex.set(id, topoIndex.size);
	}
	return { preflight, exclusive, adjacency, topoIndex };
}

export interface EpicComponent {
	/** Smallest member task id. */
	id: string;
	/** Member task ids, sorted. */
	members: string[];
	mode: EpicComponentMode;
	/** Conflict edges inside the component. */
	edgeCount: number;
	/** d_C = edgeCount / (|C| choose 2); 0 for a single task. */
	density: number;
	exclusiveReason?: EpicExclusiveReason;
}

export interface EpicComponentPartition {
	components: EpicComponent[];
	/** Task id → component id. */
	componentOf: Map<string, string>;
	threshold: number;
}

/**
 * Components (union-find) of `taskIds` — a subset of the graph's tasks —
 * with their modes under `densityThreshold`.
 */
export function partitionEpicComponents(
	graph: EpicConflictGraph,
	taskIds: Iterable<string>,
	densityThreshold: number,
): EpicComponentPartition {
	const members = new Set(taskIds);
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = id;
		while (parent.get(root) !== root) root = parent.get(root) ?? root;
		let node = id;
		while (node !== root) {
			const next = parent.get(node) ?? root;
			parent.set(node, root);
			node = next;
		}
		return root;
	};
	for (const id of members) {
		if (!graph.exclusive.has(id)) parent.set(id, id);
	}
	const edges: Array<[string, string]> = [];
	for (const [a, neighbours] of graph.adjacency) {
		if (!parent.has(a)) continue;
		for (const b of neighbours) {
			if (a < b && parent.has(b)) edges.push([a, b]);
		}
	}
	for (const [a, b] of edges) {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	}
	const groups = new Map<string, string[]>();
	for (const id of parent.keys()) {
		const root = find(id);
		const group = groups.get(root);
		if (group) group.push(id);
		else groups.set(root, [id]);
	}
	const edgeCount = new Map<string, number>();
	for (const [a] of edges) {
		const root = find(a);
		edgeCount.set(root, (edgeCount.get(root) ?? 0) + 1);
	}
	const components: EpicComponent[] = [];
	const componentOf = new Map<string, string>();
	for (const [root, group] of groups) {
		group.sort((a, b) => a.localeCompare(b));
		const n = group.length;
		const count = edgeCount.get(root) ?? 0;
		const density = n < 2 ? 0 : count / ((n * (n - 1)) / 2);
		const component: EpicComponent = {
			id: group[0],
			members: group,
			mode: density > densityThreshold ? 'serial-component' : 'parallel',
			edgeCount: count,
			density,
		};
		components.push(component);
		for (const id of group) componentOf.set(id, component.id);
	}
	for (const id of members) {
		const reason = graph.exclusive.get(id);
		if (!reason) continue;
		components.push({
			id,
			members: [id],
			mode: 'exclusive',
			edgeCount: 0,
			density: 0,
			exclusiveReason: reason,
		});
		componentOf.set(id, id);
	}
	components.sort((a, b) => a.id.localeCompare(b.id));
	return { components, componentOf, threshold: densityThreshold };
}

/**
 * Waves since each component last had a task issued (`history` oldest
 * first). A wave served component C when one of its issued tasks shared a
 * recorded component with a current member of C (or was a member). Never
 * served ⇒ `history.length`.
 */
export function componentAges(
	partition: EpicComponentPartition,
	history: readonly EpicWaveHistoryEntry[],
): Map<string, number> {
	const ages = new Map<string, number>();
	for (const component of partition.components) {
		let age = history.length;
		for (let index = history.length - 1; index >= 0; index -= 1) {
			const wave = history[index];
			const byTask = wave.components?.byTask ?? {};
			const served = new Set<string>();
			for (const taskId of wave.taskIds) {
				const recorded = byTask[taskId];
				if (recorded !== undefined) served.add(recorded);
			}
			const hit = component.members.some(
				(member) =>
					wave.taskIds.includes(member) ||
					(byTask[member] !== undefined && served.has(byTask[member])),
			);
			if (hit) {
				age = history.length - 1 - index;
				break;
			}
		}
		ages.set(component.id, age);
	}
	return ages;
}

export interface EpicWaveChoice {
	taskIds: string[];
	kind: 'parallel' | 'exclusive' | 'serial-component';
}

/**
 * The next wave among `readyIds` (see the module header); null when none is
 * ready.
 */
export function chooseEpicWave(
	graph: EpicConflictGraph,
	partition: EpicComponentPartition,
	readyIds: readonly string[],
	maxParallel: number,
	ages: Map<string, number>,
): EpicWaveChoice | null {
	if (readyIds.length === 0) return null;
	const componentOf = (id: string) => partition.componentOf.get(id) ?? id;
	const order = [...readyIds].sort(
		(a, b) =>
			(ages.get(componentOf(b)) ?? 0) - (ages.get(componentOf(a)) ?? 0) ||
			(graph.topoIndex.get(a) ?? 0) - (graph.topoIndex.get(b) ?? 0) ||
			a.localeCompare(b),
	);
	const exclusive = order.find((id) => graph.exclusive.has(id));
	if (exclusive !== undefined) {
		return { taskIds: [exclusive], kind: 'exclusive' };
	}
	const modes = new Map(partition.components.map((c) => [c.id, c.mode]));
	const width = Math.max(1, Math.trunc(maxParallel));
	const chosen: string[] = [];
	const usedSerial = new Set<string>();
	for (const id of order) {
		if (chosen.length >= width) break;
		const component = componentOf(id);
		const serial = modes.get(component) === 'serial-component';
		if (serial && usedSerial.has(component)) continue;
		const neighbours = graph.adjacency.get(id);
		if (chosen.some((other) => neighbours?.has(other))) continue;
		chosen.push(id);
		if (serial) usedSerial.add(component);
	}
	const kind =
		chosen.length === 1 &&
		modes.get(componentOf(chosen[0])) === 'serial-component'
			? 'serial-component'
			: 'parallel';
	return { taskIds: chosen, kind };
}

/** Ready task ids: every dependency in `done` or satisfied outside. */
export function readyEpicTasks(
	graph: EpicConflictGraph,
	done: ReadonlySet<string>,
	satisfiedOutside: (taskId: string) => boolean,
): string[] {
	const assigned = new Set(done);
	const isSatisfied = makeDependencySatisfactionChecker(
		graph.preflight.taskMap,
		assigned,
		satisfiedOutside,
	);
	return getReadyTasks(graph.preflight.sortedTasks, assigned, isSatisfied).map(
		(classified) => classified.task.id,
	);
}

/** The recorded form of a partition (wave tasks always kept when capped). */
export function toWaveComponents(
	partition: EpicComponentPartition,
	waveTaskIds: readonly string[],
): EpicWaveComponents {
	const ids = [...partition.componentOf.keys()].sort((a, b) =>
		a.localeCompare(b),
	);
	const keep = new Set(waveTaskIds);
	for (const id of ids) {
		if (keep.size >= MAX_WAVE_COMPONENT_TASKS) break;
		keep.add(id);
	}
	const byTask: Record<string, string> = {};
	for (const id of ids) {
		if (keep.has(id)) byTask[id] = partition.componentOf.get(id) ?? id;
	}
	const recorded = new Set(Object.values(byTask));
	const modes: Record<string, EpicComponentMode> = {};
	const density: Record<string, number> = {};
	const exclusive: Record<string, EpicExclusiveReason> = {};
	for (const component of partition.components) {
		if (!recorded.has(component.id)) continue;
		modes[component.id] = component.mode;
		density[component.id] = Math.round(component.density * 1000) / 1000;
		if (component.exclusiveReason) {
			exclusive[component.id] = component.exclusiveReason;
		}
	}
	return {
		byTask,
		modes,
		density,
		exclusive,
		threshold: partition.threshold,
		truncated: keep.size < ids.length,
	};
}

export interface EpicNextWaveInput extends EpicConflictGraphInput {
	maxParallel: number;
	densityThreshold: number;
	/** A dependency outside `tasks` is satisfied (completed + evidence). */
	satisfiedOutside: (taskId: string) => boolean;
	/** This phase's earlier waves, oldest first (component ages). */
	history: readonly EpicWaveHistoryEntry[];
}

/**
 * THE next-wave step over `tasks` (the phase's runnable pending tasks):
 * graph → components → ready tasks → wave. `epic_next_wave`
 * (`wave-select.ts`) issues its choice; {@link dryRunEpicPhase} repeats it.
 */
export function planNextEpicWave(input: EpicNextWaveInput): {
	partition: EpicComponentPartition;
	choice: EpicWaveChoice | null;
} {
	const graph = buildEpicConflictGraph(input);
	const partition = partitionEpicComponents(
		graph,
		input.tasks.map((task) => task.id),
		input.densityThreshold,
	);
	const choice = chooseEpicWave(
		graph,
		partition,
		readyEpicTasks(graph, new Set(), input.satisfiedOutside),
		input.maxParallel,
		componentAges(partition, input.history),
	);
	return { partition, choice };
}

export interface EpicPhaseDryRun {
	/** Waves in issue order. */
	waves: EpicWaveChoice[];
	/**
	 * Tasks never scheduled: `blocked` tasks, a dependency cycle, tasks
	 * downstream of either — and, when the run stopped at its work budget,
	 * every task still pending (each then counts as one serial step: a
	 * pessimistic L).
	 */
	unscheduled: string[];
	/** Work units spent ({@link epicWaveWork} summed over the waves). */
	work: number;
	/** True when `maxWork` stopped the run before every task was planned. */
	aborted: boolean;
}

/** Work units per scope path per wave (the shared preflight resolves each). */
export const EPIC_WORK_PER_SCOPE_PATH = 8;
/** Work units per task pair per wave (graph + component bookkeeping). */
export const EPIC_WORK_PER_TASK_PAIR = 6;

/**
 * Deterministic cost estimate (work units ≈ path comparisons) of ONE
 * planning step over `remaining` tasks with these scope sizes, `history`
 * waves old: per-path preflight + per-pair graph work + the pairwise path
 * comparisons (Σ_{i<j} |a_i|·|a_j|) + component aging. Callers that must
 * stay bounded (start sizing, plan shaping) spend a budget of these.
 */
export function epicWaveWork(
	scopeSizes: readonly number[],
	history: number,
): number {
	let sum = 0;
	let squares = 0;
	for (const size of scopeSizes) {
		const n = Math.max(1, size);
		sum += n;
		squares += n * n;
	}
	const r = scopeSizes.length;
	return (
		EPIC_WORK_PER_SCOPE_PATH * sum +
		(EPIC_WORK_PER_TASK_PAIR * r * (r - 1)) / 2 +
		(sum * sum - squares) / 2 +
		r * history
	);
}

/**
 * Replay `epic_next_wave` over one phase as if every issued wave completed
 * (the `/swarm epic start` sizing dry-run): each step is
 * {@link planNextEpicWave} over the tasks still pending — the graph and
 * components rebuilt, the recorded components aging them — exactly the
 * sequence `epic_next_wave` issues when every live scope equals the
 * planning scope. `blocked` tasks never run (as in `epic_next_wave`), so
 * they and their dependents are unscheduled. Dependencies outside the
 * phase count as satisfied (phases run in order).
 *
 * `maxWork` bounds the run: before each step its {@link epicWaveWork} is
 * charged; a step that would exceed the budget is not run (`aborted`, the
 * rest unscheduled). Without it the run is unbounded (and identical).
 */
export function dryRunEpicPhase(
	input: EpicConflictGraphInput & {
		maxParallel: number;
		densityThreshold: number;
		maxWork?: number;
	},
): EpicPhaseDryRun {
	const blocked = new Set(
		input.tasks.filter((task) => task.status === 'blocked').map((t) => t.id),
	);
	let remaining = input.tasks.filter((task) => !blocked.has(task.id));
	const history: EpicWaveHistoryEntry[] = [];
	const waves: EpicWaveChoice[] = [];
	const sizeOf = (id: string) => (input.scopes[id] ?? []).length;
	let work = 0;
	let aborted = false;
	while (remaining.length > 0) {
		const cost = epicWaveWork(
			remaining.map((task) => sizeOf(task.id)),
			history.length,
		);
		if (input.maxWork !== undefined && work + cost > input.maxWork) {
			aborted = true;
			break;
		}
		work += cost;
		const { partition, choice } = planNextEpicWave({
			...input,
			tasks: remaining,
			satisfiedOutside: (dep) => !blocked.has(dep),
			history,
		});
		if (!choice) break;
		waves.push(choice);
		history.push({
			taskIds: choice.taskIds,
			components: toWaveComponents(partition, choice.taskIds),
		});
		const issued = new Set(choice.taskIds);
		remaining = remaining.filter((task) => !issued.has(task.id));
	}
	return {
		waves,
		unscheduled: [...blocked, ...remaining.map((task) => task.id)].sort(
			(a, b) => a.localeCompare(b),
		),
		work,
		aborted,
	};
}

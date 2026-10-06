/**
 * Epic PLANNER REGRESSION HARNESS — deterministic simulator (Epic v2 C8).
 *
 * NOT a real-speed benchmark (critic M12). It replays small fixture plans
 * through the REAL pure planners and charges a fixed, simple cost model, so
 * a change to a planner that makes its schedules longer or more conflict
 * prone shows up as a metric regression against the golden file. It says
 * nothing about how fast a real epic runs: real tasks have LLM latency,
 * serialized QA, retries and humans in the loop, none of which is modelled.
 *
 * Strategies (one fixture = one plan, run `epochs` times in a row):
 *   - Balanced: the standard serial flow — one task at a time, in
 *     dependency order (never concurrent, so never conflicting).
 *   - Lean: the real Lean Turbo lane planner (`planLeanTurboLanes`,
 *     src/turbo/lean/planner.ts — imported, never modified) on the DECLARED
 *     scopes, per phase, executed as the Lean runner does: ONE coder per
 *     lane working through the lane's tasks in order, lanes concurrently,
 *     then the serialized / degraded tasks one at a time. (Observed: the
 *     planner's first-fit packs every non-conflicting task into the first
 *     lane and serializes the rest, so it never yields two lanes — Lean then
 *     runs one coder at a time: no conflicts, a serial makespan.)
 *   - Epic: the real Epic component planner (`planNextEpicWave`,
 *     src/epic/components.ts) wave after wave, per phase, with the
 *     real learning model (`learning.ts`): every wave's outcomes update the
 *     epic's posterior (used by its next wave) and every epoch merges into
 *     the prior the next epoch inherits — `decay_per_epic` applied when the
 *     epoch learned something, as `/swarm epic close` does (no wall-clock
 *     decay: the epochs are back to back). Co-change pairs of a fixture
 *     feed the real co-change rule.
 *
 * Cost model. Durations are the fixture's (or seeded: 2..8 units, mulberry32
 * over `seed`, in task order). Two tasks CONFLICT when they run
 * concurrently (overlapping [start, end)) and their TRUE write sets (the
 * fixture's `actual`, which may exceed the declared scope) overlap — path
 * segment aware, as the planners compare paths. Each conflicting pair
 * charges REWORK to the task that lands second (later end; ties → larger
 * id): it runs again, in full, after its phase's (Lean) or wave's (Epic)
 * concurrent work, one rework at a time. In Epic the reworked task's
 * outcome carries a merge failure and generation 2 — exactly what the real
 * wave close records — so learning sees it.
 *
 * Lives under scripts/ (outside the plugin bundle): the plugin never imports
 * it; the regression test (tests/unit/epic/epic-bench.test.ts) and
 * `bun scripts/epic-bench.ts` do.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import type { LeanTurboConfig } from '../../src/config/schema';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../src/config/constants';
import type { CoChangeEntry } from '../../src/tools/co-change-analyzer';
import {
	DEFAULT_EPIC_DENSITY_THRESHOLD,
	type EpicCochangeSignal,
	type EpicWaveHistoryEntry,
	planNextEpicWave,
	toWaveComponents,
} from '../../src/epic/components';
import {
	boundEpicLearning,
	DEFAULT_EPIC_LEARNING_SETTINGS,
	type EpicLearningStats,
	emptyEpicLearning,
	epicHotFiles,
	epicLearningFromOutcomes,
	isEpicLearningEmpty,
	mergeEpicLearning,
	scaleEpicLearning,
	undeclaredFiles,
} from '../../src/epic/learning';
import type { EpicTaskOutcome } from '../../src/epic/lifecycle';
import { normalizePath, pathsConflict } from '../../src/turbo/lean/conflicts';
import type { PlanTask } from '../../src/turbo/lean/partition-common';
import { planLeanTurboLanes } from '../../src/turbo/lean/planner';

/** A virtual project root: the planners validate paths against it, no I/O. */
const VIRTUAL_ROOT = path.join(os.tmpdir(), 'epic-bench-virtual-project');

export interface EpicBenchTask {
	id: string;
	phase: number;
	depends?: string[];
	/** The declared scope the planners see. */
	declared: string[];
	/** What the task really writes (conflicts are judged on this). */
	actual: string[];
	/** Work units; absent ⇒ seeded 2..8. */
	duration?: number;
}

export interface EpicBenchFixture {
	name: string;
	description: string;
	seed: number;
	maxParallel: number;
	/** Back-to-back runs of the plan (learning carries over). */
	epochs: number;
	/** Co-change or learned co-writes are what this fixture is about. */
	learningMatters: boolean;
	cochange?: {
		npmi: number;
		minCoChanges: number;
		pairs: Array<{
			fileA: string;
			fileB: string;
			npmi: number;
			coChangeCount: number;
		}>;
	};
	tasks: EpicBenchTask[];
}

export interface EpicBenchEpoch {
	makespan: number;
	conflicts: number;
	reworkTime: number;
	/** Epic only: waves issued. */
	waves?: number;
}

export interface EpicBenchStrategy {
	epochs: EpicBenchEpoch[];
	totals: { makespan: number; conflicts: number; reworkTime: number };
}

export interface EpicBenchResult {
	fixture: string;
	balanced: EpicBenchStrategy;
	lean: EpicBenchStrategy;
	epic: EpicBenchStrategy;
}

/** mulberry32: a tiny deterministic PRNG over a 32-bit seed. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === 'string');

/** Validate a parsed fixture (throws with the offending field). */
export function parseEpicBenchFixture(raw: unknown): EpicBenchFixture {
	const fail = (what: string): never => {
		throw new Error(`invalid epic-bench fixture: ${what}`);
	};
	if (typeof raw !== 'object' || raw === null) return fail('not an object');
	const f = raw as Record<string, unknown>;
	if (typeof f.name !== 'string' || f.name.length === 0) fail('name');
	if (typeof f.description !== 'string') fail('description');
	for (const key of ['seed', 'maxParallel', 'epochs'] as const) {
		if (!Number.isInteger(f[key]) || (f[key] as number) < 1) fail(key);
	}
	if (typeof f.learningMatters !== 'boolean') fail('learningMatters');
	if (!Array.isArray(f.tasks) || f.tasks.length === 0) fail('tasks');
	const ids = new Set<string>();
	for (const t of f.tasks as Array<Record<string, unknown>>) {
		if (typeof t.id !== 'string' || ids.has(t.id)) fail(`task id ${t.id}`);
		ids.add(t.id as string);
		if (!Number.isInteger(t.phase) || (t.phase as number) < 1) {
			fail(`task ${t.id} phase`);
		}
		if (!isStringArray(t.declared) || t.declared.length === 0) {
			fail(`task ${t.id} declared`);
		}
		if (!isStringArray(t.actual)) fail(`task ${t.id} actual`);
		if (t.depends !== undefined && !isStringArray(t.depends)) {
			fail(`task ${t.id} depends`);
		}
		if (
			t.duration !== undefined &&
			(!Number.isInteger(t.duration) || (t.duration as number) < 1)
		) {
			fail(`task ${t.id} duration`);
		}
	}
	for (const t of f.tasks as EpicBenchTask[]) {
		for (const dep of t.depends ?? []) {
			if (!ids.has(dep)) fail(`task ${t.id} depends on unknown ${dep}`);
		}
	}
	return raw as EpicBenchFixture;
}

interface SimTask extends EpicBenchTask {
	duration: number;
	actualNorm: string[];
}

function withDurations(fixture: EpicBenchFixture): SimTask[] {
	const random = mulberry32(fixture.seed);
	return fixture.tasks.map((task) => {
		const seeded = 2 + Math.floor(random() * 7);
		return {
			...task,
			duration: task.duration ?? seeded,
			actualNorm: task.actual.map(normalizePath),
		};
	});
}

function phasesOf(tasks: readonly SimTask[]): number[] {
	return [...new Set(tasks.map((t) => t.phase))].sort((a, b) => a - b);
}

function writesOverlap(a: SimTask, b: SimTask): boolean {
	return a.actualNorm.some((x) => b.actualNorm.some((y) => pathsConflict(x, y)));
}

interface Interval {
	task: SimTask;
	start: number;
	end: number;
}

/**
 * Conflicting pairs among `intervals` (concurrent + overlapping true
 * writes) and the tasks that must rework (the one landing second).
 */
function chargeConflicts(intervals: readonly Interval[]): {
	pairs: number;
	reworked: SimTask[];
} {
	let pairs = 0;
	const losers = new Map<string, SimTask>();
	for (let i = 0; i < intervals.length; i += 1) {
		for (let j = i + 1; j < intervals.length; j += 1) {
			const a = intervals[i];
			const b = intervals[j];
			const concurrent = a.start < b.end && b.start < a.end;
			if (!concurrent || !writesOverlap(a.task, b.task)) continue;
			pairs += 1;
			const loser =
				a.end > b.end || (a.end === b.end && a.task.id > b.task.id) ? a : b;
			losers.set(loser.task.id, loser.task);
		}
	}
	const reworked = [...losers.values()].sort((x, y) =>
		x.id.localeCompare(y.id),
	);
	return { pairs, reworked };
}

/** Dependency order within `tasks` (deps outside count as satisfied). */
function topoOrder(tasks: readonly SimTask[]): SimTask[] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const done = new Set<string>();
	const order: SimTask[] = [];
	const remaining = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
	while (remaining.length > 0) {
		const index = remaining.findIndex((t) =>
			(t.depends ?? []).every((d) => done.has(d) || !byId.has(d)),
		);
		if (index === -1) throw new Error('epic-bench: dependency cycle');
		const [next] = remaining.splice(index, 1);
		done.add(next.id);
		order.push(next);
	}
	return order;
}

function totals(epochs: EpicBenchEpoch[]): EpicBenchStrategy['totals'] {
	return {
		makespan: epochs.reduce((s, e) => s + e.makespan, 0),
		conflicts: epochs.reduce((s, e) => s + e.conflicts, 0),
		reworkTime: epochs.reduce((s, e) => s + e.reworkTime, 0),
	};
}

function simulateBalanced(tasks: readonly SimTask[]): EpicBenchEpoch {
	let makespan = 0;
	for (const phase of phasesOf(tasks)) {
		for (const task of topoOrder(tasks.filter((t) => t.phase === phase))) {
			makespan += task.duration;
		}
	}
	return { makespan, conflicts: 0, reworkTime: 0 };
}

function asPlanTask(task: SimTask): PlanTask {
	return {
		id: task.id,
		description: `task ${task.id}`,
		status: 'pending',
		depends: task.depends ?? [],
		files_touched: task.declared,
	};
}

function leanConfig(maxParallel: number): LeanTurboConfig {
	return { ...DEFAULT_LEAN_TURBO_CONFIG, max_parallel_coders: maxParallel };
}

function simulateLean(
	tasks: readonly SimTask[],
	maxParallel: number,
): EpicBenchEpoch {
	const config = leanConfig(maxParallel);
	let clock = 0;
	let conflicts = 0;
	let reworkTime = 0;
	for (const phase of phasesOf(tasks)) {
		const phaseTasks = tasks.filter((t) => t.phase === phase);
		const byId = new Map(phaseTasks.map((t) => [t.id, t]));
		const plan = planLeanTurboLanes(
			VIRTUAL_ROOT,
			phase,
			{
				phases: [
					{ id: phase, name: `Phase ${phase}`, tasks: phaseTasks.map(asPlanTask) },
				],
			},
			config,
			Object.fromEntries(phaseTasks.map((t) => [t.id, t.declared])),
		);
		const intervals: Interval[] = [];
		let parallelEnd = clock;
		for (const lane of plan.lanes) {
			let t = clock;
			for (const id of lane.taskIds) {
				const task = byId.get(id);
				if (!task) throw new Error(`epic-bench: Lean lane task ${id}`);
				intervals.push({ task, start: t, end: t + task.duration });
				t += task.duration;
			}
			parallelEnd = Math.max(parallelEnd, t);
		}
		const serialIds = [
			...plan.serializedTasks,
			...plan.degradedTasks.map((d) => d.taskId),
		];
		const scheduled = new Set([
			...plan.lanes.flatMap((l) => l.taskIds),
			...serialIds,
		]);
		if (scheduled.size !== phaseTasks.length) {
			throw new Error(
				`epic-bench: Lean scheduled ${scheduled.size}/${phaseTasks.length} task(s) of phase ${phase}`,
			);
		}
		const charged = chargeConflicts(intervals);
		conflicts += charged.pairs;
		let t = parallelEnd;
		for (const task of topoOrder(serialIds.map((id) => byId.get(id) as SimTask))) {
			t += task.duration;
		}
		for (const task of charged.reworked) {
			t += task.duration;
			reworkTime += task.duration;
		}
		clock = t;
	}
	return { makespan: clock, conflicts, reworkTime };
}

function cochangeSignal(fixture: EpicBenchFixture): EpicCochangeSignal | null {
	if (!fixture.cochange) return null;
	return {
		threshold: {
			npmi: fixture.cochange.npmi,
			minCoChanges: fixture.cochange.minCoChanges,
		},
		pairs: fixture.cochange.pairs.map(
			(pair): CoChangeEntry => ({
				fileA: normalizePath(pair.fileA),
				fileB: normalizePath(pair.fileB),
				npmi: pair.npmi,
				coChangeCount: pair.coChangeCount,
				lift: 1,
				hasStaticEdge: false,
				totalCommits: pair.coChangeCount,
				commitsA: pair.coChangeCount,
				commitsB: pair.coChangeCount,
			}),
		),
	};
}

/** Counterfactual switches (the regression test proves each signal matters). */
export interface EpicBenchOptions {
	/** false ⇒ Epic plans without learned signals (default true). */
	learning?: boolean;
	/** false ⇒ Epic ignores the fixture's co-change pairs (default true). */
	cochange?: boolean;
	/** false ⇒ learned hot files are ignored (co-writes still expand). */
	hot?: boolean;
	/**
	 * false ⇒ no `serial-component` demotion (density threshold 1: only
	 * direct conflicts keep tasks apart).
	 */
	densityDemotion?: boolean;
}

/** One epoch of Epic over `prior`; returns the metrics and the new prior. */
function simulateEpicEpoch(
	fixture: EpicBenchFixture,
	tasks: readonly SimTask[],
	prior: EpicLearningStats,
	options: EpicBenchOptions,
): { epoch: EpicBenchEpoch; prior: EpicLearningStats } {
	const settings = DEFAULT_EPIC_LEARNING_SETTINGS;
	const learning = options.learning !== false;
	const config = leanConfig(fixture.maxParallel);
	const cochange = options.cochange === false ? null : cochangeSignal(fixture);
	let increments = emptyEpicLearning();
	let clock = 0;
	let conflicts = 0;
	let reworkTime = 0;
	let waveSeq = 0;
	for (const phase of phasesOf(tasks)) {
		let remaining = tasks.filter((t) => t.phase === phase);
		const history: EpicWaveHistoryEntry[] = [];
		while (remaining.length > 0) {
			const view = learning
				? boundEpicLearning(mergeEpicLearning(prior, increments))
				: emptyEpicLearning();
			const { partition, choice } = planNextEpicWave({
				directory: VIRTUAL_ROOT,
				tasks: remaining.map(asPlanTask),
				scopes: Object.fromEntries(remaining.map((t) => [t.id, t.declared])),
				leanConfig: config,
				hotFiles:
					options.hot === false ? [] : epicHotFiles(view, settings.hotExcess),
				coWrites: view.edges,
				cochange,
				maxParallel: fixture.maxParallel,
				densityThreshold:
					options.densityDemotion === false ? 1 : DEFAULT_EPIC_DENSITY_THRESHOLD,
				satisfiedOutside: () => true,
				history,
			});
			if (!choice || choice.taskIds.length === 0) {
				throw new Error(`epic-bench: Epic issued no wave in phase ${phase}`);
			}
			waveSeq += 1;
			const wave = choice.taskIds.map((id) => {
				const task = remaining.find((t) => t.id === id);
				if (!task) throw new Error(`epic-bench: Epic wave task ${id}`);
				return { task, start: clock, end: clock + task.duration };
			});
			const charged = chargeConflicts(wave);
			conflicts += charged.pairs;
			let end = Math.max(...wave.map((w) => w.end));
			for (const task of charged.reworked) {
				end += task.duration;
				reworkTime += task.duration;
			}
			const reworked = new Set(charged.reworked.map((t) => t.id));
			const outcomes: EpicTaskOutcome[] = wave.map(({ task }) => ({
				taskId: task.id,
				phase,
				waveSeq,
				resolution: 'completed',
				resolvedAt: '2026-01-01T00:00:00.000Z',
				generation: reworked.has(task.id) ? 2 : 1,
				stageAFailures: 0,
				stageBFailures: 0,
				mergeFailure: reworked.has(task.id)
					? { outcome: 'conflict', stage: 'merge' }
					: null,
				declared: task.declared,
				undeclared: undeclaredFiles(task.declared, task.actual),
				attribution: 'session',
				reopened: 0,
				marker: null,
			}));
			increments = mergeEpicLearning(
				increments,
				epicLearningFromOutcomes(outcomes, { isDirectory: () => false }),
			);
			history.push({
				taskIds: choice.taskIds,
				components: toWaveComponents(partition, choice.taskIds),
			});
			const issued = new Set(choice.taskIds);
			remaining = remaining.filter((t) => !issued.has(t.id));
			clock = end;
		}
	}
	const nextPrior = isEpicLearningEmpty(increments)
		? prior
		: boundEpicLearning(
				mergeEpicLearning(
					scaleEpicLearning(prior, settings.decayPerEpic),
					increments,
				),
			);
	return {
		epoch: { makespan: clock, conflicts, reworkTime, waves: waveSeq },
		prior: nextPrior,
	};
}

/** Run one fixture through the three strategies. Deterministic. */
export function simulateEpicBenchFixture(
	fixture: EpicBenchFixture,
	options: EpicBenchOptions = {},
): EpicBenchResult {
	const tasks = withDurations(fixture);
	const balanced: EpicBenchEpoch[] = [];
	const lean: EpicBenchEpoch[] = [];
	const epic: EpicBenchEpoch[] = [];
	let prior = emptyEpicLearning();
	for (let e = 0; e < fixture.epochs; e += 1) {
		balanced.push(simulateBalanced(tasks));
		lean.push(simulateLean(tasks, fixture.maxParallel));
		const run = simulateEpicEpoch(fixture, tasks, prior, options);
		epic.push(run.epoch);
		prior = run.prior;
	}
	return {
		fixture: fixture.name,
		balanced: { epochs: balanced, totals: totals(balanced) },
		lean: { epochs: lean, totals: totals(lean) },
		epic: { epochs: epic, totals: totals(epic) },
	};
}

/** The golden metrics of one result (what regressions are judged on). */
export type EpicBenchGolden = Record<
	string,
	Record<'balanced' | 'lean' | 'epic', EpicBenchStrategy['totals']>
>;

export function goldenOf(results: readonly EpicBenchResult[]): EpicBenchGolden {
	const golden: EpicBenchGolden = {};
	for (const r of results) {
		golden[r.fixture] = {
			balanced: r.balanced.totals,
			lean: r.lean.totals,
			epic: r.epic.totals,
		};
	}
	return golden;
}

/** A plain-text table (one row per fixture × strategy). */
export function formatEpicBenchTable(results: readonly EpicBenchResult[]): string {
	const rows = [
		['fixture', 'strategy', 'makespan', 'conflicts', 'rework', 'per-epoch conflicts'],
	];
	for (const r of results) {
		for (const name of ['balanced', 'lean', 'epic'] as const) {
			const s = r[name];
			rows.push([
				r.fixture,
				name,
				String(s.totals.makespan),
				String(s.totals.conflicts),
				String(s.totals.reworkTime),
				s.epochs.map((e) => e.conflicts).join(' → '),
			]);
		}
	}
	const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
	return rows
		.map((row) => row.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd())
		.join('\n');
}

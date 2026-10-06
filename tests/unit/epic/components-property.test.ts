/**
 * Epic v2 C5 — seeded property test of the component planner through
 * `selectNextEpicWave`, driven wave by wave to the end of random phases
 * (random scopes over a small file pool, global / protected files, random
 * DAG dependencies, co-change pairs, learned hot files and learned
 * co-writes (Epic v2 C6 scope expansion), widths and density thresholds).
 * Every issued wave must be:
 *   - pairwise conflict-free under THE predicate (`epicPairConflict`, path
 *     ∪ co-change with the full pair set),
 *   - at most `maxParallel` tasks (an exclusive wave is one task),
 *   - dependency-respecting (every dependency completed earlier),
 *   - at most one task per `serial-component` component,
 *   - and `all_disjoint` under THE wave verdict (`computeEpicWaveVerdict`,
 *     the call the delegation gate repeats at dispatch) over the frozen
 *     DECLARED scopes and frozen co-change pairs — the C4 parity invariant,
 *     which learned expansion must never break (it only adds planner edges);
 *   - and conflict-free over the EXPANDED scopes too (the learned co-write
 *     edges are honoured).
 * Every task is eventually issued (no starvation, no lost task).
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../src/config/constants';
import { epicPairConflict } from '../../../src/epic/cochange-conflict';
import {
	dryRunEpicPhase,
	type EpicCochangeSignal,
	type EpicWaveHistoryEntry,
} from '../../../src/epic/components';
import { computeEpicWaveVerdict } from '../../../src/epic/gate-policy';
import {
	type EpicCoWriteIndex,
	expandEpicScope,
} from '../../../src/epic/learning';
import { selectNextEpicWave } from '../../../src/epic/wave-select';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';
import { pathsConflict } from '../../../src/turbo/lean/conflicts';
import { phasePlan, type TaskSpec } from './next-wave-fixture';

/** Deterministic LCG (Numerical Recipes constants). */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const POOL = [
	'src/a.ts',
	'src/b.ts',
	'src/c.ts',
	'src/d.ts',
	'src/e.ts',
	'src/f.ts',
	'src/g.ts',
	'src/lib',
	'src/lib/h.ts',
	'src/lib/i.ts',
	'src/hub.ts',
];

interface Scenario {
	specs: TaskSpec[];
	maxParallel: number;
	threshold: number;
	cochange: EpicCochangeSignal | null;
	hotFiles: string[];
	coWrites: EpicCoWriteIndex | null;
}

function scenario(seed: number): Scenario {
	const r = rng(seed);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(r() * items.length)];
	const n = 3 + Math.floor(r() * 12);
	const specs: TaskSpec[] = [];
	for (let i = 0; i < n; i += 1) {
		const files = new Set<string>();
		const count = 1 + Math.floor(r() * 3);
		for (let k = 0; k < count; k += 1) files.add(pick(POOL));
		if (r() < 0.25) files.add('src/hub.ts');
		if (r() < 0.05) files.add('package.json');
		if (r() < 0.05) files.add('src/auth/session.ts');
		const depends: string[] = [];
		for (let j = 0; j < i; j += 1) {
			if (r() < 0.12) depends.push(`1.${j + 1}`);
		}
		specs.push({ id: `1.${i + 1}`, files: [...files], depends });
	}
	const pairs: CoChangeEntry[] = [];
	if (r() < 0.5) {
		for (let k = 0; k < 4; k += 1) {
			pairs.push({
				fileA: pick(POOL),
				fileB: pick(POOL),
				npmi: r(),
				coChangeCount: 1 + Math.floor(r() * 9),
				lift: 0,
				hasStaticEdge: false,
				totalCommits: 0,
				commitsA: 0,
				commitsB: 0,
			});
		}
	}
	return {
		specs,
		maxParallel: 1 + Math.floor(r() * 6),
		threshold: pick([0, 0.3, 0.6, 1]),
		cochange:
			pairs.length > 0
				? { pairs, threshold: { npmi: 0.5, minCoChanges: 3 } }
				: null,
		hotFiles: r() < 0.2 ? [pick(POOL)] : [],
		coWrites: r() < 0.6 ? randomCoWrites(r, pick) : null,
	};
}

/** Random learned co-writes; weights straddle the expansion threshold 1. */
function randomCoWrites(
	r: () => number,
	pick: <T>(items: readonly T[]) => T,
): EpicCoWriteIndex {
	const index = new Map<string, Map<string, number>>();
	const count = 1 + Math.floor(r() * 6);
	for (let k = 0; k < count; k += 1) {
		const from = pick(POOL);
		const to = pick(POOL);
		if (from === to) continue;
		const targets = index.get(from) ?? new Map<string, number>();
		targets.set(to, pick([0.4, 0.6, 1, 2]));
		index.set(from, targets);
	}
	return index;
}

/** The issued wave sequence of `epic_next_wave` driven to the phase end. */
function runScenario(seed: number): string[][] {
	const s = scenario(seed);
	const plan = phasePlan([s.specs], `Property ${seed}`);
	const tasks = plan.phases[0].tasks;
	const liveScopes: Record<string, string[]> = {};
	for (const task of tasks) liveScopes[task.id] = [...task.files_touched];
	const history: EpicWaveHistoryEntry[] = [];
	const completed = new Set<string>();
	const waves: string[][] = [];
	for (let guard = 0; guard <= tasks.length; guard += 1) {
		const selection = selectNextEpicWave({
			directory: '/project',
			plan,
			phaseId: 1,
			liveScopes,
			maxParallel: s.maxParallel,
			leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG },
			isCommitted: () => true,
			hotFiles: s.hotFiles,
			coWrites: s.coWrites,
			cochange: s.cochange,
			densityThreshold: s.threshold,
			waveHistory: history,
		});
		if (selection.kind === 'none') break;
		if (selection.kind !== 'wave') {
			throw new Error(`seed ${seed}: unexpected ${selection.kind}`);
		}
		const ids = selection.taskIds;
		waves.push([...ids]);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.length).toBeLessThanOrEqual(s.maxParallel);
		if (selection.waveKind === 'exclusive') expect(ids).toHaveLength(1);
		for (const id of ids) {
			const task = tasks.find((t) => t.id === id);
			for (const dep of task?.depends ?? []) {
				expect(completed.has(dep)).toBe(true);
			}
		}
		const serialUsed = new Set<string>();
		for (const id of ids) {
			const component = selection.components.byTask[id];
			if (selection.components.modes[component] === 'serial-component') {
				expect(serialUsed.has(component)).toBe(false);
				serialUsed.add(component);
			}
		}
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				expect(
					epicPairConflict(
						selection.files[ids[i]],
						selection.files[ids[j]],
						s.cochange?.pairs ?? [],
						s.cochange?.threshold ?? { npmi: 1, minCoChanges: 1 },
					).conflict,
				).toBe(false);
				// The learned co-writes are honoured: no path overlap between
				// the expanded scopes of two tasks of one wave.
				const a = expandEpicScope(selection.files[ids[i]], s.coWrites);
				const b = expandEpicScope(selection.files[ids[j]], s.coWrites);
				expect(a.some((x) => b.some((y) => pathsConflict(x, y)))).toBe(false);
			}
		}
		if (ids.length >= 2) {
			const verdict = computeEpicWaveVerdict(
				'/project',
				plan,
				{
					files: selection.files,
					cochange: s.cochange
						? {
								pairs: selection.cochangePairs,
								threshold: s.cochange.threshold,
							}
						: null,
				},
				ids,
			);
			expect(verdict.verdict).toBe('all_disjoint');
		}
		history.push({ taskIds: ids, components: selection.components });
		for (const id of ids) {
			completed.add(id);
			const task = tasks.find((t) => t.id === id);
			if (task) task.status = 'completed';
		}
	}
	expect(completed.size).toBe(tasks.length);
	return waves;
}

describe('component planner — seeded properties', () => {
	test('200 random phases: every wave edge-free, capped, ordered, verdict-parity', () => {
		let totalWaves = 0;
		let totalTasks = 0;
		for (let seed = 1; seed <= 200; seed += 1) {
			totalWaves += runScenario(seed).length;
			totalTasks += scenario(seed).specs.length;
		}
		// The planner actually parallelizes across the corpus.
		expect(totalWaves).toBeLessThan(totalTasks);
	});
});

describe('sizing dry-run replays epic_next_wave', () => {
	test('600 random phases: dryRunEpicPhase waves == the issued sequence', () => {
		for (let seed = 1001; seed <= 1600; seed += 1) {
			const s = scenario(seed);
			const plan = phasePlan([s.specs], `Dry ${seed}`);
			const dry = dryRunEpicPhase({
				directory: '/project',
				tasks: plan.phases[0].tasks.map((task) => ({
					id: task.id,
					description: task.description,
					status: 'pending' as const,
					depends: [...(task.depends ?? [])],
				})),
				scopes: Object.fromEntries(
					plan.phases[0].tasks.map((t) => [t.id, [...t.files_touched]]),
				),
				leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG },
				hotFiles: s.hotFiles,
				coWrites: s.coWrites,
				cochange: s.cochange,
				maxParallel: s.maxParallel,
				densityThreshold: s.threshold,
			});
			expect({ seed, waves: dry.waves.map((w) => w.taskIds) }).toEqual({
				seed,
				waves: runScenario(seed),
			});
			expect(dry.unscheduled).toEqual([]);
		}
	});
});

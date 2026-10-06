/**
 * Epic v2 C5 — the component planner (`components.ts`): conflict graph,
 * union-find components, density → mode, exclusive tasks, readiness, the
 * greedy next wave, starvation-free component ages, and the sizing dry-run.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../src/config/constants';
import {
	buildEpicConflictGraph,
	chooseEpicWave,
	componentAges,
	dryRunEpicPhase,
	type EpicCochangeSignal,
	type EpicConflictGraphInput,
	epicWaveWork,
	partitionEpicComponents,
	readyEpicTasks,
	toWaveComponents,
} from '../../../src/epic/components';

interface Spec {
	id: string;
	files?: string[];
	depends?: string[];
}

function graphInput(
	specs: Spec[],
	overrides: Partial<EpicConflictGraphInput> = {},
): EpicConflictGraphInput {
	const scopes: Record<string, string[]> = {};
	for (const spec of specs) {
		scopes[spec.id] = spec.files ?? [`src/t${spec.id.replace('.', '_')}.ts`];
	}
	return {
		directory: '/project',
		tasks: specs.map((spec) => ({
			id: spec.id,
			description: spec.id,
			status: 'pending' as const,
			depends: spec.depends ?? [],
		})),
		scopes,
		leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG },
		hotFiles: [],
		coWrites: null,
		cochange: null,
		...overrides,
	};
}

function plan(specs: Spec[], threshold = 0.3, overrides = {}) {
	const graph = buildEpicConflictGraph(graphInput(specs, overrides));
	const partition = partitionEpicComponents(
		graph,
		specs.map((s) => s.id),
		threshold,
	);
	return { graph, partition };
}

function nextWave(
	specs: Spec[],
	maxParallel = 4,
	threshold = 0.3,
	overrides = {},
) {
	const { graph, partition } = plan(specs, threshold, overrides);
	return chooseEpicWave(
		graph,
		partition,
		readyEpicTasks(graph, new Set(), () => true),
		maxParallel,
		componentAges(partition, []),
	);
}

/** A chain 1.1—1.2—…—1.n: consecutive tasks share one file. */
function chain(n: number): Spec[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `1.${i + 1}`,
		files: [`src/link${i}.ts`, `src/link${i + 1}.ts`],
	}));
}

/** Is there a conflict edge between two tasks with these scopes? */
function edge(
	a: string[],
	b: string[],
	cochange: EpicCochangeSignal | null,
): boolean {
	const graph = buildEpicConflictGraph(
		graphInput(
			[
				{ id: '1.1', files: a },
				{ id: '1.2', files: b },
			],
			{ cochange },
		),
	);
	return graph.adjacency.get('1.1')?.has('1.2') ?? false;
}

describe('conflict edges — the epicPairConflict relation', () => {
	test('path overlap (same file or parent/child), no overlap', () => {
		expect(edge(['src/a.ts'], ['src/a.ts'], null)).toBe(true);
		expect(edge(['src'], ['src/a.ts'], null)).toBe(true);
		expect(edge(['src/a.ts'], ['src/b.ts'], null)).toBe(false);
	});

	test('a threshold-passing co-change pair across the scopes is a conflict', () => {
		const cochange: EpicCochangeSignal = {
			pairs: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					npmi: 0.9,
					coChangeCount: 9,
				} as never,
			],
			threshold: { npmi: 0.6, minCoChanges: 5 },
		};
		expect(edge(['src/a.ts'], ['src/b.ts'], cochange)).toBe(true);
		// A root-prefixed scope path matches a repo-relative pair file.
		expect(edge(['/project/src/a.ts'], ['src/b.ts'], cochange)).toBe(true);
		// A pair internal to one scope couples nothing.
		expect(edge(['src/a.ts', 'src/b.ts'], ['src/c.ts'], cochange)).toBe(false);
		expect(
			edge(['src/a.ts'], ['src/b.ts'], {
				...cochange,
				threshold: { npmi: 0.95, minCoChanges: 5 },
			}),
		).toBe(false);
	});
});

describe('components and modes', () => {
	test('disjoint tasks: singleton parallel components, one wave', () => {
		const { partition } = plan([{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }]);
		expect(partition.components.map((c) => [c.id, c.mode])).toEqual([
			['1.1', 'parallel'],
			['1.2', 'parallel'],
			['1.3', 'parallel'],
		]);
		expect(
			nextWave([{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }])?.taskIds,
		).toEqual(['1.1', '1.2', '1.3']);
	});

	test('star: a hub task with 3 spokes is dense (2/4 > 0.3) ⇒ serial', () => {
		const specs: Spec[] = [
			{ id: '1.1', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
			{ id: '1.2', files: ['src/a.ts'] },
			{ id: '1.3', files: ['src/b.ts'] },
			{ id: '1.4', files: ['src/c.ts'] },
		];
		const { partition } = plan(specs);
		expect(partition.components).toEqual([
			{
				id: '1.1',
				members: ['1.1', '1.2', '1.3', '1.4'],
				mode: 'serial-component',
				edgeCount: 3,
				density: 0.5,
			},
		]);
		expect(nextWave(specs)).toEqual({
			taskIds: ['1.1'],
			kind: 'serial-component',
		});
	});

	test('density demotion: a component at or below the threshold is parallel', () => {
		const star: Spec[] = [
			{ id: '1.1', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
			{ id: '1.2', files: ['src/a.ts'] },
			{ id: '1.3', files: ['src/b.ts'] },
			{ id: '1.4', files: ['src/c.ts'] },
		];
		expect(plan(star, 0.5).partition.components[0].mode).toBe('parallel');
		// Chain 1.1—1.2—1.3 (d = 2/3): serial at 0.3 — one task; parallel at
		// 0.7 — the non-adjacent ends share the wave.
		const short = chain(3);
		expect(nextWave(short, 4, 0.3)).toEqual({
			taskIds: ['1.1'],
			kind: 'serial-component',
		});
		expect(nextWave(short, 4, 0.7)).toEqual({
			taskIds: ['1.1', '1.3'],
			kind: 'parallel',
		});
	});

	test('chain: ONE component, yet non-adjacent tasks run in parallel', () => {
		const specs = chain(8); // 7 edges / 28 pairs = 0.25 ≤ 0.3
		const { partition } = plan(specs);
		expect(partition.components).toHaveLength(1);
		expect(partition.components[0]).toMatchObject({
			mode: 'parallel',
			edgeCount: 7,
			density: 0.25,
		});
		expect(nextWave(specs)?.taskIds).toEqual(['1.1', '1.3', '1.5', '1.7']);
		// A short chain is dense (2/3) ⇒ serial.
		expect(plan(chain(3)).partition.components[0].mode).toBe(
			'serial-component',
		);
	});

	test('exclusive: global file, protected path, no scope, hot file — alone, first', () => {
		const specs: Spec[] = [
			{ id: '1.1' },
			{ id: '1.2', files: ['package.json'] },
			{ id: '1.3', files: ['src/auth/login.ts'] },
			{ id: '1.4', files: [] },
			{ id: '1.5', files: ['src/hot.ts'] },
		];
		const { partition } = plan(specs, 0.3, { hotFiles: ['src/hot.ts'] });
		expect(
			partition.components
				.filter((c) => c.mode === 'exclusive')
				.map((c) => [c.id, c.exclusiveReason]),
		).toEqual([
			['1.2', 'global-file'],
			['1.3', 'protected-path'],
			['1.4', 'no-scope'],
			['1.5', 'hot-file'],
		]);
		expect(nextWave(specs, 4, 0.3, { hotFiles: ['src/hot.ts'] })).toEqual({
			taskIds: ['1.2'],
			kind: 'exclusive',
		});
	});

	test('hot files match exact paths only: a directory scope over a hot file is not exclusive', () => {
		const specs: Spec[] = [
			{ id: '1.1', files: ['src/lib'] },
			{ id: '1.2', files: ['src/lib/hot.ts'] },
			{ id: '1.3', files: ['./src/lib/hot.ts'] },
		];
		const { partition } = plan(specs, 0.3, { hotFiles: ['src/lib/hot.ts'] });
		expect(
			partition.components
				.filter((c) => c.mode === 'exclusive')
				.map((c) => c.id),
		).toEqual(['1.2', '1.3']);
	});

	test('an exclusive task never joins a component through its conflicts', () => {
		const specs: Spec[] = [
			{ id: '1.1', files: ['package.json', 'src/a.ts'] },
			{ id: '1.2', files: ['src/a.ts'] },
			{ id: '1.3', files: ['src/a.ts', 'src/b.ts'] },
		];
		const { partition } = plan(specs);
		expect(partition.componentOf.get('1.1')).toBe('1.1');
		expect(partition.componentOf.get('1.2')).toBe('1.2');
		expect(partition.componentOf.get('1.3')).toBe('1.2');
	});
});

describe('readiness', () => {
	test('in-phase dependencies wait; a cycle is never ready', () => {
		const specs: Spec[] = [
			{ id: '1.1' },
			{ id: '1.2', depends: ['1.1'] },
			{ id: '1.3', depends: ['1.4'] },
			{ id: '1.4', depends: ['1.3'] },
		];
		const graph = buildEpicConflictGraph(graphInput(specs));
		expect(readyEpicTasks(graph, new Set(), () => true)).toEqual(['1.1']);
		expect(readyEpicTasks(graph, new Set(['1.1']), () => true)).toEqual([
			'1.2',
		]);
	});

	test('an out-of-phase dependency needs the caller’s evidence', () => {
		const graph = buildEpicConflictGraph(
			graphInput([{ id: '2.1', depends: ['1.9'] }, { id: '2.2' }]),
		);
		expect(readyEpicTasks(graph, new Set(), () => false)).toEqual(['2.2']);
		expect(readyEpicTasks(graph, new Set(), () => true)).toEqual([
			'2.1',
			'2.2',
		]);
	});
});

describe('starvation: oldest component first', () => {
	const specs: Spec[] = [
		{ id: '1.1', files: ['src/x.ts'] },
		{ id: '1.2', files: ['src/x.ts'] },
		{ id: '1.3', files: ['src/y.ts'] },
		{ id: '1.4', files: ['src/y.ts'] },
	];

	test('ages count waves since the component last had a task issued', () => {
		const { partition } = plan(specs);
		const byTask = { '1.1': '1.1', '1.2': '1.1', '1.3': '1.3', '1.4': '1.3' };
		const history = [
			{ taskIds: ['1.0'], components: { byTask: { '1.0': '1.0' } } },
			{ taskIds: ['1.2'], components: { byTask } },
		];
		const ages = componentAges(partition, history);
		expect(ages.get('1.1')).toBe(0);
		expect(ages.get('1.3')).toBe(2);
		// A wave record without components still counts its own members.
		expect(componentAges(partition, [{ taskIds: ['1.4'] }]).get('1.3')).toBe(0);
	});

	test('with width 1 the older component wins over topological order', () => {
		const { graph, partition } = plan(specs);
		const ready = readyEpicTasks(graph, new Set(), () => true);
		expect(
			chooseEpicWave(graph, partition, ready, 1, new Map())?.taskIds,
		).toEqual(['1.1']);
		const aged = new Map([
			['1.1', 0],
			['1.3', 1],
		]);
		expect(chooseEpicWave(graph, partition, ready, 1, aged)?.taskIds).toEqual([
			'1.3',
		]);
	});

	test('dry-run with width 1 alternates the two components', () => {
		const run = dryRunEpicPhase({
			...graphInput(specs),
			maxParallel: 1,
			densityThreshold: 0.3,
		});
		expect(run.waves.map((w) => w.taskIds[0])).toEqual([
			'1.1',
			'1.3',
			'1.2',
			'1.4',
		]);
	});
});

describe('recorded components and the dry-run', () => {
	test('toWaveComponents caps byTask but always keeps the wave tasks', () => {
		const specs = Array.from({ length: 300 }, (_, i) => ({
			id: `1.${String(i).padStart(3, '0')}`,
		}));
		const { partition } = plan(specs);
		const recorded = toWaveComponents(partition, ['1.299']);
		expect(Object.keys(recorded.byTask)).toHaveLength(256);
		expect(recorded.byTask['1.299']).toBe('1.299');
		expect(recorded.truncated).toBe(true);
	});

	test('dry-run: hub cluster serializes only within itself; cycles unscheduled', () => {
		const run = dryRunEpicPhase({
			...graphInput([
				{ id: '1.1', files: ['src/hub.ts'] },
				{ id: '1.2', files: ['src/hub.ts'] },
				{ id: '1.3', files: ['src/hub.ts'] },
				{ id: '1.4' },
				{ id: '1.5' },
				{ id: '1.6', depends: ['1.7'] },
				{ id: '1.7', depends: ['1.6'] },
			]),
			maxParallel: 4,
			densityThreshold: 0.3,
		});
		expect(run.waves.map((w) => w.taskIds)).toEqual([
			['1.1', '1.4', '1.5'],
			['1.2'],
			['1.3'],
		]);
		expect(run.unscheduled).toEqual(['1.6', '1.7']);
	});
});

describe('bounded dry-run (Epic v2 C7)', () => {
	const specs = [
		{ id: '1.1', files: ['src/hub.ts'] },
		{ id: '1.2', files: ['src/hub.ts'] },
		{ id: '1.3', files: ['src/hub.ts'] },
		{ id: '1.4' },
	];
	const input = { ...graphInput(specs), maxParallel: 4, densityThreshold: 0.3 };

	test('a sufficient budget changes nothing; the work is counted', () => {
		const free = dryRunEpicPhase(input);
		const bounded = dryRunEpicPhase({ ...input, maxWork: 1_000_000 });
		expect(bounded).toEqual(free);
		expect(free.aborted).toBe(false);
		expect(free.work).toBeGreaterThan(0);
	});

	test('the budget stops the run before a step that would exceed it', () => {
		const free = dryRunEpicPhase(input);
		const firstStep = epicWaveWork([1, 1, 1, 1], 0);
		const bounded = dryRunEpicPhase({ ...input, maxWork: firstStep });
		expect(bounded.aborted).toBe(true);
		expect(bounded.waves).toEqual(free.waves.slice(0, 1));
		expect(bounded.work).toBe(firstStep);
		// Every task not planned counts as unscheduled (pessimistic steps).
		expect(bounded.unscheduled.length).toBe(4 - free.waves[0].taskIds.length);
		expect(dryRunEpicPhase({ ...input, maxWork: 0 })).toMatchObject({
			waves: [],
			unscheduled: ['1.1', '1.2', '1.3', '1.4'],
			aborted: true,
			work: 0,
		});
	});
});

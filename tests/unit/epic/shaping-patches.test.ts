/**
 * Epic v2 C7 — every plan-changing shaping suggestion is a CONCRETE patch:
 * applied verbatim it yields a valid plan (unique valid ids, no dangling
 * dependency, no new cycle) whose sizing is exactly the promised what-if.
 * Covers isolate-hot-file, split-task, merge-tasks (incl. the transitive
 * merge cycle), the cycle-safe prerequisite dependencies, directory
 * entries (narrow-scope advice, never extracted), a seeded property sweep,
 * and the latency bound.
 */
import { describe, expect, test } from 'bun:test';
import { shapeEpicPlan } from '../../../src/epic/shaping';
import {
	type EpicShapingPhase,
	epicSizingContextFor,
	estimateEpicScopes,
	sizeEpicPlan,
} from '../../../src/epic/shaping-sizing';
import { normalizePath } from '../../../src/utils/path';
import {
	applySuggestion,
	CONTEXT,
	NO_SIGNALS,
	ofType,
	planProblems,
	task,
} from './shaping-fixture';

function shape(
	phases: EpicShapingPhase[],
	extra: { isDirectory?: (entry: string) => boolean } = {},
	context = CONTEXT,
) {
	return shapeEpicPlan({ ...context, phases, declared: {}, ...extra });
}

/** Applied verbatim: valid, and sized exactly as promised. */
function expectHonest(
	phases: EpicShapingPhase[],
	report: ReturnType<typeof shape>,
	context = CONTEXT,
): number {
	let checked = 0;
	for (const suggestion of report.suggestions) {
		const next = applySuggestion(phases, suggestion);
		if (!next || !suggestion.whatIf) continue;
		expect(planProblems(next)).toEqual([]);
		const after = sizeEpicPlan(
			context,
			next,
			estimateEpicScopes(next, {}),
		).verdict;
		expect({
			type: suggestion.type,
			speedup: after.effectiveSpeedup,
			steps: after.serialSteps,
			tasks: after.pendingTasks,
		}).toEqual({
			type: suggestion.type,
			speedup: suggestion.whatIf.effectiveSpeedup,
			steps: suggestion.whatIf.serialSteps,
			tasks: suggestion.whatIf.pendingTasks,
		});
		checked += 1;
	}
	return checked;
}

describe('isolate-hot-file and split-task', () => {
	test('a learned hot file declared by two tasks is isolated (honest patch)', () => {
		const phases: EpicShapingPhase[] = [
			{
				id: 1,
				tasks: [
					task('1.1', ['src/hot.ts', 'src/a.ts']),
					task('1.2', ['src/hot.ts', 'src/b.ts']),
					...Array.from({ length: 6 }, (_, i) =>
						task(`1.${i + 3}`, [`src/own-${i}.ts`]),
					),
				],
			},
		];
		const context = epicSizingContextFor('/project', {}, 4, {
			...NO_SIGNALS,
			hotFiles: ['src/hot.ts'],
		});
		const report = shape(phases, {}, context);
		const isolate = ofType(report.suggestions, 'isolate-hot-file');
		expect(isolate).toMatchObject({
			file: 'src/hot.ts',
			taskIds: ['1.1', '1.2'],
		});
		expect(isolate?.patch.newTask.id).toBe('1.9');
		expect(expectHonest(phases, report, context)).toBeGreaterThan(0);
	});

	test('split: real part ids, dependents wait for every part, promised == applied', () => {
		const phases: EpicShapingPhase[] = [
			{
				id: 1,
				tasks: [
					task('1.1', ['src/x.ts', 'src/a1.ts']),
					task('1.2', ['src/x.ts', 'src/a2.ts']),
					task('1.3', ['src/y.ts', 'src/b1.ts']),
					task('1.4', ['src/y.ts', 'src/b2.ts']),
					task('1.5', ['src/x.ts', 'src/y.ts', 'src/own.ts']),
					task('1.6', ['src/after.ts'], { depends: ['1.5'] }),
				],
			},
		];
		const report = shape(phases);
		const split = ofType(report.suggestions, 'split-task');
		expect(split).toMatchObject({
			taskId: '1.5',
			parts: [['src/x.ts', 'src/own.ts'], ['src/y.ts']],
		});
		expect(split?.patch.newTasks.map((t) => [t.id, t.files_touched])).toEqual([
			['1.7', ['src/y.ts']],
		]);
		expect(split?.patch.edits).toContainEqual({
			taskId: '1.6',
			depends: ['1.5', '1.7'],
		});
		expect(split?.summary).toContain('must depend on all parts');
		expect(expectHonest(phases, report)).toBeGreaterThan(0);
	});
});

describe('merge-tasks', () => {
	test('concrete patch: removal, union scope, dependents re-pointed', () => {
		const phases: EpicShapingPhase[] = [
			{
				id: 1,
				tasks: [
					task('1.1', ['src/m.ts', 'src/n.ts']),
					task('1.2', ['src/n.ts', 'src/m.ts'], { depends: ['1.1'] }),
					task('1.3', ['src/c.ts'], { depends: ['1.2'] }),
					...Array.from({ length: 5 }, (_, i) =>
						task(`1.${i + 4}`, [`src/o${i}.ts`]),
					),
				],
			},
		];
		const report = shape(phases);
		const merge = ofType(report.suggestions, 'merge-tasks');
		expect(merge).toMatchObject({ keep: '1.1', absorb: '1.2', jaccard: 1 });
		expect(merge?.patch).toEqual({
			removed_task_ids: ['1.2'],
			removal_reason: expect.stringContaining('Merged into 1.1'),
			edits: [
				{ taskId: '1.1', depends: [], files_touched: ['src/m.ts', 'src/n.ts'] },
				{ taskId: '1.3', depends: ['1.1'] },
			],
		});
		expect(expectHonest(phases, report)).toBeGreaterThan(0);
		const large = phases.map((p) => ({
			...p,
			tasks: (p.tasks ?? []).map((t) =>
				t.id === '1.2' ? { ...t, size: 'large' } : t,
			),
		}));
		expect(ofType(shape(large).suggestions, 'merge-tasks')).toBeUndefined();
	});

	test('regression: no merge when one task reaches the other through another (cycle)', () => {
		// 1.3 → 1.2 → 1.1, and 1.1 / 1.3 share their whole scope: merging them
		// would make the merged task depend on itself through 1.2.
		const phases: EpicShapingPhase[] = [
			{
				id: 1,
				tasks: [
					task('1.1', ['src/a.ts']),
					task('1.2', ['src/a.ts', 'src/b.ts'], { depends: ['1.1'] }),
					task('1.3', ['src/a.ts'], { depends: ['1.2'] }),
					task('1.10', ['src/a.ts', 'src/c.ts']),
					task('1.11', ['src/a.ts', 'src/d.ts']),
					...Array.from({ length: 6 }, (_, i) =>
						task(`1.${i + 4}`, [`src/w${i}.ts`]),
					),
				],
			},
		];
		const report = shape(phases);
		for (const s of report.suggestions) {
			if (s.type === 'merge-tasks') {
				expect([s.keep, s.absorb].sort()).not.toEqual(['1.1', '1.3']);
			}
		}
		expectHonest(phases, report);
	});
});

describe('cycle safety and directory entries', () => {
	test('the prerequisite inherits outside deps, never one that reaches an owner', () => {
		const phases: EpicShapingPhase[] = [
			{ id: 1, tasks: [task('1.1', ['src/base.ts'])] },
			{
				id: 2,
				tasks: [
					task('2.1', ['src/hub.ts', 'src/f1.ts'], { depends: ['1.1'] }),
					task('2.2', ['src/hub.ts', 'src/f2.ts'], { depends: ['1.1'] }),
					task('2.3', ['src/hub.ts', 'src/f3.ts'], { depends: ['2.1'] }),
					task('2.4', ['src/hub.ts', 'src/f4.ts']),
					task('2.5', ['src/g.ts'], { depends: ['2.1'] }),
					task('2.6', ['src/hub.ts', 'src/f6.ts'], { depends: ['2.5'] }),
					task('2.7', ['src/s7.ts']),
					task('2.8', ['src/s8.ts']),
				],
			},
		];
		const report = shape(phases);
		const extract = ofType(report.suggestions, 'extract-prerequisite');
		// 1.1 is inherited; 2.5 depends on owner 2.1, so it would close a cycle.
		expect(extract?.patch.newTask).toMatchObject({
			id: '2.9',
			depends: ['1.1'],
		});
		expect(expectHonest(phases, report)).toBeGreaterThan(0);
	});

	test('a directory entry is never extracted: narrow-scope advice instead', () => {
		const phases: EpicShapingPhase[] = [
			{
				id: 1,
				tasks: [
					...Array.from({ length: 6 }, (_, i) =>
						task(`1.${i + 1}`, ['src/lib', `src/lib/f${i}.ts`]),
					),
					task('1.7', ['src/s7.ts']),
					task('1.8', ['src/s8.ts']),
				],
			},
		];
		for (const isDirectory of [undefined, () => true]) {
			const report = shape(phases, isDirectory ? { isDirectory } : {});
			expect(
				report.suggestions.some((s) => s.type === 'extract-prerequisite'),
			).toBe(false);
			expect(report.suggestions[0]).toMatchObject({
				type: 'narrow-scope',
				entry: 'src/lib',
				taskIds: ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6'],
			});
		}
		// A no-extension FILE the caller confirms is not a directory: extractable.
		const makefile = phases.map((p) => ({
			...p,
			tasks: (p.tasks ?? []).map((t) =>
				t.id <= '1.6'
					? { ...t, files_touched: ['Makefile', `src/m${t.id}.ts`] }
					: t,
			),
		}));
		const report = shape(makefile, { isDirectory: () => false });
		// Paths are `normalizePath`d, which case-folds on win32.
		expect(ofType(report.suggestions, 'extract-prerequisite')?.file).toBe(
			normalizePath('Makefile'),
		);
	});
});

describe('property: random plans', () => {
	test('every suggestion applied verbatim is valid, acyclic and honest', () => {
		let seed = 7;
		const rnd = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const pool = [
			'src/registry.ts',
			'src/index.ts',
			'package.json',
			'src/hub.ts',
			'src/shared/types.ts',
			...Array.from({ length: 24 }, (_, i) => `src/f${i}.ts`),
		];
		const pick = () => pool[Math.floor(rnd() * pool.length)];
		let checked = 0;
		for (let iteration = 0; iteration < 120; iteration += 1) {
			const phases: EpicShapingPhase[] = [];
			const nPhases = 1 + Math.floor(rnd() * 2);
			for (let p = 1; p <= nPhases; p += 1) {
				const hubs = [pick(), pick()];
				const n = 4 + Math.floor(rnd() * 12);
				const tasks = Array.from({ length: n }, (_, i) => {
					const files = new Set<string>();
					const k = rnd() < 0.06 ? 0 : 1 + Math.floor(rnd() * 3);
					for (let j = 0; j < k; j += 1)
						files.add(rnd() < 0.45 ? hubs[j % 2] : pick());
					const depends =
						i > 0 && rnd() < 0.35 ? [`${p}.${1 + Math.floor(rnd() * i)}`] : [];
					return task(`${p}.${i + 1}`, [...files], {
						depends,
						size: rnd() < 0.8 ? 'small' : 'medium',
						status: rnd() < 0.08 ? 'completed' : 'pending',
					});
				});
				phases.push({ id: p, tasks });
			}
			expect(planProblems(phases)).toEqual([]);
			checked += expectHonest(phases, shape(phases));
		}
		expect(checked).toBeGreaterThan(20);
	});
});

describe('latency bound', () => {
	test('adversarial plans within the caps shape within a generous bound', () => {
		const all = Array.from({ length: 500 }, (_, i) => `src/m${i}/f${i}.ts`);
		const plans: EpicShapingPhase[][] = [
			// every task touches the same 500 files
			[
				{
					id: 1,
					tasks: Array.from({ length: 60 }, (_, i) => task(`1.${i + 1}`, all)),
				},
			],
			// 200 tasks, alternating halves of 100 files
			[
				{
					id: 1,
					tasks: Array.from({ length: 200 }, (_, i) =>
						task(
							`1.${i + 1}`,
							all.filter((_, j) => (j + i) % 2 === 0).slice(0, 100),
						),
					),
				},
			],
			// a 200-task dependency chain
			[
				{
					id: 1,
					tasks: Array.from({ length: 200 }, (_, i) =>
						task(`1.${i + 1}`, [all[i], all[i + 1]], {
							depends: i ? [`1.${i}`] : [],
						}),
					),
				},
			],
			// 200 sparse tasks
			[
				{
					id: 1,
					tasks: Array.from({ length: 200 }, (_, i) =>
						task(`1.${i + 1}`, [
							all[i % 500],
							all[(i * 7) % 500],
							all[(i * 13 + 1) % 500],
						]),
					),
				},
			],
		];
		for (const phases of plans) {
			const started = performance.now();
			const report = shape(phases);
			const elapsed = performance.now() - started;
			expect(report.budget.work).toBeLessThanOrEqual(report.budget.maxWork);
			// ≈ 0.25 s on a laptop; 3 s leaves room for slow CI runners.
			expect(elapsed).toBeLessThan(3_000);
		}
	});
});

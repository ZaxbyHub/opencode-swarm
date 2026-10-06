/**
 * Epic v2 C7 — plan shaping (`src/epic/shaping.ts`, pure).
 *
 * The suggestions are judged by the SAME sizing `/swarm epic start` uses
 * (`sizeEpicPlan`): applying an extract-prerequisite patch reproduces the
 * what-if it promised, and turns a not-epic-sized hub plan epic-sized.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../src/config/constants';
import {
	formatEpicShapingLines,
	MAX_SHAPING_TASKS,
	shapeEpicPlan,
} from '../../../src/epic/shaping';
import {
	type EpicShapingPhase,
	estimateEpicScopes,
	sizeEpicPlan,
} from '../../../src/epic/shaping-sizing';
import {
	applySuggestion,
	CONTEXT,
	hubPhase,
	ofType,
	planProblems,
	task,
} from './shaping-fixture';

function shape(phases: EpicShapingPhase[], extra: { maxWork?: number } = {}) {
	return shapeEpicPlan({ ...CONTEXT, phases, declared: {}, ...extra });
}

function sized(phases: EpicShapingPhase[]) {
	return sizeEpicPlan(CONTEXT, phases, estimateEpicScopes(phases, {})).verdict;
}

describe('extract-prerequisite (hub file)', () => {
	const phases = [hubPhase('src/registry.ts', 6, 2)];

	test('a star hub yields a concrete, valid save_plan patch', () => {
		const report = shape(phases);
		expect(report.sizing?.epicSized).toBe(false);
		expect(report.verdict).toBe('improvable');
		const top = report.suggestions[0];
		expect(top.type).toBe('extract-prerequisite');
		if (top.type !== 'extract-prerequisite') return;
		expect(top.file).toBe('src/registry.ts');
		expect(top.fileKind).toBe('hub-file');
		expect(top.edgeShare).toBe(1);
		expect(top.taskIds).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '1.6']);
		// New id: save_plan's strict N.M format, unused, in the hub's phase.
		expect(top.patch.newTask).toMatchObject({
			id: '1.9',
			phase: 1,
			files_touched: ['src/registry.ts'],
			depends: [],
		});
		expect(top.patch.newTask.id).toMatch(/^\d+\.\d+(\.\d+)*$/);
		expect(top.patch.newTask.description).not.toMatch(/\[[^\]]*\]/);
		expect(top.patch.edits).toHaveLength(6);
		expect(top.patch.edits[0]).toEqual({
			taskId: '1.1',
			remove_files: ['src/registry.ts'],
			add_depends: ['1.9'],
			files_touched: ['src/feature-1.ts'],
			depends: ['1.9'],
		});
		expect(top.whatIf?.epicSized).toBe(true);
		expect(top.deltaEffectiveSpeedup).toBeGreaterThan(0.25);
	});

	test('applying the patch makes the plan epic-sized, exactly as promised', () => {
		const report = shape(phases);
		const top = report.suggestions[0];
		if (top.type !== 'extract-prerequisite') throw new Error('no extract');
		const before = sized(phases);
		const after = sized(applySuggestion(phases, top) ?? []);
		expect(before.epicSized).toBe(false);
		expect(after.epicSized).toBe(true);
		expect(after.effectiveSpeedup).toBeGreaterThan(before.effectiveSpeedup);
		expect(after.effectiveSpeedup).toBeCloseTo(
			top.whatIf?.effectiveSpeedup ?? 0,
			10,
		);
		expect(after.serialSteps).toBe(top.whatIf?.serialSteps ?? -1);
		expect(planProblems(applySuggestion(phases, top) ?? [])).toEqual([]);
		// Re-shaping the patched plan: nothing left to fix.
		const again = shape(applySuggestion(phases, top) ?? []);
		expect(again.verdict).toBe('acceptable');
		expect(ofType(again.suggestions, 'extract-prerequisite')).toBeUndefined();
	});

	test('the new id skips every id already used (any status, nested ids)', () => {
		const phase = hubPhase('src/registry.ts', 6, 2);
		phase.tasks = [
			...(phase.tasks ?? []),
			task('1.12', ['src/done.ts'], { status: 'completed' }),
			task('1.13.1', ['src/nested.ts'], { status: 'completed' }),
		];
		const top = shape([phase]).suggestions[0];
		if (top.type !== 'extract-prerequisite') throw new Error('no extract');
		expect(top.patch.newTask.id).toBe('1.14');
	});

	test('a global (barrel) file: every task runs alone until it is extracted', () => {
		const report = shape([hubPhase('src/shared/types.ts', 6, 0)]);
		expect(report.sizing?.serialSteps).toBe(6);
		const top = ofType(report.suggestions, 'extract-prerequisite');
		expect(top?.fileKind).toBe('global-file');
		expect(top?.edgeShare).toBe(0); // exclusive tasks have no edges
		expect(top?.whatIf?.epicSized).toBe(true);
	});

	test('a task whose whole scope is the hub keeps it (it must still edit it)', () => {
		const phase = hubPhase('src/registry.ts', 6, 2);
		phase.tasks = [...(phase.tasks ?? []), task('1.9', ['src/registry.ts'])];
		const top = shape([phase]).suggestions[0];
		if (top.type !== 'extract-prerequisite') throw new Error('no extract');
		const edit = top.patch.edits.find((e) => e.taskId === '1.9');
		expect(edit).toMatchObject({
			remove_files: [],
			files_touched: ['src/registry.ts'],
			depends: ['1.10'],
		});
	});
});

describe('declare-scope, verdicts', () => {
	test('declare-scope is always ranked first', () => {
		const phase = hubPhase('src/registry.ts', 6, 2);
		phase.tasks = [...(phase.tasks ?? []), task('1.9', [])];
		const report = shape([phase]);
		expect(report.suggestions[0]).toMatchObject({
			type: 'declare-scope',
			taskIds: ['1.9'],
			count: 1,
			deltaEffectiveSpeedup: null,
		});
		expect(report.suggestions[1].type).toBe('extract-prerequisite');
	});

	test('independent tasks: acceptable, no suggestion', () => {
		const report = shape([hubPhase('unused', 0, 8)]);
		expect(report.sizing?.epicSized).toBe(true);
		expect(report).toMatchObject({ verdict: 'acceptable', suggestions: [] });
	});

	test('too few tasks: not-epic-sized (nothing to suggest)', () => {
		const report = shape([hubPhase('unused', 0, 3)]);
		expect(report.verdict).toBe('not-epic-sized');
		expect(report.sizing?.reasons).toEqual(['too-few-tasks']);
	});

	test('a fully coupled plan no suggestion rescues is not-epic-sized', () => {
		// Every task shares two files: extracting one still leaves the other.
		const tasks = Array.from({ length: 6 }, (_, i) =>
			task(`1.${i + 1}`, ['src/a.ts', 'src/b.ts']),
		);
		const report = shape([{ id: 1, tasks }]);
		expect(report.sizing?.epicSized).toBe(false);
		expect(report.verdict).toBe('not-epic-sized');
	});

	test('completed / closed tasks are ignored; ranking is deterministic', () => {
		const phase = hubPhase('src/registry.ts', 6, 2);
		phase.tasks = [
			...(phase.tasks ?? []),
			task('1.20', ['src/registry.ts'], { status: 'completed' }),
			task('1.21', ['src/registry.ts'], { status: 'closed' }),
		];
		const a = shape([phase]);
		const b = shape([phase]);
		expect(a).toEqual(b);
		expect(a.sizing?.pendingTasks).toBe(8);
		const top = ofType(a.suggestions, 'extract-prerequisite');
		expect(top?.taskIds).not.toContain('1.20');
		expect(top?.patch.newTask.id).toBe('1.22');
	});
});

describe('budget', () => {
	test(`over ${MAX_SHAPING_TASKS} pending tasks: skipped-budget, nothing computed`, () => {
		const report = shape([hubPhase('unused', 0, MAX_SHAPING_TASKS + 1)]);
		expect(report).toMatchObject({
			verdict: 'skipped-budget',
			sizing: null,
			suggestions: [],
		});
		expect(report.budget.tasks).toBe(201);
	});

	test('over 500 distinct scope files: skipped-budget', () => {
		const tasks = Array.from({ length: 6 }, (_, i) =>
			task(
				`1.${i + 1}`,
				Array.from({ length: 90 }, (_, j) => `src/t${i}/f${j}.ts`),
			),
		);
		const report = shape([{ id: 1, tasks }]);
		expect(report.verdict).toBe('skipped-budget');
		expect(report.budget.files).toBe(540);
	});

	test('work budget too small for the baseline: skipped-budget, no sizing', () => {
		const report = shape([hubPhase('src/registry.ts', 6, 2)], { maxWork: 1 });
		expect(report).toMatchObject({ verdict: 'skipped-budget', sizing: null });
		expect(report.budget).toMatchObject({ whatIfs: 0, truncated: true });
		expect(formatEpicShapingLines(report)[0]).toContain('work budget');
	});

	test('baseline fits but no what-if does: skipped-budget with the baseline', () => {
		const phases = [hubPhase('src/registry.ts', 6, 2)];
		const baseline = sizeEpicPlan(
			CONTEXT,
			phases,
			estimateEpicScopes(phases, {}),
		);
		const report = shape(phases, { maxWork: baseline.work + 1 });
		expect(report.verdict).toBe('skipped-budget');
		expect(report.sizing?.epicSized).toBe(false);
		expect(report.budget.truncated).toBe(true);
		expect(formatEpicShapingLines(report)[0]).toContain('evaluate suggestions');
	});

	test('the work spent never exceeds the allowance', () => {
		for (const maxWork of [10_000, 50_000, 200_000, 1_000_000]) {
			const report = shape([hubPhase('src/registry.ts', 40, 20)], { maxWork });
			expect(report.budget.work).toBeLessThanOrEqual(maxWork);
		}
	});

	test('what-ifs are capped and counted', () => {
		const report = shape([hubPhase('src/registry.ts', 6, 2)]);
		expect(report.budget.whatIfs).toBeGreaterThan(0);
		expect(report.budget.whatIfs).toBeLessThanOrEqual(16);
		expect(report.budget.truncated).toBe(false);
		expect(report.suggestions.length).toBeLessThanOrEqual(5);
	});
});

describe('formatting', () => {
	test('markdown lines carry the verdict, the ranked suggestions and the patch', () => {
		const lines = formatEpicShapingLines(
			shape([hubPhase('src/registry.ts', 6, 2)]),
		);
		expect(lines[0]).toContain(
			'Plan shaping: **improvable** — the suggestions below would help',
		);
		expect(lines[1]).toStartWith('1. [extract-prerequisite]');
		expect(lines[2]).toContain(
			'Patch: add task 1.9 to phase 1 (files_touched [src/registry.ts], depends [])',
		);
		expect(lines[2]).toContain(
			'1.1: files_touched [src/feature-1.ts], depends [1.9]',
		);
	});

	test('maxSuggestions trims and points to the full list', () => {
		const phase = hubPhase('src/registry.ts', 6, 2);
		phase.tasks = [...(phase.tasks ?? []), task('1.9', [])];
		const lines = formatEpicShapingLines(shape([phase]), { maxSuggestions: 1 });
		expect(lines.some((l) => l.includes('/swarm coupling --suggest'))).toBe(
			true,
		);
	});

	test('the lean risk policy comes from config', () => {
		expect(CONTEXT.leanConfig).toEqual(DEFAULT_LEAN_TURBO_CONFIG);
		expect(CONTEXT.thresholds.minTasks).toBe(6);
	});
});

/**
 * Tests for Epic mode's coupling-report computation (Capability B).
 * File: tests/unit/epic/coupling-report.test.ts
 *
 * Covers:
 *  - Edge cases: 0 / 1 task → no coupling to measure.
 *  - p value correctness across small known fixtures.
 *  - Per-module contention attribution (path-only, cochange-only, both).
 *  - Roadmap top-N truncation and stable lexicographic tie-break.
 *  - Markdown formatter renders the expected sections.
 */
import { describe, expect, test } from 'bun:test';
import {
	type CouplingTask,
	computeCouplingReport,
	formatCouplingReportMarkdown,
} from '../../../src/epic/coupling-report';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';

const THRESHOLD = { npmi: 0.6, minCoChanges: 5 };

function entry(fileA: string, fileB: string, npmi = 0.9): CoChangeEntry {
	const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
	return {
		fileA: a,
		fileB: b,
		coChangeCount: 10,
		npmi,
		lift: 1,
		hasStaticEdge: false,
		totalCommits: 100,
		commitsA: 20,
		commitsB: 20,
	};
}

describe('computeCouplingReport — edge cases', () => {
	test('empty task list → p=0, totalPairs=0, no conflicts', () => {
		const r = computeCouplingReport([], [], THRESHOLD);
		expect(r.taskCount).toBe(0);
		expect(r.totalPairs).toBe(0);
		expect(r.conflictingPairCount).toBe(0);
		expect(r.p).toBe(0);
		expect(r.perModule).toEqual([]);
		expect(r.roadmap).toEqual([]);
	});

	test('single task → no pairs to evaluate, p=0', () => {
		const tasks: CouplingTask[] = [{ id: '1.1', scope: ['src/a.ts'] }];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.taskCount).toBe(1);
		expect(r.totalPairs).toBe(0);
		expect(r.p).toBe(0);
	});

	test('two disjoint tasks no co-change → p=0, no conflicts', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/b.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.taskCount).toBe(2);
		expect(r.totalPairs).toBe(1);
		expect(r.conflictingPairCount).toBe(0);
		expect(r.p).toBe(0);
	});
});

describe('computeCouplingReport — p value', () => {
	test('two tasks with path overlap → p=1', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/shared.ts'] },
			{ id: '1.2', scope: ['src/shared.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.totalPairs).toBe(1);
		expect(r.conflictingPairCount).toBe(1);
		expect(r.p).toBe(1);
	});

	test('three tasks with one conflicting pair → p ≈ 0.333', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/a.ts'] }, // conflicts with 1.1
			{ id: '1.3', scope: ['src/b.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.totalPairs).toBe(3); // (1,2), (1,3), (2,3)
		expect(r.conflictingPairCount).toBe(1);
		expect(r.p).toBeCloseTo(1 / 3, 5);
	});

	test('every pair conflicts → p=1', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/x.ts'] },
			{ id: '1.2', scope: ['src/x.ts'] },
			{ id: '1.3', scope: ['src/x.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.totalPairs).toBe(3);
		expect(r.conflictingPairCount).toBe(3);
		expect(r.p).toBe(1);
	});

	test('cochange-only conflict promotes a no-path pair into the count', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/b.ts'] }, // no path overlap with 1.1
		];
		const pairs = [entry('src/a.ts', 'src/b.ts', 0.9)]; // historically coupled
		const r = computeCouplingReport(tasks, pairs, THRESHOLD);
		expect(r.conflictingPairCount).toBe(1);
		expect(r.p).toBe(1);
		expect(r.conflictingPairs[0].reason).toBe('cochange');
	});
});

describe('computeCouplingReport — per-module attribution', () => {
	test('path conflict on a single module attributes only that module', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/a.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.perModule).toHaveLength(1);
		expect(r.perModule[0].module).toBe('src/a.ts');
		expect(r.perModule[0].conflicts).toBe(1);
		expect(r.perModule[0].share).toBe(1);
	});

	test('cochange conflict attributes BOTH files of the pair', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/b.ts'] },
		];
		const pairs = [entry('src/a.ts', 'src/b.ts', 0.9)];
		const r = computeCouplingReport(tasks, pairs, THRESHOLD);
		expect(r.perModule).toHaveLength(2);
		const modules = r.perModule.map((m) => m.module).sort();
		expect(modules).toEqual(['src/a.ts', 'src/b.ts']);
	});

	test('contention ranks modules by count descending, lexicographic tie-break', () => {
		// 1.1↔1.2 conflict on src/hot.ts (high contention).
		// 1.3↔1.4 conflict on src/cold.ts (low contention).
		// 1.5↔1.6 also conflict on src/hot.ts.
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/hot.ts'] },
			{ id: '1.2', scope: ['src/hot.ts'] },
			{ id: '1.3', scope: ['src/cold.ts'] },
			{ id: '1.4', scope: ['src/cold.ts'] },
			{ id: '1.5', scope: ['src/hot.ts'] },
			{ id: '1.6', scope: ['src/hot.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		// hot.ts pairs: (1.1,1.2), (1.1,1.5), (1.1,1.6), (1.2,1.5), (1.2,1.6), (1.5,1.6) → 6.
		// cold.ts pairs: (1.3,1.4) → 1.
		expect(r.perModule[0].module).toBe('src/hot.ts');
		expect(r.perModule[0].conflicts).toBe(6);
		expect(r.perModule[1].module).toBe('src/cold.ts');
		expect(r.perModule[1].conflicts).toBe(1);
	});

	test('share denominators sum sensibly even when a pair attributes multiple modules', () => {
		// Two tasks, cochange-only conflict on (a, b) → both files credited.
		// Share for each: 1 / 1 conflict = 1.0 (each module appears in 100% of conflicts).
		// This is intentional: a 50%-50% normalization would obscure that BOTH
		// modules drove the same conflict.
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/b.ts'] },
		];
		const pairs = [entry('src/a.ts', 'src/b.ts', 0.9)];
		const r = computeCouplingReport(tasks, pairs, THRESHOLD);
		for (const m of r.perModule) expect(m.share).toBe(1);
	});
});

describe('computeCouplingReport — roadmap', () => {
	test('truncates to roadmapTop (default 5)', () => {
		// 7 distinct conflict modules with one conflict each.
		const tasks: CouplingTask[] = [];
		for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
			tasks.push({ id: `${f}1`, scope: [`src/${f}.ts`] });
			tasks.push({ id: `${f}2`, scope: [`src/${f}.ts`] });
		}
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.perModule.length).toBe(7);
		expect(r.roadmap.length).toBe(5);
	});

	test('respects custom roadmapTop', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/a.ts'] },
			{ id: '1.3', scope: ['src/b.ts'] },
			{ id: '1.4', scope: ['src/b.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD, { roadmapTop: 1 });
		expect(r.roadmap.length).toBe(1);
	});

	test('roadmap entries name the module and its share', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/auth.ts'] },
			{ id: '1.2', scope: ['src/auth.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		expect(r.roadmap[0]).toContain('src/auth.ts');
		expect(r.roadmap[0]).toMatch(/\d+%/);
		// Phrasing avoids "drives X% of detected coupling" (which can read as a
		// share-of-total, but pairs may attribute both endpoints so coverages
		// can sum past 100%). The chosen phrasing is literal: it's the share
		// of conflicting pairs this module appears in.
		expect(r.roadmap[0]).toContain('appears in');
		expect(r.roadmap[0]).toContain('conflicting pairs');
	});
});

describe('formatCouplingReportMarkdown — output structure', () => {
	test('empty plan returns a "no tasks" message', () => {
		const r = computeCouplingReport([], [], THRESHOLD);
		const md = formatCouplingReportMarkdown(r);
		expect(md).toContain('## Coupling Report');
		expect(md).toContain('No tasks to analyze');
	});

	test('single task returns an "at least two needed" message', () => {
		const r = computeCouplingReport(
			[{ id: '1.1', scope: ['src/a.ts'] }],
			[],
			THRESHOLD,
		);
		const md = formatCouplingReportMarkdown(r);
		expect(md).toContain('at least two tasks');
	});

	test('full report includes p, per-module table, roadmap, conflict-pairs table', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/a.ts'] },
			{ id: '1.3', scope: ['src/b.ts'] },
		];
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		const md = formatCouplingReportMarkdown(r);
		expect(md).toContain('## Coupling Report');
		expect(md).toContain('**p = ');
		expect(md).toContain('### Per-module contention');
		expect(md).toContain('### Decoupling roadmap');
		expect(md).toContain('### Conflicting task pairs');
		expect(md).toContain('src/a.ts');
		expect(md).toContain('1.1');
		expect(md).toContain('1.2');
		// Renamed column header + sum-past-100% disclosure.
		expect(md).toContain('Pair coverage');
		expect(md).toContain('can sum past 100%');
	});

	test('small p value does not collapse to 0.0% in markdown', () => {
		// 1 conflict over 50 tasks → 1/(50*49/2)=1/1225 ≈ 0.0008 → 0.08% with .toFixed(2).
		const tasks: CouplingTask[] = Array.from({ length: 50 }, (_, i) => ({
			id: `t${i}`,
			scope: i < 2 ? ['src/shared.ts'] : [`src/file-${i}.ts`],
		}));
		const r = computeCouplingReport(tasks, [], THRESHOLD);
		const md = formatCouplingReportMarkdown(r);
		// 0.08% (the .toFixed(2) rendering) should appear, not 0.0%.
		expect(md).toContain('0.08%');
		expect(md).not.toContain('— 0.0%');
	});

	test('estimate disclaimer present per brief §4.2 ("estimates not facts")', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/a.ts'] },
		];
		const md = formatCouplingReportMarkdown(
			computeCouplingReport(tasks, [], THRESHOLD),
		);
		expect(md.toLowerCase()).toContain('estimat');
	});
});

describe('computeCouplingReport — conflictingPairs evidence', () => {
	test('records reason and evidence counts for each conflicting pair', () => {
		const tasks: CouplingTask[] = [
			{ id: '1.1', scope: ['src/a.ts'] },
			{ id: '1.2', scope: ['src/b.ts'] },
		];
		const pairs = [entry('src/a.ts', 'src/b.ts', 0.9)];
		const r = computeCouplingReport(tasks, pairs, THRESHOLD);
		expect(r.conflictingPairs).toHaveLength(1);
		const cp = r.conflictingPairs[0];
		expect(cp.reason).toBe('cochange');
		expect(cp.cochangeMatches).toBe(1);
		expect(cp.pathMatches).toBe(0);
		expect(cp.a).toBe('1.1');
		expect(cp.b).toBe('1.2');
	});
});

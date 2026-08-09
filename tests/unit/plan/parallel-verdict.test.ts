import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeParallelVerdict,
	isProvablyDisjoint,
	MAX_PARALLEL_VERDICT_TASKS,
} from '../../../src/plan/parallel-verdict.js';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer.js';

let tempDir: string;
let scopesDir: string;

function writeScope(taskId: string, files: string[]): void {
	const scopeFile = {
		version: 1,
		taskId,
		files,
		declaredAt: 1,
		expiresAt: Number.MAX_SAFE_INTEGER,
	};
	fs.writeFileSync(
		path.join(scopesDir, `scope-${taskId}.json`),
		JSON.stringify(scopeFile),
		'utf-8',
	);
}

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-verdict-test-'));
	scopesDir = path.join(tempDir, '.swarm', 'scopes');
	fs.mkdirSync(scopesDir, { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('computeParallelVerdict — verdict classification', () => {
	test('two disjoint-scope tasks → all_disjoint with empty pairs', () => {
		writeScope('1.1', ['src/auth.ts']);
		writeScope('1.2', ['src/db.ts']);

		const result = computeParallelVerdict(tempDir, ['1.1', '1.2']);

		expect(result.verdict).toBe('all_disjoint');
		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0]).toEqual({
			a: '1.1',
			b: '1.2',
			verdict: 'disjoint',
			evidence: [],
		});
		expect(result.unknownScopeTasks).toEqual([]);
	});

	test('two overlapping-scope tasks → conflicts_present with path evidence', () => {
		writeScope('2.1', ['src/auth.ts', 'src/login.ts']);
		writeScope('2.2', ['src/login.ts', 'src/session.ts']);

		const result = computeParallelVerdict(tempDir, ['2.1', '2.2']);

		expect(result.verdict).toBe('conflicts_present');
		expect(result.pairs).toHaveLength(1);
		expect(result.pairs[0].verdict).toBe('conflict');
		expect(result.pairs[0].evidence.length).toBeGreaterThan(0);
		expect(
			result.pairs[0].evidence.some((e) => e.includes('src/login.ts')),
		).toBe(true);
	});

	test('parent/child directory overlap is detected as conflict', () => {
		writeScope('3.1', ['src/auth/']); // directory prefix
		writeScope('3.2', ['src/auth/login.ts']); // child file

		const result = computeParallelVerdict(tempDir, ['3.1', '3.2']);

		expect(result.verdict).toBe('conflicts_present');
		expect(result.pairs[0].verdict).toBe('conflict');
	});

	test('one task with no scope file → unknown_scopes, pair is unknown', () => {
		writeScope('4.1', ['src/a.ts']);
		// 4.2 has no scope file

		const result = computeParallelVerdict(tempDir, ['4.1', '4.2']);

		expect(result.verdict).toBe('unknown_scopes');
		expect(result.unknownScopeTasks).toEqual(['4.2']);
		expect(result.pairs[0].verdict).toBe('unknown');
	});

	test('empty declared scope treated as unknown', () => {
		writeScope('5.1', ['src/a.ts']);
		writeScope('5.2', []); // empty scope

		const result = computeParallelVerdict(tempDir, ['5.1', '5.2']);

		expect(result.verdict).toBe('unknown_scopes');
		expect(result.unknownScopeTasks).toEqual(['5.2']);
	});

	test('malformed scope file → fail-closed unknown', () => {
		writeScope('6.1', ['src/a.ts']);
		fs.writeFileSync(
			path.join(scopesDir, 'scope-6.2.json'),
			'not valid json {',
			'utf-8',
		);

		const result = computeParallelVerdict(tempDir, ['6.1', '6.2']);

		expect(result.verdict).toBe('unknown_scopes');
		expect(result.unknownScopeTasks).toEqual(['6.2']);
	});

	test('F-004/F-007: stale or unsafe scope records fail closed', () => {
		writeScope('6.3', ['src/a.ts']);
		fs.writeFileSync(
			path.join(scopesDir, 'scope-6.4.json'),
			JSON.stringify({
				version: 1,
				taskId: 'wrong',
				declaredAt: 0,
				expiresAt: 1,
				files: ['src/b.ts'],
			}),
		);
		expect(computeParallelVerdict(tempDir, ['6.3', '6.4']).verdict).toBe(
			'unknown_scopes',
		);
		expect(
			computeParallelVerdict(tempDir, ['6.3', 'x/../../../victim']).verdict,
		).toBe('unknown_scopes');
	});

	test('F-005: oversized input is rejected before pairwise work', () => {
		const ids = Array.from(
			{ length: MAX_PARALLEL_VERDICT_TASKS + 1 },
			(_, index) => `oversized-${index}`,
		);
		expect(() => computeParallelVerdict(tempDir, ids)).toThrow(RangeError);
	});
});

describe('computeParallelVerdict — three-task matrices', () => {
	test('three mixed tasks → correct matrix', () => {
		// 7.1 disjoint from 7.2; 7.2 conflicts with 7.3; 7.1 disjoint from 7.3
		writeScope('7.1', ['src/a.ts']);
		writeScope('7.2', ['src/b.ts', 'src/shared.ts']);
		writeScope('7.3', ['src/shared.ts', 'src/c.ts']);

		const result = computeParallelVerdict(tempDir, ['7.1', '7.2', '7.3']);

		expect(result.verdict).toBe('conflicts_present');
		expect(result.pairs).toHaveLength(3);
		const pairMap = new Map(
			result.pairs.map((p) => [`${p.a}-${p.b}`, p.verdict]),
		);
		expect(pairMap.get('7.1-7.2')).toBe('disjoint');
		expect(pairMap.get('7.1-7.3')).toBe('disjoint');
		expect(pairMap.get('7.2-7.3')).toBe('conflict');
	});

	test('three fully disjoint tasks → all_disjoint', () => {
		writeScope('8.1', ['src/a.ts']);
		writeScope('8.2', ['src/b.ts']);
		writeScope('8.3', ['src/c.ts']);

		const result = computeParallelVerdict(tempDir, ['8.1', '8.2', '8.3']);

		expect(result.verdict).toBe('all_disjoint');
		expect(result.pairs.every((p) => p.verdict === 'disjoint')).toBe(true);
	});

	test('suggestedSerialOrder is a valid topological order for conflicting graph', () => {
		// 9.1 conflicts with 9.2; chain 9.1 → 9.2; 9.3 disjoint from both.
		writeScope('9.1', ['src/shared.ts']);
		writeScope('9.2', ['src/shared.ts', 'src/other.ts']);
		writeScope('9.3', ['src/c.ts']);

		const result = computeParallelVerdict(tempDir, ['9.1', '9.2', '9.3']);

		expect(result.verdict).toBe('conflicts_present');
		// Input order is the tie-break; with one edge 9.1→9.2, 9.1 must precede 9.2.
		const order = result.suggestedSerialOrder;
		expect(order).toContain('9.1');
		expect(order).toContain('9.2');
		expect(order).toContain('9.3');
		expect(order.indexOf('9.1')).toBeLessThan(order.indexOf('9.2'));
	});

	test('suggestedSerialOrder preserves input order when no conflicts', () => {
		writeScope('10.1', ['src/a.ts']);
		writeScope('10.2', ['src/b.ts']);
		writeScope('10.3', ['src/c.ts']);

		const result = computeParallelVerdict(tempDir, ['10.1', '10.2', '10.3']);

		expect(result.suggestedSerialOrder).toEqual(['10.1', '10.2', '10.3']);
	});
});

describe('computeParallelVerdict — co-change signal', () => {
	test('useCochange with supplied pairs adds co-change evidence on coupled tasks', () => {
		// Two tasks with disjoint PATHS but whose files are git co-change coupled.
		writeScope('11.1', ['src/api.ts']);
		writeScope('11.2', ['src/api-handler.ts']);

		const cochangePairs: CoChangeEntry[] = [
			{
				fileA: 'src/api.ts',
				fileB: 'src/api-handler.ts',
				coChangeCount: 10,
				npmi: 0.5,
				lift: 2.0,
				hasStaticEdge: false,
				totalCommits: 20,
				commitsA: 15,
				commitsB: 12,
			},
		];

		const result = computeParallelVerdict(tempDir, ['11.1', '11.2'], {
			useCochange: true,
			cochangePairs,
		});

		expect(result.verdict).toBe('conflicts_present');
		expect(result.pairs[0].verdict).toBe('conflict');
		expect(result.pairs[0].evidence.some((e) => e.includes('co-change'))).toBe(
			true,
		);
	});

	test('co-change disabled by default — disjoint paths stay disjoint', () => {
		writeScope('12.1', ['src/api.ts']);
		writeScope('12.2', ['src/api-handler.ts']);

		// Same co-change pair supplied but useCochange not set.
		const cochangePairs: CoChangeEntry[] = [
			{
				fileA: 'src/api.ts',
				fileB: 'src/api-handler.ts',
				coChangeCount: 10,
				npmi: 0.5,
				lift: 2.0,
				hasStaticEdge: false,
				totalCommits: 20,
				commitsA: 15,
				commitsB: 12,
			},
		];

		const result = computeParallelVerdict(tempDir, ['12.1', '12.2'], {
			cochangePairs,
		});

		expect(result.verdict).toBe('all_disjoint');
	});
});

describe('computeParallelVerdict — read-only guarantee', () => {
	test('writes nothing under .swarm/ or the source tree', () => {
		writeScope('13.1', ['src/a.ts']);
		writeScope('13.2', ['src/b.ts']);

		// Snapshot the entire tempDir tree before.
		const before = walkTree(tempDir);
		computeParallelVerdict(tempDir, ['13.1', '13.2']);
		const after = walkTree(tempDir);

		expect(after).toEqual(before);
	});
});

describe('isProvablyDisjoint', () => {
	test('true for ≥2 disjoint tasks', () => {
		writeScope('14.1', ['src/a.ts']);
		writeScope('14.2', ['src/b.ts']);
		expect(isProvablyDisjoint(tempDir, ['14.1', '14.2'])).toBe(true);
	});

	test('false for overlapping tasks', () => {
		writeScope('15.1', ['src/shared.ts']);
		writeScope('15.2', ['src/shared.ts']);
		expect(isProvablyDisjoint(tempDir, ['15.1', '15.2'])).toBe(false);
	});

	test('false when any task has unknown scope', () => {
		writeScope('16.1', ['src/a.ts']);
		// 16.2 missing
		expect(isProvablyDisjoint(tempDir, ['16.1', '16.2'])).toBe(false);
	});

	test('false for fewer than 2 tasks', () => {
		writeScope('17.1', ['src/a.ts']);
		expect(isProvablyDisjoint(tempDir, ['17.1'])).toBe(false);
		expect(isProvablyDisjoint(tempDir, [])).toBe(false);
	});
});

/** Recursively collect all relative file paths + mtimes under root. */
function walkTree(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const full = path.join(cur, e.name);
			if (e.isDirectory()) {
				stack.push(full);
			} else {
				out.push(path.relative(root, full));
			}
		}
	}
	return out.sort();
}

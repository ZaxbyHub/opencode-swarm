/**
 * Epic v2 C4 — `computeParallelVerdict`'s explicit `scopes` option (an epic
 * wave's FROZEN declared scopes):
 *   - present ⇒ scopes come ONLY from the map: live bindings are never
 *     consulted (no fallback), the plan is not needed, a missing or empty
 *     entry is `unknown` (fail closed);
 *   - absent ⇒ behaviour is unchanged (live v2 bindings, #2532).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema.js';
import { computeParallelVerdict } from '../../../src/plan/parallel-verdict.js';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer.js';
import { executeDeclareScope } from '../../../src/tools/declare-scope.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tempDir: string;

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Scopes Option Plan',
		swarm: 'scopes-option',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [1, 2].map((n) => ({
					id: `1.${n}`,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `Task 1.${n}`,
					depends: [],
					files_touched: [],
				})),
			},
		],
	};
}

async function declare(taskId: string, files: string[]): Promise<void> {
	const result = await executeDeclareScope(
		{ taskId, files, working_directory: tempDir },
		tempDir,
		{ sessionID: 'scopes-option-architect', messageID: `m-${taskId}` },
	);
	expect(result.success).toBe(true);
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('verdict-scopes-');
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function writePlan(): void {
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify(plan(), null, 2),
	);
}

describe('scopes present: the map is the only source', () => {
	test('no plan, no .swarm at all: disjoint scopes ⇒ all_disjoint, nothing written', () => {
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2'], {
			scopes: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
		});
		expect(verdict).toEqual({
			verdict: 'all_disjoint',
			pairs: [{ a: '1.1', b: '1.2', verdict: 'disjoint', evidence: [] }],
			suggestedSerialOrder: ['1.1', '1.2'],
			unknownScopeTasks: [],
		});
		expect(fs.existsSync(path.join(tempDir, '.swarm'))).toBe(false);
	});

	test('a corrupt plan.json is never read', () => {
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, '.swarm', 'plan.json'), '{not json');
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], {
				scopes: { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] },
			}).verdict,
		).toBe('all_disjoint');
	});

	test('live disjoint bindings never fill a missing or empty entry (no fallback)', async () => {
		writePlan();
		await declare('1.1', ['src/a.ts']);
		await declare('1.2', ['src/b.ts']);
		// Control: without the option the live bindings certify disjointness.
		expect(computeParallelVerdict(tempDir, ['1.1', '1.2']).verdict).toBe(
			'all_disjoint',
		);
		const missing = computeParallelVerdict(tempDir, ['1.1', '1.2'], {
			plan: plan(),
			scopes: { '1.1': ['src/a.ts'] },
		});
		expect(missing.verdict).toBe('unknown_scopes');
		expect(missing.unknownScopeTasks).toEqual(['1.2']);
		const empty = computeParallelVerdict(tempDir, ['1.1', '1.2'], {
			scopes: { '1.1': [], '1.2': [] },
		});
		expect(empty.verdict).toBe('unknown_scopes');
		expect(empty.unknownScopeTasks).toEqual(['1.1', '1.2']);
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], { scopes: {} })
				.unknownScopeTasks,
		).toEqual(['1.1', '1.2']);
	});

	test('frozen overlapping scopes win over live disjoint bindings', async () => {
		writePlan();
		await declare('1.1', ['src/a.ts']);
		await declare('1.2', ['src/b.ts']);
		const verdict = computeParallelVerdict(tempDir, ['1.1', '1.2'], {
			scopes: { '1.1': ['src/shared.ts'], '1.2': ['src/shared.ts'] },
		});
		expect(verdict.verdict).toBe('conflicts_present');
		expect(verdict.pairs[0].evidence).toEqual([
			'path overlap: src/shared.ts ↔ src/shared.ts',
		]);
	});

	test('inherited keys are not scopes', () => {
		const scopes = Object.create({ '1.2': ['src/b.ts'] }) as Record<
			string,
			string[]
		>;
		scopes['1.1'] = ['src/a.ts'];
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], { scopes })
				.unknownScopeTasks,
		).toEqual(['1.2']);
	});

	test('co-change signal applies to explicit scopes too', () => {
		const pair: CoChangeEntry = {
			fileA: 'src/a.ts',
			fileB: 'src/b.ts',
			coChangeCount: 9,
			npmi: 0.9,
			lift: 0,
			hasStaticEdge: false,
			totalCommits: 0,
			commitsA: 0,
			commitsB: 0,
		};
		const scopes = { '1.1': ['src/a.ts'], '1.2': ['src/b.ts'] };
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], {
				scopes,
				useCochange: true,
				cochangePairs: [pair],
				cochangeThreshold: { npmi: 0.5, minCoChanges: 3 },
			}).verdict,
		).toBe('conflicts_present');
		// Below threshold ⇒ disjoint.
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], {
				scopes,
				useCochange: true,
				cochangePairs: [pair],
				cochangeThreshold: { npmi: 0.95, minCoChanges: 3 },
			}).verdict,
		).toBe('all_disjoint');
	});

	test('the 64-task cap still applies before anything is read', () => {
		const ids = Array.from({ length: 65 }, (_, i) => `1.${i + 1}`);
		expect(() => computeParallelVerdict(tempDir, ids, { scopes: {} })).toThrow(
			RangeError,
		);
	});
});

describe('scopes absent: unchanged', () => {
	test('undefined option field is the bindings path', async () => {
		writePlan();
		await declare('1.1', ['src/a.ts']);
		const base = computeParallelVerdict(tempDir, ['1.1', '1.2']);
		expect(base.verdict).toBe('unknown_scopes');
		expect(base.unknownScopeTasks).toEqual(['1.2']);
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], { scopes: undefined }),
		).toEqual(base);
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2'], { plan: plan() }),
		).toEqual(base);
	});

	test('no plan on disk and no option ⇒ every task unknown (fail closed)', () => {
		expect(
			computeParallelVerdict(tempDir, ['1.1', '1.2']).unknownScopeTasks,
		).toEqual(['1.1', '1.2']);
	});
});

/**
 * Epic v2 C5 — the conflict graph computes co-change edges through a pair
 * index (pairs indexed by file once; per task the pair sides it owns
 * exclusively) instead of calling `epicPairConflict` with every pair for
 * every task pair. Differential test: the graph's edge relation equals
 * `epicPairConflict(...).conflict` on random scopes and pairs (root-prefixed
 * paths, directories, pairs internal to one scope, self-pairs, duplicates,
 * thresholds). Plus a generous performance bound for a large phase.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../src/config/constants';
import { epicPairConflict } from '../../../src/epic/cochange-conflict';
import {
	buildEpicConflictGraph,
	type EpicCochangeSignal,
} from '../../../src/epic/components';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function entry(
	fileA: string,
	fileB: string,
	npmi: number,
	coChangeCount: number,
): CoChangeEntry {
	return {
		fileA,
		fileB,
		npmi,
		coChangeCount,
		lift: 0,
		hasStaticEdge: false,
		totalCommits: 0,
		commitsA: 0,
		commitsB: 0,
	};
}

const FILES = [
	'src/a.ts',
	'src/b.ts',
	'src/c.ts',
	'src/d/e.ts',
	'src/d/f.ts',
	'lib/a.ts',
	'a.ts',
	'e.ts',
	'src/d',
];

function graphFor(
	scopes: Record<string, string[]>,
	cochange: EpicCochangeSignal | null,
) {
	return buildEpicConflictGraph({
		directory: '/project',
		tasks: Object.keys(scopes).map((id) => ({
			id,
			description: id,
			status: 'pending' as const,
			depends: [],
		})),
		scopes,
		leanConfig: { ...DEFAULT_LEAN_TURBO_CONFIG },
		hotFiles: [],
		coWrites: null,
		cochange,
	});
}

describe('pair-index edges == epicPairConflict', () => {
	test('1000 random phases: identical edge relation', () => {
		for (let seed = 1; seed <= 1000; seed += 1) {
			const r = rng(seed);
			const pick = () => FILES[Math.floor(r() * FILES.length)];
			const scopes: Record<string, string[]> = {};
			const n = 2 + Math.floor(r() * 6);
			for (let i = 0; i < n; i += 1) {
				const files = new Set<string>();
				const count = 1 + Math.floor(r() * 3);
				for (let k = 0; k < count; k += 1) {
					const file = pick();
					files.add(r() < 0.2 ? `/project/${file}` : file);
				}
				scopes[`1.${i + 1}`] = [...files];
			}
			const pairs = Array.from({ length: Math.floor(r() * 8) }, () =>
				entry(pick(), pick(), r(), 1 + Math.floor(r() * 9)),
			);
			if (pairs.length > 0 && r() < 0.3) pairs.push({ ...pairs[0] });
			const cochange =
				r() < 0.85
					? { pairs, threshold: { npmi: r() * 0.8, minCoChanges: 3 } }
					: null;
			const graph = graphFor(scopes, cochange);
			const ids = [...graph.adjacency.keys()];
			for (let i = 0; i < ids.length; i += 1) {
				for (let j = i + 1; j < ids.length; j += 1) {
					const expected = epicPairConflict(
						scopes[ids[i]],
						scopes[ids[j]],
						cochange?.pairs ?? [],
						cochange?.threshold ?? { npmi: 1, minCoChanges: 1 },
					).conflict;
					expect({
						seed,
						pair: [ids[i], ids[j]],
						edge: graph.adjacency.get(ids[i])?.has(ids[j]),
					}).toEqual({ seed, pair: [ids[i], ids[j]], edge: expected });
				}
			}
		}
	});
});

describe('performance', () => {
	test('150 tasks × 5000 co-change pairs builds well under a second', () => {
		const r = rng(7);
		const files = Array.from({ length: 300 }, (_, i) => `src/m${i}/f${i}.ts`);
		const pick = () => files[Math.floor(r() * files.length)];
		const scopes: Record<string, string[]> = {};
		for (let i = 0; i < 150; i += 1) scopes[`1.${i + 1}`] = [pick(), pick()];
		const pairs = Array.from({ length: 5000 }, () =>
			entry(pick(), pick(), 0.9, 9),
		);
		const started = performance.now();
		const graph = graphFor(scopes, {
			pairs,
			threshold: { npmi: 0.6, minCoChanges: 5 },
		});
		const elapsed = performance.now() - started;
		expect(graph.adjacency.size).toBe(150);
		// Typically ~15 ms; the old per-pair scan took ~10 s.
		expect(elapsed).toBeLessThan(2000);
	});
});

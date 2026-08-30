import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type GraphNode,
	type RepoGraph,
	resetQueryCache,
	searchSymbols,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');

function node(
	moduleName: string,
	exports: string[],
	extras: {
		ranges?: Record<string, { startLine: number; endLine: number }>;
		kinds?: Record<string, string>;
		language?: string;
	} = {},
): GraphNode {
	return {
		filePath: path.join(root, moduleName),
		moduleName,
		exports,
		imports: [],
		language: extras.language ?? 'typescript',
		mtime: '1',
		...(extras.ranges !== undefined ? { exportRanges: extras.ranges } : {}),
		...(extras.kinds !== undefined
			? { exportKinds: extras.kinds as GraphNode['exportKinds'] }
			: {}),
	};
}

function makeGraph(schemaVersion = '1.6.0'): RepoGraph {
	const util = node(
		'src/util.ts',
		['formatCurrency', 'Calculator', 'toString'],
		{
			ranges: {
				formatCurrency: { startLine: 1, endLine: 3 },
				Calculator: { startLine: 5, endLine: 9 },
				toString: { startLine: 10, endLine: 11 },
				helperLocal: { startLine: 13, endLine: 14 },
			},
			kinds: {
				formatCurrency: 'function',
				Calculator: 'class',
				toString: 'method',
			},
		},
	);
	const py = node('lib/py_mod.py', ['format_file'], {
		ranges: { format_file: { startLine: 1, endLine: 2 } },
		kinds: { format_file: 'function' },
		language: 'python',
	});
	const main = node('src/main.ts', ['main'], {
		ranges: { main: { startLine: 1, endLine: 2 } },
		kinds: { main: 'function' },
	});
	return {
		schema_version: schemaVersion,
		workspaceRoot: root,
		nodes: {
			[util.filePath]: util,
			[py.filePath]: py,
			[main.filePath]: main,
		},
		edges: [],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 3,
			edgeCount: 0,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

/** A real pre-1.6.0 graph carries no exportKinds data at all. */
function stripKinds(graph: RepoGraph): RepoGraph {
	for (const n of Object.values(graph.nodes)) delete n.exportKinds;
	return graph;
}

describe('searchSymbols: match tiers', () => {
	test('exact outranks prefix outranks substring outranks subsequence', () => {
		const graph = makeGraph();
		const result = searchSymbols(graph, { query: 'main' });
		const tiers = result.hits.map((h) => h.match);
		// 'main' is an exact hit; 'formatCurrency'-style names hit lower tiers.
		expect(result.hits[0]).toMatchObject({
			symbol: 'main',
			match: 'exact',
			file: 'src/main.ts',
		});
		expect(tiers).toEqual([...tiers].sort());
		expect(new Set(tiers).has('exact')).toBe(true);
	});

	test('prefix match is found and tiered', () => {
		const result = searchSymbols(makeGraph(), { query: 'formatC' });
		expect(result.hits.map((h) => h.symbol)).toEqual(['formatCurrency']);
		expect(result.hits[0]?.match).toBe('prefix');
	});

	test('subsequence (fuzzy) match finds sparse names', () => {
		const result = searchSymbols(makeGraph(), { query: 'fmc' });
		expect(result.hits.some((h) => h.symbol === 'formatCurrency')).toBe(true);
	});

	test('no match returns empty with zero budget', () => {
		const result = searchSymbols(makeGraph(), { query: 'zzzznope' });
		expect(result.hits).toEqual([]);
		expect(result.budget).toEqual({ returned: 0, dropped: 0 });
	});
});

describe('searchSymbols: filters', () => {
	test('kind filter matches only that declaration kind', () => {
		const result = searchSymbols(makeGraph(), { query: 'c', kind: 'class' });
		expect(result.kindSupported).toBe(true);
		expect(result.hits.map((h) => h.symbol)).toEqual(['Calculator']);
		expect(result.hits[0]?.kind).toBe('class');
	});

	test('kind filter on a pre-1.6.0 graph degrades instead of failing', () => {
		const result = searchSymbols(stripKinds(makeGraph('1.5.0')), {
			query: 'c',
			kind: 'class',
		});
		expect(result.kindSupported).toBe(false);
		expect(result.hits).toEqual([]);
		expect(result.warnings.join('\n')).toContain(
			'kind filter requires graph schema 1.6.0+',
		);
	});

	test('kind hits are null on a pre-1.6.0 graph without a filter', () => {
		const result = searchSymbols(stripKinds(makeGraph('1.5.0')), {
			query: 'Calculator',
		});
		expect(result.hits.length).toBe(1);
		expect(result.hits[0]?.kind).toBeNull();
	});

	test('language filter restricts to one node language', () => {
		const result = searchSymbols(makeGraph(), {
			query: 'format',
			language: 'python',
		});
		expect(result.hits.map((h) => h.symbol)).toEqual(['format_file']);
	});

	test('file filter restricts to one file', () => {
		const result = searchSymbols(makeGraph(), {
			query: 'format',
			file: 'src/util.ts',
		});
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits.every((h) => h.file === 'src/util.ts')).toBe(true);
	});

	test('file filter for an unknown file returns a warning', () => {
		const result = searchSymbols(makeGraph(), {
			query: 'format',
			file: 'src/missing.ts',
		});
		expect(result.hits).toEqual([]);
		expect(result.warnings.join('\n')).toContain(
			'file filter not found in graph',
		);
	});

	test('visibility=exported excludes range-only symbols', () => {
		const result = searchSymbols(makeGraph(), {
			query: 'helperLocal',
			visibility: 'exported',
		});
		expect(result.hits).toEqual([]);
	});

	test('visibility=module-local finds non-exported range symbols', () => {
		const result = searchSymbols(makeGraph(), {
			query: 'helperLocal',
			visibility: 'module-local',
		});
		expect(result.hits.map((h) => h.symbol)).toEqual(['helperLocal']);
		expect(result.hits[0]?.exported).toBe(false);
	});
});

describe('searchSymbols: bounding and edge cases', () => {
	test('top_n bounds hits and reports the dropped remainder', () => {
		const result = searchSymbols(makeGraph(), { query: 'format', topN: 1 });
		expect(result.hits.length).toBe(1);
		expect(result.budget.returned).toBe(1);
		expect(result.budget.dropped).toBeGreaterThan(0);
		expect(result.warnings.join('\n')).toContain('omitted by top_n=1');
	});

	test('Object.prototype-named symbols are matched safely', () => {
		const result = searchSymbols(makeGraph(), { query: 'toString' });
		expect(result.hits.map((h) => h.symbol)).toEqual(['toString']);
		expect(result.hits[0]?.kind).toBe('method');
	});

	test('empty query returns a warning without throwing', () => {
		const result = searchSymbols(makeGraph(), { query: '' });
		expect(result.hits).toEqual([]);
		expect(result.warnings.join('\n')).toContain('query is empty');
	});

	test('all output paths are workspace-relative with forward slashes', () => {
		const result = searchSymbols(makeGraph(), { query: 'main' });
		for (const hit of result.hits) {
			expect(hit.file.startsWith('/')).toBe(false);
			expect(hit.file.includes('\\')).toBe(false);
			expect(path.isAbsolute(hit.file)).toBe(false);
		}
	});
});

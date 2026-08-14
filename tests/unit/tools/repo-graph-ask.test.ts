import { describe, expect, test } from 'bun:test';
import {
	_askInternals,
	askGraph,
	type RepoGraph,
} from '../../../src/tools/repo-graph';

const {
	tokenize,
	splitCompound,
	expandTerms,
	buildVocabulary,
	personalizedPageRank,
	buildUndirectedAdjacency,
} = _askInternals;

function makeGraph(
	nodeSpecs: {
		key: string;
		moduleName: string;
		exports?: string[];
		imports?: string[];
		roles?: string[];
		boundary?: string;
	}[],
	edges: { source: string; target: string }[] = [],
): RepoGraph {
	const nodes: Record<string, any> = {};
	for (const spec of nodeSpecs) {
		nodes[spec.key] = {
			filePath: spec.key,
			moduleName: spec.moduleName,
			exports: spec.exports ?? [],
			imports: spec.imports ?? [],
			language: 'typescript',
			mtime: '2024-01-01T00:00:00Z',
			ontology: {
				roles: spec.roles ?? ['source_module'],
				routes: [],
				dataOperations: [],
				findings: [],
				security: [],
				conventions: [],
				packageBoundary: spec.boundary,
			},
		};
	}
	return {
		schema_version: '1.4.0',
		workspaceRoot: '/workspace',
		nodes,
		edges: edges.map((e) => ({
			source: e.source,
			target: e.target,
			importSpecifier: './target',
			importType: 'static' as const,
		})),
		metadata: {
			generatedAt: '2024-01-01T00:00:00Z',
			generator: 'test',
			nodeCount: nodeSpecs.length,
			edgeCount: edges.length,
		},
	};
}

describe('tokenize', () => {
	test('splits and lowercases', () => {
		const tokens = tokenize('Where is the GraphBuilder stored');
		expect(tokens).toContain('where');
		expect(tokens).toContain('graph');
		expect(tokens).toContain('builder');
		expect(tokens).toContain('graphbuilder');
		expect(tokens).toContain('stored');
	});

	test('splits snake_case', () => {
		const tokens = tokenize('find_user_by_id');
		expect(tokens).toContain('find');
		expect(tokens).toContain('user');
	});
});

describe('splitCompound', () => {
	test('camelCase', () => {
		expect(splitCompound('getKeyFiles')).toContain('get');
		expect(splitCompound('getKeyFiles')).toContain('Key');
		expect(splitCompound('getKeyFiles')).toContain('Files');
	});

	test('snake_case', () => {
		expect(splitCompound('get_key_files')).toContain('get');
		expect(splitCompound('get_key_files')).toContain('key');
		expect(splitCompound('get_key_files')).toContain('files');
	});
});

describe('expandTerms', () => {
	test('filters to vocabulary', () => {
		const vocab = new Set(['storage', 'graph', 'builder', 'cache']);
		const result = expandTerms(['storage', 'nosuch', 'graph'], vocab);
		expect(result).toContain('storage');
		expect(result).toContain('graph');
		expect(result).not.toContain('nosuch');
	});
});

describe('personalizedPageRank', () => {
	test('converges on a small graph', () => {
		const keys = ['a', 'b', 'c'];
		const adj = new Map<string, Set<string>>([
			['a', new Set(['b'])],
			['b', new Set(['a', 'c'])],
			['c', new Set(['b'])],
		]);
		const restart = new Map([
			['a', 1],
			['b', 0],
			['c', 0],
		]);
		const scores = personalizedPageRank(adj, restart, keys);
		expect(scores.get('a')!).toBeGreaterThan(scores.get('c')!);
	});
});

describe('askGraph', () => {
	const graph = makeGraph(
		[
			{
				key: '/workspace/src/storage.ts',
				moduleName: 'src/storage.ts',
				exports: ['saveGraph', 'loadGraph'],
				imports: ['./types'],
				boundary: 'src/tools/repo-graph',
			},
			{
				key: '/workspace/src/builder.ts',
				moduleName: 'src/builder.ts',
				exports: ['buildWorkspaceGraph', 'isAssetEdge'],
				imports: ['./storage', './types'],
				boundary: 'src/tools/repo-graph',
			},
			{
				key: '/workspace/src/types.ts',
				moduleName: 'src/types.ts',
				exports: ['RepoGraph', 'GraphNode', 'GraphEdge'],
				imports: [],
				boundary: 'src/tools/repo-graph',
			},
			{
				key: '/workspace/src/cache.ts',
				moduleName: 'src/cache.ts',
				exports: ['getCachedGraph', 'setCachedGraph'],
				imports: ['./types'],
				boundary: 'src/tools/repo-graph',
			},
			{
				key: '/workspace/tests/storage.test.ts',
				moduleName: 'tests/storage.test.ts',
				exports: [],
				imports: ['../src/storage'],
				roles: ['test_file'],
			},
		],
		[
			{
				source: '/workspace/src/builder.ts',
				target: '/workspace/src/storage.ts',
			},
			{
				source: '/workspace/src/builder.ts',
				target: '/workspace/src/types.ts',
			},
			{
				source: '/workspace/src/storage.ts',
				target: '/workspace/src/types.ts',
			},
			{ source: '/workspace/src/cache.ts', target: '/workspace/src/types.ts' },
			{
				source: '/workspace/tests/storage.test.ts',
				target: '/workspace/src/storage.ts',
			},
		],
	);

	test('determinism: same graph same output', () => {
		const a = askGraph(graph, 'where is the graph saved atomically');
		const b = askGraph(graph, 'where is the graph saved atomically');
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	test('ranks storage.ts in top 3 for save question', () => {
		const result = askGraph(graph, 'where is the graph saved');
		expect(result.hits.length).toBeGreaterThan(0);
		const top3 = result.hits.slice(0, 3).map((h) => h.file);
		expect(top3).toContain('src/storage.ts');
	});

	test('rare term outranks common term (IDF)', () => {
		const result = askGraph(graph, 'isAssetEdge');
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits[0].file).toBe('src/builder.ts');
	});

	test('test files are de-ranked', () => {
		const result = askGraph(graph, 'storage');
		const storageIdx = result.hits.findIndex(
			(h) => h.file === 'src/storage.ts',
		);
		const testIdx = result.hits.findIndex(
			(h) => h.file === 'tests/storage.test.ts',
		);
		if (testIdx >= 0) {
			expect(storageIdx).toBeLessThan(testIdx);
		}
	});

	test('empty question returns empty hits', () => {
		const result = askGraph(graph, '');
		expect(result.hits).toEqual([]);
		expect(result.budget.returned).toBe(0);
	});

	test('no-match question returns empty hits', () => {
		const result = askGraph(graph, 'xyzzy frobnicator');
		expect(result.hits).toEqual([]);
	});

	test('budget counts are correct', () => {
		const result = askGraph(graph, 'types graph node', { topN: 2 });
		expect(result.budget.requested).toBe(2);
		expect(result.budget.returned).toBeLessThanOrEqual(2);
		if (result.budget.returned === 2) {
			expect(result.budget.dropped).toBeGreaterThanOrEqual(0);
		}
	});

	test('top_n is clamped to 25', () => {
		const result = askGraph(graph, 'graph', { topN: 100 });
		expect(result.budget.requested).toBe(25);
	});

	test('hits include community and role', () => {
		const result = askGraph(graph, 'storage');
		for (const hit of result.hits) {
			expect(typeof hit.community).toBe('string');
			expect(typeof hit.role).toBe('string');
			expect(hit.community.length).toBeGreaterThan(0);
		}
	});

	test('expandedTerms populated', () => {
		const result = askGraph(graph, 'saveGraph builder');
		expect(result.expandedTerms.length).toBeGreaterThan(0);
	});

	test('asset edges excluded from adjacency', () => {
		const assetGraph = makeGraph(
			[
				{
					key: '/workspace/src/app.ts',
					moduleName: 'src/app.ts',
					exports: ['App'],
				},
				{
					key: '/workspace/src/data.json',
					moduleName: 'src/data.json',
					exports: [],
				},
			],
			[{ source: '/workspace/src/app.ts', target: '/workspace/src/data.json' }],
		);
		(assetGraph.edges[0] as any).targetKind = 'asset';
		const keys = Object.keys(assetGraph.nodes).sort();
		const adj = buildUndirectedAdjacency(assetGraph, keys);
		expect(adj.get('/workspace/src/app.ts')!.size).toBe(0);
	});
});

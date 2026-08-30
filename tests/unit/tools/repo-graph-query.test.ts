import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	buildOntologyPreflightPacket,
	type ContextPackResult,
	type ContextPackSpan,
	type GraphNode,
	getBlastRadius,
	getContextPack,
	getDependencies,
	getGraphNode,
	getImporters,
	getPackageBoundaries,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
	type SymbolEdge,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');

function node(moduleName: string, exports: string[] = []): GraphNode {
	return {
		filePath: path.join(root, moduleName),
		moduleName,
		exports,
		imports: [],
		language: 'typescript',
		mtime: '1',
		ontology: {
			roles: ['source_module'],
			packageBoundary: moduleName.startsWith('app/')
				? 'app'
				: moduleName.split('/')[0],
			routes: [],
			dataOperations: [],
			security: [],
			conventions: [],
			findings: [],
		},
	};
}

function makeGraph(): RepoGraph {
	const app = node('app/api/route.ts', ['POST']);
	const data = node('lib/data.ts', ['save']);
	const util = node('src/util.ts', ['format']);
	const controller = node('src/controller.ts', []);
	return {
		schema_version: '1.0.0',
		workspaceRoot: root,
		nodes: {
			[app.filePath]: app,
			[data.filePath]: data,
			[util.filePath]: util,
			[controller.filePath]: controller,
		},
		edges: [
			{
				source: app.filePath,
				target: data.filePath,
				importSpecifier: '../../../lib/data',
				importType: 'named',
				importedSymbols: ['save'],
			},
			{
				source: controller.filePath,
				target: util.filePath,
				importSpecifier: './util',
				importType: 'named',
				importedSymbols: ['format'],
			},
		],
		metadata: {
			generatedAt: new Date().toISOString(),
			generator: 'test',
			nodeCount: 4,
			edgeCount: 2,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('repo graph query API', () => {
	test('returns direct importers and dependencies through cached indexes', () => {
		const graph = makeGraph();

		expect(getImporters(graph, 'lib/data.ts')).toEqual([
			{ file: 'app/api/route.ts', importType: 'named' },
		]);
		expect(getDependencies(graph, 'app/api/route.ts')).toEqual([
			{ file: 'lib/data.ts', importType: 'named' },
		]);
	});

	test('resolves graph nodes by absolute and module-name inputs', () => {
		const graph = makeGraph();

		expect(getGraphNode(graph, 'app/api/route.ts')?.moduleName).toBe(
			'app/api/route.ts',
		);
		expect(
			getGraphNode(graph, path.join(root, 'app/api/route.ts'))?.moduleName,
		).toBe('app/api/route.ts');
	});

	test('computes package-boundary dependency relationships', () => {
		const graph = makeGraph();
		const boundaries = getPackageBoundaries(graph, 10);
		const app = boundaries.find((boundary) => boundary.name === 'app');
		const lib = boundaries.find((boundary) => boundary.name === 'lib');

		expect(app?.dependsOn).toEqual(['lib']);
		expect(lib?.dependedOnBy).toEqual(['app']);
	});

	test('preflight packet includes selected package-boundary dependencies (F-001)', () => {
		const graph = makeGraph();
		const packet = buildOntologyPreflightPacket(
			graph,
			['app/api/route.ts', 'lib/data.ts'],
			{ maxFiles: 2 },
		) as {
			packageBoundaries: Array<{
				name: string;
				dependsOn: string[];
				dependedOnBy: string[];
			}>;
		};
		const app = packet.packageBoundaries.find(
			(boundary) => boundary.name === 'app',
		);
		const lib = packet.packageBoundaries.find(
			(boundary) => boundary.name === 'lib',
		);

		expect(app?.dependsOn).toEqual(['lib']);
		expect(lib?.dependedOnBy).toEqual(['app']);
	});

	test('resetQueryCache refreshes indexes after in-place graph mutation', () => {
		const graph = makeGraph();
		expect(getDependencies(graph, 'lib/data.ts')).toEqual([]);

		const data = getGraphNode(graph, 'lib/data.ts');
		const util = getGraphNode(graph, 'src/util.ts');
		if (!data || !util) throw new Error('test graph is missing nodes');
		graph.edges.push({
			source: data.filePath,
			target: util.filePath,
			importSpecifier: '../src/util',
			importType: 'named',
			importedSymbols: ['format'],
		});

		expect(getDependencies(graph, 'lib/data.ts')).toEqual([]);
		resetQueryCache();
		expect(getDependencies(graph, 'lib/data.ts')).toEqual([
			{ file: 'src/util.ts', importType: 'named' },
		]);
	});

	test('returns empty query results for empty graphs', () => {
		const graph: RepoGraph = {
			schema_version: '1.0.0',
			workspaceRoot: root,
			nodes: {},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		expect(getImporters(graph, 'missing.ts')).toEqual([]);
		expect(getDependencies(graph, 'missing.ts')).toEqual([]);
		expect(getBlastRadius(graph, ['missing.ts'])).toEqual(
			expect.objectContaining({
				directDependents: [],
				transitiveDependents: [],
				totalDependents: 0,
				riskLevel: 'low',
			}),
		);
		expect(getPackageBoundaries(graph)).toEqual([]);
	});
});

describe('getContextPack', () => {
	// Helper: builds a minimal 1.2.0 graph with exportRanges and symbolEdges.
	// Uses path.posix.join so node keys are always forward-slash absolute paths
	// regardless of platform, matching the graph's absolute-key convention.
	function makeContextGraph(
		nodes: {
			[filePath: string]: {
				moduleName: string;
				exports: string[];
				exportRanges: Record<string, { startLine: number; endLine: number }>;
			};
		},
		symbolEdges: SymbolEdge[],
	): RepoGraph {
		const graphNodes: Record<string, GraphNode> = {};
		for (const [filePath, info] of Object.entries(nodes)) {
			// Store with normalized (forward-slash) keys matching the format the
			// builder uses (normalizeGraphPath) and what getGraphNode's
			// absoluteKeyForModule produces — ensures lookups work on all platforms.
			const normPath = normalizeGraphPath(path.join(root, filePath));
			graphNodes[normPath] = {
				filePath: normPath,
				moduleName: info.moduleName,
				exports: info.exports,
				exportRanges: info.exportRanges,
				imports: [],
				language: 'typescript',
				mtime: '1',
				ontology: {
					roles: ['source_module'],
					packageBoundary: 'lib',
					routes: [],
					dataOperations: [],
					security: [],
					conventions: [],
					findings: [],
				},
			};
		}
		return {
			schema_version: '1.2.0',
			workspaceRoot: root,
			nodes: graphNodes,
			edges: [],
			symbolEdges: symbolEdges.map((e) => ({
				...e,
				fromFile: normalizeGraphPath(path.join(root, e.fromFile)),
				toFile: normalizeGraphPath(path.join(root, e.toFile)),
			})),
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: Object.keys(nodes).length,
				edgeCount: 0,
			},
		};
	}

	test('happy path: target + one neighbor reachable via symbolEdge, both at full depth', () => {
		// Paths in graph.nodes and returned spans are normalized (forward-slash)
		// via normalizeGraphPath, matching the builder's storage convention.
		const aPath = normalizeGraphPath(path.join(root, 'a.ts'));
		const bPath = normalizeGraphPath(path.join(root, 'b.ts'));

		const graph = makeContextGraph(
			{
				// keys are relative module names; makeContextGraph normalizes them
				['a.ts']: {
					moduleName: 'a.ts',
					exports: ['foo'],
					exportRanges: { foo: { startLine: 1, endLine: 10 } },
				},
				['b.ts']: {
					moduleName: 'b.ts',
					exports: ['bar'],
					exportRanges: { bar: { startLine: 11, endLine: 20 } },
				},
			},
			[
				// b.bar calls a.foo (forward direction from b -> a)
				{
					fromFile: 'b.ts',
					fromSymbol: 'bar',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
				// a.foo is called by b.bar (reverse direction from a <- b)
				{
					fromFile: 'a.ts',
					fromSymbol: 'foo',
					toFile: 'b.ts',
					toSymbol: 'bar',
				},
			],
		);

		const result = getContextPack(graph, aPath, 'foo', {
			maxDepth: 2,
			maxTokens: 4000,
		});

		expect(result.schemaSupported).toBe(true);
		expect(result.target).toEqual({ file: aPath, symbol: 'foo' });
		expect(result.truncated).toBe(false);
		expect(result.estimatedTokens).toBeGreaterThan(0);

		// Spans are relevance-ordered: target first, then neighbors
		expect(result.spans).toHaveLength(2);
		expect(result.spans[0]).toMatchObject({
			file: aPath,
			symbol: 'foo',
			startLine: 1,
			endLine: 10,
			mode: 'full',
		});
		expect(result.spans[1]).toMatchObject({
			file: bPath,
			symbol: 'bar',
			startLine: 11,
			endLine: 20,
			mode: 'full',
		});
	});

	test('schema fallback: 1.1.0 graph with no symbolEdges or exportRanges', () => {
		const aPath = path.posix.join(root, 'a.ts');
		const graph: RepoGraph = {
			schema_version: '1.1.0',
			workspaceRoot: root,
			nodes: {
				[aPath]: {
					filePath: aPath,
					moduleName: 'a.ts',
					exports: ['foo'],
					imports: [],
					language: 'typescript',
					mtime: '1',
					ontology: {
						roles: ['source_module'],
						packageBoundary: 'lib',
						routes: [],
						dataOperations: [],
						security: [],
						conventions: [],
						findings: [],
					},
				},
			},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 1,
				edgeCount: 0,
			},
		};

		const result = getContextPack(graph, aPath, 'foo');
		expect(result.schemaSupported).toBe(false);
		expect(result.spans).toEqual([]);
		expect(result.truncated).toBe(false);
		expect(result.estimatedTokens).toBe(0);
		expect(result.note).toBe('rebuild with repo_map action="build"');
	});

	test('truncation: token budget cuts off peripheral spans but target is always included', () => {
		const aPath = normalizeGraphPath(path.join(root, 'a.ts'));
		const bPath = normalizeGraphPath(path.join(root, 'b.ts'));
		const cPath = normalizeGraphPath(path.join(root, 'c.ts'));

		// Each span is 10 lines = ~120 tokens (full mode, 12 tokens/line).
		// Target: 120 tokens. Each peripheral: 120 tokens.
		// maxTokens=250: target (120) fits + b (120) fits = 240. c (120) would exceed 250 → truncated.
		const graph = makeContextGraph(
			{
				['a.ts']: {
					moduleName: 'a.ts',
					exports: ['foo'],
					exportRanges: { foo: { startLine: 1, endLine: 10 } },
				},
				['b.ts']: {
					moduleName: 'b.ts',
					exports: ['bar'],
					exportRanges: { bar: { startLine: 11, endLine: 20 } },
				},
				['c.ts']: {
					moduleName: 'c.ts',
					exports: ['baz'],
					exportRanges: { baz: { startLine: 21, endLine: 30 } },
				},
			},
			[
				{
					fromFile: 'b.ts',
					fromSymbol: 'bar',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
				{
					fromFile: 'c.ts',
					fromSymbol: 'baz',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
			],
		);

		const result = getContextPack(graph, aPath, 'foo', {
			maxDepth: 2,
			maxTokens: 250,
		});

		expect(result.schemaSupported).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.spans).toHaveLength(2); // target + b; c is cut off
		// Target must always be present
		expect(result.spans[0]).toMatchObject({
			file: aPath,
			symbol: 'foo',
			mode: 'full',
		});
		// b is within budget, c is not
		expect(result.spans[1]).toMatchObject({ file: bPath, symbol: 'bar' });
		// c should not appear
		expect(result.spans.find((s) => s.file === cPath)).toBeUndefined();
	});

	test('maxDepth boundary: periphery symbols at depth==maxDepth get mode=signature, inner get mode=full', () => {
		const aPath = normalizeGraphPath(path.join(root, 'a.ts'));
		const bPath = normalizeGraphPath(path.join(root, 'b.ts'));
		const cPath = normalizeGraphPath(path.join(root, 'c.ts'));

		// b.bar is at depth 1 (full), c.baz is at depth 2 (signature, at maxDepth boundary)
		const graph = makeContextGraph(
			{
				['a.ts']: {
					moduleName: 'a.ts',
					exports: ['foo'],
					exportRanges: { foo: { startLine: 1, endLine: 10 } },
				},
				['b.ts']: {
					moduleName: 'b.ts',
					exports: ['bar'],
					exportRanges: { bar: { startLine: 11, endLine: 20 } },
				},
				['c.ts']: {
					moduleName: 'c.ts',
					exports: ['baz'],
					exportRanges: { baz: { startLine: 21, endLine: 30 } },
				},
			},
			[
				{
					fromFile: 'b.ts',
					fromSymbol: 'bar',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
				{
					fromFile: 'c.ts',
					fromSymbol: 'baz',
					toFile: 'b.ts',
					toSymbol: 'bar',
				},
			],
		);

		const result = getContextPack(graph, aPath, 'foo', {
			maxDepth: 2,
			maxTokens: 4000,
		});

		expect(result.schemaSupported).toBe(true);
		expect(result.spans).toHaveLength(3);

		const spanMap: Record<string, ContextPackSpan> = {};
		for (const s of result.spans) {
			spanMap[s.symbol] = s;
		}

		// Target at depth 0: full mode
		expect(spanMap['foo'].mode).toBe('full');
		// b.bar at depth 1 (< maxDepth=2): full mode
		expect(spanMap['bar'].mode).toBe('full');
		// c.baz at depth 2 (=== maxDepth): signature mode
		expect(spanMap['baz'].mode).toBe('signature');
	});

	// Regression: getContextPack must resolve a workspace-relative module path
	// (e.g. 'src/foo.ts') to the correct graph node — same resolution used by
	// getGraphNode/getCallers/getImporters.  Previously it passed the raw input
	// through normalizeGraphPath as the lookup key, which fails when the caller
	// supplies a relative path but graph.nodes keys are absolute.
	test('resolves relative module path input to correct node and spans (F-4.1)', () => {
		const aRel = 'a.ts';
		const bRel = 'b.ts';

		const graph = makeContextGraph(
			{
				[aRel]: {
					moduleName: 'a.ts',
					exports: ['foo'],
					exportRanges: { foo: { startLine: 1, endLine: 10 } },
				},
				[bRel]: {
					moduleName: 'b.ts',
					exports: ['bar'],
					exportRanges: { bar: { startLine: 11, endLine: 20 } },
				},
			},
			[
				{
					fromFile: 'b.ts',
					fromSymbol: 'bar',
					toFile: 'a.ts',
					toSymbol: 'foo',
				},
				{
					fromFile: 'a.ts',
					fromSymbol: 'foo',
					toFile: 'b.ts',
					toSymbol: 'bar',
				},
			],
		);

		// Pass a relative module path (no root prefix) — same style used by
		// getCallers/getImporters tests in this file.
		const result = getContextPack(graph, 'a.ts', 'foo', {
			maxDepth: 2,
			maxTokens: 4000,
		});

		expect(result.schemaSupported).toBe(true);
		// target.file must be the resolved absolute path (consistent with graph)
		expect(result.target.file).toBe(
			normalizeGraphPath(path.join(root, 'a.ts')),
		);
		expect(result.target.symbol).toBe('foo');
		expect(result.spans).toHaveLength(2);
		expect(result.spans[0]).toMatchObject({
			file: normalizeGraphPath(path.join(root, 'a.ts')),
			symbol: 'foo',
			mode: 'full',
		});
		expect(result.spans[1]).toMatchObject({
			file: normalizeGraphPath(path.join(root, 'b.ts')),
			symbol: 'bar',
			mode: 'full',
		});
	});
});

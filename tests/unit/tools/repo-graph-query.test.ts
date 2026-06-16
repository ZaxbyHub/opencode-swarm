import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	buildOntologyPreflightPacket,
	type GraphNode,
	getBlastRadius,
	getDependencies,
	getGraphNode,
	getImporters,
	getPackageBoundaries,
	type RepoGraph,
	resetQueryCache,
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

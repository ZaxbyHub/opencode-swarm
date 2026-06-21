/**
 * Tests for the schema 1.1.0 call-graph layer: per-edge `usedSymbols`, per-node
 * `exportLines`, and the `getCallers` / `getDeadExports` queries.
 *
 * Builder behavior is exercised against the real filesystem (so the regex
 * usage scan, alias handling, and sync/async parity are all covered). Query
 * edge cases (schema gate, role exclusions, namespace unresolvability) use
 * hand-constructed graphs for determinism.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import {
	buildWorkspaceGraph,
	buildWorkspaceGraphAsync,
	clearCache,
	type GraphNode,
	getCallers,
	getDeadExports,
	isSchemaVersionAtLeast,
	type RepoGraph,
	resetQueryCache,
} from '../../../src/tools/repo-graph';

describe('isSchemaVersionAtLeast', () => {
	test('compares dotted numeric versions', () => {
		expect(isSchemaVersionAtLeast('1.1.0', '1.1.0')).toBe(true);
		expect(isSchemaVersionAtLeast('1.2.0', '1.1.0')).toBe(true);
		expect(isSchemaVersionAtLeast('2.0.0', '1.1.0')).toBe(true);
		expect(isSchemaVersionAtLeast('1.0.0', '1.1.0')).toBe(false);
		expect(isSchemaVersionAtLeast(undefined, '1.1.0')).toBe(false);
		expect(isSchemaVersionAtLeast('1.1', '1.1.0')).toBe(true);
	});
});

describe('builder: usedSymbols + exportLines', () => {
	let tempDir: string;
	let workspacePath: string;

	beforeEach(() => {
		tempDir = fsSync.mkdtempSync(path.join(process.cwd(), 'repo-graph-cg-'));
		workspacePath = path.relative(process.cwd(), tempDir);
	});

	afterEach(() => {
		clearCache(workspacePath);
		resetQueryCache();
		fsSync.rmSync(tempDir, { recursive: true, force: true });
	});

	function write(rel: string, content: string): void {
		const full = path.join(tempDir, rel);
		fsSync.mkdirSync(path.dirname(full), { recursive: true });
		fsSync.writeFileSync(full, content);
	}

	test('records only imported symbols actually referenced, alias-aware', () => {
		write(
			'lib.ts',
			`export function used(x: number) { return x; }\n` +
				`export function unused() { return 0; }\n` +
				`export function aliasedSrc() { return 1; }\n`,
		);
		write(
			'consumer.ts',
			`import { used, unused, aliasedSrc as alias } from './lib';\n` +
				`export const out = used(1) + alias();\n` +
				`// 'unused' is imported but never called below\n`,
		);

		const graph = buildWorkspaceGraph(workspacePath);
		const edge = graph.edges.find(
			(e) => e.source.endsWith('consumer.ts') && e.target.endsWith('lib.ts'),
		);
		expect(edge).toBeDefined();
		// 'used' (direct) and 'aliasedSrc' (via local alias `alias`) are referenced;
		// 'unused' is imported but never referenced in the body.
		expect(edge?.usedSymbols).toEqual(['aliasedSrc', 'used']);

		// exportLines maps each exported symbol to its 1-based definition line.
		const libNode = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith('lib.ts'),
		);
		expect(libNode?.exportLines?.used).toBe(1);
		expect(libNode?.exportLines?.unused).toBe(2);
		expect(libNode?.exportLines?.aliasedSrc).toBe(3);
	});

	test('namespace imports yield no usedSymbols (unresolvable)', () => {
		write('lib.ts', `export const a = 1;\nexport const b = 2;\n`);
		write('ns.ts', `import * as L from './lib';\nexport const x = L.a;\n`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edge = graph.edges.find((e) => e.source.endsWith('ns.ts'));
		expect(edge?.importType).toBe('namespace');
		expect(edge?.usedSymbols).toBeUndefined();
	});

	test('named re-exports treat re-exported symbols as used', () => {
		write('lib.ts', `export const a = 1;\nexport const b = 2;\n`);
		write('barrel.ts', `export { a, b } from './lib';\n`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edge = graph.edges.find(
			(e) => e.source.endsWith('barrel.ts') && e.target.endsWith('lib.ts'),
		);
		// Re-exporting exposes a and b downstream -> both count as used.
		expect(edge?.usedSymbols).toEqual(['a', 'b']);
	});

	test('named default exports reconcile with the "default" sentinel', () => {
		// `export default function go` is referenced cross-file as the default,
		// not as `go`. The export must normalize to 'default' so the queries do
		// not mis-handle it (issue #1409 review, bug 1).
		write('d.ts', `export default function go() { return 1; }\n`);
		write('use-default.ts', `import go from './d';\nexport const r = go();\n`);

		const graph = buildWorkspaceGraph(workspacePath);
		const edge = graph.edges.find((e) => e.source.endsWith('use-default.ts'));
		expect(edge?.importType).toBe('default');
		expect(edge?.usedSymbols).toEqual(['default']);

		// The default export is recorded under the 'default' sentinel, not 'go'.
		const dNode = Object.values(graph.nodes).find((n) =>
			n.filePath.endsWith('d.ts'),
		);
		expect(dNode?.exports).toEqual(['default']);

		// getCallers finds the default consumer; getDeadExports does NOT flag the
		// used default export as dead.
		expect(getCallers(graph, 'd.ts', 'default')).toEqual([
			{ file: 'use-default.ts', resolution: 'used' },
		]);
		const dead = getDeadExports(graph);
		expect(dead.candidates.map((c) => c.symbol)).not.toContain('default');
		expect(dead.candidates.map((c) => c.symbol)).not.toContain('go');
	});

	test('sync and async builders remain identical with the new fields', async () => {
		write('lib.ts', `export const used = 1;\nexport const dead = 2;\n`);
		write('c.ts', `import { used } from './lib';\nexport const v = used;\n`);

		const sync = buildWorkspaceGraph(workspacePath);
		clearCache(workspacePath);
		const asyncGraph = await buildWorkspaceGraphAsync(workspacePath);
		expect(asyncGraph.nodes).toEqual(sync.nodes);
		expect(asyncGraph.edges).toEqual(sync.edges);
	});
});

describe('getCallers / getDeadExports (synthetic graphs)', () => {
	afterEach(() => resetQueryCache());

	function node(rel: string, exports: string[]): GraphNode {
		return {
			filePath: `/ws/${rel}`,
			moduleName: rel,
			exports,
			imports: [],
			language: 'typescript',
			mtime: '2026-01-01T00:00:00.000Z',
		};
	}

	function graphOf(
		nodes: GraphNode[],
		edges: RepoGraph['edges'],
		schema = '1.1.0',
	): RepoGraph {
		const nodeMap: Record<string, GraphNode> = {};
		for (const n of nodes) nodeMap[n.filePath] = n;
		return {
			schema_version: schema,
			workspaceRoot: '/ws',
			nodes: nodeMap,
			edges,
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'repo-graph',
				nodeCount: nodes.length,
				edgeCount: edges.length,
			},
		};
	}

	test('getCallers returns referencing files at "used" resolution', () => {
		const graph = graphOf(
			[node('lib.ts', ['foo', 'bar']), node('a.ts', []), node('b.ts', [])],
			[
				{
					source: '/ws/a.ts',
					target: '/ws/lib.ts',
					importSpecifier: './lib',
					importType: 'named',
					importedSymbols: ['foo'],
					usedSymbols: ['foo'],
				},
				{
					source: '/ws/b.ts',
					target: '/ws/lib.ts',
					importSpecifier: './lib',
					importType: 'named',
					importedSymbols: ['bar'],
					usedSymbols: [],
				},
			],
		);
		const callers = getCallers(graph, 'lib.ts', 'foo');
		expect(callers).toEqual([{ file: 'a.ts', resolution: 'used' }]);
		// 'bar' was imported by b.ts but not used -> no callers.
		expect(getCallers(graph, 'lib.ts', 'bar')).toEqual([]);
	});

	test('getCallers falls back to import-level on edges without usedSymbols', () => {
		const graph = graphOf(
			[node('lib.ts', ['foo']), node('a.ts', [])],
			[
				{
					source: '/ws/a.ts',
					target: '/ws/lib.ts',
					importSpecifier: './lib',
					importType: 'named',
					importedSymbols: ['foo'],
					// no usedSymbols (legacy edge)
				},
			],
			'1.0.0',
		);
		expect(getCallers(graph, 'lib.ts', 'foo')).toEqual([
			{ file: 'a.ts', resolution: 'imported' },
		]);
	});

	test('getDeadExports flags unreferenced exports of imported files', () => {
		const graph = graphOf(
			[node('lib.ts', ['used', 'dead']), node('a.ts', [])],
			[
				{
					source: '/ws/a.ts',
					target: '/ws/lib.ts',
					importSpecifier: './lib',
					importType: 'named',
					importedSymbols: ['used'],
					usedSymbols: ['used'],
				},
			],
		);
		const result = getDeadExports(graph);
		expect(result.schemaSupported).toBe(true);
		expect(result.candidates).toEqual([
			{ file: 'lib.ts', symbol: 'dead', line: undefined, importerCount: 1 },
		]);
	});

	test('getDeadExports returns schemaSupported=false on pre-1.1.0 graphs', () => {
		const graph = graphOf(
			[node('lib.ts', ['dead']), node('a.ts', [])],
			[
				{
					source: '/ws/a.ts',
					target: '/ws/lib.ts',
					importSpecifier: './lib',
					importType: 'named',
					importedSymbols: [],
				},
			],
			'1.0.0',
		);
		const result = getDeadExports(graph);
		expect(result.schemaSupported).toBe(false);
		expect(result.candidates).toEqual([]);
	});

	test('getDeadExports ignores files with no in-repo importers', () => {
		const graph = graphOf([node('orphan.ts', ['foo'])], []);
		const result = getDeadExports(graph);
		expect(result.candidates).toEqual([]);
		expect(result.analyzedFiles).toBe(0);
	});

	test('getDeadExports skips files reached via namespace import (unresolvable)', () => {
		const graph = graphOf(
			[node('lib.ts', ['a']), node('n.ts', [])],
			[
				{
					source: '/ws/n.ts',
					target: '/ws/lib.ts',
					importSpecifier: './lib',
					importType: 'namespace',
					importedSymbols: ['*'],
				},
			],
		);
		const result = getDeadExports(graph);
		expect(result.candidates).toEqual([]);
		expect(result.skippedUnresolvable).toBe(1);
	});

	test('getDeadExports excludes framework-invoked roles', () => {
		const cliNode = node('cli.ts', ['handler']);
		cliNode.ontology = {
			roles: ['cli_command'],
			packageBoundary: 'root',
			routes: [],
			dataOperations: [],
			security: [],
			conventions: [],
			findings: [],
		};
		const graph = graphOf(
			[cliNode, node('a.ts', [])],
			[
				{
					source: '/ws/a.ts',
					target: '/ws/cli.ts',
					importSpecifier: './cli',
					importType: 'named',
					importedSymbols: [],
					usedSymbols: [],
				},
			],
		);
		expect(getDeadExports(graph).candidates).toEqual([]);
	});
});

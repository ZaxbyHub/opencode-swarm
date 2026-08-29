/**
 * Issue #1534 — query index cache is keyed by graph identity, not a slot.
 *
 * The derived reverse/forward/module-name indexes used to live in a
 * module-level SINGLE-SLOT cache. `loadSubgraphForFiles` returns a fresh
 * `RepoGraph` per call, so a single slot would be evicted by every injection
 * subgraph and force `repo_map` — which reuses ONE cached graph object — to
 * rebuild its index over the FULL graph on the next call. These tests pin the
 * `WeakMap` behavior that removes that thrash, and the mutation contract the
 * WeakMap no longer enforces by accident.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { getDependencies, getImporters, resetQueryCache } from './query';
import type { GraphEdge, GraphNode, RepoGraph } from './types';
import { normalizeGraphPath } from './types';

const root = path.resolve('/repo');

function key(moduleName: string): string {
	return normalizeGraphPath(path.join(root, moduleName));
}

function node(moduleName: string): GraphNode {
	return {
		filePath: key(moduleName),
		moduleName,
		exports: ['run'],
		imports: [],
		language: 'typescript',
		mtime: '2024-01-01T00:00:00.000Z',
	};
}

function edge(source: string, target: string): GraphEdge {
	return {
		source: key(source),
		target: key(target),
		importSpecifier: `./${target}`,
		importType: 'named',
		importedSymbols: ['run'],
		targetKind: 'node',
	};
}

function makeNodes(moduleNames: readonly string[]): Record<string, GraphNode> {
	const nodes: Record<string, GraphNode> = {};
	for (const moduleName of moduleNames)
		nodes[key(moduleName)] = node(moduleName);
	return nodes;
}

function metadata(nodeCount: number, edgeCount: number) {
	return {
		generatedAt: '2024-01-01T00:00:00.000Z',
		generator: 'test',
		nodeCount,
		edgeCount,
	};
}

/**
 * A graph whose `edges` array is read through a counting getter.
 *
 * `buildQueryIndexes` is the ONLY thing on the `getImporters` path that reads
 * `graph.edges` (`getGraphNode` reads `graph.nodes`, and the reverse-index
 * lookup reads the built Map), so the counter is an exact "how many times was
 * the index built for this graph object" instrument. Note that
 * `collectExternallyUsedSymbols` and `getSymbolConsumers` DO scan
 * `graph.edges` directly — this instrument is only valid for `getImporters` /
 * `getDependencies`.
 */
function countingGraph(
	moduleNames: readonly string[],
	edges: GraphEdge[],
): { graph: RepoGraph; indexBuilds: () => number } {
	let reads = 0;
	const graph: RepoGraph = {
		schema_version: '1.3.0',
		workspaceRoot: root,
		nodes: makeNodes(moduleNames),
		get edges(): GraphEdge[] {
			reads++;
			return edges;
		},
		metadata: metadata(moduleNames.length, edges.length),
	};
	return { graph, indexBuilds: () => reads };
}

describe('query index cache — WeakMap keying (#1534)', () => {
	test('a subgraph query between two full-graph queries does not rebuild the full index', () => {
		resetQueryCache();
		const full = countingGraph(
			['src/core/util.ts', 'src/mid/a.ts', 'src/mid/b.ts', 'src/top/x.ts'],
			[
				edge('src/mid/a.ts', 'src/core/util.ts'),
				edge('src/mid/b.ts', 'src/core/util.ts'),
				edge('src/top/x.ts', 'src/mid/a.ts'),
			],
		);
		// A DIFFERENT RepoGraph object, as loadSubgraphForFiles returns per call.
		const subgraph = countingGraph(
			['src/core/util.ts', 'src/mid/a.ts'],
			[edge('src/mid/a.ts', 'src/core/util.ts')],
		);

		// 1. repo_map-style whole-graph query: builds the full index once.
		const first = getImporters(full.graph, 'src/core/util.ts');
		expect(full.indexBuilds()).toBe(1);

		// 2. An interleaved injection-hook subgraph query. Under the previous
		//    single-slot cache this EVICTED the full graph's index.
		expect(getImporters(subgraph.graph, 'src/core/util.ts')).toEqual([
			{ file: 'src/mid/a.ts', importType: 'named' },
		]);
		expect(subgraph.indexBuilds()).toBe(1);

		// 3. The next whole-graph query must reuse the index, not rebuild it.
		const second = getImporters(full.graph, 'src/core/util.ts');
		expect(second).toEqual(first);
		expect(full.indexBuilds()).toBe(1);

		// Repeated interleaving must stay at one build apiece.
		getImporters(subgraph.graph, 'src/core/util.ts');
		getImporters(full.graph, 'src/mid/a.ts');
		expect(full.indexBuilds()).toBe(1);
		expect(subgraph.indexBuilds()).toBe(1);
	});

	test('each graph object keeps its own index (no cross-graph contamination)', () => {
		resetQueryCache();
		const full = countingGraph(
			['src/core/util.ts', 'src/mid/a.ts', 'src/mid/b.ts'],
			[
				edge('src/mid/a.ts', 'src/core/util.ts'),
				edge('src/mid/b.ts', 'src/core/util.ts'),
			],
		);
		const subgraph = countingGraph(
			['src/core/util.ts', 'src/mid/a.ts'],
			[edge('src/mid/a.ts', 'src/core/util.ts')],
		);

		// The subgraph legitimately sees fewer importers than the full graph;
		// interleaving must never let one answer stand in for the other.
		expect(getImporters(full.graph, 'src/core/util.ts')).toHaveLength(2);
		expect(getImporters(subgraph.graph, 'src/core/util.ts')).toHaveLength(1);
		expect(getImporters(full.graph, 'src/core/util.ts')).toHaveLength(2);
		expect(getImporters(subgraph.graph, 'src/core/util.ts')).toHaveLength(1);
		expect(full.indexBuilds()).toBe(1);
		expect(subgraph.indexBuilds()).toBe(1);
	});

	test('resetQueryCache is still required after an in-place mutation', () => {
		// CONTRACT PIN. The single-slot cache used to flush incidentally the
		// moment any other graph was queried, which could mask a missing
		// invalidation. The WeakMap removes that accident: a stale index now
		// survives for the lifetime of the graph object. Every in-place
		// mutation site (incremental.ts:429,722,742) must call resetQueryCache.
		resetQueryCache();
		const edges: GraphEdge[] = [edge('src/mid/a.ts', 'src/core/util.ts')];
		const graph: RepoGraph = {
			schema_version: '1.3.0',
			workspaceRoot: root,
			nodes: makeNodes(['src/core/util.ts', 'src/mid/a.ts', 'src/deep/d.ts']),
			edges,
			metadata: metadata(3, edges.length),
		};

		expect(getDependencies(graph, 'src/core/util.ts')).toEqual([]);

		// Mutate the graph in place, exactly as an incremental update does.
		graph.edges.push(edge('src/core/util.ts', 'src/deep/d.ts'));

		// WITHOUT resetQueryCache the answer is detectably stale...
		expect(getDependencies(graph, 'src/core/util.ts')).toEqual([]);

		// ...and the seam is what makes it fresh again.
		resetQueryCache();
		expect(getDependencies(graph, 'src/core/util.ts')).toEqual([
			{ file: 'src/deep/d.ts', importType: 'named' },
		]);
	});

	test('resetQueryCache invalidates every live graph, not just the last one', () => {
		resetQueryCache();
		const edgesA: GraphEdge[] = [];
		const edgesB: GraphEdge[] = [];
		const graphA: RepoGraph = {
			schema_version: '1.3.0',
			workspaceRoot: root,
			nodes: makeNodes(['src/core/util.ts', 'src/deep/d.ts']),
			edges: edgesA,
			metadata: metadata(2, 0),
		};
		const graphB: RepoGraph = {
			schema_version: '1.3.0',
			workspaceRoot: root,
			nodes: makeNodes(['src/core/util.ts', 'src/deep/d.ts']),
			edges: edgesB,
			metadata: metadata(2, 0),
		};

		expect(getDependencies(graphA, 'src/core/util.ts')).toEqual([]);
		expect(getDependencies(graphB, 'src/core/util.ts')).toEqual([]);
		edgesA.push(edge('src/core/util.ts', 'src/deep/d.ts'));
		edgesB.push(edge('src/core/util.ts', 'src/deep/d.ts'));

		resetQueryCache();
		expect(getDependencies(graphA, 'src/core/util.ts')).toHaveLength(1);
		expect(getDependencies(graphB, 'src/core/util.ts')).toHaveLength(1);
	});
});

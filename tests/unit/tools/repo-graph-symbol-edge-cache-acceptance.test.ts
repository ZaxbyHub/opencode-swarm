/**
 * Acceptance coverage for issue #2489 / AC2.
 *
 * The public symbol-query module historically rebuilt its forward/reverse
 * symbol-edge maps in each query family.  This fixture observes the public
 * graph input rather than reaching into a private helper, so it fails for the
 * shipped duplicate scans and remains valid if the cache implementation is
 * reorganized.
 */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { resetQueryCache } from '../../../src/tools/repo-graph/query';
import {
	explainGraphEntry,
	getImpactCone,
	getSymbolContext,
} from '../../../src/tools/repo-graph/symbol-query';
import type {
	GraphNode,
	RepoGraph,
	SymbolEdge,
} from '../../../src/tools/repo-graph/types';
import { normalizeGraphPath } from '../../../src/tools/repo-graph/types';

const root = path.resolve(import.meta.dir, '../../../repo-graph-symbol-cache');

function key(file: string): string {
	return normalizeGraphPath(path.join(root, file));
}

function makeNode(file: string, symbol: string): GraphNode {
	return {
		filePath: key(file),
		moduleName: file,
		exports: [symbol],
		exportLines: { [symbol]: 1 },
		exportRanges: { [symbol]: { startLine: 1, endLine: 1 } },
		imports: [],
		language: 'typescript',
		mtime: '2026-01-01T00:00:00.000Z',
	};
}

function makeCountingGraph(): {
	graph: RepoGraph;
	reads: () => number;
	addEdge: (edge: SymbolEdge) => void;
} {
	const symbolEdges: SymbolEdge[] = [
		{
			fromFile: key('caller.ts'),
			fromSymbol: 'call',
			toFile: key('target.ts'),
			toSymbol: 'run',
		},
		{
			fromFile: key('target.ts'),
			fromSymbol: 'run',
			toFile: key('callee.ts'),
			toSymbol: 'finish',
		},
	];
	const nodes = {
		[key('caller.ts')]: makeNode('caller.ts', 'call'),
		[key('target.ts')]: makeNode('target.ts', 'run'),
		[key('callee.ts')]: makeNode('callee.ts', 'finish'),
	};
	let symbolEdgeReads = 0;
	const graph: RepoGraph = {
		schema_version: '1.7.0',
		workspaceRoot: root,
		nodes,
		edges: [],
		metadata: {
			generatedAt: '2026-01-01T00:00:00.000Z',
			generator: 'acceptance',
			nodeCount: 3,
			edgeCount: 0,
		},
		get symbolEdges(): SymbolEdge[] {
			symbolEdgeReads++;
			return symbolEdges;
		},
	};
	return {
		graph,
		reads: () => symbolEdgeReads,
		addEdge: (edge) => symbolEdges.push(edge),
	};
}

describe('issue #2489 AC2 — symbol-edge indexes are graph-identity cached', () => {
	test('all public symbol query paths share one build and reset after mutation', () => {
		resetQueryCache();
		const counted = makeCountingGraph();

		const context = getSymbolContext(counted.graph, {
			file: 'target.ts',
			symbol: 'run',
		});
		const cone = getImpactCone(counted.graph, {
			file: 'target.ts',
			symbol: 'run',
		});
		const explanation = explainGraphEntry(counted.graph, {
			file: 'target.ts',
			symbol: 'run',
		});

		expect(context.callers.map((entry) => entry.symbol)).toEqual(['call']);
		expect(cone.entries.map((entry) => entry.symbol)).toEqual([
			'finish',
			'call',
		]);
		expect(
			explanation.reasons
				.filter(
					(reason) =>
						reason.type === 'referenced_by' || reason.type === 'references',
				)
				.map((reason) => reason.symbol),
		).toEqual(['call', 'finish']);
		expect(counted.reads()).toBe(1);

		counted.addEdge({
			fromFile: key('new-caller.ts'),
			fromSymbol: 'newCall',
			toFile: key('target.ts'),
			toSymbol: 'run',
		});
		resetQueryCache();
		const refreshed = getSymbolContext(counted.graph, {
			file: 'target.ts',
			symbol: 'run',
		});
		expect(refreshed.callers.map((entry) => entry.symbol)).toEqual([
			'call',
			'newCall',
		]);
		expect(counted.reads()).toBe(2);
	});
});

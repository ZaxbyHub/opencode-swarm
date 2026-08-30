import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type GraphNode,
	getSymbolContext,
	type RepoGraph,
	resetQueryCache,
} from '../../../src/tools/repo-graph';
import {
	createStableSymbolId,
	deriveRepoRootId,
} from '../../../src/tools/repo-graph/symbol-edge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmp = '';

function realNode(
	workspaceRoot: string,
	moduleName: string,
	source: string,
	exports: string[],
	ranges: Record<string, { startLine: number; endLine: number }>,
	kinds?: Record<string, string>,
): { node: GraphNode; write: () => void } {
	const filePath = path.join(workspaceRoot, moduleName);
	return {
		node: {
			filePath,
			moduleName,
			exports,
			imports: [],
			language: 'typescript',
			mtime: '1',
			exportRanges: ranges,
			...(kinds !== undefined
				? { exportKinds: kinds as GraphNode['exportKinds'] }
				: {}),
		},
		write: () => {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, source);
		},
	};
}

function edge(
	from: { file: string; symbol: string },
	to: { file: string; symbol: string },
	extras: { confidence?: number; resolution?: string; kind?: string } = {},
): Record<string, unknown> {
	return {
		fromFile: from.file,
		fromSymbol: from.symbol,
		toFile: to.file,
		toSymbol: to.symbol,
		...(extras.kind !== undefined ? { kind: extras.kind } : {}),
		...(extras.confidence !== undefined
			? { confidence: extras.confidence }
			: {}),
		...(extras.resolution !== undefined
			? { resolution: extras.resolution }
			: {}),
	};
}

function makeGraph(
	workspaceRoot: string,
	nodes: GraphNode[],
	symbolEdges: Array<Record<string, unknown>> = [],
): RepoGraph {
	return {
		schema_version: '1.6.0',
		workspaceRoot,
		nodes: Object.fromEntries(nodes.map((n) => [n.filePath, n])),
		edges: [],
		symbolEdges: symbolEdges as RepoGraph['symbolEdges'],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: nodes.length,
			edgeCount: 0,
		},
	};
}

beforeEach(() => {
	tmp = canonicalMkdtemp('repo-graph-symbol-context-');
});

afterEach(() => {
	resetQueryCache();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('getSymbolContext: resolution', () => {
	test('resolves by file+symbol with identity, signature, and neighbors', () => {
		const util = realNode(
			tmp,
			'src/util.ts',
			'export function add(a: number, b: number) {\n  return a + b;\n}\n',
			['add'],
			{ add: { startLine: 1, endLine: 3 } },
			{ add: 'function' },
		);
		const main = realNode(tmp, 'src/main.ts', 'console.log(1);\n', [], {});
		util.write();
		const graph = makeGraph(
			tmp,
			[util.node, main.node],
			[
				edge(
					{ file: main.node.filePath, symbol: '<module>' },
					{ file: util.node.filePath, symbol: 'add' },
					{ confidence: 0.9, resolution: 'import_binding', kind: 'REFERENCES' },
				),
			],
		);
		const result = getSymbolContext(graph, {
			file: 'src/util.ts',
			symbol: 'add',
		});
		expect(result.found).toBe(true);
		expect(result.identity).toMatchObject({
			file: 'src/util.ts',
			symbol: 'add',
			kind: 'function',
			visibility: 'exported',
			startLine: 1,
			endLine: 3,
		});
		expect(result.identity?.symbolId).toMatch(/^[0-9a-f]{64}$/);
		expect(result.signature).toContain('export function add');
		expect(result.callers).toHaveLength(1);
		expect(result.callers[0]).toMatchObject({
			file: 'src/main.ts',
			symbol: '<module>',
			direction: 'caller',
			depth: 1,
			confidence: 0.9,
			resolution: 'import_binding',
		});
		expect(result.callees).toEqual([]);
	});

	test('resolves by stable symbol_id matching createStableSymbolId', () => {
		const util = realNode(
			tmp,
			'src/util.ts',
			'export const VALUE = 1;\n',
			['VALUE'],
			{ VALUE: { startLine: 1, endLine: 1 } },
			{ VALUE: 'const' },
		);
		const graph = makeGraph(tmp, [util.node]);
		const expected = createStableSymbolId(
			deriveRepoRootId(tmp),
			path.join('src', 'util.ts'),
			'VALUE',
			'symbol',
		);
		const result = getSymbolContext(graph, { symbolId: expected });
		expect(result.found).toBe(true);
		expect(result.identity?.symbol).toBe('VALUE');
		expect(result.identity?.symbolId).toBe(expected);
		expect(result.symbolIdScan?.capped).toBe(false);
	});

	test('unknown symbol_id reports not found with the scan accounting', () => {
		const util = realNode(tmp, 'src/util.ts', 'export const A = 1;\n', ['A'], {
			A: { startLine: 1, endLine: 1 },
		});
		const graph = makeGraph(tmp, [util.node]);
		const result = getSymbolContext(graph, {
			symbolId: '0'.repeat(64),
		});
		expect(result.found).toBe(false);
		expect(result.note).toContain('No symbol matches');
		expect(result.symbolIdScan).toEqual({ computed: 1, capped: false });
	});

	test('missing file resolves to found:false with a note, not a throw', () => {
		const graph = makeGraph(tmp, []);
		const result = getSymbolContext(graph, {
			file: 'src/nope.ts',
			symbol: 'add',
		});
		expect(result.found).toBe(false);
		expect(result.note).toContain('Target file not found in graph');
	});

	test('symbol absent from the file reports the soft not-defined shape', () => {
		const util = realNode(tmp, 'src/util.ts', 'export const A = 1;\n', ['A'], {
			A: { startLine: 1, endLine: 1 },
		});
		const graph = makeGraph(tmp, [util.node]);
		const result = getSymbolContext(graph, {
			file: 'src/util.ts',
			symbol: 'ghost',
		});
		expect(result.found).toBe(false);
		expect(result.note).toContain('not defined in this file');
	});

	test('neither symbol_id nor file+symbol yields a usage note', () => {
		const result = getSymbolContext(makeGraph(tmp, []), {});
		expect(result.found).toBe(false);
		expect(result.note).toContain('requires symbol_id or file+symbol');
	});
});

describe('getSymbolContext: source handling', () => {
	test('include_source=true embeds hashed, containment-checked source', () => {
		const util = realNode(
			tmp,
			'src/util.ts',
			'export function add(a: number, b: number) {\n  return a + b;\n}\n',
			['add'],
			{ add: { startLine: 1, endLine: 3 } },
			{ add: 'function' },
		);
		util.write();
		const graph = makeGraph(tmp, [util.node]);
		const result = getSymbolContext(graph, {
			file: 'src/util.ts',
			symbol: 'add',
			includeSource: true,
		});
		expect(result.source).toBeDefined();
		expect(result.source?.text).toContain('return a + b;');
		expect(result.source?.mode).toBe('full');
		expect(result.source?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.source?.startLine).toBe(1);
		expect(result.source?.endLine).toBe(3);
	});

	test('source read failure fails open with a warning', () => {
		const util = realNode(
			tmp,
			'src/gone.ts',
			'export function add() {}\n',
			['add'],
			{ add: { startLine: 1, endLine: 1 } },
		);
		// Node exists in the graph but the file was never written to disk.
		const graph = makeGraph(tmp, [util.node]);
		const result = getSymbolContext(graph, {
			file: 'src/gone.ts',
			symbol: 'add',
			includeSource: true,
		});
		expect(result.found).toBe(true);
		expect(result.source).toBeUndefined();
		expect(result.warnings.join('\n')).toContain(
			'definition source unavailable: source read failed',
		);
	});

	test('include_source with no persisted range warns instead of throwing', () => {
		const util = realNode(
			tmp,
			'src/util.ts',
			'export const A = 1;\n',
			['A'],
			{},
		);
		const graph = makeGraph(tmp, [util.node]);
		const result = getSymbolContext(graph, {
			file: 'src/util.ts',
			symbol: 'A',
			includeSource: true,
		});
		expect(result.found).toBe(true);
		expect(result.source).toBeUndefined();
		expect(result.warnings.join('\n')).toContain('no persisted export range');
	});
});

describe('getSymbolContext: bounding', () => {
	test('symbol_id scan caps at 10 000 ids and reports the cap', () => {
		// Synthetic in-memory graph: 11 nodes x 1000 symbols = 11 000 names,
		// past the 10 000-id scan cap. No tree-sitter or filesystem needed.
		const nodes: GraphNode[] = Array.from({ length: 11 }, (_, fileIdx) => {
			const ranges: Record<string, { startLine: number; endLine: number }> = {};
			for (let i = 0; i < 1000; i++)
				ranges[`sym_${fileIdx}_${i}`] = { startLine: 1, endLine: 1 };
			return {
				filePath: path.join(tmp, `src/f${fileIdx}.ts`),
				moduleName: `src/f${fileIdx}.ts`,
				exports: [],
				imports: [],
				language: 'typescript',
				mtime: '1',
				exportRanges: ranges,
			};
		});
		const graph = makeGraph(tmp, nodes);
		const result = getSymbolContext(graph, { symbolId: 'f'.repeat(64) });
		expect(result.found).toBe(false);
		expect(result.symbolIdScan?.capped).toBe(true);
		expect(result.symbolIdScan?.computed).toBe(10_000);
		expect(result.warnings.join('\n')).toContain('symbol_id scan cap (10000)');
		expect(result.warnings.join('\n')).toContain('retry with file+symbol');
	});

	test('top_n caps each neighbor side and reports drops', () => {
		const util = realNode(
			tmp,
			'src/util.ts',
			'export function add() {}\n',
			['add'],
			{
				add: { startLine: 1, endLine: 1 },
			},
		);
		const others = Array.from({ length: 4 }, (_, i) =>
			realNode(tmp, `src/c${i}.ts`, 'export const C = 1;\n', [], {}),
		);
		const graph = makeGraph(
			tmp,
			[util.node, ...others.map((o) => o.node)],
			others.map((o) =>
				edge(
					{ file: o.node.filePath, symbol: '<module>' },
					{ file: util.node.filePath, symbol: 'add' },
				),
			),
		);
		const result = getSymbolContext(graph, {
			file: 'src/util.ts',
			symbol: 'add',
			topN: 2,
		});
		expect(result.callers).toHaveLength(2);
		expect(result.budget.callersReturned).toBe(2);
		expect(result.budget.dropped).toBe(2);
		expect(result.warnings.join('\n')).toContain('omitted by top_n=2');
	});
});

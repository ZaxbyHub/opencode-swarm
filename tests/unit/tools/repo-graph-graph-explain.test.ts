import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	explainGraphEntry,
	type GraphNode,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
	type SymbolEdge,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');
const abs = (moduleName: string): string =>
	normalizeGraphPath(path.join(root, moduleName));

function node(
	moduleName: string,
	options: {
		exports?: string[];
		ranges?: Record<string, { startLine: number; endLine: number }>;
		kinds?: Record<string, string>;
		imports?: string[];
	} = {},
): GraphNode {
	return {
		filePath: abs(moduleName),
		moduleName,
		exports: options.exports ?? [],
		imports: options.imports ?? [],
		language: 'typescript',
		mtime: '1',
		...(options.ranges !== undefined ? { exportRanges: options.ranges } : {}),
		...(options.kinds !== undefined
			? { exportKinds: options.kinds as GraphNode['exportKinds'] }
			: {}),
	};
}

function symEdge(
	from: { file: string; symbol: string },
	to: { file: string; symbol: string },
	extras: {
		confidence?: number;
		resolution?: string;
		evidence?: Array<{
			file: string;
			line: number;
			snippetHash: string;
			extractor: string;
		}>;
	} = {},
): SymbolEdge {
	return {
		fromFile: abs(from.file),
		fromSymbol: from.symbol,
		toFile: abs(to.file),
		toSymbol: to.symbol,
		kind: 'REFERENCES',
		...(extras.confidence !== undefined
			? { confidence: extras.confidence }
			: {}),
		...(extras.resolution !== undefined
			? { resolution: extras.resolution as SymbolEdge['resolution'] }
			: {}),
		...(extras.evidence !== undefined ? { evidence: extras.evidence } : {}),
	};
}

function makeGraph(symbolEdges: SymbolEdge[] = []): RepoGraph {
	const util = node('src/util.ts', {
		exports: ['add', 'Calculator'],
		ranges: {
			add: { startLine: 1, endLine: 3 },
			Calculator: { startLine: 5, endLine: 20 },
			inner: { startLine: 8, endLine: 10 },
		},
		kinds: { add: 'function', Calculator: 'class', inner: 'method' },
	});
	const main = node('src/main.ts', { imports: ['./util'] });
	return {
		schema_version: '1.6.0',
		workspaceRoot: root,
		nodes: { [util.filePath]: util, [main.filePath]: main },
		edges: [
			{
				source: abs('src/main.ts'),
				target: abs('src/util.ts'),
				importSpecifier: './util',
				importType: 'named',
			},
		],
		symbolEdges,
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 2,
			edgeCount: 1,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('explainGraphEntry: span resolution', () => {
	test('line resolves to the smallest containing span', () => {
		const result = explainGraphEntry(makeGraph(), {
			file: 'src/util.ts',
			line: 9,
		});
		// Line 9 sits inside both Calculator (5-20) and inner (8-10); the
		// smallest span (inner) wins.
		expect(result.resolvedSpan).toEqual({
			symbol: 'inner',
			startLine: 8,
			endLine: 10,
		});
		expect(result.target.symbol).toBe('inner');
		expect(result.definition?.kind).toBe('method');
	});

	test('line outside every span resolves to no symbol', () => {
		const result = explainGraphEntry(makeGraph(), {
			file: 'src/util.ts',
			line: 4,
		});
		expect(result.resolvedSpan).toBeUndefined();
		expect(result.target.symbol).toBeNull();
	});
});

describe('explainGraphEntry: reasons', () => {
	test('definition, referenced_by, and imported_by reasons assemble', () => {
		const graph = makeGraph([
			symEdge(
				{ file: 'src/main.ts', symbol: 'run' },
				{ file: 'src/util.ts', symbol: 'add' },
				{
					confidence: 0.9,
					resolution: 'import_binding',
					evidence: [
						{
							file: 'src/main.ts',
							line: 7,
							snippetHash: 'a'.repeat(64),
							extractor: 'tree-sitter/typescript',
						},
					],
				},
			),
		]);
		const result = explainGraphEntry(graph, {
			file: 'src/util.ts',
			symbol: 'add',
		});
		const types = result.reasons.map((r) => r.type);
		expect(types).toContain('definition');
		expect(types).toContain('referenced_by');
		expect(types).toContain('imported_by');
		const ref = result.reasons.find((r) => r.type === 'referenced_by');
		expect(ref).toMatchObject({
			file: 'src/main.ts',
			symbol: 'run',
			confidence: 0.9,
			resolution: 'import_binding',
			relationshipKind: 'REFERENCES',
		});
		expect(ref?.evidence?.[0]).toMatchObject({
			file: 'src/main.ts',
			line: 7,
			extractor: 'tree-sitter/typescript',
		});
		const def = result.reasons.find((r) => r.type === 'definition');
		expect(def).toMatchObject({
			file: 'src/util.ts',
			symbol: 'add',
			kind: 'function',
		});
		const importedBy = result.reasons.find((r) => r.type === 'imported_by');
		expect(importedBy?.file).toBe('src/main.ts');
	});

	test('outgoing references appear as references reasons', () => {
		const graph = makeGraph([
			symEdge(
				{ file: 'src/util.ts', symbol: 'add' },
				{ file: 'src/main.ts', symbol: 'run' },
			),
		]);
		const result = explainGraphEntry(graph, {
			file: 'src/util.ts',
			symbol: 'add',
		});
		const ref = result.reasons.find((r) => r.type === 'references');
		expect(ref).toMatchObject({ file: 'src/main.ts', symbol: 'run' });
	});

	test('legacy edges surface without provenance and warn', () => {
		const graph = makeGraph([
			// No confidence/resolution: a pre-1.5.0 edge shape.
			{
				fromFile: abs('src/main.ts'),
				fromSymbol: 'run',
				toFile: abs('src/util.ts'),
				toSymbol: 'add',
			},
		]);
		const result = explainGraphEntry(graph, {
			file: 'src/util.ts',
			symbol: 'add',
		});
		const ref = result.reasons.find((r) => r.type === 'referenced_by');
		expect(ref?.confidence).toBeUndefined();
		expect(ref?.evidence).toBeUndefined();
		expect(result.warnings.join('\n')).toContain(
			'legacy symbol edge(s) lack confidence/resolution',
		);
	});

	test('file-only mode explains import relationships', () => {
		const result = explainGraphEntry(makeGraph(), { file: 'src/main.ts' });
		const types = result.reasons.map((r) => r.type);
		expect(types).toContain('imports');
		expect(result.reasons.find((r) => r.type === 'imports')?.file).toBe(
			'src/util.ts',
		);
		expect(result.fileKnown).toBe(true);
	});

	test('unknown file warns and stays answer-shaped', () => {
		const result = explainGraphEntry(makeGraph(), { file: 'src/nope.ts' });
		expect(result.fileKnown).toBe(false);
		expect(result.warnings.join('\n')).toContain(
			'target file not found in graph',
		);
	});
});

describe('explainGraphEntry: bounding', () => {
	test('top_n caps reasons with drop accounting', () => {
		const edges = Array.from({ length: 6 }, (_, i) =>
			symEdge(
				{ file: `src/c${i}.ts`, symbol: 'run' },
				{ file: 'src/util.ts', symbol: 'add' },
			),
		);
		const graph = makeGraph(edges);
		for (let i = 0; i < 6; i++) {
			graph.nodes[abs(`src/c${i}.ts`)] = node(`src/c${i}.ts`);
		}
		const result = explainGraphEntry(graph, {
			file: 'src/util.ts',
			symbol: 'add',
			topN: 3,
		});
		expect(result.reasons.length).toBeLessThanOrEqual(3);
		expect(result.budget.returned).toBe(3);
		expect(result.budget.dropped).toBeGreaterThan(0);
		expect(result.warnings.join('\n')).toContain('omitted by top_n=3');
	});

	test('evidence per reason is capped at three records', () => {
		const evidence = Array.from({ length: 5 }, (_, i) => ({
			file: 'src/main.ts',
			line: i + 1,
			snippetHash: `${i}`.repeat(64),
			extractor: 'tree-sitter/typescript',
		}));
		const graph = makeGraph([
			symEdge(
				{ file: 'src/main.ts', symbol: 'run' },
				{ file: 'src/util.ts', symbol: 'add' },
				{ confidence: 0.9, resolution: 'import_binding', evidence },
			),
		]);
		const result = explainGraphEntry(graph, {
			file: 'src/util.ts',
			symbol: 'add',
		});
		const ref = result.reasons.find((r) => r.type === 'referenced_by');
		expect(ref?.evidence).toHaveLength(3);
	});

	test('all output paths are workspace-relative', () => {
		const result = explainGraphEntry(makeGraph(), {
			file: 'src/util.ts',
			symbol: 'add',
		});
		for (const reason of result.reasons) {
			expect(path.isAbsolute(reason.file)).toBe(false);
			expect(reason.file.includes('\\')).toBe(false);
		}
	});
});

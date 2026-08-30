import { beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	type FileOntology,
	type GraphEdge,
	type GraphNode,
	getImpactCone,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
} from '../../../src/tools/repo-graph';

const root = path.resolve('/repo');

/** Production graphs key nodes and edges by normalized forward-slash paths. */
const abs = (moduleName: string): string =>
	normalizeGraphPath(path.join(root, moduleName));

function ontology(
	roles: string[],
	extras: Partial<FileOntology> = {},
): FileOntology {
	return {
		roles: roles as FileOntology['roles'],
		packageBoundary: 'src',
		routes: [],
		dataOperations: [],
		security: [],
		conventions: [],
		findings: [],
		...extras,
	};
}

function node(
	moduleName: string,
	options: {
		exports?: string[];
		ranges?: Record<string, { startLine: number; endLine: number }>;
		kinds?: Record<string, string>;
		ontology?: FileOntology;
	} = {},
): GraphNode {
	return {
		filePath: abs(moduleName),
		moduleName,
		exports: options.exports ?? [],
		imports: [],
		language: 'typescript',
		mtime: '1',
		...(options.ranges !== undefined ? { exportRanges: options.ranges } : {}),
		...(options.kinds !== undefined
			? { exportKinds: options.kinds as GraphNode['exportKinds'] }
			: {}),
		...(options.ontology !== undefined ? { ontology: options.ontology } : {}),
	};
}

function fileEdge(from: string, to: string): GraphEdge {
	return {
		source: abs(from),
		target: abs(to),
		importSpecifier: `./${path.basename(to)}`,
		importType: 'named',
	};
}

function symEdge(
	from: { file: string; symbol: string },
	to: { file: string; symbol: string },
	extras: { confidence?: number; resolution?: string } = {},
): Record<string, unknown> {
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
			? { resolution: extras.resolution }
			: {}),
	};
}

function makeGraph(
	options: { symbolEdges?: Array<Record<string, unknown>> } = {},
): RepoGraph {
	const util = node('src/util.ts', {
		exports: ['add'],
		ranges: { add: { startLine: 1, endLine: 2 } },
		kinds: { add: 'function' },
	});
	const main = node('src/main.ts', {
		ontology: ontology(['source_module'], {
			routes: [
				{ method: 'GET' as const, path: '/x', source: 'file_path' as const },
			],
			dataOperations: [
				{
					operation: 'read' as const,
					access: 'database' as const,
					line: 3,
					evidence: 'db.read',
				},
			],
			security: [
				{
					kind: 'authentication' as const,
					line: 4,
					evidence: 'authn',
					confidence: 'medium' as const,
				},
			],
		}),
	});
	const test = node('src/util.test.ts', {
		ontology: ontology(['test_file']),
	});
	const deep = node('src/deep.ts', {});
	const deeper = node('src/deeper.ts', {});
	return {
		schema_version: '1.6.0',
		workspaceRoot: root,
		nodes: {
			[util.filePath]: util,
			[main.filePath]: main,
			[test.filePath]: test,
			[deep.filePath]: deep,
			[deeper.filePath]: deeper,
		},
		edges: [
			fileEdge('src/main.ts', 'src/util.ts'),
			fileEdge('src/util.test.ts', 'src/util.ts'),
			fileEdge('src/deep.ts', 'src/main.ts'),
			fileEdge('src/deeper.ts', 'src/deep.ts'),
		],
		symbolEdges: options.symbolEdges as RepoGraph['symbolEdges'],
		metadata: {
			generatedAt: '1',
			generator: 'test',
			nodeCount: 5,
			edgeCount: 4,
		},
	};
}

beforeEach(() => {
	resetQueryCache();
});

describe('getImpactCone: file-level', () => {
	test('aggregates blast radius risk, tests, and ontology facts', () => {
		const graph = makeGraph();
		const result = getImpactCone(graph, { file: 'src/util.ts', maxDepth: 3 });
		expect(result.target).toEqual({ file: 'src/util.ts', symbol: null });
		expect(result.entries).toEqual([]);
		expect(result.fileImpact.directDependents).toContain('src/main.ts');
		expect(result.fileImpact.transitiveDependents).toContain('src/deeper.ts');
		expect(result.risk).toBe(result.fileImpact.riskLevel);
		expect(result.tests).toContain('src/util.test.ts');
		expect(result.routes).toEqual([
			{
				file: 'src/main.ts',
				fact: { method: 'GET', path: '/x', source: 'file_path' },
			},
		]);
		expect(result.dataFacts[0]?.fact.operation).toBe('read');
		expect(result.securityFacts[0]?.fact.kind).toBe('authentication');
		expect(result.boundaries.length).toBeGreaterThan(0);
		expect(result.riskNotes.join('\n')).toContain('transitive spread');
		expect(result.riskNotes.join('\n')).toContain('test files affected');
		expect(result.truncated).toBe(false);
	});

	test('unknown target file warns and returns an empty cone', () => {
		const result = getImpactCone(makeGraph(), { file: 'src/nope.ts' });
		expect(result.entries).toEqual([]);
		expect(result.fileImpact.totalDependents).toBe(0);
		expect(result.warnings.join('\n')).toContain(
			'target file not found in graph',
		);
	});
});

describe('getImpactCone: symbol-level', () => {
	test('collects callers and callees by depth with provenance', () => {
		const graph = makeGraph({
			symbolEdges: [
				symEdge(
					{ file: 'src/main.ts', symbol: 'run' },
					{ file: 'src/util.ts', symbol: 'add' },
					{ confidence: 0.9, resolution: 'import_binding' },
				),
				symEdge(
					{ file: 'src/util.ts', symbol: 'add' },
					{ file: 'src/deep.ts', symbol: 'sink' },
					{ confidence: 0.4, resolution: 'unresolved' },
				),
			],
		});
		const result = getImpactCone(graph, {
			file: 'src/util.ts',
			symbol: 'add',
			maxDepth: 2,
		});
		expect(result.target).toEqual({ file: 'src/util.ts', symbol: 'add' });
		const caller = result.entries.find((e) => e.direction === 'caller');
		const callee = result.entries.find((e) => e.direction === 'callee');
		expect(caller).toMatchObject({
			file: 'src/main.ts',
			symbol: 'run',
			depth: 1,
			confidence: 0.9,
			resolution: 'import_binding',
			relationshipKind: 'REFERENCES',
		});
		expect(callee).toMatchObject({
			file: 'src/deep.ts',
			symbol: 'sink',
			depth: 1,
			confidence: 0.4,
		});
		expect(result.riskNotes.join('\n')).toContain(
			'low-confidence edges in cone: 1',
		);
	});

	test('legacy edges surface with null provenance and no low-confidence note', () => {
		const graph = makeGraph({
			symbolEdges: [
				symEdge(
					{ file: 'src/main.ts', symbol: 'run' },
					{ file: 'src/util.ts', symbol: 'add' },
				),
			],
		});
		const result = getImpactCone(graph, {
			file: 'src/util.ts',
			symbol: 'add',
		});
		expect(result.entries[0]?.confidence).toBeNull();
		expect(result.entries[0]?.resolution).toBeNull();
		expect(result.riskNotes.join('\n')).not.toContain('low-confidence edges');
	});
});

describe('getImpactCone: bounding', () => {
	test('top_n caps entries with truncation and drop accounting', () => {
		const many = Array.from({ length: 5 }, (_, i) =>
			symEdge(
				{ file: `src/c${i}.ts`, symbol: 'run' },
				{ file: 'src/util.ts', symbol: 'add' },
			),
		);
		const graph = makeGraph({ symbolEdges: many });
		graph.nodes['src/c0.ts'] = node('src/c0.ts');
		graph.nodes['src/c1.ts'] = node('src/c1.ts');
		graph.nodes['src/c2.ts'] = node('src/c2.ts');
		graph.nodes['src/c3.ts'] = node('src/c3.ts');
		graph.nodes['src/c4.ts'] = node('src/c4.ts');
		const result = getImpactCone(graph, {
			file: 'src/util.ts',
			symbol: 'add',
			topN: 2,
		});
		expect(result.entries).toHaveLength(2);
		expect(result.budget.entriesReturned).toBe(2);
		expect(result.budget.dropped).toBe(3);
		expect(result.truncated).toBe(true);
		expect(result.warnings.join('\n')).toContain('omitted by top_n=2');
	});

	test('depth 1 excludes transitive symbol reach', () => {
		const graph = makeGraph({
			symbolEdges: [
				symEdge(
					{ file: 'src/main.ts', symbol: 'run' },
					{ file: 'src/util.ts', symbol: 'add' },
				),
				symEdge(
					{ file: 'src/deeper.ts', symbol: 'far' },
					{ file: 'src/main.ts', symbol: 'run' },
				),
			],
		});
		const result = getImpactCone(graph, {
			file: 'src/util.ts',
			symbol: 'add',
			maxDepth: 1,
		});
		expect(result.entries.map((e) => e.symbol)).toEqual(['run']);
	});

	test('all output paths are workspace-relative', () => {
		const graph = makeGraph({
			symbolEdges: [
				symEdge(
					{ file: 'src/main.ts', symbol: 'run' },
					{ file: 'src/util.ts', symbol: 'add' },
				),
			],
		});
		const result = getImpactCone(graph, { file: 'src/util.ts', symbol: 'add' });
		for (const entry of result.entries) {
			expect(path.isAbsolute(entry.file)).toBe(false);
			expect(entry.file.includes('\\')).toBe(false);
		}
		expect(result.tests.every((t) => !path.isAbsolute(t))).toBe(true);
	});
});

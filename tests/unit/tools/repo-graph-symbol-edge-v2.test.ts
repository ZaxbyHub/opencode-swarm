import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	buildWorkspaceGraphAsync,
	clearCache,
	getContextPack,
	getGraphHealth,
	loadGraph,
	type RepoGraph,
} from '../../../src/tools/repo-graph';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';
import {
	createStableSymbolId,
	createSymbolEdgeV2,
	deriveRepoRootId,
	hashSymbolEdgeSnippet,
	mergeSymbolEdges,
} from '../../../src/tools/repo-graph/symbol-edge';

describe('SymbolEdge v2 — issue #1532 regression', () => {
	let workspace: string;
	let originalExtractFileSymbols: typeof builderInternals.extractFileSymbols;

	beforeEach(() => {
		workspace = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-edge-v2-')),
		);
		originalExtractFileSymbols = builderInternals.extractFileSymbols;
	});

	afterEach(() => {
		clearCache(workspace);
		builderInternals.extractFileSymbols = originalExtractFileSymbols;
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	test('async builder emits trustworthy v2 facts on real symbol edges', async () => {
		fs.writeFileSync(
			path.join(workspace, 'dep.ts'),
			'export function target() { return 1; }\n',
		);
		fs.writeFileSync(
			path.join(workspace, 'caller.ts'),
			'import { target } from "./dep";\nexport function caller() { return target(); }\n',
		);

		const graph = await buildWorkspaceGraphAsync(workspace);
		const edge = graph.symbolEdges?.find(
			(candidate) =>
				candidate.fromFile.endsWith('caller.ts') &&
				candidate.toSymbol === 'target',
		) as (Record<string, unknown> & { evidence?: unknown[] }) | undefined;

		expect(edge).toBeDefined();
		expect(edge?.id).toMatch(/^[a-f0-9]{64}$/);
		expect(edge?.fromId).toMatch(/^[a-f0-9]{64}$/);
		expect(edge?.toId).toMatch(/^[a-f0-9]{64}$/);
		expect(edge?.kind).toBe('REFERENCES');
		expect(edge?.confidence).toBeGreaterThan(0);
		expect(edge?.confidence).toBeLessThanOrEqual(1);
		expect(edge?.resolution).toBe('import_binding');
		expect(edge?.evidence).toHaveLength(1);
		expect(edge?.evidence?.[0]).toEqual(
			expect.objectContaining({
				file: 'caller.ts',
				line: 2,
				extractor: 'tree-sitter/typescript',
			}),
		);
	});

	test('storage rejects a partially populated malformed v2 edge', async () => {
		const graphPath = path.join(workspace, '.swarm', 'repo-graph.json');
		fs.mkdirSync(path.dirname(graphPath), { recursive: true });
		const graph: RepoGraph = {
			schema_version: '1.5.0',
			workspaceRoot: workspace,
			nodes: {},
			edges: [],
			symbolEdges: [
				{
					fromFile: path.join(workspace, 'caller.ts'),
					fromSymbol: 'caller',
					toFile: path.join(workspace, 'dep.ts'),
					toSymbol: 'target',
					confidence: 2,
				} as RepoGraph['symbolEdges'][number],
			],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};
		fs.writeFileSync(graphPath, JSON.stringify(graph));

		await expect(loadGraph(workspace)).rejects.toThrow(
			'repo-graph.json contains invalid symbolEdges entry',
		);
	});

	test('graph health derives low-confidence and unresolved counts from edges', () => {
		const repoRootId = deriveRepoRootId(workspace);
		const edge = createSymbolEdgeV2(
			{
				fromFile: path.join(workspace, 'caller.ts'),
				fromSymbol: 'caller',
				toFile: path.join(workspace, 'dep.ts'),
				toSymbol: 'target',
			},
			workspace,
			repoRootId,
			{
				confidence: 0.25,
				resolution: 'unresolved',
				evidence: [],
			},
		);
		const graph: RepoGraph = {
			schema_version: '1.5.0',
			workspaceRoot: workspace,
			repoRootId,
			nodes: {},
			edges: [],
			symbolEdges: [edge],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};

		const health = getGraphHealth(graph) as unknown as Record<string, unknown>;
		expect(health.lowConfidenceEdgeCount).toBe(1);
		expect(health.unresolvedSymbolEdgeCount).toBe(1);
	});

	test('stable IDs normalize roots, separators, drive case, and Unicode without folding path case', () => {
		const windowsRoot = deriveRepoRootId('C:\\work\\cafe\u0301-repo');
		const posixRoot = deriveRepoRootId('/mnt/work/caf\u00e9-repo');
		expect(windowsRoot).toBe(posixRoot);

		const windowsId = createStableSymbolId(
			windowsRoot,
			'src\\caf\u00e9.ts',
			're\u0301sume\u0301',
			'symbol',
		);
		const posixId = createStableSymbolId(
			posixRoot,
			'src/caf\u00e9.ts',
			'r\u00e9sum\u00e9',
			'symbol',
		);
		expect(windowsId).toBe(posixId);
		expect(
			createStableSymbolId(
				posixRoot,
				'src/CAF\u00c9.ts',
				'r\u00e9sum\u00e9',
				'symbol',
			),
		).not.toBe(posixId);
	});

	test('snippet hashing is stable across CRLF/LF logical lines', () => {
		expect(hashSymbolEdgeSnippet('return target();\r')).toBe(
			hashSymbolEdgeSnippet('return target();'),
		);
	});

	test('duplicate evidence merges deterministically regardless of input order', () => {
		const repoRootId = deriveRepoRootId(workspace);
		const coordinates = {
			fromFile: path.join(workspace, 'caller.ts'),
			fromSymbol: 'caller',
			toFile: path.join(workspace, 'dep.ts'),
			toSymbol: 'target',
		};
		const evidenceA = {
			file: 'caller.ts',
			line: 2,
			snippetHash: hashSymbolEdgeSnippet('target();'),
			extractor: 'tree-sitter/typescript',
		};
		const evidenceB = { ...evidenceA, line: 4 };
		const a = createSymbolEdgeV2(coordinates, workspace, repoRootId, {
			confidence: 0.9,
			resolution: 'import_binding',
			evidence: [evidenceA],
		});
		const b = createSymbolEdgeV2(coordinates, workspace, repoRootId, {
			confidence: 0.8,
			resolution: 'import_binding',
			evidence: [evidenceB],
		});
		expect(mergeSymbolEdges(a, b, workspace, repoRootId)).toEqual(
			mergeSymbolEdges(b, a, workspace, repoRootId),
		);
	});

	test('equal-confidence duplicates choose resolution deterministically', () => {
		const repoRootId = deriveRepoRootId(workspace);
		const coordinates = {
			fromFile: path.join(workspace, 'caller.ts'),
			fromSymbol: 'caller',
			toFile: path.join(workspace, 'dep.ts'),
			toSymbol: 'target',
		};
		const unresolved = createSymbolEdgeV2(coordinates, workspace, repoRootId, {
			confidence: 0.9,
			resolution: 'unresolved',
			evidence: [],
		});
		const resolved = createSymbolEdgeV2(coordinates, workspace, repoRootId, {
			confidence: 0.9,
			resolution: 'import_binding',
			evidence: [],
		});

		const merged = mergeSymbolEdges(
			unresolved,
			resolved,
			workspace,
			repoRootId,
		);
		expect(merged.resolution).toBe('import_binding');
		expect(
			mergeSymbolEdges(resolved, unresolved, workspace, repoRootId),
		).toEqual(merged);
	});

	test('legacy edges remain traversable and unscored in health', () => {
		const caller = path.join(workspace, 'caller.ts');
		const dep = path.join(workspace, 'dep.ts');
		const graph: RepoGraph = {
			schema_version: '1.2.0',
			workspaceRoot: workspace,
			nodes: {
				[caller.replace(/\\/g, '/')]: {
					filePath: caller,
					moduleName: 'caller.ts',
					exports: ['caller'],
					exportRanges: { caller: { startLine: 1, endLine: 2 } },
					imports: ['./dep'],
					language: 'typescript',
					mtime: new Date(0).toISOString(),
				},
				[dep.replace(/\\/g, '/')]: {
					filePath: dep,
					moduleName: 'dep.ts',
					exports: ['target'],
					exportRanges: { target: { startLine: 1, endLine: 1 } },
					imports: [],
					language: 'typescript',
					mtime: new Date(0).toISOString(),
				},
			},
			edges: [],
			symbolEdges: [
				{
					fromFile: caller,
					fromSymbol: 'caller',
					toFile: dep,
					toSymbol: 'target',
				},
			],
			metadata: {
				generatedAt: new Date(0).toISOString(),
				generator: 'test',
				nodeCount: 2,
				edgeCount: 0,
			},
		};

		expect(getContextPack(graph, 'dep.ts', 'target').spans).toHaveLength(2);
		const health = getGraphHealth(graph);
		expect(health.lowConfidenceEdgeCount).toBe(0);
		expect(health.unresolvedSymbolEdgeCount).toBe(0);
		expect(
			health.notes.some((note) => note.includes('legacy symbol edge')),
		).toBe(true);
	});

	test('missing direct-reference line retains an honest unresolved edge', async () => {
		fs.writeFileSync(
			path.join(workspace, 'dep.ts'),
			'export const target = 1;\n',
		);
		fs.writeFileSync(
			path.join(workspace, 'caller.ts'),
			'import { target } from "./dep";\nexport const caller = target;\n',
		);
		builderInternals.extractFileSymbols = async (_grammar, content) =>
			content.includes('caller')
				? {
						defs: [
							{
								name: 'caller',
								kind: 'const',
								exported: true,
								startLine: 2,
								endLine: 2,
							},
						],
						imports: [
							{
								specifier: './dep',
								importType: 'named',
								bindings: [{ imported: 'target', local: 'target' }],
							},
						],
						refs: [{ identifier: 'target', enclosingDecl: 'caller' }],
					}
				: {
						defs: [
							{
								name: 'target',
								kind: 'const',
								exported: true,
								startLine: 1,
								endLine: 1,
							},
						],
						imports: [],
						refs: [],
					};

		const graph = await buildWorkspaceGraphAsync(workspace);
		const edge = graph.symbolEdges?.[0];
		expect(edge?.confidence).toBe(0);
		expect(edge?.resolution).toBe('unresolved');
		expect(edge?.evidence).toEqual([]);
	});
});

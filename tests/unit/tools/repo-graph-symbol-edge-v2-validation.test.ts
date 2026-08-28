import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	clearCache,
	getGraphHealth,
	loadGraph,
	type RepoGraph,
	saveGraph,
} from '../../../src/tools/repo-graph';
import {
	createSymbolEdgeV2,
	deriveRepoRootId,
	hashSymbolEdgeSnippet,
} from '../../../src/tools/repo-graph/symbol-edge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

type SymbolEdge = NonNullable<RepoGraph['symbolEdges']>[number];

describe('SymbolEdge v2 persistence validation — issue #1532', () => {
	let workspace: string;

	beforeEach(() => {
		workspace = canonicalMkdtemp('repo-graph-edge-v2-store-');
		fs.mkdirSync(path.join(workspace, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		clearCache(workspace);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	function coordinates(): Pick<
		SymbolEdge,
		'fromFile' | 'fromSymbol' | 'toFile' | 'toSymbol'
	> {
		return {
			fromFile: path.join(workspace, 'caller.ts'),
			fromSymbol: 'caller',
			toFile: path.join(workspace, 'dep.ts'),
			toSymbol: 'target',
		};
	}

	function graphWith(edge: SymbolEdge, schema = '1.5.0'): RepoGraph {
		return {
			schema_version: schema,
			workspaceRoot: workspace,
			repoRootId: deriveRepoRootId(workspace),
			nodes: {},
			edges: [],
			symbolEdges: [edge],
			metadata: {
				generatedAt: new Date(0).toISOString(),
				generator: 'test',
				nodeCount: 0,
				edgeCount: 0,
			},
		};
	}

	function validEdge(): SymbolEdge {
		return createSymbolEdgeV2(
			coordinates(),
			workspace,
			deriveRepoRootId(workspace),
			{
				confidence: 0.9,
				resolution: 'import_binding',
				evidence: [
					{
						file: 'caller.ts',
						line: 2,
						snippetHash: hashSymbolEdgeSnippet('target();'),
						extractor: 'tree-sitter/typescript',
					},
				],
			},
		);
	}

	function writeRaw(graph: RepoGraph): void {
		fs.writeFileSync(
			path.join(workspace, '.swarm', 'repo-graph.json'),
			JSON.stringify(graph),
		);
		clearCache(workspace);
	}

	test.each([
		['unknown kind', { kind: 'MAYBE' }],
		['unknown resolution', { resolution: 'guessed' }],
		['confidence below zero', { confidence: -0.1 }],
		['confidence above one', { confidence: 1.1 }],
		['shape-valid mismatched edge id', { id: 'a'.repeat(64) }],
		['shape-valid mismatched source id', { fromId: 'b'.repeat(64) }],
		[
			'unsafe evidence path',
			{
				evidence: [
					{
						file: '../escape.ts',
						line: 1,
						snippetHash: 'c'.repeat(64),
						extractor: 'test',
					},
				],
			},
		],
		[
			'invalid evidence line',
			{
				evidence: [
					{
						file: 'caller.ts',
						line: 0,
						snippetHash: 'c'.repeat(64),
						extractor: 'test',
					},
				],
			},
		],
		[
			'invalid evidence hash',
			{
				evidence: [
					{
						file: 'caller.ts',
						line: 1,
						snippetHash: 'nope',
						extractor: 'test',
					},
				],
			},
		],
	] as const)('load rejects %s', async (_name, mutation) => {
		const edge = { ...validEdge(), ...mutation } as unknown as SymbolEdge;
		writeRaw(graphWith(edge));
		await expect(loadGraph(workspace)).rejects.toThrow(
			'repo-graph.json contains invalid symbolEdges entry',
		);
	});

	test('load rejects a partial v2 record', async () => {
		const partial = { ...coordinates(), confidence: 0.5 } as SymbolEdge;
		writeRaw(graphWith(partial));
		await expect(loadGraph(workspace)).rejects.toThrow(
			'repo-graph.json contains invalid symbolEdges entry',
		);
	});

	test('save rejects a shape-valid but semantically inconsistent ID before writing', async () => {
		const edge = { ...validEdge(), toId: 'd'.repeat(64) };
		await expect(saveGraph(workspace, graphWith(edge))).rejects.toThrow(
			'repo-graph.json contains invalid symbolEdges entry',
		);
		expect(
			fs.existsSync(path.join(workspace, '.swarm', 'repo-graph.json')),
		).toBe(false);
	});

	test('confidence and provenance survive save/load unchanged', async () => {
		const edge = validEdge();
		await saveGraph(workspace, graphWith(edge));
		clearCache(workspace);
		const loaded = await loadGraph(workspace);
		expect(loaded?.symbolEdges?.[0]).toEqual(edge);
	});

	test('schema 1.2 legacy graph derives root identity and survives explicit save/reload', async () => {
		const legacy: SymbolEdge = coordinates();
		const graph = graphWith(legacy, '1.2.0');
		delete graph.repoRootId;
		writeRaw(graph);

		const loaded = await loadGraph(workspace);
		expect(loaded?.schema_version).toBe('1.2.0');
		expect(loaded?.repoRootId).toBe(deriveRepoRootId(workspace));
		expect(loaded?.symbolEdges?.[0]).toEqual(
			expect.objectContaining(coordinates()),
		);
		expect(loaded?.symbolEdges?.[0].resolution).toBeUndefined();
		expect(
			getGraphHealth(loaded!).notes.some((note) =>
				note.includes('legacy symbol edge'),
			),
		).toBe(true);
		if (!loaded) throw new Error('expected legacy graph');

		await saveGraph(workspace, loaded);
		clearCache(workspace);
		const reloaded = await loadGraph(workspace);
		expect(reloaded?.schema_version).toBe('1.2.0');
		expect(reloaded?.repoRootId).toBe(deriveRepoRootId(workspace));
		expect(reloaded?.symbolEdges?.[0]).toEqual(loaded.symbolEdges?.[0]);
	});

	test('load binds workspaceRoot and repoRootId to the active workspace', async () => {
		const graph = graphWith(validEdge());
		graph.workspaceRoot = path.relative(process.cwd(), workspace);
		graph.repoRootId = 'forged-root';
		writeRaw(graph);

		const loaded = await loadGraph(workspace);
		expect(loaded?.workspaceRoot).toBe(workspace);
		expect(loaded?.repoRootId).toBe(deriveRepoRootId(workspace));
	});

	test('load rejects a graph whose persisted workspaceRoot targets another workspace', async () => {
		const foreignWorkspace = canonicalMkdtemp('repo-graph-edge-v2-foreign-');
		try {
			const graph = graphWith(validEdge());
			graph.workspaceRoot = foreignWorkspace;
			writeRaw(graph);
			await expect(loadGraph(workspace)).rejects.toThrow(
				'repo-graph.json workspaceRoot mismatch',
			);
		} finally {
			fs.rmSync(foreignWorkspace, { recursive: true, force: true });
		}
	});

	test('createSymbolEdgeV2 accepts exact schema boundaries', () => {
		const repoRootId = deriveRepoRootId(workspace);
		const exactFilePath = `${workspace}${path.sep}${'f'.repeat(
			4096 - workspace.length - path.sep.length,
		)}`;
		const edge = createSymbolEdgeV2(
			{
				fromFile: exactFilePath,
				fromSymbol: 's'.repeat(512),
				toFile: path.join(workspace, 'dep.ts'),
				toSymbol: 't'.repeat(512),
			},
			workspace,
			repoRootId,
			{
				confidence: 1,
				resolution: 'import_binding',
				evidence: [
					{
						file: 'e'.repeat(1024),
						line: 1,
						snippetHash: 'a'.repeat(64),
						extractor: 'x'.repeat(128),
					},
				],
			},
		);
		expect(edge.fromSymbol).toHaveLength(512);
		expect(edge.toSymbol).toHaveLength(512);
		expect(edge.fromFile.length).toBe(4096);
		expect(edge.evidence[0]?.file).toHaveLength(1024);
		expect(edge.evidence[0]?.extractor).toHaveLength(128);
	});

	test.each([
		[
			'symbol over 512 chars',
			() => ({
				fromSymbol: 's'.repeat(513),
			}),
			'invalid fromSymbol',
		],
		[
			'path over 4096 chars',
			() => ({
				fromFile: `${workspace}${path.sep}${'f'.repeat(
					4097 - workspace.length - path.sep.length,
				)}`,
			}),
			'invalid fromFile',
		],
		[
			'evidence path over 1024 chars',
			() => ({
				evidence: [
					{
						file: 'e'.repeat(1025),
						line: 1,
						snippetHash: 'a'.repeat(64),
						extractor: 'test',
					},
				],
			}),
			'invalid evidence entry',
		],
		[
			'extractor over 128 chars',
			() => ({
				evidence: [
					{
						file: 'caller.ts',
						line: 1,
						snippetHash: 'a'.repeat(64),
						extractor: 'x'.repeat(129),
					},
				],
			}),
			'invalid evidence entry',
		],
		[
			'too many evidence entries',
			() => ({
				evidence: Array.from({ length: 17 }, (_, index) => ({
					file: `caller-${index}.ts`,
					line: 1,
					snippetHash: 'a'.repeat(64),
					extractor: 'test',
				})),
			}),
			'invalid evidence',
		],
		[
			'NaN confidence',
			() => ({ confidence: Number.NaN }),
			'invalid symbol edge confidence',
		],
	] as const)('createSymbolEdgeV2 rejects %s', (_name, mutation, message) => {
		const repoRootId = deriveRepoRootId(workspace);
		expect(() =>
			createSymbolEdgeV2(coordinates(), workspace, repoRootId, {
				confidence: 0.9,
				resolution: 'import_binding',
				evidence: [],
				...mutation(),
			}),
		).toThrow(message);
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	clearCache,
	loadGraph,
	type RepoGraph,
	saveGraph,
} from '../../../src/tools/repo-graph';
import {
	createSymbolEdgeV2,
	deriveRepoRootId,
	hashSymbolEdgeSnippet,
} from '../../../src/tools/repo-graph/symbol-edge';

type SymbolEdge = NonNullable<RepoGraph['symbolEdges']>[number];

describe('SymbolEdge v2 persistence validation — issue #1532', () => {
	let workspace: string;

	beforeEach(() => {
		workspace = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'repo-graph-edge-v2-store-')),
		);
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
		expect(loaded?.symbolEdges?.[0].resolution).toBe('unresolved');
		if (!loaded) throw new Error('expected legacy graph');

		await saveGraph(workspace, loaded);
		clearCache(workspace);
		const reloaded = await loadGraph(workspace);
		expect(reloaded?.schema_version).toBe('1.2.0');
		expect(reloaded?.repoRootId).toBe(deriveRepoRootId(workspace));
		expect(reloaded?.symbolEdges?.[0]).toEqual(loaded.symbolEdges?.[0]);
	});
});

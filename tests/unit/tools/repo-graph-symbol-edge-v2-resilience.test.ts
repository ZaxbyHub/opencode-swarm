import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	buildWorkspaceGraphAsync,
	clearCache,
	loadGraph,
	saveGraph,
	updateGraphForFiles,
} from '../../../src/tools/repo-graph';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';
import { REPO_GRAPH_FINGERPRINT_FILENAME } from '../../../src/tools/repo-graph/freshness';
import { _internals as incrementalInternals } from '../../../src/tools/repo-graph/incremental';
import {
	createSymbolEdgeV2,
	deriveRepoRootId,
	hashSymbolEdgeSnippet,
} from '../../../src/tools/repo-graph/symbol-edge';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('SymbolEdge v2 resilience — issue #1532 review findings', () => {
	let workspace: string;
	let originalExtractFileSymbols: typeof builderInternals.extractFileSymbols;
	let originalIncrementalScanFileAsync: typeof incrementalInternals.scanFileAsync;

	beforeEach(() => {
		workspace = canonicalMkdtemp('repo-graph-edge-v2-resilience-');
		originalExtractFileSymbols = builderInternals.extractFileSymbols;
		originalIncrementalScanFileAsync = incrementalInternals.scanFileAsync;
	});

	afterEach(() => {
		builderInternals.extractFileSymbols = originalExtractFileSymbols;
		incrementalInternals.scanFileAsync = originalIncrementalScanFileAsync;
		clearCache(workspace);
		fs.rmSync(workspace, { recursive: true, force: true });
	});

	function write(relPath: string, content: string): string {
		const full = path.join(workspace, relPath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
		return full;
	}

	test('async builder keeps valid nodes and records a diagnostic when one symbol edge is malformed', async () => {
		write('dep.ts', 'export function target() { return 1; }\n');
		write(
			'caller.ts',
			'import { target } from "./dep";\nexport function caller() { return target(); }\n',
		);
		originalExtractFileSymbols = builderInternals.extractFileSymbols;
		builderInternals.extractFileSymbols = async (grammar, content) => {
			const facts = await originalExtractFileSymbols(grammar, content);
			if (!content.includes('export function caller')) {
				return facts;
			}
			if (!facts) return facts;
			return {
				...facts,
				imports: [
					{
						...facts.imports[0],
						bindings: [{ imported: 'x'.repeat(513), local: 'target' }],
					},
				],
			};
		};

		const graph = await buildWorkspaceGraphAsync(workspace);
		expect(Object.keys(graph.nodes)).toHaveLength(2);
		expect(graph.symbolEdges ?? []).toHaveLength(0);
		expect(graph.edges).toContainEqual(
			expect.objectContaining({ importSpecifier: './dep' }),
		);
		expect(graph.diagnostics?.extractionFailures).toContainEqual({
			file: 'caller.ts',
			language: 'typescript',
			reason: 'symbol_edge_validation_failed',
		});
	});

	test('incremental update persists/fingerprints the graph when a malformed symbol edge is skipped', async () => {
		const depPath = write('dep.ts', 'export function target() { return 1; }\n');
		const callerPath = write(
			'caller.ts',
			'import { target } from "./dep";\nexport function caller() { return target(); }\n',
		);
		await saveGraph(workspace, await buildWorkspaceGraphAsync(workspace));

		fs.writeFileSync(
			callerPath,
			'import { target } from "./dep";\nexport function caller() { return target() + 1; }\n',
		);
		builderInternals.extractFileSymbols = async (grammar, content) => {
			const facts = await originalExtractFileSymbols(grammar, content);
			if (!content.includes('target() + 1')) {
				return facts;
			}
			if (!facts) return facts;
			return {
				...facts,
				refs: [
					{ identifier: 'target', enclosingDecl: 'x'.repeat(513), line: 2 },
				],
			};
		};

		const updated = await updateGraphForFiles(workspace, [callerPath]);
		expect(Object.keys(updated.nodes)).toHaveLength(2);
		expect(updated.edges).toContainEqual(
			expect.objectContaining({ source: callerPath, target: depPath }),
		);
		expect(updated.symbolEdges ?? []).toHaveLength(0);
		expect(updated.diagnostics?.extractionFailures).toContainEqual({
			file: 'caller.ts',
			language: 'typescript',
			reason: 'symbol_edge_validation_failed',
		});
		expect(
			fs.existsSync(
				path.join(workspace, '.swarm', REPO_GRAPH_FINGERPRINT_FILENAME),
			),
		).toBe(true);
		const reloaded = await loadGraph(workspace);
		expect(reloaded?.diagnostics?.extractionFailures).toContainEqual({
			file: 'caller.ts',
			language: 'typescript',
			reason: 'symbol_edge_validation_failed',
		});
	});

	test('incremental update merges duplicate incoming v2 edges and preserves both evidence records', async () => {
		write('dep.ts', 'export function target() { return 1; }\n');
		const callerPath = write(
			'caller.ts',
			'import { target } from "./dep";\nexport function caller() { return target(); }\n',
		);
		await saveGraph(workspace, await buildWorkspaceGraphAsync(workspace));

		const realScanFileAsync = originalIncrementalScanFileAsync;
		incrementalInternals.scanFileAsync = async (
			filePath,
			absoluteRoot,
			maxFileSize,
			hasManifest,
			repoRootId,
		) => {
			const scanned = await realScanFileAsync(
				filePath,
				absoluteRoot,
				maxFileSize,
				hasManifest,
				repoRootId,
			);
			if (!filePath.endsWith('caller.ts')) {
				return scanned;
			}
			const resolvedRepoRootId = repoRootId ?? deriveRepoRootId(absoluteRoot);
			const coordinates = {
				fromFile: callerPath,
				fromSymbol: 'caller',
				toFile: path.join(workspace, 'dep.ts'),
				toSymbol: 'target',
			};
			return {
				...scanned,
				symbolEdges: [
					createSymbolEdgeV2(coordinates, absoluteRoot, resolvedRepoRootId, {
						confidence: 0.9,
						resolution: 'import_binding',
						evidence: [
							{
								file: 'caller.ts',
								line: 2,
								snippetHash: hashSymbolEdgeSnippet('return target();'),
								extractor: 'tree-sitter/typescript',
							},
						],
					}),
					createSymbolEdgeV2(coordinates, absoluteRoot, resolvedRepoRootId, {
						confidence: 0.8,
						resolution: 'import_binding',
						evidence: [
							{
								file: 'caller.ts',
								line: 3,
								snippetHash: hashSymbolEdgeSnippet('return target();'),
								extractor: 'tree-sitter/typescript',
							},
						],
					}),
				],
			};
		};

		const updated = await updateGraphForFiles(workspace, [callerPath]);
		const edge = updated.symbolEdges?.find(
			(candidate) =>
				candidate.fromFile === callerPath && candidate.toSymbol === 'target',
		);
		expect(edge).toBeDefined();
		expect(edge?.evidence.map((entry) => entry.line)).toEqual([2, 3]);
	});

	test('incremental update replaces a legacy source edge instead of duplicating it', async () => {
		// Before the fix, a schema-1.2 edge was excluded from the v2 ID index and
		// remained beside the newly extracted v2 edge after the source file changed.
		const depPath = write('dep.ts', 'export function target() { return 1; }\n');
		const callerPath = write(
			'caller.ts',
			'import { target } from "./dep";\nexport function caller() { return target(); }\n',
		);
		const graph = await buildWorkspaceGraphAsync(workspace);
		const generated = graph.symbolEdges?.find(
			(edge) => edge.fromFile === callerPath && edge.toFile === depPath,
		);
		expect(generated).toBeDefined();
		if (!generated) throw new Error('expected generated symbol edge');
		graph.schema_version = '1.2.0';
		graph.symbolEdges = [
			{
				fromFile: generated.fromFile,
				fromSymbol: generated.fromSymbol,
				toFile: generated.toFile,
				toSymbol: generated.toSymbol,
			},
		];
		await saveGraph(workspace, graph);

		fs.writeFileSync(
			callerPath,
			'import { target } from "./dep";\nexport function caller() { return target() + 1; }\n',
		);
		const updated = await updateGraphForFiles(workspace, [callerPath]);
		const callerEdges = (updated.symbolEdges ?? []).filter(
			(edge) => edge.fromFile === callerPath,
		);
		expect(callerEdges).toHaveLength(1);
		expect(callerEdges[0]).toEqual(
			expect.objectContaining({
				id: expect.stringMatching(/^[a-f0-9]{64}$/),
				confidence: expect.any(Number),
			}),
		);
	});
});

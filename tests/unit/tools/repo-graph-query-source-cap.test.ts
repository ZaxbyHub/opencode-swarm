import { beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	DEFAULT_MAX_SOURCE_BYTES,
	type GraphNode,
	getContextPack,
	normalizeGraphPath,
	type RepoGraph,
	resetQueryCache,
} from '../../../src/tools/repo-graph';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Regression coverage for the query-time source-read cap (issue #2399):
// getContextPack must never load graph-referenced files above the shared
// 1 MiB ceiling, while files at or under the cap keep reading normally.

function tempGraphNode(
	tempRoot: string,
	rel: string,
	symbol: string,
	startLine = 2,
): GraphNode {
	const abs = normalizeGraphPath(path.join(tempRoot, rel));
	return {
		filePath: abs,
		moduleName: rel,
		exports: [symbol],
		exportRanges: { [symbol]: { startLine, endLine: startLine } },
		imports: [],
		language: 'typescript',
		mtime: '1',
		ontology: {
			roles: ['source_module'],
			packageBoundary: 'root',
			routes: [],
			dataOperations: [],
			security: [],
			conventions: [],
			findings: [],
		},
	};
}

describe('getContextPack source-read cap', () => {
	beforeEach(() => {
		resetQueryCache();
	});

	test('include_source skips graph-referenced files above the query read cap', () => {
		const tempRoot = canonicalMkdtemp('repo-graph-query-cap-');
		try {
			const rel = 'large.ts';
			const abs = normalizeGraphPath(path.join(tempRoot, rel));
			writeFileSync(
				path.join(tempRoot, rel),
				`${'x'.repeat(1024 * 1024 + 1)}\nexport const huge = 1;\n`,
				'utf-8',
			);

			const graph: RepoGraph = {
				schema_version: '1.2.0',
				workspaceRoot: tempRoot,
				nodes: {
					[abs]: {
						filePath: abs,
						moduleName: rel,
						exports: ['huge'],
						exportRanges: { huge: { startLine: 2, endLine: 2 } },
						imports: [],
						language: 'typescript',
						mtime: '1',
						ontology: {
							roles: ['source_module'],
							packageBoundary: 'root',
							routes: [],
							dataOperations: [],
							security: [],
							conventions: [],
							findings: [],
						},
					},
				},
				edges: [],
				metadata: {
					generatedAt: '2026-01-01T00:00:00.000Z',
					generator: 'test',
					nodeCount: 1,
					edgeCount: 0,
				},
			};

			const result = getContextPack(graph, rel, 'huge', {
				includeSource: true,
			});

			expect(result.spans[0]).toMatchObject({
				file: abs,
				symbol: 'huge',
				note: 'source too large',
			});
			expect(result.snippets).toEqual([]);
			expect(result.warnings).toContain('source too large for large.ts:huge');
			// Result-shape pins (review finding PRR-011a): the oversized span is
			// admitted without text and keeps its line-count token estimate.
			expect(result.truncated).toBe(false);
			expect(result.coverage.returnedSymbols).toBe(1);
			expect(result.estimatedTokens).toBeGreaterThan(0);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('include_source still reads a file at exactly the cap boundary', () => {
		const tempRoot = canonicalMkdtemp('repo-graph-query-cap-');
		try {
			const rel = 'boundary.ts';
			const graphNode = tempGraphNode(tempRoot, rel, 'boundary');
			// Pad so the total byte size is exactly the cap (guard is strict `>`).
			const suffix = '\nexport const boundary = 1;\n';
			writeFileSync(
				path.join(tempRoot, rel),
				`${'x'.repeat(DEFAULT_MAX_SOURCE_BYTES - suffix.length)}${suffix}`,
				'utf-8',
			);
			expect(statSync(path.join(tempRoot, rel)).size).toBe(
				DEFAULT_MAX_SOURCE_BYTES,
			);

			const graph: RepoGraph = {
				schema_version: '1.2.0',
				workspaceRoot: tempRoot,
				nodes: { [graphNode.filePath]: graphNode },
				edges: [],
				metadata: {
					generatedAt: '2026-01-01T00:00:00.000Z',
					generator: 'test',
					nodeCount: 1,
					edgeCount: 0,
				},
			};

			const result = getContextPack(graph, rel, 'boundary', {
				includeSource: true,
			});

			expect(result.spans[0]).toMatchObject({
				file: graphNode.filePath,
				symbol: 'boundary',
			});
			expect(result.spans[0]?.note).toBeUndefined();
			expect(result.spans[0]?.text).toBe('export const boundary = 1;');
			expect(result.snippets).toHaveLength(1);
			expect(
				result.warnings.some((warning) => warning.includes('source too large')),
			).toBe(false);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('include_source packs a successfully read target alongside an oversized neighbor', () => {
		const tempRoot = canonicalMkdtemp('repo-graph-query-cap-');
		try {
			const small = tempGraphNode(tempRoot, 'small.ts', 'small', 1);
			const large = tempGraphNode(tempRoot, 'large.ts', 'huge');
			writeFileSync(
				path.join(tempRoot, 'small.ts'),
				'export const small = 1;\n',
				'utf-8',
			);
			writeFileSync(
				path.join(tempRoot, 'large.ts'),
				`${'x'.repeat(DEFAULT_MAX_SOURCE_BYTES + 1)}\nexport const huge = 1;\n`,
				'utf-8',
			);

			const graph: RepoGraph = {
				schema_version: '1.2.0',
				workspaceRoot: tempRoot,
				nodes: { [small.filePath]: small, [large.filePath]: large },
				edges: [],
				symbolEdges: [
					{
						fromFile: small.filePath,
						fromSymbol: 'small',
						toFile: large.filePath,
						toSymbol: 'huge',
					},
				],
				metadata: {
					generatedAt: '2026-01-01T00:00:00.000Z',
					generator: 'test',
					nodeCount: 2,
					edgeCount: 0,
				},
			};

			const result = getContextPack(graph, 'small.ts', 'small', {
				includeSource: true,
			});

			expect(result.coverage.returnedSymbols).toBe(2);
			const smallSpan = result.spans.find((span) => span.symbol === 'small');
			const hugeSpan = result.spans.find((span) => span.symbol === 'huge');
			expect(smallSpan?.text).toBe('export const small = 1;');
			expect(smallSpan?.note).toBeUndefined();
			expect(hugeSpan?.note).toBe('source too large');
			expect(hugeSpan?.text).toBeUndefined();
			expect(result.snippets).toHaveLength(1);
			expect(result.snippets[0]?.file).toBe(small.filePath);
			expect(result.warnings).toContain('source too large for large.ts:huge');
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

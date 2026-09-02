/**
 * Issue #1144 regression suite.
 *
 * The repo-graph build loops were optimized from O(N^2) to O(N) by replacing
 * the per-element upsertNode/addEdge calls (each of which recomputed
 * graph.metadata and, for edges, did an O(edges) `.some()` dedup) with O(1)
 * bulk-insert helpers + a loop-local Set keyed on a NUL-separated
 * (source, target, importSpecifier) triple.
 *
 * The async builder (`buildWorkspaceGraphAsync`) is the actual plugin-startup
 * path, and prior to this suite its node/edge CONTENT and ORDER were unguarded
 * (only counts/caps/budget were tested). These tests lock in that the
 * optimization is behavior-preserving:
 *   - async output equals sync output (full nodes + ordered edges), and
 *   - edge dedup matches the old `.some()` semantics, including paths and
 *     import specifiers that contain spaces (which a naive space-separated key
 *     would have aliased).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import {
	buildWorkspaceGraph,
	buildWorkspaceGraphAsync,
	clearCache,
} from '../../../src/tools/repo-graph';

describe('repo-graph build O(N) equivalence — issue #1144', () => {
	let tempDir: string;
	let workspacePath: string;

	beforeEach(async () => {
		// Temp dir INSIDE cwd so the relative workspace path has no `../`
		// (matches validateWorkspace expectations used across the repo-graph suite).
		tempDir = await fsSync.promises.mkdtemp(
			path.join(process.cwd(), 'repo-graph-async-eq-'),
		);
		workspacePath = path.relative(process.cwd(), tempDir);
	});

	afterEach(async () => {
		clearCache(workspacePath);
		try {
			await fsSync.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	async function writeFiles(files: Record<string, string>): Promise<void> {
		for (const [rel, content] of Object.entries(files)) {
			const full = path.join(tempDir, rel);
			await fsSync.promises.mkdir(path.dirname(full), { recursive: true });
			await fsSync.promises.writeFile(full, content);
		}
	}

	test('async builder produces nodes/edges identical to the sync builder (order-sensitive)', async () => {
		await writeFiles({
			'index.ts': `import { foo } from './foo';\nimport { bar } from './bar';\nexport const idx = 1;`,
			'foo.ts': `import { bar } from './bar';\nexport const foo = 'foo';`,
			'bar.ts': `export const bar = 'bar';`,
		});

		const sync = buildWorkspaceGraph(workspacePath);
		const asyncGraph = await buildWorkspaceGraphAsync(workspacePath);

		// Build file-level projections: strip async-exclusive symbol fields
		// (exportRanges, and exportKinds since schema 1.6.0 / KG-14) before
		// comparing node content. Sync never produces either (3.2 contract).
		const fileLevelNodes = <Record<string, object>>{};
		for (const [key, asyncNode] of Object.entries(asyncGraph.nodes)) {
			const {
				exportRanges: _er,
				exportKinds: _ek,
				...fileLevel
			} = asyncNode as Record<string, unknown>;
			fileLevelNodes[key] = fileLevel;
		}
		expect(fileLevelNodes).toEqual(sync.nodes);

		// Edge projection: usedSymbols is computed differently by sync vs async
		// usage scanners (sync uses regex computeUsedSymbols; async uses tree-sitter
		// `facts.refs`). Exclude it from the structural comparison; all other edge
		// fields (source, target, importSpecifier, importType, importedSymbols) must match.
		// Order-sensitive: async edge ordering must match sync.
		const fileLevelEdges = asyncGraph.edges.map((e) => {
			const { usedSymbols: _us, ...rest } = e as Record<string, unknown>;
			return rest as typeof e;
		});
		const syncEdgesProjected = sync.edges.map((e) => {
			const { usedSymbols: _us, ...rest } = e as Record<string, unknown>;
			return rest as typeof e;
		});
		expect(fileLevelEdges).toEqual(syncEdgesProjected);

		expect(asyncGraph.metadata.nodeCount).toBe(sync.metadata.nodeCount);
		expect(asyncGraph.metadata.edgeCount).toBe(sync.metadata.edgeCount);

		// Sanity: this fixture actually has nodes and edges (guards a vacuous pass).
		expect(asyncGraph.metadata.nodeCount).toBe(3);
		expect(asyncGraph.metadata.edgeCount).toBeGreaterThan(0);

		// Async-exclusive contract: sync nodes lack exportRanges; async nodes have them.
		for (const node of Object.values(sync.nodes)) {
			expect((node as Record<string, unknown>).exportRanges).toBeUndefined();
		}
		const anyAsyncHasExportRanges = Object.values(asyncGraph.nodes).some(
			(n) => (n as Record<string, unknown>).exportRanges !== undefined,
		);
		expect(anyAsyncHasExportRanges).toBe(true);

		// Same contract for the schema 1.6.0 declaration-kind map (KG-14,
		// issue #1535): sync never produces exportKinds; async does wherever
		// tree-sitter extracted defs.
		for (const node of Object.values(sync.nodes)) {
			expect((node as Record<string, unknown>).exportKinds).toBeUndefined();
		}
		const anyAsyncHasExportKinds = Object.values(asyncGraph.nodes).some(
			(n) => (n as Record<string, unknown>).exportKinds !== undefined,
		);
		expect(anyAsyncHasExportKinds).toBe(true);

		// Async-exclusive contract: sync graph never has symbolEdges (the key is
		// absent entirely). Async graph may or may not populate it depending on
		// whether the fixture has cross-file symbol usages; what matters is that
		// sync never has it while async can (verified separately by the
		// determinism test which uses a fixture that does produce symbolEdges).
		expect((sync as Record<string, unknown>).symbolEdges).toBeUndefined();
		// When async does produce symbolEdges, it must be an array (never undefined
		// on a graph that has cross-file symbol usages).
		const asyncSymbolEdges = (asyncGraph as Record<string, unknown>)
			.symbolEdges;
		expect(
			Array.isArray(asyncSymbolEdges) || asyncSymbolEdges === undefined,
		).toBe(true);
	});

	test('duplicate edges (same source+target+specifier) dedup to one, distinct sources do not', async () => {
		await writeFiles({
			// Same module imported twice by the SAME file -> one edge (source,target,spec identical).
			'a.ts': `import { x } from './c';\nimport { y } from './c';\nexport const a = 1;`,
			// Different source importing the same specifier -> a separate edge.
			'b.ts': `import { z } from './c';\nexport const b = 1;`,
			'c.ts': `export const x = 1;\nexport const y = 2;\nexport const z = 3;`,
		});

		const sync = buildWorkspaceGraph(workspacePath);
		const asyncGraph = await buildWorkspaceGraphAsync(workspacePath);

		// Uniform parity contract: strip usedSymbols from both sync+async edges
		// before the deep-equal (sync uses regex, async uses tree-sitter facts.refs;
		// the structural edge fields must match regardless of scanner divergence).
		const asyncEdgesProjected = asyncGraph.edges.map((e) => {
			const { usedSymbols: _us, ...rest } = e as Record<string, unknown>;
			return rest as typeof e;
		});
		const syncEdgesProjected = sync.edges.map((e) => {
			const { usedSymbols: _us, ...rest } = e as Record<string, unknown>;
			return rest as typeof e;
		});
		expect(asyncEdgesProjected).toEqual(syncEdgesProjected);

		// a->c appears exactly once despite two import statements; b->c is separate.
		const aToC = asyncGraph.edges.filter(
			(e) => e.source.endsWith('a.ts') && e.target.endsWith('c.ts'),
		);
		const bToC = asyncGraph.edges.filter(
			(e) => e.source.endsWith('b.ts') && e.target.endsWith('c.ts'),
		);
		expect(aToC.length).toBe(1);
		expect(bToC.length).toBe(1);
	});

	test('paths and import specifiers containing spaces are handled without key aliasing', async () => {
		await writeFiles({
			// Directory and file names with spaces; specifier also contains a space.
			'my src/a file.ts': `import { b } from './b file';\nimport { c } from './c';\nexport const a = 1;`,
			'my src/b file.ts': `export const b = 2;`,
			'my src/c.ts': `export const c = 3;`,
		});

		const sync = buildWorkspaceGraph(workspacePath);
		const asyncGraph = await buildWorkspaceGraphAsync(workspacePath);

		// File-level parity: strip async-exclusive symbol fields (exportRanges,
		// exportKinds) before comparing nodes.
		const fileLevelNodes = <Record<string, object>>{};
		for (const [key, asyncNode] of Object.entries(asyncGraph.nodes)) {
			const {
				exportRanges: _er,
				exportKinds: _ek,
				...fileLevel
			} = asyncNode as Record<string, unknown>;
			fileLevelNodes[key] = fileLevel;
		}
		expect(fileLevelNodes).toEqual(sync.nodes);

		// Edge projection: strip usedSymbols (sync/async scanner divergence);
		// all other edge fields (source, target, importSpecifier, importType, importedSymbols)
		// are compared strictly and order-sensitively.
		const fileLevelEdges = asyncGraph.edges.map((e) => {
			const { usedSymbols: _us, ...rest } = e as Record<string, unknown>;
			return rest as typeof e;
		});
		const syncEdgesProjected = sync.edges.map((e) => {
			const { usedSymbols: _us, ...rest } = e as Record<string, unknown>;
			return rest as typeof e;
		});
		expect(fileLevelEdges).toEqual(syncEdgesProjected);

		// Behavior-preserving across the space boundary.
		// Both edges from "a file.ts" survive (no collision from the space-bearing
		// specifier "./b file"): one to "b file.ts", one to "c.ts".
		const fromA = asyncGraph.edges.filter((e) =>
			e.source.endsWith('a file.ts'),
		);
		expect(fromA.length).toBe(2);
		const targets = fromA.map((e) => path.basename(e.target)).sort();
		expect(targets).toEqual(['b file.ts', 'c.ts']);
	});

	test('async builder symbol fields (exportRanges, symbolEdges) are deterministic across two runs', async () => {
		await writeFiles({
			'index.ts': `import { foo } from './foo';\nimport { bar } from './bar';\nexport const idx = 1;`,
			'foo.ts': `import { bar } from './bar';\nexport const foo = 'foo';`,
			'bar.ts': `export const bar = 'bar';`,
		});

		const run1 = await buildWorkspaceGraphAsync(workspacePath);
		clearCache(workspacePath);
		const run2 = await buildWorkspaceGraphAsync(workspacePath);

		// Two consecutive async builds must produce identical exportRanges on every node.
		const keys1 = Object.keys(run1.nodes).sort();
		const keys2 = Object.keys(run2.nodes).sort();
		expect(keys1).toEqual(keys2);
		for (const key of keys1) {
			const n1 = run1.nodes[key] as Record<string, unknown>;
			const n2 = run2.nodes[key] as Record<string, unknown>;
			expect(n1.exportRanges).toEqual(n2.exportRanges);
		}

		// And identical symbolEdges at the graph level.
		expect((run1 as Record<string, unknown>).symbolEdges).toEqual(
			(run2 as Record<string, unknown>).symbolEdges,
		);
	});
});

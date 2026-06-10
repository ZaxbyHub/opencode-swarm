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

		// Full node map equality (keys + node objects incl. exports/imports/mtime).
		expect(asyncGraph.nodes).toEqual(sync.nodes);
		// Full edge array equality, order-sensitive (toEqual compares array order).
		expect(asyncGraph.edges).toEqual(sync.edges);
		expect(asyncGraph.metadata.nodeCount).toBe(sync.metadata.nodeCount);
		expect(asyncGraph.metadata.edgeCount).toBe(sync.metadata.edgeCount);

		// Sanity: this fixture actually has nodes and edges (guards a vacuous pass).
		expect(asyncGraph.metadata.nodeCount).toBe(3);
		expect(asyncGraph.metadata.edgeCount).toBeGreaterThan(0);
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

		expect(asyncGraph.edges).toEqual(sync.edges);

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

		// Behavior-preserving across the space boundary.
		expect(asyncGraph.nodes).toEqual(sync.nodes);
		expect(asyncGraph.edges).toEqual(sync.edges);

		// Both edges from "a file.ts" survive (no collision from the space-bearing
		// specifier "./b file"): one to "b file.ts", one to "c.ts".
		const fromA = asyncGraph.edges.filter((e) =>
			e.source.endsWith('a file.ts'),
		);
		expect(fromA.length).toBe(2);
		const targets = fromA.map((e) => path.basename(e.target)).sort();
		expect(targets).toEqual(['b file.ts', 'c.ts']);
	});
});

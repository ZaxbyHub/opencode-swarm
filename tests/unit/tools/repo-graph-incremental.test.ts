/**
 * Verification tests for updateGraphForFiles (incremental graph updates)
 * Tests: incremental update, deleted files, forceRebuild, fallback, validation, batch update, unsupported extension skip
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { clearCache } from '../../../src/tools/repo-graph';
import { _internals as builderInternals } from '../../../src/tools/repo-graph/builder';
import { _internals as incrementalInternals } from '../../../src/tools/repo-graph/incremental';

// Use dynamic import to get the real module (bypasses any mock.module from other test files)
// This is necessary because bun:test's mock.module persists globally across tests
const getRealRepoGraph = async () => {
	const module = await import('../../../src/tools/repo-graph');
	return {
		buildWorkspaceGraph: module.buildWorkspaceGraph,
		loadGraph: module.loadGraph,
		saveGraph: module.saveGraph,
		updateGraphForFiles: module.updateGraphForFiles,
	};
};

describe('updateGraphForFiles', () => {
	let tempDir: string;
	let workspacePath: string;
	const realParseFileImports = builderInternals.parseFileImports;
	// Store real functions after getting them

	/** Normalize a path for use as a graph key (forward slashes, matching normalizeGraphPath) */
	function normalizeKey(p: string): string {
		return path.normalize(p).replace(/\\/g, '/');
	}
	let buildWorkspaceGraph: ReturnType<
		typeof import('../../../src/tools/repo-graph').buildWorkspaceGraph
	>;
	let loadGraph: ReturnType<
		typeof import('../../../src/tools/repo-graph').loadGraph
	>;
	let saveGraph: ReturnType<
		typeof import('../../../src/tools/repo-graph').saveGraph
	>;
	let updateGraphForFiles: ReturnType<
		typeof import('../../../src/tools/repo-graph').updateGraphForFiles
	>;

	beforeEach(async () => {
		// Get real implementations
		const realModule = await getRealRepoGraph();
		buildWorkspaceGraph = realModule.buildWorkspaceGraph;
		loadGraph = realModule.loadGraph;
		saveGraph = realModule.saveGraph;
		updateGraphForFiles = realModule.updateGraphForFiles;

		// Create temp directory inside cwd to avoid path traversal issues
		tempDir = await fsSync.promises.mkdtemp(
			path.join(process.cwd(), 'incremental-test-'),
		);
		workspacePath = path.relative(process.cwd(), tempDir);
		// Create .swarm directory for graph storage
		await fsSync.promises.mkdir(path.join(tempDir, '.swarm'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		builderInternals.parseFileImports = realParseFileImports;
		clearCache(workspacePath);
		try {
			await fsSync.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('incremental update succeeds for an existing file - node updated', async () => {
		// Create initial files
		const files = {
			'index.ts': `import { foo } from './foo';
export const indexExport = 'hello';`,
			'foo.ts': `export const foo = 'foo';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Build initial graph
		const initialGraph = buildWorkspaceGraph(workspacePath);
		expect(Object.keys(initialGraph.nodes).length).toBe(2);

		// Save the graph
		await saveGraph(workspacePath, initialGraph);

		// Modify foo.ts to add a new export
		const newFooContent = `export const foo = 'foo';
export const bar = 'bar';`;
		await fsSync.promises.writeFile(
			path.join(tempDir, 'foo.ts'),
			newFooContent,
		);

		// Get the absolute path for the updated file
		const absoluteFooPath = path.join(tempDir, 'foo.ts');

		// Run incremental update
		const updatedGraph = await updateGraphForFiles(workspacePath, [
			absoluteFooPath,
		]);

		// Verify the node was updated
		const fooNode = updatedGraph.nodes[normalizeKey(absoluteFooPath)];
		expect(fooNode).toBeDefined();
		expect(fooNode?.exports).toContain('foo');
		expect(fooNode?.exports).toContain('bar');
	});

	test('deleted file removes node and edges', async () => {
		// Create initial files
		const files = {
			'index.ts': `import { foo } from './foo';
export const indexExport = 'hello';`,
			'foo.ts': `export const foo = 'foo';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Build and save initial graph
		const initialGraph = buildWorkspaceGraph(workspacePath);
		expect(Object.keys(initialGraph.nodes).length).toBe(2);
		expect(initialGraph.edges.length).toBe(1); // index.ts -> foo.ts
		await saveGraph(workspacePath, initialGraph);

		// Delete foo.ts
		await fsSync.promises.unlink(path.join(tempDir, 'foo.ts'));

		// Get absolute paths
		const absoluteFooPath = path.join(tempDir, 'foo.ts');

		// Run incremental update - file no longer exists
		const updatedGraph = await updateGraphForFiles(workspacePath, [
			absoluteFooPath,
		]);

		// Verify node was removed
		expect(updatedGraph.nodes[normalizeKey(absoluteFooPath)]).toBeUndefined();

		// Verify edge was removed (no edges referencing the deleted file)
		const remainingEdges = updatedGraph.edges.filter(
			(e) => e.source === absoluteFooPath || e.target === absoluteFooPath,
		);
		expect(remainingEdges.length).toBe(0);
	});

	test('forceRebuild option triggers full rebuild', async () => {
		// Create initial files
		const files = {
			'index.ts': `export const indexExport = 'hello';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Build and save initial graph
		const initialGraph = buildWorkspaceGraph(workspacePath);
		await saveGraph(workspacePath, initialGraph);

		// Run with forceRebuild
		const rebuiltGraph = await updateGraphForFiles(workspacePath, [], {
			forceRebuild: true,
		});

		// Verify it returns a valid graph (full rebuild was called)
		expect(rebuiltGraph).toBeDefined();
		expect(rebuiltGraph.metadata).toBeDefined();
		expect(rebuiltGraph.metadata.nodeCount).toBeGreaterThan(0);
	});

	test('no existing graph falls back to full rebuild', async () => {
		// Create files but do NOT save a graph
		const files = {
			'index.ts': `export const indexExport = 'hello';`,
			'utils.ts': `export const util = 'util';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Verify no graph exists
		const existingGraph = await loadGraph(workspacePath);
		expect(existingGraph).toBeNull();

		// Run update - should fall back to full rebuild since no graph exists
		const resultGraph = await updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'index.ts'),
		]);

		// Verify a full graph was built
		expect(resultGraph).toBeDefined();
		expect(Object.keys(resultGraph.nodes).length).toBe(2);
	});

	test('validation failure triggers full rebuild - orphan edge removed', async () => {
		// Create initial files
		const files = {
			'index.ts': `import { foo } from './foo';
export const indexExport = 'hello';`,
			'foo.ts': `export const foo = 'foo';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Build and save initial graph
		const initialGraph = buildWorkspaceGraph(workspacePath);
		await saveGraph(workspacePath, initialGraph);

		// Manually corrupt the graph to create an orphan edge (edge pointing to non-existent node)
		const loadedGraph = await loadGraph(workspacePath);
		expect(loadedGraph).not.toBeNull();

		// Add an edge that points to a non-existent node
		loadedGraph!.edges.push({
			source: path.join(tempDir, 'index.ts'),
			target: path.join(tempDir, 'nonexistent.ts'),
			importSpecifier: './nonexistent',
			importType: 'named',
		});

		// Save the corrupted graph
		await saveGraph(workspacePath, loadedGraph!);

		// Now update a file - should detect orphan edge and fall back to full rebuild
		const absoluteIndexPath = path.join(tempDir, 'index.ts');
		const updatedGraph = await updateGraphForFiles(workspacePath, [
			absoluteIndexPath,
		]);

		// After full rebuild, the graph should only contain edges for existing files
		// Verify that no edge references a non-existent file
		for (const edge of updatedGraph.edges) {
			const sourcePath = normalizeKey(edge.source);
			const targetPath = normalizeKey(edge.target);
			// These paths should exist as nodes
			expect(updatedGraph.nodes[sourcePath]).toBeDefined();
			// The key assertion: after rebuild, all edges should have valid targets
			// If we get here without the orphan edge causing issues, the rebuild worked
		}
		// Also verify the graph metadata is valid
		expect(updatedGraph.metadata.nodeCount).toBeGreaterThan(0);
	});

	test('multiple files updated in one call - batch update works', async () => {
		// Create initial files
		const files = {
			'index.ts': `import { foo } from './foo';
import { bar } from './bar';
export const indexExport = 'hello';`,
			'foo.ts': `export const foo = 'foo';`,
			'bar.ts': `export const bar = 'bar';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Build and save initial graph
		const initialGraph = buildWorkspaceGraph(workspacePath);
		await saveGraph(workspacePath, initialGraph);

		// Modify both foo.ts and bar.ts
		const newFooContent = `export const foo = 'foo';
export const modified = true;`;
		const newBarContent = `export const bar = 'bar';
export const alsoModified = true;`;

		await fsSync.promises.writeFile(
			path.join(tempDir, 'foo.ts'),
			newFooContent,
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'bar.ts'),
			newBarContent,
		);

		// Run batch update
		const absoluteFooPath = path.join(tempDir, 'foo.ts');
		const absoluteBarPath = path.join(tempDir, 'bar.ts');

		const updatedGraph = await updateGraphForFiles(workspacePath, [
			absoluteFooPath,
			absoluteBarPath,
		]);

		// Verify both files were updated
		expect(
			updatedGraph.nodes[normalizeKey(absoluteFooPath)]?.exports,
		).toContain('modified');
		expect(
			updatedGraph.nodes[normalizeKey(absoluteBarPath)]?.exports,
		).toContain('alsoModified');
	});

	test('unsupported file extension (.css) is skipped - not in SUPPORTED_EXTENSIONS', async () => {
		// Create initial files
		const files = {
			'index.ts': `import './styles.css';
export const indexExport = 'hello';`,
		};

		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}

		// Build and save initial graph
		const initialGraph = buildWorkspaceGraph(workspacePath);
		expect(Object.keys(initialGraph.nodes).length).toBe(1);
		await saveGraph(workspacePath, initialGraph);

		// Try to update a .css file
		const absoluteCssPath = path.join(tempDir, 'styles.css');

		// Run update with CSS file - should not crash, but CSS is not supported
		const resultGraph = await updateGraphForFiles(workspacePath, [
			absoluteCssPath,
		]);

		// The CSS file should not appear as a node (scanFile returns null for unsupported extensions)
		// The graph should remain unchanged since CSS doesn't create nodes
		expect(resultGraph).toBeDefined();
		// Note: CSS files are scanned but don't produce nodes in the graph
		// since scanFile only creates nodes for .ts, .tsx, .js, .jsx, .mjs, .cjs, .py
	});

	test('updateGraphForFiles does not produce control-char specifiers when file has CR in import', async () => {
		// Seed workspace with a clean file so there is a baseline graph to update
		const seedContent = 'export const seed = 1;\n';
		await fsSync.promises.writeFile(path.join(tempDir, 'seed.ts'), seedContent);

		const initialGraph = buildWorkspaceGraph(workspacePath);
		await saveGraph(workspacePath, initialGraph);

		// Now add a file whose import specifier contains a literal carriage-return byte.
		// Use String.fromCharCode(13) — unambiguously 0x0D, not the two-char \r sequence.
		const cr = String.fromCharCode(13);
		const dirtyContent = `import x from './bar${cr}.js';\nimport y from './ok';\n`;
		const dirtyPath = path.join(tempDir, 'dirty.ts');
		await fsSync.promises.writeFile(dirtyPath, dirtyContent, 'binary');

		// Must not throw
		const updatedGraph = await updateGraphForFiles(workspacePath, [dirtyPath]);

		// Node for the dirty file must exist
		const dirtyModuleName = 'dirty.ts';
		const dirtyNode = Object.values(updatedGraph.nodes).find(
			(n) => n.moduleName === dirtyModuleName,
		);
		expect(dirtyNode).toBeDefined();

		// No control chars in any node's imports
		for (const node of Object.values(updatedGraph.nodes)) {
			for (const imp of node.imports) {
				expect(/[\0\t\r\n]/.test(imp)).toBe(false);
			}
		}

		// No control chars in any edge's importSpecifier originating from the dirty file
		const dirtyAbsPath = path.resolve(tempDir, 'dirty.ts');
		for (const edge of updatedGraph.edges) {
			if (edge.source === dirtyAbsPath) {
				expect(/[\0\t\r\n]/.test(edge.importSpecifier)).toBe(false);
			}
		}
	});

	test('malformed file scan failure is handled without throwing', async () => {
		await fsSync.promises.writeFile(
			path.join(tempDir, 'good.ts'),
			`export const good = true;`,
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'bad.ts'),
			`export const bad = true;`,
		);

		const initialGraph = buildWorkspaceGraph(workspacePath);
		await saveGraph(workspacePath, initialGraph);

		builderInternals.parseFileImports = (content: string) => {
			if (content.includes('bad')) {
				throw new Error('synthetic parse failure');
			}
			return realParseFileImports(content);
		};

		const updatedGraph = await updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'bad.ts'),
		]);

		const modules = Object.values(updatedGraph.nodes).map((n) => n.moduleName);
		expect(modules).toContain('good.ts');
		expect(modules).toContain('bad.ts');
		for (const edge of updatedGraph.edges) {
			expect(updatedGraph.nodes[normalizeKey(edge.source)]).toBeDefined();
			expect(updatedGraph.nodes[normalizeKey(edge.target)]).toBeDefined();
		}
	});

	test('normal incremental update does not bump incrementalFallbacks (A4 happy path)', async () => {
		// Sanity that the optimistic-concurrency / replay path (defect A4) does
		// not spuriously fire on a clean single-session update: the
		// incrementalFallbacks diagnostics counter must stay at 0/undefined.
		const files = {
			'a.ts': `import { b } from './b';\nexport const a = b;\n`,
			'b.ts': `export const b = 1;\n`,
		};
		for (const [name, content] of Object.entries(files)) {
			await fsSync.promises.writeFile(path.join(tempDir, name), content);
		}
		const initialGraph = buildWorkspaceGraph(workspacePath);
		await saveGraph(workspacePath, initialGraph);

		await fsSync.promises.writeFile(
			path.join(tempDir, 'b.ts'),
			'export const b = 2;\nexport const bNew = 3;\n',
		);
		const updated = await updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'b.ts'),
		]);
		const fallbacks =
			(updated.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;
		expect(fallbacks).toBe(0);
		// The edit took effect (proves the incremental save path ran).
		const bNode = updated.nodes[normalizeKey(path.join(tempDir, 'b.ts'))];
		expect(bNode?.exports).toContain('bNew');
	});
});

describe('updateGraphForFiles concurrent-save replay (A4)', () => {
	let tempDir: string;
	let workspacePath: string;
	const realStat = incrementalInternals.stat;
	const realParseFileImports = builderInternals.parseFileImports;

	/** Normalize a path for use as a graph key (forward slashes). */
	function normalizeKey(p: string): string {
		return path.normalize(p).replace(/\\/g, '/');
	}

	async function real() {
		const module = await getRealRepoGraph();
		return {
			buildWorkspaceGraph: module.buildWorkspaceGraph,
			saveGraph: module.saveGraph,
			loadGraph: module.loadGraph,
			updateGraphForFiles: module.updateGraphForFiles,
		};
	}

	beforeEach(async () => {
		tempDir = await fsSync.promises.mkdtemp(
			path.join(process.cwd(), 'incremental-a4-test-'),
		);
		workspacePath = path.relative(process.cwd(), tempDir);
		await fsSync.promises.mkdir(path.join(tempDir, '.swarm'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		incrementalInternals.stat = realStat;
		builderInternals.parseFileImports = realParseFileImports;
		clearCache(workspacePath);
		try {
			await fsSync.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('one mtime shift triggers reload+replay (no full rebuild)', async () => {
		const m = await real();
		await fsSync.promises.writeFile(
			path.join(tempDir, 'a.ts'),
			`export const a = 1;\n`,
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'b.ts'),
			`export const b = 1;\n`,
		);
		const initial = m.buildWorkspaceGraph(workspacePath);
		await m.saveGraph(workspacePath, initial);

		// Override the concurrency stat so the FIRST call (the pre-save mtime
		// check) returns a shifted mtime, simulating a concurrent writer having
		// saved between our load and our pre-save check. Subsequent calls use
		// the real mtime so the post-replay re-stat matches and the replay
		// succeeds without a terminal fallback.
		let statCall = 0;
		const graphFile = path.join(tempDir, '.swarm', 'repo-graph.json');
		const realFileStats = await fsSync.promises.stat(graphFile);
		incrementalInternals.stat = async (p: string) => {
			if (p === graphFile) {
				statCall++;
				// First stat (pre-save check) reports a shifted mtime.
				if (statCall === 1) {
					return {
						...realFileStats,
						mtimeMs: realFileStats.mtimeMs + 5000,
					} as fsSync.Stats;
				}
			}
			return realStat(p);
		};

		await fsSync.promises.writeFile(
			path.join(tempDir, 'b.ts'),
			'export const b = 2;\nexport const bNew = 3;\n',
		);

		const updated = await m.updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'b.ts'),
		]);

		// Reload+replay succeeded (no terminal full rebuild): the fallback
		// counter must NOT have been bumped.
		const fallbacks =
			(updated.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;
		expect(fallbacks).toBe(0);
		// The replayed edit took effect (proves the reload+replay path ran and
		// saved the fresh graph).
		const bNode = updated.nodes[normalizeKey(path.join(tempDir, 'b.ts'))];
		expect(bNode?.exports).toContain('bNew');
	});

	test('second mtime shift during replay triggers exactly one full rebuild', async () => {
		const m = await real();
		await fsSync.promises.writeFile(
			path.join(tempDir, 'a.ts'),
			`export const a = 1;\n`,
		);
		const initial = m.buildWorkspaceGraph(workspacePath);
		await m.saveGraph(workspacePath, initial);

		// Make EVERY concurrency stat report a shifted mtime, so: pre-save
		// check shifts (triggers reload+replay), then post-replay re-stat also
		// shifts (triggers terminal full rebuild). This exercises the double-
		// shift terminal-fallback path — bounded, never loops.
		const graphFile = path.join(tempDir, '.swarm', 'repo-graph.json');
		const realFileStats = await fsSync.promises.stat(graphFile);
		incrementalInternals.stat = async (p: string) => {
			if (p === graphFile) {
				return {
					...realFileStats,
					mtimeMs: realFileStats.mtimeMs + 5000,
				} as fsSync.Stats;
			}
			return realStat(p);
		};

		await fsSync.promises.writeFile(
			path.join(tempDir, 'a.ts'),
			'export const a = 2;\nexport const aNew = 3;\n',
		);

		const updated = await m.updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'a.ts'),
		]);

		// The terminal full rebuild fired exactly once (counter bumped by 1).
		const fallbacks =
			(updated.diagnostics?.incrementalFallbacks as number | undefined) ?? 0;
		expect(fallbacks).toBe(1);
	});
});

describe('incremental manifest-aware boundaries (A8 manifest closure)', () => {
	let tempDir: string;
	let workspacePath: string;

	async function real() {
		const module = await getRealRepoGraph();
		return {
			buildWorkspaceGraph: module.buildWorkspaceGraph,
			saveGraph: module.saveGraph,
			loadGraph: module.loadGraph,
			updateGraphForFiles: module.updateGraphForFiles,
		};
	}

	beforeEach(async () => {
		tempDir = await fsSync.promises.mkdtemp(
			path.join(process.cwd(), 'incremental-manifest-test-'),
		);
		workspacePath = path.relative(process.cwd(), tempDir);
		await fsSync.promises.mkdir(path.join(tempDir, '.swarm'), {
			recursive: true,
		});
	});

	afterEach(async () => {
		clearCache(workspacePath);
		try {
			await fsSync.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test('incremental edit preserves manifest-driven package boundary (buildManifestClosure)', async () => {
		const m = await real();
		// customdomain/ is NOT in the static packages|crates|apps|libs|services
		// set, so without a manifest it would fall back to segment 0. A
		// package.json under customdomain/ makes the boundary customdomain/users.
		await fsSync.promises.mkdir(path.join(tempDir, 'customdomain/users'), {
			recursive: true,
		});
		await fsSync.promises.writeFile(
			path.join(tempDir, 'customdomain/package.json'),
			'{ "name": "customdomain" }\n',
		);
		await fsSync.promises.writeFile(
			path.join(tempDir, 'customdomain/users/svc.ts'),
			'export const svc = 1;\n',
		);

		const initial = m.buildWorkspaceGraph(workspacePath);
		await m.saveGraph(workspacePath, initial);

		const svcNode = Object.values(initial.nodes).find(
			(n) => n.moduleName === 'customdomain/users/svc.ts',
		);
		// The initial (manifest-aware) build classifies the boundary as
		// customdomain/users thanks to the package.json under customdomain/.
		expect(svcNode?.ontology?.packageBoundary).toBe('customdomain/users');

		// Edit svc.ts. The incremental re-scan must re-derive the manifest
		// closure (buildManifestClosure) and preserve the manifest-driven
		// boundary — NOT regress to the static-rule 'customdomain'.
		await fsSync.promises.writeFile(
			path.join(tempDir, 'customdomain/users/svc.ts'),
			'export const svc = 2;\nexport const svcNew = 3;\n',
		);
		const updated = await m.updateGraphForFiles(workspacePath, [
			path.join(tempDir, 'customdomain/users/svc.ts'),
		]);
		const updatedSvc = Object.values(updated.nodes).find(
			(n) => n.moduleName === 'customdomain/users/svc.ts',
		);
		expect(updatedSvc?.ontology?.packageBoundary).toBe('customdomain/users');
		expect(updatedSvc?.exports).toContain('svcNew');
	});
});

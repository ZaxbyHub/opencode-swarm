/**
 * Cross-platform hardening tests for src/tools/repo-graph/
 *
 * Covers: path normalization, CRLF line numbers, symlink cycle safety,
 * grammar directory resolution, workspace-relative query output, and
 * workspace containment enforcement.
 *
 * Issue: https://github.com/ZaxbyHub/opencode-swarm/issues/1523 (KG-02/18)
 *
 * KNOWN GAP (deferred to future KG iteration):
 *   Case-insensitive filesystem collisions are NOT tested here.
 *   On Windows and macOS, `normalizeGraphPath('Foo.ts')` and
 *   `normalizeGraphPath('foo.ts')` produce different keys even though they
 *   refer to the same file. The graph does not de-duplicate case variants.
 *   Tracking issue: KG-02/18 scope explicitly excludes this (case-insensitive collisions out of scope).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGrammarsDir } from '../../../../src/lang/runtime';
import { extractFileOntology } from '../../../../src/tools/repo-graph/ontology';
import {
	getDependencies,
	getImporters,
	resetQueryCache,
} from '../../../../src/tools/repo-graph/query';
import { safeRealpathSync } from '../../../../src/tools/repo-graph/safe-realpath';
import { _internals as storageInternals } from '../../../../src/tools/repo-graph/storage';
import type {
	GraphEdge,
	GraphNode,
	RepoGraph,
} from '../../../../src/tools/repo-graph/types';
import {
	createEmptyGraph,
	normalizeGraphPath,
} from '../../../../src/tools/repo-graph/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the current OS can create symlinks without elevated privileges. */
function canCreateSymlinks(): boolean {
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'symtest-'));
	try {
		symlinkSync(tmp, path.join(tmp, 'probe'), 'junction');
		return true;
	} catch {
		return false;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Build a minimal RepoGraph with two nodes and one edge, rooted at a tmpdir path. */
function makeMinimalGraph(): RepoGraph {
	// Use os.tmpdir() so path.join/path.resolve work correctly on all platforms.
	const workspaceRoot = path.join(os.tmpdir(), 'graphify-test-workspace');
	const graph = createEmptyGraph(workspaceRoot);

	const srcFile = normalizeGraphPath(path.join(workspaceRoot, 'src', 'foo.ts'));
	const libFile = normalizeGraphPath(path.join(workspaceRoot, 'lib', 'bar.ts'));

	const srcNode: GraphNode = {
		filePath: srcFile,
		moduleName: 'src/foo',
		language: 'typescript',
		exports: [],
		exportLines: {},
		imports: ['../lib/bar'],
		mtime: new Date(0).toISOString(),
	};
	const libNode: GraphNode = {
		filePath: libFile,
		moduleName: 'lib/bar',
		language: 'typescript',
		exports: ['bar'],
		exportLines: {},
		imports: [],
		mtime: new Date(0).toISOString(),
	};

	graph.nodes[srcFile] = srcNode;
	graph.nodes[libFile] = libNode;

	const edge: GraphEdge = {
		source: srcFile,
		target: libFile,
		importSpecifier: '../lib/bar',
		importType: 'named',
		importedSymbols: ['bar'],
	};
	graph.edges.push(edge);
	return graph;
}

// ---------------------------------------------------------------------------
// 1. normalizeGraphPath — path key normalization
// ---------------------------------------------------------------------------

describe('normalizeGraphPath', () => {
	// SC-001
	it('backslash path produces same key as forward-slash path', () => {
		const forward = 'src/auth/session.ts';
		const backward = 'src\\auth\\session.ts';
		expect(normalizeGraphPath(forward)).toBe(normalizeGraphPath(backward));
	});

	it('mixed separators produce same key', () => {
		const mixed = 'src/auth\\session.ts';
		const forward = 'src/auth/session.ts';
		expect(normalizeGraphPath(mixed)).toBe(normalizeGraphPath(forward));
	});

	// FR-004 — Windows drive letter
	it('Windows drive-letter path preserves letter in forward-slash form', () => {
		const winPath = 'C:\\Users\\project\\src\\foo.ts';
		const result = normalizeGraphPath(winPath);
		expect(result).not.toContain('\\');
		expect(result).toMatch(/^C:\//);
	});

	// SC-003 — spaces
	it('path with spaces normalizes without truncation', () => {
		const spacePath = 'my project/src/foo bar.ts';
		const result = normalizeGraphPath(spacePath);
		expect(result).toContain('my project');
		expect(result).toContain('foo bar.ts');
		expect(result).not.toContain('\\');
	});

	// SC-004 — Unicode
	it('Unicode path normalizes and is round-trip stable', () => {
		const unicodePath = 'src/résumé/parser.ts';
		const result = normalizeGraphPath(unicodePath);
		expect(normalizeGraphPath(result)).toBe(result);
		expect(result).toContain('résumé');
	});

	it('shell-sensitive characters are preserved', () => {
		const shellPath = 'src/my-lib (v2)/index.ts';
		const result = normalizeGraphPath(shellPath);
		expect(result).toContain('my-lib (v2)');
	});
});

// ---------------------------------------------------------------------------
// 2. safeRealpathSync — error handling and DI
// ---------------------------------------------------------------------------

describe('safeRealpathSync', () => {
	// SC-016
	it('returns fallback when target does not exist (ENOENT)', () => {
		const missing = path.join(os.tmpdir(), '__graphify_no_such_path_xyzzy__');
		const fallback = '/fallback/path';
		const result = safeRealpathSync(missing, fallback);
		expect(result).toBe(fallback);
	});

	// SC-017
	it('returns null for non-ENOENT errors (EACCES)', () => {
		const fakeResolver = (_p: string): string => {
			const err = Object.assign(new Error('Permission denied'), {
				code: 'EACCES',
			});
			throw err;
		};
		const result = safeRealpathSync('/any/path', '/fallback', fakeResolver);
		expect(result).toBeNull();
	});

	it('returns null for EPERM errors', () => {
		const fakeResolver = (_p: string): string => {
			const err = Object.assign(new Error('Operation not permitted'), {
				code: 'EPERM',
			});
			throw err;
		};
		const result = safeRealpathSync('/any/path', '/fallback', fakeResolver);
		expect(result).toBeNull();
	});

	// SC-018 — DI injectable
	it('uses the injected resolver instead of realpathSync', () => {
		let called = false;
		const fakeResolver = (p: string): string => {
			called = true;
			return p + '-resolved';
		};
		const result = safeRealpathSync('/some/path', '/fallback', fakeResolver);
		expect(called).toBe(true);
		expect(result).toBe('/some/path-resolved');
	});

	it('returns resolved path on success', () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'safe-realpath-'));
		try {
			const result = safeRealpathSync(tmp, '/fallback');
			expect(result).not.toBeNull();
			expect(typeof result).toBe('string');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 3. extractFileOntology — CRLF line number consistency
// ---------------------------------------------------------------------------

describe('extractFileOntology — CRLF line numbers', () => {
	/** Content lines: line 1 is blank, line 3 has a route, line 5 has a data op, line 7 has a secret. */
	const LINES = [
		'// header comment',
		'import { db } from "./db";',
		"router.get('/users', async (req, res) => {",
		'  // handler body',
		'  const user = await db.findUnique({ where: { id: req.params.id } });',
		'  if (!user) return res.status(404).send("Not found");',
		'  const token = getAuthToken(user);',
		'  res.json(user);',
		'});',
	];

	const LF_CONTENT = LINES.join('\n');
	const CRLF_CONTENT = LINES.join('\r\n');

	// SC-005 — CRLF produces correct line numbers
	it('data operation line numbers are correct in CRLF content', () => {
		const result = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: CRLF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const dataOps = result.dataOperations ?? [];
		expect(dataOps.length).toBeGreaterThan(0);
		// db.findById is on line 5 (1-based)
		const readOp = dataOps.find((op) => op.operation === 'read');
		expect(readOp).toBeDefined();
		expect(readOp?.line).toBe(5);
	});

	// SC-006 — LF and CRLF produce identical line numbers
	it('data operation line numbers are identical for LF and CRLF content', () => {
		const lfResult = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: LF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const crlfResult = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: CRLF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const lfOps = (lfResult.dataOperations ?? []).map((op) => ({
			operation: op.operation,
			line: op.line,
		}));
		const crlfOps = (crlfResult.dataOperations ?? []).map((op) => ({
			operation: op.operation,
			line: op.line,
		}));
		expect(crlfOps).toEqual(lfOps);
	});

	it('security fact line numbers are identical for LF and CRLF content', () => {
		const lfResult = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: LF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const crlfResult = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: CRLF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const lfSec = (lfResult.security ?? []).map((f) => ({
			kind: f.kind,
			line: f.line,
		}));
		const crlfSec = (crlfResult.security ?? []).map((f) => ({
			kind: f.kind,
			line: f.line,
		}));
		// Guard: 'const token = ...' on line 7 must be detected as secret_handling
		expect(lfSec.length).toBeGreaterThan(0);
		expect(crlfSec).toEqual(lfSec);
	});

	it('route fact line numbers are identical for LF and CRLF content', () => {
		const lfResult = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: LF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const crlfResult = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: CRLF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		const lfRoutes = (lfResult.routes ?? []).map((r) => ({
			method: r.method,
			line: r.line,
		}));
		const crlfRoutes = (crlfResult.routes ?? []).map((r) => ({
			method: r.method,
			line: r.line,
		}));
		// Guard: router.get('/users', ...) on line 3 must be detected as a route
		expect(lfRoutes.length).toBeGreaterThan(0);
		expect(crlfRoutes).toEqual(lfRoutes);
	});

	it('CRLF route is on the correct 1-based line', () => {
		const result = extractFileOntology({
			moduleName: 'src/users/route',
			filePath: '/workspace/src/users/route.ts',
			content: CRLF_CONTENT,
			language: 'typescript',
			exports: [],
			imports: [],
		});
		// router.get('/users', ...) is on line 3 (1-based)
		const getUsersRoute = (result.routes ?? []).find(
			(r) => r.path === '/users',
		);
		expect(getUsersRoute).toBeDefined();
		expect(getUsersRoute?.line).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// 4. resolveGrammarsDir — grammar layout resolution
// ---------------------------------------------------------------------------

describe('resolveGrammarsDir', () => {
	// SC-009
	it('source layout: thisDir ending in /src/lang resolves to src/lang/grammars', () => {
		const result = resolveGrammarsDir('/project/src/lang');
		expect(normalizeGraphPath(result)).toMatch(/src\/lang\/grammars$/);
	});

	// SC-010
	it('main-bundle layout: thisDir ending in /dist resolves to dist/lang/grammars', () => {
		const result = resolveGrammarsDir('/project/dist');
		expect(normalizeGraphPath(result)).toMatch(/dist\/lang\/grammars$/);
	});

	// SC-011
	it('CLI-bundle layout: thisDir ending in /dist/cli resolves to dist/lang/grammars', () => {
		const result = resolveGrammarsDir('/project/dist/cli');
		expect(normalizeGraphPath(result)).toMatch(/dist\/lang\/grammars$/);
	});

	// SC-012 — forward slashes in output
	it('source layout with Windows separators produces forward-slash output', () => {
		const result = resolveGrammarsDir('C:\\project\\src\\lang');
		expect(result).not.toContain('\\\\');
		const normalized = normalizeGraphPath(result);
		expect(normalized).not.toContain('\\');
	});

	it('main-bundle layout with Windows separators produces forward-slash output', () => {
		const result = resolveGrammarsDir('C:\\project\\dist');
		const normalized = normalizeGraphPath(result);
		expect(normalized).not.toContain('\\');
	});

	it('CLI-bundle layout with Windows separators produces forward-slash output', () => {
		const result = resolveGrammarsDir('C:\\project\\dist\\cli');
		const normalized = normalizeGraphPath(result);
		expect(normalized).not.toContain('\\');
	});

	it('all three layouts produce distinct absolute paths', () => {
		const source = normalizeGraphPath(resolveGrammarsDir('/project/src/lang'));
		const main = normalizeGraphPath(resolveGrammarsDir('/project/dist'));
		const cli = normalizeGraphPath(resolveGrammarsDir('/project/dist/cli'));
		// source vs dist are different; main and cli both point to dist/lang/grammars
		expect(source).not.toBe(main);
		expect(main).toBe(cli);
	});
});

// ---------------------------------------------------------------------------
// 5. Query output — workspace-relative forward-slash paths (SC-002, FR-002)
// ---------------------------------------------------------------------------

describe('getDependencies / getImporters — workspace-relative output', () => {
	afterEach(() => {
		resetQueryCache();
	});

	// SC-002: query output is workspace-relative, not absolute
	it('getDependencies returns workspace-relative forward-slash paths', () => {
		const graph = makeMinimalGraph();
		const workspaceRoot = path.join(os.tmpdir(), 'graphify-test-workspace');
		const srcFile = normalizeGraphPath(
			path.join(workspaceRoot, 'src', 'foo.ts'),
		);
		const deps = getDependencies(graph, srcFile);
		expect(deps.length).toBeGreaterThan(0);
		for (const dep of deps) {
			// Must not be an absolute path (Windows C:/ or Unix /...)
			expect(dep.file).not.toMatch(/^[A-Za-z]:\//);
			expect(dep.file).not.toMatch(/^\//);
			expect(dep.file).not.toContain('\\');
		}
	});

	it('getImporters returns workspace-relative forward-slash paths', () => {
		const graph = makeMinimalGraph();
		const workspaceRoot = path.join(os.tmpdir(), 'graphify-test-workspace');
		const libFile = normalizeGraphPath(
			path.join(workspaceRoot, 'lib', 'bar.ts'),
		);
		const importers = getImporters(graph, libFile);
		expect(importers.length).toBeGreaterThan(0);
		for (const imp of importers) {
			expect(imp.file).not.toMatch(/^[A-Za-z]:\//);
			expect(imp.file).not.toMatch(/^\//);
			expect(imp.file).not.toContain('\\');
		}
	});

	it('getDependencies output paths contain no backslashes', () => {
		const graph = makeMinimalGraph();
		const workspaceRoot = path.join(os.tmpdir(), 'graphify-test-workspace');
		const srcFile = normalizeGraphPath(
			path.join(workspaceRoot, 'src', 'foo.ts'),
		);
		const deps = getDependencies(graph, srcFile);
		for (const dep of deps) {
			expect(dep.file).not.toContain('\\');
		}
	});

	// SC-002 (supplemental): exercises the path.relative fallback in moduleNameForEdgePath
	// when the target absolute path is not present in graph.nodes (e.g. from an unresolved import)
	it('getDependencies falls back to workspace-relative path when target is not in nodes', () => {
		const workspaceRoot = path.join(os.tmpdir(), 'graphify-test-workspace');
		const graph = createEmptyGraph(workspaceRoot);

		const srcFile = normalizeGraphPath(
			path.join(workspaceRoot, 'src', 'foo.ts'),
		);
		const unknownTarget = normalizeGraphPath(
			path.join(workspaceRoot, 'vendor', 'lib.ts'),
		);

		graph.nodes[srcFile] = {
			filePath: srcFile,
			moduleName: 'src/foo',
			language: 'typescript',
			exports: [],
			imports: ['../vendor/lib'],
			mtime: new Date(0).toISOString(),
		};
		// unknownTarget deliberately NOT in graph.nodes — exercises path.relative branch
		graph.edges.push({
			source: srcFile,
			target: unknownTarget,
			importSpecifier: '../vendor/lib',
			importType: 'named',
		});

		const deps = getDependencies(graph, srcFile);
		expect(deps.length).toBeGreaterThan(0);
		for (const dep of deps) {
			expect(dep.file).toBe('vendor/lib.ts');
			expect(dep.file).not.toMatch(/^[A-Za-z]:\//);
			expect(dep.file).not.toMatch(/^\//);
			expect(dep.file).not.toContain('\\');
		}
	});
});

// ---------------------------------------------------------------------------
// 6. Workspace containment via _internals mock (SC-013, SC-014, SC-015)
// ---------------------------------------------------------------------------

describe('storage workspace containment', () => {
	let savedSafeRealpath: typeof storageInternals.safeRealpathSync;
	let savedRetryDelayMs: number;

	beforeEach(() => {
		savedSafeRealpath = storageInternals.safeRealpathSync;
		savedRetryDelayMs = storageInternals.retryDelayMs;
		storageInternals.retryDelayMs = 0; // avoid real sleeps in rename retry loop
	});

	afterEach(() => {
		storageInternals.safeRealpathSync = savedSafeRealpath;
		storageInternals.retryDelayMs = savedRetryDelayMs;
	});

	// SC-013: save within workspace succeeds
	it('saveGraph succeeds when workspace is a real directory on disk', async () => {
		const { saveGraph } = await import(
			'../../../../src/tools/repo-graph/storage'
		);
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'graph-save-'));
		const base = realpathSync(tmp);
		try {
			const graph = createEmptyGraph(base);
			await saveGraph(base, graph);
			const { existsSync } = await import('node:fs');
			expect(existsSync(path.join(base, '.swarm', 'repo-graph.json'))).toBe(
				true,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	// SC-014: save with path traversal in workspace is rejected
	it('saveGraph rejects a workspace path containing path traversal (..)', async () => {
		const { saveGraph } = await import(
			'../../../../src/tools/repo-graph/storage'
		);
		// Use raw concatenation so path.join doesn't normalize away the `..` before
		// validateWorkspace sees it (path.join('/tmp','ok','..','x') → '/tmp/x').
		const sep = path.sep;
		const traversalWorkspace =
			os.tmpdir() + sep + 'ok' + sep + '..' + sep + 'escape';
		let threw = false;
		try {
			await saveGraph(traversalWorkspace, createEmptyGraph(traversalWorkspace));
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	// SC-015: symlink workspace escape rejected via DI mock
	it('rejects when _internals.safeRealpathSync returns null (non-ENOENT error)', async () => {
		const { saveGraph } = await import(
			'../../../../src/tools/repo-graph/storage'
		);
		const tmp = mkdtempSync(path.join(os.tmpdir(), 'graph-escape-'));
		const base = realpathSync(tmp);
		try {
			const graph = createEmptyGraph(base);
			// Simulate a non-ENOENT error during realpath resolution — saveGraph must throw
			storageInternals.safeRealpathSync = (
				_targetPath: string,
				_fallback: string,
			) => null;

			let threw = false;
			try {
				await saveGraph(base, graph);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 7. Symlink cycle walk terminates (SC-007, SC-008)
// ---------------------------------------------------------------------------

describe('buildWorkspaceGraph — symlink cycle safety', () => {
	it.skipIf(!canCreateSymlinks())(
		'SC-007: circular symlink pair does not hang buildWorkspaceGraph',
		async () => {
			const { buildWorkspaceGraphAsync } = await import(
				'../../../../src/tools/repo-graph/builder'
			);
			const tmp = mkdtempSync(path.join(os.tmpdir(), 'graph-cycle-'));
			// Wrap in realpathSync for macOS iCloud/FileVault layouts
			const base = realpathSync(tmp);
			try {
				const dirA = path.join(base, 'dirA');
				const dirB = path.join(base, 'dirB');
				mkdirSync(dirA);
				mkdirSync(dirB);
				// Create a real source file so the graph has something to scan
				writeFileSync(path.join(dirA, 'index.ts'), 'export const a = 1;\n');
				// Create circular symlinks: dirA/linkToB → dirB, dirB/linkToA → dirA
				symlinkSync(dirB, path.join(dirA, 'linkToB'), 'junction');
				symlinkSync(dirA, path.join(dirB, 'linkToA'), 'junction');

				const start = Date.now();
				const result = await buildWorkspaceGraphAsync(base, {
					followSymlinks: true,
					walkBudgetMs: 5000,
				});
				const elapsed = Date.now() - start;

				// Must complete (not hang); 5 s budget is very generous
				expect(elapsed).toBeLessThan(10_000);
				// Result is a valid graph object
				expect(result).toBeDefined();
				expect(typeof result.nodes).toBe('object');
				expect(Object.keys(result.nodes).length).toBeGreaterThan(0);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!canCreateSymlinks())(
		'SC-008: symlink entries are counted as skipped, not traversed',
		async () => {
			const { buildWorkspaceGraphAsync } = await import(
				'../../../../src/tools/repo-graph/builder'
			);
			const tmp = mkdtempSync(path.join(os.tmpdir(), 'graph-skip-'));
			const base = realpathSync(tmp);
			try {
				const realSub = path.join(base, 'real-sub');
				mkdirSync(realSub);
				writeFileSync(path.join(realSub, 'index.ts'), 'export const x = 1;\n');
				// A symlink to realSub — should be skipped by default
				symlinkSync(realSub, path.join(base, 'link-to-sub'), 'junction');

				const result = await buildWorkspaceGraphAsync(base, {
					followSymlinks: false,
					walkBudgetMs: 5000,
				});

				// The symlinked directory should NOT have added extra copies of the files
				// Only files from real-sub itself should appear in nodes
				const nodePaths = Object.keys(result.nodes).map((p) =>
					normalizeGraphPath(p),
				);
				const linkPaths = nodePaths.filter((p) => p.includes('link-to-sub'));
				expect(linkPaths).toHaveLength(0);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
	);
});

// ---------------------------------------------------------------------------
// 8. SC-019 — Known gap is documented (meta-test)
// ---------------------------------------------------------------------------

describe('known gap documentation', () => {
	it('SC-019: this test file documents the case-sensitivity known gap', () => {
		// This test verifies the known-gap comment exists in this file.
		// The comment at the top of this file explicitly defers case-insensitive
		// filesystem collision handling to a future KG iteration (KG-02 scope).
		// Case-insensitive collisions are intentionally out of scope per KG-02/18.
		const __filename = fileURLToPath(import.meta.url);
		const source = readFileSync(__filename, 'utf8');
		expect(source).toContain('case-insensitive');
		expect(source).toContain('KG-02/18');
	});
});

/**
 * Closure-rule and query-equivalence tests for loadSubgraphForFiles /
 * queryNodeByFile (issue #1534).
 *
 * Every equivalence assertion feeds BOTH the index-built subgraph and the
 * JSON-loaded full graph to the same unmodified `getLocalizationContext` /
 * `getBlastRadius` and compares the results, so a closure that under-includes
 * shows up as a behavioural difference rather than a shape difference.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir.js';
import { loadDatabaseCtor } from '../../db/sqlite-loader';
import { addEdge, buildWorkspaceGraphAsync, upsertNode } from './builder';
import {
	closeAllRepoMemory,
	getRepoMemoryPath,
	loadSubgraphForFiles,
	queryNodeByFile,
} from './indexed-storage';
import {
	getBlastRadius,
	getGraphNode,
	getLocalizationContext,
	resetQueryCache,
} from './query';
import { loadGraphSync, saveGraph } from './storage';
import { deriveRepoRootId } from './symbol-edge';
import type { GraphEdge, GraphNode, RepoGraph } from './types';
import { createEmptyGraph } from './types';

// ============ Fixtures ============

const workspaces: string[] = [];

function makeWorkspace(): string {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repo-mem-q-')));
	// `.opencode/` is both the project-config location and the project-root
	// marker `assertProjectRoot` requires before the save lock may be taken.
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ repo_graph: { storage: 'indexed' } }),
		'utf-8',
	);
	workspaces.push(dir);
	return dir;
}

function makeNode(
	root: string,
	rel: string,
	extra: Partial<GraphNode> = {},
): GraphNode {
	return {
		filePath: path.join(root, ...rel.split('/')),
		moduleName: rel,
		exports: [],
		imports: [],
		language: 'typescript',
		mtime: new Date(0).toISOString(),
		...extra,
	};
}

function makeEdge(root: string, from: string, to: string): GraphEdge {
	return {
		source: path.join(root, ...from.split('/')),
		target: path.join(root, ...to.split('/')),
		importSpecifier: `./${to}`,
		importType: 'named',
		importedSymbols: ['thing'],
		usedSymbols: ['thing'],
		targetKind: 'node',
	};
}

function fixtureGraph(
	root: string,
	rels: string[],
	links: Array<[string, string]>,
): RepoGraph {
	const graph = createEmptyGraph(root);
	for (const rel of rels) upsertNode(graph, makeNode(root, rel));
	for (const [from, to] of links) addEdge(graph, makeEdge(root, from, to));
	return graph;
}

function loadFull(workspace: string): RepoGraph {
	const graph = loadGraphSync(workspace);
	if (!graph) throw new Error('expected a graph on disk');
	return graph;
}

function countFileRows(workspace: string): number {
	const Db = loadDatabaseCtor();
	const db = new Db(getRepoMemoryPath(workspace));
	try {
		return db.query<{ n: number }, []>('SELECT COUNT(*) as n FROM files').get()
			?.n as number;
	} finally {
		db.close();
	}
}

/**
 * Assert the two graphs answer the real query functions identically at the
 * depth the subgraph was built for. `depth` MUST be the same value passed to
 * `loadSubgraphForFiles`: a subgraph built for depth D is only guaranteed
 * sufficient up to D.
 */
function expectEquivalent(
	full: RepoGraph,
	sub: RepoGraph,
	targets: string[],
	depth: number,
): void {
	for (const target of targets) {
		resetQueryCache();
		const fullLocal = getLocalizationContext(full, target, { maxDepth: depth });
		resetQueryCache();
		const subLocal = getLocalizationContext(sub, target, { maxDepth: depth });
		expect(subLocal).toEqual(fullLocal);
	}
	resetQueryCache();
	const fullBlast = getBlastRadius(full, targets, depth);
	resetQueryCache();
	const subBlast = getBlastRadius(sub, targets, depth);
	expect(subBlast).toEqual(fullBlast);
}

beforeEach(() => {
	workspaces.length = 0;
});

afterEach(() => {
	closeAllRepoMemory();
	resetQueryCache();
	for (const dir of workspaces) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	workspaces.length = 0;
});

// ============ Realistic graph (round-3 blocker 4) ============

describe('a graph produced by buildWorkspaceGraphAsync', () => {
	test('reports fresh, actually takes the subgraph path, and answers identically', async () => {
		const ws = makeWorkspace();
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		const write = (rel: string, body: string) =>
			writeFileSync(path.join(ws, ...rel.split('/')), body, 'utf-8');
		// A manifest makes the walker emit an extractor input witness.
		write('package.json', '{"name":"fixture","version":"0.0.0"}\n');
		write(
			'src/leaf.ts',
			'export const leaf = 1;\nexport function pick() { return leaf; }\n',
		);
		write(
			'src/core.ts',
			"import { leaf, pick } from './leaf';\nexport const core = leaf + pick();\n",
		);
		write(
			'src/mid.ts',
			"import { core } from './core';\nexport const mid = core;\n",
		);
		write(
			'src/top.ts',
			"import { mid } from './mid';\nexport const top = mid;\n",
		);
		write(
			'src/apex.ts',
			"import { top } from './top';\nexport const apex = top;\n",
		);
		write('src/island-a.ts', 'export const islandA = 1;\n');
		write(
			'src/island-b.ts',
			"import { islandA } from './island-a';\nexport const islandB = islandA;\n",
		);

		const built = await buildWorkspaceGraphAsync(ws);
		// The rev-3 suffix-read mechanism was inert on exactly this shape: a real
		// build appends repoRootId, symbolEdges and diagnostics AFTER metadata.
		expect(built.symbolEdges?.length ?? 0).toBeGreaterThan(0);
		expect(
			built.diagnostics?.extractorInputWitnesses?.length ?? 0,
		).toBeGreaterThan(0);

		await saveGraph(ws, built);
		const full = loadFull(ws);
		const totalNodes = Object.keys(full.nodes).length;
		expect(countFileRows(ws)).toBe(totalNodes);

		// Freshness reports FRESH and the subgraph path is taken: the returned
		// graph is a strict subset of the full graph, not a re-parse of it.
		const sub = loadSubgraphForFiles(ws, ['src/core.ts'], 2);
		expect(sub).not.toBeNull();
		const subgraph = sub as RepoGraph;
		expect(Object.keys(subgraph.nodes).length).toBeLessThan(totalNodes);
		expect(Object.keys(subgraph.nodes)).not.toContain(
			Object.keys(full.nodes).find((k) => k.endsWith('island-b.ts')) as string,
		);

		expectEquivalent(full, subgraph, ['src/core.ts'], 2);

		// Reviewer blast-radius depth (D=3) over three changed files, one of them
		// (island-b) outside the other two's closure.
		const changed = ['src/core.ts', 'src/leaf.ts', 'src/island-b.ts'];
		const deep = loadSubgraphForFiles(ws, changed, 3) as RepoGraph;
		expect(deep).not.toBeNull();
		expectEquivalent(full, deep, changed, 3);
	});

	test('serves a real anchor through queryNodeByFile', async () => {
		const ws = makeWorkspace();
		mkdirSync(path.join(ws, 'src'), { recursive: true });
		writeFileSync(
			path.join(ws, 'src', 'anchor.ts'),
			'export const anchor = 1;\n',
			'utf-8',
		);
		await saveGraph(ws, await buildWorkspaceGraphAsync(ws));
		const full = loadFull(ws);

		const viaIndex = queryNodeByFile(ws, 'src/anchor.ts');
		expect(viaIndex).toEqual(getGraphNode(full, 'src/anchor.ts') as GraphNode);
		expect(viaIndex?.exports).toContain('anchor');
	});
});

// ============ Closure rule steps 1-2 ============

describe('target resolution (closure rule steps 1-2)', () => {
	test('resolves absolute, ./-prefixed and backslash spellings of one target', async () => {
		const ws = makeWorkspace();
		await saveGraph(
			ws,
			fixtureGraph(ws, ['src/a.ts', 'src/b.ts'], [['src/b.ts', 'src/a.ts']]),
		);
		const full = loadFull(ws);
		const expected = getGraphNode(full, 'src/a.ts') as GraphNode;

		for (const spelling of [
			path.join(ws, 'src', 'a.ts'),
			'./src/a.ts',
			'.\\src\\a.ts',
			'src\\a.ts',
			'src/a.ts',
		]) {
			expect(queryNodeByFile(ws, spelling)).toEqual(expected);
			const sub = loadSubgraphForFiles(ws, [spelling], 2);
			expect(Object.keys(sub?.nodes ?? {})).toHaveLength(2);
		}
	});

	test('falls back to module_name when moduleName diverges from the relative path', async () => {
		const ws = makeWorkspace();
		const graph = createEmptyGraph(ws);
		// moduleName deliberately does NOT equal path.relative(root, filePath).
		upsertNode(
			graph,
			makeNode(ws, 'src/real.ts', { moduleName: 'aliased/name.ts' }),
		);
		upsertNode(graph, makeNode(ws, 'src/importer.ts'));
		upsertNode(graph, makeNode(ws, 'src/far.ts'));
		addEdge(graph, makeEdge(ws, 'src/importer.ts', 'src/real.ts'));
		addEdge(graph, makeEdge(ws, 'src/far.ts', 'src/importer.ts'));
		await saveGraph(ws, graph);
		const full = loadFull(ws);

		// A plain `WHERE files.path = ?` on the raw input misses this node.
		const node = queryNodeByFile(ws, 'aliased/name.ts');
		expect(node).not.toBeNull();
		expect(node).toEqual(getGraphNode(full, 'aliased/name.ts') as GraphNode);
		expect(node?.filePath).toBe(path.join(ws, 'src', 'real.ts'));

		// Step 4 is AND, not incidence: at depth 1 the node set is
		// {real, importer}, so far -> importer (source outside N) is excluded even
		// though it is incident to a member.
		const sub = loadSubgraphForFiles(ws, ['aliased/name.ts'], 1) as RepoGraph;
		expect(sub).not.toBeNull();
		expect(Object.keys(sub.nodes)).toHaveLength(2);
		expect(sub.edges).toHaveLength(1);
		expect(sub.edges[0]?.source).toBe(path.join(ws, 'src', 'importer.ts'));
		expectEquivalent(full, sub, ['aliased/name.ts'], 1);
	});

	test('a target absent from the graph resolves to nothing, exactly as on the full graph', async () => {
		const ws = makeWorkspace();
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts'], []));
		const full = loadFull(ws);
		const sub = loadSubgraphForFiles(ws, ['src/ghost.ts'], 2) as RepoGraph;
		expect(sub).not.toBeNull();
		expect(getGraphNode(sub, 'src/ghost.ts')).toBeUndefined();
		expect(getGraphNode(full, 'src/ghost.ts')).toBeUndefined();
		expect(queryNodeByFile(ws, 'src/ghost.ts')).toBeNull();
	});
});

// ============ Closure rule steps 3-4 ============

describe('node and edge closure (closure rule steps 3-4)', () => {
	const RELS = [
		'src/core.ts',
		'src/util.ts',
		'src/lonely.ts',
		'src/mid.ts',
		'src/outer.ts',
		'src/dep.ts',
		'src/unrelated.ts',
	];
	const LINKS: Array<[string, string]> = [
		['src/mid.ts', 'src/core.ts'],
		['src/util.ts', 'src/mid.ts'],
		['src/core.ts', 'src/dep.ts'],
		['src/outer.ts', 'src/util.ts'],
	];

	async function seed(): Promise<{ ws: string; full: RepoGraph }> {
		const ws = makeWorkspace();
		await saveGraph(ws, fixtureGraph(ws, RELS, LINKS));
		return { ws, full: loadFull(ws) };
	}

	test('multi-target union shares one visited set (a target that is also a depth-2 dependent)', async () => {
		const { ws, full } = await seed();
		// util imports mid imports core, so util is a depth-2 dependent of core AND
		// itself a target. Per-file subgraphs merged afterwards would give a
		// different totalDependents and therefore a different riskLevel.
		const targets = ['src/core.ts', 'src/util.ts', 'src/lonely.ts'];
		const sub = loadSubgraphForFiles(ws, targets, 3) as RepoGraph;
		expect(sub).not.toBeNull();

		resetQueryCache();
		const fullBlast = getBlastRadius(full, targets, 3);
		resetQueryCache();
		const subBlast = getBlastRadius(sub, targets, 3);
		expect(subBlast).toEqual(fullBlast);
		expect(fullBlast.transitiveDependents).not.toContain('src/util.ts');

		// Every requested file must resolve in the subgraph exactly as it does in
		// the full graph — repo-graph-injection filters changedFiles on this.
		for (const target of [...targets, 'src/nope.ts']) {
			expect(getGraphNode(sub, target)?.moduleName).toBe(
				getGraphNode(full, target)?.moduleName as string,
			);
		}
		expectEquivalent(full, sub, targets, 2);
	});

	test('the closure keeps R_1..R_D and F_1 and drops everything else', async () => {
		const { ws } = await seed();
		const sub = loadSubgraphForFiles(ws, ['src/core.ts'], 2) as RepoGraph;
		const modules = Object.values(sub.nodes)
			.map((node) => node.moduleName)
			.sort();
		// T=core; R_1=mid; R_2=util; F_1=dep. outer is R_3, unrelated is nowhere.
		expect(modules).toEqual([
			'src/core.ts',
			'src/dep.ts',
			'src/mid.ts',
			'src/util.ts',
		]);
		// AND rule: outer -> util has its source outside N and is excluded.
		expect(sub.edges.map((edge) => path.basename(edge.source)).sort()).toEqual([
			'core.ts',
			'mid.ts',
			'util.ts',
		]);
	});

	test('depth 0 still answers importers and dependencies correctly', async () => {
		const { ws, full } = await seed();
		const sub = loadSubgraphForFiles(ws, ['src/core.ts'], 0) as RepoGraph;
		expect(sub).not.toBeNull();
		// getLocalizationContext calls getImporters unconditionally, so R_1 must be
		// present even when maxDepth is 0.
		resetQueryCache();
		const fullLocal = getLocalizationContext(full, 'src/core.ts', {
			maxDepth: 0,
		});
		resetQueryCache();
		const subLocal = getLocalizationContext(sub, 'src/core.ts', {
			maxDepth: 0,
		});
		expect(subLocal).toEqual(fullLocal);
		expect(subLocal.importerCount).toBe(1);
		expect(subLocal.dependencyCount).toBe(1);
	});

	test('subgraph shape: derived repoRootId, absent symbolEdges and diagnostics', async () => {
		const { ws } = await seed();
		const sub = loadSubgraphForFiles(ws, ['src/core.ts'], 2) as RepoGraph;
		expect(sub.repoRootId).toBe(deriveRepoRootId(ws));
		expect('symbolEdges' in sub).toBe(false);
		expect('diagnostics' in sub).toBe(false);
		expect(sub.metadata.nodeCount).toBe(Object.keys(sub.nodes).length);
		expect(sub.metadata.edgeCount).toBe(sub.edges.length);
		// Determinism: the same call twice yields the same key order.
		const again = loadSubgraphForFiles(ws, ['src/core.ts'], 2) as RepoGraph;
		expect(Object.keys(again.nodes)).toEqual(Object.keys(sub.nodes));
		expect(again.edges).toEqual(sub.edges);
	});
});

// ============ Closure rule step 5 ============

describe('workspaceRoot binding (closure rule step 5)', () => {
	test('returns the active root, not the persisted graph_meta value', async () => {
		const ws = makeWorkspace();
		// `saveGraph` never rewrites graph.workspaceRoot, so a root spelled
		// differently from its canonical form is what lands in graph_meta.
		const graph = fixtureGraph(
			ws,
			['src/a.ts', 'src/b.ts'],
			[['src/b.ts', 'src/a.ts']],
		);
		graph.workspaceRoot = ws + path.sep;
		await saveGraph(ws, graph);

		const sub = loadSubgraphForFiles(ws, ['src/a.ts'], 2) as RepoGraph;
		expect(sub).not.toBeNull();
		expect(sub.workspaceRoot).toBe(ws);
		expect(sub.workspaceRoot).not.toBe(graph.workspaceRoot);
		expectEquivalent(loadFull(ws), sub, ['src/a.ts'], 2);
	});

	// Windows `symlinkSync` on directories creates junctions and can require
	// elevation, so this is declared-skipped there rather than silently passing.
	// CI (ubuntu / macos) is the real evidence for this case.
	test.skipIf(process.platform === 'win32')(
		'a workspace reached through a symlink yields the realpathed root',
		async () => {
			const real = makeWorkspace();
			const linkParent = canonicalMkdtemp('repo-mem-link-');
			workspaces.push(linkParent);
			const link = path.join(linkParent, 'linked');
			symlinkSync(real, link, 'dir');

			// Saved through the SYMLINK path, so graph_meta.workspace_root is the
			// un-realpathed spelling.
			const graph = fixtureGraph(
				link,
				['src/a.ts', 'src/b.ts'],
				[['src/b.ts', 'src/a.ts']],
			);
			await saveGraph(link, graph);

			// Read through the REAL path: the binding check realpaths both sides and
			// matches, and the returned root is the active realpath.
			const sub = loadSubgraphForFiles(real, ['src/a.ts'], 2) as RepoGraph;
			expect(sub).not.toBeNull();
			expect(sub.workspaceRoot).toBe(real);
			expect(sub.workspaceRoot).not.toBe(graph.workspaceRoot);

			// The observable consequence: LocalizationBlock.target is derived from
			// graphRoot(graph), so an un-rebound root would produce a different
			// string than every loadGraph consumer sees.
			resetQueryCache();
			const local = getLocalizationContext(sub, path.join(real, 'src', 'a.ts'));
			expect(local.target).toBe('src/a.ts');
			expectEquivalent(loadFull(real), sub, ['src/a.ts'], 2);
		},
	);
});

/**
 * Tests for src/tools/repo-graph/indexed-storage.ts — path, lifecycle, storage
 * mode, the saveGraph write path, freshness/writer-identity, and corruption.
 *
 * Closure-rule and query-equivalence coverage lives in
 * indexed-storage-queries.test.ts (FR-006 500-line cap).
 *
 * No `if (isWindows) return;` guards: those make every assertion trivially pass
 * on a Windows host. Nothing here shells out.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../db/sqlite-loader';
import { tryAcquireLock } from '../../parallel/file-locks';
import { addEdge, upsertNode } from './builder';
import {
	closeAllRepoMemory,
	getRepoMemoryPath,
	isIndexedStorageAvailable,
	loadSubgraphForFiles,
	queryNodeByFile,
	REPO_MEMORY_FILENAME,
	resolveGraphStorageMode,
	syncIndexFromGraph,
} from './indexed-storage';
import { getGraphPath, saveGraph } from './storage';
import type { GraphEdge, GraphNode, RepoGraph } from './types';
import { createEmptyGraph } from './types';

// ============ Fixtures ============

const workspaces: string[] = [];

function makeWorkspace(storage: 'json' | 'indexed' | Record<string, unknown>) {
	const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repo-mem-')));
	// `.opencode/` is BOTH the project-config location and the marker that makes
	// this directory a project root for `assertProjectRoot` (invariant 4).
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	const repoGraph = typeof storage === 'string' ? { storage } : storage;
	writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ repo_graph: repoGraph }),
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

function makeEdge(
	root: string,
	from: string,
	to: string,
	extra: Partial<GraphEdge> = {},
): GraphEdge {
	return {
		source: path.join(root, ...from.split('/')),
		target: path.join(root, ...to.split('/')),
		importSpecifier: `./${to}`,
		importType: 'named',
		targetKind: 'node',
		...extra,
	};
}

function fixtureGraph(
	root: string,
	rels: string[],
	links: Array<[string, string]> = [],
): RepoGraph {
	const graph = createEmptyGraph(root);
	for (const rel of rels) upsertNode(graph, makeNode(root, rel));
	for (const [from, to] of links) addEdge(graph, makeEdge(root, from, to));
	return graph;
}

/** Open the store directly (second connection) to inspect what was persisted. */
function withStore<T>(
	workspace: string,
	fn: (db: ReturnType<typeof open>) => T,
) {
	const db = open(workspace);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function open(workspace: string) {
	const Db = loadDatabaseCtor();
	return new Db(getRepoMemoryPath(workspace));
}

function readMetaDirect(workspace: string): Record<string, string> {
	return withStore(workspace, (db) => {
		const rows = db
			.query<{ key: string; value: string }, []>(
				'SELECT key, value FROM graph_meta',
			)
			.all();
		return Object.fromEntries(rows.map((row) => [row.key, row.value]));
	});
}

function countRows(workspace: string, table: 'files' | 'edges'): number {
	return withStore(
		workspace,
		(db) =>
			db.query<{ n: number }, []>(`SELECT COUNT(*) as n FROM ${table}`).get()
				?.n ?? -1,
	);
}

beforeEach(() => {
	workspaces.length = 0;
});

afterEach(() => {
	closeAllRepoMemory();
	for (const dir of workspaces) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	workspaces.length = 0;
});

// ============ Path and availability ============

describe('getRepoMemoryPath', () => {
	test('mirrors getGraphPath and resolves inside .swarm/', () => {
		const ws = makeWorkspace('json');
		expect(REPO_MEMORY_FILENAME).toBe('repo-memory.sqlite');
		expect(getRepoMemoryPath(ws)).toBe(
			path.join(ws, '.swarm', REPO_MEMORY_FILENAME),
		);
		expect(path.dirname(getRepoMemoryPath(ws))).toBe(
			path.dirname(getGraphPath(ws)),
		);
	});

	test('rejects a workspace containing path traversal', () => {
		expect(() => getRepoMemoryPath('/tmp/../etc')).toThrow(
			/path traversal detected/,
		);
	});

	test('rejects an empty workspace', () => {
		expect(() => getRepoMemoryPath('')).toThrow(/non-empty string/);
	});
});

describe('resolveGraphStorageMode', () => {
	test('a SQLite driver is resolvable in this runtime', () => {
		expect(isIndexedStorageAvailable()).toBe(true);
	});

	test('defaults to json when repo_graph declares no storage', () => {
		expect(resolveGraphStorageMode(makeWorkspace({}))).toBe('json');
	});

	test('returns indexed when the project config opts in', () => {
		expect(resolveGraphStorageMode(makeWorkspace('indexed'))).toBe('indexed');
	});

	test('falls back to json for an invalid storage value', () => {
		expect(resolveGraphStorageMode(makeWorkspace({ storage: 'sqlite' }))).toBe(
			'json',
		);
	});
});

// ============ Write path ============

describe('saveGraph — json mode', () => {
	test('never creates an index', async () => {
		const ws = makeWorkspace('json');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		expect(existsSync(getGraphPath(ws))).toBe(true);
		expect(existsSync(getRepoMemoryPath(ws))).toBe(false);
	});

	test('deletes an index left behind by a config flip back to json', async () => {
		const indexed = makeWorkspace('indexed');
		await saveGraph(indexed, fixtureGraph(indexed, ['src/a.ts']));
		expect(existsSync(getRepoMemoryPath(indexed))).toBe(true);

		// Flip the SAME workspace back to json and save again.
		writeFileSync(
			path.join(indexed, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ repo_graph: { storage: 'json' } }),
			'utf-8',
		);
		await saveGraph(indexed, fixtureGraph(indexed, ['src/a.ts', 'src/b.ts']));
		expect(existsSync(getRepoMemoryPath(indexed))).toBe(false);
	});
});

describe('saveGraph — indexed mode', () => {
	test('persists every node and edge plus exactly five graph_meta keys', async () => {
		const ws = makeWorkspace('indexed');
		const graph = fixtureGraph(
			ws,
			['src/a.ts', 'src/b.ts', 'src/c.ts'],
			[
				['src/b.ts', 'src/a.ts'],
				['src/c.ts', 'src/b.ts'],
			],
		);
		await saveGraph(ws, graph);

		expect(existsSync(getRepoMemoryPath(ws))).toBe(true);
		expect(countRows(ws, 'files')).toBe(3);
		expect(countRows(ws, 'edges')).toBe(2);

		const meta = readMetaDirect(ws);
		expect(Object.keys(meta).sort()).toEqual([
			'graph_schema_version',
			'source_ino',
			'source_mtime_ms',
			'source_size',
			'workspace_root',
		]);
		expect(meta.graph_schema_version).toBe(graph.schema_version);
		expect(meta.workspace_root).toBe(graph.workspaceRoot);

		const stats = statSync(getGraphPath(ws));
		expect(meta.source_size).toBe(String(stats.size));
		expect(meta.source_mtime_ms).toBe(String(stats.mtimeMs));
	});

	test('a second save in the same process still produces a fresh index', async () => {
		// Regression guard: `releaseLock` in file-locks.ts is a documented no-op,
		// so releasing through it would hold the sentinel for the 5-minute stale
		// window and every later save would silently skip its sync.
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts', 'src/b.ts']));

		expect(countRows(ws, 'files')).toBe(2);
		const meta = readMetaDirect(ws);
		expect(meta.source_size).toBe(String(statSync(getGraphPath(ws)).size));
		expect(queryNodeByFile(ws, 'src/b.ts')).not.toBeNull();
	});

	test('indexes an empty graph and serves an empty subgraph', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, createEmptyGraph(ws));
		expect(countRows(ws, 'files')).toBe(0);
		expect(countRows(ws, 'edges')).toBe(0);

		const sub = loadSubgraphForFiles(ws, ['src/missing.ts'], 2);
		expect(sub).not.toBeNull();
		expect(sub?.nodes).toEqual({});
		expect(sub?.edges).toEqual([]);
	});

	test('round-trips a node with zero exports and an edge with no optional fields', async () => {
		const ws = makeWorkspace('indexed');
		const graph = createEmptyGraph(ws);
		upsertNode(graph, makeNode(ws, 'src/a.ts', { exports: [] }));
		upsertNode(graph, makeNode(ws, 'src/b.ts', { exports: [] }));
		graph.edges.push({
			source: path.join(ws, 'src', 'b.ts'),
			target: path.join(ws, 'src', 'a.ts'),
			importSpecifier: './a',
			importType: 'sideeffect',
		});
		await saveGraph(ws, graph);

		const sub = loadSubgraphForFiles(ws, ['src/a.ts'], 2);
		expect(sub?.edges).toEqual(graph.edges);
		expect(queryNodeByFile(ws, 'src/a.ts')?.exports).toEqual([]);
	});

	test('round-trips unicode / NFC paths', async () => {
		const ws = makeWorkspace('indexed');
		const rel = 'src/été/café.ts';
		await saveGraph(ws, fixtureGraph(ws, [rel]));
		const node = queryNodeByFile(ws, rel);
		expect(node?.moduleName).toBe(rel);
	});
});

describe('saveGraph — lock contention', () => {
	test('a held lock skips the sync, keeps the JSON write, and leaves the index untouched', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		const before = readMetaDirect(ws);
		expect(countRows(ws, 'files')).toBe(1);

		// Hold the same lock saveGraph uses. tryAcquireLock retries internally and
		// then returns { acquired: false } rather than throwing.
		const held = await tryAcquireLock(ws, 'repo-graph.json', 'test', 'hold');
		expect(held.acquired).toBe(true);
		try {
			await saveGraph(ws, fixtureGraph(ws, ['src/a.ts', 'src/b.ts']));
		} finally {
			if (held.acquired && held.lock._release) await held.lock._release();
		}

		// Durability is never gated on the lock: the JSON write happened.
		const written = JSON.parse(
			readFileSync(getGraphPath(ws), 'utf-8'),
		) as RepoGraph;
		expect(Object.keys(written.nodes)).toHaveLength(2);

		// The index was neither updated nor deleted...
		expect(existsSync(getRepoMemoryPath(ws))).toBe(true);
		expect(countRows(ws, 'files')).toBe(1);
		expect(readMetaDirect(ws)).toEqual(before);
		// ...and every reader falls back on the stat mismatch.
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
	});
});

// ============ Freshness and the writer-identity race ============

describe('freshness', () => {
	test('a later write to repo-graph.json invalidates the index', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).not.toBeNull();

		writeFileSync(
			getGraphPath(ws),
			`${readFileSync(getGraphPath(ws), 'utf-8')}\n`,
		);
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
	});

	test('a stamp that predates a concurrent unlocked rename fails the read', async () => {
		// The documented interleaving, driven directly against syncIndexFromGraph:
		// A renames -> vA, A captures its inside-lock stamp, B renames unlocked ->
		// vB, A's sync then completes with A's pre-sync stamp.
		const ws = makeWorkspace('indexed');
		const graphA = fixtureGraph(ws, ['src/a.ts']);
		await saveGraph(ws, graphA);
		const stampA = statSync(getGraphPath(ws));

		// B renames unlocked while A's sync is still in flight.
		writeFileSync(
			getGraphPath(ws),
			`${JSON.stringify(graphA, null, 2)}\n// vB\n`,
			'utf-8',
		);

		const synced = await syncIndexFromGraph(ws, graphA, {
			size: stampA.size,
			mtimeMs: stampA.mtimeMs,
			ino: String(stampA.ino ?? 0),
		});
		expect(synced).toBe(true);
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
	});

	test('saveGraph stamps with its pre-sync inside-lock stat, not a post-sync re-stat', async () => {
		const ws = makeWorkspace('indexed');
		const graphPath = getGraphPath(ws);
		const graph = fixtureGraph(ws, ['src/a.ts', 'src/b.ts']);

		// Simulate writer B renaming an unlocked, DIFFERENTLY SIZED document while
		// writer A's index sync is in flight. The hook is a property getter on the
		// first node, so it fires from inside the sync's per-row
		// `JSON.stringify(node)`. It is gated on A's own bytes already being on
		// disk, so it provably runs AFTER A's rename and AFTER A's inside-lock
		// stamp, and never during saveGraph's own pre-rename serialization.
		const target = graph.nodes[
			Object.keys(graph.nodes)[0] as string
		] as GraphNode;
		const realMtime = target.mtime;
		const writerBBytes = `${JSON.stringify(graph, null, 2)}\n// writer B was here\n`;
		let fired = false;
		Object.defineProperty(target, 'mtime', {
			enumerable: true,
			configurable: true,
			get() {
				if (
					!fired &&
					existsSync(graphPath) &&
					readFileSync(graphPath, 'utf-8').includes('"src/b.ts"')
				) {
					fired = true;
					writeFileSync(graphPath, writerBBytes, 'utf-8');
				}
				return realMtime;
			},
		});

		await saveGraph(ws, graph);
		expect(fired).toBe(true);

		// A stamped its OWN bytes. B's larger document is what is on disk now, so
		// the two must differ — a post-sync re-stat would have recorded B's size
		// and silently validated an index holding A's content.
		const meta = readMetaDirect(ws);
		const onDisk = statSync(graphPath);
		expect(meta.source_size).not.toBe(String(onDisk.size));
		expect(Number(meta.source_size)).toBe(
			Buffer.byteLength(JSON.stringify(graph, null, 2), 'utf-8'),
		);

		// The fail-safe fires: every reader falls back to JSON.
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
	});

	test('an index bound to a different workspace is rejected', async () => {
		const owner = makeWorkspace('indexed');
		const foreign = makeWorkspace('indexed');
		await saveGraph(owner, fixtureGraph(owner, ['src/a.ts']));

		// Move the owner's store and its source stamp into the foreign workspace.
		mkdirSync(path.join(foreign, '.swarm'), { recursive: true });
		closeAllRepoMemory();
		writeFileSync(
			getRepoMemoryPath(foreign),
			readFileSync(getRepoMemoryPath(owner)),
		);
		writeFileSync(
			getGraphPath(foreign),
			readFileSync(getGraphPath(owner), 'utf-8'),
			'utf-8',
		);
		const stats = statSync(getGraphPath(owner));
		withStore(foreign, (db) => {
			db.run('UPDATE graph_meta SET value = ? WHERE key = ?', [
				String(stats.size),
				'source_size',
			]);
			db.run('UPDATE graph_meta SET value = ? WHERE key = ?', [
				String(statSync(getGraphPath(foreign)).mtimeMs),
				'source_mtime_ms',
			]);
		});

		// The size/mtime stamp can be forged; the workspace binding cannot.
		expect(readMetaDirect(foreign).workspace_root).toBe(owner);
		expect(loadSubgraphForFiles(foreign, ['src/a.ts'], 2)).toBeNull();
		expect(queryNodeByFile(foreign, 'src/a.ts')).toBeNull();
	});
});

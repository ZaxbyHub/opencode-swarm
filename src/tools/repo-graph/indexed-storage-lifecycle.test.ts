/**
 * Corruption and lifecycle tests for src/tools/repo-graph/indexed-storage.ts
 * (issue #1534).
 *
 * Split from indexed-storage.test.ts for the FR-006 500-line cap; the write
 * path and freshness live there, closure-rule coverage in
 * indexed-storage-queries.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../db/sqlite-loader';
import { addEdge, upsertNode } from './builder';
import {
	closeAllRepoMemory,
	deleteRepoMemory,
	getRepoMemoryPath,
	loadSubgraphForFiles,
	queryNodeByFile,
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
}); // ============ Corruption ============

describe('corruption handling', () => {
	test('garbage bytes are discarded and the reader returns null', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		closeAllRepoMemory();
		writeFileSync(getRepoMemoryPath(ws), 'not a database at all', 'utf-8');

		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
		expect(existsSync(getRepoMemoryPath(ws))).toBe(false);
	});

	test('a valid SQLite file with no schema_migrations is discarded', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		closeAllRepoMemory();
		deleteRepoMemory(ws);
		mkdirSync(path.join(ws, '.swarm'), { recursive: true });
		const Db = loadDatabaseCtor();
		const foreign = new Db(getRepoMemoryPath(ws));
		foreign.run('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
		foreign.close();

		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
		expect(existsSync(getRepoMemoryPath(ws))).toBe(false);
	});

	test('a future schema version is not read, is not deleted, and self-repairs on the next save', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		closeAllRepoMemory();
		withStore(ws, (db) => {
			db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
				99,
				'from_a_newer_build',
			]);
		});

		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
		// Structurally valid, just unreadable here: it is NOT destroyed.
		expect(existsSync(getRepoMemoryPath(ws))).toBe(true);

		closeAllRepoMemory();
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts', 'src/b.ts']));
		expect(countRows(ws, 'files')).toBe(2);
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).not.toBeNull();
	});

	test('a missing store is simply absent, not an error', () => {
		const ws = makeWorkspace('indexed');
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
	});
});

// ============ Lifecycle ============

describe('lifecycle', () => {
	test('deleteRepoMemory removes the store and its WAL sidecars', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		const store = getRepoMemoryPath(ws);
		expect(existsSync(store)).toBe(true);

		deleteRepoMemory(ws);
		for (const suffix of ['', '-wal', '-shm']) {
			expect(existsSync(`${store}${suffix}`)).toBe(false);
		}
	});

	test('deleteRepoMemory is a no-op when nothing exists', () => {
		const ws = makeWorkspace('indexed');
		expect(() => deleteRepoMemory(ws)).not.toThrow();
	});

	test('a synced index survives closeAllRepoMemory and reopens', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts']));
		closeAllRepoMemory();
		expect(queryNodeByFile(ws, 'src/a.ts')?.moduleName).toBe('src/a.ts');
	});
});

// ============ Bounded sync ============

describe('sync budget', () => {
	test('exceeding the wall-clock budget aborts the transaction and discards the index', async () => {
		// SYNC_BUDGET_MS is 2 s and the budget is checked every 500 rows, so the
		// graph needs >= 500 nodes and one of them must burn more than the budget
		// while its row is being serialized. Atomics.wait is a synchronous sleep
		// (no Bun.* call, no busy loop); this is not synchronisation — the branch
		// under test is inherently wall-clock-driven.
		const ws = makeWorkspace('indexed');
		const rels = Array.from({ length: 520 }, (_, i) => `src/n${i}.ts`);
		const graph = fixtureGraph(ws, rels);
		await saveGraph(ws, graph);
		expect(existsSync(getRepoMemoryPath(ws))).toBe(true);
		const stamp = statSync(getGraphPath(ws));

		const first = graph.nodes[
			Object.keys(graph.nodes)[0] as string
		] as GraphNode;
		const realMtime = first.mtime;
		Object.defineProperty(first, 'mtime', {
			enumerable: true,
			configurable: true,
			get() {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
				return realMtime;
			},
		});

		const synced = await syncIndexFromGraph(ws, graph, {
			size: stamp.size,
			mtimeMs: stamp.mtimeMs,
			ino: String(stamp.ino ?? 0),
		});
		expect(synced).toBe(false);
		// Aborted transaction + discarded store: readers fall back to JSON.
		expect(existsSync(getRepoMemoryPath(ws))).toBe(false);
		expect(loadSubgraphForFiles(ws, ['src/n0.ts'], 2)).toBeNull();
	});
});

// ============ Row-level corruption ============

describe('unparseable rows', () => {
	test('repeated reads of an undeletable corrupt store stay bounded and never throw', async () => {
		// On Windows a second live connection can block the unlink in
		// deleteRepoMemory, so the corrupt store survives the corruption path. The
		// invariant that must hold on every platform: each subsequent read opens,
		// fails, closes, and returns null — degrading to the JSON path rather than
		// throwing, leaking a handle, or looping inside one call.
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts', 'src/b.ts']));
		closeAllRepoMemory();
		const Db = loadDatabaseCtor();
		const corrupt = new Db(getRepoMemoryPath(ws));
		corrupt.run("UPDATE files SET node_json = 'definitely not json'");

		// Hold `corrupt` open across every read so the unlink may fail.
		try {
			for (let attempt = 0; attempt < 3; attempt++) {
				expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
				expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
			}
		} finally {
			corrupt.close();
		}

		// Once the blocking connection is gone the next read discards the store
		// for good, so the degradation is self-healing rather than permanent.
		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
		expect(existsSync(getRepoMemoryPath(ws))).toBe(false);
	});

	test('a node_json that is not JSON discards the index and returns null', async () => {
		const ws = makeWorkspace('indexed');
		await saveGraph(ws, fixtureGraph(ws, ['src/a.ts', 'src/b.ts']));
		closeAllRepoMemory();
		const Db = loadDatabaseCtor();
		const db = new Db(getRepoMemoryPath(ws));
		db.run("UPDATE files SET node_json = 'definitely not json'");
		db.close();

		expect(queryNodeByFile(ws, 'src/a.ts')).toBeNull();
		expect(existsSync(getRepoMemoryPath(ws))).toBe(false);
	});
});

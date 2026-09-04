import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';
import { loadDatabaseCtor } from '../../db/sqlite-loader';
import { upsertNode } from './builder';
import {
	_internals,
	closeAllRepoMemory,
	getRepoMemoryPath,
	loadSubgraphForFiles,
	queryNodeByFile,
	syncIndexFromGraph,
} from './indexed-storage';
import { getGraphPath, saveGraph } from './storage';
import type { GraphEdge, GraphNode, RepoGraph } from './types';
import { createEmptyGraph } from './types';

const workspaces: string[] = [];
const realRemoveRepoMemoryFiles = _internals.removeRepoMemoryFiles;
const realUnlinkSync = _internals.unlinkSync;

function makeWorkspace(): string {
	const root = canonicalMkdtemp('repo-mem-hard-');
	mkdirSync(path.join(root, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(root, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ repo_graph: { storage: 'indexed' } }),
		'utf-8',
	);
	workspaces.push(root);
	return root;
}

function fixtureGraph(root: string): RepoGraph {
	const graph = createEmptyGraph(root);
	const node = (rel: string): GraphNode => ({
		filePath: path.join(root, ...rel.split('/')),
		moduleName: rel,
		exports: ['value'],
		imports: [],
		language: 'typescript',
		mtime: new Date(0).toISOString(),
	});
	upsertNode(graph, node('src/a.ts'));
	upsertNode(graph, node('src/b.ts'));
	graph.edges.push({
		source: path.join(root, 'src', 'a.ts'),
		target: path.join(root, 'src', 'b.ts'),
		importSpecifier: './b',
		importType: 'named',
		importedSymbols: ['value'],
		targetKind: 'node',
	});
	return graph;
}

function withStore(
	workspace: string,
	fn: (db: ReturnType<ReturnType<typeof loadDatabaseCtor>>) => void,
): void {
	const Db = loadDatabaseCtor();
	const db = new Db(getRepoMemoryPath(workspace));
	try {
		fn(db);
	} finally {
		db.close();
	}
}

beforeEach(() => {
	workspaces.length = 0;
	_internals.removeRepoMemoryFiles = realRemoveRepoMemoryFiles;
	_internals.unlinkSync = realUnlinkSync;
});

afterEach(() => {
	_internals.removeRepoMemoryFiles = realRemoveRepoMemoryFiles;
	_internals.unlinkSync = realUnlinkSync;
	closeAllRepoMemory();
	for (const workspace of workspaces) {
		rmSync(workspace, { recursive: true, force: true });
	}
	workspaces.length = 0;
});

describe('indexed row validation', () => {
	test('accepts valid indexed nodes and edges', async () => {
		const workspace = makeWorkspace();
		await saveGraph(workspace, fixtureGraph(workspace));

		expect(queryNodeByFile(workspace, 'src/a.ts')?.moduleName).toBe('src/a.ts');
		const subgraph = loadSubgraphForFiles(workspace, ['src/a.ts'], 1);
		expect(subgraph?.edges).toHaveLength(1);
	});

	test('round-trips a module name that is not already normalized', async () => {
		const workspace = makeWorkspace();
		const graph = fixtureGraph(workspace);
		upsertNode(graph, {
			filePath: path.join(workspace, 'src', 'MyFile.ts'),
			moduleName: './virtual/MyFile.ts',
			exports: ['value'],
			imports: [],
			language: 'typescript',
			mtime: new Date(0).toISOString(),
		});
		await saveGraph(workspace, graph);

		expect(queryNodeByFile(workspace, './virtual/MyFile.ts')?.moduleName).toBe(
			'./virtual/MyFile.ts',
		);
		expect(existsSync(getRepoMemoryPath(workspace))).toBe(true);
	});

	test('rejects JSON-valid nodes whose shape or row identity is corrupt', async () => {
		const workspace = makeWorkspace();
		await saveGraph(workspace, fixtureGraph(workspace));
		closeAllRepoMemory();
		withStore(workspace, (db) => {
			db.run('UPDATE files SET node_json = ? WHERE module_name = ?', [
				JSON.stringify({ filePath: 7, moduleName: 'src/a.ts' }),
				'src/a.ts',
			]);
		});

		expect(queryNodeByFile(workspace, 'src/a.ts')).toBeNull();
		expect(existsSync(getRepoMemoryPath(workspace))).toBe(false);
	});

	test('rejects valid nodes whose JSON identity disagrees with the indexed row', async () => {
		const workspace = makeWorkspace();
		await saveGraph(workspace, fixtureGraph(workspace));
		closeAllRepoMemory();
		withStore(workspace, (db) => {
			const row = db
				.query<{ node_json: string }, []>(
					"SELECT node_json FROM files WHERE module_name = 'src/a.ts'",
				)
				.get();
			const node = JSON.parse(row?.node_json ?? '{}') as GraphNode;
			node.filePath = path.join(workspace, 'src', 'b.ts');
			db.run("UPDATE files SET node_json = ? WHERE module_name = 'src/a.ts'", [
				JSON.stringify(node),
			]);
		});

		expect(queryNodeByFile(workspace, 'src/a.ts')).toBeNull();
		expect(existsSync(getRepoMemoryPath(workspace))).toBe(false);
	});

	test('rejects a valid node when only its indexed module name is corrupt', async () => {
		const workspace = makeWorkspace();
		await saveGraph(workspace, fixtureGraph(workspace));
		closeAllRepoMemory();
		withStore(workspace, (db) => {
			db.run(
				"UPDATE files SET module_name = 'src/other.ts' WHERE module_name = 'src/a.ts'",
			);
		});

		expect(queryNodeByFile(workspace, 'src/a.ts')).toBeNull();
		expect(existsSync(getRepoMemoryPath(workspace))).toBe(false);
	});

	test('rejects JSON-valid edges whose row identity is corrupt', async () => {
		const workspace = makeWorkspace();
		await saveGraph(workspace, fixtureGraph(workspace));
		closeAllRepoMemory();
		withStore(workspace, (db) => {
			const edge = db
				.query<{ edge_json: string }, []>('SELECT edge_json FROM edges LIMIT 1')
				.get();
			const parsed = JSON.parse(edge?.edge_json ?? '{}') as GraphEdge;
			parsed.target = path.join(workspace, 'src', 'a.ts');
			db.run('UPDATE edges SET edge_json = ?', [JSON.stringify(parsed)]);
		});

		expect(loadSubgraphForFiles(workspace, ['src/a.ts'], 1)).toBeNull();
		expect(existsSync(getRepoMemoryPath(workspace))).toBe(false);
	});
});

describe('bounded handle lifecycle', () => {
	test('keeps at most the LRU cap and refreshes reads', async () => {
		const roots = Array.from({ length: _internals.maxOpenHandles }, () =>
			makeWorkspace(),
		);
		for (const root of roots) await saveGraph(root, fixtureGraph(root));

		expect(_internals.openHandleCount()).toBe(_internals.maxOpenHandles);
		expect(queryNodeByFile(roots[0] as string, 'src/a.ts')).not.toBeNull();
		const extra = makeWorkspace();
		await saveGraph(extra, fixtureGraph(extra));

		expect(_internals.openHandleCount()).toBe(_internals.maxOpenHandles);
		expect(_internals.hasOpenHandle(roots[0] as string)).toBe(true);
		expect(_internals.hasOpenHandle(roots[1] as string)).toBe(false);
		expect(_internals.hasOpenHandle(extra)).toBe(true);
	});

	test('eviction remains bounded when the oldest handle close throws', () => {
		const throwingClose = mock(() => {
			throw new Error('simulated close failure');
		});
		for (let index = 0; index < _internals.maxOpenHandles; index++) {
			const close = index === 0 ? throwingClose : mock(() => undefined);
			_internals.cacheHandle(`test-store-${index}`, {
				close,
			} as unknown as Database);
		}

		expect(() =>
			_internals.cacheHandle('test-store-extra', {
				close: mock(() => undefined),
			} as unknown as Database),
		).not.toThrow();
		expect(throwingClose).toHaveBeenCalledTimes(1);
		expect(_internals.openHandleCount()).toBe(_internals.maxOpenHandles);
	});

	test('reports a real non-ENOENT unlink failure', async () => {
		const workspace = makeWorkspace();
		await saveGraph(workspace, fixtureGraph(workspace));
		closeAllRepoMemory();
		const storePath = getRepoMemoryPath(workspace);
		_internals.unlinkSync = (target) => {
			if (target === storePath) {
				throw Object.assign(new Error('simulated permission failure'), {
					code: 'EPERM',
				});
			}
			return realUnlinkSync(target);
		};

		expect(_internals.removeRepoMemoryFiles(workspace)).toBe(false);
		expect(existsSync(storePath)).toBe(true);
	});

	test('does not reopen a future-schema store when deletion fails', async () => {
		const workspace = makeWorkspace();
		const graph = fixtureGraph(workspace);
		await saveGraph(workspace, graph);
		closeAllRepoMemory();
		withStore(workspace, (db) => {
			db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
				99,
				'future',
			]);
		});
		const source = statSync(getGraphPath(workspace));
		_internals.removeRepoMemoryFiles = () => false;

		expect(
			await syncIndexFromGraph(workspace, graph, {
				size: source.size,
				mtimeMs: source.mtimeMs,
				ino: String(source.ino ?? 0),
			}),
		).toBe(false);
		expect(_internals.openHandleCount()).toBe(0);
		expect(existsSync(getRepoMemoryPath(workspace))).toBe(true);
		withStore(workspace, (db) => {
			expect(
				db
					.query<{ version: number }, []>(
						'SELECT MAX(version) AS version FROM schema_migrations',
					)
					.get()?.version,
			).toBe(99);
		});
	});
});

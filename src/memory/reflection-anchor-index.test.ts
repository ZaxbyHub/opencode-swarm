/**
 * Issue #1534 — indexed anchor resolution in the reflection service.
 *
 * `loadBoundedGraph` returns null outright when `.swarm/repo-graph.json`
 * exceeds MAX_GRAPH_BYTES (16 MB) — precisely the large-repo case this feature
 * exists for — after which every anchor loses its `packageBoundary` and falls
 * back to bare file existence. Consulting the SQLite index there is a PURE
 * WIDENING: it may only ADD `packageBoundary`, and must never mark an anchor
 * dead that the current code would call alive. These tests pin both halves.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GraphNode, RepoGraph } from '../tools/repo-graph/types';
import { normalizeGraphPath } from '../tools/repo-graph/types';
import { _internals, _test_exports } from './reflection-service';

const originalResolveMode = _internals.resolveGraphStorageMode;
const originalQueryNode = _internals.queryNodeByFile;

let tmp: string;
let modeCalls: string[];
let nodeCalls: Array<{ workspace: string; file: string }>;

function indexedNode(moduleName: string, boundary: string): GraphNode {
	return {
		filePath: normalizeGraphPath(path.join(tmp, moduleName)),
		moduleName,
		exports: ['run'],
		imports: [],
		language: 'typescript',
		mtime: '2024-01-01T00:00:00.000Z',
		ontology: {
			roles: ['source_module'],
			packageBoundary: boundary,
			routes: [],
			dataOperations: [],
			security: [],
			conventions: [],
			findings: [],
		},
	};
}

function write(relative: string): void {
	const target = path.join(tmp, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, 'export const run = 1;\n');
}

function makeGraph(moduleNames: readonly string[]): RepoGraph {
	const nodes: Record<string, GraphNode> = {};
	for (const moduleName of moduleNames) {
		const node = indexedNode(moduleName, 'from-json');
		nodes[node.filePath] = node;
	}
	return {
		schema_version: '1.3.0',
		workspaceRoot: tmp,
		nodes,
		edges: [],
		metadata: {
			generatedAt: '2024-01-01T00:00:00.000Z',
			generator: 'test',
			nodeCount: moduleNames.length,
			edgeCount: 0,
		},
	};
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refl-anchor-')));
	modeCalls = [];
	nodeCalls = [];
	write('src/core/util.ts');
	write('src/plain/on-disk.ts');
	_internals.resolveGraphStorageMode = (workspace: string) => {
		modeCalls.push(workspace);
		return 'indexed';
	};
	_internals.queryNodeByFile = (workspace: string, file: string) => {
		nodeCalls.push({ workspace, file });
		return file === 'src/core/util.ts'
			? indexedNode('src/core/util.ts', 'core')
			: null;
	};
});

afterEach(() => {
	_internals.resolveGraphStorageMode = originalResolveMode;
	_internals.queryNodeByFile = originalQueryNode;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('indexed anchor resolution (#1534)', () => {
	test('an anchor resolved through the index gains packageBoundary', () => {
		// graph === null is the >16 MB / unreadable case.
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		expect(resolve({ file: 'src/core/util.ts' })).toEqual({
			alive: true,
			packageBoundary: 'core',
		});
		expect(nodeCalls).toEqual([{ workspace: tmp, file: 'src/core/util.ts' }]);
	});

	test('an anchor absent from the index is still alive when the file exists', () => {
		// PURE WIDENING: the index answering "no" must leave the existing
		// containedFileExists fallback untouched.
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		expect(resolve({ file: 'src/plain/on-disk.ts' })).toEqual({ alive: true });
		expect(nodeCalls).toHaveLength(1);
	});

	test('an anchor absent from both the index and the disk is still dead', () => {
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		expect(resolve({ file: 'src/gone/missing.ts' })).toEqual({ alive: false });
	});

	test('the index never flips an alive anchor to dead', () => {
		const anchors = [
			{ file: 'src/core/util.ts' },
			{ file: 'src/plain/on-disk.ts' },
			{ file: 'src/gone/missing.ts' },
			{ file: '' },
			{ file: path.join(tmp, 'src/core/util.ts') },
		];

		_internals.resolveGraphStorageMode = () => 'json';
		const withoutIndex = _test_exports.createAnchorResolver(tmp, null);
		const baseline = anchors.map((anchor) => withoutIndex(anchor));

		_internals.resolveGraphStorageMode = (workspace: string) => {
			modeCalls.push(workspace);
			return 'indexed';
		};
		const withIndex = _test_exports.createAnchorResolver(tmp, null);
		const widened = anchors.map((anchor) => withIndex(anchor));

		for (const [index, before] of baseline.entries()) {
			// alive may only go false -> true, never true -> false...
			expect(widened[index].alive || !before.alive).toBe(true);
			// ...and packageBoundary may only be added.
			if (before.packageBoundary !== undefined) {
				expect(widened[index].packageBoundary).toBe(before.packageBoundary);
			}
		}
		// The widening actually happened, so this is not a vacuous pass.
		expect(baseline[0]).toEqual({ alive: true });
		expect(widened[0]).toEqual({ alive: true, packageBoundary: 'core' });
	});

	test('json mode never consults the index', () => {
		_internals.resolveGraphStorageMode = (workspace: string) => {
			modeCalls.push(workspace);
			return 'json';
		};
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		expect(resolve({ file: 'src/core/util.ts' })).toEqual({ alive: true });
		expect(modeCalls).toEqual([tmp]);
		expect(nodeCalls).toEqual([]);
	});

	test('a loadable JSON graph never consults the index or the config', () => {
		const graph = makeGraph(['src/core/util.ts']);
		const resolve = _test_exports.createAnchorResolver(tmp, graph);
		expect(resolve({ file: 'src/core/util.ts' })).toEqual({
			alive: true,
			packageBoundary: 'from-json',
		});
		// A node MISSING from a loadable graph must NOT fall through to the
		// index — the plan scopes the widening to graph === null.
		expect(resolve({ file: 'src/plain/on-disk.ts' })).toEqual({ alive: true });
		expect(modeCalls).toEqual([]);
		expect(nodeCalls).toEqual([]);
	});

	test('the storage mode is resolved once per regeneration, not per anchor', () => {
		// MAX_ANCHOR_PROBES is 4000; a per-anchor config read would be 4000 reads.
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		for (const file of [
			'src/core/util.ts',
			'src/plain/on-disk.ts',
			'src/gone/missing.ts',
		]) {
			resolve({ file });
		}
		expect(modeCalls).toEqual([tmp]);
	});

	test('a throwing config read degrades to the JSON-only behavior', () => {
		_internals.resolveGraphStorageMode = () => {
			throw new Error('unreadable config');
		};
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		expect(resolve({ file: 'src/core/util.ts' })).toEqual({ alive: true });
		expect(nodeCalls).toEqual([]);
	});

	test('a throwing index read degrades to the JSON-only behavior', () => {
		_internals.queryNodeByFile = () => {
			throw new Error('SQLITE_CORRUPT');
		};
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		expect(resolve({ file: 'src/core/util.ts' })).toEqual({ alive: true });
		expect(resolve({ file: 'src/gone/missing.ts' })).toEqual({ alive: false });
	});

	test('resolved anchors stay cached by file and symbol', () => {
		const resolve = _test_exports.createAnchorResolver(tmp, null);
		resolve({ file: 'src/core/util.ts' });
		resolve({ file: 'src/core/util.ts' });
		expect(nodeCalls).toHaveLength(1);
		resolve({ file: 'src/core/util.ts', symbol: 'add' });
		expect(nodeCalls).toHaveLength(2);
	});
});

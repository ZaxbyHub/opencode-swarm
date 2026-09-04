/**
 * Issue #1534 — indexed-storage wiring for the two file-scoped injection
 * blocks.
 *
 * What is pinned here is the GATE ORDER and the CACHE BEHAVIOR, not the
 * storage layer: `_internals.loadSubgraphForFiles` is replaced with a counting
 * fake (invariant 7 — DI over mock.module) that applies the approved closure
 * rule to the real graph. That makes "the kill switch returns before SQLite is
 * touched" and "the LRU hit never touches SQLite" directly assertable.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildWorkspaceGraphAsync,
	type FreshnessProbe,
	type GraphEdge,
	type GraphNode,
	getGraphNode,
	loadGraphSync,
	normalizeGraphPath,
	type RepoGraph,
	saveGraph,
} from '../tools/repo-graph';
import {
	_internals,
	buildCoderLocalizationBlock,
	buildReviewerBlastRadiusBlock,
	getCachedGraph,
	type RepoGraphInjectionOptions,
	resetGraphInjectionCache,
} from './repo-graph-injection';

const originalProbe = _internals.probeFreshness;
const originalLoadSubgraph = _internals.loadSubgraphForFiles;

let tmp: string;
/** Every (files, depth) request the fake index received, in order. */
let subgraphCalls: Array<{ files: string[]; depth: number }>;

function probe(
	state: FreshnessProbe['state'],
	changed: string[] = [],
	removed: string[] = [],
): FreshnessProbe {
	return {
		state,
		changed,
		removed,
		truncated: false,
		probedFiles: 1,
		elapsedMs: 1,
	};
}

/** The approved closure rule (07-approved-plan.md steps 3-5), steps 3-5. */
function buildClosure(
	full: RepoGraph,
	files: readonly string[],
	depth: number,
): RepoGraph {
	const targets = new Set<string>();
	for (const file of files) {
		const resolved = getGraphNode(full, file);
		if (resolved) targets.add(normalizeGraphPath(resolved.filePath));
	}
	const included = new Set(targets);
	let frontier = new Set(targets);
	for (let hop = 0; hop < depth; hop++) {
		const next = new Set<string>();
		for (const candidate of full.edges) {
			const source = normalizeGraphPath(candidate.source);
			if (
				frontier.has(normalizeGraphPath(candidate.target)) &&
				!included.has(source)
			) {
				next.add(source);
			}
		}
		for (const source of next) included.add(source);
		frontier = next;
	}
	for (const candidate of full.edges) {
		if (targets.has(normalizeGraphPath(candidate.source))) {
			included.add(normalizeGraphPath(candidate.target));
		}
	}
	const nodes: Record<string, GraphNode> = {};
	for (const nodeKey of included) {
		const found = full.nodes[nodeKey];
		if (found) nodes[nodeKey] = found;
	}
	const edges: GraphEdge[] = full.edges.filter(
		(candidate) =>
			included.has(normalizeGraphPath(candidate.source)) &&
			included.has(normalizeGraphPath(candidate.target)),
	);
	return {
		schema_version: full.schema_version,
		workspaceRoot: full.workspaceRoot,
		nodes,
		edges,
		metadata: {
			generatedAt: full.metadata.generatedAt,
			generator: full.metadata.generator,
			nodeCount: Object.keys(nodes).length,
			edgeCount: edges.length,
		},
	};
}

/** Stand-in for the SQLite reader; records every call it receives. */
function fakeIndex(directory: string, files: string[], depth: number) {
	subgraphCalls.push({ files: [...files], depth });
	const full = loadGraphSync(directory);
	if (!full) return null;
	return buildClosure(full, files, depth);
}

const INDEXED: RepoGraphInjectionOptions = { storage: 'indexed' };
const JSON_MODE: RepoGraphInjectionOptions = { storage: 'json' };

function write(relative: string, contents: string): void {
	const target = path.join(tmp, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, contents);
}

beforeEach(async () => {
	resetGraphInjectionCache();
	subgraphCalls = [];
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rgi-indexed-')));
	// core/util <- mid/a <- top/x <- far/z ; core/util <- mid/b
	// top/x is therefore BOTH a depth-2 dependent of core/util and, in the
	// reviewer cases below, a target in its own right.
	write(
		'src/core/util.ts',
		'export function add(a: number, b: number) { return a + b; }\n',
	);
	write(
		'src/mid/a.ts',
		"import { add } from '../core/util';\nexport const a = add(1, 2);\n",
	);
	write(
		'src/mid/b.ts',
		"import { add } from '../core/util';\nexport const b = add(3, 4);\n",
	);
	write('src/top/x.ts', "import { a } from '../mid/a';\nexport const x = a;\n");
	write('src/far/z.ts', "import { x } from '../top/x';\nexport const z = x;\n");
	const graph = await buildWorkspaceGraphAsync(tmp);
	await saveGraph(tmp, graph);
	_internals.probeFreshness = async () => probe('clean');
	_internals.loadSubgraphForFiles = fakeIndex;
});

afterEach(() => {
	_internals.probeFreshness = originalProbe;
	_internals.loadSubgraphForFiles = originalLoadSubgraph;
	resetGraphInjectionCache();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('gate order — suppression happens before any materialization', () => {
	test('enabled === false returns null without touching the index', async () => {
		expect(
			await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', {
				...INDEXED,
				enabled: false,
			}),
		).toBeNull();
		expect(
			await buildReviewerBlastRadiusBlock(tmp, ['src/core/util.ts'], {
				...INDEXED,
				enabled: false,
			}),
		).toBeNull();
		expect(subgraphCalls).toEqual([]);
		expect(_internals.cacheSize()).toBe(0);
		expect(_internals.subgraphCacheSize()).toBe(0);
	});

	test('freshness suppression returns null before any graph is materialized', async () => {
		_internals.probeFreshness = async () => probe('no-fingerprint');
		expect(
			await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', INDEXED),
		).toBeNull();

		_internals.probeFreshness = async () =>
			probe('drifted', ['a.ts', 'b.ts'], ['c.ts']);
		expect(
			await buildReviewerBlastRadiusBlock(tmp, ['src/core/util.ts'], {
				...INDEXED,
				refreshCap: 2,
			}),
		).toBeNull();

		expect(subgraphCalls).toEqual([]);
		// Neither cache was populated — nothing was parsed and nothing was read
		// out of the index.
		expect(_internals.cacheSize()).toBe(0);
		expect(_internals.subgraphCacheSize()).toBe(0);
	});

	test('drift within the refresh cap is still served', async () => {
		_internals.probeFreshness = async () => probe('drifted', ['a.ts']);
		const block = await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', {
			...INDEXED,
			refreshCap: 5,
		});
		expect(block).not.toBeNull();
		expect(subgraphCalls).toHaveLength(1);
	});

	test('a missing graph artifact returns null without touching the index', async () => {
		fs.rmSync(path.join(tmp, '.swarm'), { recursive: true, force: true });
		expect(
			await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', INDEXED),
		).toBeNull();
		expect(subgraphCalls).toEqual([]);
	});

	test('a warm full-graph LRU hit never touches the index', async () => {
		// Populate the full-graph LRU the way a whole-graph consumer does.
		expect(await getCachedGraph(tmp, INDEXED)).not.toBeNull();
		expect(_internals.cacheSize()).toBe(1);

		const block = await buildCoderLocalizationBlock(
			tmp,
			'src/core/util.ts',
			INDEXED,
		);
		expect(block).not.toBeNull();
		expect(subgraphCalls).toEqual([]);
	});

	test('json mode never touches the index', async () => {
		expect(
			await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', JSON_MODE),
		).not.toBeNull();
		expect(
			await buildReviewerBlastRadiusBlock(tmp, ['src/core/util.ts'], undefined),
		).not.toBeNull();
		expect(subgraphCalls).toEqual([]);
		expect(_internals.cacheSize()).toBe(1);
	});
});

describe('indexed branch — output equivalence and cache placement', () => {
	test('the coder block is byte-identical to the JSON path and requests depth 2', async () => {
		const fromJson = await buildCoderLocalizationBlock(
			tmp,
			'src/core/util.ts',
			JSON_MODE,
		);
		resetGraphInjectionCache();
		const fromIndex = await buildCoderLocalizationBlock(
			tmp,
			'src/core/util.ts',
			INDEXED,
		);
		expect(fromJson).not.toBeNull();
		expect(fromIndex).toBe(fromJson as string);
		expect(subgraphCalls).toEqual([{ files: ['src/core/util.ts'], depth: 2 }]);
	});

	test('a served subgraph goes in its own LRU, never the full-graph LRU', async () => {
		expect(
			await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', INDEXED),
		).not.toBeNull();
		expect(_internals.cacheSize()).toBe(0);
		expect(_internals.subgraphCacheSize()).toBe(1);

		// A repeat of the same request is served from the subgraph LRU.
		expect(
			await buildCoderLocalizationBlock(tmp, 'src/core/util.ts', INDEXED),
		).not.toBeNull();
		expect(subgraphCalls).toHaveLength(1);

		// A different (files, depth) request is a distinct key.
		expect(
			await buildReviewerBlastRadiusBlock(tmp, ['src/core/util.ts'], INDEXED),
		).not.toBeNull();
		expect(subgraphCalls).toHaveLength(2);
		expect(_internals.subgraphCacheSize()).toBe(2);
		expect(_internals.cacheSize()).toBe(0);
	});

	test('the reviewer block unions three changed files in ONE depth-3 request', async () => {
		// src/nope/missing.ts is outside the closure entirely: it has no node,
		// so the `getGraphNode(...) !== undefined` filter must drop it against
		// the SUBGRAPH exactly as it would against the full graph.
		const changed = [
			'src/core/util.ts',
			'./src/top/x.ts',
			'src/nope/missing.ts',
		];
		const fromJson = await buildReviewerBlastRadiusBlock(
			tmp,
			changed,
			JSON_MODE,
		);
		resetGraphInjectionCache();
		const fromIndex = await buildReviewerBlastRadiusBlock(
			tmp,
			changed,
			INDEXED,
		);
		expect(fromJson).not.toBeNull();
		expect(fromIndex).toBe(fromJson as string);
		// ONE call, carrying every requested file, at the depth getBlastRadius uses.
		expect(subgraphCalls).toHaveLength(1);
		expect(subgraphCalls[0].depth).toBe(3);
		expect(subgraphCalls[0].files).toEqual([
			'src/core/util.ts',
			'src/top/x.ts',
			'src/nope/missing.ts',
		]);
		// The unresolvable file is not listed as a changed target.
		expect(fromIndex).toContain('src/core/util.ts, src/top/x.ts');
		expect(fromIndex).not.toContain('src/nope/missing.ts');
	});

	test('a target that is also another target’s depth-2 dependent is pre-visited', async () => {
		// src/top/x.ts imports src/mid/a.ts which imports src/core/util.ts, so
		// x is a depth-2 dependent of util AND a target. getBlastRadius seeds
		// `visited` with both simultaneously; a merged per-file closure would
		// produce a different totalDependents and a different risk level.
		const changed = ['src/core/util.ts', 'src/top/x.ts'];
		const fromJson = await buildReviewerBlastRadiusBlock(
			tmp,
			changed,
			JSON_MODE,
		);
		resetGraphInjectionCache();
		const fromIndex = await buildReviewerBlastRadiusBlock(
			tmp,
			changed,
			INDEXED,
		);
		expect(fromJson).not.toBeNull();
		expect(fromIndex).toBe(fromJson as string);
		// x must never be reported as its own dependent.
		expect(fromIndex).toContain(
			'Direct dependents: src/far/z.ts, src/mid/a.ts, src/mid/b.ts',
		);
	});

	test('every requested file resolves in the subgraph exactly as in the full graph', async () => {
		const changed = ['src/core/util.ts', 'src/far/z.ts'];
		const full = loadGraphSync(tmp);
		expect(full).not.toBeNull();
		const subgraph = buildClosure(full as RepoGraph, changed, 3);
		for (const file of changed) {
			expect(getGraphNode(subgraph, file)).toEqual(
				getGraphNode(full as RepoGraph, file) as GraphNode,
			);
		}
	});
});

describe('indexed branch — fail-open to the JSON path', () => {
	test('a null index result falls back to the full graph', async () => {
		const fromJson = await buildCoderLocalizationBlock(
			tmp,
			'src/core/util.ts',
			JSON_MODE,
		);
		resetGraphInjectionCache();
		_internals.loadSubgraphForFiles = (directory, files, depth) => {
			subgraphCalls.push({ files: [...files], depth });
			return null;
		};
		const fromIndex = await buildCoderLocalizationBlock(
			tmp,
			'src/core/util.ts',
			INDEXED,
		);
		expect(fromIndex).toBe(fromJson as string);
		expect(subgraphCalls).toHaveLength(1);
		// The JSON path ran, so the full-graph LRU is populated.
		expect(_internals.cacheSize()).toBe(1);
		expect(_internals.subgraphCacheSize()).toBe(0);
	});

	test('a throwing index result falls back to the full graph', async () => {
		const fromJson = await buildReviewerBlastRadiusBlock(
			tmp,
			['src/core/util.ts'],
			JSON_MODE,
		);
		resetGraphInjectionCache();
		_internals.loadSubgraphForFiles = () => {
			throw new Error('SQLITE_CORRUPT');
		};
		const fromIndex = await buildReviewerBlastRadiusBlock(
			tmp,
			['src/core/util.ts'],
			INDEXED,
		);
		expect(fromIndex).toBe(fromJson as string);
		expect(_internals.cacheSize()).toBe(1);
	});

	test('an empty changed-file list short-circuits before any gate', async () => {
		expect(await buildReviewerBlastRadiusBlock(tmp, [], INDEXED)).toBeNull();
		expect(await buildCoderLocalizationBlock(tmp, '', INDEXED)).toBeNull();
		expect(subgraphCalls).toEqual([]);
		expect(_internals.cacheSize()).toBe(0);
	});

	test('subgraphCacheKey is ino-sensitive (PRR-003 regression pin)', () => {
		// A same-size/same-mtime-tick rewrite must not reuse a cached subgraph:
		// the inode is the only component that changes. If this pin fails after
		// someone drops `ino` from the key, stale subgraphs become reachable
		// again through the cache.
		const key = (ino: number) =>
			_internals.subgraphCacheKey(
				'dir',
				{ mtimeMs: 100, size: 10, ino },
				['src/a.ts'],
				1,
			);
		expect(key(1)).toBe(key(1));
		expect(key(1)).not.toBe(key(2));
	});

	test('full-graph cache comparator is inode-sensitive', () => {
		const cached = { mtimeMs: 100, size: 10, ino: 7 };

		expect(_internals.fullGraphCacheMatches(cached, cached)).toBe(true);
		expect(
			_internals.fullGraphCacheMatches(cached, {
				mtimeMs: 100,
				size: 10,
				ino: 8,
			}),
		).toBe(false);
	});
});

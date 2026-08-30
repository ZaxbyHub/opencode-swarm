/**
 * Regression coverage for issue #1534 implementation-review finding B1: the
 * rename->stamp window in `saveGraph`.
 *
 * `saveGraph` must stamp its OWN bytes (a stat of the temp file, taken
 * INSIDE the lock, BEFORE the rename publishes it) rather than re-stating
 * the path AFTER the rename. If the stamp were taken post-rename, a second
 * writer B — which failed to acquire the lock and therefore renames
 * unlocked (the JSON write is deliberately never gated on the lock) — could
 * land in the gap between A's rename and A's stat. A would then stamp its
 * own vA-content index with vB's stat, and every reader's freshness check
 * would PASS on superseded content, silently serving stale data.
 *
 * This test drives the REAL `saveGraph` (not `syncIndexFromGraph` directly)
 * and injects writer B via the `_internals.fsRename` DI seam, so that B's
 * unlocked rename happens in the actual rename->stamp window, not merely
 * during per-row JSON serialization inside the sync (that window is already
 * covered by indexed-storage.test.ts:387 and is a DIFFERENT window).
 *
 * FR-006: kept in its own file because indexed-storage.test.ts is already
 * at the 500-line cap.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';
import { upsertNode } from './builder';
import { loadSubgraphForFiles, syncIndexFromGraph } from './indexed-storage';
import { _internals, getGraphPath, saveGraph } from './storage';
import type { GraphNode, RepoGraph } from './types';
import { createEmptyGraph } from './types';

const workspaces: string[] = [];

function makeWorkspace() {
	const dir = canonicalMkdtemp('repo-mem-race-');
	mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ repo_graph: { storage: 'indexed' } }),
		'utf-8',
	);
	workspaces.push(dir);
	return dir;
}

function makeNode(root: string, rel: string): GraphNode {
	return {
		filePath: path.join(root, ...rel.split('/')),
		moduleName: rel,
		exports: [],
		imports: [],
		language: 'typescript',
		mtime: new Date(0).toISOString(),
	};
}

function fixtureGraph(root: string, rels: string[]): RepoGraph {
	const graph = createEmptyGraph(root);
	for (const rel of rels) upsertNode(graph, makeNode(root, rel));
	return graph;
}

afterEach(() => {
	_internals.retryDelayMs = 100;
	for (const dir of workspaces.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

describe('saveGraph rename->stamp window (issue #1534, finding B1)', () => {
	test('writer B racing the rename->stamp window is not silently validated', async () => {
		const ws = makeWorkspace();
		const graphA = fixtureGraph(ws, ['src/a.ts', 'src/b.ts']);
		const graphB = fixtureGraph(ws, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
		const graphPath = getGraphPath(ws);

		const realRename = _internals.fsRename;
		_internals.retryDelayMs = 0;
		let injected = false;
		_internals.fsRename = async (...args: Parameters<typeof realRename>) => {
			// Perform writer A's real rename first.
			const result = await realRename(...args);
			// Then simulate writer B's unlocked rename landing in the gap
			// between A's rename and A's stamp — exactly once, only for the
			// rename that targets the real graph path (not other renames the
			// suite may trigger).
			if (!injected && String(args[1]) === graphPath) {
				injected = true;
				writeFileSync(graphPath, JSON.stringify(graphB, null, 2), 'utf-8');
			}
			return result;
		};

		try {
			await saveGraph(ws, graphA);
		} finally {
			_internals.fsRename = realRename;
		}

		expect(injected).toBe(true);

		// Safe outcome: the index must NOT validate against B's content. The
		// reader falls back to JSON rather than silently serving a stale
		// (or mismatched) index.
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
	});

	// POSITIVE CONTROL (implementation-review finding N2). Without this, the
	// test above could go vacuous: `null` is ALSO what a reader returns when the
	// index was never synced at all — config not picked up, `assertProjectRoot`
	// failing, the lock not acquired, or no SQLite driver. Those preconditions
	// hold today, but nothing IN THIS FILE pinned them, so a future change to
	// `resolveGraphStorageMode`, `assertProjectRoot`, or the fixture shape would
	// leave the race test green while testing nothing. This case proves the same
	// fixture DOES produce a readable index when no writer races it, which makes
	// the `toBeNull()` above meaningful.
	test('the same fixture yields a readable index when nothing races it', async () => {
		const ws = makeWorkspace();
		const graphA = fixtureGraph(ws, ['src/a.ts', 'src/b.ts']);

		await saveGraph(ws, graphA);

		const subgraph = loadSubgraphForFiles(ws, ['src/a.ts'], 2);
		expect(subgraph).not.toBeNull();
		expect(Object.keys(subgraph?.nodes ?? {}).length).toBeGreaterThan(0);
		expect(
			Object.values(subgraph?.nodes ?? {}).some(
				(node) => node.moduleName === 'src/a.ts',
			),
		).toBe(true);
	});

	// The collision the {size, mtimeMs} stamp could NOT catch, and which
	// measurement showed is COMMON rather than rare: two graph documents of
	// identical byte length (20/20 in measurement for two rebuilds differing
	// only in file mtimes — empirical, not structural: the ISO `mtime` is
	// fixed-width but nodes also carry a variable-width numeric `mtimeMs`)
	// carrying the same mtimeMs (back-to-back writes shared one
	// 146/200 times on a ~15 ms-resolution filesystem). Only the file id
	// distinguishes them.
	//
	// Driven at the store boundary rather than through the filesystem, because
	// `utimesSync` truncates sub-millisecond precision and so cannot reproduce
	// an exact mtimeMs match on this platform — the scenario is real, but the
	// harness for it must not be.
	test('an index stamped by another writer (same size+mtime, different file id) is rejected', async () => {
		const ws = makeWorkspace();
		const graphA = fixtureGraph(ws, ['src/a.ts', 'src/b.ts']);
		await saveGraph(ws, graphA);
		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).not.toBeNull();

		const live = statSync(getGraphPath(ws));
		if (String(live.ino ?? 0) === '0') {
			// A bare `return` here would report PASS and hide the fact that the
			// assertion never ran — the vacuous-test shape this suite bans. Make
			// it visible in CI output instead.
			console.warn(
				'[skip] filesystem reports no usable file id; the collision assertion did not run',
			);
			return;
		}

		// Re-stamp with the live size and mtime but a FOREIGN file id: exactly
		// what a competing writer's document would produce.
		// N5: BigInt(live.ino) directly — String() on a number above ~1e21 yields
		// exponential notation, which BigInt() rejects.
		const foreignIno = String(BigInt(live.ino) + 1n);
		// N2: assert the sync SUCCEEDED. Without this the test passes when
		// syncIndexFromGraph fails, because a failed sync calls deleteRepoMemory
		// and the subsequent read returns null for the wrong reason — exactly how
		// the NULL-bind-against-NOT-NULL defect behaved.
		expect(
			await syncIndexFromGraph(ws, graphA, {
				size: live.size,
				mtimeMs: live.mtimeMs,
				ino: foreignIno,
			}),
		).toBe(true);

		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).toBeNull();
	});

	// The guard: a filesystem that supplies no usable file id must degrade to
	// size+mtime, never fail closed. Failing closed would make the feature
	// silently inert — the exact failure mode this change already hit once.
	test('a zero file id degrades to size+mtime instead of failing closed', async () => {
		const ws = makeWorkspace();
		const graphA = fixtureGraph(ws, ['src/a.ts', 'src/b.ts']);
		await saveGraph(ws, graphA);

		const live = statSync(getGraphPath(ws));
		expect(
			await syncIndexFromGraph(ws, graphA, {
				size: live.size,
				mtimeMs: live.mtimeMs,
				ino: '0',
			}),
		).toBe(true);

		expect(loadSubgraphForFiles(ws, ['src/a.ts'], 2)).not.toBeNull();
	});
});

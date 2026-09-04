import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../../tests/helpers/tmpdir';
import {
	clearCache,
	getCachedIno,
	getCachedMtime,
	getCachedSize,
} from './cache';
import {
	_internals,
	getGraphPath,
	loadGraph,
	loadGraphSync,
	loadOrCreateGraph,
	saveGraph,
} from './storage';
import { createEmptyGraph } from './types';

const workspaces: string[] = [];

afterEach(() => {
	for (const workspace of workspaces) {
		clearCache(workspace);
		rmSync(workspace, { recursive: true, force: true });
	}
	workspaces.length = 0;
});

describe('full graph cache artifact identity', () => {
	test('loadOrCreateGraph preserves the artifact witnesses written by saveGraph', async () => {
		const workspace = canonicalMkdtemp('repo-graph-create-cache-');
		workspaces.push(workspace);
		mkdirSync(path.join(workspace, '.opencode'), { recursive: true });

		await loadOrCreateGraph(workspace);
		const stats = statSync(getGraphPath(workspace));

		expect(getCachedMtime(workspace)).toBe(stats.mtimeMs);
		expect(getCachedSize(workspace)).toBe(stats.size);
		expect(getCachedIno(workspace)).toBe(String(stats.ino));
	});

	test('loadGraphSync seeds the artifact witnesses after a cold cache load', async () => {
		const workspace = canonicalMkdtemp('repo-graph-sync-cache-');
		workspaces.push(workspace);
		mkdirSync(path.join(workspace, '.opencode'), { recursive: true });

		await saveGraph(workspace, createEmptyGraph(workspace));
		clearCache(workspace);
		const stats = statSync(getGraphPath(workspace));

		const loaded = loadGraphSync(workspace);

		expect(loaded?.metadata.generator).toBe('repo-graph');
		expect(getCachedMtime(workspace)).toBe(stats.mtimeMs);
		expect(getCachedSize(workspace)).toBe(stats.size);
		expect(getCachedIno(workspace)).toBe(String(stats.ino));
	});

	test('the production comparator rejects only usable mismatched file ids', () => {
		const stat = { mtimeMs: 100, size: 10, ino: 7 };
		expect(_internals.cacheArtifactMatches(100, '7', 10, stat)).toBe(true);
		expect(_internals.cacheArtifactMatches(100, '7', 11, stat)).toBe(false);
		expect(
			_internals.cacheArtifactMatches(100, '7', 10, { ...stat, ino: 8 }),
		).toBe(false);
		expect(
			_internals.cacheArtifactMatches(100, '0', 10, { ...stat, ino: 8 }),
		).toBe(true);
		expect(
			_internals.cacheArtifactMatches(100, '7', 10, { ...stat, ino: 0 }),
		).toBe(true);
	});

	test('rejects a replacement inode even when mtime is unchanged', async () => {
		const workspace = canonicalMkdtemp('repo-graph-inode-');
		workspaces.push(workspace);
		mkdirSync(path.join(workspace, '.opencode'), { recursive: true });
		const graph = createEmptyGraph(workspace);
		await saveGraph(workspace, graph);
		const graphPath = getGraphPath(workspace);
		const written = statSync(graphPath);
		utimesSync(graphPath, written.atime, new Date(Math.trunc(written.mtimeMs)));
		const first = await loadGraph(workspace);
		expect(first?.metadata.generator).toBe('repo-graph');

		const before = statSync(graphPath);
		const replacement = `${graphPath}.replacement`;
		const changed = readFileSync(graphPath, 'utf-8').replace(
			'"generator": "repo-graph"',
			'"generator": "repo-graPH"',
		);
		expect(changed).toContain('repo-graPH');
		writeFileSync(replacement, changed, 'utf-8');
		utimesSync(replacement, before.atime, before.mtime);
		renameSync(replacement, graphPath);
		const after = statSync(graphPath);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		if (before.ino === 0 || after.ino === 0) return;
		expect(String(after.ino)).not.toBe(String(before.ino));

		const reloaded = await loadGraph(workspace);
		expect(reloaded?.metadata.generator).toBe('repo-graPH');
	});
});

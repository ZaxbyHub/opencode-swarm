import { afterEach, describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	clearCache,
	getCachedGraph,
	getCachedIno,
	getCachedMtime,
	getCachedSize,
	isDirty,
	markDirty,
	setCachedGraph,
} from '../../../src/tools/repo-graph/cache';
import { createEmptyGraph } from '../../../src/tools/repo-graph/types';

const workspaces = Array.from({ length: 18 }, (_, index) =>
	path.join(tmpdir(), `repo-graph-cache-lru-${process.pid}-${index}`),
);

afterEach(() => {
	for (const workspace of workspaces) clearCache(workspace);
});

describe('repo-graph workspace cache', () => {
	test('evicts the least-recently-used workspace at the 16-entry cap', () => {
		for (const workspace of workspaces.slice(0, 16)) {
			setCachedGraph(workspace, createEmptyGraph(workspace));
		}

		// Refresh entry 0, making entry 1 the least recently used.
		expect(getCachedGraph(workspaces[0])).toBeDefined();
		setCachedGraph(workspaces[16], createEmptyGraph(workspaces[16]));

		expect(getCachedGraph(workspaces[0])).toBeDefined();
		expect(getCachedGraph(workspaces[1])).toBeUndefined();
		expect(getCachedGraph(workspaces[16])).toBeDefined();
	});

	test('keeps graph, dirty, and mtime state coherent under one key', () => {
		const workspace = workspaces[0];
		const graph = createEmptyGraph(workspace);
		setCachedGraph(workspace, graph, 123, 456, 789);
		markDirty(path.join(workspace, '.'));

		expect(getCachedGraph(workspace)).toBe(graph);
		expect(isDirty(workspace)).toBe(true);
		expect(getCachedMtime(workspace)).toBe(123);
		expect(getCachedSize(workspace)).toBe(789);

		// Replacing without an mtime must not retain the previous witness.
		setCachedGraph(workspace, createEmptyGraph(workspace));
		expect(isDirty(workspace)).toBe(false);
		expect(getCachedMtime(workspace)).toBeUndefined();
		expect(getCachedIno(workspace)).toBeUndefined();
		expect(getCachedSize(workspace)).toBeUndefined();

		clearCache(workspace);
		expect(getCachedGraph(workspace)).toBeUndefined();
		expect(isDirty(workspace)).toBe(false);
		expect(getCachedMtime(workspace)).toBeUndefined();
		expect(getCachedIno(workspace)).toBeUndefined();
		expect(getCachedSize(workspace)).toBeUndefined();
	});

	test('retains dirty-without-graph state without orphaning another map', () => {
		const workspace = workspaces[0];
		markDirty(workspace);

		expect(isDirty(workspace)).toBe(true);
		expect(getCachedGraph(workspace)).toBeUndefined();
	});
});

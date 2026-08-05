import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	clearCache,
	markDirty,
	setCachedGraph,
} from '../../../src/tools/repo-graph/cache';
import {
	_internals,
	getGraphPath,
	saveIfDirty,
} from '../../../src/tools/repo-graph/storage';
import { createEmptyGraph } from '../../../src/tools/repo-graph/types';

const realWriteFingerprint = _internals.writeFingerprint;

describe('saveIfDirty freshness pairing', () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(tmpdir(), 'repo-graph-dirty-1986-'));
	});

	afterEach(async () => {
		_internals.writeFingerprint = realWriteFingerprint;
		clearCache(root);
		await fs.rm(root, { recursive: true, force: true });
	});

	test('writes the graph before certifying its fingerprint', async () => {
		const graph = createEmptyGraph(root);
		setCachedGraph(root, graph);
		markDirty(root);
		let persistedBeforeFingerprint = false;
		_internals.writeFingerprint = async (workspace, savedGraph, options) => {
			const persisted = JSON.parse(
				await fs.readFile(getGraphPath(workspace), 'utf8'),
			) as { schema_version?: string };
			persistedBeforeFingerprint =
				persisted.schema_version === savedGraph.schema_version;
			expect(options).toEqual({ maxFiles: 777 });
			return true;
		};

		await saveIfDirty(root, { maxFiles: 777 });

		expect(persistedBeforeFingerprint).toBe(true);
	});
});

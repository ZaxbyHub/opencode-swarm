/**
 * Regression tests for the rename retry in saveGraph.
 *
 * Windows returns EPERM (not EEXIST) when rename() targets a file that is
 * held open by another process (reader, AV scanner). The retry loop must
 * handle EPERM / EBUSY in addition to EEXIST.
 *
 * Uses _internals.fsRename DI seam to inject a mock rename without
 * mock.module leakage across test files.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearCache } from '../../../src/tools/repo-graph';
import { _internals, saveGraph } from '../../../src/tools/repo-graph/storage';
import type { RepoGraph } from '../../../src/tools/repo-graph/types';

function makeGraph(workspaceRoot: string): RepoGraph {
	return {
		schema_version: '1.0.0',
		workspaceRoot,
		nodes: {},
		edges: [],
		metadata: {
			generatedAt: new Date().toISOString(),
			generator: 'test',
			nodeCount: 0,
			edgeCount: 0,
		},
	};
}

function makeErr(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('saveGraph rename retry (EPERM/EBUSY regression)', () => {
	let tempDir: string;
	let originalCwd: string;
	let workspaceName: string;
	let resolvedWorkspace: string;
	const realRename = _internals.fsRename;

	beforeEach(async () => {
		tempDir = await fsPromises.mkdtemp(
			path.join(os.tmpdir(), 'repo-graph-eperm-'),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);
		workspaceName = 'eperm-ws';
		resolvedWorkspace = path.resolve(workspaceName);
		await fsPromises.mkdir(path.join(workspaceName, '.swarm'), {
			recursive: true,
		});
		clearCache(workspaceName);
	});

	afterEach(async () => {
		// Always restore the real rename
		_internals.fsRename = realRename;
		process.chdir(originalCwd);
		clearCache(workspaceName);
		try {
			await fsPromises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('saveGraph retries and succeeds when rename throws EPERM on first attempt', async () => {
		const graph = makeGraph(resolvedWorkspace);
		let calls = 0;
		_internals.fsRename = async (src: string, dst: string) => {
			calls++;
			if (calls === 1) throw makeErr('EPERM');
			return realRename(src, dst);
		};

		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();
		expect(calls).toBe(2);

		// File must exist and be valid JSON after the retry succeeds
		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		const content = await fsPromises.readFile(graphPath, 'utf-8');
		expect(() => JSON.parse(content)).not.toThrow();
	});

	test('saveGraph retries and succeeds when rename throws EBUSY on first attempt', async () => {
		const graph = makeGraph(resolvedWorkspace);
		let calls = 0;
		_internals.fsRename = async (src: string, dst: string) => {
			calls++;
			if (calls === 1) throw makeErr('EBUSY');
			return realRename(src, dst);
		};

		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();
		expect(calls).toBe(2);
	});

	test('saveGraph throws after exhausting all retries on persistent EPERM', async () => {
		const graph = makeGraph(resolvedWorkspace);
		const epermErr = makeErr('EPERM');
		_internals.fsRename = async () => {
			throw epermErr;
		};

		await expect(saveGraph(workspaceName, graph)).rejects.toMatchObject({
			code: 'EPERM',
		});
	});

	test('saveGraph throws immediately on ENOENT without retrying', async () => {
		const graph = makeGraph(resolvedWorkspace);
		let calls = 0;
		_internals.fsRename = async () => {
			calls++;
			throw makeErr('ENOENT');
		};

		await expect(saveGraph(workspaceName, graph)).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(calls).toBe(1);
	});

	test('saveGraph throws immediately on EACCES without retrying', async () => {
		const graph = makeGraph(resolvedWorkspace);
		let calls = 0;
		_internals.fsRename = async () => {
			calls++;
			throw makeErr('EACCES');
		};

		await expect(saveGraph(workspaceName, graph)).rejects.toMatchObject({
			code: 'EACCES',
		});
		expect(calls).toBe(1);
	});

	test('saveGraph retries and succeeds when rename throws EEXIST on first attempt', async () => {
		const graph = makeGraph(resolvedWorkspace);
		let calls = 0;
		_internals.fsRename = async (src: string, dst: string) => {
			calls++;
			if (calls === 1) throw makeErr('EEXIST');
			return realRename(src, dst);
		};

		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();
		expect(calls).toBe(2);
	});

	test('saveGraph succeeds on real FS without needing a retry (baseline)', async () => {
		const graph = makeGraph(resolvedWorkspace);
		await expect(saveGraph(workspaceName, graph)).resolves.toBeUndefined();
		const graphPath = path.join(workspaceName, '.swarm', 'repo-graph.json');
		expect(
			await fsPromises.access(graphPath).then(
				() => true,
				() => false,
			),
		).toBe(true);
	});
});

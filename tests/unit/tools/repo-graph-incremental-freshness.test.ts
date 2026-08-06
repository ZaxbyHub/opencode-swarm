import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { clearCache } from '../../../src/tools/repo-graph/cache';
import {
	_internals,
	updateGraphForFiles,
} from '../../../src/tools/repo-graph/incremental';
import { saveGraph } from '../../../src/tools/repo-graph/storage';
import {
	type BuildWorkspaceGraphOptions,
	createEmptyGraph,
	type GraphNode,
	normalizeGraphPath,
	type RepoGraph,
} from '../../../src/tools/repo-graph/types';

const realInternals = { ..._internals };

function makeNode(filePath: string, exports = ['old']): GraphNode {
	return {
		filePath,
		moduleName: path.basename(filePath),
		exports,
		imports: [],
		language: 'typescript',
		mtime: new Date().toISOString(),
	};
}

describe('incremental freshness persistence and filesystem safety', () => {
	let root: string;
	let source: string;
	let graph: RepoGraph;

	beforeEach(async () => {
		root = await fs.mkdtemp(
			path.join(tmpdir(), 'repo-graph-incremental-1986-'),
		);
		source = path.join(root, 'a.ts');
		await fs.writeFile(source, 'export const old = 1;\n', 'utf8');
		graph = createEmptyGraph(root);
		graph.nodes[normalizeGraphPath(source)] = makeNode(source);
		graph.metadata.nodeCount = 1;
		await saveGraph(root, graph);
	});

	afterEach(async () => {
		Object.assign(_internals, realInternals);
		clearCache(root);
		await fs.rm(root, { recursive: true, force: true });
	});

	test('persists graph before fingerprint and threads freshness limits', async () => {
		const calls: string[] = [];
		let fingerprintOptions: BuildWorkspaceGraphOptions | undefined;
		_internals.saveGraph = async () => {
			calls.push('graph');
		};
		_internals.writeFingerprint = async (_root, _graph, options) => {
			calls.push('fingerprint');
			fingerprintOptions = options;
			return true;
		};
		const buildOptions: BuildWorkspaceGraphOptions = {
			maxFiles: 321,
			walkBudgetMs: 4321,
			followSymlinks: true,
			excludeDirs: ['generated'],
		};

		await updateGraphForFiles(root, [], { buildOptions });

		expect(calls).toEqual(['graph', 'fingerprint']);
		expect(fingerprintOptions).toEqual({
			maxFiles: 321,
			walkBudgetMs: 4321,
			followSymlinks: true,
			excludeDirs: ['generated'],
		});
	});

	test('threads build options through forced and missing-graph rebuilds', async () => {
		const observed: Array<BuildWorkspaceGraphOptions | undefined> = [];
		_internals.buildWorkspaceGraphAsync = async (_root, options) => {
			observed.push(options);
			return createEmptyGraph(root);
		};
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;
		const buildOptions = { maxFiles: 123, walkBudgetMs: 2345 };

		await updateGraphForFiles(root, [], { forceRebuild: true, buildOptions });
		clearCache(root);
		await fs.rm(path.join(root, '.swarm', 'repo-graph.json'));
		await updateGraphForFiles(root, [], { buildOptions });

		expect(observed).toEqual([buildOptions, buildOptions]);
	});

	test('deletes a node only after ENOENT authorization', async () => {
		await fs.rm(source);
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.nodes[normalizeGraphPath(source)]).toBeUndefined();
	});

	test('preserves the last-known graph on a transient stat error', async () => {
		const realStat = _internals.stat;
		_internals.stat = async (target) => {
			if (target === source) {
				throw Object.assign(new Error('sharing violation'), { code: 'EACCES' });
			}
			return realStat(target);
		};
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.nodes[normalizeGraphPath(source)]?.exports).toEqual(['old']);
		expect(updated.diagnostics?.unreadableFiles).toContain('a.ts');
	});

	test('scans a removed path that was recreated before reconciliation', async () => {
		_internals.scanFileAsync = async () => ({
			node: makeNode(source, ['recreated']),
			edges: [],
			symbolEdges: [],
		});
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.nodes[normalizeGraphPath(source)]?.exports).toEqual([
			'recreated',
		]);
	});

	test('preserves prior data when a live file cannot be read', async () => {
		_internals.scanFileAsync = async () => ({
			node: null,
			edges: [],
			symbolEdges: [],
			diagnostics: { unreadableFiles: ['a.ts'] },
		});
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.nodes[normalizeGraphPath(source)]?.exports).toEqual(['old']);
		expect(updated.diagnostics?.unreadableFiles).toEqual(['a.ts']);
		expect(updated.diagnostics?.extractorInputWitnesses).toEqual([]);
	});

	test('records a stable witness when a file becomes oversized', async () => {
		const witness = {
			file: 'a.ts',
			kind: 'stable-skip' as const,
			sizeBytes: 2_000_000,
			mtimeMs: 1234,
		};
		_internals.scanFileAsync = async () => ({
			node: null,
			edges: [],
			symbolEdges: [],
			diagnostics: { oversizedFiles: ['a.ts'] },
			inputWitness: witness,
		});
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.nodes[normalizeGraphPath(source)]).toBeUndefined();
		expect(updated.diagnostics?.extractorInputWitnesses).toEqual([witness]);
	});

	test('preserves prior data and records a validation-skipped diagnostic', async () => {
		_internals.scanFileAsync = async () => ({
			node: { ...makeNode(source, ['invalid']), moduleName: 'bad\u0000name' },
			edges: [],
			symbolEdges: [],
		});
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.nodes[normalizeGraphPath(source)]?.exports).toEqual(['old']);
		expect(updated.diagnostics?.validationSkippedFiles).toEqual(['a.ts']);
	});

	test('replaces stale per-file diagnostics without disturbing other files', async () => {
		graph.diagnostics = {
			oversizedFiles: ['a.ts', 'other.ts'],
			binaryFiles: ['a.ts'],
			unreadableFiles: ['a.ts'],
			validationSkippedFiles: ['a.ts'],
			extractorInputWitnesses: [
				{
					file: 'a.ts',
					kind: 'stable-skip',
					sizeBytes: 100,
					mtimeMs: 10,
				},
				{
					file: 'package.json',
					kind: 'manifest',
					sizeBytes: 200,
					mtimeMs: 20,
				},
			],
		};
		await saveGraph(root, graph);
		_internals.scanFileAsync = async () => ({
			node: makeNode(source, ['healthy']),
			edges: [],
			symbolEdges: [],
		});
		_internals.saveGraph = async () => {};
		_internals.writeFingerprint = async () => true;

		const updated = await updateGraphForFiles(root, [source]);

		expect(updated.diagnostics?.oversizedFiles).toEqual(['other.ts']);
		expect(updated.diagnostics?.binaryFiles).toEqual([]);
		expect(updated.diagnostics?.unreadableFiles).toEqual([]);
		expect(updated.diagnostics?.validationSkippedFiles).toEqual([]);
		expect(updated.diagnostics?.extractorInputWitnesses).toEqual([
			{
				file: 'package.json',
				kind: 'manifest',
				sizeBytes: 200,
				mtimeMs: 20,
			},
		]);
	});
});

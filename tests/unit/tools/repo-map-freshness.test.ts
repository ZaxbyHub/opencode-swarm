import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	buildWorkspaceGraphAsync,
	clearCache,
	type FreshnessProbe,
	type RepoGraph,
	saveGraph,
} from '../../../src/tools/repo-graph';
import { _internals, repo_map } from '../../../src/tools/repo-map';

type Executable = {
	execute: (
		args: Record<string, unknown>,
		ctx: { directory: string },
	) => Promise<string>;
};

const originalLoadConfig = _internals.loadPluginConfigWithMeta;
const originalProbe = _internals.probeFreshness;
const originalUpdate = _internals.updateGraphForFiles;

let tmp: string;
let graph: RepoGraph;

function config(overrides: Record<string, unknown> = {}): void {
	_internals.loadPluginConfigWithMeta = (() => ({
		config: { repo_graph: overrides },
		recovery: 'none',
		removedKeys: [],
		warnings: [],
		loadedFromFile: false,
		configHadErrors: false,
	})) as typeof _internals.loadPluginConfigWithMeta;
}

function probe(
	state: FreshnessProbe['state'],
	changed: string[] = [],
	removed: string[] = [],
): FreshnessProbe {
	return {
		state,
		changed,
		removed,
		truncated: state === 'inconclusive',
		probedFiles: 2,
		elapsedMs: 1,
	};
}

async function call(
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const raw = await (repo_map as unknown as Executable).execute(args, {
		directory: tmp,
	});
	return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(async () => {
	tmp = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-freshness-')),
	);
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(path.join(tmp, 'src/a.ts'), 'export const a = 1;\n');
	graph = await buildWorkspaceGraphAsync(tmp);
	await saveGraph(tmp, graph);
	config();
});

afterEach(() => {
	_internals.loadPluginConfigWithMeta = originalLoadConfig;
	_internals.probeFreshness = originalProbe;
	_internals.updateGraphForFiles = originalUpdate;
	clearCache(tmp);
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('repo_map bounded freshness refresh', () => {
	test('refreshes complete source drift at the cap and reports the detected set', async () => {
		const changed = path.join(tmp, 'src/a.ts');
		let probeCalls = 0;
		let updatePaths: string[] = [];
		config({ refresh_cap: 1 });
		_internals.probeFreshness = async () =>
			probeCalls++ === 0 ? probe('drifted', [changed]) : probe('clean');
		_internals.updateGraphForFiles = (async (_root, paths) => {
			updatePaths = paths;
			return graph;
		}) as typeof _internals.updateGraphForFiles;

		const result = await call({ action: 'key_files' });

		expect(updatePaths).toEqual([changed]);
		expect(result.probeState).toBe('clean');
		expect(result.changedFiles).toBe(1);
		expect(result.refreshedFiles).toBe(1);
		expect(result.stale).toBe(false);
	});

	test('does not refresh drift above the configured cap', async () => {
		const changed = [path.join(tmp, 'src/a.ts'), path.join(tmp, 'src/b.ts')];
		let updateCalls = 0;
		config({ refresh_cap: 1 });
		_internals.probeFreshness = async () => probe('drifted', changed);
		_internals.updateGraphForFiles = (async () => {
			updateCalls++;
			return graph;
		}) as typeof _internals.updateGraphForFiles;

		const result = await call({ action: 'key_files' });

		expect(updateCalls).toBe(0);
		expect(result.stale).toBe(true);
		expect(result.changedFiles).toBe(2);
		expect(result.freshnessNote).toContain('refresh_cap=1');
	});

	test('keeps incomplete positive observations read-only and marks freshness unknown', async () => {
		let updateCalls = 0;
		_internals.probeFreshness = async () =>
			probe('inconclusive', [path.join(tmp, 'src/a.ts')]);
		_internals.updateGraphForFiles = (async () => {
			updateCalls++;
			return graph;
		}) as typeof _internals.updateGraphForFiles;

		const result = await call({ action: 'key_files' });

		expect(updateCalls).toBe(0);
		expect(result.probeState).toBe('inconclusive');
		expect(result.changedFiles).toBe(1);
		expect(result.refreshedFiles).toBe(0);
		expect(result.stale).toBe(false);
	});

	test('reports manifest drift as rebuild-only even below the refresh cap', async () => {
		let updateCalls = 0;
		_internals.probeFreshness = async () =>
			probe('drifted', [path.join(tmp, 'package.json')]);
		_internals.updateGraphForFiles = (async () => {
			updateCalls++;
			return graph;
		}) as typeof _internals.updateGraphForFiles;

		const result = await call({ action: 'key_files' });

		expect(updateCalls).toBe(0);
		expect(result.stale).toBe(true);
		expect(result.freshnessNote).toContain('manifest drift');
	});

	test('short-circuits every action when repository graphs are disabled', async () => {
		config({ enabled: false });

		const result = await call({ action: 'key_files' });

		expect(result.success).toBe(false);
		expect(result.error).toContain('repo_graph.enabled=false');
	});
});

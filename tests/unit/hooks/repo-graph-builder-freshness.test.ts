import { describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import {
	createRepoGraphBuilderHook,
	type RepoGraphDeps,
} from '../../../src/hooks/repo-graph-builder';
import {
	createEmptyGraph,
	type RepoGraph,
} from '../../../src/tools/repo-graph';
import type { FreshnessProbe } from '../../../src/tools/repo-graph/freshness';

function graphWithNodes(root: string, count: number): RepoGraph {
	const graph = createEmptyGraph(root);
	for (let index = 0; index < count; index += 1) {
		const filePath = path.join(root, 'src', `file-${index}.ts`);
		graph.nodes[filePath] = {
			filePath,
			moduleName: `src/file-${index}`,
			language: 'typescript',
			imports: [],
			exports: [],
			mtime: '2026-01-01T00:00:00.000Z',
			sizeBytes: 1,
		};
	}
	graph.metadata.nodeCount = count;
	return graph;
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
		probedFiles: changed.length,
		elapsedMs: 1,
	};
}

function fixture(
	root: string,
	savedGraph: RepoGraph | null,
	result: FreshnessProbe,
) {
	const builtGraph = graphWithNodes(root, 3);
	const buildWorkspaceGraph = mock(async () => builtGraph);
	const saveGraph = mock(async () => {});
	const updateGraphForFiles = mock(async () => savedGraph ?? builtGraph);
	const loadGraph = mock(async () => savedGraph);
	const probeFreshness = mock(async () => result);
	const writeFingerprint = mock(async () => true);
	// These injected fakes model successful I/O only. Error/corruption and
	// fingerprint-refusal branches are exercised explicitly in dedicated tests
	// below; real filesystem semantics belong to the freshness/storage suites.
	const deps: RepoGraphDeps = {
		buildWorkspaceGraph,
		saveGraph,
		updateGraphForFiles,
		loadGraph,
		probeFreshness,
		writeFingerprint,
		isGraphWideInputPath: (filePath) =>
			path.basename(filePath) === 'package.json',
		safeRealpathSync: (filePath) => filePath,
	};
	return {
		deps,
		buildWorkspaceGraph,
		saveGraph,
		updateGraphForFiles,
		loadGraph,
		probeFreshness,
		writeFingerprint,
	};
}

const options = {
	refreshCap: 1,
	maxFiles: 321,
	walkBudgetMs: 4_321,
	excludeDirs: ['generated'],
};

describe('repo graph startup freshness decisions (issue #1986)', () => {
	test('enabled:false is a defensive no-op for init and write hooks', async () => {
		const root = path.resolve('disabled-repo-graph');
		const f = fixture(root, null, probe('no-fingerprint'));
		const hook = createRepoGraphBuilderHook(root, f.deps, {
			...options,
			enabled: false,
		});

		await hook.init();
		await hook.toolAfter(
			{ tool: 'write', sessionID: 's1', args: { file_path: 'src/a.ts' } },
			{},
		);

		expect(f.loadGraph).not.toHaveBeenCalled();
		expect(f.buildWorkspaceGraph).not.toHaveBeenCalled();
		expect(f.updateGraphForFiles).not.toHaveBeenCalled();
		expect(f.writeFingerprint).not.toHaveBeenCalled();
	});

	test.each([
		'clean',
		'inconclusive',
	] as const)('%s probe leaves the saved graph untouched', async (state) => {
		const root = path.resolve(`repo-graph-${state}`);
		const saved = graphWithNodes(root, 10);
		const f = fixture(root, saved, probe(state, [path.join(root, 'src/a.ts')]));
		const hook = createRepoGraphBuilderHook(root, f.deps, options);

		await hook.init();

		expect(f.buildWorkspaceGraph).not.toHaveBeenCalled();
		expect(f.updateGraphForFiles).not.toHaveBeenCalled();
		expect(f.writeFingerprint).not.toHaveBeenCalled();
	});

	test.each([
		['missing graph', null, probe('no-fingerprint')],
		[
			'missing fingerprint',
			graphWithNodes(path.resolve('no-fp'), 2),
			probe('no-fingerprint'),
		],
	] as const)('full-builds for %s and certifies the result', async (_label, saved, result) => {
		const root = path.resolve(`repo-graph-${_label.replaceAll(' ', '-')}`);
		const f = fixture(root, saved, result);
		const hook = createRepoGraphBuilderHook(root, f.deps, options);

		await hook.init();

		expect(f.buildWorkspaceGraph).toHaveBeenCalledWith(root, {
			maxFiles: 321,
			walkBudgetMs: 4_321,
			excludeDirs: ['generated'],
		});
		expect(f.saveGraph).toHaveBeenCalledTimes(1);
		expect(f.writeFingerprint).toHaveBeenCalledTimes(1);
	});

	test('corrupt saved graph triggers a full rebuild', async () => {
		const root = path.resolve('repo-graph-corrupt');
		const f = fixture(root, null, probe('clean'));
		f.loadGraph.mockImplementation(async () => {
			throw Object.assign(new Error('corrupt graph'), { code: 'CORRUPTION' });
		});
		const hook = createRepoGraphBuilderHook(root, f.deps, options);

		await hook.init();

		expect(f.buildWorkspaceGraph).toHaveBeenCalledTimes(1);
		expect(f.probeFreshness).not.toHaveBeenCalled();
	});

	test('initRefresh:false retains the configured legacy full rebuild', async () => {
		const root = path.resolve('repo-graph-legacy');
		const f = fixture(root, graphWithNodes(root, 2), probe('clean'));
		const hook = createRepoGraphBuilderHook(root, f.deps, {
			...options,
			initRefresh: false,
		});

		await hook.init();

		expect(f.loadGraph).not.toHaveBeenCalled();
		expect(f.probeFreshness).not.toHaveBeenCalled();
		expect(f.buildWorkspaceGraph).toHaveBeenCalledTimes(1);
	});

	test('complete drift at the strict cutover is incremental and deduplicated', async () => {
		const root = path.resolve('repo-graph-incremental');
		const saved = graphWithNodes(root, 10);
		const a = path.join(root, 'src/a.ts');
		const b = path.join(root, 'src/b.ts');
		const c = path.join(root, 'src/c.ts');
		const d = path.join(root, 'src/d.ts');
		const f = fixture(root, saved, probe('drifted', [a, b, c], [c, d]));
		const hook = createRepoGraphBuilderHook(root, f.deps, options);

		await hook.init();

		expect(f.updateGraphForFiles).toHaveBeenCalledWith(root, [a, b, c, d], {
			buildOptions: {
				maxFiles: 321,
				walkBudgetMs: 4_321,
				excludeDirs: ['generated'],
			},
		});
		expect(f.buildWorkspaceGraph).not.toHaveBeenCalled();
	});

	test.each([
		['above strict cutover', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']],
		['graph-wide manifest', ['package.json']],
	] as const)('full-builds complete drift for %s', async (_label, names) => {
		const root = path.resolve(`repo-graph-${_label.replaceAll(' ', '-')}`);
		const saved = graphWithNodes(root, 10);
		const changed = names.map((name) => path.join(root, name));
		const f = fixture(root, saved, probe('drifted', changed));
		const hook = createRepoGraphBuilderHook(root, f.deps, options);

		await hook.init();

		expect(f.buildWorkspaceGraph).toHaveBeenCalledTimes(1);
		expect(f.updateGraphForFiles).not.toHaveBeenCalled();
	});

	test('write-triggered fallback receives the configured build limits', async () => {
		const root = path.resolve('repo-graph-tool-after');
		const filePath = path.join(root, 'src', 'a.ts');
		const f = fixture(root, graphWithNodes(root, 1), probe('clean'));
		const hook = createRepoGraphBuilderHook(root, f.deps, options);

		await hook.toolAfter(
			{ tool: 'write', sessionID: 's1', args: { file_path: filePath } },
			{},
		);

		expect(f.updateGraphForFiles).toHaveBeenCalledWith(root, [filePath], {
			buildOptions: {
				maxFiles: 321,
				walkBudgetMs: 4_321,
				excludeDirs: ['generated'],
			},
		});
	});
});

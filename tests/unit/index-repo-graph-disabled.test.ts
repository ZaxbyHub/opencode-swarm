import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getSafeDefaultConfigLoadResult } from '../../src/config';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import { withSafeTestDir } from '../helpers/safe-test-dir';

describe('repo_graph.enabled plugin wiring (issue #1986)', () => {
	let restore = () => {};

	afterEach(() => {
		restore();
		restore = () => {};
	});

	test('disabled config avoids hook construction and startup registration', async () => {
		await withSafeTestDir(async (directory) => {
			const defaults = getSafeDefaultConfigLoadResult();
			const createRepoGraphBuilderHook = mock(() => {
				throw new Error('disabled repo graph hook must not be constructed');
			});
			const scheduledTasks: Array<readonly (() => unknown)[]> = [];

			// Only the repo-graph admission decision is under test. Snapshot and
			// git-hygiene I/O are stubbed because their success/failure branches are
			// covered by tests/unit/index.test.ts.
			restore = overrideIndexInternalsForTest({
				loadPluginConfigWithMetaAsync: (async () => ({
					...defaults,
					config: {
						...defaults.config,
						repo_graph: {
							...defaults.config.repo_graph,
							enabled: false,
						},
					},
				})) as never,
				loadSnapshot: (async () => {}) as never,
				ensureSwarmGitExcluded: (async () => {}) as never,
				createRepoGraphBuilderHook: createRepoGraphBuilderHook as never,
				schedulePostResolutionTasks: ((tasks: readonly (() => unknown)[]) => {
					scheduledTasks.push(tasks);
				}) as never,
			});

			const plugin = await OpenCodeSwarm.server({
				client: {} as never,
				project: {} as never,
				directory,
				worktree: directory,
				serverUrl: new URL('http://localhost:3000'),
				$: {} as never,
			});

			expect(plugin).toHaveProperty('tool');
			expect(createRepoGraphBuilderHook).not.toHaveBeenCalled();
			// The wrapper scheduler still receives other optional startup work; the
			// absence of a constructed repo hook proves no repo watchdog/init task or
			// toolAfter callback can have been registered.
			expect(scheduledTasks.length).toBe(1);
		});
	}, 30_000);
});

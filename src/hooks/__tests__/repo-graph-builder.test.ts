/**
 * Repo-graph builder hook tests (issue #704).
 *
 * These tests validate the contract that prevents the OpenCode Desktop hang:
 *   - calling `init()` returns control to the caller within a single
 *     macrotask (i.e. async-function-runs-sync-until-first-await is not
 *     reintroduced),
 *   - `toolAfter` waits for the initial scan before applying incremental
 *     updates (no race between the deferred init and the first write tool),
 *   - the homedir-refusal guard surfaces as a clean catch in `init()`.
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import { createRepoGraphBuilderHook } from '../repo-graph-builder';

describe('createRepoGraphBuilderHook — issue #704 contract', () => {
	test('init() returns to caller before scan work runs', async () => {
		const events: string[] = [];
		const hook = createRepoGraphBuilderHook('/nonexistent-workspace-704', {
			buildWorkspaceGraph: async () => {
				events.push('scan-start');
				return {
					schema_version: '1.0.0',
					workspaceRoot: '/test',
					nodes: {},
					edges: [],
					metadata: {
						generatedAt: new Date().toISOString(),
						generator: 'repo-graph',
						nodeCount: 0,
						edgeCount: 0,
					},
				};
			},
			saveGraph: async () => {
				events.push('save');
			},
			updateGraphForFiles: async () => {
				events.push('update');
				return {
					schema_version: '1.0.0',
					workspaceRoot: '/test',
					nodes: {},
					edges: [],
					metadata: {
						generatedAt: new Date().toISOString(),
						generator: 'repo-graph',
						nodeCount: 0,
						edgeCount: 0,
					},
				};
			},
		});

		// Call init() without awaiting; immediately schedule a sentinel
		// microtask. Pre-fix, the synchronous scan ran on the same call
		// frame and blocked the microtask queue. Post-fix, init() yields
		// to the macrotask queue before doing scan work, so any microtask
		// scheduled by the caller drains first. This models the real
		// host scenario where `await server(input, options)` continues
		// via microtask after the plugin's init Promise settles.
		const initPromise = hook.init();
		await new Promise<void>((resolve) => {
			queueMicrotask(() => {
				events.push('sentinel');
				resolve();
			});
		});
		await initPromise;
		expect(events.indexOf('sentinel')).toBeLessThan(
			events.indexOf('scan-start'),
		);
	});

	test('init() is idempotent — multiple calls share one promise', async () => {
		let scans = 0;
		const hook = createRepoGraphBuilderHook('/whatever-workspace', {
			buildWorkspaceGraph: async () => {
				scans++;
				return {
					schema_version: '1.0.0',
					workspaceRoot: '/test',
					nodes: {},
					edges: [],
					metadata: {
						generatedAt: new Date().toISOString(),
						generator: 'repo-graph',
						nodeCount: 0,
						edgeCount: 0,
					},
				};
			},
			saveGraph: async () => {},
			updateGraphForFiles: async () => ({
				schema_version: '1.0.0',
				workspaceRoot: '/test',
				nodes: {},
				edges: [],
				metadata: {
					generatedAt: new Date().toISOString(),
					generator: 'repo-graph',
					nodeCount: 0,
					edgeCount: 0,
				},
			}),
		});
		await Promise.all([hook.init(), hook.init(), hook.init()]);
		expect(scans).toBe(1);
	});

	test('init() swallows the homedir-refusal error from the underlying builder', async () => {
		const hook = createRepoGraphBuilderHook(os.homedir(), {
			buildWorkspaceGraph: async () => {
				throw new Error(
					`Refusing to scan top-level system path as workspace: ${os.homedir()}.`,
				);
			},
			saveGraph: async () => {},
			updateGraphForFiles: async () => ({
				schema_version: '1.0.0',
				workspaceRoot: '/test',
				nodes: {},
				edges: [],
				metadata: {
					generatedAt: new Date().toISOString(),
					generator: 'repo-graph',
					nodeCount: 0,
					edgeCount: 0,
				},
			}),
		});
		// Must not reject — init() catches and logs.
		await expect(hook.init()).resolves.toBeUndefined();
	});

	test('toolAfter waits for the initial scan to finish before updating', async () => {
		const order: string[] = [];
		let resolveScan: () => void = () => {};
		const scanGate = new Promise<void>((r) => {
			resolveScan = r;
		});
		const hook = createRepoGraphBuilderHook('/some/workspace', {
			buildWorkspaceGraph: async () => {
				await scanGate;
				order.push('scan-done');
				return {
					schema_version: '1.0.0',
					workspaceRoot: '/test',
					nodes: {},
					edges: [],
					metadata: {
						generatedAt: new Date().toISOString(),
						generator: 'repo-graph',
						nodeCount: 0,
						edgeCount: 0,
					},
				};
			},
			saveGraph: async () => {},
			updateGraphForFiles: async () => {
				order.push('update');
				return {
					schema_version: '1.0.0',
					workspaceRoot: '/test',
					nodes: {},
					edges: [],
					metadata: {
						generatedAt: new Date().toISOString(),
						generator: 'repo-graph',
						nodeCount: 0,
						edgeCount: 0,
					},
				};
			},
		});
		const initPromise = hook.init();
		// Fire toolAfter while the scan is still gated. The handler must
		// wait for the scan (no `update` before `scan-done`).
		const toolPromise = hook.toolAfter(
			{
				tool: 'edit',
				sessionID: 's1',
				args: { file_path: '/some/workspace/x.ts' },
			},
			{},
		);
		await new Promise((r) => setTimeout(r, 25));
		expect(order).toEqual([]);
		resolveScan();
		await initPromise;
		await toolPromise;
		expect(order).toEqual(['scan-done', 'update']);
	});
});

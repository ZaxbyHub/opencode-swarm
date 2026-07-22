import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarm, {
	capSessionMap,
	overrideIndexInternalsForTest,
	schedulePostResolutionTasksForTest,
} from '../../src/index';

type IndexInternalsOverrides = Parameters<
	typeof overrideIndexInternalsForTest
>[0];
type RepoGraphBuilderFactory = NonNullable<
	IndexInternalsOverrides['createRepoGraphBuilderHook']
>;

describe('OpenCodeSwarm Plugin Registration', () => {
	let tempDir: string;
	let restoreIndexInternals = () => {};

	const mockPluginInput = {
		client: {} as any,
		project: {} as any,
		directory: '' as string,
		worktree: '' as string,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	};

	beforeEach(async () => {
		// Create a temp directory for the mock context
		tempDir = await mkdtemp(path.join(tmpdir(), 'swarm-test-'));
		mockPluginInput.directory = tempDir;
		mockPluginInput.worktree = tempDir;
	});

	afterEach(async () => {
		restoreIndexInternals();
		restoreIndexInternals = () => {};
		// Clean up temp directory
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('1. default export uses OpenCode v1 plugin object shape', () => {
		expect(OpenCodeSwarm.id).toBe('opencode-swarm');
		expect(typeof OpenCodeSwarm.server).toBe('function');
	});

	test('2. plugin server returns object with tool property when invoked with mock context', async () => {
		const result = await OpenCodeSwarm.server(mockPluginInput);
		expect(result).toHaveProperty('tool');
	});

	test('3. tool property contains doc_scan and doc_extract entries', async () => {
		const result = await OpenCodeSwarm.server(mockPluginInput);
		expect(result.tool).toHaveProperty('doc_scan');
		expect(result.tool).toHaveProperty('doc_extract');
	});

	test('4. doc_scan and doc_extract are defined tool objects (not undefined)', async () => {
		const result = await OpenCodeSwarm.server(mockPluginInput);
		// Tools created with createSwarmTool are objects with execute properties
		expect(result.tool.doc_scan).toBeDefined();
		expect(result.tool.doc_extract).toBeDefined();
		expect(typeof result.tool.doc_scan.execute).toBe('function');
		expect(typeof result.tool.doc_extract.execute).toBe('function');
	});

	test('5. server settles before deferred repo-graph startup begins (issue #704)', async () => {
		const order: string[] = [];
		let scheduledTasks: readonly (() => void)[] = [];
		let markScanStarted!: () => void;
		const scanStarted = new Promise<void>((resolve) => {
			markScanStarted = resolve;
		});
		const createRepoGraphBuilderHook = (() => ({
			init: async () => {
				order.push('repo-graph-started');
				markScanStarted();
			},
			toolAfter: async () => {},
		})) as RepoGraphBuilderFactory;
		restoreIndexInternals = overrideIndexInternalsForTest({
			createRepoGraphBuilderHook,
			schedulePostResolutionTasks: (tasks) => {
				scheduledTasks = [...tasks];
			},
		});

		// Previous code queued init from inside initializeOpenCodeSwarm before its
		// final awaits. The fake scan therefore started before this promise settled.
		const serverPromise = OpenCodeSwarm.server(mockPluginInput);
		void serverPromise.then(() => order.push('server-resolved'));
		await serverPromise;
		expect(order).toEqual(['server-resolved']);
		expect(scheduledTasks.length).toBeGreaterThan(0);

		scheduledTasks[0]?.();
		await scanStarted;
		expect(order).toEqual(['server-resolved', 'repo-graph-started']);
	});

	test('5b. issue #1782: config-load timeout falls back to safe defaults and init still completes', async () => {
		// The parallel init I/O wraps loadPluginConfigWithMetaAsync in a 2s
		// withTimeout. If the read stalls past 2s, init must STILL complete
		// and the resulting config must equal getSafeDefaultConfigLoadResult().
		// We deterministically inject a stall via the test seam added in
		// issue #1782 (overrideIndexInternalsForTest).
		const stall = new Promise(() => {
			/* never resolves — simulates a hung AV scan */
		});
		restoreIndexInternals = overrideIndexInternalsForTest({
			loadPluginConfigWithMetaAsync: (() => stall) as any,
			schedulePostResolutionTasks: () => {
				/* swallow to keep test deterministic */
			},
		});

		const start = Date.now();
		const result = await OpenCodeSwarm.server(mockPluginInput);
		const elapsed = Date.now() - start;

		// Init completed despite the stall. Bounded by LOAD_PLUGIN_CONFIG_TIMEOUT_MS
		// (~2000ms) plus the parallel reads' latencies; allow generous headroom.
		expect(result).toHaveProperty('tool');
		expect(elapsed).toBeLessThan(10_000);
		// The other two parallel reads complete near-instantly (no real .swarm
		// state, no real git exclude issues in a fresh tmpdir), so the bound
		// on total time is dominated by the 2s config timeout.
		expect(elapsed).toBeGreaterThanOrEqual(1900);
	});

	test('5c. issue #1782: parallel init I/O runs config+snapshot+git-exclude concurrently', async () => {
		// Inject three stubs that record start timestamps; assert they all
		// start within a small window (proves the reads are concurrent).
		const started: Record<string, number> = {};

		const makeStub = (key: 'config' | 'snapshot' | 'gitExclude') => {
			const stub = (..._args: unknown[]) =>
				new Promise<any>((resolve) => {
					started[key] = Date.now();
					// Resolve on next tick — gives the other two stubs time to
					// also start before we let Promise.all complete.
					setTimeout(() => {
						resolve(
							key === 'config'
								? {
										config: {
											full_auto: { enabled: false },
											guardrails: { enabled: true },
											quiet: true,
										},
										recovery: 'none',
										removedKeys: [],
										warnings: [],
										loadedFromFile: false,
										configHadErrors: false,
									}
								: undefined,
						);
					}, 5);
				});
			return stub;
		};

		restoreIndexInternals = overrideIndexInternalsForTest({
			loadPluginConfigWithMetaAsync: makeStub('config') as any,
			loadSnapshot: makeStub('snapshot') as any,
			ensureSwarmGitExcluded: makeStub('gitExclude') as any,
			createRepoGraphBuilderHook: (() => ({
				init: async () => {},
				toolAfter: async () => {},
			})) as any,
			schedulePostResolutionTasks: () => {
				/* swallow */
			},
		});

		await OpenCodeSwarm.server(mockPluginInput);

		// All three started within a small window of each other (parallel).
		const starts = Object.values(started);
		expect(starts.length).toBe(3);
		const maxDelta = Math.max(...starts) - Math.min(...starts);
		// Concurrent: Promise.all starts all three within a single event-loop
		// tick (a few ms). A sequential chain would space them ~5ms apart
		// (each stub's setTimeout) → ~10ms total spread. Allow headroom.
		expect(maxDelta).toBeLessThan(8);
	});

	test('6. post-resolution scheduler launches tasks from a later timer turn', async () => {
		const order = ['caller'];
		let markTaskStarted!: () => void;
		const taskStarted = new Promise<void>((resolve) => {
			markTaskStarted = resolve;
		});

		schedulePostResolutionTasksForTest([
			() => {
				order.push('task');
				markTaskStarted();
			},
		]);
		expect(order).toEqual(['caller']);

		await taskStarted;
		expect(order).toEqual(['caller', 'task']);
	});

	test('7. post-resolution scheduler isolates synchronous and asynchronous task failures', async () => {
		const order: string[] = [];
		let markFinalTaskStarted!: () => void;
		const finalTaskStarted = new Promise<void>((resolve) => {
			markFinalTaskStarted = resolve;
		});

		schedulePostResolutionTasksForTest([
			() => {
				order.push('sync-failure');
				throw new Error('expected synchronous failure');
			},
			async () => {
				order.push('async-failure');
				throw new Error('expected asynchronous failure');
			},
			() => {
				order.push('final-task');
				markFinalTaskStarted();
			},
		]);

		await finalTaskStarted;
		expect(order).toEqual(['sync-failure', 'async-failure', 'final-task']);
	});
});

describe('capSessionMap heartbeat memory cap (invariant-8)', () => {
	test('FIFO-caps a session-keyed map at max, evicting oldest first', () => {
		// Mirrors the heartbeat throttle path: set a key, then cap the map.
		const map = new Map<string, number>();
		const max = 500;
		for (let i = 0; i < 600; i++) {
			// Deterministic monotonic stamp (value is irrelevant — the cap
			// evicts by insertion order, not by timestamp).
			map.set(`session-${i}`, 1_700_000_000_000 + i);
			capSessionMap(map, max);
			expect(map.size).toBeLessThanOrEqual(max);
		}

		// Size is pinned at the cap after inserting more than `max` distinct keys.
		expect(map.size).toBe(max);
		// Oldest key was evicted; the most recent key survives (FIFO semantics).
		expect(map.has('session-0')).toBe(false);
		expect(map.has('session-599')).toBe(true);
	});

	test('no-op when the map is already within the cap', () => {
		const map = new Map<string, number>([
			['a', 1],
			['b', 2],
		]);
		capSessionMap(map, 500);
		expect(map.size).toBe(2);
		expect(map.has('a')).toBe(true);
		expect(map.has('b')).toBe(true);
	});
});

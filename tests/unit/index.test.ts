import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getSafeDefaultConfigLoadResult } from '../../src/config';
import OpenCodeSwarm, {
	capSessionMap,
	overrideIndexInternalsForTest,
	schedulePostResolutionTasksForTest,
} from '../../src/index';
import { swarmState } from '../../src/state';
import { createIndexCommandsModuleGuards } from '../helpers/index-commands-shared.js';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';

// File-scoped DEFAULT stub for the post-resolution queue (PR #2173 F-006).
//
// Tests 2/3/4 boot `OpenCodeSwarm.server()` with no override of their own. That
// boot queues background work on an unref'd `setTimeout(0)` which fires AFTER
// the synchronous `afterEach` removed `tempDir` — and then RECREATES it,
// leaving permanent `swarm-test-*` orphans in the system temp directory (2-5
// per run).
//
// This is a DEFAULT, not a blanket override: `overrideIndexInternalsForTest`
// saves the current value and its restore function puts that value back, so the
// per-test overrides in tests 5 / 5b / 5c / 5d / 5e still win for their own
// duration and their `afterEach` restore lands back on this no-op. Tests 6 and 7
// call `schedulePostResolutionTasksForTest`, which invokes the REAL
// `schedulePostResolutionTasks` directly rather than the injectable alias, so
// they are unaffected — the scheduling seam stays fully exercised.
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
afterAll(moduleGuards.tearDownAll);

type IndexInternalsOverrides = Parameters<
	typeof overrideIndexInternalsForTest
>[0];
type RepoGraphBuilderFactory = NonNullable<
	IndexInternalsOverrides['createRepoGraphBuilderHook']
>;

describe('OpenCodeSwarm Plugin Registration', () => {
	let tempDir: string;
	let restoreIndexInternals = () => {};
	let cleanupIsolatedEnv: () => void = () => {};

	const mockPluginInput = {
		client: {} as any,
		project: {} as any,
		directory: '' as string,
		worktree: '' as string,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	};

	beforeEach(async () => {
		// Redirect XDG_CONFIG_HOME/XDG_CACHE_HOME into a temp root BEFORE any
		// unstubbed `OpenCodeSwarm.server()` boot below. The boot's post-resolution
		// queue runs config-doctor, whose getUserConfigDir() ignores `directory`
		// entirely (src/services/config-doctor.ts:582-584); with no
		// `.opencode/opencode-swarm.json` under the temp `directory`, its
		// project-absent fallback reads AND REWRITES the developer's real global
		// ~/.config/opencode/opencode-swarm.json (config-doctor.ts:1884-1896).
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
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
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
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

	test('5a. memory reflection startup is opt-in and deferred until after server resolution', async () => {
		let scheduledTasks: ReadonlyArray<() => void | Promise<void>> = [];
		let regenerationCalls = 0;
		const safe = getSafeDefaultConfigLoadResult();
		restoreIndexInternals = overrideIndexInternalsForTest({
			loadPluginConfigWithMetaAsync: (async () => ({
				...safe,
				config: {
					...safe.config,
					memory: {
						enabled: true,
						reflection: { enabled: true, halfLifeDays: 30 },
					},
				},
			})) as any,
			loadSnapshot: (async () => {}) as any,
			ensureSwarmGitExcluded: (async () => {}) as any,
			createRepoGraphBuilderHook: (() => ({
				init: async () => {},
				toolAfter: async () => {},
			})) as RepoGraphBuilderFactory,
			regenerateMemoryReflection: async () => {
				regenerationCalls++;
			},
			schedulePostResolutionTasks: (tasks) => {
				scheduledTasks = [...tasks];
			},
		});

		await OpenCodeSwarm.server(mockPluginInput);
		expect(regenerationCalls).toBe(0);

		const reflectionTask = scheduledTasks.find(
			(task) => task.name === 'regenerateMemoryReflectionTask',
		);
		expect(reflectionTask).toBeDefined();
		await reflectionTask?.();
		expect(regenerationCalls).toBe(1);
	});

	test('5b. issue #1782: config-load timeout falls back to safe defaults and init still completes', async () => {
		// The parallel init I/O wraps loadPluginConfigWithMetaAsync in a 2s
		// withTimeout. If the read stalls past 2s, init must STILL complete
		// and the resulting config must equal getSafeDefaultConfigLoadResult().
		//
		// We stub ALL THREE parallel I/O functions so the test is purely about
		// the config-read timeout mechanism — no real fs/git I/O that could
		// interact with the event loop on Windows CI. The config stub resolves
		// after 5s (well past the 2s timeout), NOT never — a never-resolving
		// promise can hang the event loop under Bun on Windows when combined
		// with unref'd timers in withTimeout.
		const slowConfig = new Promise<any>((resolve) => {
			setTimeout(() => resolve({ config: {}, loadedFromFile: false }), 5_000);
		});
		restoreIndexInternals = overrideIndexInternalsForTest({
			loadPluginConfigWithMetaAsync: (() => slowConfig) as any,
			loadSnapshot: (async () => {
				/* no-op — stubbed to avoid real fs I/O */
			}) as any,
			ensureSwarmGitExcluded: (async () => {
				/* no-op — stubbed to avoid real git spawn */
			}) as any,
			schedulePostResolutionTasks: () => {
				/* swallow to keep test deterministic */
			},
		});

		const { performance } = await import('node:perf_hooks');
		const start = performance.now();
		const result = await OpenCodeSwarm.server(mockPluginInput);
		const elapsed = performance.now() - start;

		// Init completed despite the stall. Bounded by LOAD_PLUGIN_CONFIG_TIMEOUT_MS
		// (~2000ms); the other two stubs resolve immediately.
		expect(result).toHaveProperty('tool');
		expect(elapsed).toBeLessThan(10_000);
		// The 2s timeout dominates the total time.
		expect(elapsed).toBeGreaterThanOrEqual(1900);
	});

	test('5c. issue #1782: parallel init I/O runs config+snapshot+git-exclude concurrently', async () => {
		// Inject three stubs that record start timestamps; assert they all
		// start within a small window (proves the reads are concurrent).
		// Uses performance.now() (monotonic) rather than the wall-clock Date
		// API to avoid the test-clock lint — these are elapsed-spread
		// measurements, not time-sensitive assertions that need a frozen clock.
		const { performance } = await import('node:perf_hooks');
		const started: Record<string, number> = {};

		const makeStub = (key: 'config' | 'snapshot' | 'gitExclude') => {
			const stub = (..._args: unknown[]) =>
				new Promise<any>((resolve) => {
					started[key] = performance.now();
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

	test('5d. issue #1782: immediate config-load REJECTION (not just timeout) falls back to safe defaults', async () => {
		// PRR-012 coverage gap (swarm-pr-review): test 5b only exercised the
		// never-resolving timeout path. The .catch also handles immediate
		// rejection (e.g. a synchronous throw inside the async loader body).
		// This test injects an immediately-rejecting loader and asserts:
		//   (a) init still completes (the .catch produces safe defaults)
		//   (b) the resulting config shape matches getSafeDefaultConfigLoadResult
		//       (PRR-006: assert the safe-default values are actually used)
		const expectedDefault = getSafeDefaultConfigLoadResult();
		// Seed the field to TRUE so the assertion proves a transition to the
		// safe-default value (false). Without this, the assertion would pass
		// even if init never assigned the field (it defaults to false at
		// src/state.ts). (Reviewer PRR-006 NEEDS_REVISION fix.)
		const previousFullAuto = swarmState.fullAutoEnabledInConfig;
		swarmState.fullAutoEnabledInConfig = true;
		restoreIndexInternals = overrideIndexInternalsForTest({
			loadPluginConfigWithMetaAsync: (async () => {
				throw new Error('simulated catastrophic config-read failure');
			}) as any,
			schedulePostResolutionTasks: () => {
				/* swallow */
			},
		});

		try {
			const result = await OpenCodeSwarm.server(mockPluginInput);

			// (a) Init completed despite the rejection.
			expect(result).toHaveProperty('tool');

			// (b) The safe-default config was actually used. We seeded
			// fullAutoEnabledInConfig to true; init must reset it to false
			// (the safe-default's full_auto.enabled value). This proves the
			// .catch fallback wired the safe-default config into init, not
			// just that init completed.
			expect(swarmState.fullAutoEnabledInConfig).toBe(false);
			expect(expectedDefault.config.full_auto?.enabled).toBe(false);
		} finally {
			swarmState.fullAutoEnabledInConfig = previousFullAuto;
		}
	});

	test('5e. issue #1782: ensureSwarmGitExcluded resolves before any .swarm/ write (ordering contract)', async () => {
		// PRR-011 coverage gap (swarm-pr-review): no test verified that the
		// parallel Promise.all preserves the in-source ordering contract —
		// `ensureSwarmGitExcluded` must complete before any `.swarm/` artifact
		// is created (so the exclude write protects .swarm/ from git).
		//
		// We observe the filesystem INSIDE the delayed git-exclude stub
		// (before it resolves) — if `.swarm/` already existed at that point,
		// ordering was broken (initTelemetry ran during the parallel block
		// instead of after Promise.all). (Reviewer PRR-011 NEEDS_REVISION fix.)
		const fs = await import('node:fs');
		let swarmDirExistedBeforeGitExclude: boolean | undefined;
		restoreIndexInternals = overrideIndexInternalsForTest({
			ensureSwarmGitExcluded: (() =>
				new Promise<void>((resolve) => {
					// Delay so the observation happens while the promise is
					// still unresolved. If ordering is correct, .swarm/ must
					// NOT exist yet (initTelemetry runs after Promise.all).
					setTimeout(() => {
						swarmDirExistedBeforeGitExclude = fs.existsSync(
							path.join(mockPluginInput.directory, '.swarm'),
						);
						resolve();
					}, 20);
				})) as any,
			createRepoGraphBuilderHook: (() => ({
				init: async () => {},
				toolAfter: async () => {},
			})) as any,
			schedulePostResolutionTasks: () => {
				/* swallow */
			},
		});

		await OpenCodeSwarm.server(mockPluginInput);

		// The stub observed the filesystem before resolving. If ordering
		// held (Promise.all before initTelemetry), .swarm/ did NOT exist
		// when the stub's 20ms timer fired — initTelemetry hasn't run yet.
		expect(swarmDirExistedBeforeGitExclude).toBe(false);
		// After server() returns, .swarm/ DOES exist (initTelemetry ran
		// after Promise.all).
		expect(fs.existsSync(path.join(mockPluginInput.directory, '.swarm'))).toBe(
			true,
		);
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

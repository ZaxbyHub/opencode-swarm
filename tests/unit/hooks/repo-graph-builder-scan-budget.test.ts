/**
 * Startup-scan budget + filter-first ordering tests for repo-graph-builder.ts
 * (issue #2472 REPOGRAPH-1, AC-1 / AC-2).
 *
 * Mirrors the frozen acceptance checks under
 * `.agents/issue-traces/2472-hot-path-stalls-restart-safe/repro/`:
 *
 *  - check-c1.ts — the ENTIRE cheap synchronous filter chain (enabled flag,
 *    WRITE_TOOL_NAMES membership, path extraction/validation, exclude dirs)
 *    runs BEFORE the init await, so a read-tool toolAfter settles immediately
 *    even while the startup scan is pending. Only write tools keep the gate.
 *  - check-c2.ts — the startup scan is bounded by an overall wall-clock budget
 *    (STARTUP_SCAN_BUDGET_MS, overridable via the additive `scanBudgetMs`
 *    options knob) that resolves fail-open, and a full rebuild announces its
 *    start via logger.log.
 *
 *  - PRR-003 / PR #2588 bot finding 4 — a timed-out (zombie) scan that
 *    completes in the background cannot overwrite a newer incremental save
 *    that landed after the budget fired (stale-overwrite generation guard).
 *
 * Uses the DI deps parameter (not mock.module) per the repo testing standard,
 * and canonicalMkdtemp for symlink-safe temp workspaces (issue #1737 / FR-011).
 */

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRepoGraphBuilderHook } from '../../../src/hooks/repo-graph-builder';
import type { RepoGraph } from '../../../src/tools/repo-graph';
import * as logger from '../../../src/utils/logger';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Workaround for Bun #32056 (see repo-graph-builder.test.ts): on Windows, a
// pending promise that leaves the event loop idle prevents bun's per-test
// --timeout from firing. These tests deliberately hold pending promises, so a
// 1s keepalive interval keeps the event loop waking regularly.
let _keepalive: ReturnType<typeof setInterval> | undefined;
beforeAll(() => {
	_keepalive = setInterval(() => {}, 1000);
});
afterAll(() => {
	if (_keepalive) clearInterval(_keepalive);
});

const tempWorkspace = canonicalMkdtemp('repo-graph-scan-budget-');

afterAll(() => {
	try {
		fs.rmSync(tempWorkspace, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimal graph fixture — only `metadata` counters are consumed by the hook. */
function fakeGraph(nodeCount = 3, edgeCount = 1): RepoGraph {
	return {
		schema_version: '1.0.0',
		workspaceRoot: tempWorkspace,
		nodes: {},
		edges: [],
		metadata: {
			generatedAt: '2026-01-15T00:00:00.000Z',
			generator: 'test',
			nodeCount,
			edgeCount,
		},
	} satisfies RepoGraph;
}

/** A buildWorkspaceGraph dep that never settles (a wedged scan). */
function neverSettlingBuild(): () => Promise<RepoGraph> {
	return () => new Promise<RepoGraph>(() => {});
}

function writeFixture(relPath: string): string {
	const abs = path.join(tempWorkspace, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, 'export const fixture = 1;\n');
	return abs;
}

describe('repo-graph-builder filter-first toolAfter (check-c1 mirror)', () => {
	test('read-tool toolAfter settles while the startup scan never settles', async () => {
		const saveGraph = mock(() => Promise.resolve());
		const hook = createRepoGraphBuilderHook(
			tempWorkspace,
			{
				// No saved graph -> doInit takes the full-rebuild path.
				loadGraph: async () => null,
				// The full scan never settles by construction (mirrors check-c1).
				buildWorkspaceGraph: neverSettlingBuild(),
				saveGraph,
				writeFingerprint: async () => true,
			},
			// Short budget only so the ref'ed withTimeout timer cannot linger
			// past the test; the scan itself can never settle before it.
			{ enabled: true, initRefresh: true, scanBudgetMs: 400 },
		);

		let initSettled = false;
		const initDone = hook.init().then(() => {
			initSettled = true;
		});
		// Give doInit one event-loop turn so it is genuinely inside the scan.
		await sleep(30);
		expect(initSettled).toBe(false);

		const outcome = await Promise.race([
			hook
				.toolAfter(
					{
						tool: 'read',
						sessionID: 'scan-budget-read',
						args: { file_path: path.join(tempWorkspace, 'some-file.ts') },
					},
					{ output: '' },
				)
				.then(() => 'settled' as const),
			sleep(200).then(() => 'timeout' as const),
		]);

		// The read call must settle WITHOUT the init promise having settled.
		expect(outcome).toBe('settled');
		expect(initSettled).toBe(false);

		// Cleanup: let the fail-open budget settle init (also proves it does),
		// and confirm the timed-out scan saved no graph.
		await initDone;
		expect(initSettled).toBe(true);
		expect(saveGraph).not.toHaveBeenCalled();
	});

	test('write-tool toolAfter still awaits the startup scan (gate preserved)', async () => {
		const srcFile = writeFixture(path.join('src', 'gated.ts'));
		let initSettledAt = 0;
		let updateCalledAt = 0;
		const updateGraphForFiles = mock(() => {
			// performance.now ordering stamps — the sanctioned test-clock pattern
			// (monotonic, so the >= ordering assertion is strictly sound).
			updateCalledAt = performance.now();
			return Promise.resolve(fakeGraph());
		});

		const hook = createRepoGraphBuilderHook(
			tempWorkspace,
			{
				loadGraph: async () => null,
				buildWorkspaceGraph: neverSettlingBuild(),
				saveGraph: async () => {},
				writeFingerprint: async () => true,
				updateGraphForFiles,
			},
			{ enabled: true, initRefresh: true, scanBudgetMs: 150 },
		);

		const initDone = hook.init().then(() => {
			initSettledAt = performance.now();
		});
		await sleep(30); // inside the pending scan
		expect(initSettledAt).toBe(0);

		const writeP = hook.toolAfter(
			{
				tool: 'edit',
				sessionID: 'scan-budget-write',
				args: { file_path: srcFile },
			},
			{ output: '' },
		);

		// While the scan is pending the write must NOT proceed — the gate is
		// the documented race/stomp protection for early writes.
		const early = await Promise.race([
			writeP.then(() => 'settled-early' as const),
			sleep(60).then(() => 'still-gated' as const),
		]);
		expect(early).toBe('still-gated');
		expect(updateGraphForFiles).not.toHaveBeenCalled();

		// After the fail-open budget settles init, the write proceeds — and
		// strictly after init settled (incremental updates stay serialized
		// behind the initial scan).
		await initDone;
		await writeP;
		expect(updateGraphForFiles).toHaveBeenCalledTimes(1);
		expect(updateCalledAt).toBeGreaterThanOrEqual(initSettledAt);
	});
});

describe('repo-graph-builder zombie-scan stale-overwrite guard (PRR-003 / bot finding 4)', () => {
	test('late full-scan save is skipped when a newer incremental save landed after the budget fired', async () => {
		// Prior buggy behavior: runBoundedInit raced doInit() via withTimeout;
		// on timeout initPromise settled fail-open but the background build
		// kept running, and its eventual _saveGraph unconditionally overwrote
		// whatever newer incremental save a write tool had persisted in the
		// meantime. The generation guard must skip the zombie save.
		const fullScanGraph = fakeGraph(11, 7);
		const incrementalGraph = fakeGraph(12, 8);
		const saveCalls: RepoGraph[] = [];
		const saveGraph = mock(
			async (_workspace: string, graph: RepoGraph): Promise<void> => {
				saveCalls.push(graph);
			},
		);
		// The incremental-update dep routes its persist through the SAME
		// saveGraph dep (mirroring the real updateGraphForFiles, which saves
		// its result) so the save ORDER is observable at one seam: the
		// incremental save lands first, and the zombie full-scan save must
		// never follow it.
		const updateGraphForFiles = mock(async () => {
			await saveGraph(tempWorkspace, incrementalGraph);
			return incrementalGraph;
		});
		// The full scan resolves only when released — well after the budget
		// fires — so doInit's rebuild is genuinely a zombie scan.
		let releaseBuild: (graph: RepoGraph) => void = () => {};
		const buildGate = new Promise<RepoGraph>((resolve) => {
			releaseBuild = resolve;
		});

		const hook = createRepoGraphBuilderHook(
			tempWorkspace,
			{
				loadGraph: async () => null, // forces the full-rebuild path
				buildWorkspaceGraph: () => buildGate,
				saveGraph,
				updateGraphForFiles,
				writeFingerprint: async () => true,
			},
			{ enabled: true, initRefresh: true, scanBudgetMs: 80 },
		);

		// 1. The startup scan starts and blows the budget -> init settles
		//    fail-open deterministically (init resolves exactly when the
		//    budget fires; buildGate is still pending).
		await hook.init();

		// 2. A write tool lands an incremental save while the zombie scan is
		//    still building. Only the incremental save has persisted so far.
		const srcFile = writeFixture(path.join('src', 'zombie-guard.ts'));
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: 'zombie-guard',
				args: { file_path: srcFile },
			},
			{ output: '' },
		);
		expect(updateGraphForFiles).toHaveBeenCalledTimes(1);
		expect(saveCalls).toEqual([incrementalGraph]);

		// 3. The zombie full scan completes LATE. Its save must be SKIPPED —
		//    saveGraph stays at exactly one call carrying the incremental
		//    result, never a second call overwriting it with the stale
		//    full-scan graph.
		releaseBuild(fullScanGraph);
		await sleep(50); // let the zombie continuation run its guard
		expect(saveGraph).toHaveBeenCalledTimes(1);
		expect(saveCalls[0]).toBe(incrementalGraph);
		expect(saveCalls).not.toContain(fullScanGraph);
	});
});

describe('repo-graph-builder startup scan budget (check-c2 mirror)', () => {
	test('scan exceeding the budget resolves fail-open: never rejects, warns, saves no graph', async () => {
		const saveGraph = mock(() => Promise.resolve());
		const updateGraphForFiles = mock(() => Promise.resolve(fakeGraph()));
		const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

		const hook = createRepoGraphBuilderHook(
			tempWorkspace,
			{
				loadGraph: async () => null, // forces the full-rebuild path
				buildWorkspaceGraph: neverSettlingBuild(),
				saveGraph,
				writeFingerprint: async () => true,
				updateGraphForFiles,
			},
			{ enabled: true, initRefresh: true, scanBudgetMs: 50 },
		);

		try {
			// initPromise must settle safely (resolve), never reject.
			await expect(hook.init()).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('wall-clock budget'),
			);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('fail-open'),
			);
			// No graph is saved for a timed-out scan.
			expect(saveGraph).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}

		// Incremental updates proceed on writes after the fail-open settle.
		const srcFile = writeFixture('post-budget.ts');
		await hook.toolAfter(
			{
				tool: 'edit',
				sessionID: 'scan-budget-post',
				args: { file_path: srcFile },
			},
			{ output: '' },
		);
		expect(updateGraphForFiles).toHaveBeenCalledTimes(1);
	});

	test('full rebuild announces its start BEFORE the scan work begins', async () => {
		const messages: string[] = [];
		const logSpy = spyOn(logger, 'log').mockImplementation(
			(message: string) => {
				messages.push(message);
			},
		);
		let announcementSeenWhenWorkBegan = false;
		const graph = fakeGraph(5, 2);

		const hook = createRepoGraphBuilderHook(
			tempWorkspace,
			{
				loadGraph: async () => null,
				buildWorkspaceGraph: async () => {
					// By the time the scan work runs, the start announcement
					// must already have been logged.
					announcementSeenWhenWorkBegan = messages.some((m) =>
						/\bscan start\b/i.test(m),
					);
					return graph;
				},
				saveGraph: async () => {},
				writeFingerprint: async () => true,
			},
			{ enabled: true, initRefresh: true },
		);

		try {
			await hook.init();
			expect(announcementSeenWhenWorkBegan).toBe(true);
			// The announcement carries whole-word start semantics (matches the
			// frozen check-c2 regex: start/begin/scanning/building as \b words).
			expect(
				messages.some((m) => /\b(start|begin|scanning|building)\b/i.test(m)),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});
});

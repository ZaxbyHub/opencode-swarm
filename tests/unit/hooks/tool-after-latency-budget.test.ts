/**
 * Composed tool.execute.after latency budget (issue #2472 W10 / AC-14).
 *
 * The measurable class this guard pins: seconds-scale stalls on the per-tool-
 * call hot path. At base, ONE `tool.execute.after` invocation could block for
 * seconds (sync `spawnSync` workspace snapshots on the delegation/stall paths,
 * unconditional ENOENT retry-sleep ladders, synchronous doc-index scans). The
 * fix workstreams (W1–W8) removed the blocking work; this test ratchets the
 * whole composed chain against regressions of that class.
 *
 * Method: boot the REAL plugin via `OpenCodeSwarm.server()` in a fresh temp
 * project (the same harness as tests/unit/index.test.ts — stubbed client, real
 * init, real config load) and invoke the REAL composed
 * `hooks['tool.execute.after']` handler — the same single async function the
 * host calls, containing every stage (activity, trajectory, knowledge ack/
 * verdict collectors, realtime admission, reviewer receipts, auto-review, PRM,
 * guardrails, delegation ledger, self-review, memory lifecycle, repo-graph,
 * hive promoter). No stage is stubbed or subset.
 *
 * Budget: 750 ms per composed steady-state call — the issue's stated ceiling
 * (hundreds-of-ms class per assumption A-2), generous for CI variance, and far
 * below the seconds-class regressions being guarded. PRR-005: the budget must
 * hold "including the first call of a fresh session", so the first composed
 * invocation on the freshly-booted plugin is MEASURED (it covers cold dynamic
 * imports and one-time per-session init) under its own documented ceiling —
 * see FIRST_CALL_BUDGET_MS below — instead of being discarded as warm-up.
 *
 * Elapsed time is measured with the monotonic `performance.now()` rather than
 * the wall-clock Date API — the repo's test-clock gate
 * (scripts/check-test-clock.ts) blocks raw wall-clock usage in added test
 * lines, and performance.now is the established precedent for elapsed
 * measurements (tests/unit/index.test.ts).
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import OpenCodeSwarm from '../../../src/index';
import { resetTelemetryForTesting } from '../../../src/telemetry';
import {
	createIndexCommandsModuleGuards,
	type MockPluginInput,
} from '../../helpers/index-commands-shared.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Per-composed-call ceiling (ms) for steady-state calls. See file header. */
const COMPOSED_CALL_BUDGET_MS = 750;

/**
 * First-call ceiling (ms) — PRR-005. The FIRST composed invocation on a fresh
 * plugin instance includes cold dynamic imports and one-time per-session init
 * across every stage (a legitimately heavier class than steady-state, which is
 * why it gets its own ceiling instead of being discarded as warm-up). Local
 * measurement (Windows dev box, this branch, fresh `bun test` process): first
 * composed call ≈ 40 ms — well under 750 ms, but that is one warm-ish local
 * sample, and CI's cold-filesystem runners run several× slower with far more
 * variance, so 750 ms is NOT a reliable first-call CI bound. 2000 ms keeps a
 * wide CI margin while still pinning the guarded property — a seconds-class
 * stall regression (the #2472 class) cannot hide under it. If CI proves the
 * first call reliably fits 750 ms, tighten this to match.
 */
const FIRST_CALL_BUDGET_MS = 2000;

// File-scoped guard (PR #2173 F-006): neutralize post-resolution task
// SCHEDULING so background init work cannot outlive the temp dir. The
// composed tool.execute.after chain itself is fully real.
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
afterAll(moduleGuards.tearDownAll);

type ToolAfterHandler = (
	input: unknown,
	output: unknown,
) => Promise<unknown> | unknown;

interface BootedPlugin {
	dispose: () => Promise<void>;
	'tool.execute.after'?: ToolAfterHandler;
}

function pluginInputFor(directory: string): MockPluginInput {
	return {
		client: {},
		project: {},
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {},
	};
}

describe('composed tool.execute.after latency budget (issue #2472 W10 / AC-14)', () => {
	let tempDir = '';
	let readTarget = '';
	let cleanupIsolatedEnv: () => void = () => {};

	beforeEach(() => {
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		// Fresh temp project per test — no init scans pending, no prior state.
		tempDir = canonicalMkdtemp('swarm-latency-');
		const opencodeDir = path.join(tempDir, '.opencode');
		mkdirSync(opencodeDir, { recursive: true });
		writeFileSync(
			path.join(opencodeDir, 'opencode-swarm.json'),
			JSON.stringify({ version_check: false, quiet: true }, null, 2),
		);
		// Representative read-tool target: a small EXISTING file in the project.
		readTarget = path.join(tempDir, 'sample-read-target.ts');
		writeFileSync(
			readTarget,
			'export const fixture = "latency-budget read target";\n',
		);
	});

	afterEach(() => {
		resetTelemetryForTesting();
		safeRmRecursive(tempDir);
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	test('the REAL composed tool.execute.after chain completes read-tool calls within the latency budget', async () => {
		const plugin = (await OpenCodeSwarm.server(
			pluginInputFor(tempDir) as any,
		)) as unknown as BootedPlugin;
		const toolAfter = plugin['tool.execute.after'];
		expect(
			typeof toolAfter,
			'booted plugin must expose the composed tool.execute.after handler',
		).toBe('function');

		const makeInput = (callID: string) => ({
			tool: 'read',
			sessionID: 'latency-budget-session',
			callID,
			args: { file_path: readTarget },
		});
		const makeOutput = () => ({
			output: 'export const fixture = "latency-budget read target";\n',
			metadata: {},
		});

		// (a) PRR-005: the FIRST composed invocation on the freshly-booted
		// plugin is MEASURED, not discarded — this is the "first call of a
		// fresh session" the issue requires the budget to cover (cold dynamic
		// imports + first-call init), under the documented first-call ceiling.
		const firstStart = performance.now();
		await toolAfter(makeInput('latency-first'), makeOutput());
		const firstElapsed = performance.now() - firstStart;
		expect(
			firstElapsed,
			`first composed tool.execute.after invocation took ${firstElapsed.toFixed(1)}ms — exceeds the ${FIRST_CALL_BUDGET_MS}ms first-call ceiling (seconds-class hot-path stall regression, issue #2472 class)`,
		).toBeLessThanOrEqual(FIRST_CALL_BUDGET_MS);

		// (b) two measured steady-state invocations follow.
		const measuredElapsed: number[] = [];
		for (let invocation = 1; invocation <= 2; invocation += 1) {
			const start = performance.now();
			await toolAfter(
				makeInput(`latency-measured-${invocation}`),
				makeOutput(),
			);
			const elapsed = performance.now() - start;
			measuredElapsed.push(elapsed);
			expect(
				elapsed,
				`composed tool.execute.after invocation ${invocation} took ${elapsed.toFixed(1)}ms — exceeds the ${COMPOSED_CALL_BUDGET_MS}ms budget (seconds-class hot-path stall regression, issue #2472 class)`,
			).toBeLessThanOrEqual(COMPOSED_CALL_BUDGET_MS);
		}

		// Both measured invocations stayed in budget (stability — not a
		// single lucky run). Redundant with the loop assertion but makes
		// the stability contract explicit in any failure diff.
		expect(measuredElapsed.length).toBe(2);
		expect(
			measuredElapsed.every((elapsed) => elapsed <= COMPOSED_CALL_BUDGET_MS),
			`measured composed-call timings must all stay within ${COMPOSED_CALL_BUDGET_MS}ms: got ${measuredElapsed.map((e) => e.toFixed(1)).join('ms, ')}ms`,
		).toBe(true);

		await expect(plugin.dispose()).resolves.toBeUndefined();
	}, 60_000);
});

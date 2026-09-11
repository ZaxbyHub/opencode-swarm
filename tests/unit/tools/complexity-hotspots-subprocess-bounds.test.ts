/**
 * #2674 — bounded-subprocess contract for the churn caller.
 *
 * Drives the REAL `complexity_hotspots` tool (→ `getGitChurn`'s `bunSpawn`)
 * against a real fake-git executable (tests/helpers/fake-git-2674.ts) for
 * the end-to-end modes, and through the `_internals.bunSpawn` DI seam for
 * the cross-runtime kill shapes (every stub sets `signalCode` explicitly —
 * `'SIGKILL'` for kill branches, `null` for tolerated/spawn-failure
 * branches). Kills must surface as the tool's structured `error` JSON —
 * never a fabricated empty success. Explicit per-test timeouts throughout
 * (bun:test's 5000 ms default would flake against the 10 s churn bound).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { performance } from 'node:perf_hooks';
import {
	_internals,
	complexity_hotspots,
} from '../../../src/tools/complexity-hotspots.js';
import {
	type FakeGitFixture,
	plantChurnSources,
	setupFakeGit,
	teardownFakeGit,
} from '../../helpers/fake-git-2674.js';

const CHURN_BOUND_MS = 10_000;
const TERMINATION_SLACK_MS = 25_000;

async function runTool(projectDir: string) {
	const raw = await complexity_hotspots.execute(
		{ days: 365, top_n: 5 },
		{ directory: projectDir },
	);
	return JSON.parse(raw) as {
		error?: string;
		hotspots?: Array<{ file: string }>;
		analyzedFiles?: number;
	};
}

describe('churn getGitChurn end-to-end bounds via real fake git (#2674)', () => {
	let fixture: FakeGitFixture | null = null;

	afterEach(() => {
		teardownFakeGit(fixture);
		fixture = null;
	});

	test('normal output: real analysis round-trip (hotspots > 0)', async () => {
		fixture = setupFakeGit('normal');
		plantChurnSources(fixture.projectDir);
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toBeUndefined();
		expect(parsed.hotspots).toHaveLength(3);
		expect(parsed.analyzedFiles).toBe(3);
	}, 20_000);

	test('nonzero exit with no signal stays tolerated as an empty result', async () => {
		fixture = setupFakeGit('nonzero');
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toBeUndefined();
		expect(parsed.hotspots).toEqual([]);
	}, 20_000);

	test('missing executable: structured spawn-failure error', async () => {
		fixture = setupFakeGit('normal', true);
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('git churn analysis failed');
	}, 20_000);

	test('hung child: killed at the bound, surfaces as structured error (not empty success)', async () => {
		fixture = setupFakeGit('hang');
		const started = performance.now();
		const parsed = await runTool(fixture.projectDir);
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(CHURN_BOUND_MS - 1_000);
		expect(elapsed).toBeLessThan(TERMINATION_SLACK_MS);
		expect(parsed.error).toContain('git churn analysis failed');
		expect(parsed.error).toContain('did not finish within 10000 ms');
		expect(parsed.hotspots).toEqual([]);
	}, 30_000);

	test('SIGTERM-trapping hung child: the bound still fires (tree kill + race)', async () => {
		fixture = setupFakeGit('hang-trap');
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('did not finish within 10000 ms');
	}, 30_000);

	test('early EOF then hang: bounded, structured error', async () => {
		fixture = setupFakeGit('eof');
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('git churn analysis failed');
	}, 30_000);

	test('forking child (grandchild holds the pipe): tree kill keeps the bound', async () => {
		fixture = setupFakeGit('fork');
		plantChurnSources(fixture.projectDir);
		const started = performance.now();
		const parsed = await runTool(fixture.projectDir);
		expect(performance.now() - started).toBeLessThan(TERMINATION_SLACK_MS);
		expect(parsed.error).toContain('git churn analysis failed');
	}, 30_000);

	test('output above the bound: BunCompatOutputLimitError surfaces as the structured error', async () => {
		fixture = setupFakeGit('overflow');
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('buffer limit');
	}, 30_000);
});

describe('churn kill-shape discrimination via _internals.bunSpawn DI (#2674)', () => {
	const originalBunSpawn = _internals.bunSpawn;
	let fixture: FakeGitFixture | null = null;

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		teardownFakeGit(fixture);
		fixture = null;
	});

	function stubSpawn(overrides: {
		exitCode: number | null;
		signalCode: NodeJS.Signals | null;
		spawnError?: Error | null;
		stdout?: string;
	}) {
		let killed = false;
		_internals.bunSpawn = (() => ({
			stdout: { text: async () => overrides.stdout ?? '' },
			stderr: { text: async () => '' },
			exited: Promise.resolve(overrides.exitCode ?? -1),
			exitCode: overrides.exitCode,
			signalCode: overrides.signalCode,
			spawnError: overrides.spawnError ?? null,
			kill() {
				killed = true;
			},
		})) as typeof _internals.bunSpawn;
		return { wasKilled: () => killed };
	}

	test('(a+b) wrapper-timeout kill shape (signalCode SIGKILL, both runtime shapes): structured error', async () => {
		fixture = setupFakeGit('normal');
		// Bun native path exposes signalCode as a getter; Node path via
		// observedSignal — both present as a plain property to the caller.
		const { wasKilled } = stubSpawn({
			exitCode: null,
			signalCode: 'SIGKILL',
			stdout: 'src/alpha.ts\n',
		});
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('killed by SIGKILL');
		expect(parsed.hotspots).toEqual([]);
		expect(wasKilled()).toBe(true);
	}, 20_000);

	test('(c) externally-supplied signalCode (SIGTERM) is still a bound breach', async () => {
		fixture = setupFakeGit('normal');
		stubSpawn({ exitCode: null, signalCode: 'SIGTERM' });
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('killed by SIGTERM');
	}, 20_000);

	test('(d) nonzero exit with signalCode null stays tolerated (empty repo case)', async () => {
		fixture = setupFakeGit('normal');
		const { wasKilled } = stubSpawn({
			exitCode: 128,
			signalCode: null,
			stderr: "fatal: your current branch 'main' does not have any commits yet",
		});
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toBeUndefined();
		expect(parsed.hotspots).toEqual([]);
		expect(wasKilled()).toBe(true); // finally-block best-effort kill still ran
	}, 20_000);

	test('spawnError with signalCode null keeps the existing #2236 loud failure', async () => {
		fixture = setupFakeGit('normal');
		stubSpawn({
			exitCode: null,
			signalCode: null,
			spawnError: new Error('spawn git ENOENT'),
		});
		const parsed = await runTool(fixture.projectDir);
		expect(parsed.error).toContain('spawn git ENOENT');
	}, 20_000);
});

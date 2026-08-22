/**
 * Generation guard for src/utils/git-executable.ts — an async probe cycle that
 * was abandoned by a cache reset must not commit its pre-reset result.
 *
 * THE BUG. Plugin init (`src/index.ts`) runs `ensureSwarmGitExcluded` under an
 * outer `withTimeout`, and `ensureSwarmGitExcluded` awaits
 * `resolveGitExecutableAsync()` as its first statement — so the probe starts
 * when the init promise is CONSTRUCTED. The user's `git.binary` is registered
 * afterwards via `setGitBinaryOverride`, which resets the resolver cache. When
 * the outer timeout fires, `withTimeout` settles the init promise but cannot
 * cancel the probe: the abandoned probe finishes after the reset and re-writes
 * a `success` cache entry naming the PRE-OVERRIDE candidate. Success entries
 * never expire, so the user's configured git binary was silently discarded for
 * the whole process lifetime.
 *
 * Moving `setGitBinaryOverride` earlier does not close this — the probe is
 * already in flight — so the fix is a generation counter checked at the write.
 *
 * See git-executable.test.ts (lazy-load/candidate ordering),
 * git-executable-override.test.ts (precedence/TTL/budget), and
 * git-executable-version-probe.test.ts (output-format validation).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import {
	_internals,
	describeGitResolution,
	resetGitExecutableCache,
	resolveGitExecutable,
	resolveGitExecutableAsync,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';
import {
	SIM_PLATFORM,
	SIM_SEP,
	writeSimFixture,
} from '../../helpers/git-executable-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ORIGINAL_INTERNALS = { ..._internals };

function restoreInternals(): void {
	_internals.spawnSync = ORIGINAL_INTERNALS.spawnSync;
	_internals.platform = ORIGINAL_INTERNALS.platform;
	_internals.env = ORIGINAL_INTERNALS.env;
	_internals.now = ORIGINAL_INTERNALS.now;
	_internals.yieldToEventLoop = ORIGINAL_INTERNALS.yieldToEventLoop;
}

function fakeSpawnResult(): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from('git version 2.43.0\n'), Buffer.from('')],
		stdout: Buffer.from('git version 2.43.0\n'),
		stderr: Buffer.from(''),
		status: 0,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<Buffer>;
}

/**
 * Freeze the clock. `probeCycle` re-checks `now() - start > TOTAL_BUDGET_MS`
 * at the top of EVERY iteration, and these tests hold the generator suspended
 * across several `await`s. On a loaded CI runner a real clock can cross the
 * 1000ms budget during that pause, flipping the outcome to `exhausted-budget`
 * and making the resolver return the bare `'git'` — which would turn a genuine
 * regression assertion red for entirely the wrong reason.
 */
const FROZEN_NOW = 1_000_000;

let tmpDir: string;

beforeEach(() => {
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	tmpDir = canonicalMkdtemp('git-exec-stale-');
	_internals.platform = () => SIM_PLATFORM;
	_internals.now = () => FROZEN_NOW;
	_internals.spawnSync = () => fakeSpawnResult();
});

afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A `yieldToEventLoop` stub that suspends the probe generator at its FIRST
 * yield and hands the test a handle to resume it, so the reset can be made to
 * land deterministically mid-probe rather than by timing luck.
 *
 * `probeCycle` only reaches a `yield` after a REJECTED candidate, which is why
 * every scenario below puts a non-existent PATH directory ahead of the real
 * fixture.
 */
function installFirstYieldGate(): {
	entered: Promise<void>;
	release: () => void;
} {
	let markEntered: () => void = () => {};
	const entered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});

	let pending = true;
	_internals.yieldToEventLoop = () => {
		if (!pending) return Promise.resolve();
		pending = false;
		markEntered();
		return released;
	};

	return { entered, release };
}

describe('git-executable stale in-flight probe guard', () => {
	test('an abandoned async probe does not clobber a newer git.binary override', async () => {
		const pathGit = writeSimFixture(tmpDir, 'path-git');
		const overrideGit = writeSimFixture(tmpDir, 'override-git');
		// Rejected first so the cycle reaches a yield we can suspend on.
		const absentDir = `${tmpDir}${SIM_SEP}absent`;
		_internals.env = () => ({ PATH: `${absentDir};${pathGit.dir}` });

		const gate = installFirstYieldGate();

		// Mirrors init: `ensureSwarmGitExcluded` starts the probe with NO
		// override registered.
		const stalePromise = resolveGitExecutableAsync();
		await gate.entered;

		// ...and the user's `git.binary` is registered while it is still running.
		setGitBinaryOverride(overrideGit.candidate);

		// The outer `withTimeout` has already given up, but the probe finishes.
		gate.release();
		const staleResult = await stalePromise;

		// Sanity: the race really happened as designed. A `'git'` here would mean
		// the fixtures never resolved (budget tripped, or a host/simulated
		// separator mismatch) and the assertions below would prove nothing.
		expect(staleResult).toBe(pathGit.candidate);

		// THE REGRESSION: the abandoned cycle must leave the reset state alone.
		expect(describeGitResolution().resolved).toBe(false);
		expect(describeGitResolution().attempts).toEqual([]);

		// ...so the next resolution honors the user's binary instead of a cached
		// pre-override candidate that would never expire.
		expect(await resolveGitExecutableAsync()).toBe(overrideGit.candidate);
		expect(describeGitResolution().resolvedPath).toBe(overrideGit.candidate);
	});

	test('a stale probe does not overwrite a NEWER cycle that already committed', async () => {
		const pathGit = writeSimFixture(tmpDir, 'path-git');
		const overrideGit = writeSimFixture(tmpDir, 'override-git');
		const absentDir = `${tmpDir}${SIM_SEP}absent`;
		_internals.env = () => ({ PATH: `${absentDir};${pathGit.dir}` });

		const gate = installFirstYieldGate();
		const stalePromise = resolveGitExecutableAsync();
		await gate.entered;

		setGitBinaryOverride(overrideGit.candidate);

		// A second caller resolves to completion BEFORE the abandoned one wakes.
		expect(await resolveGitExecutableAsync()).toBe(overrideGit.candidate);

		gate.release();
		await stalePromise;

		expect(describeGitResolution().resolvedPath).toBe(overrideGit.candidate);
		expect(await resolveGitExecutableAsync()).toBe(overrideGit.candidate);
	});

	test('an uncontested async resolution still memoizes (the guard is not a caching kill switch)', async () => {
		const pathGit = writeSimFixture(tmpDir, 'plain-git');
		_internals.env = () => ({ PATH: pathGit.dir });
		let spawnCalls = 0;
		_internals.spawnSync = () => {
			spawnCalls += 1;
			return fakeSpawnResult();
		};

		expect(await resolveGitExecutableAsync()).toBe(pathGit.candidate);
		expect(spawnCalls).toBe(1);
		expect(describeGitResolution().resolved).toBe(true);
		expect(describeGitResolution().resolvedPath).toBe(pathGit.candidate);

		expect(await resolveGitExecutableAsync()).toBe(pathGit.candidate);
		expect(spawnCalls).toBe(1);
	});

	test('the sync resolver still commits its result', () => {
		const pathGit = writeSimFixture(tmpDir, 'sync-git');
		_internals.env = () => ({ PATH: pathGit.dir });
		let spawnCalls = 0;
		_internals.spawnSync = () => {
			spawnCalls += 1;
			return fakeSpawnResult();
		};

		expect(resolveGitExecutable()).toBe(pathGit.candidate);
		expect(describeGitResolution().resolvedPath).toBe(pathGit.candidate);
		expect(resolveGitExecutable()).toBe(pathGit.candidate);
		expect(spawnCalls).toBe(1);
	});
});

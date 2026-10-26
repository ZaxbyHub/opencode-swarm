/**
 * Acceptance check C7 for issue #3317 (class: DISCRIMINATING).
 *
 * Negative-cache contract of the git-executable resolver (60s fallback TTL):
 *  - Arm 1 (discriminating): a probe cycle where every spawn TIMES OUT
 *    (error.code ETIMEDOUT) is an "unknown", not a rejection — the fallback
 *    outcome must NOT be negative-cached, so a later resolve INSIDE the 60s
 *    TTL re-probes (call count increases) and accepts a now-healthy
 *    candidate.
 *  - Arm 2 (guard, green at base): definite rejections (candidate exists but
 *    `git --version` exits nonzero) ARE negative-cached — a later resolve
 *    inside the TTL does NOT re-probe (call count unchanged).
 *
 * Mirrors the established pattern of git-executable-stale-probe.test.ts
 * (SIM_PLATFORM fixtures + _internals stubs, restored in afterEach).
 *
 * Arm 1 is RED at base (both outcomes share one 60s fallback cache entry, so
 * the second resolve never probes), GREEN after the fix. Arm 2 is GREEN at
 * both ends.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import {
	__seedGitExecutableForTests,
	_internals,
	resetGitExecutableCache,
	resolveGitExecutable,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';
import {
	SIM_PLATFORM,
	writeSimFixture,
} from '../../helpers/git-executable-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ORIGINAL_INTERNALS = { ..._internals };

function restoreInternals(): void {
	_internals.spawnSync = ORIGINAL_INTERNALS.spawnSync;
	_internals.platform = ORIGINAL_INTERNALS.platform;
	_internals.env = ORIGINAL_INTERNALS.env;
	_internals.now = ORIGINAL_INTERNALS.now;
	_internals.yieldToEventLoop = ORIGINAL_INTERNALS.yieldToEventLoop;
}

function timeoutSpawnResult(): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from(''), Buffer.from('')],
		stdout: Buffer.from(''),
		stderr: Buffer.from(''),
		status: null,
		signal: null,
		error: Object.assign(new Error('spawn ETIMEDOUT'), {
			code: 'ETIMEDOUT',
		}),
	} as SpawnSyncReturns<Buffer>;
}

function okSpawnResult(): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from('git version 2.45.0\n'), Buffer.from('')],
		stdout: Buffer.from('git version 2.45.0\n'),
		stderr: Buffer.from(''),
		status: 0,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<Buffer>;
}

function exitOneSpawnResult(): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		output: [null, Buffer.from(''), Buffer.from('boom')],
		stdout: Buffer.from(''),
		stderr: Buffer.from('boom'),
		status: 1,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<Buffer>;
}

/**
 * Frozen clock: the total-budget check (`now - start > TOTAL_BUDGET_MS`) reads
 * `_internals.now()` on every iteration; a real clock on a loaded runner can
 * cross the 1000ms budget mid-cycle and flip the outcome to exhausted-budget
 * for the wrong reason.
 */
const FROZEN_NOW = 1_000_000;
const ADVANCE_INSIDE_TTL_MS = 5_000; // far below NEGATIVE_CACHE_TTL_MS (60s)

let tmpDir: string;
let fakeNow: number;

beforeEach(() => {
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	tmpDir = canonicalMkdtemp('git-exec-timeout-');
	_internals.platform = () => SIM_PLATFORM;
	fakeNow = FROZEN_NOW;
	_internals.now = () => fakeNow;
});

afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	// Restore the preload's resolver pin so co-running test files keep the
	// zero-probe 'git' resolution this suite temporarily displaced.
	__seedGitExecutableForTests('git');
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('git-executable timeout-cycle negative caching (#3317 C7)', () => {
	test('an all-timeout probe cycle is not negative-cached: a later resolve inside the TTL re-probes', () => {
		const fixture = writeSimFixture(tmpDir, 'timeout-git');
		_internals.env = () => ({ PATH: fixture.dir });
		let spawnCalls = 0;
		_internals.spawnSync = () => {
			spawnCalls += 1;
			return timeoutSpawnResult();
		};

		const first = resolveGitExecutable();
		expect(first).toBe('git');
		const firstCount = spawnCalls;
		expect(firstCount).toBeGreaterThan(0);

		// git recovers: the very next probe of the on-disk candidate accepts.
		_internals.spawnSync = () => {
			spawnCalls += 1;
			return okSpawnResult();
		};
		fakeNow = FROZEN_NOW + ADVANCE_INSIDE_TTL_MS;

		const second = resolveGitExecutable();
		expect(spawnCalls).toBeGreaterThan(firstCount);
		expect(second).toBe(fixture.candidate);
	});

	test('definite rejections stay negative-cached for the TTL (no re-probe churn)', () => {
		const fixture = writeSimFixture(tmpDir, 'rejected-git');
		_internals.env = () => ({ PATH: fixture.dir });
		let spawnCalls = 0;
		_internals.spawnSync = () => {
			spawnCalls += 1;
			return exitOneSpawnResult();
		};

		const first = resolveGitExecutable();
		expect(first).toBe('git');
		const firstCount = spawnCalls;
		expect(firstCount).toBeGreaterThan(0);

		fakeNow = FROZEN_NOW + ADVANCE_INSIDE_TTL_MS;
		const second = resolveGitExecutable();
		expect(second).toBe('git');
		expect(spawnCalls).toBe(firstCount);
	});
});

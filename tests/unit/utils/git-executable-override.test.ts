/**
 * Override precedence, invalid-override fallthrough, negative-cache TTL,
 * probe-budget exhaustion, and async-yield behavior for
 * src/utils/git-executable.ts (issue #2236 hardening — F1/F4).
 *
 * See git-executable.test.ts for lazy-load, candidate-ordering, and
 * probe-validation coverage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import {
	_internals,
	describeGitResolution,
	GIT_BINARY_ENV_VAR,
	resetGitExecutableCache,
	resolveGitExecutable,
	resolveGitExecutableAsync,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';
import {
	SIM_GIT_NAME,
	SIM_PLATFORM,
	simJoin,
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

function fakeSpawnResult(
	overrides: Partial<SpawnSyncReturns<Buffer>> = {},
): SpawnSyncReturns<Buffer> {
	return {
		pid: 4242,
		// Real `git --version` output — probeCandidate requires git's own format.
		output: [null, Buffer.from('git version 2.43.0\n'), Buffer.from('')],
		stdout: Buffer.from('git version 2.43.0\n'),
		stderr: Buffer.from(''),
		status: 0,
		signal: null,
		error: undefined,
		...overrides,
	} as SpawnSyncReturns<Buffer>;
}

function enoentResult(): SpawnSyncReturns<Buffer> {
	return fakeSpawnResult({
		status: null,
		error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
	});
}

let tmpDir: string;

beforeEach(() => {
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	clearDeferredWarnings();
	tmpDir = canonicalMkdtemp('git-exec-override-');
});
afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	clearDeferredWarnings();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * On-disk fixtures come from tests/helpers/git-executable-fixtures.ts, which
 * shapes every candidate path for SIM_PLATFORM rather than for the host that
 * happens to be running the suite. See that module for why a `path.join`
 * fixture is a different string from the candidate the resolver generates,
 * and why `win32` is the only simulation that works on both hosts.
 */
function simulateFixturePlatform(): void {
	_internals.platform = () => SIM_PLATFORM;
}

/** Bound to this test's own tmpdir; see writeSimFixture for the guards. */
function writeFixture(
	label: string,
	...segments: string[]
): { dir: string; candidate: string } {
	return writeSimFixture(tmpDir, label, ...segments);
}

/**
 * Resolve, then assert BOTH that `expected` came back AND that the resolver
 * actually generated that string as a candidate. The second assertion is the
 * recurrence guard: a fixture shaped for the HOST instead of `SIM_PLATFORM`
 * fails it first, printing the generated candidate list beside the fixture
 * path — which names the cause, unlike a bare `Received: "git"`.
 */
function expectResolvesTo(expected: string): void {
	const resolved = resolveGitExecutable();
	expect(describeGitResolution().attempts.map((a) => a.candidate)).toContain(
		expected,
	);
	expect(resolved).toBe(expected);
}

describe('git-executable — override precedence', () => {
	test('env override wins over config override', () => {
		const envGit = writeFixture('env').candidate;
		const configGit = writeFixture('config').candidate;
		setGitBinaryOverride(configGit);

		simulateFixturePlatform();
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: envGit, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === envGit || cmd === configGit
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expectResolvesTo(envGit);
	});

	test('config override is used when no env override is set', () => {
		const configGit = writeFixture('config').candidate;
		setGitBinaryOverride(configGit);

		simulateFixturePlatform();
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === configGit ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expectResolvesTo(configGit);
	});

	test('platform candidate wins over a PATH candidate when both are valid', () => {
		// `Git`/`cmd` are the literal segments `windowsPlatformCandidates()`
		// appends to a ProgramFiles root, so the fixture is built from the same
		// segments and joined with the SIMULATED separator.
		const platformFixture = writeFixture(
			'ProgramFiles',
			'Git',
			'cmd',
			SIM_GIT_NAME,
		);
		const pathFixture = writeFixture('PathBin');

		simulateFixturePlatform();
		_internals.env = () => ({
			ProgramFiles: platformFixture.dir,
			PATH: pathFixture.dir,
		});
		_internals.spawnSync = (cmd) =>
			cmd === platformFixture.candidate || cmd === pathFixture.candidate
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expectResolvesTo(platformFixture.candidate);
	});

	test('PATH candidate wins when no platform candidate is valid', () => {
		const pathFixture = writeFixture('PathBin');

		simulateFixturePlatform();
		// ProgramFiles points at a real, empty directory — the constructed
		// Git\cmd\git.exe / Git\bin\git.exe candidates do not exist.
		_internals.env = () => ({ ProgramFiles: tmpDir, PATH: pathFixture.dir });
		_internals.spawnSync = (cmd) =>
			cmd === pathFixture.candidate
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expectResolvesTo(pathFixture.candidate);
	});
});

describe('git-executable — invalid override (F4 carry-forward item i)', () => {
	test('a relative-path override is skipped with a warning and resolution falls through', () => {
		const pathFixture = writeFixture('fallback');

		simulateFixturePlatform();
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: 'relative\\git.exe',
			PATH: pathFixture.dir,
		});
		_internals.spawnSync = (cmd) =>
			cmd === pathFixture.candidate
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expectResolvesTo(pathFixture.candidate);

		const { attempts } = describeGitResolution();
		const overrideAttempt = attempts.find((a) => a.source === 'override');
		expect(overrideAttempt?.reason).toBe('not an absolute path');
		expect(
			getDeferredWarnings().some((w) => w.includes('relative\\git.exe')),
		).toBe(true);
	});

	test('a nonexistent override is skipped with a warning and resolution falls through', () => {
		const pathFixture = writeFixture('fallback');
		// Deliberately never created — exempt from writeSimFixture, and absent
		// on every host because it lives under this test's own temp dir.
		const missingOverride = simJoin(
			path.join(tmpDir, 'nonexistent-override'),
			SIM_PLATFORM,
			SIM_GIT_NAME,
		);
		expect(fs.existsSync(missingOverride)).toBe(false);

		simulateFixturePlatform();
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: missingOverride,
			PATH: pathFixture.dir,
		});
		_internals.spawnSync = (cmd) =>
			cmd === pathFixture.candidate
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expectResolvesTo(pathFixture.candidate);
		expect(getDeferredWarnings().some((w) => w.includes(missingOverride))).toBe(
			true,
		);
	});

	test('an override that fails the git --version probe is skipped with a warning and falls through', () => {
		const brokenOverride = writeFixture('broken').candidate;
		const pathFixture = writeFixture('fallback');

		simulateFixturePlatform();
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: brokenOverride,
			PATH: pathFixture.dir,
		});
		_internals.spawnSync = (cmd) => {
			if (cmd === brokenOverride) return fakeSpawnResult({ status: 1 });
			if (cmd === pathFixture.candidate) return fakeSpawnResult({ status: 0 });
			return enoentResult();
		};

		expectResolvesTo(pathFixture.candidate);
		expect(getDeferredWarnings().some((w) => w.includes(brokenOverride))).toBe(
			true,
		);
	});

	test('a bad override never permanently wins even though it is candidate #1', () => {
		// Regression guard for the "silently wins" failure mode named in the
		// approved plan: an unusable override must not make a working host
		// unreachable.
		const pathFixture = writeFixture('fallback');
		simulateFixturePlatform();
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: '',
			PATH: pathFixture.dir,
		});
		_internals.spawnSync = (cmd) =>
			cmd === pathFixture.candidate
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		// Empty string override is normalized to "unset" — resolves via PATH.
		expectResolvesTo(pathFixture.candidate);
	});
});

describe('git-executable — setGitBinaryOverride cache semantics', () => {
	test('resets the cache only when the value actually changes', () => {
		const gitPath = writeFixture('cfg').candidate;
		setGitBinaryOverride(gitPath);

		simulateFixturePlatform();
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expectResolvesTo(gitPath);
		expect(describeGitResolution().resolved).toBe(true);

		setGitBinaryOverride(gitPath); // identical value — must NOT reset
		expect(describeGitResolution().resolved).toBe(true);

		setGitBinaryOverride(path.join(tmpDir, 'other-git.exe')); // different value — must reset
		expect(describeGitResolution().resolved).toBe(false);
	});

	test('empty-string override normalizes to unset', () => {
		setGitBinaryOverride('   ');
		expect(describeGitResolution().overrideValue).toBeUndefined();
	});
});

describe('git-executable — negative-cache TTL (60s)', () => {
	test('a failed resolution is served from cache before the TTL elapses', () => {
		let simulatedNow = 0;
		_internals.now = () => simulatedNow;
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		let platformCalls = 0;
		_internals.platform = () => {
			platformCalls++;
			return 'linux';
		};

		// Every candidate is rejected, so resolution falls back to the unprobed
		// bare name (BL-1). What this test pins is that the FALLBACK itself is
		// cached: the second call must return the same answer without paying
		// for another probe cycle.
		expect(resolveGitExecutable()).toBe('git');
		expect(platformCalls).toBe(1);

		simulatedNow = 59_000; // before the 60s TTL
		expect(resolveGitExecutable()).toBe('git');
		expect(platformCalls).toBe(1); // no new probe cycle ran
	});

	test('a failed resolution is re-probed after the TTL elapses', () => {
		let simulatedNow = 0;
		_internals.now = () => simulatedNow;
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		let platformCalls = 0;
		_internals.platform = () => {
			platformCalls++;
			return 'linux';
		};

		expect(resolveGitExecutable()).toBe('git');
		expect(platformCalls).toBe(1);

		simulatedNow = 61_000; // after the 60s TTL
		// Same answer, but re-derived — a host that installs git mid-session
		// must not stay pinned to the bare fallback until restart.
		expect(resolveGitExecutable()).toBe('git');
		expect(platformCalls).toBe(2); // a fresh probe cycle ran
	});

	test('a successful resolution is NOT subject to the negative-cache TTL', () => {
		const gitPath = writeFixture('success').candidate;
		let simulatedNow = 0;
		_internals.now = () => simulatedNow;
		simulateFixturePlatform();
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expectResolvesTo(gitPath);
		simulatedNow = 10_000_000; // far beyond any TTL
		expect(resolveGitExecutable()).toBe(gitPath);
	});
});

describe('git-executable — total probe budget (1000ms)', () => {
	test('remaining candidates are skipped once the budget is exceeded, and the bare fallback is returned', () => {
		let tick = 0;
		const TICK_STEP_MS = 400;
		_internals.now = () => {
			const v = tick;
			tick += TICK_STEP_MS;
			return v;
		};
		_internals.platform = () => 'linux';
		_internals.env = () => ({
			PATH: ['/d1', '/d2', '/d3', '/d4', '/d5'].join(':'),
		});
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		const resolved = resolveGitExecutable();
		expect(resolved).toBe('git');

		const { attempts } = describeGitResolution();
		// 3 linux platform candidates come first; the budget trips after 2 of
		// them are probed (start=0, checks at 400 and 800 pass, check at 1200
		// exceeds 1000 and breaks before a 3rd probe).
		expect(attempts.length).toBe(2);
		expect(attempts.every((a) => a.source === 'platform')).toBe(true);
	});

	test('the fallback result is itself memoized with the 60s negative TTL', () => {
		_internals.platform = () => 'linux';
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		// Force a budget-exhausted outcome deterministically by jumping the
		// clock forward by more than the budget on the very first check.
		let calls = 0;
		_internals.now = () => {
			calls++;
			return calls === 1 ? 0 : 5_000; // start=0, first loop-check=5000 -> exceeded
		};

		expect(resolveGitExecutable()).toBe('git');
		const description = describeGitResolution();
		expect(description.attempts).toEqual([]);
	});
});

describe('git-executable — resolveGitExecutableAsync', () => {
	test('yields to the event loop between candidate probes', async () => {
		let yieldCalls = 0;
		_internals.yieldToEventLoop = () => {
			yieldCalls++;
			return Promise.resolve();
		};
		_internals.platform = () => 'linux';
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		await expect(resolveGitExecutableAsync()).resolves.toBe('git');
		// One yield per probed candidate — 3 linux platform candidates. The
		// all-rejected cycle still runs to completion (and still yields between
		// every probe) before falling back to the bare name.
		expect(yieldCalls).toBe(3);
	});

	test('concurrent callers share a single in-flight probe cycle', async () => {
		let probeCycles = 0;
		_internals.platform = () => {
			probeCycles++;
			return 'linux';
		};
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		const [a, b] = await Promise.all([
			resolveGitExecutableAsync(),
			resolveGitExecutableAsync(),
		]);
		// Both callers get the same bare fallback out of ONE shared cycle —
		// `platform()` (and therefore `buildCandidates`) ran exactly once.
		expect(a).toBe('git');
		expect(b).toBe('git');
		expect(probeCycles).toBe(1);
	});

	test('resolves the same absolute path as the sync entry point on success', async () => {
		const gitPath = writeFixture('async-success').candidate;
		simulateFixturePlatform();
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		await expect(resolveGitExecutableAsync()).resolves.toBe(gitPath);
	});
});

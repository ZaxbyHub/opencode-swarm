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
import * as os from 'node:os';
import * as path from 'node:path';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { GitBinaryMissingError } from '../../../src/utils/git-binary-missing-error';
import {
	_internals,
	describeGitResolution,
	GIT_BINARY_ENV_VAR,
	resetGitExecutableCache,
	resolveGitExecutable,
	resolveGitExecutableAsync,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';

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
		output: [null, Buffer.from(''), Buffer.from('')],
		stdout: Buffer.from(''),
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
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-exec-override-'));
});
afterEach(() => {
	restoreInternals();
	resetGitExecutableCache();
	setGitBinaryOverride(undefined);
	clearDeferredWarnings();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAcceptedBinary(name: string): string {
	const dir = fs.mkdtempSync(path.join(tmpDir, `${name}-`));
	const binPath = path.join(dir, 'git.exe');
	fs.writeFileSync(binPath, 'stub');
	return binPath;
}

describe('git-executable — override precedence', () => {
	test('env override wins over config override', () => {
		const envGit = writeAcceptedBinary('env');
		const configGit = writeAcceptedBinary('config');
		setGitBinaryOverride(configGit);

		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: envGit, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === envGit || cmd === configGit
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expect(resolveGitExecutable()).toBe(envGit);
	});

	test('config override is used when no env override is set', () => {
		const configGit = writeAcceptedBinary('config');
		setGitBinaryOverride(configGit);

		_internals.platform = () => 'win32';
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === configGit ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expect(resolveGitExecutable()).toBe(configGit);
	});

	test('platform candidate wins over a PATH candidate when both are valid', () => {
		const programFilesDir = path.join(tmpDir, 'ProgramFiles');
		fs.mkdirSync(path.join(programFilesDir, 'Git', 'cmd'), { recursive: true });
		const platformGit = path.join(programFilesDir, 'Git', 'cmd', 'git.exe');
		fs.writeFileSync(platformGit, 'stub');

		const pathDir = path.join(tmpDir, 'PathBin');
		fs.mkdirSync(pathDir, { recursive: true });
		const pathGit = path.join(pathDir, 'git.exe');
		fs.writeFileSync(pathGit, 'stub');

		_internals.platform = () => 'win32';
		_internals.env = () => ({ ProgramFiles: programFilesDir, PATH: pathDir });
		_internals.spawnSync = (cmd) =>
			cmd === platformGit || cmd === pathGit
				? fakeSpawnResult({ status: 0 })
				: enoentResult();

		expect(resolveGitExecutable()).toBe(platformGit);
	});

	test('PATH candidate wins when no platform candidate is valid', () => {
		const pathDir = path.join(tmpDir, 'PathBin');
		fs.mkdirSync(pathDir, { recursive: true });
		const pathGit = path.join(pathDir, 'git.exe');
		fs.writeFileSync(pathGit, 'stub');

		_internals.platform = () => 'win32';
		// ProgramFiles points at a real, empty directory — the constructed
		// Git\cmd\git.exe / Git\bin\git.exe candidates do not exist.
		_internals.env = () => ({ ProgramFiles: tmpDir, PATH: pathDir });
		_internals.spawnSync = (cmd) =>
			cmd === pathGit ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expect(resolveGitExecutable()).toBe(pathGit);
	});
});

describe('git-executable — invalid override (F4 carry-forward item i)', () => {
	test('a relative-path override is skipped with a warning and resolution falls through', () => {
		const pathGit = writeAcceptedBinary('fallback');
		const pathDir = path.dirname(pathGit);

		_internals.platform = () => 'win32';
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: 'relative\\git.exe',
			PATH: pathDir,
		});
		_internals.spawnSync = (cmd) =>
			cmd === pathGit ? fakeSpawnResult({ status: 0 }) : enoentResult();

		const resolved = resolveGitExecutable();
		expect(resolved).toBe(pathGit);

		const { attempts } = describeGitResolution();
		const overrideAttempt = attempts.find((a) => a.source === 'override');
		expect(overrideAttempt?.reason).toBe('not an absolute path');
		expect(
			getDeferredWarnings().some((w) => w.includes('relative\\git.exe')),
		).toBe(true);
	});

	test('a nonexistent override is skipped with a warning and resolution falls through', () => {
		const pathGit = writeAcceptedBinary('fallback');
		const pathDir = path.dirname(pathGit);
		const missingOverride = path.join(
			tmpDir,
			'nonexistent-override',
			'git.exe',
		);

		_internals.platform = () => 'win32';
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: missingOverride,
			PATH: pathDir,
		});
		_internals.spawnSync = (cmd) =>
			cmd === pathGit ? fakeSpawnResult({ status: 0 }) : enoentResult();

		const resolved = resolveGitExecutable();
		expect(resolved).toBe(pathGit);
		expect(getDeferredWarnings().some((w) => w.includes(missingOverride))).toBe(
			true,
		);
	});

	test('an override that fails the git --version probe is skipped with a warning and falls through', () => {
		const brokenOverride = path.join(tmpDir, 'broken-git.exe');
		fs.writeFileSync(brokenOverride, 'stub');
		const pathGit = writeAcceptedBinary('fallback');
		const pathDir = path.dirname(pathGit);

		_internals.platform = () => 'win32';
		_internals.env = () => ({
			[GIT_BINARY_ENV_VAR]: brokenOverride,
			PATH: pathDir,
		});
		_internals.spawnSync = (cmd) => {
			if (cmd === brokenOverride) return fakeSpawnResult({ status: 1 });
			if (cmd === pathGit) return fakeSpawnResult({ status: 0 });
			return enoentResult();
		};

		const resolved = resolveGitExecutable();
		expect(resolved).toBe(pathGit);
		expect(getDeferredWarnings().some((w) => w.includes(brokenOverride))).toBe(
			true,
		);
	});

	test('a bad override never permanently wins even though it is candidate #1', () => {
		// Regression guard for the "silently wins" failure mode named in the
		// approved plan: an unusable override must not make a working host
		// unreachable.
		const pathGit = writeAcceptedBinary('fallback');
		const pathDir = path.dirname(pathGit);
		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: '', PATH: pathDir });
		_internals.spawnSync = (cmd) =>
			cmd === pathGit ? fakeSpawnResult({ status: 0 }) : enoentResult();

		// Empty string override is normalized to "unset" — resolves via PATH.
		expect(resolveGitExecutable()).toBe(pathGit);
	});
});

describe('git-executable — setGitBinaryOverride cache semantics', () => {
	test('resets the cache only when the value actually changes', () => {
		const gitPath = writeAcceptedBinary('cfg');
		setGitBinaryOverride(gitPath);

		_internals.platform = () => 'win32';
		_internals.env = () => ({ PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expect(resolveGitExecutable()).toBe(gitPath);
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

		expect(() => resolveGitExecutable()).toThrow(GitBinaryMissingError);
		expect(platformCalls).toBe(1);

		simulatedNow = 59_000; // before the 60s TTL
		expect(() => resolveGitExecutable()).toThrow(GitBinaryMissingError);
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

		expect(() => resolveGitExecutable()).toThrow(GitBinaryMissingError);
		expect(platformCalls).toBe(1);

		simulatedNow = 61_000; // after the 60s TTL
		expect(() => resolveGitExecutable()).toThrow(GitBinaryMissingError);
		expect(platformCalls).toBe(2); // a fresh probe cycle ran
	});

	test('a successful resolution is NOT subject to the negative-cache TTL', () => {
		const gitPath = writeAcceptedBinary('success');
		let simulatedNow = 0;
		_internals.now = () => simulatedNow;
		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		expect(resolveGitExecutable()).toBe(gitPath);
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

		await expect(resolveGitExecutableAsync()).rejects.toBeInstanceOf(
			GitBinaryMissingError,
		);
		// One yield per probed candidate — 3 linux platform candidates.
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

		const [a, b] = await Promise.allSettled([
			resolveGitExecutableAsync(),
			resolveGitExecutableAsync(),
		]);
		expect(a.status).toBe('rejected');
		expect(b.status).toBe('rejected');
		expect(probeCycles).toBe(1);
	});

	test('resolves the same absolute path as the sync entry point on success', async () => {
		const gitPath = writeAcceptedBinary('async-success');
		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		await expect(resolveGitExecutableAsync()).resolves.toBe(gitPath);
	});
});

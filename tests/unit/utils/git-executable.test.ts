/**
 * Core resolver behavior for src/utils/git-executable.ts (issue #2236
 * hardening — F1/F5). See git-executable-override.test.ts for precedence,
 * invalid-override, TTL, budget, and async-yield coverage.
 *
 * Platform/env are driven entirely through the `_internals` seam so the
 * POSIX (darwin/linux) branches actually execute on this Windows test host
 * — never gated behind `if (isWindows) return`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import {
	_internals,
	describeGitResolution,
	GIT_BINARY_ENV_VAR,
	resetGitExecutableCache,
	resolveGitExecutable,
	setGitBinaryOverride,
} from '../../../src/utils/git-executable';
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

// This describe block MUST run first in this file (bun:test executes
// describe/test blocks in declaration order) — it asserts on state left
// over from pure module import, before any other test in this file has
// called a resolver function or mutated `_internals`.
describe('git-executable — lazy load (AGENTS.md invariant 1)', () => {
	test('describeGitResolution reports an idle state immediately after import', () => {
		// tests/preload/executable-resolver-pin.ts seeds the resolver cache
		// with a synthetic 'git' success entry for every test file (FR-006
		// ratchet fix — see that file for why). That is a TEST-INFRA artifact,
		// not module import-time behavior, so undo it here via the same
		// `resetGitExecutableCache()` every other describe block below uses,
		// before asserting the invariant this test actually cares about: the
		// module itself never eagerly resolves anything on its own.
		resetGitExecutableCache();
		const description = describeGitResolution();
		expect(description.attempts).toEqual([]);
		expect(description.resolved).toBe(false);
		expect(description.resolvedPath).toBeUndefined();
	});

	test('_internals.spawnSync has not been invoked by anything at import time', () => {
		let calls = 0;
		const original = _internals.spawnSync;
		_internals.spawnSync = ((...args: Parameters<typeof original>) => {
			calls++;
			return original(...args);
		}) as typeof original;
		try {
			expect(calls).toBe(0);
		} finally {
			_internals.spawnSync = original;
		}
	});
});

describe('git-executable — candidate ordering', () => {
	beforeEach(() => {
		resetGitExecutableCache();
		setGitBinaryOverride(undefined);
		clearDeferredWarnings();
		// Deterministic default: reject everything unless a test overrides
		// this, so hardcoded candidate paths that happen to coincide with a
		// real install on the host machine cannot flip a test green/red.
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });
	});
	afterEach(() => {
		restoreInternals();
		resetGitExecutableCache();
		setGitBinaryOverride(undefined);
		clearDeferredWarnings();
	});

	test('darwin: homebrew-first platform candidate order', () => {
		_internals.platform = () => 'darwin';
		_internals.env = () => ({ PATH: '' });

		// Every candidate is rejected, so resolution falls through to the
		// unprobed bare name (BL-1) — but it still probed them IN ORDER, which
		// is what this test pins.
		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		expect(attempts.map((a) => a.candidate)).toEqual([
			'/opt/homebrew/bin/git',
			'/usr/local/bin/git',
			'/usr/bin/git',
		]);
		expect(attempts.every((a) => a.source === 'platform')).toBe(true);
	});

	test('linux: platform candidate order', () => {
		_internals.platform = () => 'linux';
		_internals.env = () => ({ PATH: '' });

		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		expect(attempts.map((a) => a.candidate)).toEqual([
			'/usr/bin/git',
			'/usr/local/bin/git',
			'/bin/git',
		]);
	});

	test('win32: ProgramFiles / ProgramFiles(x86) / LOCALAPPDATA candidates, cmd before bin', () => {
		_internals.platform = () => 'win32';
		_internals.env = () => ({
			PATH: '',
			ProgramFiles: 'C:\\Program Files',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
			LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
		});

		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		expect(attempts.map((a) => a.candidate)).toEqual([
			'C:\\Program Files\\Git\\cmd\\git.exe',
			'C:\\Program Files\\Git\\bin\\git.exe',
			'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
			'C:\\Program Files (x86)\\Git\\bin\\git.exe',
			'C:\\Users\\test\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
			'C:\\Users\\test\\AppData\\Local\\Programs\\Git\\bin\\git.exe',
		]);
	});

	test('PATH candidates: every PATH entry is scanned, not just the first match', () => {
		_internals.platform = () => 'linux';
		_internals.env = () => ({ PATH: ['/a', '/b', '/c'].join(':') });

		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		const pathAttempts = attempts.filter((a) => a.source === 'path');
		expect(pathAttempts.map((a) => a.candidate)).toEqual([
			'/a/git',
			'/b/git',
			'/c/git',
		]);
	});

	test('bare "git" is never itself probed as a candidate', () => {
		_internals.platform = () => 'linux';
		_internals.env = () => ({ PATH: '' });

		// The bare name is what resolution RETURNS, and it is never itself a
		// probed candidate — nothing ever spawned a --version check against a
		// slash-less name, which is precisely why its success cannot be
		// predicted from this attempt list (BL-1).
		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		// Guard against a vacuous pass: candidates really were probed.
		expect(attempts.length).toBeGreaterThan(0);
		expect(attempts.some((a) => a.candidate === 'git')).toBe(false);
	});

	test('empty candidate list (win32, no env hints) falls back to the bare name and reports itself unresolved', () => {
		_internals.platform = () => 'win32';
		_internals.env = () => ({});

		// Zero enumerable candidates is NOT evidence that git is missing —
		// nothing was probed at all. Returning the bare name keeps a host whose
		// git resolves through the runtime's own PATH lookup working (BL-1).
		expect(resolveGitExecutable()).toBe('git');

		const description = describeGitResolution();
		expect(description.attempts).toEqual([]);
		// Deliberate asymmetry, pinned here so nobody "fixes" it later:
		// resolution returned a usable value, yet `resolved` is false because
		// nothing was VALIDATED. That honesty is what makes gitExec's "No
		// candidate probe results are recorded for this process" diagnostic
		// correct — see tests/unit/git/branch.gitexec-spawn-cwd-2236.test.ts.
		expect(description.resolved).toBe(false);
		expect(description.resolvedPath).toBeUndefined();
	});
});

describe('git-executable — probe validation', () => {
	let tmpDir: string;

	beforeEach(() => {
		resetGitExecutableCache();
		setGitBinaryOverride(undefined);
		clearDeferredWarnings();
		tmpDir = canonicalMkdtemp('git-exec-probe-');
	});
	afterEach(() => {
		restoreInternals();
		resetGitExecutableCache();
		setGitBinaryOverride(undefined);
		clearDeferredWarnings();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('rejects a candidate that exists but exits non-zero (xcode-select shim case)', () => {
		const shimPath = path.join(tmpDir, 'git');
		fs.writeFileSync(shimPath, '#!/bin/sh\nexit 1\n');

		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: shimPath, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === shimPath
				? fakeSpawnResult({
						status: 1,
						stderr: Buffer.from('xcrun: error: invalid active developer path'),
					})
				: enoentResult();

		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		const shimAttempt = attempts.find((a) => a.candidate === shimPath);
		expect(shimAttempt?.accepted).toBe(false);
		expect(shimAttempt?.reason).toContain('exit 1');
	});

	test('accepts a candidate that passes the git --version probe', () => {
		const gitPath = path.join(tmpDir, 'git');
		fs.writeFileSync(gitPath, 'binary-stub');

		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		_internals.spawnSync = (cmd) =>
			cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();

		const resolved = resolveGitExecutable();
		expect(resolved).toBe(gitPath);

		const description = describeGitResolution();
		expect(description.resolved).toBe(true);
		expect(description.resolvedPath).toBe(gitPath);
	});

	test('rejects a directory candidate as "is a directory"', () => {
		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: tmpDir, PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		const overrideAttempt = attempts.find((a) => a.source === 'override');
		expect(overrideAttempt?.reason).toBe('is a directory');
	});

	test('rejects a nonexistent candidate as "no such file"', () => {
		const missingPath = path.join(tmpDir, 'does-not-exist', 'git');
		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: missingPath, PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		expect(resolveGitExecutable()).toBe('git');
		const { attempts } = describeGitResolution();
		const overrideAttempt = attempts.find((a) => a.source === 'override');
		expect(overrideAttempt?.reason).toBe('no such file');
	});

	test('successful resolution is memoized for the process lifetime', () => {
		const gitPath = path.join(tmpDir, 'git');
		fs.writeFileSync(gitPath, 'binary-stub');

		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		let calls = 0;
		_internals.spawnSync = (cmd) => {
			calls++;
			return cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();
		};

		const first = resolveGitExecutable();
		const callsAfterFirst = calls;
		const second = resolveGitExecutable();
		expect(second).toBe(first);
		expect(calls).toBe(callsAfterFirst);
	});

	test('resetGitExecutableCache forces a fresh probe cycle', () => {
		const gitPath = path.join(tmpDir, 'git');
		fs.writeFileSync(gitPath, 'binary-stub');

		_internals.platform = () => 'win32';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: gitPath, PATH: '' });
		let calls = 0;
		_internals.spawnSync = (cmd) => {
			calls++;
			return cmd === gitPath ? fakeSpawnResult({ status: 0 }) : enoentResult();
		};

		resolveGitExecutable();
		const callsAfterFirst = calls;
		resetGitExecutableCache();
		expect(describeGitResolution().resolved).toBe(false);

		resolveGitExecutable();
		expect(calls).toBeGreaterThan(callsAfterFirst);
	});

	test('records the full actionable diagnostic — every candidate and the rejected override — while still falling back to the bare name', () => {
		// POSIX-shaped on purpose: the simulated platform is linux, and a
		// Windows-shaped path would be rejected as "not an absolute path"
		// before the stat ever runs, quietly testing the wrong branch on this
		// Windows host. Absent on every host, asserted rather than assumed.
		const overridePath = '/opencode-swarm-2236-absent/does-not-exist/git';
		expect(fs.existsSync(overridePath)).toBe(false);
		_internals.platform = () => 'linux';
		_internals.env = () => ({ [GIT_BINARY_ENV_VAR]: overridePath, PATH: '' });
		_internals.spawnSync = () => fakeSpawnResult({ status: 1 });

		// The diagnostic is no longer carried by an exception from THIS layer
		// (BL-1: throwing here declared git missing on hosts where it works).
		// It is the data recorded below, which gitExec renders into the
		// GitBinaryMissingError it throws when the SPAWN fails. That rendering
		// — candidate lines, override note, and the "... and N more" cap — is
		// asserted in tests/unit/git/branch.gitexec-spawn-cwd-2236.test.ts.
		// This test guarantees the renderer is fed a complete input.
		expect(resolveGitExecutable()).toBe('git');

		const description = describeGitResolution();
		expect(description.attempts.map((a) => a.candidate)).toEqual([
			overridePath,
			'/usr/bin/git',
			'/usr/local/bin/git',
			'/bin/git',
		]);
		expect(description.attempts.every((a) => a.accepted === false)).toBe(true);
		expect(
			description.attempts.find((a) => a.source === 'override')?.reason,
		).toBe('no such file');
		expect(description.overrideValue).toBe(overridePath);
		expect(description.overrideSource).toBe('env');
		// A usable value came back, yet nothing was validated — see the
		// empty-candidate-list test above for why that asymmetry is deliberate.
		expect(description.resolved).toBe(false);
		expect(description.resolvedPath).toBeUndefined();
	});
});

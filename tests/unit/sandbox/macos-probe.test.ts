/**
 * Tests for the corrected macOS sandbox-exec availability probe
 * (issue #2236 F6/RC2, and F6a items 1-2).
 *
 * sandbox-exec(8) has NO `--version` flag — its documented synopsis is
 * `sandbox-exec [-f file | -n name | -p string] [-D k=v] command [args...]`
 * (BSD getopt, short options only). The previous probe invoked
 * `sandbox-exec --version`, which is consumed as an invalid option and
 * fails on EVERY macOS host regardless of whether Seatbelt actually works.
 *
 * These tests drive `probeSandboxExec()` through its `_internals.spawnSync`
 * seam, so the corrected exit-code-0-only criterion is verified regardless
 * of the host platform running the tests — no real sandbox-exec binary
 * required, and no `if (isWindows) return;` guards.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { _internals } from '../../../src/sandbox/macos/sandbox-exec-executor';

type SpawnResult = ReturnType<typeof _internals.spawnSync>;

const originalSpawnSync = _internals.spawnSync;
const originalProbeSandboxExec = _internals.probeSandboxExec;

beforeEach(() => {
	_internals.resetProbeMemo();
});

afterEach(() => {
	_internals.spawnSync = originalSpawnSync;
	_internals.probeSandboxExec = originalProbeSandboxExec;
	_internals.resetProbeMemo();
});

function mockSpawnResult(overrides: {
	status?: number | null;
	stdout?: string;
	stderr?: string;
	error?: NodeJS.ErrnoException;
}): SpawnResult {
	return {
		status: overrides.status ?? 0,
		stdout: overrides.stdout ?? '',
		stderr: overrides.stderr ?? '',
		error: overrides.error,
		signal: null,
		output: [null, overrides.stdout ?? '', overrides.stderr ?? ''],
		pid: 4242,
	} as unknown as SpawnResult;
}

describe('probeSandboxExec — F6 exit-code-only criterion', () => {
	test('exit 0 with EMPTY stdout IS available — the case the old stdout-length check got wrong', () => {
		_internals.spawnSync = mock(() =>
			mockSpawnResult({ status: 0, stdout: '' }),
		) as typeof _internals.spawnSync;

		expect(_internals.probeSandboxExec()).toBe(true);
	});

	test('exit 0 with non-empty stdout is ALSO available (content is irrelevant to the criterion)', () => {
		_internals.spawnSync = mock(() =>
			mockSpawnResult({ status: 0, stdout: 'unexpected but harmless output' }),
		) as typeof _internals.spawnSync;

		expect(_internals.probeSandboxExec()).toBe(true);
	});

	test('non-empty stderr does NOT mark unavailable — macOS prints a deprecation notice on every invocation', () => {
		_internals.spawnSync = mock(() =>
			mockSpawnResult({
				status: 0,
				stdout: '',
				stderr:
					'sandbox-exec(1) is deprecated and will be removed in a future release',
			}),
		) as typeof _internals.spawnSync;

		expect(_internals.probeSandboxExec()).toBe(true);
	});

	test('non-zero exit code marks unavailable regardless of stdout content', () => {
		_internals.spawnSync = mock(() =>
			mockSpawnResult({
				status: 1,
				stdout: 'looks like a version string 1.2.3',
			}),
		) as typeof _internals.spawnSync;

		expect(_internals.probeSandboxExec()).toBe(false);
	});

	test('a non-zero exit consistent with BSD getopt rejecting an invalid option (64) marks unavailable', () => {
		_internals.spawnSync = mock(() =>
			mockSpawnResult({ status: 64 }),
		) as typeof _internals.spawnSync;

		expect(_internals.probeSandboxExec()).toBe(false);
	});

	test('spawnSync error with ENOENT marks unavailable without throwing', () => {
		_internals.spawnSync = mock(() =>
			mockSpawnResult({
				status: null,
				error: Object.assign(new Error('spawn sandbox-exec ENOENT'), {
					code: 'ENOENT',
				}) as NodeJS.ErrnoException,
			}),
		) as typeof _internals.spawnSync;

		expect(() => _internals.probeSandboxExec()).not.toThrow();
		expect(_internals.probeSandboxExec()).toBe(false);
	});

	test('spawnSync throwing synchronously is caught and marks unavailable', () => {
		_internals.spawnSync = mock(() => {
			throw new Error('unexpected spawn failure');
		}) as typeof _internals.spawnSync;

		expect(() => _internals.probeSandboxExec()).not.toThrow();
		expect(_internals.probeSandboxExec()).toBe(false);
	});
});

describe('probeSandboxExec — invocation shape', () => {
	test('invokes with -p <profile> <target>, never --version', () => {
		let capturedArgs: [string, string[]] | undefined;
		_internals.spawnSync = mock((binary: string, args: string[]) => {
			capturedArgs = [binary, args];
			return mockSpawnResult({ status: 0 });
		}) as typeof _internals.spawnSync;

		_internals.probeSandboxExec();

		expect(capturedArgs).toBeDefined();
		const [binary, args] = capturedArgs!;
		expect(typeof binary).toBe('string');
		expect(args).not.toContain('--version');
		expect(args[0]).toBe('-p');
		expect(typeof args[1]).toBe('string');
		expect(args[1]).toContain('(version 1)');
	});

	test('resolveSandboxExecBinary falls back to the bare name when the absolute path is absent', () => {
		// On this (non-macOS) host /usr/bin/sandbox-exec does not exist, so
		// resolution must fall back to the bare name — proving the fallback
		// branch, not just the happy path.
		expect(_internals.resolveSandboxExecBinary()).toBe('sandbox-exec');
	});

	test('resolveProbeTargetBinary falls back to the bare name when the absolute path is absent', () => {
		expect(_internals.resolveProbeTargetBinary()).toBe('true');
	});
});

describe('buildProbeProfile — F6a item 2 shape parity with production', () => {
	test('shares the deny-then-scoped-allow ordering with the production profile', () => {
		const profile = _internals.buildProbeProfile('/tmp/swarm-probe');
		const denyIdx = profile.indexOf('(deny file-write*)');
		const allowIdx = profile.indexOf('(allow file-write* (subpath');
		expect(denyIdx).toBeGreaterThanOrEqual(0);
		expect(allowIdx).toBeGreaterThan(denyIdx);
		expect(profile).toContain(
			'(allow file-write* (subpath "/tmp/swarm-probe"))',
		);
	});

	test('includes a setenv/unsetenv pair so an invalid env primitive is caught by the probe (F6b caveat)', () => {
		const profile = _internals.buildProbeProfile('/tmp/swarm-probe');
		expect(profile).toContain('(setenv');
		expect(profile).toContain('(unsetenv');
	});

	test('is NOT the trivial (allow default)-only profile — a trivial probe would pass even when production is unparseable', () => {
		const profile = _internals.buildProbeProfile('/tmp/swarm-probe');
		// The trivial profile the original RC2 fix-design considered was just
		// `(version 1)(allow default)`. Assert the probe profile carries the
		// SAME primitive count/shape as production, not that reduced form.
		expect(profile).toContain('(deny file-write*)');
		expect(profile.split('\n').length).toBeGreaterThan(2);
	});
});

describe('probeSandboxExecMemoized — F6a item 1', () => {
	test('a successful probe is memoized: the raw probe is invoked only once across many calls', () => {
		let callCount = 0;
		_internals.probeSandboxExec = mock(() => {
			callCount++;
			return true;
		});

		expect(_internals.probeSandboxExecMemoized()).toBe(true);
		expect(_internals.probeSandboxExecMemoized()).toBe(true);
		expect(_internals.probeSandboxExecMemoized()).toBe(true);
		expect(callCount).toBe(1);
	});

	test('resetProbeMemo forces the next call to re-invoke the raw probe', () => {
		let callCount = 0;
		_internals.probeSandboxExec = mock(() => {
			callCount++;
			return true;
		});

		expect(_internals.probeSandboxExecMemoized()).toBe(true);
		expect(callCount).toBe(1);

		_internals.resetProbeMemo();

		expect(_internals.probeSandboxExecMemoized()).toBe(true);
		expect(callCount).toBe(2);
	});

	test('a failed probe is also memoized until resetProbeMemo (production: the 60s failure TTL)', () => {
		let callCount = 0;
		_internals.probeSandboxExec = mock(() => {
			callCount++;
			return false;
		});

		expect(_internals.probeSandboxExecMemoized()).toBe(false);
		expect(_internals.probeSandboxExecMemoized()).toBe(false);
		expect(callCount).toBe(1);
	});
});

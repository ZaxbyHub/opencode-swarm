/**
 * Tests for the macOS sandbox-exec env hardening (issue #2236 F6b).
 *
 * `getEnvOverrides()` was declared on `SandboxExecutor` and implemented by
 * `MacOSSandboxExecutor`, but had ZERO production callers — the DYLD
 * injection-variable stripping it declares (DYLD_INSERT_LIBRARIES,
 * DYLD_LIBRARY_PATH, DYLD_FRAMEWORK_PATH, DYLD_ROOT_PATH -> null, plus
 * PATH -> the base-OS bin dirs) had never actually been applied to a
 * sandboxed command. This file covers `MacOSSandboxExecutor`'s own
 * getEnvOverrides() shape and its command-level application inside the
 * wrapped command (`buildEnvOverridePrefix` / `wrapCommand`'s 4th parameter
 * — issue #2590: SBPL cannot mutate the sandboxed process's environment, so
 * the overrides ride the inner shell instead of the profile). The wiring at
 * the `applySandboxExecution` call site (macOS-only gate by `mechanism`) is
 * covered separately in
 * tests/unit/hooks/guardrails-sandbox-env-wiring.test.ts.
 *
 * Seam-driven: process.platform is overridden to 'darwin' via the
 * established Object.defineProperty pattern (see
 * tests/unit/config/cache-paths.test.ts) and _internals.probeSandboxExec is
 * mocked, so MacOSSandboxExecutor's real logic is exercised regardless of
 * the host platform running the tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	MacOSSandboxExecutor,
} from '../../../src/sandbox/macos/sandbox-exec-executor';

const originalPlatform = process.platform;
const originalProbeSandboxExec = _internals.probeSandboxExec;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
	Object.defineProperty(process, 'platform', {
		value: originalPlatform,
		configurable: true,
	});
}

beforeEach(() => {
	setPlatform('darwin');
	_internals.probeSandboxExec = mock(() => true);
	_internals.resetProbeMemo();
});

afterEach(() => {
	restorePlatform();
	_internals.probeSandboxExec = originalProbeSandboxExec;
	_internals.resetProbeMemo();
});

describe('MacOSSandboxExecutor.getEnvOverrides() — F6b shape', () => {
	test('unsets all five DYLD injection variables', () => {
		const executor = new MacOSSandboxExecutor([]);
		const env = executor.getEnvOverrides();
		expect(env.DYLD_INSERT_LIBRARIES).toBeNull();
		expect(env.DYLD_LIBRARY_PATH).toBeNull();
		expect(env.DYLD_FRAMEWORK_PATH).toBeNull();
		expect(env.DYLD_ROOT_PATH).toBeNull();
		expect(env.DYLD_FORCE_FLAT_NAMESPACE).toBeNull();
	});

	test('sets PATH to the base-OS bin dirs only', () => {
		const executor = new MacOSSandboxExecutor([]);
		const env = executor.getEnvOverrides();
		expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
	});

	test('returns exactly six keys — no unexpected additions', () => {
		const executor = new MacOSSandboxExecutor([]);
		const env = executor.getEnvOverrides();
		expect(Object.keys(env).sort()).toEqual(
			[
				'DYLD_FORCE_FLAT_NAMESPACE',
				'DYLD_FRAMEWORK_PATH',
				'DYLD_INSERT_LIBRARIES',
				'DYLD_LIBRARY_PATH',
				'DYLD_ROOT_PATH',
				'PATH',
			].sort(),
		);
	});
});

describe('wrapCommand() env overrides — command-level application (issue #2590)', () => {
	test('wrapCommand accepts getEnvOverrides() output as its 4th parameter without throwing', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const env = executor.getEnvOverrides();
		expect(() =>
			executor.wrapCommand('echo hello', [], undefined, env),
		).not.toThrow();
	});

	test('the wrapped command still resolves through sandbox-exec when env overrides are supplied', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const env = executor.getEnvOverrides();
		const result = executor.wrapCommand('echo hello', [], undefined, env);
		expect(result).toContain('sandbox-exec');
		expect(result).toContain('-f');
	});

	test('the DYLD_* unsets and the PATH pin are applied by the inner shell BEFORE the user command', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const env = executor.getEnvOverrides();
		const wrapped = executor.wrapCommand('echo hello', [], undefined, env);

		// One `unset` builtin covering all five DYLD injection variables...
		expect(wrapped).toContain(
			'unset DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_ROOT_PATH DYLD_FORCE_FLAT_NAMESPACE',
		);
		// ...and an export pinning PATH to the base-OS bin dirs. The value is
		// single-quote-escaped for the outer bash -c context, so assert the
		// assignment and the verbatim value separately.
		expect(wrapped).toContain('export PATH=');
		expect(wrapped).toContain('/usr/bin:/bin:/usr/sbin:/sbin');
		// Env ops run BEFORE the user command.
		expect(wrapped.indexOf('unset DYLD_INSERT_LIBRARIES')).toBeLessThan(
			wrapped.indexOf('echo hello'),
		);
	});

	test('buildSandboxProfile contains NO env directives for the F6b overrides (issue #2590)', () => {
		// envOverrides is no longer a buildSandboxProfile parameter — the
		// 2-arg call below is the compile-checked contract. The profile must
		// never carry env directives: SBPL has no setenv/unsetenv ops and
		// emitting them made the profile unparseable (#2590).
		const profile = _internals.buildSandboxProfile(['/scope'], '/tmp');
		expect(profile).not.toContain('setenv');
		expect(profile).not.toContain('unsetenv');
	});

	test('getEnvOverrides() round-trips through wrapCommand to the inner-shell prefix', () => {
		const executor = new MacOSSandboxExecutor([], '/tmp');
		const env = executor.getEnvOverrides();
		const wrapped = executor.wrapCommand('echo hello', [], undefined, env);
		// One `unset` builtin covers all five DYLD keys, in getEnvOverrides()
		// insertion order; PATH is exported right after.
		expect(wrapped).toContain(
			'unset DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_ROOT_PATH DYLD_FORCE_FLAT_NAMESPACE',
		);
		expect(wrapped).toContain('export PATH=');
	});

	test('no-override wrapCommand output carries no env ops (byte-shape preserved)', () => {
		const executor = new MacOSSandboxExecutor(['/scope'], '/tmp');
		const wrapped = executor.wrapCommand(
			'echo hello',
			[],
			undefined,
			undefined,
		);
		expect(wrapped).not.toContain('unset ');
		expect(wrapped).not.toContain('export ');
		expect(wrapped).toContain('sandbox-exec');
	});
});

describe('buildEnvOverridePrefix — direct unit tests (PR #2630 review PRR-007)', () => {
	test('undefined and empty overrides produce an empty prefix', () => {
		expect(_internals.buildEnvOverridePrefix(undefined)).toBe('');
		expect(_internals.buildEnvOverridePrefix({})).toBe('');
	});

	test('null-valued keys group into one unset builtin ordered before exports', () => {
		const prefix = _internals.buildEnvOverridePrefix({
			AAA_SET: '1',
			BBB_UNSET: null,
		});
		expect(prefix).toBe("unset BBB_UNSET; export AAA_SET='1'; ");
		expect(prefix.indexOf('unset')).toBeLessThan(prefix.indexOf('export'));
	});

	test('values are single-quote-escaped for the outer bash -c context', () => {
		expect(_internals.buildEnvOverridePrefix({ K: "it's" })).toBe(
			"export K='it'\\''s'; ",
		);
	});

	test('invalid keys are dropped silently', () => {
		expect(_internals.buildEnvOverridePrefix({ 'BAD;KEY': 'v' })).toBe('');
		expect(
			_internals.buildEnvOverridePrefix({ 'BAD;KEY': 'v', OK_KEY: 'kept' }),
		).toBe("export OK_KEY='kept'; ");
	});
});

// NOTE (not test-automatable from this host): the assertions above prove the
// env overrides are correctly shaped, ordered, and escaped inside the wrapped
// command string, and that no profile carries env directives (#2590). They
// cannot prove a live sandbox-exec-wrapped child on real macOS hardware
// actually observes the DYLD variables unset — that requires spawning the
// child on macOS and inspecting its environment, which is not reproducible
// here. This remains an on-host verification item (trace NE1), recorded in the
// PR report rather than papered over with a placeholder assertion.

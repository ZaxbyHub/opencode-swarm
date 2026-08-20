/**
 * Tests for the macOS sandbox-exec env hardening (issue #2236 F6b).
 *
 * `getEnvOverrides()` was declared on `SandboxExecutor` and implemented by
 * `MacOSSandboxExecutor`, but had ZERO production callers — the DYLD
 * injection-variable stripping it declares (DYLD_INSERT_LIBRARIES,
 * DYLD_LIBRARY_PATH, DYLD_FRAMEWORK_PATH, DYLD_ROOT_PATH -> null, plus
 * PATH -> the base-OS bin dirs) had never actually been applied to a
 * sandboxed command. This file covers `MacOSSandboxExecutor`'s own
 * getEnvOverrides() shape and its SBPL (setenv)/(unsetenv) emission through
 * `buildSandboxProfile`/`wrapCommand`'s 4th parameter — the wiring at the
 * `applySandboxExecution` call site (macOS-only gate by `mechanism`) is
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
	test('unsets all four DYLD injection variables', () => {
		const executor = new MacOSSandboxExecutor([]);
		const env = executor.getEnvOverrides();
		expect(env.DYLD_INSERT_LIBRARIES).toBeNull();
		expect(env.DYLD_LIBRARY_PATH).toBeNull();
		expect(env.DYLD_FRAMEWORK_PATH).toBeNull();
		expect(env.DYLD_ROOT_PATH).toBeNull();
	});

	test('sets PATH to the base-OS bin dirs only', () => {
		const executor = new MacOSSandboxExecutor([]);
		const env = executor.getEnvOverrides();
		expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
	});

	test('returns exactly five keys — no unexpected additions', () => {
		const executor = new MacOSSandboxExecutor([]);
		const env = executor.getEnvOverrides();
		expect(Object.keys(env).sort()).toEqual(
			[
				'DYLD_FRAMEWORK_PATH',
				'DYLD_INSERT_LIBRARIES',
				'DYLD_LIBRARY_PATH',
				'DYLD_ROOT_PATH',
				'PATH',
			].sort(),
		);
	});
});

describe('wrapCommand() env overrides — SBPL emission through buildSandboxProfile (F6b)', () => {
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

	test('buildSandboxProfile emits (unsetenv DYLD_*) for every null-valued F6b override', () => {
		const env = {
			DYLD_INSERT_LIBRARIES: null,
			DYLD_LIBRARY_PATH: null,
			DYLD_FRAMEWORK_PATH: null,
			DYLD_ROOT_PATH: null,
			PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
		};
		const profile = _internals.buildSandboxProfile(['/scope'], '/tmp', env);

		expect(profile).toContain('(unsetenv DYLD_INSERT_LIBRARIES)');
		expect(profile).toContain('(unsetenv DYLD_LIBRARY_PATH)');
		expect(profile).toContain('(unsetenv DYLD_FRAMEWORK_PATH)');
		expect(profile).toContain('(unsetenv DYLD_ROOT_PATH)');
	});

	test('buildSandboxProfile emits (setenv PATH "...") for the F6b PATH override', () => {
		const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
		const profile = _internals.buildSandboxProfile(['/scope'], '/tmp', env);
		expect(profile).toContain('(setenv PATH "/usr/bin:/bin:/usr/sbin:/sbin")');
	});

	test('buildSandboxProfile(scopePaths, tempDir, MacOSSandboxExecutor.getEnvOverrides()) round-trips exactly', () => {
		// Direct regression test: the actual getEnvOverrides() output, fed
		// through the actual profile builder wrapCommand uses internally.
		const executor = new MacOSSandboxExecutor([], '/tmp');
		const env = executor.getEnvOverrides();
		const profile = _internals.buildSandboxProfile(['/scope'], '/tmp', env);

		for (const key of [
			'DYLD_INSERT_LIBRARIES',
			'DYLD_LIBRARY_PATH',
			'DYLD_FRAMEWORK_PATH',
			'DYLD_ROOT_PATH',
		]) {
			expect(profile).toContain(`(unsetenv ${key})`);
		}
		expect(profile).toContain(`(setenv PATH "${env.PATH}")`);
	});
});

// NOTE (F6b, not test-automatable from this host): the assertions above
// prove the (setenv)/(unsetenv) primitives are PARSEABLE-SHAPED and reach
// the wrapped command string. They cannot prove the primitives actually
// alter a live child process's environment — a parseability probe cannot
// distinguish "valid primitive" from "valid but no-op." Confirming the DYLD
// variables are genuinely absent from a real sandbox-exec-wrapped child's
// environment requires spawning that child on a real macOS host and
// inspecting `/proc`-equivalent env state, which is not reproducible here.
// This is recorded as an open verification gap in the PR report rather than
// papered over with a placeholder assertion.

/**
 * #3332 regression: the production wrap args INCLUDE the /lib64 read-only
 * bind when the host has /lib64 (multilib hosts — Linux CI runners).
 *
 * Leg B of the pair with bwrap-executor-lib64-absent.test.ts. Same
 * module-load determinism rules: own file, mock installed before the
 * dynamic import, original function references captured first.
 *
 * GREEN at base and after the fix (guards against always-omit regressions).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';

const realExistsSync = realFs.existsSync;
void realExistsSync;

mock.module('node:fs', () => ({
	...realFs,
	// Fake host WITH /lib64.
	existsSync: () => true,
}));

const { BubblewrapSandboxExecutor, _internals } = await import(
	'../../../src/sandbox/linux/bubblewrap-executor.js'
);

afterEach(() => {
	mock.restore();
});

describe('bwrap executor /lib64 bind is host-conditional (present leg)', () => {
	test('wrap includes the /lib64 bind when the host has /lib64', () => {
		const originalProbe = _internals.probeBwrap;
		_internals.probeBwrap = () => true;
		try {
			const executor = new BubblewrapSandboxExecutor(['/ws/proj'], '/tmp');
			expect(executor.isAvailable()).toBe(true);
			const wrapped = executor.wrapCommand('true', []);
			expect(wrapped).toContain("--tmpfs '/tmp'");
			// Quoting-agnostic presence.
			expect(wrapped).toContain('/lib64');
			// The full read-only system-bind set is intact on this host shape.
			expect(wrapped).toContain('/etc');
			expect(wrapped).toContain('/usr');
			expect(wrapped).toContain('/lib');
		} finally {
			_internals.probeBwrap = originalProbe;
		}
	}, 60_000);
});

/**
 * #3332 regression: the production wrap args omit the /lib64 read-only bind
 * when the host has no /lib64 (usr-merged / non-multilib images).
 *
 * Leg A of the pair with bwrap-executor-lib64-present.test.ts. Availability
 * is read at module-load time (BWRAP_NAMESPACE_SMOKE_ARGS is a module-level
 * const built from buildBwrapArgs), so each leg lives in its OWN file with
 * the node:fs mock installed BEFORE the dynamic import. Original function
 * references are captured before mock.module — Bun hot-swaps the captured
 * namespace too (verified on this repo), and a passthrough through the
 * namespace would recurse infinitely.
 *
 * RED at base, GREEN after the fix.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';

const realExistsSync = realFs.existsSync;
void realExistsSync;

mock.module('node:fs', () => ({
	...realFs,
	// Fake host WITHOUT /lib64.
	existsSync: () => false,
}));

const { BubblewrapSandboxExecutor, _internals } = await import(
	'../../../src/sandbox/linux/bubblewrap-executor.js'
);

afterEach(() => {
	mock.restore();
});

describe('bwrap executor /lib64 bind is host-conditional (absent leg)', () => {
	test('wrap omits the /lib64 bind when the host has no /lib64', () => {
		const originalProbe = _internals.probeBwrap;
		_internals.probeBwrap = () => true;
		try {
			const executor = new BubblewrapSandboxExecutor(['/ws/proj'], '/tmp');
			expect(executor.isAvailable()).toBe(true);
			const wrapped = executor.wrapCommand('true', []);
			// It really wrapped (not passthrough) before asserting on binds.
			expect(wrapped).toContain("--tmpfs '/tmp'");
			// Quoting-agnostic absence: no /lib64 token anywhere.
			expect(wrapped).not.toContain('/lib64');
		} finally {
			_internals.probeBwrap = originalProbe;
		}
	}, 60_000);
});

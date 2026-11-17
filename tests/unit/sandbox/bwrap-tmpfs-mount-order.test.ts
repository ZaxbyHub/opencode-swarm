/**
 * bwrap mounts in argument order and the size-capped `--tmpfs <temp>` hides
 * everything beneath `temp` mounted before it. A scope under the default temp
 * root (`/tmp`) used to be bound first and then hidden, so in-scope writes
 * landed in the tmpfs and never reached the host ("No such file or directory"
 * on the host side; surfaced when ubuntu-26.04 shipped a working bwrap that
 * ubuntu-24.04 lacked, turning the sandbox integration tests from vacuous to
 * real). The tmpfs must come BEFORE scopes under it, and AFTER a scope or
 * read-only root that equals or contains `temp` so temp stays a tmpfs.
 */

import { describe, expect, test } from 'bun:test';
import {
	_internals,
	BubblewrapSandboxExecutor,
} from '../../../src/sandbox/linux/bubblewrap-executor';

function wrap(
	scopes: string[],
	temp?: string,
	readonlyRoots?: string[],
): string {
	// wrapCommand only checks the cached availability flag set by the
	// constructor from the probe seam; stub it so the string shape is
	// assertable on any platform.
	const originalProbe = _internals.probeBwrap;
	_internals.probeBwrap = () => true;
	try {
		const executor = new BubblewrapSandboxExecutor([]);
		return executor.wrapCommand('true', scopes, temp, undefined, {
			network_mode: 'off',
			readonly_roots: readonlyRoots,
		});
	} finally {
		_internals.probeBwrap = originalProbe;
	}
}

describe('bwrap tmpfs vs scope mount order', () => {
	test('a scope under the default /tmp is mounted AFTER the tmpfs', () => {
		const cmd = wrap(['/tmp/ac001-scope-x']);
		const tmpfs = cmd.indexOf("--tmpfs '/tmp'");
		const bind = cmd.indexOf(
			"--bind '/tmp/ac001-scope-x' '/tmp/ac001-scope-x'",
		);
		expect(tmpfs).toBeGreaterThan(-1);
		expect(bind).toBeGreaterThan(-1);
		expect(tmpfs).toBeLessThan(bind);
	});

	test('a read-only root under temp is also mounted after the tmpfs', () => {
		const cmd = wrap(['/tmp/ws/src'], '/tmp', ['/tmp/ws']);
		const tmpfs = cmd.indexOf("--tmpfs '/tmp'");
		const ro = cmd.indexOf("--ro-bind '/tmp/ws' '/tmp/ws'");
		const rw = cmd.indexOf("--bind '/tmp/ws/src' '/tmp/ws/src'");
		expect(tmpfs).toBeLessThan(ro);
		expect(ro).toBeLessThan(rw);
	});

	test('--size still immediately precedes --tmpfs', () => {
		const cmd = wrap(['/tmp/s']);
		expect(cmd).toMatch(/--size \d+ --tmpfs '\/tmp'/);
	});

	test('temp strictly inside a scope keeps the tmpfs AFTER the scope bind', () => {
		const cmd = wrap(['/work'], '/work/tmp');
		const bind = cmd.indexOf("--bind '/work' '/work'");
		const tmpfs = cmd.indexOf("--tmpfs '/work/tmp'");
		expect(bind).toBeGreaterThan(-1);
		expect(tmpfs).toBeGreaterThan(bind);
	});

	test('temp inside a read-only root keeps the tmpfs AFTER the ro-bind', () => {
		// Pins the read-only-root half of the containment check: a scopes-only
		// check would emit the tmpfs first and the ro-bind would then hide it.
		const cmd = wrap([], '/ws/tmp', ['/ws']);
		const ro = cmd.indexOf("--ro-bind '/ws' '/ws'");
		const tmpfs = cmd.indexOf("--tmpfs '/ws/tmp'");
		expect(ro).toBeGreaterThan(-1);
		expect(tmpfs).toBeGreaterThan(ro);
	});

	test('temp EQUAL to a scope or read-only root keeps the tmpfs last', () => {
		// Equality counts as "inside": the tmpfs wins, as before the fix, so
		// temp stays a private size-capped tmpfs (not the writable host dir,
		// and not a read-only host dir that would break every temp write).
		for (const cmd of [wrap(['/tmp']), wrap([], '/tmp', ['/tmp'])]) {
			const mount = cmd.search(/--(ro-)?bind '\/tmp' '\/tmp'/);
			const tmpfs = cmd.indexOf("--tmpfs '/tmp'");
			expect(mount).toBeGreaterThan(-1);
			expect(tmpfs).toBeGreaterThan(mount);
		}
	});

	test('a scope outside temp is unaffected and the tmpfs is mounted once', () => {
		const cmd = wrap(['/home/u/proj']);
		expect(cmd.match(/--tmpfs/g)).toHaveLength(1);
		expect(cmd).toContain("--bind '/home/u/proj' '/home/u/proj'");
	});

	test('a sibling path sharing only a name prefix is not treated as nested', () => {
		// temp '/tmpx' is NOT under scope '/tmp' (no '/' boundary).
		const cmd = wrap(['/tmp'], '/tmpx');
		const bind = cmd.indexOf("--bind '/tmp' '/tmp'");
		const tmpfs = cmd.indexOf("--tmpfs '/tmpx'");
		expect(tmpfs).toBeLessThan(bind);
	});
});

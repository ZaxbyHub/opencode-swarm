/**
 * `validateProjectDirectory` — system-location containment (issue #1619).
 *
 * Split out of `path-security.test.ts` to keep that file under the FR-006
 * 500-line cap; the shape assertions (absolute / relative / UNC) stay there,
 * and everything about WHICH absolute roots are usable lives here.
 *
 * Absoluteness is NOT containment. Every caller of the validated root writes
 * under `<root>/.swarm/`, so a root of `E:\` or `/etc` produces real writes at a
 * system location — `validateSwarmPath` pins the write INSIDE the root, which
 * does not help when the root itself is wrong. Observed, not theorised: while
 * this validator briefly accepted any absolute path, running
 * `tests/security/adversarial/services-path-traversal.test.ts` created
 * `E:\.swarm\session\budget-state.json`, `E:\Windows\` and
 * `E:\Users\Brett\AppData\Local\` on a developer machine.
 *
 * Both deny lists are evaluated on every platform so a Linux CI runner and a
 * Windows host enforce an identical contract.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { validateProjectDirectory } from '../../../src/utils/path-security';

describe('validateProjectDirectory — system-location containment', () => {
	test('rejects a filesystem or drive root', () => {
		for (const root of ['/', 'C:\\', 'E:/', 'C:/']) {
			expect(() => validateProjectDirectory(root), root).toThrow(
				/filesystem root/,
			);
		}
	});

	test('rejects POSIX system hierarchies, as roots and as subtrees', () => {
		for (const dir of ['/etc', '/usr/bin', '/dev/shm', '/boot', '/proc/self']) {
			expect(() => validateProjectDirectory(dir), dir).toThrow(
				/system location/,
			);
		}
	});

	test('rejects Windows system hierarchies on ANY drive', () => {
		// The harm was observed at `E:\Windows`, not `C:\Windows` — denying only
		// the system drive would have missed it.
		for (const dir of [
			'C:\\Windows',
			'E:\\Windows',
			'C:\\Windows\\System32',
			'C:/Program Files',
			'C:\\Program Files (x86)',
			'C:\\ProgramData',
		]) {
			expect(() => validateProjectDirectory(dir), dir).toThrow(
				/system location/,
			);
		}
	});

	test('rejects the user-container directory itself but not projects inside it', () => {
		for (const dir of ['C:\\Users', 'E:/Users', '/home', '/root']) {
			expect(() => validateProjectDirectory(dir), dir).toThrow(
				/system location/,
			);
		}
		// The normal case must keep working.
		expect(() => validateProjectDirectory('C:\\Users\\dev\\app')).not.toThrow();
		expect(() => validateProjectDirectory('/home/runner/work/x')).not.toThrow();
	});

	// PR #2129: the first version of this guard used the host's `path.resolve`,
	// which is bound to the running platform. On POSIX a backslash is an ordinary
	// filename character, so `path.resolve('C:\\Windows')` on Linux yields
	// `<cwd>/C:\Windows` — first segment `home`, not `Windows` — and the deny list
	// never fired. It passed on a Windows dev host and failed the `security` job on
	// ubuntu. The mechanism is pinned here platform-independently so neither runner
	// executes a vacuous assertion.
	test('a Windows-shaped root is judged by the win32 parser on every platform', () => {
		// The divergence that caused the CI failure, asserted directly.
		expect(path.win32.isAbsolute('C:\\Windows')).toBe(true);
		expect(path.posix.isAbsolute('C:\\Windows')).toBe(false);
		expect(path.posix.resolve('C:\\Windows')).not.toContain('/Windows');

		// Rejected regardless of which platform is running this test.
		expect(() => validateProjectDirectory('C:\\Windows')).toThrow(
			/system location/,
		);
		expect(() => validateProjectDirectory('\\Windows')).toThrow(
			/system location|absolute path/,
		);
	});

	test('a POSIX-shaped root is judged by the posix parser on every platform', () => {
		expect(path.posix.isAbsolute('/etc')).toBe(true);
		expect(path.win32.isAbsolute('/etc')).toBe(true);
		expect(() => validateProjectDirectory('/etc')).toThrow(/system location/);
	});

	test('CI workspace roots stay valid on every platform', () => {
		// If the deny list ever swallowed one of these, the features this guard
		// protects would go dead again — the exact failure mode #1619 fixed.
		for (const root of [
			'/home/runner/work/opencode-swarm/opencode-swarm',
			'/Users/runner/work/repo',
			'/tmp/swarm-security-abc',
			'C:\\Users\\runneradmin\\repo',
		]) {
			expect(() => validateProjectDirectory(root), root).not.toThrow();
		}
	});

	test('does NOT reject /var, where the macOS temp root lives', () => {
		// The macOS temp root is `/var/folders/...`, so denying the /var subtree
		// would reject every temp-rooted test workspace there, re-creating the
		// dead-feature class. (Phrased without the literal API name on purpose:
		// scripts/check-test-tmpdir.sh matches raw text on added lines and does not
		// distinguish code from comments.)
		expect(() =>
			validateProjectDirectory('/var/folders/xy/T/workspace'),
		).not.toThrow();
	});
});

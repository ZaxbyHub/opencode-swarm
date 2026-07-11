import { describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/sandbox/macos/sandbox-exec-executor';

/**
 * Issue #1778 H2: SBPL is last-match-wins, so the blanket `(deny file-write*)`
 * must appear BEFORE the scoped `(allow file-write* (subpath ...))` lines.
 * Otherwise the trailing deny overrides the scoped allow and denies EVERY
 * write, including in-scope writes (breaking AC-001). These string-level
 * assertions lock the ordering against regression. (Runtime enforcement itself
 * still requires a macOS host to exercise sandbox-exec.)
 */
describe('macOS SBPL profile ordering (#1778 H2)', () => {
	const profile = _internals.buildSandboxProfile(
		['/work/project/src'],
		'/tmp/swarm-abc',
	);

	test('blanket deny file-write* precedes the scoped allow', () => {
		const denyIdx = profile.indexOf('(deny file-write*)');
		const allowIdx = profile.indexOf('(allow file-write* (subpath');
		expect(denyIdx).toBeGreaterThanOrEqual(0);
		expect(allowIdx).toBeGreaterThanOrEqual(0);
		// Last-match-wins: deny must come first so the scoped allow wins in-scope.
		expect(denyIdx).toBeLessThan(allowIdx);
	});

	test('the scoped allow is the last file-write* rule in the profile', () => {
		const lastDeny = profile.lastIndexOf('(deny file-write*)');
		const lastAllow = profile.lastIndexOf('(allow file-write* (subpath');
		expect(lastAllow).toBeGreaterThan(lastDeny);
	});

	test('includes the declared scope path and temp dir as writable', () => {
		expect(profile).toContain('/work/project/src');
		expect(profile).toContain('/tmp/swarm-abc');
	});
});

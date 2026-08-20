/**
 * Issue #2236 hardening (lane C1b): `gitExec` (src/git/branch.ts) resolves
 * the git binary via `_internals.resolveGitExecutable()` instead of a bare
 * `'git'` literal. This file is a small, standalone regression test that
 * `gitExec` actually spawns whatever the resolver returns, rather than a
 * hardcoded `'git'`.
 *
 * Split out of `branch.test.ts` (FR-006 500-line ratchet — that file is
 * already far over cap, so a new assertion there must land in a new file
 * instead of growing it) rather than reusing the shared preload seed, since
 * this test's whole point is to prove `gitExec` is NOT hardcoded to `'git'`.
 * Stubs `_internals.spawnSync`/`_internals.resolveGitExecutable` directly —
 * no `node:child_process` module mock needed, mirroring the DI-seam pattern
 * `branch.test.ts` itself uses.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { _internals } from '../../../src/git/branch';

const originalSpawnSync = _internals.spawnSync;
const originalResolveGitExecutable = _internals.resolveGitExecutable;

afterEach(() => {
	_internals.spawnSync = originalSpawnSync;
	_internals.resolveGitExecutable = originalResolveGitExecutable;
});

describe('gitExec routes through resolveGitExecutable() (issue #2236 hardening, lane C1b)', () => {
	test('spawns the binary returned by _internals.resolveGitExecutable, not a bare "git" literal', () => {
		const sentinel = '/opt/fake-git-install/bin/git';
		_internals.resolveGitExecutable = () => sentinel;
		let calledWith: string | undefined;
		_internals.spawnSync = ((command: string) => {
			calledWith = command;
			return { status: 0, stdout: 'main\n', stderr: '' };
		}) as typeof _internals.spawnSync;

		_internals.gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], '/test/repo');

		expect(calledWith).toBe(sentinel);
	});
});

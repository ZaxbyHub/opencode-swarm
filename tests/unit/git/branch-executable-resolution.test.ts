/**
 * Suite-wide coverage gap closer (issue #2236 / PR #2261 reviewer finding).
 *
 * `bunfig.toml` preloads `tests/preload/executable-resolver-pin.ts`, which
 * seeds `resolveGitExecutable()`'s cache with the bare name `'git'` before any
 * test file loads. Every other test file that exercises `gitExec()`
 * (`src/git/branch.ts`) therefore only ever sees that bare-name path — NOT an
 * absolute resolved path — unless it explicitly calls
 * `resetGitExecutableCache()` first. That means a regression where a
 * high-traffic call site mishandles an absolute resolved executable path
 * (string-concatenates it instead of passing it array-form, mis-splits it on
 * whitespace, etc.) would be invisible across the ENTIRE suite: nothing
 * outside the resolver's own tests ever feeds it anything but the bare name.
 *
 * This file closes that gap for the highest-traffic call site, `gitExec` in
 * `src/git/branch.ts`, which every exported branch-management function
 * ultimately funnels through. It resets the resolver cache, seeds it with an
 * ABSOLUTE path that contains a SPACE (the realistic Windows shape,
 * `C:\Program Files\Git\cmd\git.exe`, and the shape that actually breaks
 * naive string concatenation — a bare-name or no-space path would not), and
 * asserts the exact argv `spawnSync` receives: `command` must be that exact
 * absolute string, unmangled and un-split, and `args` must remain the git
 * subcommand array, not merged into `command`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type MockSpawnResult = {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException;
};

let capturedCalls: Array<{ command: string; args: string[] }> = [];
let queuedResult: MockSpawnResult = { status: 0, stdout: 'main\n', stderr: '' };

const mockSpawnSync = mock(
	(command: string, args: string[], _options: Record<string, unknown>) => {
		capturedCalls.push({ command, args: [...args] });
		return queuedResult;
	},
);

// Mock node:child_process BEFORE importing branch.ts / git-executable.ts, so
// both modules' internal `import { spawnSync } from 'node:child_process'`
// bind to the mock (mirrors tests/unit/git/branch.test.ts's own pattern).
import * as realChildProcess from 'node:child_process';

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

const branch = await import('../../../src/git/branch.js');
const gitExecutable = await import('../../../src/utils/git-executable.js');

// Windows-shaped absolute path containing a space — the real-world install
// location (`C:\Program Files\Git\cmd\git.exe`) and the shape that breaks a
// naive `command + ' ' + args.join(' ')` concatenation, since a shell would
// need to quote it to keep it as one token.
const ABS_PATH_WITH_SPACE = 'C:\\Program Files\\Git\\cmd\\git.exe';

describe('gitExec absolute resolved path integration (PR #2261 reviewer coverage gap)', () => {
	beforeEach(() => {
		capturedCalls = [];
		queuedResult = { status: 0, stdout: 'main\n', stderr: '' };
		mockSpawnSync.mockClear();
		// Escape the suite-wide bare-name pin so this test exercises a REAL
		// absolute resolved path, not the preload's 'git'.
		gitExecutable.resetGitExecutableCache();
	});

	afterEach(() => {
		// Restore the pinned suite-wide state so later test files (which do NOT
		// reset the cache themselves) keep seeing the cheap bare-name path
		// instead of paying real probe cost or leaking this fixture value.
		gitExecutable.resetGitExecutableCache();
		gitExecutable.__seedGitExecutableForTests('git');
	});

	test('resolveGitExecutable actually resolves to the seeded absolute path (not a silent bare-name fallback)', () => {
		gitExecutable.__seedGitExecutableForTests(ABS_PATH_WITH_SPACE);
		const resolved = gitExecutable.resolveGitExecutable();
		expect(
			resolved,
			'resolveGitExecutable() must return the seeded absolute path — a bare-name fallback here would make every assertion below vacuous',
		).toBe(ABS_PATH_WITH_SPACE);
	});

	test('gitExec spawns the exact absolute resolved path as argv[0] and keeps subcommand args as a separate array', () => {
		gitExecutable.__seedGitExecutableForTests(ABS_PATH_WITH_SPACE);
		// Sanity: prove resolution actually landed on the fixture before
		// trusting the downstream spawn assertion.
		expect(gitExecutable.resolveGitExecutable()).toBe(ABS_PATH_WITH_SPACE);

		const output = branch.getCurrentBranch('/test/repo');

		expect(output).toBe('main');
		expect(capturedCalls.length).toBe(1);
		const call = capturedCalls[0];

		// The command passed to spawnSync must be EXACTLY the resolved absolute
		// path, byte for byte, unsplit and unmangled by any intermediate
		// string-concatenation or whitespace-splitting.
		expect(call.command).toBe(ABS_PATH_WITH_SPACE);

		// The subcommand args must remain their own array — proof the call site
		// used array-form spawning (`spawnSync(command, args, ...)`), not a
		// single shell-concatenated string that a naive regression would
		// produce (e.g. `${command} ${args.join(' ')}` collapsed into argv[0]).
		expect(call.args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);

		// Belt-and-suspenders: the space inside the resolved path must survive
		// intact inside argv[0] — a regression that split on whitespace (e.g.
		// `command.split(' ')[0]`) would truncate this to "C:\Program".
		expect(call.command).toContain(' ');
		expect(call.command.startsWith('C:\\Program Files\\Git')).toBe(true);
	});

	test('resetGitExecutableCache followed by a fresh seed does not leak the previous absolute path into a later resolution', () => {
		gitExecutable.__seedGitExecutableForTests(ABS_PATH_WITH_SPACE);
		expect(gitExecutable.resolveGitExecutable()).toBe(ABS_PATH_WITH_SPACE);

		gitExecutable.resetGitExecutableCache();
		gitExecutable.__seedGitExecutableForTests('git');
		expect(gitExecutable.resolveGitExecutable()).toBe('git');
	});
});

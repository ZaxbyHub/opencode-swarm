/**
 * Suite-wide coverage gap closer (issue #2236 / PR #2261 reviewer finding).
 *
 * `bunfig.toml` preloads `tests/preload/executable-resolver-pin.ts`, which
 * seeds `resolveGitExecutable()`'s cache with the bare name `'git'` before any
 * test file loads. Every other test file that exercises `gitExec()`
 * (`src/git/branch.ts`) therefore only ever sees that bare-name path — NOT an
 * absolute resolved path — unless it explicitly resets the resolver cache.
 *
 * That means a regression where a high-traffic call site mishandles an absolute
 * resolved executable path (string-concatenates it instead of passing it
 * array-form, splits it on whitespace, etc.) would be invisible across the
 * ENTIRE suite. Demonstrated: mutating `gitExec` to `command.split(' ')[0]`
 * leaves 72 pre-existing branch tests green while failing only this file.
 *
 * This closes that gap for the highest-traffic call site, `gitExec`, which
 * every exported branch-management function funnels through. It seeds an
 * ABSOLUTE path containing a SPACE (`C:\Program Files\Git\cmd\git.exe` — the
 * realistic Windows shape, and the shape that actually breaks naive
 * concatenation) and asserts the exact argv the spawn receives.
 *
 * WHY THE `_internals` SEAM AND NOT `mock.module`. An earlier version of this
 * file replaced `node:child_process` wholesale. That registers PROCESS-WIDE and
 * is not undone by `mock.restore()`, so it leaked into co-resident files two
 * separate ways: its default `stdout: 'main\n'` made `probeBwrap` report bwrap
 * AVAILABLE on Windows (breaking linux.test.ts's `isAvailable()` assertion,
 * because `bubblewrap-executor.ts` imports `spawnSync` directly with no seam of
 * its own), and its unconditional `[...args]` spread threw a `TypeError` on any
 * co-resident 2-arg `spawnSync(cmd, opts)` call (breaking
 * sandbox-integration.test.ts). Measured: the `mock.module` form turned a
 * 0-failure pair into 2 failures; this seam-based form yields 0. The seam is
 * per-module and genuinely restorable, which is why AGENTS.md prefers it for
 * new code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpawnSyncReturns } from 'node:child_process';
import {
	_internals as branchInternals,
	getCurrentBranch,
} from '../../../src/git/branch';

/**
 * Windows-shaped absolute path containing a space — the real-world install
 * location, and the shape that breaks a naive `command + ' ' + args.join(' ')`
 * concatenation or a `split(' ')[0]` truncation.
 */
const ABS_PATH_WITH_SPACE = 'C:\\Program Files\\Git\\cmd\\git.exe';

const originalSpawnSync = branchInternals.spawnSync;
const originalResolve = branchInternals.resolveGitExecutable;

let capturedCalls: Array<{ command: string; args: string[] }> = [];

function spawnResult(stdout: string): SpawnSyncReturns<string> {
	return {
		pid: 4242,
		output: [null, stdout, ''],
		stdout,
		stderr: '',
		status: 0,
		signal: null,
		error: undefined,
	} as SpawnSyncReturns<string>;
}

beforeEach(() => {
	capturedCalls = [];
	// Escape the suite-wide bare-name pin so this file exercises a REAL
	// absolute resolved path rather than the preload's 'git'.
	branchInternals.resolveGitExecutable = () => ABS_PATH_WITH_SPACE;
	branchInternals.spawnSync = ((command: string, args: string[]) => {
		capturedCalls.push({ command, args: [...args] });
		return spawnResult('main\n');
	}) as typeof branchInternals.spawnSync;
});

afterEach(() => {
	// Restore the CAPTURED originals, never a hand-written literal — the latter
	// is permanent pollution rather than a restore.
	branchInternals.spawnSync = originalSpawnSync;
	branchInternals.resolveGitExecutable = originalResolve;
});

describe('gitExec absolute resolved path integration (PR #2261 reviewer coverage gap)', () => {
	test('spawns the exact absolute resolved path as argv[0] and keeps subcommand args a separate array', () => {
		const output = getCurrentBranch('/test/repo');

		expect(output).toBe('main');
		// Non-vacuous: without a recorded call every assertion below is empty.
		expect(capturedCalls.length).toBe(1);
		const call = capturedCalls[0];

		// argv[0] must be EXACTLY the resolved path, byte for byte — unsplit and
		// unmangled by any intermediate concatenation or whitespace split.
		expect(call.command).toBe(ABS_PATH_WITH_SPACE);

		// Subcommand args stay their own array: proof the call site spawns
		// array-form rather than collapsing everything into one shell string.
		expect(call.args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);

		// The space must survive inside argv[0]. A `command.split(' ')[0]`
		// regression truncates this to "C:\Program".
		expect(call.command).toContain(' ');
		expect(call.command.startsWith('C:\\Program Files\\Git')).toBe(true);
	});

	test('the resolved path is taken from the resolver, not hardcoded or re-derived', () => {
		// Point the resolver somewhere else mid-test: whatever it returns is
		// what must be spawned, so this cannot pass by coincidence of the
		// constant above.
		const other = '/opt/custom prefix/bin/git';
		branchInternals.resolveGitExecutable = () => other;

		getCurrentBranch('/test/repo');

		expect(capturedCalls.length).toBe(1);
		expect(capturedCalls[0].command).toBe(other);
	});
});

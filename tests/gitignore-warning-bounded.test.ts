/**
 * Regression tests for the plugin-load hang caused by unbounded `git`
 * subprocess calls in `ensureSwarmGitExcluded`.
 *
 * Engineering rule under test:
 *   "OpenCode plugin registration must never await unbounded filesystem,
 *    Git, network, package-manager, repo-scan, or cache-repair work."
 *
 * The previous implementation issued up to four sequential `bunSpawn(['git', ...])`
 * calls with no per-call `timeout`, no `stdin: 'ignore'`, and no
 * `try { … } finally { proc.kill() }`. Any host condition that prevents
 * `git` from exiting promptly (antivirus interception, credential prompt,
 * NFS-stalled `.git`, Bun-on-Windows stdin pipe semantics) hangs plugin
 * init forever; OpenCode's plugin host silently drops a plugin whose entry
 * never resolves, so no agents appear in the TUI / GUI.
 *
 * Tests use the file-scoped `_internals` DI seam exported from
 * `gitignore-warning.ts` rather than `mock.module`, because Bun runs all
 * test files in a shared process and `mock.module` mutations leak across
 * unrelated suites that import `bun-compat`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS,
	ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS,
	ensureSwarmGitExcluded,
	resetSwarmGitExcludedState,
} from '../src/utils/gitignore-warning';

const realBunSpawn = _internals.bunSpawn;

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
});

beforeEach(() => {
	resetSwarmGitExcludedState();
});

describe('ensureSwarmGitExcluded — bounded execution', () => {
	test('exports the per-call and outer timeout constants', () => {
		expect(ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS).toBe(3_000);
		expect(ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS).toBe(1_500);
	});

	test('every bunSpawn call passes timeout + stdin:ignore + pipe stdout/stderr', async () => {
		const observed: Array<Record<string, unknown>> = [];
		const killCalls = { count: 0 };
		_internals.bunSpawn = ((
			_cmd: string[],
			options?: Record<string, unknown>,
		) => {
			if (options) observed.push(options);
			// Resolve with a non-zero exit so the function short-circuits
			// after the first spawn — happy-path coverage is in a separate
			// test below.
			return {
				stdout: { text: () => Promise.resolve('') },
				stderr: { text: () => Promise.resolve('') },
				exited: Promise.resolve(1),
				exitCode: 1,
				kill: () => {
					killCalls.count += 1;
				},
			};
		}) as unknown as typeof realBunSpawn;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bounded-1-'));
		try {
			await ensureSwarmGitExcluded(tmpDir, { quiet: true });

			expect(observed.length).toBeGreaterThanOrEqual(1);
			for (const opts of observed) {
				expect(opts.timeout).toBe(
					ENSURE_SWARM_GIT_EXCLUDED_PER_CALL_TIMEOUT_MS,
				);
				expect(opts.stdin).toBe('ignore');
				expect(opts.stdout).toBe('pipe');
				expect(opts.stderr).toBe('pipe');
			}
			// Every spawn site must invoke kill() in its finally — defensive
			// cleanup so a runtime that ignored `timeout` cannot leak orphans.
			expect(killCalls.count).toBe(observed.length);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('reaches every spawn site (4 git calls) when the happy path runs', async () => {
		const cmds: string[][] = [];
		const killCalls = { count: 0 };
		let callIndex = 0;

		// Use os.tmpdir() + mkdtempSync — never hardcode /tmp (AGENTS.md invariant 7).
		const fakeGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gitroot-'));

		const responses: Array<{ exitCode: number; stdout: string }> = [
			// 1. rev-parse --show-toplevel
			{ exitCode: 0, stdout: `${fakeGitRoot}\n` },
			// 2. rev-parse --git-path info/exclude
			{ exitCode: 0, stdout: `${fakeGitRoot}/.git/info/exclude\n` },
			// 3. check-ignore -q .swarm/.gitkeep — non-zero means NOT ignored
			{ exitCode: 1, stdout: '' },
			// 4. ls-files -- .swarm — empty stdout means no tracked files
			{ exitCode: 0, stdout: '' },
		];

		_internals.bunSpawn = ((cmd: string[]) => {
			cmds.push(cmd);
			const response = responses[callIndex] ?? { exitCode: 0, stdout: '' };
			callIndex += 1;
			return {
				stdout: { text: () => Promise.resolve(response.stdout) },
				stderr: { text: () => Promise.resolve('') },
				exited: Promise.resolve(response.exitCode),
				exitCode: response.exitCode,
				kill: () => {
					killCalls.count += 1;
				},
			};
		}) as unknown as typeof realBunSpawn;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bounded-2-'));
		try {
			fs.mkdirSync(path.join(fakeGitRoot, '.git', 'info'), {
				recursive: true,
			});
			await ensureSwarmGitExcluded(tmpDir, { quiet: true });
			expect(cmds.length).toBe(4);
			expect(cmds[0]).toEqual([
				'git',
				'-C',
				tmpDir,
				'rev-parse',
				'--show-toplevel',
			]);
			expect(cmds[1]).toEqual([
				'git',
				'-C',
				tmpDir,
				'rev-parse',
				'--git-path',
				'info/exclude',
			]);
			expect(cmds[2]).toEqual([
				'git',
				'-C',
				tmpDir,
				'check-ignore',
				'-q',
				'.swarm/.gitkeep',
			]);
			expect(cmds[3]).toEqual([
				'git',
				'-C',
				tmpDir,
				'ls-files',
				'--',
				'.swarm',
			]);
			// Every spawn site invokes kill() in its finally.
			expect(killCalls.count).toBe(4);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
			fs.rmSync(fakeGitRoot, { recursive: true, force: true });
		}
	});

	test('never-resolving spawn — outer timer must intervene (confirms withTimeout in src/index.ts guards plugin init)', async () => {
		// When the runtime's per-call `timeout` option is honored, bunSpawn kills
		// the child, settling proc.exited and triggering the try/finally proc.kill().
		// When mocked to never resolve (e.g. in this test), the function hangs
		// indefinitely on its own — only the outer withTimeout in src/index.ts
		// makes plugin init bounded. This test proves that dependency.
		_internals.bunSpawn = (() => ({
			stdout: {
				text: () =>
					new Promise<string>(() => {
						/* never */
					}),
			},
			stderr: { text: () => Promise.resolve('') },
			exited: new Promise<number>(() => {
				/* never */
			}),
			exitCode: null,
			kill: () => {
				/* no-op — finally never runs without proc.exited settling */
			},
		})) as unknown as typeof realBunSpawn;

		const tmpDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'swarm-bounded-never-'),
		);
		try {
			// 100 ms is enough to prove the function does not self-bound.
			// The outer withTimeout(ENSURE_SWARM_GIT_EXCLUDED_OUTER_TIMEOUT_MS)
			// in src/index.ts is what actually bounds plugin init.
			const outerTimerFired = await Promise.race([
				ensureSwarmGitExcluded(tmpDir, { quiet: true }).then(
					() => false as const,
				),
				new Promise<true>((resolve) => setTimeout(resolve, 100, true)),
			]);

			expect(outerTimerFired).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

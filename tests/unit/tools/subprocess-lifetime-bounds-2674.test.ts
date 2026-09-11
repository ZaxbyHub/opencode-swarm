import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	_internals as identityInternals,
	writeProjectIdentity,
} from '../../../src/knowledge/identity';
import {
	_internals as diagnoseInternals,
	GIT_REPOSITORY_CHECK_TIMEOUT_MS,
	getDiagnoseData,
} from '../../../src/services/diagnose-service';
import {
	complexity_hotspots,
	_internals as hotspotsInternals,
} from '../../../src/tools/complexity-hotspots';
import { __seedGitExecutableForTests } from '../../../src/utils/git-executable';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * #2674 — bounded-subprocess caller contract for the three probe sites:
 * `getGitRemoteUrl` (identity.ts), `checkGitRepository` (diagnose-service.ts),
 * and `getGitChurn` (complexity-hotspots.ts).
 *
 * Everything routes through the file-scoped `_internals` seams (no
 * `mock.module`), per AGENTS.md §7 and the gitignore-warning-bounded.test.ts
 * precedent. The seams are restored in afterEach; hotspots assertions mirror
 * the frozen acceptance checks in the issue trace.
 */

function stdinIgnored(opts: Record<string, unknown>): boolean {
	if (opts.stdin === 'ignore') return true;
	if (opts.stdio === 'ignore') return true;
	return Array.isArray(opts.stdio) && opts.stdio[0] === 'ignore';
}

function timeoutOk(opts: Record<string, unknown>): boolean {
	return typeof opts.timeout === 'number' && (opts.timeout as number) > 0;
}

describe('subprocess lifetime bounds — regression: unbounded probes (#2674)', () => {
	const tempDirs: string[] = [];
	const savedEnv: Record<string, string | undefined> = {
		HOME: process.env.HOME,
		LOCALAPPDATA: process.env.LOCALAPPDATA,
		APPDATA: process.env.APPDATA,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		XDG_DATA_HOME: process.env.XDG_DATA_HOME,
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	describe('identity.ts getGitRemoteUrl (via writeProjectIdentity)', () => {
		it('git remote probe passes positive timeout and ignored stdin through the seam', async () => {
			__seedGitExecutableForTests('git');
			const calls: {
				args: string[];
				opts: Record<string, unknown>;
			}[] = [];
			const original = identityInternals.execFileSync;
			identityInternals.execFileSync = ((
				_cmd: string,
				args: string[],
				opts?: Record<string, unknown>,
			) => {
				calls.push({ args, opts: opts ?? {} });
				return 'https://example.com/repo.git';
			}) as typeof identityInternals.execFileSync;

			const redirect = canonicalMkdtemp('swarm-2674-id-cfg-');
			tempDirs.push(redirect);
			const projectDir = canonicalMkdtemp('swarm-2674-id-proj-');
			tempDirs.push(projectDir);
			if (process.platform === 'win32') {
				process.env.LOCALAPPDATA = redirect;
				process.env.APPDATA = redirect;
			} else {
				process.env.HOME = redirect;
				process.env.XDG_CONFIG_HOME = path.join(redirect, '.config');
				process.env.XDG_DATA_HOME = path.join(redirect, '.local/share');
			}

			try {
				const identity = await writeProjectIdentity(
					projectDir,
					'2674contract',
					'proj-2674',
				);
				const remoteCall = calls.find((call) => call.args.includes('remote'));
				expect(remoteCall).toBeDefined();
				expect(timeoutOk(remoteCall?.opts ?? {})).toBe(true);
				expect(stdinIgnored(remoteCall?.opts ?? {})).toBe(true);
				expect(remoteCall?.opts.cwd).toBe(projectDir);
				expect(identity.repoUrl).toBe('https://example.com/repo.git');
			} finally {
				identityInternals.execFileSync = original;
			}
		});

		it('a timed-out or failing remote probe degrades to repoUrl undefined (existing fallback preserved)', async () => {
			__seedGitExecutableForTests('git');
			const original = identityInternals.execFileSync;
			identityInternals.execFileSync = ((
				_cmd: string,
				_args: string[],
				opts?: Record<string, unknown>,
			) => {
				// Simulate Node's timeout kill: the probe throws, the catch path
				// must fall back to "no remote".
				throw new Error(
					`spawn ETIMEDOUT after ${(opts as { timeout?: number })?.timeout ?? 0}ms`,
				);
			}) as typeof identityInternals.execFileSync;

			const redirect = canonicalMkdtemp('swarm-2674-id-to-');
			tempDirs.push(redirect);
			const projectDir = canonicalMkdtemp('swarm-2674-id-top-');
			tempDirs.push(projectDir);
			if (process.platform === 'win32') {
				process.env.LOCALAPPDATA = redirect;
				process.env.APPDATA = redirect;
			} else {
				process.env.HOME = redirect;
				process.env.XDG_CONFIG_HOME = path.join(redirect, '.config');
				process.env.XDG_DATA_HOME = path.join(redirect, '.local/share');
			}

			try {
				const identity = await writeProjectIdentity(
					projectDir,
					'2674timeout',
					'proj-2674-t',
				);
				expect(identity.repoUrl).toBeUndefined();
			} finally {
				identityInternals.execFileSync = original;
			}
		});
	});

	describe('diagnose-service.ts checkGitRepository (via getDiagnoseData)', () => {
		it('rev-parse probe passes positive timeout and all-ignored stdio through the seam', async () => {
			__seedGitExecutableForTests('git');
			const calls: {
				args: string[];
				opts: Record<string, unknown>;
			}[] = [];
			const originalExec = diagnoseInternals.execFileSync;
			const originalSandbox = diagnoseInternals.detectSandboxCapability;
			const originalExecutor = diagnoseInternals.getSandboxExecutor;
			diagnoseInternals.execFileSync = ((
				_cmd: string,
				args: string[],
				opts?: Record<string, unknown>,
			) => {
				calls.push({ args, opts: opts ?? {} });
				return '.git';
			}) as typeof diagnoseInternals.execFileSync;
			diagnoseInternals.detectSandboxCapability = () =>
				({ supported: false }) as never;
			diagnoseInternals.getSandboxExecutor = () =>
				undefined as unknown as ReturnType<
					typeof diagnoseInternals.getSandboxExecutor
				>;

			const projectDir = canonicalMkdtemp('swarm-2674-diag-');
			tempDirs.push(projectDir);

			try {
				const result = await getDiagnoseData(projectDir);
				const revParse = calls.find((call) => call.args.includes('rev-parse'));
				expect(revParse).toBeDefined();
				expect(revParse?.opts.cwd).toBe(projectDir);
				expect(revParse?.opts.stdio).toBe('ignore');
				expect(revParse?.opts.timeout).toBe(GIT_REPOSITORY_CHECK_TIMEOUT_MS);
				// The health check itself still completes.
				expect(Array.isArray(result.checks)).toBe(true);
			} finally {
				diagnoseInternals.execFileSync = originalExec;
				diagnoseInternals.detectSandboxCapability = originalSandbox;
				diagnoseInternals.getSandboxExecutor = originalExecutor;
			}
		});
	});

	describe('complexity-hotspots.ts getGitChurn', () => {
		function makeContext(directory: string): ToolContext {
			return {
				sessionID: 'test-session',
				messageID: 'test-message',
				agent: 'test-agent',
				directory,
				worktree: directory,
				abort: new AbortController().signal,
				metadata: () => ({}),
				ask: async () => undefined,
			} as ToolContext;
		}

		it('bunSpawn options carry positive timeout and stdin ignore; kill() runs on success', async () => {
			__seedGitExecutableForTests('git');
			const dir = canonicalMkdtemp('swarm-2674-churn-opts-');
			tempDirs.push(dir);
			const original = hotspotsInternals.bunSpawn;
			let killCalls = 0;
			const seen: { opts: Record<string, unknown> }[] = [];
			hotspotsInternals.bunSpawn = ((_cmd: string[], opts?: unknown) => {
				seen.push({ opts: (opts ?? {}) as Record<string, unknown> });
				return {
					stdout: { text: async () => 'src/a.ts\n' },
					stderr: { text: async () => '' },
					exited: Promise.resolve(0),
					exitCode: 0,
					spawnError: null,
					kill() {
						killCalls += 1;
					},
				};
			}) as typeof hotspotsInternals.bunSpawn;

			try {
				const parsed = JSON.parse(
					await complexity_hotspots.execute({}, makeContext(dir)),
				);
				expect(seen.length).toBeGreaterThan(0);
				const opts = seen[0].opts;
				expect(timeoutOk(opts)).toBe(true);
				expect(opts.stdin).toBe('ignore');
				expect(opts.cwd).toBe(dir);
				// finally-kill runs even on the success path (best-effort,
				// idempotent on an already-exited child).
				expect(killCalls).toBeGreaterThan(0);
				expect(parsed.error).toBeUndefined();
			} finally {
				hotspotsInternals.bunSpawn = original;
			}
		});

		it('hung child settles within the bound with kill evidence and a typed timeout error', async () => {
			__seedGitExecutableForTests('git');
			const dir = canonicalMkdtemp('swarm-2674-churn-hung-');
			tempDirs.push(dir);
			const original = hotspotsInternals.bunSpawn;
			let killCalls = 0;
			let releaseExited: (code: number) => void = () => {};
			let releaseStdout: (text: string) => void = () => {};
			const exited = new Promise<number>((resolve) => {
				releaseExited = resolve;
			});
			const stdoutText = new Promise<string>((resolve) => {
				releaseStdout = resolve;
			});
			hotspotsInternals.bunSpawn = (() => ({
				stdout: { text: () => stdoutText },
				stderr: { text: async () => '' },
				exited,
				exitCode: null,
				spawnError: null,
				kill() {
					killCalls += 1;
					releaseExited(1);
					releaseStdout('');
				},
			})) as typeof hotspotsInternals.bunSpawn;

			try {
				// performance.now (monotonic, wall-clock-independent) is the
				// sanctioned timer for elapsed-duration assertions; a frozen
				// Date clock would zero the measurement.
				const started = performance.now();
				const result = await complexity_hotspots.execute({}, makeContext(dir));
				const elapsedMs = performance.now() - started;
				const parsed = JSON.parse(result);
				// Pre-fix behavior (the bug): the await stayed pending forever
				// with zero kills. Post-fix: a bounded settle with kill evidence
				// and the loud timeout error naming the bound.
				expect(elapsedMs).toBeLessThan(4_000);
				expect(killCalls).toBeGreaterThan(0);
				expect(parsed.error).toContain('analysis failed');
				expect(parsed.error).toContain('timed out after');
			} finally {
				hotspotsInternals.bunSpawn = original;
			}
		});
	});
});

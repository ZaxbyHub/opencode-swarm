/**
 * Supplementary failure-class coverage for the #3317 reader (PR-feedback
 * round PRR-002/005/006/009 fixes): pins the classes that gained new
 * branches and had zero tests — EOUTPUT (bound overflow), ESIGNAL
 * (terminated child), ENOENT-after-await (Node-runtime async spawnError),
 * the end-to-end deadline covering executable resolution, and the
 * consumer-side cause arms (close gate + shared rollback/checkpoint
 * descriptor).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCloseCommand } from '../../../src/commands/close/orchestrator';
import {
	_internals as purgeInternals,
	recheckBeforeDestructive,
} from '../../../src/commands/destructive-purge';
import {
	type GitStatusReadResult,
	gitStatusReadInternals,
	readGitStatusAsync,
} from '../../../src/commands/git-status-read';
import { describeUnreadableCause } from '../../../src/commands/rollback-gate';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempRoots: string[] = [];

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;
const originalSpawn = gitStatusReadInternals.spawn;
const originalRunGitStatus = purgeInternals.runGitStatus;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	gitStatusReadInternals.spawn = originalSpawn;
	purgeInternals.runGitStatus = originalRunGitStatus;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function stubSpawnResult(overrides: {
	exitCode?: number | null;
	spawnError?: Error | null;
	signalCode?: string | null;
}): ReturnType<typeof originalSpawn> {
	return {
		stdout: {
			getReader: () => ({
				read: async () => ({ done: true, value: undefined }),
				releaseLock: () => {},
			}),
		},
		stderr: {
			getReader: () => ({
				read: async () => ({ done: true, value: undefined }),
				releaseLock: () => {},
			}),
		},
		exited: Promise.resolve(overrides.exitCode ?? 0),
		exitCode: null,
		signalCode: overrides.signalCode ?? null,
		spawnError: overrides.spawnError ?? null,
		kill() {},
	} as unknown as ReturnType<typeof originalSpawn>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('git-status reader failure classes (#3317 feedback supplement)', () => {
	test('EOUTPUT: bound overflow carries the bound code with a null status (never "exited with status 0")', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-eout-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;
		const result = await readGitStatusAsync(
			[
				'-e',
				"require('node:fs').writeSync(2, 'EOUTPUT-STDERR-MARKER'); const b = Buffer.alloc(64 * 1024, 120); for (let i = 0; i < 4; i++) require('node:fs').writeSync(1, b);",
			],
			cwd,
			{ timeoutMs: 20_000, maxBufferBytes: 16 * 1024 },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('EOUTPUT');
			expect(result.status).toBeNull();
			expect(result.stderrTail).toContain('exceeded');
			// PRR-003's consumer: the retained partial stderr renders beside
			// the bound (review round 2 — the earlier claim had no consumer).
			expect(result.stderrTail).toContain('EOUTPUT-STDERR-MARKER');
		}
	}, 30_000);

	test('ESIGNAL: a child whose exit resolves the signal sentinel (-1) is classed as terminated, not a nonzero git exit', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-sig-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => 'git';
		gitStatusReadInternals.spawn = (() =>
			stubSpawnResult({ exitCode: -1 })) as typeof gitStatusReadInternals.spawn;
		const result = await readGitStatusAsync(['status'], cwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ESIGNAL');
			expect(result.status).toBeNull();
		}
	}, 30_000);

	test('ESIGNAL: an exit carrying signalCode (Bun native / POSIX kill shape, e.g. 137/SIGKILL) is classed as terminated, not nonzero', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-sigcode-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => 'git';
		gitStatusReadInternals.spawn = (() =>
			stubSpawnResult({
				exitCode: 137,
				signalCode: 'SIGKILL',
			})) as typeof gitStatusReadInternals.spawn;
		const result = await readGitStatusAsync(['status'], cwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ESIGNAL');
			expect(result.status).toBeNull();
		}
	}, 30_000);

	test('ENOENT-after-await: a spawnError that populates ASYNC (Node-runtime shape) is still classified as ENOENT, not status 1', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-late-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => 'git';
		// The Node fallback populates spawnError from the async 'error' event;
		// model it as a value that is null at spawn time and populated before
		// `exited` settles.
		let lateError: Error | null = null;
		const proc = stubSpawnResult({ exitCode: 1 }) as Record<string, unknown>;
		Object.defineProperty(proc, 'spawnError', {
			get: () => lateError,
			configurable: true,
		});
		proc.exited = (async () => {
			await sleep(30);
			lateError = Object.assign(new Error('spawn ENOENT'), {
				code: 'ENOENT',
			});
			return 1;
		})();
		gitStatusReadInternals.spawn = (() =>
			proc) as unknown as typeof gitStatusReadInternals.spawn;
		const result = await readGitStatusAsync(['status'], cwd);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ENOENT');
			expect(result.status).toBeNull();
		}
	}, 30_000);

	test('the deadline covers executable resolution: a slow resolver exhausts the timeout before any child spawns', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-deadline-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => {
			await sleep(400);
			return process.execPath;
		};
		let spawns = 0;
		gitStatusReadInternals.spawn = (() => {
			spawns += 1;
			return stubSpawnResult({ exitCode: 0 });
		}) as typeof gitStatusReadInternals.spawn;
		const startedAt = performance.now();
		const result = await gitStatusReadInternals.readOnce(['status'], cwd, 80);
		const elapsedMs = performance.now() - startedAt;
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe('ETIMEDOUT');
		}
		expect(spawns).toBe(0);
		// End-to-end bound (post-push automation review): the refusal must
		// arrive near the advertised 80 ms deadline, NOT after the resolver's
		// own 400 ms sleep. Charging resolution against the deadline without
		// racing it (the pre-fix shape) returned at ~400 ms; the race returns
		// at ~80 ms. 300 ms separates the two shapes with wide margins in
		// both directions (timer slack on loaded CI runners).
		expect(elapsedMs).toBeLessThan(300);
	}, 30_000);

	test('close gate renders EOUTPUT and ESIGNAL causes (never the availability or index-repair remedy)', async () => {
		const root = canonicalMkdtemp('3317-fclass-close-');
		tempRoots.push(root);
		fs.mkdirSync(path.join(root, '.git'), { recursive: true });
		fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
		fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });

		const { _closeGateInternals } = await import(
			'../../../src/commands/close/orchestrator'
		);
		const originalRunGit = _closeGateInternals.runGit;
		try {
			_closeGateInternals.runGit = async () =>
				({
					ok: false,
					code: 'EOUTPUT',
					status: null,
					stderrTail: 'output exceeded the 1048576-byte bound',
				}) satisfies GitStatusReadResult;
			const out = await handleCloseCommand(root, []);
			expect(out).toContain('output safety bound');
			expect(out).not.toContain('Ensure git is available');
			expect(out).not.toContain('damaged .git/index');
			expect(out).toContain('Nothing was closed, archived, or destroyed');

			_closeGateInternals.runGit = async () =>
				({
					ok: false,
					code: 'ESIGNAL',
					status: null,
					stderrTail: 'git process was terminated',
				}) satisfies GitStatusReadResult;
			const out2 = await handleCloseCommand(root, []);
			expect(out2).toContain('terminated before it answered');
			expect(out2).not.toContain('failed to spawn');
			expect(out2).not.toContain('Ensure git is available');

			// PRR-027 pin: the ENOENT remedy arm the release fragment
			// advertises ("install hint") must render at the close gate.
			_closeGateInternals.runGit = async () =>
				({
					ok: false,
					code: 'ENOENT',
					status: null,
					stderrTail: '',
				}) satisfies GitStatusReadResult;
			const out3 = await handleCloseCommand(root, []);
			expect(out3).toContain('The git executable was not found (ENOENT)');
			expect(out3).toContain('Install git on PATH');
			expect(out3).toContain('USER-level config');
			expect(out3).not.toContain('damaged .git/index');
			expect(out3).toContain('Nothing was closed, archived, or destroyed');
		} finally {
			_closeGateInternals.runGit = originalRunGit;
		}
	}, 60_000);

	test('the pre-destruction re-check carries the structured cause into its refusal (PRR-001 suffix branch)', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-recheck-');
		tempRoots.push(cwd);
		purgeInternals.runGitStatus = async () =>
			({
				ok: false,
				code: 'ETIMEDOUT',
				status: null,
				stderrTail: '',
			}) satisfies GitStatusReadResult;
		const result = await recheckBeforeDestructive(cwd, []);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// The generic sentence stays; the cause suffix is appended only
			// when the reader produced a structured failure.
			expect(result.reason).toContain(
				'the confirmed scope cannot be re-verified',
			);
			expect(result.reason).toContain('. Cause: ');
			expect(result.reason).toContain('timed out (ETIMEDOUT)');
		}
	}, 30_000);

	test('an exact-bound read is NOT truncated; one byte over is EOUTPUT (strict > at the bound)', async () => {
		const cwd = canonicalMkdtemp('3317-fclass-exact-');
		tempRoots.push(cwd);
		gitStatusReadInternals.resolveExecutable = async () => process.execPath;
		const bound = 16 * 1024;
		const exact = await readGitStatusAsync(
			['-e', `require('node:fs').writeSync(1, Buffer.alloc(${bound}, 120));`],
			cwd,
			{ timeoutMs: 20_000, maxBufferBytes: bound },
		);
		expect(exact.ok).toBe(true);
		if (exact.ok) {
			expect(exact.stdout.length).toBe(bound);
		}

		const over = await readGitStatusAsync(
			[
				'-e',
				`require('node:fs').writeSync(1, Buffer.alloc(${bound + 1}, 120));`,
			],
			cwd,
			{ timeoutMs: 20_000, maxBufferBytes: bound },
		);
		expect(over.ok).toBe(false);
		if (!over.ok) {
			expect(over.code).toBe('EOUTPUT');
		}
	}, 30_000);

	test('the shared rollback/checkpoint cause descriptor covers every reader class with a matched remedy', () => {
		expect(
			describeUnreadableCause({
				code: 'ETIMEDOUT',
				status: null,
				stderrTail: '',
			}),
		).toContain('timed out');
		expect(
			describeUnreadableCause({
				code: 'EOUTPUT',
				status: null,
				stderrTail: 'output exceeded the 1048576-byte bound',
			}),
		).toContain('safety bound');
		expect(
			describeUnreadableCause({
				code: 'ESIGNAL',
				status: null,
				stderrTail: '',
			}),
		).toContain('terminated before it answered');
		// ENOENT carries the fragment's install hint at EVERY sink (round-2
		// question: rollback/checkpoint previously fell to the generic arm).
		expect(
			describeUnreadableCause({
				code: 'ENOENT',
				status: null,
				stderrTail: '',
			}),
		).toContain('install git on PATH');
		expect(
			describeUnreadableCause({
				code: null,
				status: 128,
				stderrTail: 'fatal: x',
			}),
		).toContain('status 128');
		expect(
			describeUnreadableCause({ code: null, status: null, stderrTail: '' }),
		).toBe('retry, or inspect git status manually');
	});
});

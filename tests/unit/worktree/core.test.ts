import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BunCompatSubprocess } from '../../../src/utils/bun-compat';
import { makeWorktreeBranchName } from '../../../src/worktree';
import { _internals, removeWorktree } from '../../../src/worktree/core';

describe('shared worktree branch naming', () => {
	test('uses generalized purpose-prefixed branch names by default', () => {
		expect(
			makeWorktreeBranchName('parent-session', '1.1', { purpose: 'lane' }),
		).toBe('swarm/lane/parent-session/1.1');
	});

	test('preserves Lean Turbo legacy lane branch names for existing callers', () => {
		expect(
			makeWorktreeBranchName('parent-session', 'lane-a', {
				purpose: 'lane',
				branchStyle: 'legacy-lane',
			}),
		).toBe('swarm-lane/parent-session/lane-a');
	});
});

describe('removeWorktree opt-in force fallback (#1708)', () => {
	const realBunSpawn = _internals.bunSpawn;
	const realPlatform = _internals.platform;
	const realSleep = _internals.sleep;
	const realResolveGitExecutable = _internals.resolveGitExecutable;

	afterEach(() => {
		_internals.bunSpawn = realBunSpawn;
		_internals.platform = realPlatform;
		_internals.sleep = realSleep;
		_internals.resolveGitExecutable = realResolveGitExecutable;
	});

	function mockProc(
		exitCode: number,
		stdout = '',
		stderr = '',
	): BunCompatSubprocess {
		return {
			exited: Promise.resolve(exitCode),
			exitCode,
			stdout: { text: () => Promise.resolve(stdout) },
			stderr: { text: () => Promise.resolve(stderr) },
			kill: () => {},
		} as unknown as BunCompatSubprocess;
	}

	/** Creates a real worktree base + an in-base worktree dir on disk. */
	function makeInRootFixture(): { base: string; worktreePath: string } {
		const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-wt-base-')));
		const worktreePath = join(base, 'wt');
		mkdirSync(worktreePath, { recursive: true });
		return { base, worktreePath };
	}

	/** Installs a spawn stub that records every git argv and routes by --force. */
	function installSpawn(routes: {
		nonForce: () => BunCompatSubprocess;
		force: () => BunCompatSubprocess;
	}): string[][] {
		// Issue #2236 hardening (lane C1b): `runGit` resolves the git binary
		// via `resolveGitExecutable()` instead of a bare `'git'` literal. Stub
		// it (re-applied per test, since `afterEach` above restores the real
		// implementation) so the captured argv below stays deterministic — no
		// real filesystem probing against the stubbed `bunSpawn`.
		_internals.resolveGitExecutable = () => 'git';
		const calls: string[][] = [];
		_internals.bunSpawn = ((cmd: string[]) => {
			calls.push(cmd);
			return cmd.includes('--force') ? routes.force() : routes.nonForce();
		}) as typeof _internals.bunSpawn;
		return calls;
	}

	test('dirty-worktree failure + force:true + in-root → escalates to --force and succeeds', async () => {
		const { base, worktreePath } = makeInRootFixture();
		const calls = installSpawn({
			// Non-retryable, non-EBUSY "use --force" error → hits give-up on attempt 0.
			nonForce: () =>
				mockProc(
					1,
					'',
					"fatal: '...' contains modified or untracked files, use --force to delete it",
				),
			force: () => mockProc(0),
		});

		const result = await removeWorktree(worktreePath, base, {
			force: true,
			worktreeDir: base,
		});

		expect(result).toEqual({ success: true });
		// Exactly one non-force attempt, then exactly one --force attempt.
		const forceCalls = calls.filter((c) => c.includes('--force'));
		expect(forceCalls.length).toBe(1);
		expect(forceCalls[0]).toEqual([
			'git',
			'worktree',
			'remove',
			'--force',
			worktreePath,
		]);
	});

	test('EBUSY exhaustion (Windows) + force:true + in-root → escalates to --force after retries', async () => {
		const { base, worktreePath } = makeInRootFixture();
		_internals.platform = 'win32';
		_internals.sleep = () => Promise.resolve();
		const calls = installSpawn({
			nonForce: () => mockProc(1, '', 'EBUSY: resource busy or locked'),
			force: () => mockProc(0),
		});

		const result = await removeWorktree(worktreePath, base, {
			force: true,
			worktreeDir: base,
		});

		expect(result).toEqual({ success: true });
		const nonForceCalls = calls.filter((c) => !c.includes('--force'));
		const forceCalls = calls.filter((c) => c.includes('--force'));
		// 4 non-force attempts (MAX_RETRIES) then a single force escalation.
		expect(nonForceCalls.length).toBe(4);
		expect(forceCalls.length).toBe(1);
	});

	test('force:true but target OUTSIDE trusted base → NO --force attempt, returns error', async () => {
		const { base } = makeInRootFixture();
		// A real dir that is NOT under `base` (so realpathSync succeeds and it is
		// containment, not fail-closed, that rejects it).
		const outside = realpathSync(mkdtempSync(join(tmpdir(), 'core-wt-out-')));
		const calls = installSpawn({
			nonForce: () =>
				mockProc(
					1,
					'',
					'fatal: contains modified or untracked files, use --force to delete it',
				),
			force: () => mockProc(0),
		});

		const result = await removeWorktree(outside, base, {
			force: true,
			worktreeDir: base,
		});

		expect('error' in result).toBe(true);
		expect(calls.some((c) => c.includes('--force'))).toBe(false);
	});

	test('force unset + in-root failure → preserves legacy behavior (error, no --force)', async () => {
		const { base, worktreePath } = makeInRootFixture();
		const calls = installSpawn({
			nonForce: () =>
				mockProc(
					1,
					'',
					'fatal: contains modified or untracked files, use --force to delete it',
				),
			force: () => mockProc(0),
		});

		const result = await removeWorktree(worktreePath, base);

		expect('error' in result).toBe(true);
		expect(calls.some((c) => c.includes('--force'))).toBe(false);
	});
});

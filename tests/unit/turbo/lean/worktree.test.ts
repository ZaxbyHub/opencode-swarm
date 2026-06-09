/**
 * Tests for src/turbo/lean/worktree.ts
 *
 * All tests mock _internals.bunSpawn (the DI seam) to avoid needing a real git repo.
 * The mock replaces the BunCompatSubprocess return value so each test can exercise
 * specific exit codes and stdout/stderr strings.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	_internals,
	assertCleanWorkingTree,
	autoCommitDirty,
	checkPathBudget,
	cleanUntrackedFiles,
	isCleanWorktree,
	provisionWorktree,
	removeWorktree,
	shortenWorktreePath,
} from '../../../../src/turbo/lean/worktree';
import type { BunCompatSubprocess } from '../../../../src/utils/bun-compat';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Saves the real bunSpawn, platform, sleep, osTmpdir, and getCoreLongPaths so tests can restore them in afterEach. */
const realBunSpawn = _internals.bunSpawn;
const realPlatform = _internals.platform;
const realSleep = _internals.sleep;
const realOsTmpdir = _internals.osTmpdir;
const realGetCoreLongPaths = _internals.getCoreLongPaths;

/**
 * Constructs a minimal BunCompatSubprocess mock.
 * exitCode, stdout, and stderr are configurable per test.
 */
function mockProc(
	exitCode: number,
	stdout = '',
	stderr = '',
): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: {
			text: () => Promise.resolve(stdout),
		} as unknown as BunCompatSubprocess['stdout'],
		stderr: {
			text: () => Promise.resolve(stderr),
		} as unknown as BunCompatSubprocess['stderr'],
		kill: () => {},
	} as BunCompatSubprocess;
}

/**
 * Installs a fake bunSpawn that returns a pre-configured mockProc.
 * Subsequent calls to _internals.bunSpawn return the same mock unless
 * the test reassigns _internals.bunSpawn directly.
 */
function stubSpawn(exitCode: number, stdout = '', stderr = '') {
	_internals.bunSpawn = () => mockProc(exitCode, stdout, stderr);
}

/** Restores the real bunSpawn, platform, sleep, osTmpdir, and getCoreLongPaths after every test. */
afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.platform = realPlatform;
	_internals.sleep = realSleep;
	_internals.osTmpdir = realOsTmpdir;
	_internals.getCoreLongPaths = realGetCoreLongPaths;
});

// ---------------------------------------------------------------------------
// provisionWorktree
// ---------------------------------------------------------------------------

describe('provisionWorktree', () => {
	const fakeDir = 'C:\\project-root';
	const fakeLaneId = 'lane-1';
	const fakeSessionId = 'session-abc';
	const fakeConfig = {};

	test('creates worktree with correct branch name and returns worktreePath + branchName', async () => {
		// show-ref → exit 1 (branch doesn't exist), worktree add → exit 0 (success)
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('show-ref')) return mockProc(1, '', '');
			return mockProc(0, '', '');
		};

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			fakeConfig,
		);

		expect(result).toEqual({
			worktreePath: expect.stringContaining('swarm-worktrees'),
			branchName: 'swarm-lane/session-abc/lane-1',
		} as Record<string, string>);
	});

	test('uses config.worktree_dir when provided', async () => {
		// show-ref → exit 1 (branch doesn't exist), worktree add → exit 0 (success)
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('show-ref')) return mockProc(1, '', '');
			return mockProc(0, '', '');
		};
		const config = { worktree_dir: 'D:\\worktrees' };

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			config,
		);

		// worktreePath should be resolved under D:\worktrees
		expect(result).toHaveProperty('worktreePath');
		expect(
			(result as { worktreePath: string }).worktreePath.toLowerCase(),
		).toContain('d:\\worktrees');
	});

	test('resolves relative worktree_dir against project directory', async () => {
		// show-ref → exit 1 (branch doesn't exist), worktree add → exit 0 (success)
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('show-ref')) return mockProc(1, '', '');
			return mockProc(0, '', '');
		};

		const config = { worktree_dir: '../custom-wt' };

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			config,
		);

		expect(result).toHaveProperty('worktreePath');
		// Should be resolved against fakeDir (C:\project-root), not process.cwd()
		expect(
			(result as { worktreePath: string }).worktreePath.toLowerCase(),
		).toContain('custom-wt');
	});

	test('uses default .swarm-worktrees/<sessionId>/<laneId> when worktree_dir not set', async () => {
		// show-ref → exit 1 (branch doesn't exist), worktree add → exit 0 (success)
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('show-ref')) return mockProc(1, '', '');
			return mockProc(0, '', '');
		};

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			{},
		);

		// worktreePath should resolve to <parent-of-project-root>/.swarm-worktrees/<sessionId>/<laneId>
		expect(result).toHaveProperty('worktreePath');
		const p = (result as { worktreePath: string }).worktreePath;
		expect(p).toContain('.swarm-worktrees');
		expect(p).toContain(fakeSessionId);
		expect(p).toContain(fakeLaneId);
	});

	test('returns error when branch already exists', async () => {
		// git show-ref --verify --quiet exits 0 → branch exists
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('show-ref')) return mockProc(0, '', '');
			return mockProc(0, '', '');
		};

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			fakeConfig,
		);

		expect(result).toEqual({
			error: 'Branch already exists: swarm-lane/session-abc/lane-1',
		});
	});

	test('returns error when git worktree add fails', async () => {
		// show-ref → exit 1 (branch doesn't exist), worktree add → exit 128 (failure)
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('show-ref')) return mockProc(1, '', '');
			return mockProc(128, '', 'fatal: invalid reference: HEADXYZ');
		};

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			fakeConfig,
		);

		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain(
			'Failed to create worktree',
		);
	});
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
	const fakeWorktreePath = 'C:\\worktrees\\session-abc\\lane-1';
	const fakeProjectRoot = 'C:\\project-root';

	test('returns { success: true } when removal succeeds', async () => {
		stubSpawn(0, '', '');

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({ success: true });
	});

	test('returns error when removal fails with non-retryable exit code', async () => {
		stubSpawn(1, '', 'fatal: could not read logical configuration');

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({
			error: 'fatal: could not read logical configuration',
		});
	});

	test('Windows: retries up to 3 times on EBUSY', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {}; // no-op — no real delays in tests

		// Simulate Windows: EBUSY on first two attempts, success on third
		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			if (attempts < 3) return mockProc(1, '', 'EBUSY: resource busy');
			return mockProc(0, '', '');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({ success: true });
		expect(attempts).toBe(3);
	});

	test('Windows: returns error after 3 retries (4 attempts) exhausted', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {}; // no-op

		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			return mockProc(1, '', 'EBUSY: resource busy');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({ error: 'EBUSY: resource busy' });
		expect(attempts).toBe(4); // initial + 3 retries = 4 total attempts
	});

	test('Windows: retries on EPERM', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {}; // no-op

		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			if (attempts < 3) return mockProc(1, '', 'EPERM: access denied');
			return mockProc(0, '', '');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({ success: true });
		expect(attempts).toBe(3);
	});

	test('does NOT use --force flag', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		// Verify 'worktree' command was called with 'remove' (no '--force')
		const worktreeCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'worktree',
		);
		expect(worktreeCall).toBeDefined();
		expect(worktreeCall).not.toContain('--force');
		expect(worktreeCall![2]).toBe('remove');
	});
});

// ---------------------------------------------------------------------------
// isCleanWorktree
// ---------------------------------------------------------------------------

describe('isCleanWorktree', () => {
	const fakePath = 'C:\\worktrees\\session-abc\\lane-1';

	test('returns true when both git status --porcelain and git ls-files return empty', async () => {
		stubSpawn(0, '', ''); // used for both Promise.all calls (same stub, both get empty)

		const result = await isCleanWorktree(fakePath);

		expect(result).toBe(true);
	});

	test('returns false when git status --porcelain has output (uncommitted changes)', async () => {
		// status --porcelain has output, ls-files is empty
		// Two calls happen in Promise.all; bunSpawn is called twice.
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, ' M modified.txt', '');
			return mockProc(0, '', '');
		};

		const result = await isCleanWorktree(fakePath);

		expect(result).toBe(false);
	});

	test('returns false when git ls-files has output (untracked files)', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // status clean
			return mockProc(0, 'untracked.txt', ''); // ls-files has untracked
		};

		const result = await isCleanWorktree(fakePath);

		expect(result).toBe(false);
	});

	test('returns false when git commands return non-zero (cannot determine cleanliness)', async () => {
		// If git exits non-zero, we cannot verify cleanliness — must treat as dirty
		stubSpawn(128, '', 'fatal: not a git repository');

		const result = await isCleanWorktree(fakePath);

		expect(result).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// autoCommitDirty
// ---------------------------------------------------------------------------

describe('autoCommitDirty', () => {
	const fakePath = 'C:\\worktrees\\session-abc\\lane-1';

	test('returns { committed: true, message } on successful commit', async () => {
		// git add succeeds, git commit succeeds
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // git add -A
			return mockProc(0, '', ''); // git commit
		};

		const result = await autoCommitDirty(fakePath);

		expect(result).toEqual({
			committed: true,
			message: 'swarm-lane: auto-commit before cleanup',
		});
	});

	test('returns { committed: false, reason: "Nothing to commit" } when nothing to commit', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // git add -A succeeds
			return mockProc(1, '', 'nothing to commit'); // git commit detects nothing
		};

		const result = await autoCommitDirty(fakePath);

		expect(result).toEqual({ committed: false, reason: 'Nothing to commit' });
	});

	test('returns { committed: false, reason } when git add fails', async () => {
		stubSpawn(1, '', 'fatal: not a git repository');

		const result = await autoCommitDirty(fakePath);

		expect(result).toEqual({
			committed: false,
			reason: 'git add failed: fatal: not a git repository',
		});
	});

	test('uses correct commit message prefix', async () => {
		let commitArgs: string[] = [];
		_internals.bunSpawn = (args: string[]) => {
			commitArgs = args;
			return mockProc(0, '', '');
		};

		await autoCommitDirty(fakePath);

		const commitIdx = commitArgs.indexOf('commit');
		expect(commitIdx).toBeGreaterThan(-1);
		expect(commitArgs[commitIdx + 1]).toBe('-m');
		expect(commitArgs[commitIdx + 2]).toBe(
			'swarm-lane: auto-commit before cleanup',
		);
	});
});

// ---------------------------------------------------------------------------
// cleanUntrackedFiles
// ---------------------------------------------------------------------------

describe('cleanUntrackedFiles', () => {
	const fakePath = 'C:\\worktrees\\session-abc\\lane-1';

	test('returns { cleaned: true } when dry-run is empty and clean succeeds', async () => {
		// First call: dry-run (empty → nothing to clean), second call: actual clean
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // dry-run: empty
			return mockProc(0, '', ''); // clean: success
		};

		const result = await cleanUntrackedFiles(fakePath);

		expect(result).toEqual({ cleaned: true });
		expect(callCount).toBe(2);
	});

	test('returns { cleaned: true } when dry-run shows only safe-to-clean files', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				// dry-run: only generated/temp files
				return mockProc(
					0,
					'Would remove dist/bundle.js\nWould remove debug.log\nWould remove coverage/lcov.info\n',
					'',
				);
			}
			return mockProc(0, '', ''); // clean: success
		};

		const result = await cleanUntrackedFiles(fakePath);

		expect(result).toEqual({ cleaned: true });
		expect(callCount).toBe(2);
	});

	test('skips clean and returns error when dry-run shows source files', async () => {
		// Capture console.warn
		const warnCalls: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnCalls.push(args.join(' '));

		try {
			let callCount = 0;
			_internals.bunSpawn = () => {
				callCount++;
				// dry-run shows a .ts file (source code)
				return mockProc(
					0,
					'Would remove src/new-feature.ts\nWould remove debug.log\n',
					'',
				);
			};

			const result = await cleanUntrackedFiles(fakePath);

			expect(result).toEqual({
				cleaned: false,
				error:
					'untracked source files detected — skipping clean to prevent data loss',
			});
			// Actual clean should NOT have been called
			expect(callCount).toBe(1);
			// Warning should have been logged
			expect(warnCalls.length).toBe(1);
			expect(warnCalls[0]).toContain('src/new-feature.ts');
			expect(warnCalls[0]).toContain('Skipping clean');
		} finally {
			console.warn = origWarn;
		}
	});

	test('proceeds with clean when dry-run fails (fail-open)', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(1, '', 'dry-run error'); // dry-run fails
			return mockProc(0, '', ''); // clean proceeds
		};

		const result = await cleanUntrackedFiles(fakePath);

		expect(result).toEqual({ cleaned: true });
		expect(callCount).toBe(2);
	});

	test('returns { cleaned: false, error } when actual clean fails', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // dry-run: empty
			return mockProc(1, '', 'fatal: could not read logical configuration'); // clean fails
		};

		const result = await cleanUntrackedFiles(fakePath);

		expect(result).toEqual({
			cleaned: false,
			error: 'fatal: could not read logical configuration',
		});
	});

	test('skips clean when dry-run shows mixed safe and unsafe files', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			return mockProc(
				0,
				'Would remove src/utils/helper.ts\nWould remove build/output.js\nWould remove .tmp/cache.tmp\n',
				'',
			);
		};

		const result = await cleanUntrackedFiles(fakePath);

		expect(result).toEqual({
			cleaned: false,
			error:
				'untracked source files detected — skipping clean to prevent data loss',
		});
		// Actual clean should NOT have been called
		expect(callCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// assertCleanWorkingTree
// ---------------------------------------------------------------------------

describe('assertCleanWorkingTree', () => {
	const fakeDir = 'C:\\project-root';

	test('returns { clean: true } when both git status and git ls-files return empty', async () => {
		stubSpawn(0, '', ''); // both commands succeed with empty output

		const result = await assertCleanWorkingTree(fakeDir);

		expect(result).toEqual({ clean: true });
	});

	test('returns { clean: false, error } when git status --porcelain has output (uncommitted changes)', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, ' M modified.txt', '');
			return mockProc(0, '', ''); // ls-files clean
		};

		const result = await assertCleanWorkingTree(fakeDir);

		expect(result).toEqual({
			clean: false,
			error: expect.stringContaining('commit or stash'),
		});
	});

	test('returns { clean: false, error } when git ls-files has output (untracked files)', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // status clean
			return mockProc(0, 'untracked-file.txt', ''); // ls-files has untracked
		};

		const result = await assertCleanWorkingTree(fakeDir);

		expect(result).toEqual({
			clean: false,
			error: expect.stringContaining('commit or stash'),
		});
	});

	test('returns { clean: false, error } when git command fails (non-zero exit)', async () => {
		stubSpawn(128, '', 'fatal: not a git repository');

		const result = await assertCleanWorkingTree(fakeDir);

		expect(result).toMatchObject({ clean: false });
		expect(result).toHaveProperty('error');
		expect((result as { error: string }).error).toContain(
			'Unable to verify working tree cleanliness',
		);
	});

	test('error message mentions "commit or stash"', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, ' M src/file.ts', '');
			return mockProc(0, '', '');
		};

		const result = await assertCleanWorkingTree(fakeDir);

		expect(result).toMatchObject({ clean: false });
		expect((result as { error: string }).error).toContain('commit or stash');
	});
});

// ---------------------------------------------------------------------------
// checkPathBudget
// ---------------------------------------------------------------------------

describe('checkPathBudget', () => {
	test('non-Windows skips path budget check → always returns { ok: true }', async () => {
		_internals.platform = 'linux';

		// bunSpawn should NOT even be called on non-Windows
		let called = false;
		_internals.bunSpawn = () => {
			called = true;
			return mockProc(0, '', '');
		};

		const result = await checkPathBudget('C:\\very\\long\\path', 'C:\\project');

		expect(result).toEqual({ ok: true });
		expect(called).toBe(false);
	});

	test('Windows with short paths → returns { ok: true }', async () => {
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => 'false';

		// Short file paths in ls-files output
		_internals.bunSpawn = () => mockProc(0, 'src/index.ts\nREADME.md\n', '');

		const result = await checkPathBudget(
			'C:\\Users\\dev\\proj',
			'C:\\Users\\dev\\proj',
		);

		expect(result).toEqual({ ok: true });
	});

	test('Windows with paths exceeding budget → returns { ok: false } with computed details', async () => {
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => 'false';

		// A very long relative path that pushes total over 250
		const longRelativePath =
			'src/' + 'nested/deeply/'.repeat(12) + 'super-long-file-name.ts';
		_internals.bunSpawn = () =>
			mockProc(0, `short.ts\n${longRelativePath}\n`, '');

		// Use a worktree root long enough so total >= 250
		const longRoot =
			'C:\\Users\\developer\\projects\\my-enterprise-application\\.swarm-worktrees\\session-id\\lane-1';
		const result = await checkPathBudget(
			longRoot,
			'C:\\Users\\developer\\projects\\my-enterprise-application',
		);

		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain(
			'Total path budget exceeded',
		);
		expect((result as { error: string }).error).toContain(longRoot);
		expect((result as { suggestion: string }).suggestion).toContain(
			'worktree_dir',
		);
	});

	test('returns { ok: true } when git ls-files fails', async () => {
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => 'false';

		// git ls-files returns non-zero
		_internals.bunSpawn = () => mockProc(1, '', 'fatal: not a git repository');

		const result = await checkPathBudget('C:\\very\\long\\path', 'C:\\project');

		expect(result).toEqual({ ok: true });
	});

	test('returns { ok: true } when git ls-files returns empty', async () => {
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => 'false';

		_internals.bunSpawn = () => mockProc(0, '', '');

		const result = await checkPathBudget('C:\\very\\long\\path', 'C:\\project');

		expect(result).toEqual({ ok: true });
	});

	test('skips path budget when core.longpaths is true (even with long paths)', async () => {
		_internals.platform = 'win32';

		// core.longpaths = true → budget check skipped entirely
		_internals.getCoreLongPaths = async () => 'true';

		// bunSpawn should NOT be called if longpaths skips the budget
		let called = false;
		_internals.bunSpawn = () => {
			called = true;
			return mockProc(0, '', '');
		};

		// Use a very long worktree root that would normally exceed the budget
		const longRoot =
			'C:\\Users\\developer\\projects\\my-enterprise-application\\.swarm-worktrees\\session-id\\lane-1';
		const result = await checkPathBudget(
			longRoot,
			'C:\\Users\\developer\\projects\\my-enterprise-application',
		);

		expect(result).toEqual({ ok: true });
		expect(called).toBe(false);
	});

	test('still applies budget check when core.longpaths is false', async () => {
		_internals.platform = 'win32';

		// core.longpaths = false → budget check proceeds
		_internals.getCoreLongPaths = async () => 'false';

		// A very long relative path that pushes total over 250
		const longRelativePath =
			'src/' + 'nested/deeply/'.repeat(12) + 'super-long-file-name.ts';
		_internals.bunSpawn = () =>
			mockProc(0, `short.ts\n${longRelativePath}\n`, '');

		const longRoot =
			'C:\\Users\\developer\\projects\\my-enterprise-application\\.swarm-worktrees\\session-id\\lane-1';
		const result = await checkPathBudget(
			longRoot,
			'C:\\Users\\developer\\projects\\my-enterprise-application',
		);

		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain(
			'Total path budget exceeded',
		);
	});

	test('still applies budget check when core.longpaths throws (fail-safe)', async () => {
		_internals.platform = 'win32';

		// getCoreLongPaths throws → should be caught and budget check proceeds
		_internals.getCoreLongPaths = async () => {
			throw new Error('git config failed unexpectedly');
		};

		// A very long relative path that pushes total over 250
		const longRelativePath =
			'src/' + 'nested/deeply/'.repeat(12) + 'super-long-file-name.ts';
		_internals.bunSpawn = () =>
			mockProc(0, `short.ts\n${longRelativePath}\n`, '');

		const longRoot =
			'C:\\Users\\developer\\projects\\my-enterprise-application\\.swarm-worktrees\\session-id\\lane-1';
		const result = await checkPathBudget(
			longRoot,
			'C:\\Users\\developer\\projects\\my-enterprise-application',
		);

		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain(
			'Total path budget exceeded',
		);
	});

	test('still applies budget check when core.longpaths query fails (returns undefined)', async () => {
		_internals.platform = 'win32';

		// getCoreLongPaths returns undefined (query failed) → budget check proceeds
		_internals.getCoreLongPaths = async () => undefined;

		// A very long relative path that pushes total over 250
		const longRelativePath =
			'src/' + 'nested/deeply/'.repeat(12) + 'super-long-file-name.ts';
		_internals.bunSpawn = () =>
			mockProc(0, `short.ts\n${longRelativePath}\n`, '');

		const longRoot =
			'C:\\Users\\developer\\projects\\my-enterprise-application\\.swarm-worktrees\\session-id\\lane-1';
		const result = await checkPathBudget(
			longRoot,
			'C:\\Users\\developer\\projects\\my-enterprise-application',
		);

		expect(result).toMatchObject({ ok: false });
		expect((result as { error: string }).error).toContain(
			'Total path budget exceeded',
		);
	});
});

// ---------------------------------------------------------------------------
// shortenWorktreePath
// ---------------------------------------------------------------------------

describe('shortenWorktreePath', () => {
	test('returns tmpdir-based path with swwt prefix', () => {
		_internals.osTmpdir = () => 'C:\\Temp';
		_internals.platform = 'win32';

		const result = shortenWorktreePath('C:\\project', 'sess-1', 'lane-2');

		expect(result).toBe(path.join('C:\\Temp', 'swwt', 'sess-1', 'lane-2'));
	});

	test('returns correct path regardless of platform', () => {
		_internals.osTmpdir = () => '/tmp';
		_internals.platform = 'linux';

		const result = shortenWorktreePath('/project', 'sess-1', 'lane-2');

		expect(result).toBe(path.join('/tmp', 'swwt', 'sess-1', 'lane-2'));
	});
});

// ---------------------------------------------------------------------------
// provisionWorktree — path budget integration
// ---------------------------------------------------------------------------

describe('provisionWorktree — path budget (Windows)', () => {
	const fakeDir = 'C:\\project-root';
	const fakeLaneId = 'lane-1';
	const fakeSessionId = 'session-abc';

	test('auto-shortens on Windows when budget exceeded (no explicit worktree_dir)', async () => {
		_internals.platform = 'win32';
		_internals.osTmpdir = () => 'C:\\Temp';
		_internals.getCoreLongPaths = async () => 'false';

		// Construct a long relative path that will exceed budget with the default worktree root
		const longRelative = 'src/' + 'nested/deep/'.repeat(17) + 'abc.ts';
		let spawnCallCount = 0;
		_internals.bunSpawn = () => {
			spawnCallCount++;
			// Call 1: git ls-files for budget check (longRelative exceeds budget)
			if (spawnCallCount === 1) return mockProc(0, longRelative);
			// Call 2: git ls-files for re-check with shortened path
			if (spawnCallCount === 2) return mockProc(0, longRelative);
			// Call 3: git show-ref (branch doesn't exist yet)
			if (spawnCallCount === 3) return mockProc(1);
			// Call 4: git worktree add
			return mockProc(0);
		};

		const result = await provisionWorktree(
			fakeDir,
			fakeLaneId,
			fakeSessionId,
			{}, // no worktree_dir
		);

		expect(result).toHaveProperty('worktreePath');
		expect(typeof (result as { worktreePath: string }).worktreePath).toBe(
			'string',
		);
		expect(result).toHaveProperty('branchName');
		// The worktree path should be the shortened temp path
		expect(
			(result as { worktreePath: string }).worktreePath.toLowerCase(),
		).toContain('swwt');
	});

	test('warns but proceeds when budget exceeded AND worktree_dir is explicitly set', async () => {
		_internals.platform = 'win32';
		_internals.getCoreLongPaths = async () => 'false';

		// Long relative path that exceeds budget
		const longRelative = 'src/' + 'nested/deep/'.repeat(17) + 'abc.ts';
		let spawnCallCount = 0;
		_internals.bunSpawn = () => {
			spawnCallCount++;
			// Call 1: git ls-files for budget check (longRelative exceeds budget)
			if (spawnCallCount === 1) return mockProc(0, longRelative);
			// Call 2: git show-ref (branch doesn't exist)
			if (spawnCallCount === 2) return mockProc(1);
			// Call 3: git worktree add (success)
			return mockProc(0);
		};

		// Capture console.warn
		const warnCalls: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnCalls.push(args.join(' '));

		try {
			const config = { worktree_dir: 'D:\\explicit-trees' };
			const result = await provisionWorktree(
				fakeDir,
				fakeLaneId,
				fakeSessionId,
				config,
			);

			// Should succeed because user explicitly set worktree_dir
			expect(result).toHaveProperty('worktreePath');
			// Should have issued a warning
			expect(warnCalls.length).toBeGreaterThan(0);
			expect(warnCalls[0]).toContain('Path budget warning');
		} finally {
			console.warn = origWarn;
		}
	});
});

// ---------------------------------------------------------------------------
// _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals.bunSpawn', () => {
	test('_internals.bunSpawn can be replaced for testing', () => {
		// Confirm the seam exists and is initially the real function
		expect(typeof _internals.bunSpawn).toBe('function');

		// Replace with a no-op mock
		_internals.bunSpawn = () => mockProc(0, 'replaced', '');
		const result = _internals.bunSpawn();
		expect(result.exitCode).toBe(0);
		expect(result).toHaveProperty('exited');
		expect(result).toHaveProperty('kill');
	});
});

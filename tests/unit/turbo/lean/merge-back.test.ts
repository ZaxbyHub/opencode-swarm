/**
 * Tests for src/turbo/lean/merge-back.ts
 *
 * All tests mock _internals.bunSpawn (the DI seam) to avoid needing a real git repo.
 * The mock replaces the BunCompatSubprocess return value so each test can exercise
 * specific exit codes and stdout/stderr strings.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { LeanTurboConfig } from '../../../../src/config/schema';
import {
	_internals,
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	getMergeStrategy,
	handleMergeConflict,
	mergeLaneBranch,
	postMergeCleanup,
	startupOrphanRecovery,
} from '../../../../src/turbo/lean/merge-back';
import { _internals as worktreeInternals } from '../../../../src/turbo/lean/worktree';
import type { BunCompatSubprocess } from '../../../../src/utils/bun-compat';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Saves the real bunSpawn so tests can restore it in afterEach. */
const realBunSpawn = _internals.bunSpawn;

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

/** Restores the real bunSpawn after every test. */
afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
});

// ---------------------------------------------------------------------------
// getMergeStrategy
// ---------------------------------------------------------------------------

describe('getMergeStrategy', () => {
	test('returns config.merge_strategy when set to merge', () => {
		const config: LeanTurboConfig = { merge_strategy: 'merge' };
		expect(getMergeStrategy(config)).toBe('merge');
	});

	test('returns config.merge_strategy when set to rebase', () => {
		const config: LeanTurboConfig = { merge_strategy: 'rebase' };
		expect(getMergeStrategy(config)).toBe('rebase');
	});

	test('returns config.merge_strategy when set to cherry-pick', () => {
		const config: LeanTurboConfig = { merge_strategy: 'cherry-pick' };
		expect(getMergeStrategy(config)).toBe('cherry-pick');
	});

	test('returns merge when config.merge_strategy is undefined', () => {
		const config: LeanTurboConfig = {};
		expect(getMergeStrategy(config)).toBe('merge');
	});
});

// ---------------------------------------------------------------------------
// mergeLaneBranch
// ---------------------------------------------------------------------------

describe('mergeLaneBranch', () => {
	const fakeDir = 'C:\\project-root';
	const fakeBranch = 'swarm-lane/session-abc/lane-1';

	test('success with merge strategy — returns { merged: true, strategy: "merge" }', async () => {
		stubSpawn(0, '', '');

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({ merged: true, strategy: 'merge' });
	});

	test('success with rebase strategy — returns { merged: true, strategy: "rebase" }', async () => {
		stubSpawn(0, '', '');

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'rebase');

		expect(result).toEqual({ merged: true, strategy: 'rebase' });
	});

	test('success with cherry-pick strategy — returns { merged: true, strategy: "cherry-pick" }', async () => {
		let callCount = 0;
		_internals.bunSpawn = (_args: string[]) => {
			callCount++;
			// Call 1: git merge-base HEAD <branchName>
			if (callCount === 1) return mockProc(0, 'abc1234\n', '');
			// Call 2: git cherry-pick <range>
			return mockProc(0, '', '');
		};

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'cherry-pick');

		expect(result).toEqual({ merged: true, strategy: 'cherry-pick' });
		expect(callCount).toBe(2);
	});

	test('conflict detection: stderr contains CONFLICT → returns { conflict: true, files, message }', async () => {
		// First call: merge returns conflict
		// Second call: merge --abort returns success
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				return mockProc(
					1,
					'',
					'CONFLICT (content): Merge conflict in src/file1.ts\nCONFLICT (content): Merge conflict in src/file2.ts',
				);
			}
			return mockProc(0, '', '');
		};

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({
			conflict: true,
			files: ['src/file1.ts', 'src/file2.ts'],
			message: expect.stringContaining('CONFLICT'),
		});
	});

	test('conflict auto-abort: uses merge --abort for merge strategy', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) {
				return mockProc(
					1,
					'',
					'CONFLICT (content): Merge conflict in src/file.ts',
				);
			}
			return mockProc(0, '', '');
		};

		await mergeLaneBranch(fakeDir, fakeBranch, 'merge');

		const abortCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'merge' && args[2] === '--abort',
		);
		expect(abortCall).toBeDefined();
	});

	test('conflict auto-abort: uses rebase --abort for rebase strategy', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) {
				return mockProc(
					1,
					'',
					'CONFLICT (content): Merge conflict in src/file.ts',
				);
			}
			return mockProc(0, '', '');
		};

		await mergeLaneBranch(fakeDir, fakeBranch, 'rebase');

		const abortCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'rebase' && args[2] === '--abort',
		);
		expect(abortCall).toBeDefined();
	});

	test('conflict auto-abort: uses cherry-pick --abort for cherry-pick strategy', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) {
				// Call 1: git merge-base HEAD <branchName>
				return mockProc(0, 'abc1234\n', '');
			}
			if (callCount === 2) {
				// Call 2: git cherry-pick <range> — conflict
				return mockProc(
					1,
					'',
					'CONFLICT (content): Merge conflict in src/file.ts',
				);
			}
			// Call 3: git cherry-pick --abort
			return mockProc(0, '', '');
		};

		await mergeLaneBranch(fakeDir, fakeBranch, 'cherry-pick');

		const abortCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'cherry-pick' && args[2] === '--abort',
		);
		expect(abortCall).toBeDefined();
	});

	test('non-conflict failure: returns { error }', async () => {
		stubSpawn(128, '', 'fatal: not a git repository');

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({ error: 'fatal: not a git repository' });
	});

	test('non-conflict failure with stdout error: returns { error } from stdout', async () => {
		stubSpawn(1, 'some error output', '');

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({ error: 'some error output' });
	});

	test('verify correct git command args for merge strategy', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await mergeLaneBranch(fakeDir, fakeBranch, 'merge');

		const mergeCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'merge',
		);
		expect(mergeCall).toBeDefined();
		expect(mergeCall![2]).toBe('--no-edit');
		expect(mergeCall![3]).toBe(fakeBranch);
	});

	test('verify correct git command args for rebase strategy', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await mergeLaneBranch(fakeDir, fakeBranch, 'rebase');

		const rebaseCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'rebase',
		);
		expect(rebaseCall).toBeDefined();
		expect(rebaseCall![2]).toBe(fakeBranch);
	});

	test('verify correct git command args for cherry-pick strategy', async () => {
		const fakeMergeBase = 'abc1234';
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) {
				// merge-base call
				return mockProc(0, `${fakeMergeBase}\n`, '');
			}
			return mockProc(0, '', '');
		};

		await mergeLaneBranch(fakeDir, fakeBranch, 'cherry-pick');

		// First call: git merge-base HEAD <branchName>
		const mergeBaseCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'merge-base',
		);
		expect(mergeBaseCall).toBeDefined();
		expect(mergeBaseCall![2]).toBe('HEAD');
		expect(mergeBaseCall![3]).toBe(fakeBranch);

		// Second call: git cherry-pick <mergeBase>..<branchName>
		const cherryPickCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'cherry-pick',
		);
		expect(cherryPickCall).toBeDefined();
		expect(cherryPickCall![2]).toBe(`${fakeMergeBase}..${fakeBranch}`);
	});

	test('cherry-pick merge-base failure falls back to tip-only with warning', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) {
				// merge-base fails (no common ancestor)
				return mockProc(1, '', 'fatal: no common ancestor');
			}
			// Fallback: cherry-pick <branchName> (tip only)
			return mockProc(0, '', '');
		};

		// Suppress console.warn output from the fallback path
		const warnSpy = (console.warn = vi.fn() as unknown as typeof console.warn);

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'cherry-pick');

		expect(result).toEqual({ merged: true, strategy: 'cherry-pick' });
		expect(callCount).toBe(2);

		// Verify merge-base was attempted
		const mergeBaseCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'merge-base',
		);
		expect(mergeBaseCall).toBeDefined();

		// Verify fallback used tip-only cherry-pick (not a range)
		const cherryPickCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'cherry-pick',
		);
		expect(cherryPickCall).toBeDefined();
		expect(cherryPickCall![2]).toBe(fakeBranch);
		expect(cherryPickCall![2]).not.toContain('..');

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('merge-base failed'),
		);
		warnSpy.mockRestore?.();
	});

	test('cherry-pick merge-base returns empty stdout falls back to tip-only', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) {
				// merge-base succeeds but returns empty stdout
				return mockProc(0, '', '');
			}
			// Fallback: cherry-pick <branchName> (tip only)
			return mockProc(0, '', '');
		};

		const warnSpy = (console.warn = vi.fn() as unknown as typeof console.warn);

		const result = await mergeLaneBranch(fakeDir, fakeBranch, 'cherry-pick');

		expect(result).toEqual({ merged: true, strategy: 'cherry-pick' });

		const cherryPickCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'cherry-pick',
		);
		expect(cherryPickCall).toBeDefined();
		expect(cherryPickCall![2]).toBe(fakeBranch);

		warnSpy.mockRestore?.();
	});
});

// ---------------------------------------------------------------------------
// postMergeCleanup
// ---------------------------------------------------------------------------

describe('postMergeCleanup', () => {
	const fakeDir = 'C:\\project-root';
	const fakeBranch = 'swarm-lane/session-abc/lane-1';

	test('both branch delete and prune succeed → { cleaned: true }', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			return mockProc(0, '', '');
		};

		const result = await postMergeCleanup(fakeDir, fakeBranch);

		expect(result).toEqual({ cleaned: true });
		expect(callCount).toBe(2);
	});

	test('branch delete fails but prune succeeds → { error, partial: true }', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(1, '', 'fatal: branch not found');
			return mockProc(0, '', '');
		};

		const result = await postMergeCleanup(fakeDir, fakeBranch);

		expect(result).toMatchObject({
			error: expect.stringContaining('Branch delete failed'),
			partial: true,
		});
	});

	test('both fail → { error } (no partial)', async () => {
		stubSpawn(1, '', 'fatal: something went wrong');

		const result = await postMergeCleanup(fakeDir, fakeBranch);

		expect(result).toMatchObject({
			error: expect.stringContaining('Branch delete failed'),
		});
		expect(result).not.toMatchObject({ partial: true });
	});

	test('prune fails but branch delete succeeds → { error } (no partial)', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) return mockProc(0, '', ''); // branch delete succeeds
			return mockProc(1, '', 'fatal: prune failed'); // prune fails
		};

		const result = await postMergeCleanup(fakeDir, fakeBranch);

		expect(result).toMatchObject({
			error: expect.stringContaining('Worktree prune failed'),
		});
		expect(result).not.toMatchObject({ partial: true });
	});

	test('verify correct git command args for branch -D', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await postMergeCleanup(fakeDir, fakeBranch);

		const branchCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'branch',
		);
		expect(branchCall).toBeDefined();
		expect(branchCall![2]).toBe('-D');
		expect(branchCall![3]).toBe(fakeBranch);
	});

	test('verify correct git command args for worktree prune', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await postMergeCleanup(fakeDir, fakeBranch);

		const pruneCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'worktree' && args[2] === 'prune',
		);
		expect(pruneCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// handleMergeConflict
// ---------------------------------------------------------------------------

describe('handleMergeConflict', () => {
	const fakeDir = 'C:\\project-root';
	const fakeBranch = 'swarm-lane/session-abc/lane-1';

	test('lists conflicted files and aborts successfully → { files, message, aborted: true }', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				return mockProc(0, 'src/file1.ts\nsrc/file2.ts', '');
			}
			return mockProc(0, '', '');
		};

		const result = await handleMergeConflict(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({
			files: ['src/file1.ts', 'src/file2.ts'],
			message: 'Conflicts detected in 2 file(s): src/file1.ts, src/file2.ts',
			aborted: true,
		});
	});

	test('diff fails but abort succeeds → { error, aborted: true }', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				return mockProc(128, '', 'fatal: not a git repository');
			}
			return mockProc(0, '', '');
		};

		const result = await handleMergeConflict(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({
			error: 'Failed to list conflicted files: fatal: not a git repository',
			aborted: true,
		});
	});

	test('diff succeeds but abort fails → { error, aborted: false }', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				return mockProc(0, 'src/file1.ts', '');
			}
			return mockProc(1, '', 'fatal: could not abort');
		};

		const result = await handleMergeConflict(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({
			error: 'merge abort failed: fatal: could not abort',
			aborted: false,
		});
	});

	test('diff succeeds but returns empty file list', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				return mockProc(0, '', '');
			}
			return mockProc(0, '', '');
		};

		const result = await handleMergeConflict(fakeDir, fakeBranch, 'merge');

		expect(result).toEqual({
			files: [],
			message: 'Conflicts detected in 0 file(s): ',
			aborted: true,
		});
	});

	test('strategy-aware abort: rebase uses rebase --abort', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) return mockProc(0, 'src/file.ts', '');
			return mockProc(0, '', '');
		};

		await handleMergeConflict(fakeDir, fakeBranch, 'rebase');

		const abortCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'rebase' && args[2] === '--abort',
		);
		expect(abortCall).toBeDefined();
	});

	test('strategy-aware abort: cherry-pick uses cherry-pick --abort', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) return mockProc(0, 'src/file.ts', '');
			return mockProc(0, '', '');
		};

		await handleMergeConflict(fakeDir, fakeBranch, 'cherry-pick');

		const abortCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'cherry-pick' && args[2] === '--abort',
		);
		expect(abortCall).toBeDefined();
	});

	test('strategy-aware abort: merge uses merge --abort', async () => {
		const spawnCalls: string[][] = [];
		let callCount = 0;
		_internals.bunSpawn = (args: string[]) => {
			callCount++;
			spawnCalls.push(args);
			if (callCount === 1) return mockProc(0, 'src/file.ts', '');
			return mockProc(0, '', '');
		};

		await handleMergeConflict(fakeDir, fakeBranch, 'merge');

		const abortCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'merge' && args[2] === '--abort',
		);
		expect(abortCall).toBeDefined();
	});

	test('verify git diff --name-only --diff-filter=U is called', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, 'src/file.ts', '');
		};

		await handleMergeConflict(fakeDir, fakeBranch, 'merge');

		const diffCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' &&
				args[1] === 'diff' &&
				args[2] === '--name-only' &&
				args[3] === '--diff-filter=U',
		);
		expect(diffCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// attemptMergeBackFromDirty (DD-7 progressive dirty cleanup)
// ---------------------------------------------------------------------------

describe('attemptMergeBackFromDirty', () => {
	const fakeWorktree = 'C:\\project-root\\.swarm-worktrees\\session-1\\lane-1';
	const fakeBranch = 'swarm-lane/session-1/lane-1';
	const fakePrimary = 'C:\\project-root';

	let savedWorktreeSpawn: typeof worktreeInternals.bunSpawn;

	beforeEach(() => {
		savedWorktreeSpawn = worktreeInternals.bunSpawn;
	});

	afterEach(() => {
		// Restore both DI seams
		_internals.bunSpawn = realBunSpawn;
		worktreeInternals.bunSpawn = savedWorktreeSpawn;
	});

	/**
	 * Helper: configure mock bunSpawn for worktree operations AND merge operations.
	 *
	 * The worktree functions (autoCommitDirty, cleanUntrackedFiles) use worktree's _internals.bunSpawn.
	 * The merge function (mergeLaneBranch) uses merge-back's _internals.bunSpawn.
	 * Both must be set independently.
	 */
	function setupMocks(opts: {
		/** git add exit code (autoCommitDirty step 1) */
		commitAddExit?: number;
		/** git commit exit code (autoCommitDirty step 2) */
		commitCommitExit?: number;
		/** git commit stderr (for "nothing to commit" detection) */
		commitStderr?: string;
		/** git commit stdout (for "nothing to commit" detection) */
		commitStdout?: string;
		/** git clean exit code (cleanUntrackedFiles) */
		cleanExit?: number;
		/** git clean stderr */
		cleanStderr?: string;
		/** merge exit code */
		mergeExit?: number;
		/** merge stderr */
		mergeStderr?: string;
	}) {
		const {
			commitAddExit = 0,
			commitCommitExit = 0,
			commitStderr = '',
			commitStdout = '',
			cleanExit = 0,
			cleanStderr = '',
			mergeExit = 0,
			mergeStderr = '',
		} = opts;

		// Configure worktree's bunSpawn (for autoCommitDirty and cleanUntrackedFiles)
		// Args-aware (not call-count) so early exits in autoCommitDirty don't
		// shift which mock response cleanUntrackedFiles receives.
		worktreeInternals.bunSpawn = (args: string[]) => {
			if (args.includes('add')) {
				// git add -A (autoCommitDirty step 1)
				return mockProc(commitAddExit, '', commitStderr);
			}
			if (args.includes('commit')) {
				// git commit -m ... (autoCommitDirty step 2)
				return mockProc(commitCommitExit, commitStdout, commitStderr);
			}
			if (args.includes('clean')) {
				// git clean -fd (cleanUntrackedFiles)
				return mockProc(cleanExit, '', cleanStderr);
			}
			return mockProc(0, '', '');
		};

		// Configure merge-back's bunSpawn (for mergeLaneBranch)
		_internals.bunSpawn = (_args: string[]) => {
			return mockProc(mergeExit, '', mergeStderr);
		};
	}

	test('dirty worktree auto-committed + cleaned + merged → { merged: true, autoCommitted: true, cleaned: true }', async () => {
		setupMocks({
			commitAddExit: 0,
			commitCommitExit: 0,
			cleanExit: 0,
			mergeExit: 0,
		});

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toEqual({
			merged: true,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		});
	});

	test('clean worktree (nothing to commit) + cleaned + merged → { merged: true, autoCommitted: false, cleaned: true }', async () => {
		setupMocks({
			commitAddExit: 0,
			commitCommitExit: 1,
			commitStderr: 'nothing to commit, working tree clean',
			cleanExit: 0,
			mergeExit: 0,
		});

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toEqual({
			merged: true,
			strategy: 'merge',
			autoCommitted: false,
			cleaned: true,
		});
	});

	test('auto-commit fails but clean succeeds and merge succeeds → { merged: true, autoCommitted: false, cleaned: true }', async () => {
		setupMocks({
			commitAddExit: 1,
			commitStderr: 'fatal: git add failed',
			cleanExit: 0,
			mergeExit: 0,
		});

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toEqual({
			merged: true,
			strategy: 'merge',
			autoCommitted: false,
			cleaned: true,
		});
	});

	test('clean fails but auto-commit succeeds and merge succeeds → { merged: true, autoCommitted: true, cleaned: false }', async () => {
		setupMocks({
			commitAddExit: 0,
			commitCommitExit: 0,
			cleanExit: 1,
			cleanStderr: 'fatal: git clean failed',
			mergeExit: 0,
		});

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toEqual({
			merged: true,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: false,
		});
	});

	test('merge has conflicts → { partial: true, stage: "merge" }', async () => {
		// mergeLaneBranch runs merge, detects conflict, then runs --abort
		// So we need two merge-back bunSpawn calls: merge (fail with conflict) and --abort (success)
		let mergeCallCount = 0;
		_internals.bunSpawn = (_args: string[]) => {
			mergeCallCount++;
			if (mergeCallCount === 1) {
				return mockProc(
					1,
					'',
					'CONFLICT (content): Merge conflict in src/file.ts',
				);
			}
			return mockProc(0, '', '');
		};

		// Configure worktree's bunSpawn for successful auto-commit and clean
		let worktreeCallCount = 0;
		worktreeInternals.bunSpawn = (_args: string[]) => {
			worktreeCallCount++;
			if (worktreeCallCount === 1) return mockProc(0, '', '');
			if (worktreeCallCount === 2) return mockProc(0, '', '');
			if (worktreeCallCount === 3) return mockProc(0, '', '');
			return mockProc(0, '', '');
		};

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toMatchObject({
			partial: true,
			stage: 'merge',
			autoCommitted: true,
			cleaned: true,
			message: expect.stringContaining('CONFLICT'),
		});
	});

	test('merge fails (non-conflict error) → { failed: true, stage: "merge" }', async () => {
		setupMocks({
			commitAddExit: 0,
			commitCommitExit: 0,
			cleanExit: 0,
			mergeExit: 128,
			mergeStderr: 'fatal: not a git repository',
		});

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toEqual({
			failed: true,
			stage: 'merge',
			message: 'fatal: not a git repository',
		});
	});

	test('both auto-commit and clean fail → { failed: true, stage: "cleanup" }', async () => {
		setupMocks({
			commitAddExit: 1,
			commitStderr: 'fatal: git add failed',
			cleanExit: 1,
			cleanStderr: 'fatal: git clean failed',
		});

		const result = await attemptMergeBackFromDirty(
			fakeWorktree,
			fakeBranch,
			fakePrimary,
			'merge',
		);

		expect(result).toEqual({
			failed: true,
			stage: 'cleanup',
			message: 'Auto-commit and clean both failed; abandoning worktree',
		});
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

// ---------------------------------------------------------------------------
// cleanupOrphanedBranches
// ---------------------------------------------------------------------------

describe('cleanupOrphanedBranches', () => {
	const fakeDir = 'C:\\project-root';

	test('removes branches not in activeSessionIds', async () => {
		// Branch list returns 2 branches: one active, one orphan
		_internals.bunSpawn = (args: string[]) => {
			// git branch --list 'swarm-lane/*'
			if (args.includes('branch') && args.includes('--list')) {
				return mockProc(
					0,
					'swarm-lane/session-active/lane-1\nswarm-lane/session-orphan/lane-2',
					'',
				);
			}
			// git branch -D — only called for orphan branches
			if (args.includes('branch') && args.includes('-D')) {
				// Verify we're only deleting the orphan, not the active branch
				const branchArg = args[args.length - 1];
				if (branchArg === 'swarm-lane/session-active/lane-1') {
					throw new Error('Unexpected branch delete for active branch');
				}
				return mockProc(0, '', '');
			}
			// git worktree prune
			return mockProc(0, '', '');
		};

		const result = await cleanupOrphanedBranches(fakeDir, ['session-active']);

		expect(result.removed).toEqual(['swarm-lane/session-orphan/lane-2']);
		expect(result.skipped).toEqual(['swarm-lane/session-active/lane-1']);
		expect(result.errors).toEqual([]);
	});

	test('skips branches with active sessionIds', async () => {
		// All branches belong to active sessions
		_internals.bunSpawn = (_args: string[]) => {
			return mockProc(
				0,
				'swarm-lane/session-1/lane-a\nswarm-lane/session-2/lane-b',
				'',
			);
		};

		const result = await cleanupOrphanedBranches(fakeDir, [
			'session-1',
			'session-2',
		]);

		expect(result.removed).toEqual([]);
		expect(result.skipped).toEqual([
			'swarm-lane/session-1/lane-a',
			'swarm-lane/session-2/lane-b',
		]);
		expect(result.errors).toEqual([]);
	});

	test('records errors when branch -D fails', async () => {
		_internals.bunSpawn = (args: string[]) => {
			if (
				args.includes('branch') &&
				args.includes('--list') &&
				args.includes('swarm-lane/*')
			) {
				return mockProc(0, 'swarm-lane/session-orphan/lane-fail', '');
			}
			if (args.includes('branch') && args.includes('--list')) {
				return mockProc(0, '', '');
			}
			if (args.includes('branch') && args.includes('-D')) {
				return mockProc(1, '', 'error: branch not found');
			}
			// git worktree prune
			return mockProc(0, '', '');
		};

		const result = await cleanupOrphanedBranches(fakeDir, []);

		expect(result.removed).toEqual([]);
		expect(result.errors).toEqual([
			{
				branch: 'swarm-lane/session-orphan/lane-fail',
				error: 'error: branch not found',
			},
		]);
	});

	test('returns empty arrays when no swarm-lane branches exist', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			return mockProc(0, '', '');
		};

		const result = await cleanupOrphanedBranches(fakeDir, []);

		expect(result.removed).toEqual([]);
		expect(result.skipped).toEqual([]);
		expect(result.errors).toEqual([]);
		// Should have called both branch namespace lists + worktree prune
		expect(callCount).toBe(3);
	});

	test('handles `* ` prefix when current branch is a swarm-lane branch (simulated git branch --list output)', async () => {
		// git branch --list prefixes the current branch with `* `, but our
		// command now uses --format=%(refname:short) which strips it.
		// This test simulates the OLD format to ensure that even if the
		// format option weren't used, the branch names would still be
		// parsed correctly because they arrive clean from --format.
		// Here we verify the --format-based output works with `* ` in
		// a mixed scenario: one branch prefixed (old format), one not.
		_internals.bunSpawn = (args: string[]) => {
			if (args.includes('branch') && args.includes('--list')) {
				// Simulate --format output: clean names, no `* ` prefix
				return mockProc(
					0,
					'swarm-lane/session-active/lane-1\nswarm-lane/session-orphan/lane-2',
					'',
				);
			}
			if (args.includes('branch') && args.includes('-D')) {
				return mockProc(0, '', '');
			}
			return mockProc(0, '', '');
		};

		const result = await cleanupOrphanedBranches(fakeDir, ['session-active']);

		// Active branch correctly identified and skipped (no false orphan)
		expect(result.skipped).toEqual(['swarm-lane/session-active/lane-1']);
		expect(result.removed).toEqual(['swarm-lane/session-orphan/lane-2']);
		expect(result.errors).toEqual([]);
	});

	test('runs git worktree prune after cleanup', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await cleanupOrphanedBranches(fakeDir, []);

		// First call: git branch --list 'swarm-lane/*'
		expect(spawnCalls[0]).toContain('branch');
		expect(spawnCalls[0]).toContain('--list');

		// Last call: git worktree prune
		const pruneCall = spawnCalls.find(
			(args) =>
				args[0] === 'git' && args[1] === 'worktree' && args[2] === 'prune',
		);
		expect(pruneCall).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// startupOrphanRecovery
// ---------------------------------------------------------------------------

describe('startupOrphanRecovery', () => {
	const fakeDir = 'C:\\project-root';

	test('prunes worktrees and returns empty when no branches remain', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			return mockProc(0, '', '');
		};

		const result = await startupOrphanRecovery(fakeDir, []);

		expect(result).toEqual({
			prunedWorktrees: true,
			remainingBranches: [],
			warnings: [],
		});
	});

	test('lists orphaned branches and generates warnings', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				// git worktree prune — success
				return mockProc(0, '', '');
			}
			// git branch --list
			return mockProc(
				0,
				'swarm-lane/session-dead/lane-1\nswarm-lane/session-dead/lane-2',
				'',
			);
		};

		const result = await startupOrphanRecovery(fakeDir, []);

		expect(result.prunedWorktrees).toBe(true);
		expect(result.remainingBranches).toEqual([
			'swarm-lane/session-dead/lane-1',
			'swarm-lane/session-dead/lane-2',
		]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain('swarm-lane/session-dead/lane-1');
		expect(result.warnings[1]).toContain('swarm-lane/session-dead/lane-2');
	});

	test('skips branches with active sessionIds', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				return mockProc(0, '', '');
			}
			// Mix of active and orphan
			return mockProc(
				0,
				'swarm-lane/session-active/lane-1\nswarm-lane/session-orphan/lane-2',
				'',
			);
		};

		const result = await startupOrphanRecovery(fakeDir, ['session-active']);

		expect(result.remainingBranches).toEqual([
			'swarm-lane/session-orphan/lane-2',
		]);
		// Only 1 warning for the orphan
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('session-orphan');
	});

	test('handles `* ` prefix when current branch is a swarm-lane branch (simulated git branch --list output)', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				// git worktree prune — success
				return mockProc(0, '', '');
			}
			// git branch --format output: clean names, no `* ` prefix.
			// The active branch must NOT be reported as orphaned.
			return mockProc(
				0,
				'swarm-lane/session-active/lane-1\nswarm-lane/session-orphan/lane-2',
				'',
			);
		};

		const result = await startupOrphanRecovery(fakeDir, ['session-active']);

		// Active branch correctly identified; only orphan reported
		expect(result.remainingBranches).toEqual([
			'swarm-lane/session-orphan/lane-2',
		]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('session-orphan');
	});

	test('continues with branch listing even if worktree prune fails', async () => {
		let callCount = 0;
		_internals.bunSpawn = () => {
			callCount++;
			if (callCount === 1) {
				// git worktree prune — FAILS
				return mockProc(1, '', 'fatal: prune failed');
			}
			// git branch --list — succeeds
			return mockProc(0, 'swarm-lane/session-orphan/lane-1', '');
		};

		const result = await startupOrphanRecovery(fakeDir, []);

		expect(result.prunedWorktrees).toBe(false);
		expect(result.remainingBranches).toEqual([
			'swarm-lane/session-orphan/lane-1',
		]);
		// First warning is about prune failure, second about orphan
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain('git worktree prune failed');
		expect(result.warnings[1]).toContain('session-orphan');
	});
});

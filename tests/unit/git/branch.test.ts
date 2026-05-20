/**
 * Comprehensive tests for src/git/branch.ts
 * Tests all git branch management functions with mocked spawnSync
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Create mock function for spawnSync
let callIndex = 0;
let returnValues: Array<{ status: number; stdout: string; stderr: string }> =
	[];

const mockSpawnSync = mock(
	(command: string, args: string[], options: { cwd: string }) => {
		// console.log(`Mock call ${callIndex}: git ${args.join(' ')}`);
		const result = returnValues[callIndex] ?? {
			status: 0,
			stdout: '',
			stderr: '',
		};
		callIndex++;
		return result;
	},
);

// Mock the node:child_process module BEFORE importing branch
mock.module('node:child_process', () => ({
	spawnSync: mockSpawnSync,
}));

// Import AFTER mock setup
const branch = await import('../../../src/git/branch');

function setupMock(
	...values: Array<{ status: number; stdout: string; stderr: string }>
) {
	callIndex = 0;
	returnValues = values;
	mockSpawnSync.mockClear();
}

describe('Git Branch Module', () => {
	const testCwd = '/test/repo';

	beforeEach(() => {
		// Reset mock before each test
		callIndex = 0;
		returnValues = [];
		mockSpawnSync.mockClear();
	});

	describe('isGitRepo()', () => {
		test('returns true when git rev-parse succeeds', () => {
			setupMock({ status: 0, stdout: '.git', stderr: '' });

			const result = branch.isGitRepo(testCwd);

			expect(result).toBe(true);
		});

		test('returns false when git rev-parse fails (not a git repo)', () => {
			setupMock({ status: 128, stdout: '', stderr: 'not a git repo' });

			const result = branch.isGitRepo(testCwd);

			expect(result).toBe(false);
		});

		test('returns false when git command throws', () => {
			mockSpawnSync.mockImplementationOnce(() => {
				throw new Error('git not found');
			});

			const result = branch.isGitRepo(testCwd);

			expect(result).toBe(false);
		});
	});

	describe('getCurrentBranch()', () => {
		test('returns branch name correctly', () => {
			setupMock({ status: 0, stdout: '  main\n', stderr: '' });

			const result = branch.getCurrentBranch(testCwd);

			expect(result).toBe('main');
		});

		test('handles branch name with whitespace', () => {
			setupMock({ status: 0, stdout: '  feature/test-branch  \n', stderr: '' });

			const result = branch.getCurrentBranch(testCwd);

			expect(result).toBe('feature/test-branch');
		});

		test('throws error when not in a git repo', () => {
			setupMock({
				status: 128,
				stdout: '',
				stderr: 'fatal: not a git repository',
			});

			expect(() => branch.getCurrentBranch(testCwd)).toThrow();
		});
	});

	describe('createBranch()', () => {
		test('creates new branch when remote branch does not exist', () => {
			// First call: check remote branch (fails - doesn't exist)
			// Second call: create new branch (should succeed)
			// Using only 2 mock values to match the 2 git calls made
			setupMock(
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" }, // remote check fails
				{ status: 0, stdout: '', stderr: '' }, // checkout -b succeeds
			);

			// Should not throw - should create branch successfully
			branch.createBranch(testCwd, 'new-feature');

			// Verify mock was called at least once (for the successful checkout)
			expect(mockSpawnSync).toHaveBeenCalled();
		});

		test('checkout existing local branch when remote exists', () => {
			// First call: check remote branch (succeeds)
			// Second call: check local branch (succeeds)
			// Third call: checkout local branch
			setupMock(
				{ status: 0, stdout: 'abc123', stderr: '' },
				{ status: 0, stdout: 'abc123', stderr: '' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'existing-branch');

			expect(mockSpawnSync).toHaveBeenCalledTimes(3);
		});

		test('checkout from remote when local branch does not exist', () => {
			// First call: check remote branch (succeeds)
			// Second call: check local branch (fails)
			// Third call: checkout from remote
			setupMock(
				{ status: 0, stdout: 'abc123', stderr: '' },
				{ status: 128, stdout: '', stderr: 'fatal: invalid reference' },
				{ status: 0, stdout: '', stderr: '' },
			);

			branch.createBranch(testCwd, 'remote-branch');

			expect(mockSpawnSync).toHaveBeenCalledTimes(3);
		});

		test('respects custom remote parameter', () => {
			// First call: check upstream remote (fails)
			// Second call: create new branch (should succeed)
			setupMock(
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" },
				{ status: 0, stdout: '', stderr: '' },
			);

			// Should not throw - should create branch successfully
			branch.createBranch(testCwd, 'my-branch', 'upstream');

			expect(mockSpawnSync).toHaveBeenCalled();
		});
	});

	describe('getChangedFiles()', () => {
		test('returns array of changed files', () => {
			// First call: getDefaultBaseBranch (succeeds - origin/main)
			// Second call: diff --name-only
			setupMock(
				{ status: 0, stdout: '.git', stderr: '' },
				{ status: 0, stdout: 'file1.ts\nfile2.ts\nfile3.ts\n', stderr: '' },
			);

			const result = branch.getChangedFiles(testCwd);

			expect(result).toEqual(['file1.ts', 'file2.ts', 'file3.ts']);
		});

		test('returns empty array when no changes', () => {
			setupMock(
				{ status: 0, stdout: '.git', stderr: '' },
				{ status: 0, stdout: '', stderr: '' },
			);

			const result = branch.getChangedFiles(testCwd);

			expect(result).toEqual([]);
		});

		test('returns empty array and logs error on git failure', () => {
			setupMock(
				{ status: 0, stdout: '.git', stderr: '' },
				{ status: 128, stdout: '', stderr: 'fatal: ambiguous argument' },
			);

			const result = branch.getChangedFiles(testCwd);

			expect(result).toEqual([]);
		});

		test('uses provided branch instead of default', () => {
			// When a branch is provided, getDefaultBaseBranch is NOT called
			// Only the diff command is called with the provided branch
			setupMock(
				{ status: 0, stdout: 'modified.ts\n', stderr: '' }, // diff with develop
			);

			const result = branch.getChangedFiles(testCwd, 'develop');

			expect(result).toEqual(['modified.ts']);
		});

		test('filters out empty strings from split', () => {
			setupMock(
				{ status: 0, stdout: '.git', stderr: '' },
				{ status: 0, stdout: 'file1.ts\n\nfile2.ts\n\n', stderr: '' },
			);

			const result = branch.getChangedFiles(testCwd);

			expect(result).toEqual(['file1.ts', 'file2.ts']);
		});
	});

	describe('getDefaultBaseBranch()', () => {
		test('returns origin/main when it exists', () => {
			setupMock({ status: 0, stdout: 'abc123', stderr: '' });

			const result = branch.getDefaultBaseBranch(testCwd);

			expect(result).toBe('origin/main');
		});

		test('returns origin/master when main does not exist', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" },
				{ status: 0, stdout: 'abc123', stderr: '' },
			);

			const result = branch.getDefaultBaseBranch(testCwd);

			expect(result).toBe('origin/master');
		});

		test('falls back to origin/main when neither main nor master exist', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" },
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" },
			);

			const result = branch.getDefaultBaseBranch(testCwd);

			expect(result).toBe('origin/main');
		});
	});

	describe('stageFiles()', () => {
		test('stages specific files successfully', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['file1.ts', 'file2.ts']);

			expect(mockSpawnSync).toHaveBeenCalled();
		});

		test('stages single file', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, ['single-file.ts']);

			expect(mockSpawnSync).toHaveBeenCalled();
		});

		test('throws error when files array is empty', () => {
			expect(() => branch.stageFiles(testCwd, [])).toThrow(
				'files array cannot be empty. Use stageAll() to stage all files.',
			);
		});

		test('does not call git exec when files array is empty', () => {
			expect(() => branch.stageFiles(testCwd, [])).toThrow();
			// Verify mock was NOT called - call count should be 0
			expect(mockSpawnSync).toHaveBeenCalledTimes(0);
		});

		test('handles files with spaces in path', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageFiles(testCwd, [
				'path with spaces/file.ts',
				'another path/file.ts',
			]);

			expect(mockSpawnSync).toHaveBeenCalled();
		});
	});

	describe('stageAll()', () => {
		test('stages all files with git add .', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.stageAll(testCwd);

			expect(mockSpawnSync).toHaveBeenCalled();
		});

		test('throws error on git failure', () => {
			setupMock({ status: 128, stdout: '', stderr: 'fatal: could not stage' });

			expect(() => branch.stageAll(testCwd)).toThrow();
		});
	});

	describe('commitChanges()', () => {
		test('commits with message', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			branch.commitChanges(testCwd, 'feat: add new feature');

			expect(mockSpawnSync).toHaveBeenCalled();
		});

		test('commits with multi-line message', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			const multiLineMessage =
				'feat: add new feature\n\n- Added feature X\n- Fixed bug Y';
			branch.commitChanges(testCwd, multiLineMessage);

			expect(mockSpawnSync).toHaveBeenCalled();
		});

		test('throws error on commit failure', () => {
			setupMock({ status: 1, stdout: '', stderr: 'nothing to commit' });

			expect(() => branch.commitChanges(testCwd, 'test commit')).toThrow();
		});
	});

	describe('getCurrentSha()', () => {
		test('returns full commit SHA', () => {
			setupMock({ status: 0, stdout: 'abc123def456789', stderr: '' });

			const result = branch.getCurrentSha(testCwd);

			expect(result).toBe('abc123def456789');
		});

		test('trims whitespace from output', () => {
			setupMock({ status: 0, stdout: '  sha1234567890  \n', stderr: '' });

			const result = branch.getCurrentSha(testCwd);

			expect(result).toBe('sha1234567890');
		});

		test('throws error when not in git repo', () => {
			setupMock({
				status: 128,
				stdout: '',
				stderr: 'fatal: not a git repository',
			});

			expect(() => branch.getCurrentSha(testCwd)).toThrow();
		});
	});

	describe('hasUncommittedChanges()', () => {
		test('returns true when there are uncommitted changes', () => {
			setupMock({
				status: 0,
				stdout: ' M modified.ts\n?? untracked.ts\n',
				stderr: '',
			});

			const result = branch.hasUncommittedChanges(testCwd);

			expect(result).toBe(true);
		});

		test('returns false when working directory is clean', () => {
			setupMock({ status: 0, stdout: '', stderr: '' });

			const result = branch.hasUncommittedChanges(testCwd);

			expect(result).toBe(false);
		});

		test('returns false when status output is just whitespace', () => {
			setupMock({ status: 0, stdout: '   \n  \n', stderr: '' });

			const result = branch.hasUncommittedChanges(testCwd);

			expect(result).toBe(false);
		});

		test('detects staged changes', () => {
			setupMock({ status: 0, stdout: 'M  staged.ts\n', stderr: '' });

			const result = branch.hasUncommittedChanges(testCwd);

			expect(result).toBe(true);
		});
	});

	describe('Integration: Full git workflow', () => {
		test('complete workflow: check repo, create branch, stage, commit', () => {
			// isGitRepo
			setupMock({ status: 0, stdout: '.git', stderr: '' });
			expect(branch.isGitRepo(testCwd)).toBe(true);

			// getCurrentBranch
			setupMock({ status: 0, stdout: 'main', stderr: '' });
			expect(branch.getCurrentBranch(testCwd)).toBe('main');

			// createBranch - new branch: remote check fails (1), checkout -b succeeds (2)
			setupMock(
				{ status: 128, stdout: '', stderr: 'not found' }, // remote check fails
				{ status: 0, stdout: '', stderr: '' }, // checkout -b succeeds
			);
			branch.createBranch(testCwd, 'feature-branch');
			expect(mockSpawnSync).toHaveBeenCalled();

			// stageFiles
			setupMock({ status: 0, stdout: '', stderr: '' });
			branch.stageFiles(testCwd, ['new-file.ts']);

			// getCurrentSha before commit
			setupMock({ status: 0, stdout: 'abc123', stderr: '' });
			expect(branch.getCurrentSha(testCwd)).toBe('abc123');

			// hasUncommittedChanges before commit
			setupMock({ status: 0, stdout: 'M new-file.ts', stderr: '' });
			expect(branch.hasUncommittedChanges(testCwd)).toBe(true);

			// commitChanges
			setupMock({ status: 0, stdout: '', stderr: '' });
			branch.commitChanges(testCwd, 'feat: add new file');

			// hasUncommittedChanges after commit
			setupMock({ status: 0, stdout: '', stderr: '' });
			expect(branch.hasUncommittedChanges(testCwd)).toBe(false);
		});
	});

	describe('resetToRemoteBranch()', () => {
		// Call sequence in implementation:
		// 1. getCurrentBranch(cwd) -> gitExec(['rev-parse', '--abbrev-ref', 'HEAD'])
		// 2. detectDefaultRemoteBranch(cwd) -> gitExec(['symbolic-ref', 'refs/remotes/origin/HEAD'])
		// 3. hasUncommittedChanges(cwd) -> gitExec(['status', '--porcelain'])
		// 4. gitExec(['log', `${defaultRemoteBranch}..HEAD`, '--oneline'])
		// 5. gitExec(['fetch', '--prune', 'origin'])
		// 6. gitExec(['rev-parse', 'HEAD'])
		// 7. gitExec(['rev-parse', `${defaultRemoteBranch}`])
		// 8. gitExec(['checkout', currentBranch])
		// 9. gitExec(['reset', '--hard', defaultRemoteBranch])

		test('Happy path: symbolic-ref succeeds, clean worktree -> alignment succeeds', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty (no unpushed)
			// 5. fetch --prune
			// 6. rev-parse HEAD -> abc123
			// 7. rev-parse origin/main -> def456 (different)
			// 8. checkout main
			// 9. reset --hard main
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty = no unpushed)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 7. rev-parse origin/main (different)
				{ status: 0, stdout: '', stderr: '' }, // 8. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 9. reset --hard main
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(true);
			expect(result.alreadyAligned).toBe(false);
			expect(result.localBranch).toBe('main');
			expect(result.targetBranch).toBe('origin/main');
			// Verify reset --hard used the origin/ prefixed ref (index 8 is the reset call)
			expect(mockSpawnSync.mock.calls[8][1]).toContain('origin/main');
		});

		test('Already aligned: HEAD SHA matches remote -> returns alreadyAligned: true', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty
			// 5. fetch --prune
			// 6. rev-parse HEAD -> abc123
			// 7. rev-parse origin/main -> abc123 (SAME = aligned!)
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty = no unpushed)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'abc123', stderr: '' }, // 7. rev-parse origin/main (SAME!)
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(true);
			expect(result.alreadyAligned).toBe(true);
			expect(result.message).toBe('Already aligned with remote');
		});

		test('Uncommitted changes detected -> returns success: false', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> DIRTY!
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: ' M modified.ts\n', stderr: '' }, // 3. hasUncommittedChanges (DIRTY)
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toBe(
				'Cannot reset: uncommitted changes in working tree',
			);
		});

		test('Unpushed commits detected -> returns success: false', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> has unpushed commits
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: 'abc123 feat: some commit\n', stderr: '' }, // 4. log (has unpushed)
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toBe('Cannot reset: unpushed commits');
			// Verify log command used remote ref for range check (index 3 is the log call)
			expect(mockSpawnSync.mock.calls[3][1][1]).toContain('origin/main');
		});

		test('Detached HEAD -> returns success: false', () => {
			// 1. getCurrentBranch -> HEAD (detached!)
			setupMock({ status: 0, stdout: 'HEAD', stderr: '' }); // 1. getCurrentBranch (detached)

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toBe('Cannot reset: detached HEAD state');
		});

		test('symbolic-ref fails -> fallback to git config init.defaultBranch succeeds', () => {
			// 1. getCurrentBranch -> develop
			// 2. symbolic-ref -> FAILS
			// 3. config init.defaultBranch -> develop
			// 4. hasUncommittedChanges -> clean
			// 5. log -> empty
			// 6. fetch --prune
			// 7. rev-parse HEAD -> abc123
			// 8. rev-parse origin/develop -> def456 (different)
			// 9. checkout develop
			// 10. reset --hard develop
			setupMock(
				{ status: 0, stdout: 'develop', stderr: '' }, // 1. getCurrentBranch
				{ status: 128, stdout: '', stderr: 'not a symbolic ref' }, // 2. symbolic-ref (FAILS)
				{ status: 0, stdout: 'develop', stderr: '' }, // 3. config init.defaultBranch (succeeds)
				{ status: 0, stdout: '', stderr: '' }, // 4. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 5. log (empty)
				{ status: 0, stdout: '', stderr: '' }, // 6. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 7. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 8. rev-parse origin/develop (different)
				{ status: 0, stdout: '', stderr: '' }, // 9. checkout develop
				{ status: 0, stdout: '', stderr: '' }, // 10. reset --hard develop
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(true);
			expect(result.localBranch).toBe('develop');
			expect(result.targetBranch).toBe('origin/develop');
		});

		test('All detection methods fail -> returns success: false', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> FAILS
			// 3. config init.defaultBranch -> FAILS
			// 4. origin/main -> FAILS
			// 5. origin/master -> FAILS
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 128, stdout: '', stderr: 'not a symbolic ref' }, // 2. symbolic-ref (FAILS)
				{ status: 128, stdout: '', stderr: '' }, // 3. config init.defaultBranch (FAILS)
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" }, // 4. origin/main (FAILS)
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" }, // 5. origin/master (FAILS)
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toBe('Could not detect default remote branch');
		});

		test('Prune branches enabled -> prunes merged branches and gone upstream', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty
			// 5. fetch --prune
			// 6. rev-parse HEAD -> abc123
			// 7. rev-parse origin/main -> def456
			// 8. checkout main
			// 9. reset --hard main
			// 10. branch --merged
			// 11. branch -d merged-branch-1
			// 12. branch -d merged-branch-2
			// 13. branch -vv
			// 14. branch -d gone-branch
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 7. rev-parse origin/main
				{ status: 0, stdout: '', stderr: '' }, // 8. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 9. reset --hard main
				{
					status: 0,
					stdout: '  merged-branch-1\n  merged-branch-2\n* main\n',
					stderr: '',
				}, // 10. branch --merged
				{ status: 0, stdout: '', stderr: '' }, // 11. branch -d merged-branch-1
				{ status: 0, stdout: '', stderr: '' }, // 12. branch -d merged-branch-2
				{
					status: 0,
					stdout: '  gone-branch abc456 [origin/gone: gone] also gone\n',
					stderr: '',
				}, // 13. branch -vv
				{ status: 0, stdout: '', stderr: '' }, // 14. branch -d gone-branch
			);

			const result = branch.resetToRemoteBranch(testCwd, {
				pruneBranches: true,
			});

			expect(result.success).toBe(true);
			expect(result.prunedBranches.length).toBeGreaterThan(0);
		});

		test('Prune branches disabled (default) -> no pruning occurs', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty
			// 5. fetch --prune
			// 6. rev-parse HEAD -> abc123
			// 7. rev-parse origin/main -> def456
			// 8. checkout main
			// 9. reset --hard main
			// NO pruning calls because pruneBranches is not set
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 7. rev-parse origin/main
				{ status: 0, stdout: '', stderr: '' }, // 8. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 9. reset --hard main
			);

			const result = branch.resetToRemoteBranch(testCwd); // pruneBranches defaults to undefined

			expect(result.success).toBe(true);
			// No branch --merged or branch -vv calls should be made
			// Only 9 calls total (not 14 like with pruning)
			expect(mockSpawnSync).toHaveBeenCalledTimes(9);
		});

		test('Windows retry: reset fails twice then succeeds on third try', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty
			// 5. fetch --prune
			// 6. rev-parse HEAD -> abc123
			// 7. rev-parse origin/main -> def456
			// 8. checkout main
			// 9. reset --hard fail 1
			// 10. reset --hard fail 2
			// 11. reset --hard success 3
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 7. rev-parse origin/main
				{ status: 0, stdout: '', stderr: '' }, // 8. checkout main
				{ status: 1, stdout: '', stderr: 'unable to lock' }, // 9. reset --hard fail 1
				{ status: 1, stdout: '', stderr: 'unable to lock' }, // 10. reset --hard fail 2
				{ status: 0, stdout: '', stderr: '' }, // 11. reset --hard success 3
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(true);
			expect(mockSpawnSync).toHaveBeenCalledTimes(11);
		});

		test('Fetch failure -> returns success: false with fetch error', () => {
			// 1. getCurrentBranch -> main
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty
			// 5. fetch --prune -> FAILS!
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty)
				{ status: 128, stdout: '', stderr: 'fatal: unable to access' }, // 5. fetch --prune fails
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toContain('Fetch failed');
		});

		test('Feature branch scenario: user on feature branch, switches to default and resets', () => {
			// 1. getCurrentBranch -> feature-branch
			// 2. symbolic-ref -> refs/remotes/origin/main
			// 3. hasUncommittedChanges -> clean
			// 4. log -> empty
			// 5. fetch --prune
			// 6. rev-parse HEAD -> abc123
			// 7. rev-parse origin/main -> def456 (different from feature branch SHA)
			// 8. checkout feature-branch (current branch)
			// 9. reset --hard main
			setupMock(
				{ status: 0, stdout: 'feature-branch', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 7. rev-parse origin/main
				{ status: 0, stdout: '', stderr: '' }, // 8. checkout feature-branch
				{ status: 0, stdout: '', stderr: '' }, // 9. reset --hard main
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(true);
			expect(result.localBranch).toBe('feature-branch');
			expect(result.targetBranch).toBe('origin/main');
		});

		test('Handles unexpected error gracefully', () => {
			mockSpawnSync.mockImplementation(() => {
				throw new Error('unexpected error');
			});

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toContain('Unexpected error');
		});

		test('Returns correct result structure on success', () => {
			// Already aligned case - no reset needed
			setupMock(
				{ status: 0, stdout: 'main', stderr: '' }, // 1. getCurrentBranch
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 2. symbolic-ref
				{ status: 0, stdout: '', stderr: '' }, // 3. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 4. log (empty)
				{ status: 0, stdout: '', stderr: '' }, // 5. fetch --prune
				{ status: 0, stdout: 'abc123', stderr: '' }, // 6. rev-parse HEAD
				{ status: 0, stdout: 'abc123', stderr: '' }, // 7. rev-parse origin/main (same = aligned)
			);

			const result = branch.resetToRemoteBranch(testCwd);

			expect(result).toHaveProperty('success');
			expect(result).toHaveProperty('targetBranch');
			expect(result).toHaveProperty('localBranch');
			expect(result).toHaveProperty('message');
			expect(result).toHaveProperty('alreadyAligned');
			expect(result).toHaveProperty('prunedBranches');
			expect(result).toHaveProperty('warnings');
			expect(Array.isArray(result.prunedBranches)).toBe(true);
			expect(Array.isArray(result.warnings)).toBe(true);
		});
	});
});

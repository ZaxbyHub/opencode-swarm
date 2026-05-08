/**
 * Comprehensive tests for resetToMainAfterMerge() function.
 * Tests the aggressive git reset flow after a PR merge.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock state — module-level so each test can configure the sequence
// ---------------------------------------------------------------------------

type SpawnResult = { status: number; stdout: string; stderr: string };

let callIndex = 0;
let returnValues: SpawnResult[] = [];

// Track which git commands were called and in what order
const gitCalls: { args: string[]; cwd: string }[] = [];

const mockSpawnSync = mock(
	(command: string, args: string[], options: { cwd: string }) => {
		const result = returnValues[callIndex] ?? {
			status: 0,
			stdout: '',
			stderr: '',
		};
		gitCalls.push({ args: args as string[], cwd: options.cwd });
		callIndex++;
		return result;
	},
);

// Mock child_process BEFORE importing branch
mock.module('node:child_process', () => ({
	spawnSync: mockSpawnSync,
}));

// Import branch module AFTER mock setup
const branch = await import('../../../src/git/branch');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMock(...values: SpawnResult[]) {
	callIndex = 0;
	returnValues = values;
	gitCalls.length = 0;
	mockSpawnSync.mockClear();
}

function getGitCalls(): { args: string[]; cwd: string }[] {
	return [...gitCalls];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('resetToMainAfterMerge', () => {
	const testCwd = '/test/repo';

	beforeEach(() => {
		callIndex = 0;
		returnValues = [];
		gitCalls.length = 0;
		mockSpawnSync.mockClear();
	});

	// -------------------------------------------------------------------------
	// 1. Success: feature branch reset to main
	// -------------------------------------------------------------------------
	describe('1. Success: feature branch reset to main', () => {
		test('defaultBranch=main, currentBranch=feat/x, no unpushed commits, reset succeeds, branch deleted', () => {
			// 1.  detectDefaultRemoteBranch → symbolic-ref → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD (on feat/x, not main) → empty (no unpushed)
			// 4.  fetch --prune origin → ok
			// 5.  checkout main → ok
			// 6.  hasUncommittedChanges → clean
			// 7.  reset --hard origin/main → ok
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if merged
			// 8.  branch -d feat/x → ok
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log (no unpushed)
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. hasUncommittedChanges (clean)
				{ status: 0, stdout: '', stderr: '' }, // 7. reset --hard
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (feat/x is merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('feat/x');
			expect(result.branchDeleted).toBe(true);
			expect(result.changesDiscarded).toBe(false);
			expect(result.warnings).toEqual([]);
			expect(result.message).toContain('deleted branch feat/x');

			// Verify branch -d was called with correct branch name
			const deleteCall = gitCalls.find(
				(c) => c.args[0] === 'branch' && c.args[1] === '-d',
			);
			expect(deleteCall).toBeDefined();
			expect(deleteCall!.args[2]).toBe('feat/x');
		});
	});

	// -------------------------------------------------------------------------
	// 2. Success: already on main
	// -------------------------------------------------------------------------
	describe('2. Success: already on main', () => {
		test('currentBranch=main, no unpushed commits, reset succeeds, no branch deletion', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'main'
			// 3.  log origin/main..HEAD (on main) → empty
			// 4.  fetch --prune origin → ok
			// 5.  hasUncommittedChanges → clean  (no checkout needed since already on main)
			// 6.  reset --hard origin/main → ok
			// No branch deletion (already on main, switchedBranch=false)
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'main', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log (no unpushed)
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 6. reset --hard
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('main');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
			expect(result.warnings).toEqual([]);

			// Should NOT have called branch -D
			const deleteCall = gitCalls.find(
				(c) => c.args[0] === 'branch' && c.args[1] === '-D',
			);
			expect(deleteCall).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// 3. Failure: could not detect default branch
	// -------------------------------------------------------------------------
	describe('3. Failure: could not detect default branch', () => {
		test('detectDefaultRemoteBranch returns null (all methods fail)', () => {
			// 1. symbolic-ref → fail
			// 2. config init.defaultBranch → fail
			// 3. origin/main → fail
			// 4. origin/master → fail
			setupMock(
				{ status: 128, stdout: '', stderr: 'not a symbolic ref' }, // 1. symbolic-ref
				{ status: 128, stdout: '', stderr: '' }, // 2. config
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" }, // 3. origin/main
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" }, // 4. origin/master
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.targetBranch).toBe('');
			expect(result.message).toBe('Could not detect default remote branch');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 4. Failure: detached HEAD
	// -------------------------------------------------------------------------
	describe('4. Failure: detached HEAD', () => {
		test('getCurrentBranch returns HEAD', () => {
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'HEAD', stderr: '' }, // 2. getCurrentBranch → detached
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('HEAD');
			expect(result.message).toBe('Cannot reset: detached HEAD state');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 5. Failure: default branch has unpushed commits
	// -------------------------------------------------------------------------
	describe('5. Failure: default branch has unpushed commits', () => {
		test('currentBranch=main, git log shows unpushed commits', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'main'
			// 3.  log origin/main..HEAD (on main) → has unpushed commits
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'main', stderr: '' }, // 2. getCurrentBranch
				{
					status: 0,
					stdout: 'abc123 Feature A\ndef456 Feature B\n',
					stderr: '',
				}, // 3. log (has unpushed)
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('main');
			expect(result.message).toContain(
				'Cannot reset: main has unpushed commits',
			);
			expect(result.message).toContain('Push them first');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 6. Success: feature branch with unpushed commits (was pushed before)
	// -------------------------------------------------------------------------
	describe('6. Success: feature branch has unpushed commits', () => {
		test('currentBranch=feat/x, unpushed commits allowed — branch was pushed before', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD (on feat/x) → has unpushed (OK — has upstream)
			// 4.  fetch --prune origin → ok
			// 5.  checkout main → ok
			// 6.  hasUncommittedChanges → clean
			// 7.  reset --hard origin/main → ok
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if merged
			// 8.  branch -d feat/x → ok
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{
					status: 0,
					stdout: 'abc123 WIP feature\n',
					stderr: '',
				}, // 3. log (has unpushed but branch has upstream)
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 7. reset --hard
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (feat/x is merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('feat/x');
			expect(result.branchDeleted).toBe(true);
			expect(result.changesDiscarded).toBe(false);
			expect(result.warnings).toEqual([]);
			expect(result.message).toContain('deleted branch feat/x');
		});
	});

	// -------------------------------------------------------------------------
	// 7. Failure: local-only branch diverges from default
	// -------------------------------------------------------------------------
	describe('7. Failure: local-only branch diverges from default', () => {
		test('no upstream tracking, SHA mismatch between local and remote', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/local-only'
			// 3.  rev-parse --abbrev-ref feat/local-only@{upstream} → fail (no upstream)
			// 4.  rev-parse HEAD → 'abc123'
			// 5.  rev-parse origin/main → 'def456'  (SHA mismatch)
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/local-only', stderr: '' }, // 2. getCurrentBranch
				{ status: 128, stdout: '', stderr: 'fatal: ambiguous argument' }, // 3. log fails
				{ status: 0, stdout: 'abc123', stderr: '' }, // 4. rev-parse HEAD
				{ status: 0, stdout: 'def456', stderr: '' }, // 5. rev-parse origin/main
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('feat/local-only');
			expect(result.message).toContain('is local-only and diverges');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 8. Failure: checkout to main fails
	// -------------------------------------------------------------------------
	describe('8. Failure: checkout to main fails', () => {
		test('checkout throws after successful fetch', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune → ok
			// 5.  checkout main → FAIL
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log (no unpushed)
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{
					status: 1,
					stdout: '',
					stderr: 'error: pathspec did not match any file',
				}, // 5. checkout FAIL
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('feat/x');
			expect(result.message).toContain('Checkout to main failed');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 9. Failure: reset --hard fails
	// -------------------------------------------------------------------------
	describe('9. Failure: reset --hard fails', () => {
		test('reset throws after successful checkout', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune → ok
			// 5.  checkout main → ok
			// 6.  reset --hard origin/main → FAIL (no hasUncommittedChanges before reset)
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{
					status: 1,
					stdout: '',
					stderr: 'fatal: could not reset hash',
				}, // 6. reset FAIL
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.targetBranch).toBe('origin/main');
			expect(result.previousBranch).toBe('feat/x');
			expect(result.message).toContain('Reset to origin/main failed');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 10. changesDiscarded flag: true when discard succeeds
	// -------------------------------------------------------------------------
	describe('10. changesDiscarded flag: true when discard succeeds', () => {
		test('hasUncommittedChanges returns true, discard succeeds on first try', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune → ok
			// 5.  checkout main → ok
			// 6.  reset --hard origin/main → ok
			// 7.  hasUncommittedChanges → DIRTY (checked before discard loop)
			// 8.  checkout -- . → ok (discard)
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if merged
			// 8.  branch -d feat/x → ok
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. reset --hard
				{ status: 0, stdout: ' M modified.txt\n', stderr: '' }, // 7. hasUncommittedChanges (dirty)
				{ status: 0, stdout: '', stderr: '' }, // 8. checkout -- . (discard)
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (feat/x is merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.changesDiscarded).toBe(true);

			// Verify discard call was made
			const discardCall = gitCalls.find(
				(c) =>
					c.args[0] === 'checkout' && c.args[1] === '--' && c.args[2] === '.',
			);
			expect(discardCall).toBeDefined();
		});
	});

	// -------------------------------------------------------------------------
	// 11. changesDiscarded flag: false when discard fails (all retries exhausted)
	// -------------------------------------------------------------------------
	describe('11. changesDiscarded flag: false when discard fails', () => {
		test('hasUncommittedChanges returns true, discard fails all 4 retries', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune → ok
			// 5.  checkout main → ok
			// 6.  reset --hard origin/main → ok
			// 7.  hasUncommittedChanges → DIRTY (checked before discard loop)
			// 8.  checkout -- . → FAIL retry 1
			// 9.  checkout -- . → FAIL retry 2
			// 10. checkout -- . → FAIL retry 3
			// 11. checkout -- . → FAIL retry 4
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if merged
			// 8.  branch -d feat/x → ok
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. reset --hard
				{ status: 0, stdout: ' M modified.txt\n', stderr: '' }, // 7. hasUncommittedChanges (dirty)
				{ status: 1, stdout: '', stderr: 'unable to lock index' }, // 8. discard FAIL 1
				{ status: 1, stdout: '', stderr: 'unable to lock index' }, // 9. discard FAIL 2
				{ status: 1, stdout: '', stderr: 'unable to lock index' }, // 10. discard FAIL 3
				{ status: 1, stdout: '', stderr: 'unable to lock index' }, // 11. discard FAIL 4
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (feat/x is merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.changesDiscarded).toBe(false);
			expect(result.warnings).toContain(
				'Could not discard all uncommitted changes after reset',
			);
		});
	});

	// -------------------------------------------------------------------------
	// 12. Failure: fetch fails — hard gate
	// -------------------------------------------------------------------------
	describe('12. Failure: fetch fails — hard gate', () => {
		test('fetch throws, function fails immediately', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune origin → FAIL (hard gate)
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{
					status: 128,
					stdout: '',
					stderr: 'fatal: unable to access remote',
				}, // 4. fetch FAIL
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toContain('fetch failed');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 13. Warning: branch deletion fails — warning in result
	// -------------------------------------------------------------------------
	describe('13. Warning: branch deletion fails — warning in result', () => {
		test('branch -d throws, warning in result, success still true', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune → ok
			// 5.  checkout main → ok
			// 6.  hasUncommittedChanges → clean
			// 7.  reset --hard origin/main → ok
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if merged (returns merged list)
			// 8.  branch -d feat/x → FAIL (not fully merged)
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 7. reset --hard
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (feat/x appears merged)
				{
					status: 1,
					stdout: '',
					stderr: 'error: not fully merged',
				}, // 8. branch -d FAIL
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true); // Still succeeds despite branch deletion failure
			expect(result.branchDeleted).toBe(false);
			expect(
				result.warnings.some((w) =>
					w.includes('Could not delete branch feat/x'),
				),
			).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// 14. Prune branches option
	// -------------------------------------------------------------------------
	describe('14. Prune branches option', () => {
		test('pruneBranches=true, merged branches are deleted', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty
			// 4.  fetch --prune → ok
			// 5.  checkout main → ok
			// 6.  hasUncommittedChanges → clean
			// 7.  reset --hard origin/main → ok
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if feat/x is merged
			// 8.  branch -d feat/x → ok (previous branch deleted first)
			// 9.  branch --merged main → shows merged branches for pruning
			// 10. branch -d merged-branch-1 → ok
			// 11. branch -d merged-branch-2 → ok
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 7. reset --hard
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{
					status: 0,
					stdout: '  feat/x\n  merged-branch-1\n  merged-branch-2\n* main\n',
					stderr: '',
				}, // 8. branch --merged (all appear merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
				{
					status: 0,
					stdout: '  merged-branch-1\n  merged-branch-2\n* main\n',
					stderr: '',
				}, // 9. branch --merged (for prune)
				{ status: 0, stdout: '', stderr: '' }, // 10. branch -d merged-branch-1
				{ status: 0, stdout: '', stderr: '' }, // 11. branch -d merged-branch-2
			);

			const result = branch.resetToMainAfterMerge(testCwd, {
				pruneBranches: true,
			});

			expect(result.success).toBe(true);
			expect(result.branchDeleted).toBe(true);

			// Verify pruning calls were made (branch -d, not -D)
			const pruneCalls = gitCalls.filter(
				(c) => c.args[0] === 'branch' && c.args[1] === '-d',
			);
			expect(pruneCalls.length).toBe(3); // feat/x + 2 merged branches
			expect(pruneCalls[0].args[2]).toBe('feat/x');
			expect(pruneCalls[1].args[2]).toBe('merged-branch-1');
			expect(pruneCalls[2].args[2]).toBe('merged-branch-2');
		});

		test('pruneBranches=false (default), no pruning happens', () => {
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 7. reset --hard
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (check previous branch)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
			);

			const result = branch.resetToMainAfterMerge(testCwd); // no pruneBranches

			expect(result.success).toBe(true);

			// branch --merged IS called (Step 8 check for previous branch), but no pruning happens
			const mergedCall = gitCalls.find(
				(c) => c.args[0] === 'branch' && c.args[1] === '--merged',
			);
			expect(mergedCall).toBeDefined();
			expect(mergedCall!.args[2]).toBe('main'); // --merged main (default branch)

			// No additional branch --merged call for pruning (pruneBranches=false)
			const allMergedCalls = gitCalls.filter(
				(c) => c.args[0] === 'branch' && c.args[1] === '--merged',
			);
			expect(allMergedCalls.length).toBe(1); // Only the Step 8 check, not Step 9 prune
		});
	});

	// -------------------------------------------------------------------------
	// 15. Idempotency — running twice produces no errors
	// -------------------------------------------------------------------------
	describe('15. Idempotency — running twice produces no errors', () => {
		test('calling resetToMainAfterMerge twice consecutively does not error', () => {
			// First call
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' },
				{ status: 0, stdout: 'feat/x', stderr: '' },
				{ status: 0, stdout: '', stderr: '' }, // log
				{ status: 0, stdout: '', stderr: '' }, // fetch
				{ status: 0, stdout: '', stderr: '' }, // checkout main
				{ status: 0, stdout: '', stderr: '' }, // hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // reset
				{ status: 0, stdout: '', stderr: '' }, // clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // branch --merged
				{ status: 0, stdout: '', stderr: '' }, // branch -d
			);

			const result1 = branch.resetToMainAfterMerge(testCwd);
			expect(result1.success).toBe(true);

			// Second call — simulate being on main now
			callIndex = 0;
			returnValues = [
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // symbolic-ref
				{ status: 0, stdout: 'main', stderr: '' }, // getCurrentBranch (now on main)
				{ status: 0, stdout: '', stderr: '' }, // log
				{ status: 0, stdout: '', stderr: '' }, // fetch
				{ status: 0, stdout: '', stderr: '' }, // hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // reset
			];
			gitCalls.length = 0;
			mockSpawnSync.mockClear();

			const result2 = branch.resetToMainAfterMerge(testCwd);
			expect(result2.success).toBe(true);
			expect(result2.branchDeleted).toBe(false); // Already on main, nothing to delete
			expect(result2.warnings).toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// Result structure verification
	// -------------------------------------------------------------------------
	describe('Result structure: all fields present and types correct', () => {
		test('success result has correct field types', () => {
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' },
				{ status: 0, stdout: 'main', stderr: '' },
				{ status: 0, stdout: '', stderr: '' },
				{ status: 0, stdout: '', stderr: '' },
				{ status: 0, stdout: '', stderr: '' },
				{ status: 0, stdout: '', stderr: '' },
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(typeof result.success).toBe('boolean');
			expect(typeof result.targetBranch).toBe('string');
			expect(typeof result.previousBranch).toBe('string');
			expect(typeof result.message).toBe('string');
			expect(typeof result.branchDeleted).toBe('boolean');
			expect(typeof result.changesDiscarded).toBe('boolean');
			expect(Array.isArray(result.warnings)).toBe(true);
		});

		test('failure result has correct field types', () => {
			setupMock(
				{ status: 128, stdout: '', stderr: 'not a symbolic ref' },
				{ status: 128, stdout: '', stderr: '' },
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" },
				{ status: 128, stdout: '', stderr: "fatal: couldn't find remote ref" },
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(typeof result.success).toBe('boolean');
			expect(typeof result.targetBranch).toBe('string');
			expect(typeof result.previousBranch).toBe('string');
			expect(typeof result.message).toBe('string');
			expect(typeof result.branchDeleted).toBe('boolean');
			expect(typeof result.changesDiscarded).toBe('boolean');
			expect(Array.isArray(result.warnings)).toBe(true);

			expect(result.success).toBe(false);
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// Windows retry behavior
	// -------------------------------------------------------------------------
	describe('Windows retry behavior for discard', () => {
		test('discard succeeds on 3rd retry on Windows', () => {
			// On Windows, discard retries 4 times with busy-wait delay between
			// This test simulates the 3rd retry succeeding
			// New order: reset --hard runs BEFORE hasUncommittedChanges check
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. reset --hard
				{ status: 0, stdout: ' M dirty.txt\n', stderr: '' }, // 7. hasUncommittedChanges (dirty)
				{ status: 1, stdout: '', stderr: 'unable to lock' }, // 8. discard FAIL 1
				{ status: 1, stdout: '', stderr: 'unable to lock' }, // 9. discard FAIL 2
				{ status: 0, stdout: '', stderr: '' }, // 10. discard SUCCESS 3
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/x\n* main\n', stderr: '' }, // 8. branch --merged (feat/x is merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/x
			);

			// Simulate Windows behavior by temporarily patching process.platform
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', {
				value: 'win32',
				configurable: true,
			});

			const result = branch.resetToMainAfterMerge(testCwd);

			Object.defineProperty(process, 'platform', {
				value: originalPlatform,
				configurable: true,
			});

			expect(result.success).toBe(true);
			expect(result.changesDiscarded).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Edge case: SHA comparison when local-only branch matches remote SHA
	// -------------------------------------------------------------------------
	describe('Edge case: local-only branch that matches remote SHA', () => {
		test('no upstream tracking but SHA matches remote — succeeds', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/local'
			// 3.  log origin/main..HEAD → fail (no upstream)
			// 4.  rev-parse HEAD → 'abc123'
			// 5.  rev-parse origin/main → 'abc123'  (SAME SHA — diverged but same content)
			// 6.  fetch --prune → ok
			// 7.  checkout main → ok
			// 8.  hasUncommittedChanges → clean
			// 9.  reset --hard origin/main → ok
			// 7b. clean -fd → ok
			// 8.  branch --merged main → check if merged
			// 8.  branch -d feat/local → ok
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/local', stderr: '' }, // 2. getCurrentBranch
				{ status: 128, stdout: '', stderr: 'fatal: ambiguous argument' }, // 3. log fails
				{ status: 0, stdout: 'abc123', stderr: '' }, // 4. rev-parse HEAD
				{ status: 0, stdout: 'abc123', stderr: '' }, // 5. rev-parse origin/main (SAME!)
				{ status: 0, stdout: '', stderr: '' }, // 6. fetch
				{ status: 0, stdout: '', stderr: '' }, // 7. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 8. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 9. reset
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '  feat/local\n* main\n', stderr: '' }, // 8. branch --merged (feat/local is merged)
				{ status: 0, stdout: '', stderr: '' }, // 8. branch -d feat/local
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.branchDeleted).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Edge case: unable to compare SHA (both rev-parse fail)
	// -------------------------------------------------------------------------
	describe('Edge case: unable to compare SHA — both rev-parse fail', () => {
		test('local SHA rev-parse fails after upstream log fails', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → fail
			// 4.  rev-parse HEAD → fail
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 128, stdout: '', stderr: 'fatal: ambiguous argument' }, // 3. log fails
				{ status: 128, stdout: '', stderr: 'fatal: not a valid object' }, // 4. rev-parse HEAD fails
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(false);
			expect(result.message).toContain('unable to compare');
			expect(result.branchDeleted).toBe(false);
			expect(result.changesDiscarded).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// Branch not merged — kept with warning
	// -------------------------------------------------------------------------
	describe('Branch not merged — kept with warning', () => {
		test('branch has upstream but not merged into default — keeps branch with warning', () => {
			// 1.  detectDefaultRemoteBranch → 'main'
			// 2.  getCurrentBranch → 'feat/x'
			// 3.  log origin/main..HEAD → empty (or has upstream, proceed)
			// 4.  fetch --prune → ok
			// 5.  checkout main → ok
			// 6.  hasUncommittedChanges → clean
			// 7.  reset --hard origin/main → ok
			// 7b. clean -fd → ok
			// 8.  branch --merged main → only shows main (feat/x NOT merged)
			//     branch -d is NOT called since not merged
			setupMock(
				{ status: 0, stdout: 'refs/remotes/origin/main', stderr: '' }, // 1. symbolic-ref
				{ status: 0, stdout: 'feat/x', stderr: '' }, // 2. getCurrentBranch
				{ status: 0, stdout: '', stderr: '' }, // 3. log (no unpushed or branch has upstream)
				{ status: 0, stdout: '', stderr: '' }, // 4. fetch
				{ status: 0, stdout: '', stderr: '' }, // 5. checkout main
				{ status: 0, stdout: '', stderr: '' }, // 6. hasUncommittedChanges
				{ status: 0, stdout: '', stderr: '' }, // 7. reset --hard
				{ status: 0, stdout: '', stderr: '' }, // 7b. clean -fd
				{ status: 0, stdout: '* main\n', stderr: '' }, // 8. branch --merged (feat/x NOT listed)
			);

			const result = branch.resetToMainAfterMerge(testCwd);

			expect(result.success).toBe(true);
			expect(result.branchDeleted).toBe(false);
			expect(result.previousBranch).toBe('feat/x');
			expect(
				result.warnings.some((w) =>
					w.includes('is not merged into main — keeping it'),
				),
			).toBe(true);

			// Verify branch -d was NOT called
			const deleteCall = gitCalls.find(
				(c) => c.args[0] === 'branch' && c.args[1] === '-d',
			);
			expect(deleteCall).toBeUndefined();
		});
	});
});

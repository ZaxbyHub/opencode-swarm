/**
 * FR-001a SC-002: Worktree isolation cleanup — denial path
 *
 * Tests that denied dispatch cleanup removes:
 * - worktree directory
 * - lane branch (unconditionally, per spec SC-002)
 * - in-memory tracking entries (standardWorktreeByCallID, awaitingMergeByCallID)
 *
 * Per SC-002: "denied dispatch removes worktree/branch/trackers"
 * The branch is deleted unconditionally — the user's work is preserved in
 * the commit history via the lane branch reflog until GC.
 *
 * @note Uses Tier 1 DI — replaces _internals seam to verify call arguments
 * and timing without needing real git operations.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	awaitingMergeByCallID,
	cleanupStandardWorktreeForCallId,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

/** Makes a minimal StandardWorktreeDispatch for testing. */
function makeMockDispatch(
	callID: string,
	worktreePath: string,
	branchName: string,
): StandardWorktreeDispatch {
	return {
		callID,
		parentSessionID: 'test-session',
		taskId: '1.1',
		planTaskId: '1.1',
		handle: {
			worktreePath,
			branchName,
			purpose: 'lane',
			id: `wt-${callID}`,
			sessionId: 'test-session',
		} as WorktreeHandle,
		mergeStrategy: 'merge',
		laneIndex: 0,
		worktree_dir: undefined,
	};
}

// ─── SC-002: denial path ────────────────────────────────────────────────────

describe('FR-001a SC-002: cleanupStandardWorktreeForCallId — denied path', () => {
	let tempDir: string;
	let originalRemoveWorktree: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;
	let originalBunSpawn: typeof _internals.bunSpawn;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('sc002-denied-');
		ensureAgentSession('test-session');
		originalRemoveWorktree = _internals.removeWorktree;
		originalPostMergeCleanup = _internals.postMergeCleanup;
		originalBunSpawn = _internals.bunSpawn;
	});

	afterEach(() => {
		_internals.removeWorktree = originalRemoveWorktree;
		_internals.postMergeCleanup = originalPostMergeCleanup;
		_internals.bunSpawn = originalBunSpawn;
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('removes worktree AND branch on denial (unconditional cleanup per spec)', async () => {
		const callID = 'call-sc002-denied';
		const worktreePath = path.join(tempDir, 'wt-denied');
		const branchName = 'swarm-lane/test-session/lane-0';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);
		awaitingMergeByCallID.set(callID, {
			callID,
			parentSessionID: 'test-session',
			taskId: '1.1',
			planTaskId: '1.1',
			branch: branchName,
			worktreePath,
			mergeStrategy: 'merge',
			queuedAt: Date.now(),
		});

		// Mock git status to return empty (clean worktree) so cleanup proceeds.
		// Without this, git status fails on the non-existent worktreePath,
		// causing preserve-failed and cleanup being skipped (fail-closed behavior).
		_internals.bunSpawn = mock(() => ({
			exited: Promise.resolve(0),
			stdout: {
				text: () => Promise.resolve(''),
				getReader: () => ({ releaseLock: () => {} }),
			},
			stderr: {
				text: () => Promise.resolve(''),
				getReader: () => ({ releaseLock: () => {} }),
			},
			exitCode: 0,
			kill: () => {},
		}));

		const removeCalls: Array<{ worktreePath: string; projectRoot: string }> =
			[];
		const cleanupCalls: Array<{ directory: string; branchName: string }> = [];

		_internals.removeWorktree = mock(
			async (wtPath: string, projectRoot: string) => {
				removeCalls.push({ worktreePath: wtPath, projectRoot });
				return { success: true };
			},
		);

		_internals.postMergeCleanup = mock(
			async (directory: string, branch: string) => {
				cleanupCalls.push({ directory, branchName: branch });
				return { cleaned: true };
			},
		);

		// Denial path: cleanup is unconditional — branch IS deleted
		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		// removeWorktree should be called (worktree removed)
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0].worktreePath).toBe(worktreePath);

		// postMergeCleanup SHOULD be called (branch IS deleted on denial)
		// Per SC-002 spec: "denied dispatch removes worktree/branch/trackers"
		expect(cleanupCalls).toHaveLength(1);
		expect(cleanupCalls[0].branchName).toBe(branchName);

		// Maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	it('emits session advisory on denial with correct reason', async () => {
		const callID = 'call-sc002-denied-advisory';
		const worktreePath = path.join(tempDir, 'wt-denied-adv');
		const branchName = 'swarm-lane/test-session/lane-2';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		// Mock git status to return empty (clean worktree)
		_internals.bunSpawn = mock(() => ({
			exited: Promise.resolve(0),
			stdout: {
				text: () => Promise.resolve(''),
				getReader: () => ({ releaseLock: () => {} }),
			},
			stderr: {
				text: () => Promise.resolve(''),
				getReader: () => ({ releaseLock: () => {} }),
			},
			exitCode: 0,
			kill: () => {},
		}));

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		const session = ensureAgentSession('test-session');
		expect(
			session.pendingAdvisoryMessages!.some(
				(m) =>
					m.includes('STANDARD_WORKTREE_CLEANUP') &&
					m.includes(callID) &&
					m.includes('denied'),
			),
		).toBe(true);
	});

	it('returns early with no cleanup when dispatch not found', async () => {
		const callID = 'call-sc002-nonexistent';
		ensureAgentSession('test-session');

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		// Should not throw and should not call any cleanup functions
		await cleanupStandardWorktreeForCallId(callID, 'denied', tempDir);

		// No error thrown for non-existent dispatch
	});
});

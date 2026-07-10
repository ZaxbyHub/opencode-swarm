/**
 * FR-001a SC-003: Worktree isolation cleanup — cancellation path
 *
 * Tests that cancelled dispatch cleanup removes:
 * - worktree directory
 * - lane branch (unconditionally, per spec SC-003)
 * - in-memory tracking entries (standardWorktreeByCallID, awaitingMergeByCallID)
 *
 * Per SC-003: "cancelled dispatch removes worktree/branch/trackers"
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
	abortStandardWorktreeDispatch,
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

// ─── SC-003: cancellation path ───────────────────────────────────────────────

describe('FR-001a SC-003: abortStandardWorktreeDispatch — cancelled dispatch', () => {
	let tempDir: string;
	let originalRemoveWorktree: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;
	let originalBunSpawn: typeof _internals.bunSpawn;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('sc003-cancelled-');
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

	it('cleans up tracked dispatch: removes worktree AND branch on cancellation', async () => {
		const callID = 'call-sc003-cancelled';
		const worktreePath = path.join(tempDir, 'wt-cancelled');
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

		// Cancellation path via abortStandardWorktreeDispatch
		await abortStandardWorktreeDispatch(callID, 'cancelled', tempDir);

		// Worktree should be removed
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0].worktreePath).toBe(worktreePath);

		// Branch SHOULD ALSO be deleted on cancellation (unconditional cleanup per spec)
		// Per SC-003 spec: "cancelled dispatch removes worktree/branch/trackers"
		expect(cleanupCalls).toHaveLength(1);
		expect(cleanupCalls[0].branchName).toBe(branchName);

		// Maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	it('emits no-op advisory when dispatch not found (never provisioned)', async () => {
		const callID = 'call-sc003-noop';
		ensureAgentSession('test-session');

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		await abortStandardWorktreeDispatch(callID, 'cancelled', tempDir);

		// abortStandardWorktreeDispatch uses session 'unknown' when dispatch not found
		const unknownSession = ensureAgentSession('unknown');
		expect(
			unknownSession.pendingAdvisoryMessages!.some(
				(m) => m.includes('STANDARD_WORKTREE_ABORT_NOOP') && m.includes(callID),
			),
		).toBe(true);
	});

	it('returns early without error when dispatch not found', async () => {
		const callID = 'call-sc003-noop-noerror';
		ensureAgentSession('test-session');

		let threw = false;
		try {
			await abortStandardWorktreeDispatch(callID, 'cancelled', tempDir);
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	it('cleanupStandardWorktreeForCallId also deletes branch on cancelled directly', async () => {
		const callID = 'call-sc003-direct';
		const worktreePath = path.join(tempDir, 'wt-direct');
		const branchName = 'swarm-lane/test-session/lane-3';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		// Mock git status to return empty (clean worktree) so cleanup proceeds.
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

		// Can call cleanupStandardWorktreeForCallId directly with 'cancelled'
		await cleanupStandardWorktreeForCallId(callID, 'cancelled', tempDir);

		// Worktree should be removed
		expect(removeCalls).toHaveLength(1);

		// Branch should be deleted (unconditional)
		expect(cleanupCalls).toHaveLength(1);
		expect(cleanupCalls[0].branchName).toBe(branchName);

		// Maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
	});
});

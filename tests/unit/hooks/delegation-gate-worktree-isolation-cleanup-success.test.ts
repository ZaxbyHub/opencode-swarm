/**
 * FR-001a SC-001: Worktree isolation cleanup — success path
 *
 * Tests that successful dispatch cleanup removes:
 * - worktree directory
 * - lane branch
 * - in-memory tracking entries (standardWorktreeByCallID, awaitingMergeByCallID)
 *
 * Per SC-001: "successful dispatch leaves no worktree or branch behind"
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

// ─── SC-001: success path ────────────────────────────────────────────────────

describe('FR-001a SC-001: cleanupStandardWorktreeForCallId — success path', () => {
	let tempDir: string;
	let originalRemoveWorktree: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('sc001-cleanup-');
		ensureAgentSession('test-session');
		originalRemoveWorktree = _internals.removeWorktree;
		originalPostMergeCleanup = _internals.postMergeCleanup;
	});

	afterEach(() => {
		_internals.removeWorktree = originalRemoveWorktree;
		_internals.postMergeCleanup = originalPostMergeCleanup;
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('removes worktree and branch, clears tracking maps on success', async () => {
		const callID = 'call-sc001-success';
		const worktreePath = path.join(tempDir, 'wt-success');
		const branchName = 'swarm-lane/test-session/lane-0';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		// Simulate what rememberStandardWorktreeDispatch does
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
		// Production moves the dispatch to awaiting-merge before merge-back.
		standardWorktreeByCallID.delete(callID);

		// Spy on removeWorktree and postMergeCleanup
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

		await cleanupStandardWorktreeForCallId(callID, 'success', tempDir);

		// Verify removeWorktree was called with correct arguments
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0].worktreePath).toBe(worktreePath);
		expect(removeCalls[0].projectRoot).toBe(tempDir);

		// Verify postMergeCleanup was called (branch deleted on success)
		expect(cleanupCalls).toHaveLength(1);
		expect(cleanupCalls[0].branchName).toBe(branchName);

		// Verify maps are cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	it('emits session advisory on success', async () => {
		const callID = 'call-sc001-advisory';
		const worktreePath = path.join(tempDir, 'wt-advisory');
		const branchName = 'swarm-lane/test-session/lane-1';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		_internals.removeWorktree = mock(async () => ({ success: true }));
		_internals.postMergeCleanup = mock(async () => ({ cleaned: true }));

		await cleanupStandardWorktreeForCallId(callID, 'success', tempDir);

		const session = ensureAgentSession('test-session');
		expect(session.pendingAdvisoryMessages).toBeDefined();
		expect(
			session.pendingAdvisoryMessages!.some(
				(m) =>
					m.includes('STANDARD_WORKTREE_CLEANUP') &&
					m.includes(callID) &&
					m.includes('success'),
			),
		).toBe(true);
	});

	it('returns early with no-op advisory when dispatch not found', async () => {
		const callID = 'call-nonexistent';
		ensureAgentSession('test-session');

		_internals.removeWorktree = mock(async () => ({ success: true }));

		await cleanupStandardWorktreeForCallId(callID, 'success', tempDir);

		// Should NOT have called removeWorktree for non-existent dispatch
		// No error thrown
	});
});

// ─── Integration: finishStandardWorktreeDispatch unconditional cleanup ──────────

describe('FR-001a: finishStandardWorktreeDispatch cleanup on partial/failed merge', () => {
	let tempDir: string;
	let originalAttemptMergeBackFromDirty: typeof _internals.attemptMergeBackFromDirty;
	let originalRemoveWorktree: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('finish-std-');
		ensureAgentSession('test-session');
		originalAttemptMergeBackFromDirty = _internals.attemptMergeBackFromDirty;
		originalRemoveWorktree = _internals.removeWorktree;
		originalPostMergeCleanup = _internals.postMergeCleanup;
	});

	afterEach(async () => {
		_internals.attemptMergeBackFromDirty = originalAttemptMergeBackFromDirty;
		_internals.removeWorktree = originalRemoveWorktree;
		_internals.postMergeCleanup = originalPostMergeCleanup;
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('F-C004: partial merge preserves the worktree and branch for recovery', async () => {
		const callID = 'call-finish-partial';
		const worktreePath = path.join(tempDir, 'wt-partial');
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
		// Production moves the dispatch to awaiting-merge before merge-back.
		standardWorktreeByCallID.delete(callID);

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

		// Simulate partial merge result
		_internals.attemptMergeBackFromDirty = mock(async () => ({
			partial: true,
			stage: 'merge',
			autoCommitted: true,
			cleaned: false,
			message: 'Merge conflict in src/index.ts',
		}));

		// Import finishStandardWorktreeDispatch after mocks are set
		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		await finishStandardWorktreeDispatch(tempDir, dispatch, undefined, callID);

		// F-C004: a conflict can retain uncommitted state; do not force-remove it.
		expect(removeCalls).toHaveLength(0);
		expect(cleanupCalls).toHaveLength(0);

		// Maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	it('F-C004: cleanup-stage failure preserves the worktree and branch for recovery', async () => {
		const callID = 'call-finish-failed';
		const worktreePath = path.join(tempDir, 'wt-failed');
		const branchName = 'swarm-lane/test-session/lane-1';
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
		// Production moves the dispatch to awaiting-merge before merge-back.
		standardWorktreeByCallID.delete(callID);

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

		// Simulate failed merge result
		_internals.attemptMergeBackFromDirty = mock(async () => ({
			failed: true,
			stage: 'cleanup',
			message: 'Auto-commit and clean both failed',
		}));

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		await finishStandardWorktreeDispatch(tempDir, dispatch, undefined, callID);

		// F-C004: cleanup-stage failure may retain dirty work; do not force-remove it.
		expect(removeCalls).toHaveLength(0);
		expect(cleanupCalls).toHaveLength(0);

		// Maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});
});

// ─── Production-shape tests ────────────────────────────────────────────────────
// These model the REAL production sequence from delegation-gate.ts:1734-1757:
// 1. standardWorktreeByCallID.delete(callID) — removes from active map
// 2. awaitingMergeByCallID.set(callID, {...}) — adds to awaiting-merge map
// 3. finishStandardWorktreeDispatch(...) — calls cleanupStandardWorktreeForCallId
// The old tests left the dispatch in standardWorktreeByCallID, so they passed
// even though cleanup was broken in the real production flow.

describe('FR-001a: cleanupStandardWorktreeForCallId — awaiting-merge state (production shape)', () => {
	let tempDir: string;
	let originalRemoveWorktree: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;
	let originalAttemptMergeBackFromDirty: typeof _internals.attemptMergeBackFromDirty;
	let originalPreserveDirtyWorktreeForCallId: typeof _internals.preserveDirtyWorktreeForCallId;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = makeTempProject('prod-shape-');
		ensureAgentSession('test-session');
		originalRemoveWorktree = _internals.removeWorktree;
		originalPostMergeCleanup = _internals.postMergeCleanup;
		originalAttemptMergeBackFromDirty = _internals.attemptMergeBackFromDirty;
		originalPreserveDirtyWorktreeForCallId =
			_internals.preserveDirtyWorktreeForCallId;
	});

	afterEach(async () => {
		_internals.removeWorktree = originalRemoveWorktree;
		_internals.postMergeCleanup = originalPostMergeCleanup;
		_internals.attemptMergeBackFromDirty = originalAttemptMergeBackFromDirty;
		_internals.preserveDirtyWorktreeForCallId =
			originalPreserveDirtyWorktreeForCallId;
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('cleanupStandardWorktreeForCallId works when dispatch is in awaitingMergeByCallID (not active map)', async () => {
		// Production sequence part 1: put dispatch in standardWorktreeByCallID
		const callID = 'call-awaiting-merge';
		const worktreePath = path.join(tempDir, 'wt-awaiting');
		const branchName = 'swarm-lane/test-session/lane-awaiting';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		standardWorktreeByCallID.set(callID, dispatch);

		// Production sequence part 2: MOVE to awaitingMergeByCallID (like delegation-gate.ts:1741-1751)
		// In production: standardWorktreeByCallID.delete(callID) THEN awaitingMergeByCallID.set(...)
		standardWorktreeByCallID.delete(callID);
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

		// Verify dispatch is NOT in standardWorktreeByCallID (production state)
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		// Verify dispatch IS in awaitingMergeByCallID (production state)
		expect(awaitingMergeByCallID.has(callID)).toBe(true);

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

		// Production sequence part 3: call cleanupStandardWorktreeForCallId directly
		// (finishStandardWorktreeDispatch calls this internally)
		await cleanupStandardWorktreeForCallId(callID, 'success', tempDir);

		// Cleanup MUST have fired even though dispatch was in awaitingMergeByCallID
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0].worktreePath).toBe(worktreePath);

		expect(cleanupCalls).toHaveLength(1);
		expect(cleanupCalls[0].branchName).toBe(branchName);

		// Both maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	it('finishStandardWorktreeDispatch cleanup works when dispatch is in awaitingMergeByCallID (full production sequence)', async () => {
		const callID = 'call-finish-prod-seq';
		const worktreePath = path.join(tempDir, 'wt-finish-prod');
		const branchName = 'swarm-lane/test-session/lane-finish-prod';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		// Step 1: Put in standardWorktreeByCallID (like rememberStandardWorktreeDispatch)
		standardWorktreeByCallID.set(callID, dispatch);

		// Step 2: MOVE to awaitingMergeByCallID (production sequence: delegation-gate.ts:1741-1751)
		standardWorktreeByCallID.delete(callID);
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

		_internals.attemptMergeBackFromDirty = mock(async () => ({
			merged: true,
		}));

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// Step 3: Call finishStandardWorktreeDispatch (like production does at delegation-gate.ts:1752-1757)
		await finishStandardWorktreeDispatch(tempDir, dispatch, undefined, callID);

		// Cleanup MUST have fired
		expect(removeCalls).toHaveLength(1);
		expect(removeCalls[0].worktreePath).toBe(worktreePath);

		expect(cleanupCalls).toHaveLength(1);
		expect(cleanupCalls[0].branchName).toBe(branchName);

		// Both maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	// ─── Merge-back-exception fail-safe path ───────────────────────────────────
	// A merge-back rejection is converted into a typed failed settlement. The
	// lane remains available for recovery while both in-memory registries clear.

	it('failed settlement preserves the lane after merge-back rejection', async () => {
		const callID = 'call-merge-back-exception';
		const worktreePath = path.join(tempDir, 'wt-exception');
		const branchName = 'swarm-lane/test-session/lane-exception';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		// Put in standardWorktreeByCallID (dispatch is still HERE when merge-back throws)
		standardWorktreeByCallID.set(callID, dispatch);

		const removeCalls: Array<{ worktreePath: string; projectRoot: string }> =
			[];
		const cleanupCalls: Array<{ directory: string; branchName: string }> = [];

		// Preserve/remove/cleanup are not called: the lane remains recoverable.
		_internals.preserveDirtyWorktreeForCallId = mock(async () => ({
			outcome: 'clean' as const,
			preserved: false,
		}));

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

		// Simulate attemptMergeBackFromDirty throwing (typed failed settlement)
		_internals.attemptMergeBackFromDirty = mock(async () => {
			throw new Error('simulated merge-back failure');
		});

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		const settlement = await finishStandardWorktreeDispatch(
			tempDir,
			dispatch,
			undefined,
			callID,
		);

		expect(settlement.outcome).toBe('failed');
		expect(removeCalls).toHaveLength(0);
		expect(cleanupCalls).toHaveLength(0);

		// Both maps should be cleared
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});

	// ─── Awaiting-merge typed failure path ─────────────────────────────────────
	// A merge-back rejection clears the awaiting registry while preserving the
	// lane for recovery; no destructive abort is attempted.

	it('clears awaiting-merge state on typed merge-back failure', async () => {
		const callID = 'call-merge-back-abort-wiring';
		const worktreePath = path.join(tempDir, 'wt-abort-wiring');
		const branchName = 'swarm-lane/test-session/lane-abort-wiring';
		const dispatch = makeMockDispatch(callID, worktreePath, branchName);

		// Set up awaiting-merge state (dispatch already moved before merge-back)
		standardWorktreeByCallID.set(callID, dispatch);
		standardWorktreeByCallID.delete(callID);
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

		_internals.attemptMergeBackFromDirty = mock(async () => {
			throw new Error('merge-back failure for abort wiring test');
		});

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		const settlement = await finishStandardWorktreeDispatch(
			tempDir,
			dispatch,
			undefined,
			callID,
		);

		expect(settlement.outcome).toBe('failed');
		expect(standardWorktreeByCallID.has(callID)).toBe(false);
		expect(awaitingMergeByCallID.has(callID)).toBe(false);
	});
});

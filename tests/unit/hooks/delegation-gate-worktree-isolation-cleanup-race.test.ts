/**
 * F-FB013: Worktree cleanup must recheck preservation immediately before
 * destructive removal, so a write after an initial clean snapshot fails closed.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	cleanupStandardWorktreeForCallId,
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';

function makeDispatch(
	callID: string,
	worktreePath: string,
	branchName: string,
): StandardWorktreeDispatch {
	return {
		callID,
		parentSessionID: 'cleanup-race-session',
		taskId: '1.1',
		planTaskId: '1.1',
		handle: {
			worktreePath,
			branchName,
			purpose: 'lane',
			id: `wt-${callID}`,
			sessionId: 'cleanup-race-session',
		} as WorktreeHandle,
		mergeStrategy: 'merge',
		laneIndex: 0,
		worktree_dir: undefined,
	};
}

describe('F-FB013: cleanup final preservation check', () => {
	let tempDir: string;
	let originalPreserve: typeof _internals.preserveDirtyWorktreeForCallId;
	let originalRemove: typeof _internals.removeWorktree;
	let originalPostMergeCleanup: typeof _internals.postMergeCleanup;

	beforeEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-cleanup-race-')),
		);
		ensureAgentSession('cleanup-race-session');
		originalPreserve = _internals.preserveDirtyWorktreeForCallId;
		originalRemove = _internals.removeWorktree;
		originalPostMergeCleanup = _internals.postMergeCleanup;
	});

	afterEach(() => {
		_internals.preserveDirtyWorktreeForCallId = originalPreserve;
		_internals.removeWorktree = originalRemove;
		_internals.postMergeCleanup = originalPostMergeCleanup;
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('fails closed when a late write is discovered after the initial clean snapshot', async () => {
		const callID = 'call-fb013-clean-snapshot-race';
		const worktreePath = path.join(tempDir, 'lane');
		const branchName = 'swarm-lane/cleanup-race-session/1.1';
		standardWorktreeByCallID.set(
			callID,
			makeDispatch(callID, worktreePath, branchName),
		);

		let preservationChecks = 0;
		_internals.preserveDirtyWorktreeForCallId = mock(async () => {
			preservationChecks++;
			return preservationChecks === 1
				? { outcome: 'clean' as const, preserved: false as const }
				: {
						outcome: 'preserve-failed' as const,
						preserved: false as const,
						error: 'late write could not be committed',
					};
		});
		const removeWorktree = mock(async () => ({ success: true }));
		const postMergeCleanup = mock(async () => ({ cleaned: true }));
		_internals.removeWorktree = removeWorktree;
		_internals.postMergeCleanup = postMergeCleanup;

		await cleanupStandardWorktreeForCallId(callID, 'cancelled', tempDir);

		expect(preservationChecks).toBe(2);
		expect(removeWorktree).not.toHaveBeenCalled();
		expect(postMergeCleanup).not.toHaveBeenCalled();
		expect(
			ensureAgentSession('cleanup-race-session').pendingAdvisoryMessages?.some(
				(message) =>
					message.includes(
						'STANDARD_WORKTREE_PRESERVATION_FAILED_ABORT_CLEANUP',
					) && message.includes(callID),
			),
		).toBe(true);
	});
});

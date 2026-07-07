/**
 * /swarm lanes command — stale failure & retry isolation tests (FR-105: SC-115, SC-117)
 *
 * Tests for:
 * - SC-115: stale failure records (still in awaiting-merge) are not shown as conflicted
 * - SC-117: machine-parseable output for retry scenarios
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { handleLanesCommand } from '../../../src/commands/lanes';
import type {
	AwaitingMergeRecord,
	StandardWorktreeDispatch,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	awaitingMergeByCallID,
	_internals as isolationInternals,
	resetStandardWorktreeIsolationState,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	initDurableStatusPath,
	_internals as mergeStatusInternals,
	recordWorktreeMergeFailure,
} from '../../../src/hooks/delegation-gate/worktree-merge-status';
import type { WorktreeHandle } from '../../../src/worktree/types';

/** Minimal WorktreeHandle for test dispatches */
function makeHandle(overrides: Partial<WorktreeHandle> = {}): WorktreeHandle {
	return {
		worktreePath: '/tmp/wt-test-lane',
		branchName: 'lane/test',
		purpose: 'lane',
		id: 'wt-001',
		sessionId: 'session-001',
		...overrides,
	};
}

/**
 * Fabricate a dispatch into standardWorktreeByCallID (active lane).
 */
function addActiveDispatch(
	overrides: Partial<StandardWorktreeDispatch> = {},
): void {
	const dispatch: StandardWorktreeDispatch = {
		callID: `call-active-${standardWorktreeByCallID.size + 1}`,
		parentSessionID: 'session-001',
		taskId: '1.1',
		planTaskId: undefined,
		handle: makeHandle(),
		mergeStrategy: 'merge',
		...overrides,
	};
	standardWorktreeByCallID.set(dispatch.callID, dispatch);
}

/**
 * Fabricate a lane into awaitingMergeByCallID (awaiting-merge lane).
 */
function addAwaitingMergeDispatch(
	overrides: Partial<AwaitingMergeRecord> = {},
): void {
	const record: AwaitingMergeRecord = {
		callID: `call-await-${(isolationInternals.awaitingMergeByCallID.size ?? 0) + 1}`,
		parentSessionID: 'session-001',
		taskId: '2.1',
		planTaskId: '2.1',
		branch: 'lane/await',
		worktreePath: '/tmp/wt-await',
		mergeStrategy: 'merge',
		queuedAt: Date.now(),
		...overrides,
	};
	awaitingMergeByCallID.set(record.callID, record);
}

/**
 * Fabricate a conflicted lane: add to merge-status registry ONLY.
 */
function addConflictedDispatch(overrides: {
	taskId: string;
	planTaskId?: string;
	failure: {
		outcome: 'partial' | 'failed';
		stage: string;
		message: string;
		worktreePath?: string;
		branch?: string;
	};
}): void {
	recordWorktreeMergeFailure(overrides.taskId, {
		outcome: overrides.failure.outcome,
		stage: overrides.failure.stage,
		message: overrides.failure.message,
		worktreePath: overrides.failure.worktreePath,
		branch: overrides.failure.branch,
	});
}

describe('handleLanesCommand — stale failure & retry isolation', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'swarm-lanes-test-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Initialize durable status path so getWorktreeMergeFailure works
		initDurableStatusPath(tempDir);

		// Clear all registries
		resetStandardWorktreeIsolationState();
	});

	afterEach(async () => {
		// Reset all registries
		resetStandardWorktreeIsolationState();
		mergeStatusInternals.resetForTest();

		// Clean up temp directory
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// SC-115: stale failure record (still in awaiting-merge) is not shown as conflicted
	// -------------------------------------------------------------------------
	test('SC-115: awaiting-merge lane with stale merge-status shows no merge-outcome annotation', () => {
		// A lane that has a merge failure recorded from a PRIOR attempt, but is now
		// awaiting-merge again (retry in progress). The merge-status entry is stale.
		// The lane must appear as 'awaiting-merge' with NO [failed]/[partial] annotation
		// and mergeOutcome must be undefined.
		addAwaitingMergeDispatch({
			callID: 'call-retry-stale',
			taskId: '15.1',
			planTaskId: '15.1',
			worktreePath: '/tmp/wt-retry-stale',
			branch: 'lane/retry-stale',
		});

		// Simulate an earlier failed attempt for the same task
		addConflictedDispatch({
			taskId: '15.1',
			failure: {
				outcome: 'partial',
				stage: 'auto-commit',
				message: 'stale attempt data',
				worktreePath: '/tmp/wt-retry-stale-old',
				branch: 'lane/retry-stale-old',
			},
		});

		const textResult = handleLanesCommand(tempDir, []);
		const jsonResult = handleLanesCommand(tempDir, ['--json']);

		// Text output: appears as awaiting-merge, no stale [partial] annotation
		expect(textResult).toContain('## awaiting-merge (1)');
		expect(textResult).toContain('call-retry-stale');
		expect(textResult).not.toContain('[partial');
		expect(textResult).not.toContain('[failed');
		expect(textResult).toContain('Merge-back in progress');

		// JSON output: mergeOutcome is undefined for this lane
		const parsed = JSON.parse(jsonResult) as {
			lanes: Array<{
				state: string;
				laneId: string;
				mergeOutcome: unknown;
				recoveryHint: string;
			}>;
		};
		const retryLane = parsed.lanes.find((l) => l.laneId === 'call-retry-stale');
		expect(retryLane).toBeDefined();
		expect(retryLane!.state).toBe('awaiting-merge');
		expect(retryLane!.mergeOutcome).toBeUndefined();
		expect(retryLane!.recoveryHint).toBe(
			'Merge-back in progress; check `/swarm status` for the latest.',
		);
	});

	test('SC-115: failure record for a lane still in awaitingMergeByCallID is not shown as conflicted', () => {
		// A lane that has a failure recorded from a PRIOR attempt, but is now
		// awaiting-merge again (re-dispatched after partial failure).
		// The failure is stale — merge is in-progress — so it should NOT appear
		// as conflicted.
		addAwaitingMergeDispatch({
			callID: 'call-retry',
			taskId: '15.1',
			planTaskId: '15.1',
			worktreePath: '/tmp/wt-retry',
			branch: 'lane/retry',
		});

		// Simulate an earlier failed attempt for the same task
		addConflictedDispatch({
			taskId: '15.1',
			failure: {
				outcome: 'failed',
				stage: 'merge',
				message: 'earlier attempt',
				worktreePath: '/tmp/wt-retry-old',
				branch: 'lane/retry-old',
			},
		});

		const result = handleLanesCommand(tempDir, []);

		// Should appear as awaiting-merge (the active/retry state), NOT conflicted
		expect(result).toContain('## awaiting-merge (1)');
		expect(result).toContain('## conflicted (0)');
		expect(result).toContain('call-retry');
	});

	// -------------------------------------------------------------------------
	// Combined scenario: all three states together
	// -------------------------------------------------------------------------
	test('lists all three states correctly in same output', () => {
		// Active lane
		addActiveDispatch({
			callID: 'call-active-1',
			taskId: '9.1',
			planTaskId: '9.1',
			handle: makeHandle({
				worktreePath: '/tmp/wt-active',
				branchName: 'lane/active',
			}),
		});

		// Awaiting-merge lane
		addAwaitingMergeDispatch({
			callID: 'call-await-1',
			taskId: '9.2',
			planTaskId: '9.2',
			worktreePath: '/tmp/wt-await',
			branch: 'lane/await',
		});

		// Conflicted lane (failed) — ONLY in merge-status registry
		addConflictedDispatch({
			taskId: '9.3',
			failure: {
				outcome: 'failed',
				stage: 'merge',
				message: 'conflict',
				worktreePath: '/tmp/wt-conflict',
				branch: 'lane/conflict',
			},
		});

		const result = handleLanesCommand(tempDir, []);

		// Order should be: active (0), awaiting-merge (1), conflicted (2)
		const activeIdx = result.indexOf('## active');
		const awaitingIdx = result.indexOf('## awaiting-merge');
		const conflictedIdx = result.indexOf('## conflicted');

		expect(activeIdx).toBeGreaterThan(-1);
		expect(awaitingIdx).toBeGreaterThan(-1);
		expect(conflictedIdx).toBeGreaterThan(-1);

		// active < awaiting-merge < conflicted
		expect(awaitingIdx).toBeGreaterThan(activeIdx);
		expect(conflictedIdx).toBeGreaterThan(awaitingIdx);

		// Total count
		expect(result).toContain('Total: 3 lanes');

		// Conflicted lane has hint
		expect(result).toContain('hint:');
		expect(result).toContain('[failed @ merge]');
	});
});

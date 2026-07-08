/**
 * /swarm lanes command — edge case tests (FR-105)
 *
 * Tests verify edge cases:
 * - Empty state: all groups show (none) and Total: 0
 * - Multiple lanes for same taskId with different callIDs
 * - Conflicted lane with missing worktreePath (legacy records)
 * - Conflicted lane where stage === conflict
 * - Conflicted lane where outcome === partial
 * - Conflicted lane with unknown stage
 * - Active lane ordering relative to awaiting-merge and conflicted
 * - planTaskId vs taskId stale detection
 *
 * All tests use _internals DI seams — NO mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { LaneRecord } from '../../../src/commands/lanes';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parseJsonOutput(output: string): {
	lanes: LaneRecord[];
	totalCount: number;
} {
	return JSON.parse(output) as { lanes: LaneRecord[]; totalCount: number };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('handleLanesCommand — edge cases', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(tmpdir(), 'swarm-lanes-lifecycle-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		initDurableStatusPath(tempDir);
		resetStandardWorktreeIsolationState();
	});

	afterEach(async () => {
		resetStandardWorktreeIsolationState();
		mergeStatusInternals.resetForTest();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('Edge cases', () => {
		test('empty state: all groups show (none) and Total: 0', () => {
			const result = handleLanesCommand(tempDir, []);

			expect(result).toContain('## active (0)');
			expect(result).toContain('## awaiting-merge (0)');
			expect(result).toContain('## conflicted (0)');
			expect(result).toContain('Total: 0 lanes');

			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));
			expect(json.totalCount).toBe(0);
			expect(json.lanes).toEqual([]);
		});

		test('multiple lanes for same taskId with different callIDs are both shown and distinguished', () => {
			const taskId = 'SAME-TASK-ID';

			// Two different callIDs for the same taskId — both in awaiting-merge
			addAwaitingMergeDispatch({
				callID: 'call-same-a',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-same-a',
				branch: 'lane/same-a',
			});
			addAwaitingMergeDispatch({
				callID: 'call-same-b',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-same-b',
				branch: 'lane/same-b',
			});

			const result = handleLanesCommand(tempDir, []);
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			// Both callIDs appear
			expect(result).toContain('call-same-a');
			expect(result).toContain('call-same-b');

			// Two separate lanes with same taskId
			const sameTaskLanes = json.lanes.filter((l) => l.taskId === taskId);
			expect(sameTaskLanes.length).toBe(2);
			expect(sameTaskLanes[0].laneId).not.toBe(sameTaskLanes[1].laneId);

			// Each has its own worktreePath
			const paths = sameTaskLanes.map((l) => l.worktreePath);
			expect(paths).toContain('/tmp/wt-same-a');
			expect(paths).toContain('/tmp/wt-same-b');
		});

		test('conflicted lane with missing worktreePath: graceful fallback, no recovery hint path', () => {
			// Pre-extension record: only has outcome/stage/message
			(mergeStatusInternals.failuresByTask as Map<string, unknown>).set(
				'LEGACY-1',
				{
					outcome: 'failed',
					stage: 'merge',
					message: 'pre-extension record',
				},
			);

			const result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## conflicted (1)');
			expect(result).toContain('LEGACY-1');
			// recovery hint should still be present but without a path
			expect(result).toContain('hint:');
			expect(result).not.toContain('hint: Merge conflict at undefined');
			expect(result).not.toContain('hint: Merge conflict at '); // no trailing space with undefined

			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));
			expect(json.lanes[0].worktreePath).toBe('');
			expect(json.lanes[0].recoveryHint).toBeTruthy();
		});

		test('conflicted lane where stage === conflict: recovery hint mentions manual resolution', () => {
			addConflictedDispatch({
				taskId: 'STAGE-CONFLICT',
				failure: {
					outcome: 'failed',
					stage: 'conflict',
					message: 'unresolved merge conflicts',
					worktreePath: '/tmp/wt-stage-conflict',
					branch: 'lane/stage-conflict',
				},
			});

			const result = handleLanesCommand(tempDir, []);
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			const hint = json.lanes[0].recoveryHint;
			expect(hint).toContain('Merge conflict at');
			expect(hint).toContain('/tmp/wt-stage-conflict');
			expect(hint).toContain('Resolve manually');
			expect(result).toContain(
				'hint: Merge conflict at /tmp/wt-stage-conflict',
			);
		});

		test('conflicted lane where outcome === partial: recovery hint mentions stage and commit', () => {
			addConflictedDispatch({
				taskId: 'PARTIAL-STAGE',
				failure: {
					outcome: 'partial',
					stage: 'auto-commit',
					message: 'author unknown',
					worktreePath: '/tmp/wt-partial-stage',
					branch: 'lane/partial-stage',
				},
			});

			const result = handleLanesCommand(tempDir, []);
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			const hint = json.lanes[0].recoveryHint;
			expect(hint).toContain(
				'Partial merge preserved at /tmp/wt-partial-stage',
			);
			expect(hint).toContain('Stage and commit');
			expect(result).toContain(
				'hint: Partial merge preserved at /tmp/wt-partial-stage',
			);
		});

		test('conflicted lane with unknown stage: fallback recovery hint format', () => {
			addConflictedDispatch({
				taskId: 'UNKNOWN-STAGE',
				failure: {
					outcome: 'failed',
					stage: 'unknown-stage',
					message: 'something went wrong',
					worktreePath: '/tmp/wt-unknown',
					branch: 'lane/unknown',
				},
			});

			const result = handleLanesCommand(tempDir, []);
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			const hint = json.lanes[0].recoveryHint;
			expect(hint).toContain('Merge-back failed at stage "unknown-stage"');
			expect(hint).toContain('Manual review required');
		});

		test('active lane appears before awaiting-merge and conflicted in human-readable output', () => {
			addConflictedDispatch({
				taskId: 'Z-last',
				failure: { outcome: 'failed', stage: 'merge', message: 'z conflict' },
			});
			addAwaitingMergeDispatch({
				callID: 'Y-mid',
				taskId: 'Y-mid',
				planTaskId: 'Y-mid',
			});
			addActiveDispatch({
				callID: 'X-first',
				taskId: 'X-first',
				planTaskId: 'X-first',
			});

			const result = handleLanesCommand(tempDir, []);

			const activeIdx = result.indexOf('## active');
			const awaitingIdx = result.indexOf('## awaiting-merge');
			const conflictedIdx = result.indexOf('## conflicted');

			expect(activeIdx).toBeGreaterThan(-1);
			expect(awaitingIdx).toBeGreaterThan(-1);
			expect(conflictedIdx).toBeGreaterThan(-1);
			expect(activeIdx).toBeLessThan(awaitingIdx);
			expect(awaitingIdx).toBeLessThan(conflictedIdx);
		});

		test('lane with both planTaskId and taskId: planTaskId is used for stale detection', () => {
			const planTaskId = 'PLAN-TASK-1';
			const taskId = 'CODER-TASK-1';

			// A dispatch with both planTaskId and taskId
			addAwaitingMergeDispatch({
				callID: 'call-plan',
				taskId,
				planTaskId,
				worktreePath: '/tmp/wt-plan',
				branch: 'lane/plan',
			});

			// Record failure using planTaskId as the key (how Epic Rule 2 keys it)
			addConflictedDispatch({
				taskId: planTaskId, // same planTaskId as the awaiting-merge record
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'plan-keyed failure',
					worktreePath: '/tmp/wt-plan',
					branch: 'lane/plan',
				},
			});

			const result = handleLanesCommand(tempDir, []);

			// Failure should be filtered as stale because planTaskId matches
			expect(result).toContain('## conflicted (0)');
			expect(result).toContain('## awaiting-merge (1)');
		});

		test('lane with only taskId (no planTaskId): stale detection uses taskId', () => {
			const taskId = 'NO-PLAN-TASK';

			addAwaitingMergeDispatch({
				callID: 'call-no-plan',
				taskId,
				planTaskId: undefined,
				worktreePath: '/tmp/wt-no-plan',
				branch: 'lane/no-plan',
			});

			// Record failure with taskId
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'no plan keyed failure',
					worktreePath: '/tmp/wt-no-plan',
					branch: 'lane/no-plan',
				},
			});

			const result = handleLanesCommand(tempDir, []);

			// Failure filtered as stale because taskId matches
			expect(result).toContain('## conflicted (0)');
			expect(result).toContain('## awaiting-merge (1)');
		});
	});
});

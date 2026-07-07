/**
 * /swarm lanes command — lane state transition tests (FR-105: SC-114, SC-115, SC-116, SC-117)
 *
 * Tests verify lane state transitions: active → awaiting-merge → conflicted,
 * and retry isolation scenarios where old failures stay stale.
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

describe('handleLanesCommand — transitions & retry isolation', () => {
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

	// =========================================================================
	// SCENARIO 1: Real lifecycle e2e
	// Simulates the state transitions at delegation-gate.ts:1462-1480
	// =========================================================================

	describe('Real lifecycle e2e', () => {
		test('lane transitions: active → awaiting-merge → conflicted (partial)', () => {
			const callID = 'call-lifecycle-1';
			const taskId = 'LIF-1';

			// Step 1: active lane (coder dispatched, still running)
			addActiveDispatch({
				callID,
				taskId,
				planTaskId: taskId,
				handle: makeHandle({
					worktreePath: '/tmp/wt-lifecycle-1',
					branchName: 'lane/lifecycle-1',
				}),
			});

			let result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## active (1)');
			expect(result).toContain(`task=${taskId}`);
			// awaiting-merge and conflicted groups exist but are empty (0 count)
			expect(result).toContain('## awaiting-merge (0)');
			expect(result).toContain('## conflicted (0)');
			expect(result).not.toContain('## awaiting-merge (1)');
			expect(result).not.toContain('## conflicted (1)');

			// Step 2: transition to awaiting-merge (coder returned, merge-back started)
			// Simulate the transition at delegation-gate.ts:1469-1479
			const dispatch = standardWorktreeByCallID.get(callID)!;
			standardWorktreeByCallID.delete(callID);
			awaitingMergeByCallID.set(callID, {
				callID,
				parentSessionID: dispatch.parentSessionID,
				taskId: dispatch.taskId,
				planTaskId: dispatch.planTaskId,
				branch: dispatch.handle.branchName,
				worktreePath: dispatch.handle.worktreePath,
				mergeStrategy: dispatch.mergeStrategy,
				queuedAt: Date.now(),
			});

			result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## awaiting-merge (1)');
			expect(result).toContain(`task=${taskId}`);
			expect(result).toContain('Merge-back in progress');
			expect(result).not.toContain('[partial');
			expect(result).not.toContain('[failed');

			// Step 3: record a partial merge failure → conflicted
			// In real flow, finishStandardWorktreeDispatch removes callID from awaitingMergeByCallID
			// after recording the failure (delegation-gate.ts:1513). Simulate that cleanup here.
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'partial',
					stage: 'auto-commit',
					message: 'empty commit',
					worktreePath: '/tmp/wt-lifecycle-1',
					branch: 'lane/lifecycle-1',
				},
			});
			awaitingMergeByCallID.delete(callID);

			result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## awaiting-merge (0)'); // removed from awaiting-merge
			expect(result).toContain('## conflicted (1)');
			expect(result).toContain('[partial @ auto-commit]');
			expect(result).toContain('Partial merge preserved');
		});

		test('lane transitions: active → awaiting-merge → conflicted (failed/conflict)', () => {
			const callID = 'call-lifecycle-2';
			const taskId = 'LIF-2';

			addActiveDispatch({
				callID,
				taskId,
				planTaskId: taskId,
				handle: makeHandle({
					worktreePath: '/tmp/wt-lifecycle-2',
					branchName: 'lane/lifecycle-2',
				}),
			});

			// Transition to awaiting-merge
			const dispatch = standardWorktreeByCallID.get(callID)!;
			standardWorktreeByCallID.delete(callID);
			awaitingMergeByCallID.set(callID, {
				callID,
				parentSessionID: dispatch.parentSessionID,
				taskId: dispatch.taskId,
				planTaskId: dispatch.planTaskId,
				branch: dispatch.handle.branchName,
				worktreePath: dispatch.handle.worktreePath,
				mergeStrategy: dispatch.mergeStrategy,
				queuedAt: Date.now(),
			});

			let result = handleLanesCommand(tempDir, []);

			// Record a conflict failure
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'failed',
					stage: 'conflict',
					message: 'unresolved conflicts in src/a.ts',
					worktreePath: '/tmp/wt-lifecycle-2',
					branch: 'lane/lifecycle-2',
				},
			});
			// Simulate finishStandardWorktreeDispatch cleanup
			awaitingMergeByCallID.delete(callID);

			result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## conflicted (1)');
			expect(result).toContain('[failed @ conflict]');
			expect(result).toContain('hint: Merge conflict at /tmp/wt-lifecycle-2');

			// JSON output agrees with human-readable at every step
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));
			expect(json.totalCount).toBe(1);
			expect(json.lanes[0].state).toBe('conflicted');
			expect(json.lanes[0].taskId).toBe(taskId);
			expect(json.lanes[0].recoveryHint).toContain('Merge conflict at');
		});

		test('JSON agrees with human-readable at every lifecycle step', () => {
			const callID = 'call-json-agree';
			const taskId = 'JSON-AGREE';

			// Active
			addActiveDispatch({ callID, taskId, planTaskId: taskId });

			let text = handleLanesCommand(tempDir, []);
			let json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			expect(text).toContain('## active (1)');
			expect(json.totalCount).toBe(1);
			expect(json.lanes[0].state).toBe('active');
			expect(json.lanes[0].taskId).toBe(taskId);

			// Awaiting-merge
			const dispatch = standardWorktreeByCallID.get(callID)!;
			standardWorktreeByCallID.delete(callID);
			awaitingMergeByCallID.set(callID, {
				callID,
				parentSessionID: dispatch.parentSessionID,
				taskId: dispatch.taskId,
				planTaskId: dispatch.planTaskId,
				branch: dispatch.handle.branchName,
				worktreePath: dispatch.handle.worktreePath,
				mergeStrategy: dispatch.mergeStrategy,
				queuedAt: Date.now(),
			});

			text = handleLanesCommand(tempDir, []);
			json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			expect(text).toContain('## awaiting-merge (1)');
			expect(json.totalCount).toBe(1);
			expect(json.lanes[0].state).toBe('awaiting-merge');
			expect(json.lanes[0].mergeOutcome).toBeUndefined();

			// Conflicted
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'conflict',
					worktreePath: '/tmp/wt-agree',
					branch: 'lane/agree',
				},
			});
			// Simulate finishStandardWorktreeDispatch cleanup
			awaitingMergeByCallID.delete(callID);

			text = handleLanesCommand(tempDir, []);
			json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			expect(text).toContain('## conflicted (1)');
			expect(json.totalCount).toBe(1);
			expect(json.lanes[0].state).toBe('conflicted');
			expect(json.lanes[0].mergeOutcome?.outcome).toBe('failed');
		});
	});

	// =========================================================================
	// SCENARIO 2: Retry scenario
	// A task re-dispatched after partial failure: old failure must stay stale,
	// lane must NOT appear in conflicted group.
	// =========================================================================

	describe('Retry scenario — old failure stays stale', () => {
		test('partial failure + new awaiting-merge dispatch: lane NOT shown as conflicted', () => {
			const taskId = 'RETRY-1';

			// First attempt recorded a partial failure
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'partial',
					stage: 'auto-commit',
					message: 'empty commit on first attempt',
					worktreePath: '/tmp/wt-retry-first',
					branch: 'lane/retry-first',
				},
			});

			// New dispatch re-adds the taskId to awaitingMergeByCallID (retry in progress)
			addAwaitingMergeDispatch({
				callID: 'call-retry-new',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-retry-new',
				branch: 'lane/retry-new',
			});

			const result = handleLanesCommand(tempDir, []);

			// Conflicted group must NOT include RETRY-1 — the failure is stale
			// because a new dispatch is in awaitingMergeByCallID
			expect(result).toContain('## conflicted (0)');
			expect(result).not.toContain('[partial');

			// The lane must appear as awaiting-merge
			expect(result).toContain('## awaiting-merge (1)');
			expect(result).toContain('call-retry-new');

			// JSON output: same invariants
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));
			const conflictedLanes = json.lanes.filter(
				(l) => l.state === 'conflicted',
			);
			expect(conflictedLanes.length).toBe(0);

			const awaitingLanes = json.lanes.filter(
				(l) => l.state === 'awaiting-merge',
			);
			expect(awaitingLanes.length).toBe(1);
			expect(awaitingLanes[0].taskId).toBe(taskId);
			expect(awaitingLanes[0].mergeOutcome).toBeUndefined();
		});

		test('failed failure + new awaiting-merge dispatch: lane NOT shown as conflicted', () => {
			const taskId = 'RETRY-2';

			// First attempt recorded a failed
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'unresolved merge conflict',
					worktreePath: '/tmp/wt-retry2-first',
					branch: 'lane/retry2-first',
				},
			});

			// New dispatch in awaitingMergeByCallID
			addAwaitingMergeDispatch({
				callID: 'call-retry2-new',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-retry2-new',
				branch: 'lane/retry2-new',
			});

			const result = handleLanesCommand(tempDir, []);

			// The task must NOT appear as conflicted (failure is stale)
			expect(result).toContain('## conflicted (0)');
			expect(result).not.toContain('[failed');

			// Must appear as awaiting-merge
			expect(result).toContain('## awaiting-merge (1)');
			expect(result).toContain('call-retry2-new');
		});

		test('awaiting-merge dispatch + partial failure: no [partial] annotation shown', () => {
			const taskId = 'RETRY-3';

			// First: record partial failure for an earlier attempt
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'partial',
					stage: 'auto-commit',
					message: 'stale partial failure',
					worktreePath: '/tmp/wt-retry3-old',
					branch: 'lane/retry3-old',
				},
			});

			// New dispatch in awaitingMergeByCallID
			addAwaitingMergeDispatch({
				callID: 'call-retry3',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-retry3',
				branch: 'lane/retry3',
			});

			const text = handleLanesCommand(tempDir, []);
			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			// No [partial] annotation must appear anywhere in the human-readable output
			expect(text).not.toContain('[partial');
			expect(text).not.toContain('[failed');

			// mergeOutcome must be undefined for the awaiting-merge lane
			const retryLane = json.lanes.find((l) => l.taskId === taskId);
			expect(retryLane).toBeDefined();
			expect(retryLane!.state).toBe('awaiting-merge');
			expect(retryLane!.mergeOutcome).toBeUndefined();
			expect(retryLane!.recoveryHint).toBe(
				'Merge-back in progress; check `/swarm status` for the latest.',
			);
		});
	});
});

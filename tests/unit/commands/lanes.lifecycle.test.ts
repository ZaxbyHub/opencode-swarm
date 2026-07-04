/**
 * /swarm lanes command — lifecycle and edge-case verification tests (FR-105: SC-114, SC-115, SC-116, SC-117)
 *
 * These tests verify the complete lifecycle scenarios described in the acceptance
 * criteria, including: retry isolation, stale conflict cleanup, multi-lane with
 * same taskId, output determinism, and full lifecycle transitions.
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
	getAllWorktreeMergeFailures,
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
	const record: AwingMergeRecord = {
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

describe('handleLanesCommand — lifecycle & edge cases', () => {
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

	// =========================================================================
	// SCENARIO 3: Stale conflict cleanup
	// A failure is stale while taskId is in awaitingMergeByCallID;
	// once removed, the same failure makes the lane appear as conflicted.
	// =========================================================================

	describe('Stale conflict cleanup', () => {
		test('failure filtered while taskId in awaitingMergeByCallID; surfaces after removal', () => {
			const taskId = 'STALE-1';

			// Add to awaitingMergeByCallID
			addAwaitingMergeDispatch({
				callID: 'call-stale-1',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-stale-1',
				branch: 'lane/stale-1',
			});

			// Record failure — must be filtered (stale, taskId still in awaitingMergeByCallID)
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'conflict in src/b.ts',
					worktreePath: '/tmp/wt-stale-1',
					branch: 'lane/stale-1',
				},
			});

			let result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## conflicted (0)'); // filtered — stale
			expect(result).toContain('## awaiting-merge (1)');

			// Remove from awaitingMergeByCallID (simulating merge-back completed)
			awaitingMergeByCallID.delete('call-stale-1');

			// Re-record the failure — now it should appear as conflicted
			addConflictedDispatch({
				taskId,
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'conflict in src/b.ts',
					worktreePath: '/tmp/wt-stale-1',
					branch: 'lane/stale-1',
				},
			});

			result = handleLanesCommand(tempDir, []);
			expect(result).toContain('## conflicted (1)');
			expect(result).toContain('[failed @ merge]');
			expect(result).toContain('STALE-1');
		});

		test('same failure record: stale while in awaitingMergeByCallID, valid after removal', () => {
			const taskId = 'STALE-2';

			// Add to awaitingMergeByCallID
			addAwaitingMergeDispatch({
				callID: 'call-stale-2',
				taskId,
				planTaskId: taskId,
				worktreePath: '/tmp/wt-stale-2',
				branch: 'lane/stale-2',
			});

			// Record partial failure — stale
			recordWorktreeMergeFailure(taskId, {
				outcome: 'partial',
				stage: 'commit',
				message: 'partial on stale attempt',
				worktreePath: '/tmp/wt-stale-2',
				branch: 'lane/stale-2',
			});

			let json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));
			expect(json.lanes.filter((l) => l.state === 'conflicted').length).toBe(0);

			// Remove from awaitingMergeByCallID
			awaitingMergeByCallID.delete('call-stale-2');

			json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));
			const conflicted = json.lanes.filter((l) => l.state === 'conflicted');
			expect(conflicted.length).toBe(1);
			expect(conflicted[0].taskId).toBe(taskId);
			expect(conflicted[0].mergeOutcome?.outcome).toBe('partial');
		});
	});

	// =========================================================================
	// SCENARIO 4: Output stability / determinism
	// Complex state with multiple lanes in all three states; output must be
	// byte-identical across two calls.
	// =========================================================================

	describe('Output stability / determinism', () => {
		test('complex state: multiple lanes in all three states, output is byte-identical', () => {
			// 2 active lanes
			addActiveDispatch({
				callID: 'active-a',
				taskId: 'A-1',
				planTaskId: 'A-1',
			});
			addActiveDispatch({
				callID: 'active-b',
				taskId: 'A-2',
				planTaskId: 'A-2',
			});

			// 2 awaiting-merge lanes
			addAwaitingMergeDispatch({
				callID: 'await-c',
				taskId: 'B-1',
				planTaskId: 'B-1',
			});
			addAwaitingMergeDispatch({
				callID: 'await-d',
				taskId: 'B-2',
				planTaskId: 'B-2',
			});

			// 2 conflicted lanes
			addConflictedDispatch({
				taskId: 'C-1',
				failure: { outcome: 'failed', stage: 'merge', message: 'conflict 1' },
			});
			addConflictedDispatch({
				taskId: 'C-2',
				failure: { outcome: 'partial', stage: 'commit', message: 'partial 1' },
			});

			const first = handleLanesCommand(tempDir, []);
			const second = handleLanesCommand(tempDir, []);

			// Byte-identical
			expect(first).toBe(second);

			// Correct count
			expect(first).toContain('## active (2)');
			expect(first).toContain('## awaiting-merge (2)');
			expect(first).toContain('## conflicted (2)');
			expect(first).toContain('Total: 6 lanes');
		});

		test('complex state JSON: byte-identical across two calls', () => {
			addActiveDispatch({
				callID: 'json-active-1',
				taskId: 'J-1',
				planTaskId: 'J-1',
			});
			addAwaitingMergeDispatch({
				callID: 'json-await-1',
				taskId: 'J-2',
				planTaskId: 'J-2',
			});
			addConflictedDispatch({
				taskId: 'J-3',
				failure: {
					outcome: 'failed',
					stage: 'merge',
					message: 'conflict json',
				},
			});

			const first = handleLanesCommand(tempDir, ['--json']);
			const second = handleLanesCommand(tempDir, ['--json']);

			expect(first).toBe(second);

			const parsed = parseJsonOutput(first);
			expect(parsed.totalCount).toBe(3);
			expect(parsed.lanes.length).toBe(3);

			// Field order must be stable (JSON.stringify preserves definition order;
			// undefined fields like mergeOutcome are omitted so we check non-optional fields)
			const keys = Object.keys(parsed.lanes[0]);
			expect(keys).toEqual([
				'state',
				'laneId',
				'branch',
				'worktreePath',
				'taskId',
				'planTaskId',
				'parentSessionID',
				'mergeStrategy',
				'recoveryHint',
			]);
		});

		test('repeated calls produce byte-identical output — no timestamps leak', () => {
			addAwaitingMergeDispatch({
				callID: 'stable-await',
				taskId: 'STABLE-1',
				planTaskId: 'STABLE-1',
			});

			for (let i = 0; i < 5; i++) {
				const output = handleLanesCommand(tempDir, []);
				expect(output).not.toMatch(/\d{13}/); // no Unix ms timestamps
				expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no ISO timestamps
			}

			const jsonOutput = handleLanesCommand(tempDir, ['--json']);
			expect(jsonOutput).not.toMatch(/\d{13}/);
			expect(jsonOutput).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
		});

		test('deterministic ordering: active → awaiting-merge → conflicted, then by laneId', () => {
			// Add in reverse alphabetical order to prove sorting works
			addConflictedDispatch({
				taskId: 'Z-conflict',
				failure: { outcome: 'failed', stage: 'merge', message: 'z conflict' },
			});
			addAwaitingMergeDispatch({
				callID: 'Y-await',
				taskId: 'Y-await',
				planTaskId: 'Y-await',
			});
			addActiveDispatch({
				callID: 'X-active',
				taskId: 'X-active',
				planTaskId: 'X-active',
			});

			const json = parseJsonOutput(handleLanesCommand(tempDir, ['--json']));

			const states = json.lanes.map((l) => l.state);
			const firstActive = states.indexOf('active');
			const firstAwaiting = states.indexOf('awaiting-merge');
			const firstConflicted = states.indexOf('conflicted');

			expect(firstAwaiting).toBeGreaterThan(firstActive);
			expect(firstConflicted).toBeGreaterThan(firstAwaiting);

			// Within active: laneId order
			const activeLanes = json.lanes.filter((l) => l.state === 'active');
			expect(activeLanes[0].laneId).toBe('X-active');
		});
	});

	// =========================================================================
	// SCENARIO 5: Edge cases
	// =========================================================================

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

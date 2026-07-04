/**
 * /swarm lanes command tests (FR-105: SC-114, SC-115, SC-116, SC-117)
 *
 * Covers:
 * - SC-114: lists active lanes (in-flight dispatches)
 * - SC-115: distinguishes awaiting-merge lanes from active lanes
 * - SC-116: lists conflicted lanes with recovery hints
 * - SC-117: deterministic, machine-parseable output in addition to human-readable
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
	getAllWorktreeMergeFailures,
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
 * SC-114: a dispatch in standardWorktreeByCallID (NOT in awaitingMergeByCallID,
 * NOT in merge-status) is shown as 'active' — coder still running.
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
 * SC-115: a dispatch in awaitingMergeByCallID is shown as 'awaiting-merge' —
 * coder returned, merge-back in progress.
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
 * SC-116: a record in merge-status registry (NOT in awaitingMergeByCallID)
 * is shown as 'conflicted' — merge-back completed with partial/failed outcome.
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

describe('handleLanesCommand', () => {
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
	// SC-114: Active lanes (coder still running)
	// -------------------------------------------------------------------------
	test('SC-114: dispatch in standardWorktreeByCallID shown as active lane', () => {
		addActiveDispatch({
			callID: 'call-active-1',
			taskId: '1.1',
			planTaskId: '1.1',
			handle: makeHandle({
				worktreePath: '/tmp/wt-active',
				branchName: 'lane/active',
			}),
			mergeStrategy: 'merge',
		});

		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('## active (1)');
		expect(result).toContain('  - call-active-1 task=1.1 branch=lane/active');
		expect(result).toContain('    worktree=/tmp/wt-active');
		// No conflict marker on an active lane
		expect(result).not.toContain('[failed');
		expect(result).not.toContain('[partial');
	});

	// -------------------------------------------------------------------------
	// SC-115: Awaiting-merge lanes (coder returned, merge in progress)
	// -------------------------------------------------------------------------
	test('SC-115: dispatch in awaitingMergeByCallID shown as awaiting-merge', () => {
		addAwaitingMergeDispatch({
			callID: 'call-await-1',
			taskId: '2.1',
			planTaskId: '2.1',
			worktreePath: '/tmp/wt-await',
			branch: 'lane/await',
			mergeStrategy: 'merge',
		});

		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('## awaiting-merge (1)');
		expect(result).toContain('  - call-await-1 task=2.1 branch=lane/await');
		expect(result).toContain('    worktree=/tmp/wt-await');
	});

	test('SC-115: two awaiting-merge lanes appear in correct group', () => {
		addAwaitingMergeDispatch({
			callID: 'call-lane-a',
			taskId: '3.1',
			planTaskId: '3.1',
			worktreePath: '/tmp/wt-lane-a',
			branch: 'lane/a',
			mergeStrategy: 'rebase',
		});
		addAwaitingMergeDispatch({
			callID: 'call-lane-b',
			taskId: '3.2',
			planTaskId: '3.2',
			worktreePath: '/tmp/wt-lane-b',
			branch: 'lane/b',
			mergeStrategy: 'merge',
		});

		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('## awaiting-merge (2)');
		expect(result).toContain('call-lane-a');
		expect(result).toContain('call-lane-b');
	});

	// -------------------------------------------------------------------------
	// SC-116: Conflicted lanes (merge completed with partial/failed outcome)
	// -------------------------------------------------------------------------
	test('SC-116: failed merge record shown as conflicted with recovery hint', () => {
		// SC-116: conflicted lane is ONLY in merge-status registry (not in any map)
		addConflictedDispatch({
			taskId: '4.1',
			failure: {
				outcome: 'failed',
				stage: 'merge',
				message: 'conflict in src/a.ts',
				worktreePath: '/tmp/wt-conflicted',
				branch: 'lane/conflicted',
			},
		});

		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('## conflicted (1)');
		expect(result).toContain('worktree=/tmp/wt-conflicted');
		expect(result).toContain('[failed @ merge]');
		expect(result).toContain('hint:');
		expect(result).toContain('/tmp/wt-conflicted');
	});

	test('SC-116: partial merge record shown as conflicted with correct hint', () => {
		addConflictedDispatch({
			taskId: '5.1',
			failure: {
				outcome: 'partial',
				stage: 'auto-commit',
				message: 'empty commit',
				worktreePath: '/tmp/wt-partial',
				branch: 'lane/partial',
			},
		});

		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('## conflicted (1)');
		expect(result).toContain('[partial @ auto-commit]');
		expect(result).toContain('hint:');
		expect(result).toContain('Partial merge preserved');
	});

	test('SC-116: conflict stage produces correct recovery hint', () => {
		addConflictedDispatch({
			taskId: '6.1',
			failure: {
				outcome: 'failed',
				stage: 'conflict',
				message: 'unresolved conflicts',
				worktreePath: '/tmp/wt-conflict',
				branch: 'lane/conflict',
			},
		});

		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('hint: Merge conflict at /tmp/wt-conflict');
	});

	// -------------------------------------------------------------------------
	// SC-117: Machine-parseable JSON output
	// -------------------------------------------------------------------------
	test('SC-117: --json flag emits valid JSON with correct schema for active lane', () => {
		addActiveDispatch({
			callID: 'call-json-test',
			taskId: '7.1',
			planTaskId: '7.1',
			handle: makeHandle({
				worktreePath: '/tmp/wt-json',
				branchName: 'lane/json',
			}),
			mergeStrategy: 'rebase',
		});

		const result = handleLanesCommand(tempDir, ['--json']);

		const parsed = JSON.parse(result) as {
			lanes: unknown[];
			totalCount: number;
		};

		expect(parsed).toHaveProperty('lanes');
		expect(Array.isArray(parsed.lanes)).toBe(true);
		expect(parsed).toHaveProperty('totalCount');
		expect(parsed.totalCount).toBe(1);

		const lane = (parsed.lanes as Array<Record<string, unknown>>)[0];
		expect(lane).toMatchObject({
			state: 'active',
			laneId: 'call-json-test',
			branch: 'lane/json',
			worktreePath: '/tmp/wt-json',
			taskId: '7.1',
			planTaskId: '7.1',
			mergeStrategy: 'rebase',
		});
		expect(lane).toHaveProperty('recoveryHint');
	});

	test('SC-117: JSON output is stable (same input = same output)', () => {
		addActiveDispatch({
			callID: 'call-stable',
			taskId: '8.1',
			planTaskId: '8.1',
			handle: makeHandle({ worktreePath: '/tmp/wt-stable' }),
		});

		const first = handleLanesCommand(tempDir, ['--json']);
		const second = handleLanesCommand(tempDir, ['--json']);

		expect(first).toBe(second);
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

	// -------------------------------------------------------------------------
	// Empty case
	// -------------------------------------------------------------------------
	test('empty state: all groups show (none)', () => {
		const result = handleLanesCommand(tempDir, []);

		expect(result).toContain('## active (0)');
		expect(result).toContain('  (none)');
		expect(result).toContain('## awaiting-merge (0)');
		expect(result).toContain('## conflicted (0)');
		expect(result).toContain('Total: 0 lanes');
	});

	// -------------------------------------------------------------------------
	// SC-117: Both --json and human-readable read same authoritative state
	// -------------------------------------------------------------------------
	test('SC-117: JSON and human-readable agree on lane count and ids', () => {
		addActiveDispatch({ callID: 'call-a', taskId: '10.1', planTaskId: '10.1' });
		addActiveDispatch({ callID: 'call-b', taskId: '10.2', planTaskId: '10.2' });

		const text = handleLanesCommand(tempDir, []);
		const json = handleLanesCommand(tempDir, ['--json']);

		const parsed = JSON.parse(json) as { lanes: Array<{ laneId: string }> };
		expect(parsed.totalCount).toBe(2);
		expect(parsed.lanes.map((l) => l.laneId)).toContain('call-a');
		expect(parsed.lanes.map((l) => l.laneId)).toContain('call-b');

		// Both include the same lanes
		expect(text).toContain('call-a');
		expect(text).toContain('call-b');
	});

	// -------------------------------------------------------------------------
	// Deterministic ordering: by state group then laneId
	// -------------------------------------------------------------------------
	test('ordering is deterministic: state order takes precedence over laneId', () => {
		// Conflicted first alphabetically (z) but should appear last due to state order
		addConflictedDispatch({
			taskId: '11.2',
			failure: {
				outcome: 'failed',
				stage: 'merge',
				message: 'x',
				worktreePath: '/tmp/wt-conflict',
				branch: 'lane/conflict',
			},
		});

		// Active (a) should appear first despite z < a alphabetically
		addActiveDispatch({
			callID: 'call-a-active',
			taskId: '11.1',
			planTaskId: '11.1',
			handle: makeHandle({ worktreePath: '/tmp/wt-a' }),
		});

		const json = handleLanesCommand(tempDir, ['--json']);

		const parsed = JSON.parse(json) as {
			lanes: Array<{ laneId: string; state: string }>;
		};

		// Conflicted should come after active despite 'z' < 'a' alphabetically
		const states = parsed.lanes.map((l) => l.state);
		const activeIndex = states.indexOf('active');
		const conflictedIndex = states.lastIndexOf('conflicted');
		expect(conflictedIndex).toBeGreaterThan(activeIndex);
	});

	test('ordering within same state group is by laneId', () => {
		addActiveDispatch({ callID: 'call-c', taskId: '12.3', planTaskId: '12.3' });
		addActiveDispatch({ callID: 'call-a', taskId: '12.1', planTaskId: '12.1' });
		addActiveDispatch({ callID: 'call-b', taskId: '12.2', planTaskId: '12.2' });

		const json = handleLanesCommand(tempDir, ['--json']);
		const parsed = JSON.parse(json) as {
			lanes: Array<{ laneId: string }>;
		};

		const ids = parsed.lanes.map((l) => l.laneId);
		expect(ids).toEqual(['call-a', 'call-b', 'call-c']);
	});

	// -------------------------------------------------------------------------
	// SC-116: conflicted record surfaces worktree path from extended fields
	// -------------------------------------------------------------------------
	test('SC-116: conflicted lane shows worktree path and branch from extended fields', () => {
		addConflictedDispatch({
			taskId: '13.1',
			failure: {
				outcome: 'failed',
				stage: 'merge',
				message: 'unresolved',
				worktreePath: '/tmp/wt-conflicted-ext',
				branch: 'lane/conflicted-ext',
			},
		});

		const json = handleLanesCommand(tempDir, ['--json']);
		const parsed = JSON.parse(json) as {
			lanes: Array<{
				state: string;
				worktreePath: string;
				branch: string;
				mergeOutcome: { outcome: string };
			}>;
		};

		expect(parsed.lanes.length).toBe(1);
		const lane = parsed.lanes[0];
		expect(lane.state).toBe('conflicted');
		expect(lane.worktreePath).toBe('/tmp/wt-conflicted-ext');
		expect(lane.branch).toBe('lane/conflicted-ext');
		expect(lane.mergeOutcome?.outcome).toBe('failed');
	});

	// -------------------------------------------------------------------------
	// SC-116: pre-extension durable records fall back gracefully
	// -------------------------------------------------------------------------
	test('SC-116: conflicted lane without extended fields falls back gracefully', () => {
		// Pre-extension record: only has outcome/stage/message (no worktreePath/branch)
		// This simulates a durable record written before the extended fields were added.
		// We directly manipulate the in-memory map to create this old-format record.
		(mergeStatusInternals.failuresByTask as Map<string, unknown>).set('14.1', {
			outcome: 'failed',
			stage: 'merge',
			message: 'old record format',
		});

		const result = handleLanesCommand(tempDir, []);

		// Should still appear as conflicted, even without extended fields
		expect(result).toContain('## conflicted (1)');
		expect(result).toContain('14.1');
		// recoveryHint should still be present (buildRecoveryHint handles missing path)
		expect(result).toContain('hint:');
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
});

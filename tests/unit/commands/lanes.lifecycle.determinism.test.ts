/**
 * /swarm lanes command — stale conflict cleanup & output determinism tests (FR-105)
 *
 * Tests verify:
 * - Stale conflict cleanup: failures filtered while taskId in awaitingMergeByCallID,
 *   surfaces after removal
 * - Output stability: byte-identical output across multiple calls
 * - Deterministic ordering: active → awaiting-merge → conflicted, then by laneId
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

describe('handleLanesCommand — stale conflict cleanup & determinism', () => {
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
});

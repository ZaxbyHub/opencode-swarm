/**
 * #3903 FB-004 falsifier: a preservation failure at terminal teardown is an
 * intentional dirty-work abort, not a worktree removal failure. The strand
 * store must not record it and no WORKTREE_LANE_STRANDED advisory may fire.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	resetStandardWorktreeIsolationState,
	type StandardWorktreeDispatch,
	standardWorktreeByCallID,
	_internals as worktreeInternals,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import type { WorktreeHandle } from '../../../src/worktree';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CALL_ID = 'fb3903-preserve-failed';
const SESSION = 'fb3903-session';

let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('fb3903-strand-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	ensureAgentSession(SESSION);
});

afterEach(() => {
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	fs.rmSync(directory, { recursive: true, force: true });
});

function config(): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
		},
	} as PluginConfig;
}

describe('#3903 FB-004 terminal strand gate', () => {
	it('does not strand a lane whose preservation failed', async () => {
		const worktreePath = path.join(directory, 'lane');
		const branchName = 'swarm-lane/fb3903/preserve-failed';
		const dispatch: StandardWorktreeDispatch = {
			callID: CALL_ID,
			parentSessionID: SESSION,
			taskId: '1.1',
			planTaskId: '1.1',
			handle: {
				worktreePath,
				branchName,
				purpose: 'lane',
				id: 'preserve-failed',
				sessionId: SESSION,
			} as WorktreeHandle,
			mergeStrategy: 'merge',
			laneIndex: 0,
		};
		standardWorktreeByCallID.set(CALL_ID, dispatch);

		const originalCleanup = worktreeInternals.cleanupStandardWorktreeForCallId;
		let cleanupCalls = 0;
		try {
			worktreeInternals.cleanupStandardWorktreeForCallId = mock(async () => {
				cleanupCalls++;
				return {
					removedWorktree: false,
					cleanedBranch: false,
					preservedRecoveryLane: false,
					preservationFailed: true,
				};
			});
			const hook = createDelegationGateHook(config(), directory);
			try {
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: SESSION,
						callID: CALL_ID,
						args: { subagent_type: 'coder', task_id: '1.1' },
					},
					{ state: 'cancelled', output: 'cancelled' },
				);
			} catch {
				// The terminal branch may reject the tool after recording the
				// failure; the strand assertion is independent of that outcome.
			}
			expect(cleanupCalls).toBe(1);
			const strandStore = path.join(
				directory,
				'.swarm',
				'dead-lane-reclaims.json',
			);
			expect(fs.existsSync(strandStore)).toBe(false);
			const advisories = (
				ensureAgentSession(SESSION).pendingAdvisoryMessages ?? []
			).join('\n');
			expect(advisories).not.toContain('WORKTREE_LANE_STRANDED');
		} finally {
			worktreeInternals.cleanupStandardWorktreeForCallId = originalCleanup;
		}
	});

	it('FB-001: G2 uses the bounded 15s lifecycle-wait helper, not a single try', async () => {
		const worktreePath = path.join(directory, 'lane');
		const branchName = 'swarm-lane/fb3903/bounded-wait';
		const dispatch: StandardWorktreeDispatch = {
			callID: 'fb3903-bounded-wait',
			parentSessionID: SESSION,
			taskId: '1.1',
			planTaskId: '1.1',
			handle: {
				worktreePath,
				branchName,
				purpose: 'lane',
				id: 'bounded-wait',
				sessionId: SESSION,
			} as WorktreeHandle,
			mergeStrategy: 'merge',
			laneIndex: 0,
		};
		standardWorktreeByCallID.set(dispatch.callID, dispatch);

		const originalAcquire =
			worktreeInternals.acquireWorktreeLifecycleLockWithin;
		const originalCleanup = worktreeInternals.cleanupStandardWorktreeForCallId;
		let observedWaitMs: number | undefined;
		try {
			worktreeInternals.acquireWorktreeLifecycleLockWithin = mock(
				async (_directory: string, _callID: string, waitMs: number) => {
					observedWaitMs = waitMs;
					return {
						acquired: true,
						lock: { _release: mock(async () => undefined) },
					};
				},
			) as never;
			worktreeInternals.cleanupStandardWorktreeForCallId = mock(async () => ({
				removedWorktree: true,
				cleanedBranch: true,
				preservedRecoveryLane: false,
			}));
			const hook = createDelegationGateHook(config(), directory);
			try {
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: SESSION,
						callID: dispatch.callID,
						args: { subagent_type: 'coder', task_id: '1.1' },
					},
					{ state: 'cancelled', output: 'cancelled' },
				);
			} catch {
				// terminal failure may reject after cleanup; the wait is the oracle
			}
			expect(observedWaitMs).toBe(worktreeInternals.worktreeCleanupLockWaitMs);
			expect(observedWaitMs).toBe(15_000);
		} finally {
			worktreeInternals.acquireWorktreeLifecycleLockWithin = originalAcquire;
			worktreeInternals.cleanupStandardWorktreeForCallId = originalCleanup;
		}
	});

	it('FB-003: G2 skips the whole teardown when a live sibling owns the lane', async () => {
		const worktreePath = path.join(directory, 'lane');
		const branchName = 'swarm-lane/fb3903/superseded';
		const dispatch: StandardWorktreeDispatch = {
			callID: 'fb3903-superseded',
			parentSessionID: SESSION,
			taskId: '1.1',
			planTaskId: '1.1',
			handle: {
				worktreePath,
				branchName,
				purpose: 'lane',
				id: 'superseded',
				sessionId: SESSION,
			} as WorktreeHandle,
			mergeStrategy: 'merge',
			laneIndex: 0,
		};
		standardWorktreeByCallID.set(dispatch.callID, dispatch);

		const originalAcquire =
			worktreeInternals.acquireWorktreeLifecycleLockWithin;
		const originalPredicate = worktreeInternals.findSupersedingLaneDispatch;
		const originalCleanup = worktreeInternals.cleanupStandardWorktreeForCallId;
		let cleanupCalls = 0;
		try {
			worktreeInternals.acquireWorktreeLifecycleLockWithin = mock(async () => ({
				acquired: true,
				lock: { _release: mock(async () => undefined) },
			})) as never;
			// Production predicate is synchronous; G2 awaits the returned value,
			// which works for a plain object as well.
			worktreeInternals.findSupersedingLaneDispatch = mock(() => ({
				kind: 'active-dispatch' as const,
				callID: 'live-sibling',
			}));
			worktreeInternals.cleanupStandardWorktreeForCallId = mock(async () => {
				cleanupCalls++;
				return {
					removedWorktree: true,
					cleanedBranch: true,
					preservedRecoveryLane: false,
				};
			});
			const hook = createDelegationGateHook(config(), directory);
			try {
				await hook.toolAfter(
					{
						tool: 'Task',
						sessionID: SESSION,
						callID: dispatch.callID,
						args: { subagent_type: 'coder', task_id: '1.1' },
					},
					{ state: 'cancelled', output: 'cancelled' },
				);
			} catch {
				// terminal failure may reject after recording; skip is the oracle
			}
			expect(cleanupCalls).toBe(0);
			expect(standardWorktreeByCallID.has(dispatch.callID)).toBe(false);
			const advisories = (
				ensureAgentSession(SESSION).pendingAdvisoryMessages ?? []
			).join('\n');
			expect(advisories).toContain(
				'STANDARD_WORKTREE_CLEANUP_SKIPPED_REPROVISIONED',
			);
		} finally {
			worktreeInternals.acquireWorktreeLifecycleLockWithin = originalAcquire;
			worktreeInternals.findSupersedingLaneDispatch = originalPredicate;
			worktreeInternals.cleanupStandardWorktreeForCallId = originalCleanup;
		}
	});
});

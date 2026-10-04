/**
 * A Task `task_id` that names a lane child session this plugin created for a
 * different agent is refused at dispatch.
 *
 * Live run (worktree isolation on): the plugin rewrote the coder's `task_id`
 * to its lane child session id, the Task result returned
 * `<task id="ses_…">`, and the architect passed that id as `task_id` when it
 * dispatched the Stage B test_engineer. OpenCode then resumed the CODER's
 * session as the test_engineer — inside the coder's lane, with its history
 * and scope.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertTaskIdNotForeignLaneSession,
	laneChildSessionAgents,
	recordLaneChildSession,
	resetStandardWorktreeIsolationState,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	createDelegationGateHook,
	makeConfig,
} from './_delegation-gate-helpers';

const LANE_SESSION = 'ses_lane_coder_2_1';

let directory: string;
let cleanup: () => void;

beforeEach(() => {
	resetSwarmState();
	resetStandardWorktreeIsolationState();
	({ dir: directory, cleanup } = createSafeTestDir('lane-session-resume-'));
	recordLaneChildSession(LANE_SESSION, 'coder');
});

afterEach(() => {
	resetStandardWorktreeIsolationState();
	resetSwarmState();
	cleanup();
});

describe('lane child session resume guard', () => {
	test('dispatching another agent with the coder lane session id is refused', async () => {
		const hook = createDelegationGateHook(makeConfig(), directory);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect', callID: 'call-te' },
				{
					args: {
						subagent_type: 'test_engineer',
						task_id: LANE_SESSION,
						prompt: 'TASK: 2.1\nWrite the tests.',
					},
				},
			),
		).rejects.toThrow('TASK_SESSION_RESUME_MISMATCH');
	});

	test('prefixed agent names are compared by role', () => {
		expect(() =>
			assertTaskIdNotForeignLaneSession({
				subagent_type: 'mega_reviewer',
				task_id: ` ${LANE_SESSION} `,
			}),
		).toThrow(/resume that coder session as reviewer/);
		expect(() =>
			assertTaskIdNotForeignLaneSession({
				subagent_type: 'mega_coder',
				task_id: LANE_SESSION,
			}),
		).not.toThrow();
	});

	test('ids the plugin did not create, plan task ids and missing ids pass', () => {
		for (const args of [
			{ subagent_type: 'test_engineer', task_id: 'ses_someone_else' },
			{ subagent_type: 'test_engineer', task_id: '2.1' },
			{ subagent_type: 'test_engineer' },
			{ subagent_type: 'test_engineer', task_id: 42 },
		]) {
			expect(() => assertTaskIdNotForeignLaneSession(args)).not.toThrow();
		}
		expect(() => assertTaskIdNotForeignLaneSession(undefined)).not.toThrow();
	});

	test('the registry is bounded and reset with the isolation state', () => {
		for (let i = 0; i < 600; i++) recordLaneChildSession(`ses_${i}`, 'coder');
		expect(laneChildSessionAgents.size).toBe(512);
		expect(laneChildSessionAgents.has('ses_0')).toBe(false);
		expect(laneChildSessionAgents.has('ses_599')).toBe(true);
		resetStandardWorktreeIsolationState();
		expect(laneChildSessionAgents.size).toBe(0);
	});
});

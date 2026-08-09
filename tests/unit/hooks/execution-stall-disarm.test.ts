/**
 * Execution-stall detector — DISARM ON NO OPEN TASK (issue #2063 B5,
 * reviewer round-4 REQUIRED 1).
 *
 * Idleness was the episode's only exit. That made the lever fire on a session
 * doing exactly the right thing: an architect finishes its execution phase with
 * a final `update_task_status(..., completed)` and then flows straight into
 * commit / CI / reporting work. It never goes idle, so the episode stayed armed;
 * none of commit-and-CI work produces a delegation completion, a file write, or
 * a status update, so every one of those calls counted as non-progress; at 60 it
 * was hard-denied.
 *
 * The second disarm path closes that hole and is the symmetric counterpart of
 * arming path (b): an episode that arms when a task OPENS ends when no task is
 * open. It is checked in-band (right after a settling status update) and
 * out-of-band (in the periodic probe), and `'unknown'` — a missing or unreadable
 * plan — deliberately does NOT disarm, so a plan-less architect loop keeps the
 * lever.
 *
 * These tests drive the REAL `.swarm/plan.json` reader against real fixture
 * files; the DI seam is used only where a test needs to prove the seam itself is
 * consulted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isExecutionEpisodeArmed } from '../../../src/hooks/guardrails/execution-episode';
import {
	_internals,
	_test_exports,
	DEFAULT_EXECUTION_STALL_STOP_CALLS,
	enforceExecutionStallDenial,
	observeExecutionStallToolCall,
	readPlanOpenTaskState,
	recordExecutionStallToolAfter,
} from '../../../src/hooks/guardrails/execution-stall';
import { resetSwarmState, swarmState } from '../../../src/state';

const PROBE_EVERY = _test_exports.WORKSPACE_PROBE_EVERY_CALLS;

const realNow = _internals.now;
const realCapture = _internals.captureWorkspaceSnapshot;
const realChanged = _internals.changedFilesSinceSnapshot;
const realReadPlan = _internals.readPlanOpenTaskState;

let clock = 1_700_000_000_000;
let tempDir: string;

/** Write a real `.swarm/plan.json` with the given task statuses. */
function writePlan(statuses: string[]): void {
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			phases: [
				{
					id: 1,
					tasks: statuses.map((status, i) => ({
						id: `1.${i + 1}`,
						status,
					})),
				},
			],
		}),
	);
}

beforeEach(() => {
	resetSwarmState();
	_test_exports.reset();
	clock = 1_700_000_000_000;
	_internals.now = () => clock;
	// Fake, always-clean workspace so no test in this file spawns git.
	_internals.captureWorkspaceSnapshot = mock(
		() => ({ gitHead: 'HEAD0', changedFiles: [] }) as never,
	) as never;
	_internals.changedFilesSinceSnapshot = mock(() => []) as never;
	_internals.readPlanOpenTaskState = realReadPlan;
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'stall-disarm-')),
	);
});

afterEach(() => {
	_internals.now = realNow;
	_internals.captureWorkspaceSnapshot = realCapture;
	_internals.changedFilesSinceSnapshot = realChanged;
	_internals.readPlanOpenTaskState = realReadPlan;
	_test_exports.reset();
	resetSwarmState();
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

function setupArchitect(sessionID: string): void {
	swarmState.activeAgent.set(sessionID, 'architect');
}

/** Arm via a mutating dispatch (arming path (a)). */
function armViaDispatch(sessionID: string): void {
	clock += 1_000;
	observeExecutionStallToolCall({
		sessionID,
		tool: 'Task',
		args: { subagent_type: 'coder', prompt: 'do it' },
		callID: 'arm-task',
	});
}

/** A successful `update_task_status` toolAfter. */
function statusUpdate(
	sessionID: string,
	taskId: string,
	status: string,
	callID: string,
): void {
	recordExecutionStallToolAfter({
		sessionID,
		tool: 'update_task_status',
		callID,
		args: { task_id: taskId, status },
		output: {
			title: 'update_task_status',
			output: JSON.stringify({ success: true, new_status: status }),
			metadata: {},
		},
		directory: tempDir,
	});
}

/** One full non-progress cycle (before + after), as the real host does. */
function nonProgressCycle(sessionID: string, n: number, tool = 'bash'): void {
	clock += 1_000;
	observeExecutionStallToolCall({
		sessionID,
		tool,
		args: tool === 'bash' ? { command: `echo ${n}` } : { filePath: `/p/${n}` },
		callID: `np-${n}`,
	});
	recordExecutionStallToolAfter({
		sessionID,
		tool,
		callID: `np-${n}`,
		output: { title: tool, output: 'ok', metadata: {} },
		directory: tempDir,
	});
}

describe('#2063 B5 — readPlanOpenTaskState (the real reader)', () => {
	test('answers open / none / unknown from a real .swarm/plan.json', () => {
		// No plan at all: NOT `none`. Only positive evidence disarms.
		expect(readPlanOpenTaskState(tempDir)).toBe('unknown');

		writePlan(['in_progress', 'pending']);
		expect(readPlanOpenTaskState(tempDir)).toBe('open');

		writePlan(['completed', 'completed']);
		expect(readPlanOpenTaskState(tempDir)).toBe('none');

		// Malformed JSON and a plan with no phases array are both `unknown`.
		fs.writeFileSync(path.join(tempDir, '.swarm', 'plan.json'), '{not json');
		expect(readPlanOpenTaskState(tempDir)).toBe('unknown');
		fs.writeFileSync(path.join(tempDir, '.swarm', 'plan.json'), '{"phases":7}');
		expect(readPlanOpenTaskState(tempDir)).toBe('unknown');

		// A blank directory never reaches the filesystem.
		expect(readPlanOpenTaskState('')).toBe('unknown');
		expect(readPlanOpenTaskState('   ')).toBe('unknown');
	});
});

describe('#2063 B5 — disarm when the plan has no in_progress task', () => {
	test('REGRESSION (reviewer r4): the final update_task_status disarms, so 60+ later calls are NOT denied', () => {
		// The exact reported shape: architect closes out its last task, then runs
		// commit + CI + reporting work. None of that is a "progress event" for
		// this lever, and the session never goes idle, so before this fix the
		// counter climbed straight through the hard rung.
		const sessionID = 'final-status-disarms';
		setupArchitect(sessionID);
		writePlan(['in_progress']);

		armViaDispatch(sessionID);
		for (let i = 0; i < 5; i++) nonProgressCycle(sessionID, i);
		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);

		// The final status update settles the last open task.
		writePlan(['completed']);
		statusUpdate(sessionID, '1.1', 'completed', 'uts-final');

		const state = _test_exports.peekState(sessionID);
		expect(state?.armed).toBe(false);
		expect(state?.nonProgressCalls).toBe(0);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(false);

		// The commit / CI tail: well past the hard rung, never denied.
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS + 5; i++) {
			nonProgressCycle(sessionID, 100 + i, i % 2 === 0 ? 'bash' : 'read');
		}

		expect(_test_exports.peekState(sessionID)?.armed).toBe(false);
		expect(_test_exports.peekState(sessionID)?.nonProgressCalls).toBe(0);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'bash' }),
		).not.toThrow();
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).not.toThrow();
	});

	test('two in_progress tasks, one completed → the episode STAYS armed', () => {
		// The narrowing that keeps the lever alive mid-phase: settling one task
		// while another is still open is not the end of the execution episode.
		const sessionID = 'one-of-two-completed';
		setupArchitect(sessionID);
		writePlan(['in_progress', 'in_progress']);

		armViaDispatch(sessionID);
		for (let i = 0; i < 5; i++) nonProgressCycle(sessionID, i);

		writePlan(['completed', 'in_progress']);
		statusUpdate(sessionID, '1.1', 'completed', 'uts-partial');

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(true);

		// And the lever still reaches the hard rung from here.
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS; i++) {
			nonProgressCycle(sessionID, 200 + i);
		}
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'bash' }),
		).toThrow(/^EXECUTION_STALL:/);
	});

	test('a settling status update does NOT disarm while the plan is unreadable', () => {
		// `'unknown' !== 'none'`: a plan-less architect loop keeps the lever.
		const sessionID = 'unknown-keeps-armed';
		setupArchitect(sessionID);
		// No plan.json written at all.

		armViaDispatch(sessionID);
		statusUpdate(sessionID, '1.1', 'completed', 'uts-no-plan');

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS; i++) {
			nonProgressCycle(sessionID, i);
		}
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read' }),
		).toThrow(/^EXECUTION_STALL:/);
	});

	test('update_task_status(in_progress) never consults the plan — it ARMS', () => {
		// Arming path (b) must not be short-circuited by a plan that has not yet
		// been re-read; the check is scoped to SETTLING updates only.
		const sessionID = 'in-progress-still-arms';
		setupArchitect(sessionID);
		writePlan(['completed']);
		const spy = mock(() => 'none' as const);
		_internals.readPlanOpenTaskState = spy as never;

		statusUpdate(sessionID, '1.1', 'in_progress', 'uts-arm');

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(true);
		expect(spy.mock.calls.length).toBe(0);
	});

	test('a FAILED status update does not disarm', () => {
		const sessionID = 'failed-status-no-disarm';
		setupArchitect(sessionID);
		writePlan(['completed']);

		armViaDispatch(sessionID);
		recordExecutionStallToolAfter({
			sessionID,
			tool: 'update_task_status',
			callID: 'uts-fail',
			args: { task_id: '1.1', status: 'completed' },
			output: {
				title: 'update_task_status',
				output: JSON.stringify({ success: false, message: 'gate refused' }),
				metadata: {},
			},
			directory: tempDir,
		});

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
	});
});

describe('#2063 B5 — the periodic probe catches an OUT-OF-BAND plan change', () => {
	test('a plan edited outside update_task_status disarms at the next probe', () => {
		const sessionID = 'out-of-band-disarm';
		setupArchitect(sessionID);
		writePlan(['in_progress']);

		armViaDispatch(sessionID);
		// One cycle captures the workspace baseline; the probe runs
		// PROBE_EVERY cycles later.
		nonProgressCycle(sessionID, 0);
		for (let i = 1; i < PROBE_EVERY; i++) nonProgressCycle(sessionID, i);
		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);

		// Somebody settles the plan without going through the tool.
		writePlan(['completed']);
		nonProgressCycle(sessionID, PROBE_EVERY);

		const state = _test_exports.peekState(sessionID);
		expect(state?.armed).toBe(false);
		expect(state?.nonProgressCalls).toBe(0);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(false);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'bash' }),
		).not.toThrow();
	});

	test('the probe leaves the episode armed while a task is still open', () => {
		const sessionID = 'probe-open-task';
		setupArchitect(sessionID);
		writePlan(['in_progress']);

		armViaDispatch(sessionID);
		for (let i = 0; i <= PROBE_EVERY * 2; i++) nonProgressCycle(sessionID, i);

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(
			_test_exports.peekState(sessionID)?.nonProgressCalls,
		).toBeGreaterThan(PROBE_EVERY);
	});

	test('the probe does not disarm on an unreadable plan', () => {
		const sessionID = 'probe-unknown-plan';
		setupArchitect(sessionID);
		// No plan.json.

		armViaDispatch(sessionID);
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS; i++) {
			nonProgressCycle(sessionID, i);
		}

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'grep' }),
		).toThrow(/^EXECUTION_STALL:/);
	});
});

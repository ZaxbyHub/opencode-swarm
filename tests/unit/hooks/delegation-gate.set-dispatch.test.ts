/**
 * FR-007 Set-Dispatch Attribution Tests
 *
 * Tests for per-task verdict parsing and attribution when a reviewer or
 * test_engineer covers multiple tasks in a single dispatch (set-dispatch).
 *
 * SC-022: reviewer covering 3 tasks with parseable verdicts attributes per-task
 * SC-023: unparseable output fails closed for the exact dispatched task
 * SC-024 parser coverage lives in the focused sibling parser test file
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import {
	readTaskEvidence,
	recordAgentDispatch,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createDelegationGateHook } from './_delegation-gate-helpers';

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function makeConfig() {
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
	} as import('../../../src/config').PluginConfig;
}

function writePlan(directory: string, taskIds: string[]): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Set-dispatch test',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: taskIds.map((id) => ({
						id,
						phase: 1,
						status: 'in_progress',
						size: 'small',
						description: `Implement ${id}`,
						depends: [],
						files_touched: [],
					})),
				},
			],
		}),
	);
}

async function seedStageA(
	directory: string,
	taskIds: string[],
): Promise<Map<string, number>> {
	writePlan(directory, taskIds);
	const generations = new Map<string, number>();
	for (const taskId of taskIds) {
		await recordAgentDispatch(directory, taskId, 'coder');
		const generation = (await readTaskEvidence(directory, taskId))!.workflow!
			.generation;
		await transitionTaskWorkflowEvidence(directory, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
		});
		generations.set(taskId, generation);
	}
	return generations;
}

async function seedReviewer(
	directory: string,
	taskIds: string[],
): Promise<Map<string, number>> {
	const generations = await seedStageA(directory, taskIds);
	for (const taskId of taskIds) {
		await recordGateEvidence(
			directory,
			taskId,
			'reviewer',
			'seed-reviewer',
			undefined,
			{ expectedGeneration: generations.get(taskId)! },
		);
	}
	return generations;
}

async function runGateDispatch(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	callID: string,
	agent: 'reviewer' | 'test_engineer',
	taskIds: string[],
	output: string,
): Promise<void> {
	const args = {
		subagent_type: agent,
		task_id: taskIds[0],
		prompt: `TASK: ${taskIds[0]}\nTASKS: ${taskIds.join(', ')}\nACCEPTANCE: ${agent} must report an exact structured verdict for every listed task`,
	};
	await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
	await hook.toolAfter({ tool: 'Task', sessionID, callID, args }, { output });
}

describe('FR-007 set-dispatch per-task attribution', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('dg-set-dispatch-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-022.1: reviewer covering 3 tasks with parseable verdicts attributes per-task via recordStageBCompletion', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-1', 'architect');
		const session = ensureAgentSession('sess-sc22-1');

		await seedStageA(tempDir, ['2.1', '2.2', '2.3']);
		session.taskWorkflowStates.set('2.1', 'pre_check_passed');
		session.taskWorkflowStates.set('2.2', 'pre_check_passed');
		session.taskWorkflowStates.set('2.3', 'pre_check_passed');
		session.currentTaskId = '2.1';

		// Simulate a set-dispatch output with per-task verdicts
		const output = {
			output: `[REVIEWED] | task-2.1 | APPROVED | No issues found
[REVIEWED] | task-2.2 | APPROVED | Minor suggestion
[REVIEWED] | task-2.3 | REJECTED | Critical bug found`,
		};

		await runGateDispatch(
			hook,
			'sess-sc22-1',
			'call-sc22-1',
			'reviewer',
			['2.1', '2.2', '2.3'],
			output.output,
		);

		// Verify recordStageBCompletion was called per-task (not over-attributed to every task)
		// Each task should have exactly 1 completion recorded for reviewer
		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.3')).toBe('rework_required');
	});

	it('SC-022.2: test_engineer covering 3 tasks with parseable verdicts attributes per-task', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-2', 'architect');
		const session = ensureAgentSession('sess-sc22-2');

		await seedReviewer(tempDir, ['2.1', '2.2', '2.3']);
		session.taskWorkflowStates.set('2.1', 'reviewer_run');
		session.taskWorkflowStates.set('2.2', 'reviewer_run');
		session.taskWorkflowStates.set('2.3', 'reviewer_run');
		session.currentTaskId = '2.1';

		const output = {
			output: `[TESTED] | task-2.1 | PASS | 10/10 tests passed
[TESTED] | task-2.2 | PASS | 8/8 tests passed
[TESTED] | task-2.3 | FAIL | 6/10 tests passed — missing error path tests`,
		};

		await runGateDispatch(
			hook,
			'sess-sc22-2',
			'call-sc22-2',
			'test_engineer',
			['2.1', '2.2', '2.3'],
			output.output,
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('tests_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('tests_run');
		expect(session.taskWorkflowStates.get('2.3')).toBe('rework_required');
	});

	it('SC-023.1: unparseable output fails closed for the exact task', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-1', 'architect');
		const session = ensureAgentSession('sess-sc23-1');

		await seedStageA(tempDir, ['1.1']);
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');
		session.currentTaskId = '1.1';

		// Output without structured verdict lines — should fall back to single-task
		const output = {
			output: `VERDICT: APPROVED
Reviewed the code. No issues found.`,
		};

		await runGateDispatch(
			hook,
			'sess-sc23-1',
			'call-sc23-1',
			'reviewer',
			['1.1'],
			output.output,
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
	});

	it('SC-023.2: empty output fails closed for the exact task', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-2', 'architect');
		const session = ensureAgentSession('sess-sc23-2');

		await seedStageA(tempDir, ['1.1']);
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');
		session.currentTaskId = '1.1';

		// Empty output — should fall back
		await runGateDispatch(
			hook,
			'sess-sc23-2',
			'call-sc23-2',
			'reviewer',
			['1.1'],
			'',
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
	});

	it('SC-023.3: mixed output — parseable verdicts take precedence over fallback', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-3', 'architect');
		const session = ensureAgentSession('sess-sc23-3');

		await seedStageA(tempDir, ['2.1', '2.2']);
		session.taskWorkflowStates.set('2.1', 'pre_check_passed');
		session.taskWorkflowStates.set('2.2', 'pre_check_passed');
		session.currentTaskId = '2.1';

		// Output has ONE structured verdict line and some regular text
		const output = {
			output: `I reviewed the code.

[REVIEWED] | task-2.1 | APPROVED | No issues found

The code looks good overall.`,
		};

		await runGateDispatch(
			hook,
			'sess-sc23-3',
			'call-sc23-3',
			'reviewer',
			['2.1', '2.2'],
			output.output,
		);

		// Only task 2.1 should have reviewer recorded (per-task attribution from parseable verdict)
		// Task 2.2 should NOT be affected (no over-attribution)
		// But state machine still processes eligible tasks from taskWorkflowStates for advancement
		const state2_1 = session.taskWorkflowStates.get('2.1');
		const state2_2 = session.taskWorkflowStates.get('2.2');

		// 2.1 should advance (has reviewer completion + parseable verdict)
		expect(state2_1).toBe('reviewer_run');
		expect(state2_2).toBe('pre_check_passed');
	});

	it('SC-022.3: reviewer set-dispatch creates per-task evidence entries', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-3', 'architect');
		const session = ensureAgentSession('sess-sc22-3');

		await seedStageA(tempDir, ['2.1', '2.2']);
		session.taskWorkflowStates.set('2.1', 'pre_check_passed');
		session.taskWorkflowStates.set('2.2', 'pre_check_passed');
		session.currentTaskId = '2.1';

		const output = {
			output: `[REVIEWED] | task-2.1 | APPROVED | Clean code
[REVIEWED] | task-2.2 | APPROVED | Minor refactor needed`,
		};

		await runGateDispatch(
			hook,
			'sess-sc22-3',
			'call-sc22-3',
			'reviewer',
			['2.1', '2.2'],
			output.output,
		);

		// Both tasks should have advanced to reviewer_run
		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('reviewer_run');
	});

	it('SC-023.4: legacy single-task verdict text fails closed', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-backward', 'architect');
		const session = ensureAgentSession('sess-sc23-backward');

		await seedStageA(tempDir, ['1.1']);
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');
		session.currentTaskId = '1.1';

		// Regular reviewer output without structured verdict format
		const output = {
			output: `VERDICT: APPROVED
Reviewed the code. No issues found.`,
		};

		await runGateDispatch(
			hook,
			'sess-sc23-backward',
			'call-sc23-backward',
			'reviewer',
			['1.1'],
			output.output,
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('rework_required');
	});

	it('SC-022.REGRESSION: reviewer verdict for task-2.1 only does NOT over-attribute to 2.2 or 2.3', async () => {
		// Regression test: when perTaskVerdicts parses only task-2.1 from the output,
		// recordStageBCompletion must NOT be called for 2.2 or 2.3.
		// Bug: the loop iterated ALL taskWorkflowStates regardless of perTaskVerdicts.
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-regression', 'architect');
		const session = ensureAgentSession('sess-sc22-regression');

		await seedStageA(tempDir, ['2.1', '2.2', '2.3']);
		session.taskWorkflowStates.set('2.1', 'pre_check_passed');
		session.taskWorkflowStates.set('2.2', 'pre_check_passed');
		session.taskWorkflowStates.set('2.3', 'pre_check_passed');
		session.currentTaskId = '2.1';

		// Output contains verdict ONLY for task-2.1
		const output = {
			output: `[REVIEWED] | task-2.1 | APPROVED | No issues found in the implementation`,
		};

		await runGateDispatch(
			hook,
			'sess-sc22-regression',
			'call-sc22-regression',
			'reviewer',
			['2.1', '2.2', '2.3'],
			output.output,
		);

		// 2.1 should have reviewer recorded (has parseable verdict)
		const completions2_1 = session.stageBCompletion?.get('2.1');
		expect(completions2_1).toBeDefined();
		expect(completions2_1?.has('reviewer')).toBe(true);

		// 2.2 and 2.3 must NOT have reviewer recorded (no over-attribution)
		// This is the key regression check — prior to the fix, both 2.2 and 2.3
		// would incorrectly receive stageBCompletion entries
		const completions2_2 = session.stageBCompletion?.get('2.2');
		const completions2_3 = session.stageBCompletion?.get('2.3');
		expect(completions2_2).toBeUndefined();
		expect(completions2_3).toBeUndefined();

		// State machine: only 2.1 should advance (has completion)
		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		// 2.2 and 2.3 remain at Stage A (no completion recorded).
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get('2.3')).toBe('pre_check_passed');
	});

	it('SC-023.REGRESSION: test_engineer verdict for task-2.1 only does NOT over-attribute to 2.2', async () => {
		// Same regression test for test_engineer agent type
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-regression', 'architect');
		const session = ensureAgentSession('sess-sc23-regression');

		await seedReviewer(tempDir, ['2.1', '2.2']);
		session.taskWorkflowStates.set('2.1', 'reviewer_run');
		session.taskWorkflowStates.set('2.2', 'reviewer_run');
		session.currentTaskId = '2.1';

		// Output contains verdict ONLY for task-2.1
		const output = {
			output: `[TESTED] | task-2.1 | PASS | 10/10 tests passed`,
		};

		await runGateDispatch(
			hook,
			'sess-sc23-regression',
			'call-sc23-regression',
			'test_engineer',
			['2.1', '2.2'],
			output.output,
		);

		// 2.1 should have test_engineer recorded
		const completions2_1 = session.stageBCompletion?.get('2.1');
		expect(completions2_1).toBeDefined();
		expect(completions2_1?.has('test_engineer')).toBe(true);

		// 2.2 must NOT have test_engineer recorded (no over-attribution)
		const completions2_2 = session.stageBCompletion?.get('2.2');
		expect(completions2_2).toBeUndefined();

		// State machine: only 2.1 should advance (has both completions)
		// 2.1 had reviewer already (from prior test setup via reviewer_run state)
		// and now test_engineer completed → should advance to tests_run
		expect(session.taskWorkflowStates.get('2.1')).toBe('tests_run');
		// 2.2 still has reviewer_run state (only reviewer completion, no test_engineer)
		expect(session.taskWorkflowStates.get('2.2')).toBe('reviewer_run');
	});
});

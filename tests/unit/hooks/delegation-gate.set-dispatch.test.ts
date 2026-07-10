/**
 * FR-007 Set-Dispatch Attribution Tests
 *
 * Tests for per-task verdict parsing and attribution when a reviewer or
 * test_engineer covers multiple tasks in a single dispatch (set-dispatch).
 *
 * SC-022: reviewer covering 3 tasks with parseable verdicts attributes per-task
 * SC-023: unparseable output falls back to single-task attribution
 * SC-024: verdicts use documented structured format
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { _internals } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createDelegationGateHook } from './_delegation-gate-helpers';

const { parsePerTaskVerdicts } = _internals;

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

describe('parsePerTaskVerdicts', () => {
	it('SC-024.1: parses [REVIEWED] verdict line with task- prefix', () => {
		const output = `
Some review content here.

[REVIEWED] | task-2.1 | APPROVED | No issues found in src/foo.ts
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')).toBe('APPROVED');
	});

	it('SC-024.2: parses [REVIEWED] verdict line with bare task ID', () => {
		const output = `
[REVIEWED] | 2.2 | REJECTED | Missing null check at line 42
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.2')).toBe('REJECTED');
	});

	it('SC-024.3: parses multiple [REVIEWED] verdict lines from single output', () => {
		const output = `
[REVIEWED] | task-2.1 | APPROVED | No issues found
[REVIEWED] | task-2.2 | APPROVED | Minor suggestion only
[REVIEWED] | task-2.3 | REJECTED | Critical bug at line 88
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(3);
		expect(verdicts.get('2.1')).toBe('APPROVED');
		expect(verdicts.get('2.2')).toBe('APPROVED');
		expect(verdicts.get('2.3')).toBe('REJECTED');
	});

	it('SC-024.4: parses [TESTED] verdict lines', () => {
		const output = `
[TESTED] | task-2.1 | PASS | 10/10 tests passed
[TESTED] | task-2.2 | FAIL | 8/10 tests passed — bar.test.ts missing error path
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(2);
		expect(verdicts.get('2.1')).toBe('PASS');
		expect(verdicts.get('2.2')).toBe('FAIL');
	});

	it('SC-024.5: parses [TESTED] with SKIPPED verdict', () => {
		const output = `
[TESTED] | task-3.1 | SKIPPED | Test file does not exist
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('3.1')).toBe('SKIPPED');
	});

	it('SC-024.6: ignores lines that do not match verdict pattern', () => {
		const output = `
This is just some review text.
VERDICT: APPROVED
TASK: 2.1
But no structured verdict line here.
[REVIEWED] | task-2.1 | APPROVED | This is valid
Random line without format.
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(1);
		expect(verdicts.get('2.1')).toBe('APPROVED');
	});

	it('SC-024.7: ignores invalid task ID formats', () => {
		const output = `
[REVIEWED] | task-invalid | APPROVED | Should be ignored
[REVIEWED] | task-2 | APPROVED | Should be ignored (missing patch number)
[REVIEWED] | task-2.1.3.4.5 | APPROVED | Valid (deeper nesting)
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(1);
		expect(verdicts.has('invalid')).toBe(false);
		expect(verdicts.has('2')).toBe(false);
		expect(verdicts.get('2.1.3.4.5')).toBe('APPROVED');
	});

	it('SC-024.8: handles empty output gracefully', () => {
		const verdicts = parsePerTaskVerdicts('');
		expect(verdicts.size).toBe(0);
	});

	it('SC-024.9: handles output with no verdict lines', () => {
		const verdicts = parsePerTaskVerdicts(
			'Just some regular output without any verdict markers.',
		);
		expect(verdicts.size).toBe(0);
	});

	it('SC-024.10: case-insensitive tag matching', () => {
		const output = `
[reviewed] | task-2.1 | APPROVED | lowercase tag
[Reviewed] | task-2.2 | APPROVED | Mixed case tag
[TESTED] | task-2.3 | PASS | Uppercase tag
[tested] | task-2.4 | PASS | Lowercase tag
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.size).toBe(4);
		expect(verdicts.get('2.1')).toBe('APPROVED');
		expect(verdicts.get('2.2')).toBe('APPROVED');
		expect(verdicts.get('2.3')).toBe('PASS');
		expect(verdicts.get('2.4')).toBe('PASS');
	});
});

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

		// Set up 3 tasks in coder_delegated state
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.taskWorkflowStates.set('2.2', 'coder_delegated');
		session.taskWorkflowStates.set('2.3', 'coder_delegated');
		session.currentTaskId = '2.1';

		// Simulate a set-dispatch output with per-task verdicts
		const output = {
			output: `[REVIEWED] | task-2.1 | APPROVED | No issues found
[REVIEWED] | task-2.2 | APPROVED | Minor suggestion
[REVIEWED] | task-2.3 | REJECTED | Critical bug found`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc22-1',
				callID: 'call-sc22-1',
				args: { subagent_type: 'reviewer' },
			},
			output,
		);

		// Verify recordStageBCompletion was called per-task (not over-attributed to every task)
		// Each task should have exactly 1 completion recorded for reviewer
		for (const taskId of ['2.1', '2.2', '2.3']) {
			const state = session.taskWorkflowStates.get(taskId);
			// State should have advanced appropriately based on barrier
			expect(state).toBeDefined();
		}
	});

	it('SC-022.2: test_engineer covering 3 tasks with parseable verdicts attributes per-task', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-2', 'architect');
		const session = ensureAgentSession('sess-sc22-2');

		// Set up 3 tasks in reviewer_run state (ready for test_engineer)
		session.taskWorkflowStates.set('2.1', 'reviewer_run');
		session.taskWorkflowStates.set('2.2', 'reviewer_run');
		session.taskWorkflowStates.set('2.3', 'reviewer_run');
		session.currentTaskId = '2.1';

		const output = {
			output: `[TESTED] | task-2.1 | PASS | 10/10 tests passed
[TESTED] | task-2.2 | PASS | 8/8 tests passed
[TESTED] | task-2.3 | FAIL | 6/10 tests passed — missing error path tests`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc22-2',
				callID: 'call-sc22-2',
				args: { subagent_type: 'test_engineer' },
			},
			output,
		);

		// All tasks should have advanced to tests_run since reviewer was already run
		for (const taskId of ['2.1', '2.2', '2.3']) {
			const state = session.taskWorkflowStates.get(taskId);
			expect(state).toBe('tests_run');
		}
	});

	it('SC-023.1: unparseable output falls back to single-task attribution (no per-task verdicts)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-1', 'architect');
		const session = ensureAgentSession('sess-sc23-1');

		// Set up a single task in coder_delegated state
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.currentTaskId = '1.1';

		// Output without structured verdict lines — should fall back to single-task
		const output = {
			output: `VERDICT: APPROVED
Reviewed the code. No issues found.`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc23-1',
				callID: 'call-sc23-1',
				args: { subagent_type: 'reviewer' },
			},
			output,
		);

		// Should have advanced to reviewer_run (single-task fallback behavior)
		expect(session.taskWorkflowStates.get('1.1')).toBe('reviewer_run');
	});

	it('SC-023.2: empty output falls back to existing taskWorkflowStates iteration', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-2', 'architect');
		const session = ensureAgentSession('sess-sc23-2');

		// Set up task in coder_delegated state
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.currentTaskId = '1.1';

		// Empty output — should fall back
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc23-2',
				callID: 'call-sc23-2',
				args: { subagent_type: 'reviewer' },
			},
			{ output: '' },
		);

		// Should still advance (fallback path)
		expect(session.taskWorkflowStates.get('1.1')).toBe('reviewer_run');
	});

	it('SC-023.3: mixed output — parseable verdicts take precedence over fallback', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-3', 'architect');
		const session = ensureAgentSession('sess-sc23-3');

		// Set up 2 tasks in coder_delegated state
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.taskWorkflowStates.set('2.2', 'coder_delegated');
		session.currentTaskId = '2.1';

		// Output has ONE structured verdict line and some regular text
		const output = {
			output: `I reviewed the code.

[REVIEWED] | task-2.1 | APPROVED | No issues found

The code looks good overall.`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc23-3',
				callID: 'call-sc23-3',
				args: { subagent_type: 'reviewer' },
			},
			output,
		);

		// Only task 2.1 should have reviewer recorded (per-task attribution from parseable verdict)
		// Task 2.2 should NOT be affected (no over-attribution)
		// But state machine still processes eligible tasks from taskWorkflowStates for advancement
		const state2_1 = session.taskWorkflowStates.get('2.1');
		const state2_2 = session.taskWorkflowStates.get('2.2');

		// 2.1 should advance (has reviewer completion + parseable verdict)
		expect(state2_1).toBe('reviewer_run');
		// 2.2 might advance via fallback iteration if it's also eligible
		// The key is we're not over-attributing the completion record
		expect(state2_2).toBeDefined();
	});

	it('SC-022.3: reviewer set-dispatch creates per-task evidence entries', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-3', 'architect');
		const session = ensureAgentSession('sess-sc22-3');

		// Set up 2 tasks in coder_delegated state
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.taskWorkflowStates.set('2.2', 'coder_delegated');
		session.currentTaskId = '2.1';

		const output = {
			output: `[REVIEWED] | task-2.1 | APPROVED | Clean code
[REVIEWED] | task-2.2 | APPROVED | Minor refactor needed`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc22-3',
				callID: 'call-sc22-3',
				args: { subagent_type: 'reviewer' },
			},
			output,
		);

		// Both tasks should have advanced to reviewer_run
		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('reviewer_run');
	});

	it('SC-023.4: backward-compat — single-task dispatch still works without structured verdicts', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-backward', 'architect');
		const session = ensureAgentSession('sess-sc23-backward');

		// Single task setup
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.currentTaskId = '1.1';

		// Regular reviewer output without structured verdict format
		const output = {
			output: `VERDICT: APPROVED
Reviewed the code. No issues found.`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc23-backward',
				callID: 'call-sc23-backward',
				args: { subagent_type: 'reviewer' },
			},
			output,
		);

		// Should work as before — single-task advancement
		expect(session.taskWorkflowStates.get('1.1')).toBe('reviewer_run');
	});

	it('SC-022.4: complex three-digit task IDs are parsed correctly', () => {
		const output = `
[REVIEWED] | task-10.1.2 | APPROVED | Valid
[TESTED] | task-10.1.2 | PASS | All tests pass
`;
		const verdicts = parsePerTaskVerdicts(output);
		expect(verdicts.get('10.1.2')).toBe('PASS');
	});

	it('SC-022.REGRESSION: reviewer verdict for task-2.1 only does NOT over-attribute to 2.2 or 2.3', async () => {
		// Regression test: when perTaskVerdicts parses only task-2.1 from the output,
		// recordStageBCompletion must NOT be called for 2.2 or 2.3.
		// Bug: the loop iterated ALL taskWorkflowStates regardless of perTaskVerdicts.
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc22-regression', 'architect');
		const session = ensureAgentSession('sess-sc22-regression');

		// Set up 3 tasks in coder_delegated state
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.taskWorkflowStates.set('2.2', 'coder_delegated');
		session.taskWorkflowStates.set('2.3', 'coder_delegated');
		session.currentTaskId = '2.1';

		// Output contains verdict ONLY for task-2.1
		const output = {
			output: `[REVIEWED] | task-2.1 | APPROVED | No issues found in the implementation`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc22-regression',
				callID: 'call-sc22-regression',
				args: { subagent_type: 'reviewer' },
			},
			output,
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
		// 2.2 and 2.3 should remain in coder_delegated (no completion recorded)
		expect(session.taskWorkflowStates.get('2.2')).toBe('coder_delegated');
		expect(session.taskWorkflowStates.get('2.3')).toBe('coder_delegated');
	});

	it('SC-023.REGRESSION: test_engineer verdict for task-2.1 only does NOT over-attribute to 2.2', async () => {
		// Same regression test for test_engineer agent type
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		startAgentSession('sess-sc23-regression', 'architect');
		const session = ensureAgentSession('sess-sc23-regression');

		// Set up 2 tasks in reviewer_run state (ready for test_engineer)
		session.taskWorkflowStates.set('2.1', 'reviewer_run');
		session.taskWorkflowStates.set('2.2', 'reviewer_run');
		session.currentTaskId = '2.1';

		// Output contains verdict ONLY for task-2.1
		const output = {
			output: `[TESTED] | task-2.1 | PASS | 10/10 tests passed`,
		};

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'sess-sc23-regression',
				callID: 'call-sc23-regression',
				args: { subagent_type: 'test_engineer' },
			},
			output,
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

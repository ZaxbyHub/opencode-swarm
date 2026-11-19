/**
 * Completion gate vs the OpenCode v2 Code Mode `execute` wrapper.
 *
 * On a v2 host every plugin tool is reached through the host-owned `execute`
 * wrapper (`{ code }`), and each nested `tools.<name>()` call is dispatched
 * through tool.execute.before under its own name. Gating the wrapper itself
 * as an opaque non-read-only tool denied every plugin call once a task reached
 * tests_run — including the `update_task_status` call the violation message
 * prescribes and the exempt `check_gate_status` — so the task could never
 * leave the gate. The gate must judge the nested calls, not the wrapper.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
	isCodeModeWrapperCall,
	recordCodeModeWrapperCall,
	resetCodeModeWrapperCalls,
} from '../../../src/hooks/code-mode-wrapper';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { registerV2ToolHooks } from '../../../src/host/v2/hooks';
import type {
	V1HooksSubset,
	V2ToolHookInput,
} from '../../../src/host/v2/types';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	recordPlanCriticApproval,
	seedAuthoritativeTaskWorkflow,
} from './_delegation-gate-helpers';

const SESSION = 'code-mode-session';
const WRAPPER_CODE =
	'return await tools.update_task_status({ task_id: "1.1", status: "completed" });';

function makeConfig(): PluginConfig {
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

async function writePlan(dir: string): Promise<void> {
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: ['1.1', '1.2'].map((id) => ({
					id,
					phase: 1,
					status: 'pending' as const,
					size: 'small' as const,
					description: `Task ${id}`,
					depends: [],
					files_touched: ['src/foo.ts'],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await recordPlanCriticApproval(dir, plan);
}

async function denial(run: () => Promise<unknown>): Promise<string | null> {
	try {
		await run();
		return null;
	} catch (err) {
		return (err as Error).message;
	}
}

describe('completion gate: Code Mode execute wrapper', () => {
	let dir: string;
	let hook: ReturnType<typeof createDelegationGateHook>;

	beforeEach(async () => {
		resetSwarmState();
		resetCodeModeWrapperCalls();
		dir = canonicalMkdtemp('completion-code-mode-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await writePlan(dir);
		ensureAgentSession(SESSION);
		await seedAuthoritativeTaskWorkflow(dir, '1.1', 'tests_run', SESSION);
		hook = createDelegationGateHook(makeConfig(), dir);
	});

	afterEach(() => {
		resetSwarmState();
		resetCodeModeWrapperCalls();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('admits the adapter-marked wrapper call whose program carries the prescribed update_task_status', async () => {
		recordCodeModeWrapperCall(SESSION, 'call-wrapper');
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'execute', sessionID: SESSION, callID: 'call-wrapper' },
				{ args: { code: WRAPPER_CODE } },
			),
		);
		expect(message).toBeNull();
	});

	it('still denies an unmarked execute call (no adapter mark, negative control)', async () => {
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'execute', sessionID: SESSION, callID: 'call-unmarked' },
				{ args: { code: WRAPPER_CODE } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});

	it('names the audited blocked exit for when completion itself is refused', async () => {
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'save_plan', sessionID: SESSION, callID: 'call-plan' },
				{ args: { title: 'x' } },
			),
		);
		expect(message).toContain('status="blocked"');
		expect(message).toContain('releases this gate');
	});

	it('does not extend the wrapper mark to an execute call under a different call id', async () => {
		// The mark is recorded under the wrapper's own call id; a nested
		// tools.<name>() call is a separate event with its own call id and is
		// judged on its own, even when it also names execute and carries code.
		recordCodeModeWrapperCall(SESSION, 'call-wrapper');
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'execute', sessionID: SESSION, callID: 'call-nested' },
				{ args: { code: WRAPPER_CODE } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});

	// Each admission clause is pinned on its own: the mark alone must not admit
	// a call that is not the `execute` wrapper or does not carry a program.
	it('does not admit a marked call whose tool is not execute, even with a string code arg', async () => {
		recordCodeModeWrapperCall(SESSION, 'call-wrapper');
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'save_plan', sessionID: SESSION, callID: 'call-wrapper' },
				{ args: { title: 'x', code: 'return 1;' } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});

	it('does not admit a marked execute call without a string code program', async () => {
		recordCodeModeWrapperCall(SESSION, 'call-wrapper');
		for (const args of [{}, { code: 42 }, { code: null }]) {
			const message = await denial(() =>
				hook.toolBefore(
					{ tool: 'execute', sessionID: SESSION, callID: 'call-wrapper' },
					{ args },
				),
			);
			expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
		}
	});

	// The admission does not inspect the program (single-call shape is only
	// enforced by the Full-Auto classifier). Pinned so a future tightening or an
	// accidental change is a deliberate, visible test edit.
	it('admits any marked wrapper program: the gate does not inspect program shape', async () => {
		recordCodeModeWrapperCall(SESSION, 'call-wrapper');
		const programs = [
			'const r = await tools.update_task_status({ task_id: "1.1", status: "blocked" }); return r;',
			'return 1;',
			'await fetch("https://example.invalid/"); return 1;',
		];
		for (const code of programs) {
			const message = await denial(() =>
				hook.toolBefore(
					{ tool: 'execute', sessionID: SESSION, callID: 'call-wrapper' },
					{ args: { code } },
				),
			);
			expect(message).toBeNull();
		}
	});

	it('releases the gate on plan status alone once the awaiting task is blocked', async () => {
		// Pins the plan-status skip in findTaskAwaitingCompletion on its own: the
		// real blocked call below also moves task evidence off tests_run, which
		// releases the gate independently of this skip.
		const planPath = path.join(dir, '.swarm', 'plan.json');
		const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Plan;
		const task = plan.phases[0].tasks.find((t) => t.id === '1.1');
		expect(task).toBeDefined();
		if (task) task.status = 'blocked';
		fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'save_plan', sessionID: SESSION, callID: 'call-plan-blocked' },
				{ args: { title: 'x' } },
			),
		);
		expect(message).toBeNull();
	});

	it('releases the gate through the real update_task_status blocked call the message names', async () => {
		const engaged = await denial(() =>
			hook.toolBefore(
				{
					tool: 'save_plan',
					sessionID: SESSION,
					callID: 'call-before-blocked',
				},
				{ args: { title: 'x' } },
			),
		);
		expect(engaged).toContain('TASK_COMPLETION_GATE_VIOLATION');
		const result = await executeUpdateTaskStatus(
			{ task_id: '1.1', status: 'blocked' },
			dir,
			{ sessionID: SESSION } as ToolContext,
		);
		expect(result.success).toBe(true);
		// The audit trail the message calls "audited": the terminal WAL for the
		// task is committed. This also keeps the test from passing through the
		// plan-status skip alone (pinned separately above).
		const wal = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'task-terminals', '1.1.json'),
				'utf-8',
			),
		) as { state?: string };
		expect(wal.state).toBe('COMMITTED');
		// The plan itself must record the status: task evidence and the WAL release
		// the gate even if plan.json never reads blocked.
		const persistedPlan = JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', 'plan.json'), 'utf-8'),
		) as Plan;
		expect(
			persistedPlan.phases[0].tasks.find((t) => t.id === '1.1')?.status,
		).toBe('blocked');
		const released = await denial(() =>
			hook.toolBefore(
				{ tool: 'save_plan', sessionID: SESSION, callID: 'call-after-blocked' },
				{ args: { title: 'x' } },
			),
		);
		expect(released).toBeNull();
	});

	it('end to end through the v2 adapter: wrapper admitted, nested save_plan denied', async () => {
		// The mark only lives while the adapter's before chain runs, so observe it
		// mid-chain: the adapter must mark the wrapper (execute with a string
		// code) and nothing else.
		const observedMarks: boolean[] = [];
		const hooks = {
			tool: {},
			agent: {},
			config: async () => {},
			event: async () => {},
			dispose: async () => {},
			'tool.execute.before': async (
				input: { tool: string; sessionID: string; callID: string },
				output: { args: unknown },
			) => {
				observedMarks.push(
					isCodeModeWrapperCall(input.sessionID, input.callID),
				);
				return hook.toolBefore(input, output);
			},
		} as unknown as V1HooksSubset;
		let before: ((event: V2ToolHookInput) => unknown) | undefined;
		const ctx = {
			tool: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
				hook: async (name: string, cb: (event: V2ToolHookInput) => unknown) => {
					if (name === 'execute.before') before = cb;
					return { dispose: async () => {} };
				},
			},
		};
		await registerV2ToolHooks(ctx as never, hooks, dir, []);
		expect(before).toBeDefined();
		const event = (tool: string, input: Record<string, unknown>) =>
			({
				tool,
				sessionID: SESSION,
				agent: 'architect',
				messageID: 'msg-1',
				id: 'call-e2e',
				input,
			}) as unknown as V2ToolHookInput;

		expect(
			await denial(async () =>
				before?.(event('execute', { code: WRAPPER_CODE })),
			),
		).toBeNull();
		// Adapter-level control: an execute event without a string code is not
		// marked as the wrapper, so it stays denied.
		expect(
			await denial(async () => before?.(event('execute', { notCode: 1 }))),
		).toContain('TASK_COMPLETION_GATE_VIOLATION');
		expect(observedMarks).toEqual([true, false]);
		// Control, not discriminating for this change: update_task_status for the
		// awaiting task is also admitted by the pre-existing same-task allowance.
		expect(
			await denial(async () =>
				before?.(
					event('update_task_status', { task_id: '1.1', status: 'completed' }),
				),
			),
		).toBeNull();
		expect(
			await denial(async () => before?.(event('save_plan', { title: 'x' }))),
		).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});
});

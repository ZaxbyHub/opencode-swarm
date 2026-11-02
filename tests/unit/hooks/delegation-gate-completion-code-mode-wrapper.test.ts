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
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import {
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
		dir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'completion-code-mode-')),
		);
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

	it('admits the adapter-marked wrapper so the prescribed update_task_status can run', async () => {
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
	});

	it('still gates a mutating nested call under its own name', async () => {
		recordCodeModeWrapperCall(SESSION, 'call-wrapper');
		const message = await denial(() =>
			hook.toolBefore(
				{ tool: 'save_plan', sessionID: SESSION, callID: 'call-wrapper' },
				{ args: { title: 'x' } },
			),
		);
		expect(message).toContain('TASK_COMPLETION_GATE_VIOLATION');
	});

	it('end to end through the v2 adapter: wrapper admitted, nested save_plan denied', async () => {
		const hooks = {
			tool: {},
			agent: {},
			config: async () => {},
			event: async () => {},
			dispose: async () => {},
			'tool.execute.before': hook.toolBefore,
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

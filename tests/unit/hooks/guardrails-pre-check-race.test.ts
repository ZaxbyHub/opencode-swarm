import { beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 1_000,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 1_000,
	max_consecutive_errors: 100,
	warning_threshold: 0.75,
	profiles: undefined,
};

function output(gatesPassed: boolean) {
	const tool = { ran: true, duration_ms: 1 };
	return {
		title: 'pre-check',
		metadata: {},
		output: JSON.stringify({
			batch_status: 'completed',
			gates_passed: gatesPassed,
			lint: tool,
			secretscan: tool,
			sast_scan: tool,
			quality_budget: tool,
			total_duration_ms: 4,
		}),
	};
}

function input(sessionID: string, callID: string, tool = 'pre_check_batch') {
	return { tool, sessionID, callID };
}

describe('pre-check task receipt correlation', () => {
	beforeEach(resetSwarmState);

	test('late task A failure cannot overwrite task B state', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session', 'coder');
		const session = getAgentSession('session')!;
		session.currentTaskId = 'task-a';
		session.taskWorkflowStates.set('task-a', 'coder_delegated');
		await hooks.toolBefore(input('session', 'call-a'), { args: {} });

		session.currentTaskId = 'task-b';
		session.taskWorkflowStates.set('task-b', 'coder_delegated');
		await hooks.toolAfter(input('session', 'call-a'), output(false));

		expect(session.lastGateFailure).toBeNull();
		expect(session.taskWorkflowStates.get('task-b')).toBe('coder_delegated');
	});

	test('late task A pass cannot clear or advance task B', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session', 'coder');
		const session = getAgentSession('session')!;
		session.currentTaskId = 'task-a';
		await hooks.toolBefore(input('session', 'call-a'), { args: {} });

		session.currentTaskId = 'task-b';
		session.taskWorkflowStates.set('task-b', 'coder_delegated');
		session.lastGateFailure = {
			tool: 'pre_check_batch',
			taskId: 'task-b',
			timestamp: 1,
		};
		await hooks.toolAfter(input('session', 'call-a'), output(true));

		expect(session.lastGateFailure?.taskId).toBe('task-b');
		expect(session.taskWorkflowStates.get('task-b')).toBe('coder_delegated');
	});

	test('missing and evicted receipts are non-mutating', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session', 'coder');
		const session = getAgentSession('session')!;
		session.currentTaskId = 'task-a';
		session.taskWorkflowStates.set('task-a', 'coder_delegated');

		await hooks.toolAfter(input('session', 'missing'), output(true));
		for (let index = 0; index < 257; index++) {
			await hooks.toolBefore(input('session', `call-${index}`), { args: {} });
		}
		await hooks.toolAfter(input('session', 'call-0'), output(true));

		expect(session.taskWorkflowStates.get('task-a')).toBe('coder_delegated');
		expect(session.lastGateFailure).toBeNull();
	});

	test('identical call IDs in concurrent sessions remain isolated', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session-a', 'coder');
		startAgentSession('session-b', 'coder');
		const sessionA = getAgentSession('session-a')!;
		const sessionB = getAgentSession('session-b')!;
		sessionA.currentTaskId = 'task-a';
		sessionB.currentTaskId = 'task-b';
		sessionA.taskWorkflowStates.set('task-a', 'coder_delegated');
		sessionB.taskWorkflowStates.set('task-b', 'coder_delegated');

		await hooks.toolBefore(input('session-a', 'shared-call'), { args: {} });
		await hooks.toolBefore(input('session-b', 'shared-call'), { args: {} });
		await hooks.toolAfter(input('session-a', 'shared-call'), output(false));
		await hooks.toolAfter(input('session-b', 'shared-call'), output(true));

		expect(sessionA.lastGateFailure).toMatchObject({
			taskId: 'task-a',
			code: 'PRE_CHECK_FAILED',
		});
		expect(sessionB.lastGateFailure).toBeNull();
		expect(sessionA.taskWorkflowStates.get('task-a')).toBe('coder_delegated');
		expect(sessionB.taskWorkflowStates.get('task-b')).toBe('pre_check_passed');
	});

	test('a successful informational gate cannot clear a pre-check failure', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session', 'coder');
		const session = getAgentSession('session')!;
		session.currentTaskId = 'task-a';
		session.taskWorkflowStates.set('task-a', 'coder_delegated');

		await hooks.toolBefore(input('session', 'precheck'), { args: {} });
		await hooks.toolAfter(input('session', 'precheck'), output(false));
		expect(session.lastGateFailure).toMatchObject({
			tool: 'pre_check_batch',
			code: 'PRE_CHECK_FAILED',
		});

		for (const [tool, callID] of [
			['lint', 'lint-pass'],
			['quality_budget', 'quality-pass'],
		] as const) {
			await hooks.toolBefore(input('session', callID, tool), { args: {} });
			await hooks.toolAfter(input('session', callID, tool), {
				title: tool,
				metadata: {},
				output: 'ok',
			});
		}

		expect(session.lastGateFailure).toMatchObject({
			tool: 'pre_check_batch',
			taskId: 'task-a',
			code: 'PRE_CHECK_FAILED',
		});
	});
});

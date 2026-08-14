import { beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../src/hooks/guardrails';
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
	const secretscan = {
		...tool,
		result: {
			count: 0,
			findings: [],
			files_scanned: 1,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	};
	const sastScan = { ...tool, result: { verdict: 'pass' } };
	return {
		title: 'pre-check',
		metadata: {},
		output: JSON.stringify({
			batch_status: 'completed',
			gates_passed: gatesPassed,
			lint: tool,
			secretscan,
			sast_scan: sastScan,
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

	test('late task A failure remains bound to A after currentTaskId moves to B', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session', 'coder');
		const session = getAgentSession('session')!;
		session.currentTaskId = 'task-a';
		session.taskWorkflowStates.set('task-a', 'coder_delegated');
		await hooks.toolBefore(input('session', 'call-a'), { args: {} });

		session.currentTaskId = 'task-b';
		session.taskWorkflowStates.set('task-b', 'coder_delegated');
		await hooks.toolAfter(input('session', 'call-a'), output(false));

		expect(session.lastGateFailure).toMatchObject({
			taskId: 'task-a',
			code: 'PRE_CHECK_FAILED',
		});
		expect(session.taskWorkflowStates.get('task-a')).toBe('coder_delegated');
		expect(session.taskWorkflowStates.get('task-b')).toBe('coder_delegated');
	});

	test('late task A pass advances only A after currentTaskId moves to B', async () => {
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
		expect(session.taskWorkflowStates.get('task-a')).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get('task-b')).toBe('coder_delegated');
	});

	test('missing receipts are non-mutating', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session', 'coder');
		const session = getAgentSession('session')!;
		session.currentTaskId = 'task-a';
		session.taskWorkflowStates.set('task-a', 'coder_delegated');

		await hooks.toolAfter(input('session', 'missing'), output(true));

		expect(session.taskWorkflowStates.get('task-a')).toBe('coder_delegated');
		expect(session.lastGateFailure).toBeNull();
	});

	test('F-011 isolates live receipt capacity by session and fails closed at the per-session cap', async () => {
		const hooks = createGuardrailsHooks(config);
		startAgentSession('session-a', 'coder');
		startAgentSession('session-b', 'coder');
		const sessionA = getAgentSession('session-a')!;
		const sessionB = getAgentSession('session-b')!;
		sessionA.currentTaskId = 'task-a';
		sessionB.currentTaskId = 'task-b';
		sessionA.taskWorkflowStates.set('task-a', 'coder_delegated');
		sessionB.taskWorkflowStates.set('task-b', 'coder_delegated');

		await hooks.toolBefore(input('session-a', 'call-a'), { args: {} });
		for (
			let index = 0;
			index < _internals.MAX_PENDING_GATE_RECEIPTS_PER_SESSION;
			index++
		) {
			await hooks.toolBefore(input('session-b', `call-b-${index}`), {
				args: {},
			});
		}

		// Prior bug: session B's 256th receipt silently evicted session A's live
		// receipt from one global FIFO, so A's valid completion was ignored.
		await expect(
			hooks.toolBefore(input('session-b', 'over-cap'), { args: {} }),
		).rejects.toThrow('GATE_RECEIPT_CAPACITY');
		await hooks.toolAfter(input('session-a', 'call-a'), output(true));

		expect(sessionA.taskWorkflowStates.get('task-a')).toBe('pre_check_passed');
		expect(sessionA.gateLog.get('task-a')).toContain('pre_check_batch');
		expect(sessionB.taskWorkflowStates.get('task-b')).toBe('coder_delegated');
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

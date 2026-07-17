import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import * as realExecutor from '../../../src/sandbox/executor';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const failingExecutor = () => ({
	isAvailable: () => true,
	mechanism: 'test-wrapper',
	wrapCommand: () => {
		throw new Error('wrapper construction failed');
	},
	getEnvOverrides: () => ({}),
});

const getExecutorMock = mock(async () => failingExecutor());

mock.module('../../../src/sandbox/executor', () => ({
	...realExecutor,
	getExecutor: getExecutorMock,
}));

const { createGuardrailsHooks } = await import('../../../src/hooks/guardrails');
const { claimScopeBindingForChild, createScopeBinding, registerScopeBinding } =
	await import('../../../src/scope/scope-binding');
const { getAgentSession, resetSwarmState, startAgentSession, swarmState } =
	await import('../../../src/state');

let directory: string;
let cleanup: () => void;

describe('guardrails sandbox-before circuit — regression: issue #1875', () => {
	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('sandbox-circuit-');
		directory = created.dir;
		cleanup = created.cleanup;
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Sandbox circuit',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Fix',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'test',
							depends: [],
							files_touched: ['src'],
						},
					],
				},
			],
		};
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		getExecutorMock.mockImplementation(async () => failingExecutor());
		startAgentSession('sandbox-before', 'coder', directory);
		swarmState.activeAgent.set('sandbox-before', 'coder');
		const session = getAgentSession('sandbox-before');
		if (!session) throw new Error('test session missing');
		session.currentTaskId = '1.1';
		session.declaredCoderScope = ['src'];
		registerScopeBinding(
			createScopeBinding({
				directory,
				plan,
				taskId: '1.1',
				files: ['src'],
				ownerSessionId: 'sandbox-parent',
				ownerMessageId: 'task-call',
				dispatchCallId: 'task-call',
				source: 'plan',
			})!,
		);
		claimScopeBindingForChild({
			directory,
			parentSessionId: 'sandbox-parent',
			childSessionId: 'sandbox-before',
			dispatchCallId: 'task-call',
		});
	});

	afterEach(() => {
		getExecutorMock.mockClear();
		resetSwarmState();
		cleanup();
	});

	it('records wrapper failures and hard-stops the first attempt', async () => {
		const hooks = createGuardrailsHooks(directory, {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			idle_timeout_minutes: 60,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			shell_audit_log: false,
			profiles: undefined,
		});

		await expect(
			hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'sandbox-before',
					callID: 'wrapper-1',
				},
				{ args: { command: 'echo attempt-1' } },
			),
		).rejects.toThrow('NON-TRANSIENT CIRCUIT BREAKER');

		const circuit = (
			getAgentSession('sandbox-before') as unknown as {
				nonTransientCircuit?: {
					category: string;
					sameCategoryCount: number;
					hardStop: boolean;
				};
			}
		).nonTransientCircuit;
		expect(circuit).toMatchObject({
			category: 'sandbox_wrapper_failure',
			sameCategoryCount: 1,
			hardStop: true,
		});
	});

	it('correlates a wrapped command result back to the sandbox failure category', async () => {
		getExecutorMock.mockImplementation(async () => ({
			isAvailable: () => true,
			mechanism: 'test-wrapper',
			wrapCommand: () => 'wrapped-command',
			getEnvOverrides: () => ({}),
		}));
		const hooks = createGuardrailsHooks(directory, {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			idle_timeout_minutes: 60,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			shell_audit_log: false,
			profiles: undefined,
		});
		const args = { command: 'echo original' };

		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'sandbox-before', callID: 'wrapped-result' },
			{ args },
		);
		expect(args.command).toBe('wrapped-command');
		expect(
			getAgentSession('sandbox-before')?.pendingToolExecutions?.get(
				'wrapped-result',
			),
		).toMatchObject({
			originalCommand: 'echo original',
			sandboxWrapped: true,
		});

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID: 'sandbox-before',
				callID: 'wrapped-result',
				args,
			},
			{
				title: 'shell',
				output: 'ParserError: MissingEndCurlyBrace',
				metadata: { exit: 1 },
			},
		);

		expect(
			getAgentSession('sandbox-before')?.nonTransientCircuit,
		).toMatchObject({
			category: 'sandbox_wrapper_failure',
			sameCategoryCount: 1,
			hardStop: true,
		});
	});

	it('merges executor environment overrides into the shell tool arguments', async () => {
		getExecutorMock.mockImplementation(async () => ({
			isAvailable: () => true,
			mechanism: 'test-wrapper',
			wrapCommand: () => 'wrapped-command',
			getEnvOverrides: () => ({
				PATH: 'C:\\safe-bin',
				DYLD_INSERT_LIBRARIES: null,
			}),
		}));
		const hooks = createGuardrailsHooks(directory, {
			enabled: true,
			max_tool_calls: 200,
			max_duration_minutes: 30,
			idle_timeout_minutes: 60,
			max_repetitions: 10,
			max_consecutive_errors: 5,
			warning_threshold: 0.75,
			shell_audit_log: false,
			profiles: undefined,
		});
		const args: {
			command: string;
			env: Record<string, string | null>;
		} = {
			command: 'echo original',
			env: {
				KEEP: 'preserved',
				PATH: 'unsafe',
				DYLD_INSERT_LIBRARIES: 'injected',
			},
		};

		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'sandbox-before', callID: 'env-overrides' },
			{ args },
		);

		expect(args.command).toBe('wrapped-command');
		expect(args.env).toEqual({
			KEEP: 'preserved',
			PATH: 'C:\\safe-bin',
			DYLD_INSERT_LIBRARIES: null,
		});
	});
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as guardrailsInternals } from '../../../src/hooks/guardrails';
import { ensureAgentSession, getAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const equivalentMechanism = 'bubblewrap';

const failingExecutor = () => ({
	isAvailable: () => true,
	mechanism: equivalentMechanism,
	wrapCommand: () => {
		throw new Error('wrapper construction failed');
	},
	getEnvOverrides: () => ({}),
});
const originalGetSandboxExecutor = guardrailsInternals.getSandboxExecutor;
const originalAssessSandboxEnforcement =
	guardrailsInternals.assessSandboxEnforcement;

const { createGuardrailsHooks } = await import('../../../src/hooks/guardrails');
const { resetSwarmState, startAgentSession, swarmState } = await import(
	'../../../src/state'
);

let directory: string;
let cleanup: () => void;

describe('guardrails sandbox-before circuit — regression: issue #1875', () => {
	beforeEach(() => {
		guardrailsInternals.getSandboxExecutor = async () => failingExecutor();
		guardrailsInternals.assessSandboxEnforcement = async () =>
			({
				satisfied: true,
				capability: {
					identity: 'linux:bubblewrap:test',
					mechanism: 'bubblewrap',
				},
				cacheKey: 'linux:bubblewrap:test',
			}) as Awaited<ReturnType<typeof originalAssessSandboxEnforcement>>;
		resetSwarmState();
		const created = createSafeTestDir('sandbox-circuit-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		ensureAgentSession('sandbox-before', 'coder', directory);
		swarmState.activeAgent.set('sandbox-before', 'coder');
		installActiveScopeBinding({
			directory,
			childSessionId: 'sandbox-before',
			taskId: '1.1',
			files: ['src/'],
			parentSessionId: 'sandbox-parent',
			dispatchCallId: 'wrapper-1',
		});
	});

	afterEach(() => {
		guardrailsInternals.getSandboxExecutor = originalGetSandboxExecutor;
		guardrailsInternals.assessSandboxEnforcement =
			originalAssessSandboxEnforcement;
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
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => true,
			mechanism: equivalentMechanism,
			wrapCommand: () => 'wrapped-command',
			getEnvOverrides: () => ({}),
		});
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

	it('leaves unsupported shell args.env untouched because the wrapper owns its environment', async () => {
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => true,
			mechanism: equivalentMechanism,
			wrapCommand: () => 'wrapped-command',
			getEnvOverrides: () => {
				throw new Error('unsupported host args.env path must not be queried');
			},
		});
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
			PATH: 'unsafe',
			DYLD_INSERT_LIBRARIES: 'injected',
		});
	});
});

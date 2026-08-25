import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { _test_exports as nonTransientTestExports } from '../../../src/hooks/guardrails/nontransient-circuit';
import {
	beginInvocation,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { telemetry } from '../../../src/telemetry';

const TEST_DIRECTORY = process.cwd();

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	shell_audit_log: false,
	profiles: undefined,
};

type CircuitView = {
	category: string | null;
	sameCategoryCount: number;
	hardStop: boolean;
};

function setupSession(sessionID: string, agent = 'coder'): void {
	startAgentSession(sessionID, agent);
	swarmState.activeAgent.set(sessionID, agent);
	beginInvocation(sessionID, agent);
}

function circuit(sessionID: string): CircuitView | undefined {
	return (
		getAgentSession(sessionID) as unknown as {
			nonTransientCircuit?: CircuitView;
		}
	).nonTransientCircuit;
}

function shellResult(
	output: string,
	exit: number | null,
): { title: string; output: string; metadata: { exit: number | null } } {
	return { title: 'shell', output, metadata: { exit } };
}

async function runToolLifecycle(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	input: {
		tool: string;
		sessionID: string;
		callID: string;
		args?: Record<string, unknown>;
	},
	output: unknown,
): Promise<void> {
	await hooks.toolBefore(
		{ tool: input.tool, sessionID: input.sessionID, callID: input.callID },
		{ args: input.args ?? {} },
	);
	await hooks.toolAfter(input, output as never);
}

describe('guardrails non-transient circuit — regression: issue #1875', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('classifies a live-shaped parser exit and hard-stops immediately', async () => {
		const sessionID = 'parse-first';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID,
				callID: 'parse-1',
				args: { command: 'broken command 1' },
			},
			{
				title: 'shell',
				output: 'shell parser failed',
				error: 'ParserError: MissingEndCurlyBrace: Missing closing brace',
				metadata: { exit: 1 },
			},
		);

		expect(circuit(sessionID)).toMatchObject({
			category: 'shell_parse_error',
			sameCategoryCount: 1,
			hardStop: true,
		});
		expect(
			getAgentSession(sessionID)?.pendingAdvisoryMessages?.join('\n'),
		).toContain('STOP');
	});

	it('does not hard-stop unrelated general permanent failures with different action identities', async () => {
		const sessionID = 'general-three';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		for (let attempt = 1; attempt <= 3; attempt++) {
			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID,
					callID: `general-${attempt}`,
					args: { command: `different failing command ${attempt}` },
				},
				shellResult('permission denied', 2),
			);
		}

		expect(circuit(sessionID)).toMatchObject({
			category: 'general_permanent',
			sameCategoryCount: 1,
			hardStop: false,
		});
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID, callID: 'allowed-next' },
				{ args: { filePath: 'package.json' } },
			),
		).resolves.toBeUndefined();
	});

	it('emits loop telemetry exactly once when each circuit transitions to hard stop', async () => {
		const loopDetected = spyOn(telemetry, 'loopDetected').mockImplementation(
			() => {},
		);
		try {
			const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
			setupSession('parser-telemetry');
			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID: 'parser-telemetry',
					callID: 'parser-1',
					args: { command: 'broken' },
				},
				{
					...shellResult('', 1),
					error: 'ParserError: MissingEndCurlyBrace',
				},
			);

			setupSession('general-telemetry');
			for (let attempt = 1; attempt <= 4; attempt++) {
				await runToolLifecycle(
					hooks,
					{
						tool: 'bash',
						sessionID: 'general-telemetry',
						callID: `general-${attempt}`,
						args: { command: `failing-${attempt}` },
					},
					shellResult('permission denied', 2),
				);
			}

			expect(loopDetected).toHaveBeenCalledTimes(1);
			expect(loopDetected).toHaveBeenNthCalledWith(
				1,
				'parser-telemetry',
				'coder',
				expect.stringContaining('nontransient:shell_parse_error:'),
			);
		} finally {
			loopDetected.mockRestore();
		}
	});

	it('preserves a permanent-failure streak across a malformed after-hook payload', async () => {
		const sessionID = 'malformed-after';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		for (let attempt = 1; attempt <= 2; attempt++) {
			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID,
					callID: `malformed-${attempt}`,
					args: { command: `failing-command-${attempt}` },
				},
				shellResult('permission denied', 2),
			);
		}
		await runToolLifecycle(
			hooks,
			{ tool: 'read', sessionID, callID: 'malformed-result' },
			undefined as never,
		);
		expect(circuit(sessionID)).toMatchObject({
			category: 'general_permanent',
			sameCategoryCount: 1,
			hardStop: false,
		});
	});

	it('uses explicit hook errors for command-not-found classification', async () => {
		const sessionID = 'explicit-error';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID,
				callID: 'missing-1',
				args: { command: 'missing-tool' },
			},
			{
				title: 'shell',
				output: '',
				metadata: {},
				error: 'CommandNotFoundException: missing-tool was not found',
			} as never,
		);

		expect(circuit(sessionID)).toMatchObject({
			category: 'command_not_found',
			sameCategoryCount: 1,
			hardStop: true,
		});
	});

	it('recognizes typed command-not-found failures from shell runtimes', async () => {
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		for (const [sessionID, signal] of [
			['powershell-missing', 'CommandNotFoundException: missing-tool'],
			['spawn-missing', 'Error: spawn missing-tool ENOENT'],
		] as const) {
			setupSession(sessionID);
			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID,
					callID: `${sessionID}-call`,
					args: { command: 'missing-tool' },
				},
				{ ...shellResult('', 127), error: signal },
			);
			expect(circuit(sessionID)).toMatchObject({
				category: 'command_not_found',
				sameCategoryCount: 1,
				hardStop: true,
			});
		}
	});

	it('breaks a general-permanent streak only on exact success or neutral outcomes', async () => {
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		const breakers = [
			['success', 'echo ok', shellResult('ok', 0)],
			['neutral', 'rg absent src', shellResult('', 1)],
		] as const;

		for (const [name, command, breaker] of breakers) {
			const sessionID = `break-${name}`;
			setupSession(sessionID);
			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID,
					callID: `${name}-failure`,
					args: { command: 'failing-command' },
				},
				shellResult('permission denied', 2),
			);
			expect(circuit(sessionID)?.sameCategoryCount).toBe(1);

			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID,
					callID: `${name}-breaker`,
					args: { command },
				},
				breaker,
			);
			expect(circuit(sessionID)?.sameCategoryCount ?? 0).toBe(0);
		}
	});

	it('treats exitCode and invalid shell exit metadata as proven permanent failures', async () => {
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		for (const [sessionID, metadata] of [
			['exit-code', { exitCode: 2 }],
			['invalid-exit', { exit: 'not-a-number' }],
		] as const) {
			setupSession(sessionID);
			await runToolLifecycle(
				hooks,
				{
					tool: 'bash',
					sessionID,
					callID: `${sessionID}-call`,
					args: { command: 'failing-command' },
				},
				{ title: 'shell', output: '', metadata } as never,
			);
			expect(circuit(sessionID)).toMatchObject({
				category: 'general_permanent',
				sameCategoryCount: 1,
				hardStop: false,
			});
		}
	});

	it('does not treat parser text from an exit-zero shell result as failure', async () => {
		const sessionID = 'exit-zero';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID,
				callID: 'docs-output',
				args: { command: 'echo ParserError MissingEndCurlyBrace' },
			},
			shellResult(
				'ParserError and MissingEndCurlyBrace are documented here',
				0,
			),
		);

		expect(circuit(sessionID)?.sameCategoryCount ?? 0).toBe(0);
	});

	it('treats rg exit 1 and git diff --quiet exit 1 as neutral only for exact original commands', async () => {
		const sessionID = 'neutral-exit-one';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		for (const [callID, command] of [
			['rg-none', 'rg impossible-pattern src'],
			['git-clean', 'git diff --quiet'],
		] as const) {
			await runToolLifecycle(
				hooks,
				{ tool: 'bash', sessionID, callID, args: { command } },
				shellResult('(no output)', 1),
			);
		}

		expect(circuit(sessionID)?.sameCategoryCount ?? 0).toBe(0);

		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID,
				callID: 'not-neutral',
				args: { command: 'rg pattern src; missing-tool' },
			},
			shellResult('missing-tool: command not found', 1),
		);

		expect(circuit(sessionID)).toMatchObject({
			category: 'general_permanent',
			sameCategoryCount: 1,
			hardStop: false,
		});
	});

	it('lets a command-not-found signature outrank the rg exit-one adapter', async () => {
		const sessionID = 'missing-rg';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID,
				callID: 'missing-rg-call',
				args: { command: 'rg absent src' },
			},
			{
				...shellResult('', 1),
				error: 'CommandNotFoundException: rg',
			},
		);

		expect(circuit(sessionID)).toMatchObject({
			category: 'command_not_found',
			sameCategoryCount: 1,
			hardStop: true,
		});
	});

	it('clears architect and coder state only at a verified new invocation', async () => {
		const architectID = 'architect-fatal';
		setupSession(architectID, 'architect');
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID: architectID,
				callID: 'architect-parse',
				args: { command: 'broken' },
			},
			shellResult('ParserError: MissingEndCurlyBrace', 1),
		);

		expect(circuit(architectID)?.sameCategoryCount).toBe(1);
		const architectSession = getAgentSession(architectID);
		const priorArchitectInvocation = architectSession?.activeInvocationId ?? 0;
		architectSession?.pendingToolExecutions?.set('stale-call', {
			tool: 'bash',
			originalCommand: 'broken',
			sandboxWrapped: true,
			ownerAgent: 'architect',
			ownerInvocationId: priorArchitectInvocation,
		});

		beginInvocation(architectID, 'architect');
		expect(circuit(architectID)).toMatchObject({
			ownerAgent: 'architect',
			ownerInvocationId: priorArchitectInvocation + 1,
			sameCategoryCount: 0,
			hardStop: false,
		});
		expect(architectSession?.pendingToolExecutions?.size).toBe(1);

		const coderID = 'new-invocation';
		setupSession(coderID);
		await runToolLifecycle(
			hooks,
			{
				tool: 'bash',
				sessionID: coderID,
				callID: 'coder-parse',
				args: { command: 'broken' },
			},
			shellResult('ParserError: MissingEndCurlyBrace', 1),
		);
		expect(circuit(coderID)?.sameCategoryCount).toBe(1);

		beginInvocation(coderID, 'coder');
		expect(circuit(coderID)?.sameCategoryCount ?? 0).toBe(0);
	});

	it('exposes an exact recovery allowlist helper for swarm commands and read-only tools', () => {
		expect(
			nonTransientTestExports.isAllowedRecoverySwarmCommand({
				command: 'diagnose',
			}),
		).toBe(true);
		expect(
			nonTransientTestExports.isAllowedRecoverySwarmCommand({
				command: 'full-auto retry-oversight',
			}),
		).toBe(true);
		expect(
			nonTransientTestExports.isAllowedRecoverySwarmCommand({
				command: 'status',
			}),
		).toBe(false);
		expect(nonTransientTestExports.isRecoveryAllowedTool('read', {})).toBe(
			true,
		);
		expect(
			nonTransientTestExports.isRecoveryAllowedTool('swarm_command', {
				command: 'guardrail reset digest --invocation 3',
			}),
		).toBe(true);
		expect(nonTransientTestExports.isRecoveryAllowedTool('bash', {})).toBe(
			false,
		);
	});
});

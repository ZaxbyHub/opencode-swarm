import { beforeEach, describe, expect, it } from 'bun:test';
import type {
	GuardrailsConfig,
	PluginConfig,
} from '../../../src/config/schema';
import { createDelegationTrackerHook } from '../../../src/hooks/delegation-tracker';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import {
	beginInvocation,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

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

describe('guardrails non-transient circuit — regression: issue #1875', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('classifies a live-shaped parser exit and hard-stops immediately', async () => {
		const sessionID = 'parse-first';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'parse-1',
				args: { command: 'broken command 1' },
			},
			shellResult(
				'ParserError: MissingEndCurlyBrace: Missing closing brace',
				1,
			),
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

	it('hard-stops on the third general permanent failure despite changed arguments', async () => {
		const sessionID = 'general-three';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		for (let attempt = 1; attempt <= 3; attempt++) {
			await hooks.toolAfter(
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
			sameCategoryCount: 3,
			hardStop: true,
		});
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID, callID: 'blocked-next' },
				{ args: { filePath: 'package.json' } },
			),
		).rejects.toThrow('NON-TRANSIENT CIRCUIT BREAKER');
	});

	it('preserves a permanent-failure streak across a malformed after-hook payload', async () => {
		const sessionID = 'malformed-after';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		for (let attempt = 1; attempt <= 2; attempt++) {
			await hooks.toolAfter(
				{
					tool: 'bash',
					sessionID,
					callID: `malformed-${attempt}`,
					args: { command: `failing-command-${attempt}` },
				},
				shellResult('permission denied', 2),
			);
		}
		await hooks.toolAfter(
			{ tool: 'read', sessionID, callID: 'malformed-result' },
			undefined as never,
		);
		expect(circuit(sessionID)).toMatchObject({
			category: 'general_permanent',
			sameCategoryCount: 2,
			hardStop: false,
		});
	});

	it('uses explicit hook errors for command-not-found classification', async () => {
		const sessionID = 'explicit-error';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await hooks.toolAfter(
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

	it('recognizes command-not-found shapes from sh and spawn failures', async () => {
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		for (const [sessionID, signal] of [
			['dash-missing', '/bin/sh: 1: missing-tool: not found'],
			['spawn-missing', 'Error: spawn missing-tool ENOENT'],
		] as const) {
			setupSession(sessionID);
			await hooks.toolAfter(
				{
					tool: 'bash',
					sessionID,
					callID: `${sessionID}-call`,
					args: { command: 'missing-tool' },
				},
				shellResult(signal, 127),
			);
			expect(circuit(sessionID)).toMatchObject({
				category: 'command_not_found',
				sameCategoryCount: 1,
				hardStop: true,
			});
		}
	});

	it('breaks a general-permanent streak on success, neutral, transient, and degraded outcomes', async () => {
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);
		const breakers = [
			['success', 'echo ok', shellResult('ok', 0)],
			['neutral', 'rg absent src', shellResult('', 1)],
			['transient', 'provider-call', shellResult('503 service unavailable', 2)],
			['degraded', 'provider-call', shellResult('context length exceeded', 2)],
		] as const;

		for (const [name, command, breaker] of breakers) {
			const sessionID = `break-${name}`;
			setupSession(sessionID);
			await hooks.toolAfter(
				{
					tool: 'bash',
					sessionID,
					callID: `${name}-failure`,
					args: { command: 'failing-command' },
				},
				shellResult('permission denied', 2),
			);
			expect(circuit(sessionID)?.sameCategoryCount).toBe(1);

			await hooks.toolAfter(
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
			await hooks.toolAfter(
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

		await hooks.toolAfter(
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
			await hooks.toolAfter(
				{ tool: 'bash', sessionID, callID, args: { command } },
				shellResult('(no output)', 1),
			);
		}

		expect(circuit(sessionID)?.sameCategoryCount ?? 0).toBe(0);

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'not-neutral',
				args: { command: 'rg pattern src; missing-tool' },
			},
			shellResult('missing-tool: command not found', 1),
		);

		expect(circuit(sessionID)).toMatchObject({
			category: 'command_not_found',
			sameCategoryCount: 1,
		});
	});

	it('lets a command-not-found signature outrank the rg exit-one adapter', async () => {
		const sessionID = 'missing-rg';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'missing-rg-call',
				args: { command: 'rg absent src' },
			},
			shellResult(
				"'rg' is not recognized as an internal or external command",
				1,
			),
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

		await hooks.toolAfter(
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
		});

		beginInvocation(architectID, 'architect');
		expect(circuit(architectID)).toMatchObject({
			ownerAgent: 'architect',
			ownerInvocationId: priorArchitectInvocation + 1,
			sameCategoryCount: 0,
			hardStop: false,
		});
		expect(architectSession?.pendingToolExecutions?.size).toBe(0);

		const coderID = 'new-invocation';
		setupSession(coderID);
		await hooks.toolAfter(
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

	it('clears a fatal architect stop on the ordinary no-agent takeover turn', async () => {
		const sessionID = 'architect-no-agent-turn';
		setupSession(sessionID, 'architect');
		const hooks = createGuardrailsHooks(TEST_DIRECTORY, config);

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'fatal-parse',
				args: { command: 'broken' },
			},
			shellResult('ParserError: MissingEndCurlyBrace', 1),
		);
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID, callID: 'blocked-old-turn' },
				{ args: { filePath: 'package.json' } },
			),
		).rejects.toThrow('NON-TRANSIENT CIRCUIT BREAKER');

		const tracker = createDelegationTrackerHook({} as PluginConfig, true);
		await tracker({ sessionID }, {});

		expect(circuit(sessionID)).toMatchObject({
			ownerAgent: 'architect',
			sameCategoryCount: 0,
			hardStop: false,
		});
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID, callID: 'allowed-new-turn' },
				{ args: { filePath: 'package.json' } },
			),
		).resolves.toBeUndefined();
	});

	it('does not persist circuit or pending correlation state in snapshots', () => {
		const sessionID = 'snapshot-boundary';
		setupSession(sessionID);
		const session = getAgentSession(sessionID);
		if (!session) throw new Error('test session missing');
		session.nonTransientCircuit = {
			ownerAgent: 'coder',
			ownerInvocationId: session.activeInvocationId,
			category: 'shell_parse_error',
			sameCategoryCount: 3,
			hardStop: true,
			lastSignal: 'ParserError',
		};
		session.pendingToolExecutions?.set('call-1', {
			tool: 'bash',
			originalCommand: 'broken',
			sandboxWrapped: true,
		});

		const serialized = serializeAgentSession(session) as unknown as Record<
			string,
			unknown
		>;
		expect(Object.hasOwn(serialized, 'nonTransientCircuit')).toBe(false);
		expect(Object.hasOwn(serialized, 'pendingToolExecutions')).toBe(false);
	});
});

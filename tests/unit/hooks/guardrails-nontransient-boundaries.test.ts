import { beforeEach, describe, expect, it } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	_test_exports,
	forgetToolExecution,
	markToolExecutionSandboxWrapped,
	recordNonTransientFailure,
	rememberToolExecution,
} from '../../../src/hooks/guardrails/nontransient-circuit';
import {
	beginInvocation,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

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

function setupSession(sessionID: string): void {
	startAgentSession(sessionID, 'coder');
	swarmState.activeAgent.set(sessionID, 'coder');
	beginInvocation(sessionID, 'coder');
}

function shellResult(output: string, exit: number) {
	return { title: 'shell', output, metadata: { exit } };
}

describe('guardrails non-transient boundaries — issue #1875 review', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('keeps a hard stop immutable across a late success and rejects the next tool', async () => {
		const sessionID = 'hard-stop-immutable';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(process.cwd(), config);

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'fatal',
				args: { command: 'broken' },
			},
			shellResult('ParserError: MissingEndCurlyBrace', 1),
		);
		const stopped = getAgentSession(sessionID)?.nonTransientCircuit;
		expect(stopped).toMatchObject({
			category: 'shell_parse_error',
			sameCategoryCount: 1,
			hardStop: true,
		});
		const stoppedSignal = stopped?.lastSignal;

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'late-success',
				args: { command: 'echo ok' },
			},
			shellResult('ok', 0),
		);

		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			category: 'shell_parse_error',
			sameCategoryCount: 1,
			hardStop: true,
			lastSignal: stoppedSignal,
		});
		await expect(
			hooks.toolBefore(
				{ tool: 'read', sessionID, callID: 'blocked-next' },
				{ args: { filePath: 'package.json' } },
			),
		).rejects.toThrow('NON-TRANSIENT CIRCUIT BREAKER');
	});

	it('cannot alternate away from general_permanent without entering an immediate hard stop', async () => {
		const sessionID = 'category-alternation';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(process.cwd(), config);

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'general',
				args: { command: 'denied' },
			},
			shellResult('permission denied', 2),
		);
		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			category: 'general_permanent',
			sameCategoryCount: 1,
			hardStop: false,
		});

		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'parser',
				args: { command: 'broken' },
			},
			shellResult('ParseError: unexpected token', 1),
		);
		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			category: 'shell_parse_error',
			sameCategoryCount: 1,
			hardStop: true,
		});
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID, callID: 'cannot-continue' },
				{ args: { command: 'missing-tool' } },
			),
		).rejects.toThrow('NON-TRANSIENT CIRCUIT BREAKER');
	});

	it('classifies neutral exit-one adapters and fatal signals directly', () => {
		for (const command of [
			'rg pattern src',
			'"rg.exe" pattern src',
			'git -C repo diff --quiet',
			'git diff --quiet -- package.json',
		]) {
			expect(_test_exports.isNeutralExitOne(command)).toBe(true);
		}
		for (const command of ['rg pattern src; echo bad', 'git status --quiet']) {
			expect(_test_exports.isNeutralExitOne(command)).toBe(false);
		}

		expect(_test_exports.classifyFatalSignal('ParserError', false)).toBe(
			'shell_parse_error',
		);
		expect(_test_exports.classifyFatalSignal('ParserError', true)).toBe(
			'sandbox_wrapper_failure',
		);
		expect(
			_test_exports.classifyFatalSignal('[sandbox] BLOCKED: denied', false),
		).toBe('sandbox_wrapper_failure');
		expect(
			_test_exports.classifyFatalSignal(
				'missing-tool: command not found',
				false,
			),
		).toBe('command_not_found');
		expect(
			_test_exports.classifyFatalSignal('permission denied', false),
		).toBeNull();
	});

	it('bounds pending correlations without evicting on same-call replacement', () => {
		const sessionID = 'pending-fifo';
		setupSession(sessionID);
		for (let index = 0; index < 100; index++) {
			rememberToolExecution(sessionID, `call-${index}`, 'bash', `cmd-${index}`);
		}

		rememberToolExecution(sessionID, 'call-50', 'bash', 'replacement');
		let pending = getAgentSession(sessionID)?.pendingToolExecutions;
		expect(pending?.size).toBe(100);
		expect(pending?.has('call-0')).toBe(true);
		expect(pending?.get('call-50')?.originalCommand).toBe('replacement');

		rememberToolExecution(sessionID, 'call-100', 'bash', 'newest');
		pending = getAgentSession(sessionID)?.pendingToolExecutions;
		expect(pending?.size).toBe(100);
		expect(pending?.has('call-0')).toBe(false);
		expect(pending?.has('call-1')).toBe(true);
		expect(pending?.has('call-100')).toBe(true);
	});

	it('truncates retained signals and exposes remember-mark-forget lifecycle', () => {
		const sessionID = 'state-boundaries';
		setupSession(sessionID);
		const longSignal = `prefix-${'x'.repeat(1_100)}`;

		recordNonTransientFailure(sessionID, 'general_permanent', longSignal);
		const retained =
			getAgentSession(sessionID)?.nonTransientCircuit?.lastSignal;
		expect(retained).toBe(longSignal.slice(0, 1_000));
		expect(retained).toHaveLength(1_000);

		rememberToolExecution(sessionID, 'lifecycle', 'bash', 'echo ok');
		markToolExecutionSandboxWrapped(sessionID, 'lifecycle');
		expect(
			getAgentSession(sessionID)?.pendingToolExecutions?.get('lifecycle')
				?.sandboxWrapped,
		).toBe(true);
		forgetToolExecution(sessionID, 'lifecycle');
		expect(
			getAgentSession(sessionID)?.pendingToolExecutions?.has('lifecycle'),
		).toBe(false);
	});
});

import { beforeEach, describe, expect, it } from 'bun:test';
import {
	_test_exports,
	assertNonTransientCircuitAllowsTool,
	forgetToolExecution,
	markToolExecutionSandboxWrapped,
	nonTransientHardStopMessage,
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

function setupSession(sessionID: string): void {
	startAgentSession(sessionID, 'coder');
	swarmState.activeAgent.set(sessionID, 'coder');
	beginInvocation(sessionID, 'coder');
}

describe('guardrails non-transient boundaries — issue #1875 review', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('keeps an exact-action hard stop without blocking other actions', () => {
		const sessionID = 'hard-stop-immutable';
		setupSession(sessionID);
		const fatalAction = {
			tool: 'bash',
			args: { command: 'broken' },
		};
		assertNonTransientCircuitAllowsTool(sessionID, fatalAction);
		recordNonTransientFailure(
			sessionID,
			'shell_parse_error',
			'ParserError: MissingEndCurlyBrace',
			fatalAction,
		);
		const stopped = getAgentSession(sessionID)?.nonTransientCircuit;
		expect(stopped).toMatchObject({
			category: 'shell_parse_error',
			sameCategoryCount: 1,
			hardStop: true,
		});
		const stoppedSignal = stopped?.lastSignal;

		expect(() =>
			assertNonTransientCircuitAllowsTool(sessionID, {
				tool: 'bash',
				args: { command: 'broken' },
			}),
		).toThrow('NON-TRANSIENT CIRCUIT BREAKER');
		expect(() =>
			assertNonTransientCircuitAllowsTool(sessionID, {
				tool: 'read',
				args: { filePath: 'package.json' },
			}),
		).not.toThrow();
		expect(getAgentSession(sessionID)?.nonTransientCircuit?.lastSignal).toBe(
			stoppedSignal,
		);
	});

	it('a fatal category stops its exact action without poisoning a different action', () => {
		const sessionID = 'category-alternation';
		setupSession(sessionID);
		const generalAction = {
			tool: 'bash',
			args: { command: 'denied' },
		};
		assertNonTransientCircuitAllowsTool(sessionID, generalAction);
		recordNonTransientFailure(
			sessionID,
			'general_permanent',
			'permission denied',
			generalAction,
		);
		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			category: 'general_permanent',
			sameCategoryCount: 1,
			hardStop: false,
		});

		const parserAction = {
			tool: 'bash',
			args: { command: 'broken' },
		};
		assertNonTransientCircuitAllowsTool(sessionID, parserAction);
		recordNonTransientFailure(
			sessionID,
			'shell_parse_error',
			'ParseError: unexpected token',
			parserAction,
		);
		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			category: 'shell_parse_error',
			sameCategoryCount: 1,
			hardStop: true,
		});
		expect(() =>
			assertNonTransientCircuitAllowsTool(sessionID, {
				tool: 'bash',
				args: { command: 'broken' },
			}),
		).toThrow('NON-TRANSIENT CIRCUIT BREAKER');
		expect(() =>
			assertNonTransientCircuitAllowsTool(sessionID, {
				tool: 'bash',
				args: { command: 'echo repaired' },
			}),
		).not.toThrow();
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
		).toBeNull();
		expect(
			_test_exports.classifyFatalSignal(
				'missing-tool: command not found',
				false,
			),
		).toBeNull();
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

	it('privacy-bounds retained signals and exposes remember-mark-forget lifecycle', () => {
		const sessionID = 'state-boundaries';
		setupSession(sessionID);
		const longSignal = `prefix-${'x'.repeat(1_100)}`;

		assertNonTransientCircuitAllowsTool(sessionID, {
			tool: 'bash',
			args: { command: 'failed' },
		});
		recordNonTransientFailure(sessionID, 'general_permanent', longSignal, {
			tool: 'bash',
			args: { command: 'failed' },
		});
		const retained =
			getAgentSession(sessionID)?.nonTransientCircuit?.lastSignal;
		expect(retained).toBe(longSignal.slice(0, 512));
		expect(retained).toHaveLength(512);

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

// Issue #1896 (sub-issue 4): the hard-stop message must surface the stored
// signal + category-specific remediation so the operator can tell a dead sandbox
// (infra) from a sub-agent refusing to act, instead of a bare category string.
describe('nonTransientHardStopMessage — diagnostic surfacing (#1896)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('surfaces the wrapper signal + sandbox remediation for sandbox_wrapper_failure', () => {
		const sessionID = 'msg-sandbox';
		setupSession(sessionID);
		const signal =
			'[sandbox] BLOCKED: Failed to wrap command with bubblewrap: probe failed. Command will not be executed unsandboxed.';
		assertNonTransientCircuitAllowsTool(sessionID, {
			tool: 'bash',
			args: { command: 'sandboxed command' },
		});
		const circuit = recordNonTransientFailure(
			sessionID,
			'sandbox_wrapper_failure',
			signal,
			{ tool: 'bash', args: { command: 'sandboxed command' } },
		);
		expect(circuit).not.toBeNull();
		const msg = nonTransientHardStopMessage(circuit!);
		expect(msg).toContain('NON-TRANSIENT CIRCUIT BREAKER');
		// The actual wrapper error + mechanism are now visible (was dropped before).
		expect(msg).toContain('Last signal:');
		expect(msg).toContain('bubblewrap');
		// Distinguishes sandbox-dead (infra) from an agent refusing.
		expect(msg).toContain('SANDBOX PROVISIONING');
		expect(msg).toContain('/swarm diagnose');
		// Explains why a plain session reset / cache clear did not help.
		expect(msg).toMatch(/in-memory|fresh agent invocation/i);
	});

	it('gives command-not-found remediation with the signal', () => {
		const sessionID = 'msg-cnf';
		setupSession(sessionID);
		assertNonTransientCircuitAllowsTool(sessionID, {
			tool: 'bash',
			args: { command: 'frobnicate' },
		});
		const circuit = recordNonTransientFailure(
			sessionID,
			'command_not_found',
			'bash: line 1: frobnicate: not found',
			{ tool: 'bash', args: { command: 'frobnicate' } },
		);
		const msg = nonTransientHardStopMessage(circuit!);
		expect(msg).toContain('Last signal:');
		expect(msg).toContain('frobnicate');
		expect(msg).toContain('PATH');
	});

	it('falls back to "(no signal captured)" when lastSignal is absent', () => {
		const msg = nonTransientHardStopMessage({
			ownerAgent: 'coder',
			ownerInvocationId: 1,
			category: 'general_permanent',
			sameCategoryCount: 3,
			hardStop: true,
			lastSignal: null,
		});
		expect(msg).toContain('NON-TRANSIENT CIRCUIT BREAKER');
		expect(msg).toContain('(no signal captured)');
	});
});

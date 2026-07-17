import { beforeEach, describe, expect, it } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { rememberToolExecution } from '../../../src/hooks/guardrails/nontransient-circuit';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import {
	beginInvocation,
	ensureAgentSession,
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

function setupSession(sessionID: string, agent = 'coder'): void {
	startAgentSession(sessionID, agent);
	swarmState.activeAgent.set(sessionID, agent);
	beginInvocation(sessionID, agent);
}

function shellResult(output: string, exit: number) {
	return { title: 'shell', output, metadata: { exit } };
}

describe('guardrails non-transient lifecycle — issue #1875 follow-up', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('queues no stale STOP before threshold and queues exactly one at 3/3', async () => {
		const sessionID = 'advisory-threshold';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(process.cwd(), config);
		const input = (callID: string) => ({
			tool: 'bash',
			sessionID,
			callID,
			args: { command: `failing-${callID}` },
		});

		await hooks.toolAfter(input('first'), shellResult('permission denied', 2));
		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			sameCategoryCount: 1,
			hardStop: false,
		});
		expect(getAgentSession(sessionID)?.pendingAdvisoryMessages ?? []).toEqual(
			[],
		);

		await hooks.toolAfter(input('success'), shellResult('ok', 0));
		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			sameCategoryCount: 0,
			hardStop: false,
		});
		expect(getAgentSession(sessionID)?.pendingAdvisoryMessages ?? []).toEqual(
			[],
		);

		for (let attempt = 1; attempt <= 4; attempt++) {
			await hooks.toolAfter(
				input(`threshold-${attempt}`),
				shellResult('permission denied', 2),
			);
		}
		const advisories =
			getAgentSession(sessionID)?.pendingAdvisoryMessages ?? [];
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('general_permanent, 3/3');
	});

	it('ignores a late result after a same-agent invocation reset', async () => {
		const sessionID = 'late-after-reset';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(process.cwd(), config);
		rememberToolExecution(sessionID, 'old-call', 'bash', 'broken');

		beginInvocation(sessionID, 'coder');
		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'old-call',
				args: { command: 'broken' },
			},
			shellResult('ParserError: MissingEndCurlyBrace', 1),
		);

		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			ownerAgent: 'coder',
			ownerInvocationId: 2,
			sameCategoryCount: 0,
			hardStop: false,
		});
		expect(getAgentSession(sessionID)?.pendingAdvisoryMessages ?? []).toEqual(
			[],
		);
	});

	it('ignores a late result after an agent handoff with colliding invocation IDs', async () => {
		const sessionID = 'late-after-handoff';
		setupSession(sessionID);
		const hooks = createGuardrailsHooks(process.cwd(), config);
		rememberToolExecution(sessionID, 'coder-call', 'bash', 'broken');

		ensureAgentSession(sessionID, 'reviewer');
		swarmState.activeAgent.set(sessionID, 'reviewer');
		beginInvocation(sessionID, 'reviewer');
		await hooks.toolAfter(
			{
				tool: 'bash',
				sessionID,
				callID: 'coder-call',
				args: { command: 'broken' },
			},
			shellResult('ParserError: MissingEndCurlyBrace', 1),
		);

		expect(getAgentSession(sessionID)?.nonTransientCircuit).toMatchObject({
			ownerAgent: 'reviewer',
			ownerInvocationId: 1,
			sameCategoryCount: 0,
			hardStop: false,
		});
		expect(getAgentSession(sessionID)?.pendingToolExecutions?.size).toBe(0);
		expect(getAgentSession(sessionID)?.pendingAdvisoryMessages ?? []).toEqual(
			[],
		);
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
		rememberToolExecution(sessionID, 'call-1', 'bash', 'broken');
		const serialized = serializeAgentSession(session) as unknown as Record<
			string,
			unknown
		>;
		expect(Object.hasOwn(serialized, 'nonTransientCircuit')).toBe(false);
		expect(Object.hasOwn(serialized, 'pendingToolExecutions')).toBe(false);
	});
});

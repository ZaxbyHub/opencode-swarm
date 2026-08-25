import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { handleGuardrailReset } from '../../../src/commands/guardrail-reset.js';
import {
	armActionCircuitAttempt,
	clearAllActionCircuits,
	getBlockingActionCircuit,
	noteActionCircuitFailure,
} from '../../../src/failures/action-circuit.js';
import { ensureAgentSession, resetSwarmState } from '../../../src/state.js';

const sessionID = 'reset-session';
const invocationID = 7;
const digest = 'a'.repeat(64);

describe('guardrail reset command', () => {
	beforeEach(() => {
		resetSwarmState();
		clearAllActionCircuits();
		ensureAgentSession(sessionID).activeInvocationId = invocationID;
		const generationToken = armActionCircuitAttempt(
			sessionID,
			invocationID,
			digest,
		);
		noteActionCircuitFailure({
			sessionID,
			invocationID,
			actionDigest: digest,
			circuitKind: 'policy.gate_denial',
			signal: 'bounded',
			hardStopThreshold: 1,
			generationToken,
		});
	});

	afterEach(() => {
		clearAllActionCircuits();
		resetSwarmState();
	});

	test('clears only an exact active action and does not replay it', () => {
		const result = handleGuardrailReset(
			[digest, '--invocation', String(invocationID)],
			sessionID,
		);
		expect(result).toContain('original action was not replayed');
		expect(
			getBlockingActionCircuit(sessionID, invocationID, digest),
		).toBeNull();
	});

	test('fails closed for a foreign invocation or malformed digest', () => {
		expect(
			handleGuardrailReset([digest, '--invocation', '8'], sessionID),
		).toStartWith('Error:');
		expect(
			handleGuardrailReset(['raw-task', '--invocation', '7'], sessionID),
		).toStartWith('Error:');
		expect(
			getBlockingActionCircuit(sessionID, invocationID, digest),
		).not.toBeNull();
	});
});

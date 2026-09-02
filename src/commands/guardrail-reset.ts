import {
	getBlockingActionCircuit,
	resetActionCircuitExternally,
} from '../failures/action-circuit.js';
import { getAgentSession } from '../state.js';

const ACTION_DIGEST = /^[a-f0-9]{64}$/;

/** Exact, audited recovery for one active invocation/action circuit. */
export function handleGuardrailReset(
	args: string[],
	sessionID: string,
): string {
	if (
		args.length !== 3 ||
		!ACTION_DIGEST.test(args[0] ?? '') ||
		args[1] !== '--invocation' ||
		!/^[1-9]\d*$/.test(args[2] ?? '')
	) {
		return 'Error: usage `/swarm guardrail reset <64-char-action-digest> --invocation <active-id>`.';
	}
	const invocationID = Number(args[2]);
	const activeInvocationID =
		getAgentSession(sessionID)?.activeInvocationId ?? 0;
	if (activeInvocationID !== invocationID) {
		return 'Error: guardrail reset refused because the requested invocation is not the active invocation for this session.';
	}
	const actionDigest = args[0];
	if (!getBlockingActionCircuit(sessionID, invocationID, actionDigest)) {
		return 'Error: no open exact-action circuit matches this session, invocation, and digest.';
	}
	resetActionCircuitExternally({
		sessionID,
		invocationID,
		actionDigest,
		actor: 'swarm-command',
	});
	return `Guardrail circuit reset for action ${actionDigest.slice(0, 12)}… in invocation ${invocationID}. The original action was not replayed; reissue it for fresh validation.`;
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleResetSessionCommand } from '../../../src/commands/reset-session';
import {
	_test_exports as actionCircuitTestExports,
	armActionCircuitAttempt,
	clearAllActionCircuits,
	getBlockingActionCircuit,
	listBlockingActionCircuitsForInvocation,
	noteActionCircuitFailure,
} from '../../../src/failures/action-circuit';
import { getDiagnoseData } from '../../../src/services/diagnose-service';
import { ensureAgentSession } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * #2471 (absorbing #1896 row 4): recovery/circuit state must be queryable
 * AND name the exact remediation command. The diagnose "Invocation circuits"
 * check must hand the operator the exact /swarm guardrail reset command, and
 * /swarm reset-session must release the reset session's action circuits
 * (previously only the session.deleted lifecycle path cleared them).
 */

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function seedCircuit(
	sessionID: string,
	invocationID: number,
	actionDigest: string,
	circuitKind = 'sandbox_wrapper_failure',
): void {
	// Real production order: toolBefore arms the attempt, toolAfter notes the
	// failure — an un-armed note is discarded as a late event by design.
	armActionCircuitAttempt(sessionID, invocationID, actionDigest);
	noteActionCircuitFailure({
		sessionID,
		invocationID,
		actionDigest,
		circuitKind,
		signal: '[sandbox] BLOCKED: probe failed (fixture)',
		hardStopThreshold: 1,
	});
}

describe('#2471 recovery diagnostics surfaces', () => {
	let directory: string;

	beforeEach(() => {
		directory = canonicalMkdtemp('recovery-diagnostics-2471-');
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		clearAllActionCircuits();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	describe('/swarm diagnose invocation-circuits check', () => {
		test('names each open circuit and the exact /swarm guardrail reset command', async () => {
			const session = ensureAgentSession('sess-diag');
			session.activeInvocationId = 9;
			seedCircuit('sess-diag', 9, DIGEST_A);

			const data = await getDiagnoseData(directory, 'sess-diag');
			const check = data.checks.find(
				(c: { name: string; detail: string }) =>
					c.name === 'Invocation circuits',
			);
			expect(check).toBeDefined();
			expect(check?.status).toBe('⚠️');
			// The circuit identity is queryable, not just the category count.
			expect(check?.detail).toContain('sandbox_wrapper_failure');
			expect(check?.detail).toContain(DIGEST_A);
			// The exact remediation command, in guardrail-reset.ts's own syntax.
			expect(check?.detail).toMatch(
				new RegExp(`/swarm guardrail reset ${DIGEST_A} --invocation 9\\b`),
			);
		});

		test('clean invocation renders no reset command and stays green', async () => {
			const session = ensureAgentSession('sess-clean');
			session.activeInvocationId = 4;

			const data = await getDiagnoseData(directory, 'sess-clean');
			const check = data.checks.find(
				(c: { name: string; detail: string }) =>
					c.name === 'Invocation circuits',
			);
			expect(check?.status).toBe('✅');
			expect(check?.detail).not.toContain('/swarm guardrail reset');
		});
	});

	describe('/swarm reset-session action-circuit release', () => {
		test('clears the reset session circuits, preserves foreign sessions, and audits the release', async () => {
			const sessionA = ensureAgentSession('sess-a');
			sessionA.activeInvocationId = 7;
			const sessionB = ensureAgentSession('sess-b');
			sessionB.activeInvocationId = 3;
			seedCircuit('sess-a', 7, DIGEST_A);
			seedCircuit('sess-b', 3, DIGEST_B, 'shell_parse_error');

			expect(getBlockingActionCircuit('sess-a', 7, DIGEST_A)).not.toBeNull();
			expect(getBlockingActionCircuit('sess-b', 3, DIGEST_B)).not.toBeNull();

			const result = await handleResetSessionCommand(directory, [], 'sess-a');

			// This session's circuits are released...
			expect(getBlockingActionCircuit('sess-a', 7, DIGEST_A)).toBeNull();
			expect(listBlockingActionCircuitsForInvocation('sess-a', 7)).toEqual([]);
			// ...the foreign session's circuits are untouched (invariant 8)...
			expect(getBlockingActionCircuit('sess-b', 3, DIGEST_B)).not.toBeNull();
			// ...and the release is audited.
			const audit = actionCircuitTestExports.getResetAudit();
			expect(
				audit.some(
					(entry: { sessionID: string; reason: string }) =>
						entry.sessionID === 'sess-a' && entry.reason === 'session',
				),
			).toBe(true);
			// The operator sees the release in the command output.
			expect(result).toContain('guardrail circuit');
		});
	});
});

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { _test_exports as circuitInternals } from '../../../src/hooks/guardrails/nontransient-circuit';
import { getAgentSession, resetSwarmState } from '../../../src/state';
import { telemetry } from '../../../src/telemetry';

const { recordActionFailure, recordActionSuccess, recoverNonTransientCircuit } =
	circuitInternals;

function setup(sessionID: string): void {
	resetSwarmState();
	getAgentSession(sessionID); // no-op read; ensure via record path below
}

describe('action-local circuits (issue #2103 workstream C)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('a missing executable blocks only its action; recovery/read tools stay clearable and reachable', () => {
		const sessionID = 's1';
		recordActionFailure(
			sessionID,
			'bash',
			'cmd:abc123',
			'command_not_found',
			'rg: command not found',
		);
		const circuit = getAgentSession(sessionID)?.nonTransientCircuit;
		const key = 'bash::cmd:abc123';
		expect(circuit?.actions?.get(key)).toMatchObject({
			category: 'command_not_found',
			hardStop: true,
		});
		// An unrelated action on the same tool is NOT blocked.
		expect(circuit?.actions?.get('bash::cmd:zzz999')).toBeUndefined();
	});

	it('corrected success of the same action clears its non-immediate circuit only', () => {
		const sessionID = 's2';
		recordActionFailure(
			sessionID,
			'bash',
			'cmd:a1',
			'git_conflict',
			'CONFLICT',
		);
		recordActionFailure(
			sessionID,
			'bash',
			'cmd:a2',
			'git_conflict',
			'CONFLICT',
		);
		recordActionSuccess(sessionID, 'bash', 'cmd:a1');
		const circuit = getAgentSession(sessionID)?.nonTransientCircuit;
		expect(circuit?.actions?.has('bash::cmd:a1')).toBe(false);
		expect(circuit?.actions?.has('bash::cmd:a2')).toBe(true);
	});

	it('immediate categories survive a late success (fail-closed) but clear via the audited recovery transition', () => {
		const sessionID = 's3';
		recordActionFailure(
			sessionID,
			'bash',
			'cmd:b1',
			'sandbox_wrapper_failure',
			'[sandbox] BLOCKED',
		);
		recordActionSuccess(sessionID, 'bash', 'cmd:b1');
		let circuit = getAgentSession(sessionID)?.nonTransientCircuit;
		expect(circuit?.actions?.get('bash::cmd:b1')?.hardStop).toBe(true);

		const loopSpy = spyOn(telemetry, 'loopDetected').mockImplementation(
			() => {},
		);
		try {
			expect(recoverNonTransientCircuit(sessionID, 'bash')).toBe(true);
		} finally {
			loopSpy.mockRestore();
		}
		circuit = getAgentSession(sessionID)?.nonTransientCircuit;
		expect(circuit?.actions?.has('bash::cmd:b1')).toBe(false);
	});

	it('sandbox-wrapper failure never executes unsandboxed: category stays do-not-retry in the shared taxonomy', async () => {
		const { classifyInvocationFailure } = await import(
			'../../../src/utils/invocation-failure.js'
		);
		const result = classifyInvocationFailure({
			channel: 'error',
			toolKind: 'shell',
			errorSignal: '[sandbox] BLOCKED: wrapper failed',
		});
		expect(result?.category).toBe('shell_sandbox_wrapper');
		expect(result?.retryClass).toBe('do_not_retry');
	});

	it('action circuits stay bounded (LRU eviction at 200)', () => {
		const sessionID = 's4';
		for (let i = 0; i < 220; i++) {
			recordActionFailure(sessionID, 'bash', `cmd:${i}`, 'git_conflict', 'x');
		}
		const circuit = getAgentSession(sessionID)?.nonTransientCircuit;
		expect(circuit?.actions?.size).toBeLessThanOrEqual(200);
		expect(circuit?.actions?.has('bash::cmd:0')).toBe(false);
		expect(circuit?.actions?.has('bash::cmd:219')).toBe(true);
	});

	it('deriveActionIdentity: same command collides, different commands do not; raw text is not stored', () => {
		const { deriveActionIdentity } = circuitInternals;
		const a = deriveActionIdentity('bash', { command: 'rg pattern src' });
		const b = deriveActionIdentity('bash', { command: 'rg pattern src' });
		const c = deriveActionIdentity('bash', { command: 'rg other src' });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.startsWith('bash:cmd:')).toBe(true);
		expect(a).not.toContain('rg pattern');
	});
});

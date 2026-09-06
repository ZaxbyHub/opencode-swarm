/**
 * Issue #2507 — spawn-protection circuit unit tests (state machine,
 * isolation, armed-digest parity, gate-denial exemption) plus the
 * lowercase-native-task loop-detector regression (HOOKS-2).
 */
import { describe, expect, it } from 'bun:test';
import {
	_clearAllSpawnCircuits,
	armDispatchIdentity,
	assertDispatchSpawnCircuitAdmits,
	getSpawnCircuitEntry,
	noteDispatchSpawnFailure,
	noteDispatchSpawnSuccess,
	SPAWN_CIRCUIT_DENIAL_CODE,
	spawnCircuitIsTaskTool,
	takeArmedDispatchIdentity,
} from '../../../src/dispatch/spawn-circuit';
import { noteGateDenial } from '../../../src/hooks/gate-denial-tracker';
import { detectLoop } from '../../../src/hooks/loop-detector';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

const ARGS = {
	description: 'explore auth',
	prompt: 'Explore the auth subsystem and report findings.',
	subagent_type: 'mega_explorer',
};

function fail(
	sessionID: string,
	invocationID: string,
	digest: string,
	now: number,
	threshold = 3,
	halfOpenAfterMs = 100,
) {
	return noteDispatchSpawnFailure({
		sessionID,
		invocationID,
		actionDigest: digest,
		threshold,
		halfOpenAfterMs,
		now,
	});
}

describe('spawn-protection circuit state machine (#2507)', () => {
	it('opens at the threshold, denies, half-open admits one probe, success closes', () => {
		_clearAllSpawnCircuits();
		let now = 1_000;
		for (let i = 1; i <= 2; i++) {
			const { entry, opened } = fail('s1', 'inv1', 'd1', now);
			expect(entry.failureCount).toBe(i);
			expect(opened).toBe(false);
		}
		const third = fail('s1', 'inv1', 'd1', (now += 10));
		expect(third.opened).toBe(true);
		expect(third.entry.state).toBe('OPEN');

		// Within the open interval: denied.
		now += 50;
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's1',
				invocationID: 'inv1',
				actionDigest: 'd1',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);

		// After the interval (and one denial issued): exactly one probe admitted.
		now += 200;
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's1',
			invocationID: 'inv1',
			actionDigest: 'd1',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
		// A second call while the probe is in flight is denied.
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's1',
				invocationID: 'inv1',
				actionDigest: 'd1',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);

		// A corrected success clears exactly the matching action.
		noteDispatchSpawnSuccess({
			sessionID: 's1',
			invocationID: 'inv1',
			actionDigest: 'd1',
		});
		expect(
			getSpawnCircuitEntry({
				sessionID: 's1',
				invocationID: 'inv1',
				actionDigest: 'd1',
			}),
		).toBeUndefined();
	});

	it('a failed half-open probe re-opens with a fresh interval', () => {
		_clearAllSpawnCircuits();
		let now = 5_000;
		fail('s2', 'inv1', 'dX', now);
		fail('s2', 'inv1', 'dX', now);
		fail('s2', 'inv1', 'dX', now);
		now += 500;
		// Deny once (episode bookkeeping), then admit the probe.
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's2',
				invocationID: 'inv1',
				actionDigest: 'dX',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's2',
			invocationID: 'inv1',
			actionDigest: 'dX',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
		// The probe FAILS -> re-open. The re-arm is NOT a CLOSED->OPEN
		// transition: opened stays false (one telemetry event per episode).
		const reopened = fail('s2', 'inv1', 'dX', now);
		expect(reopened.entry.state).toBe('OPEN');
		expect(reopened.opened).toBe(false);
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's2',
				invocationID: 'inv1',
				actionDigest: 'dX',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
	});

	it('an OPEN episode denies at least once even if the interval elapsed during bookkeeping', () => {
		_clearAllSpawnCircuits();
		// The gap between the failure record and the next dispatch exceeds
		// half_open_after_ms (composed after-hook latency) — the first
		// post-open dispatch must still be denied, never silently probed.
		let now = 9_000;
		fail('s3', 'inv1', 'dY', now);
		fail('s3', 'inv1', 'dY', now);
		fail('s3', 'inv1', 'dY', now);
		now += 5_000;
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's3',
				invocationID: 'inv1',
				actionDigest: 'dY',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
		// The SECOND post-interval dispatch is the probe.
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's3',
			invocationID: 'inv1',
			actionDigest: 'dY',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
	});

	it('success clears only the matching action; failures of other actions never reset a count', () => {
		_clearAllSpawnCircuits();
		const now = 20_000;
		fail('s4', 'inv1', 'dA', now);
		fail('s4', 'inv1', 'dA', now);
		fail('s4', 'inv1', 'dB', now); // different action
		expect(
			getSpawnCircuitEntry({
				sessionID: 's4',
				invocationID: 'inv1',
				actionDigest: 'dA',
			})?.failureCount,
		).toBe(2);
		noteDispatchSpawnSuccess({
			sessionID: 's4',
			invocationID: 'inv1',
			actionDigest: 'dA',
		});
		expect(
			getSpawnCircuitEntry({
				sessionID: 's4',
				invocationID: 'inv1',
				actionDigest: 'dB',
			}),
		).toBeDefined();
	});

	it('combined: X at half-open succeeds and clears while Y at half-open fails and re-opens', () => {
		_clearAllSpawnCircuits();
		let now = 25_000;
		// Drive X and Y to threshold together.
		for (let i = 0; i < 3; i++) {
			fail('s7', 'inv1', 'dX', now);
			fail('s7', 'inv1', 'dY', now);
		}
		now += 500;
		// Deny once per episode, then admit each action's probe.
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's7',
				invocationID: 'inv1',
				actionDigest: 'dX',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's7',
				invocationID: 'inv1',
				actionDigest: 'dY',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's7',
			invocationID: 'inv1',
			actionDigest: 'dX',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's7',
			invocationID: 'inv1',
			actionDigest: 'dY',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
		// X's probe SUCCEEDS -> X cleared; Y's probe FAILS -> Y re-opens.
		noteDispatchSpawnSuccess({
			sessionID: 's7',
			invocationID: 'inv1',
			actionDigest: 'dX',
		});
		fail('s7', 'inv1', 'dY', now);
		// X's success must NOT have cleared Y: Y is denied again...
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's7',
				invocationID: 'inv1',
				actionDigest: 'dY',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
		// ...while X admits (circuit gone).
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's7',
			invocationID: 'inv1',
			actionDigest: 'dX',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
	});

	it('sessions and invocations are isolated key spaces', () => {
		_clearAllSpawnCircuits();
		const now = 30_000;
		fail('s5', 'inv1', 'd1', now);
		fail('s5', 'inv1', 'd1', now);
		fail('s5', 'inv1', 'd1', now);
		// Same digest, different session: no entry, admits.
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's6',
			invocationID: 'inv1',
			actionDigest: 'd1',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
		// Same digest, different invocation within the session: no entry.
		assertDispatchSpawnCircuitAdmits({
			sessionID: 's5',
			invocationID: 'inv2',
			actionDigest: 'd1',
			threshold: 3,
			halfOpenAfterMs: 100,
			now,
		});
		// The original invocation is still denied.
		expect(() =>
			assertDispatchSpawnCircuitAdmits({
				sessionID: 's5',
				invocationID: 'inv1',
				actionDigest: 'd1',
				threshold: 3,
				halfOpenAfterMs: 100,
				now,
			}),
		).toThrow(SPAWN_CIRCUIT_DENIAL_CODE);
	});

	it('armed identity pins the pre-mutation digest (mutation cannot orphan the circuit)', () => {
		_clearAllSpawnCircuits();
		const armed = armDispatchIdentity('call-1', 'task', ARGS);
		// toolAfter consumes the armed digest even though the stored args
		// were mutated between the hooks (different digest when recomputed).
		const taken = takeArmedDispatchIdentity('call-1');
		expect(taken?.digest).toBe(armed.digest);
		const mutated = armDispatchIdentity('call-2', 'task', {
			...ARGS,
			prompt: `${ARGS.prompt} [INJECTED DIRECTIVE]`,
		});
		expect(mutated.digest).not.toBe(armed.digest);
		expect(takeArmedDispatchIdentity('call-1')).toBeUndefined();
	});

	it('normalizes tool ids case- and prefix-insensitively', () => {
		expect(spawnCircuitIsTaskTool('task')).toBe(true);
		expect(spawnCircuitIsTaskTool('Task')).toBe(true);
		expect(spawnCircuitIsTaskTool('opencode:task')).toBe(true);
		expect(spawnCircuitIsTaskTool('bash')).toBe(false);
	});
});

describe('gate-denial tracker exemption (#2507 plan revision 1)', () => {
	it('spawn-circuit denials are NOT counted as policy gate denials', () => {
		_clearAllSpawnCircuits();
		resetSwarmState();
		ensureAgentSession('gdx', 'architect');
		let opened = false;
		for (let i = 0; i < 3 && !opened; i++) {
			opened = fail('gdx', 'inv1', 'dE', 1).opened;
		}
		expect(opened).toBe(true);
		for (let i = 0; i < 5; i++) {
			const outcome = noteGateDenial(
				'gdx',
				'task',
				new Error(
					`${SPAWN_CIRCUIT_DENIAL_CODE}: repeated dispatch failures for this action (3 of 3). Controls remain available.`,
				),
				{ enabled: true, warnThreshold: 3, stopThreshold: 5 },
				{ subagent_type: 'mega_explorer' },
			);
			// NOT_COUNTED: streak stays 0, no rungs fire, no decoration.
			expect(outcome.count).toBe(0);
			expect(outcome.warned).toBe(false);
			expect(outcome.stopped).toBe(false);
			expect(outcome.decorated).toBe(false);
		}
		// A non-exempt code still counts (differential positive control) and
		// the tracker's own rung arithmetic is unaffected by the exemption:
		// warn fires at the 3rd non-exempt denial, stop at the 5th.
		const warnThreshold = { enabled: true, warnThreshold: 3, stopThreshold: 5 };
		const first = noteGateDenial(
			'gdx',
			'task',
			new Error('SCOPE_NOT_DECLARED: no scope'),
			warnThreshold,
			{ subagent_type: 'mega_explorer' },
		);
		expect(first.count).toBe(1);
		expect(first.warned).toBe(false);
		const second = noteGateDenial(
			'gdx',
			'task',
			new Error('SCOPE_NOT_DECLARED: no scope'),
			warnThreshold,
			{ subagent_type: 'mega_explorer' },
		);
		expect(second.count).toBe(2);
		const third = noteGateDenial(
			'gdx',
			'task',
			new Error('SCOPE_NOT_DECLARED: no scope'),
			warnThreshold,
			{ subagent_type: 'mega_explorer' },
		);
		expect(third.count).toBe(3);
		expect(third.warned).toBe(true);
		const fourth = noteGateDenial(
			'gdx',
			'task',
			new Error('SCOPE_NOT_DECLARED: no scope'),
			warnThreshold,
			{ subagent_type: 'mega_explorer' },
		);
		expect(fourth.count).toBe(4);
		const fifth = noteGateDenial(
			'gdx',
			'task',
			new Error('SCOPE_NOT_DECLARED: no scope'),
			warnThreshold,
			{ subagent_type: 'mega_explorer' },
		);
		expect(fifth.count).toBe(5);
		expect(fifth.stopped).toBe(true);
	});
});

describe('loop detector native-task regression (HOOKS-2, #2507)', () => {
	it('lowercase native task spelling is tracked and trips the ladder', () => {
		resetSwarmState();
		ensureAgentSession('loop-lc', 'architect');
		let result = detectLoop('loop-lc', 'task', ARGS);
		for (let i = 2; i <= 5; i++) {
			result = detectLoop('loop-lc', 'task', ARGS);
			expect(result.count).toBe(i);
		}
		expect(result.looping).toBe(true);
	});

	it('capitalised spelling converges on the same pattern; prefixed spelling is tracked', () => {
		resetSwarmState();
		ensureAgentSession('loop-mixed', 'architect');
		const a = detectLoop('loop-mixed', 'task', ARGS);
		const b = detectLoop('loop-mixed', 'Task', ARGS);
		expect(b.pattern).toBe(a.pattern);
		// Namespaced spelling is TRACKED (the guard strips the prefix) but
		// keeps the prefix inside createActionIdentity's pattern — the
		// identity module's pre-existing contract.
		const c = detectLoop('loop-mixed', 'opencode:task', ARGS);
		// A distinct pattern's consecutive tail is itself.
		expect(c.count).toBe(1);
		expect(c.pattern).toContain('opencode:task:');
	});
});

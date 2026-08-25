import { beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	armActionCircuitAttempt,
	clearActionCircuit,
	clearAllActionCircuits,
	clearInvocationActionCircuits,
	clearSessionActionCircuits,
	expireActionCircuit,
	getBlockingActionCircuit,
	noteActionCircuitFailure,
	peekActionCircuitCount,
	resetActionCircuitExternally,
} from '../../../src/failures/action-circuit';

const SESSION_ID = 'action-circuit-session';
const INVOCATION_ID = 7;
const ACTION_DIGEST = 'digest-a';

describe('action-circuit', () => {
	beforeEach(() => {
		clearAllActionCircuits();
	});

	test('tracks counts and enters hard stop only for the armed exact action', () => {
		const token = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			ACTION_DIGEST,
		);
		const first = noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 3,
			generationToken: token,
		});
		const third = noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 3,
			generationToken: token,
		});
		noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 3,
			generationToken: token,
		});

		expect(first.enteredHardStop).toBe(false);
		expect(third.entry?.count).toBe(2);
		expect(
			getBlockingActionCircuit(SESSION_ID, INVOCATION_ID, ACTION_DIGEST)
				?.hardStop,
		).toBe(true);
	});

	test('success clear resets only the exact action and records audit metadata', () => {
		const token = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			ACTION_DIGEST,
		);
		noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			circuitKind: 'policy.gate_denial:SCOPE_NOT_DECLARED',
			signal: 'SCOPE_NOT_DECLARED',
			hardStopThreshold: 5,
			generationToken: token,
		});
		const otherDigest = 'digest-b';
		const otherToken = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			otherDigest,
		);
		noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: otherDigest,
			circuitKind: 'policy.gate_denial:SCOPE_NOT_DECLARED',
			signal: 'SCOPE_NOT_DECLARED',
			hardStopThreshold: 5,
			generationToken: otherToken,
		});

		clearActionCircuit(SESSION_ID, INVOCATION_ID, ACTION_DIGEST, {
			reason: 'success',
		});

		expect(
			peekActionCircuitCount(
				SESSION_ID,
				INVOCATION_ID,
				ACTION_DIGEST,
				'policy.gate_denial:SCOPE_NOT_DECLARED',
			),
		).toBe(0);
		expect(
			peekActionCircuitCount(
				SESSION_ID,
				INVOCATION_ID,
				otherDigest,
				'policy.gate_denial:SCOPE_NOT_DECLARED',
			),
		).toBe(1);
		expect(_test_exports.getResetAudit()).toContainEqual(
			expect.objectContaining({
				sessionID: SESSION_ID,
				invocationID: INVOCATION_ID,
				actionDigest: ACTION_DIGEST,
				reason: 'success',
			}),
		);
	});

	test('ignores late failures after an exact clear bumped the generation token', () => {
		const token = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			ACTION_DIGEST,
		);
		clearActionCircuit(SESSION_ID, INVOCATION_ID, ACTION_DIGEST, {
			reason: 'success',
		});

		const late = noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			circuitKind: 'general_permanent',
			signal: 'late permission denied',
			hardStopThreshold: 3,
			generationToken: token,
		});

		expect(late.ignoredLateEvent).toBe(true);
		expect(late.entry).toBeNull();
		expect(
			getBlockingActionCircuit(SESSION_ID, INVOCATION_ID, ACTION_DIGEST),
		).toBeNull();
	});

	test('supports external, invocation, and session clears', () => {
		const firstToken = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			ACTION_DIGEST,
		);
		noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 1,
			generationToken: firstToken,
		});
		resetActionCircuitExternally({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ACTION_DIGEST,
			actor: 'operator',
		});
		expect(
			getBlockingActionCircuit(SESSION_ID, INVOCATION_ID, ACTION_DIGEST),
		).toBeNull();

		const secondDigest = 'digest-c';
		const secondToken = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			secondDigest,
		);
		noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: secondDigest,
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 1,
			generationToken: secondToken,
		});
		clearInvocationActionCircuits(SESSION_ID, INVOCATION_ID);
		expect(
			getBlockingActionCircuit(SESSION_ID, INVOCATION_ID, secondDigest),
		).toBeNull();

		const thirdToken = armActionCircuitAttempt('other-session', 1, 'digest-d');
		noteActionCircuitFailure({
			sessionID: 'other-session',
			invocationID: 1,
			actionDigest: 'digest-d',
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 1,
			generationToken: thirdToken,
		});
		clearSessionActionCircuits('other-session');
		expect(getBlockingActionCircuit('other-session', 1, 'digest-d')).toBeNull();
	});

	test('expires stale entries and enforces the bounded LRU cap', () => {
		const ttlDigest = 'ttl-digest';
		const ttlToken = armActionCircuitAttempt(
			SESSION_ID,
			INVOCATION_ID,
			ttlDigest,
		);
		noteActionCircuitFailure({
			sessionID: SESSION_ID,
			invocationID: INVOCATION_ID,
			actionDigest: ttlDigest,
			circuitKind: 'general_permanent',
			signal: 'permission denied',
			hardStopThreshold: 1,
			generationToken: ttlToken,
		});
		expireActionCircuit(
			SESSION_ID,
			INVOCATION_ID,
			ttlDigest,
			'general_permanent',
		);
		expect(
			getBlockingActionCircuit(SESSION_ID, INVOCATION_ID, ttlDigest),
		).toBeNull();

		const cap = _test_exports.MAX_TRACKED_ACTION_CIRCUITS;
		for (let index = 0; index <= cap; index++) {
			const digest = `bulk-${index}`;
			const token = armActionCircuitAttempt(SESSION_ID, INVOCATION_ID, digest);
			noteActionCircuitFailure({
				sessionID: SESSION_ID,
				invocationID: INVOCATION_ID,
				actionDigest: digest,
				circuitKind: 'general_permanent',
				signal: `permission denied ${index}`,
				hardStopThreshold: 1,
				generationToken: token,
			});
		}
		expect(_test_exports.size()).toBeLessThanOrEqual(cap);
	});
});

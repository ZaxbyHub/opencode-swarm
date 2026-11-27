/**
 * PR 3919 review follow-up: overlapping same-slot reservations must converge
 * on the LAST VALID binding under any failure order.
 *
 * `reserveStageBRouteEvidence` (src/state.ts) is the single shared sink both
 * Stage-B settlement surfaces call — the background ingestion
 * (src/background/stage-b-gates.ts) and the foreground settlement
 * (src/hooks/delegation-gate.ts) — so this file pins the shared rollback
 * contract for both. Reservations on one slot can overlap because a second
 * completion may reserve while the first dispatch's durable evidence write is
 * still in flight (the append-path comment in state.ts documents the same
 * concurrency for sibling slots).
 *
 * Prior buggy behavior under test: reservations chained valid → A → B, and
 * B's rollback captured A's TOKEN as its restore target. When A failed first
 * its rollback was a no-op (B had already replaced the token), so B's later
 * failure restored A's FAILED binding instead of the last valid one — a
 * poison entry for a dispatch whose durable write never landed.
 *
 * Untested here (documented per the writing-tests skill): the concurrent
 * interleaving driven end-to-end through the delegation-gate hook. Two
 * in-flight durable writes cannot be interleaved deterministically without
 * timing injection; the reserve/rollback seam these tests drive is exactly
 * what both call sites consume, which is the contract under review.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReviewRouteEvidence } from '../../../src/review/routing-enforcement';
import {
	_test_exports,
	ensureAgentSession,
	getStageBRouteEvidence,
	recordStageBRouteEvidence,
	reserveStageBRouteEvidence,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const SESSION = 'sess-route-overlap';
const TASK = '1.1';

/** A settled, dispatch-bound binding for a reviewer slot. */
const binding = (
	identity: string,
	slotIndex: number,
	callId: string,
	generation = 1,
): ReviewRouteEvidence => ({
	role: 'reviewer',
	identity,
	sessionId: SESSION,
	taskId: TASK,
	slotId: `${TASK}:reviewer:${slotIndex}`,
	callId,
	childSessionId: `child-${callId}`,
	generation,
});

/** Live entry for an identity, or undefined when the slot is released. */
const slot = (identity: string): ReviewRouteEvidence | undefined =>
	getStageBRouteEvidence(swarmState.agentSessions.get(SESSION)!, TASK).find(
		(entry) => entry.identity === identity,
	);

describe('Stage-B route reservation overlap (PR 3919 review follow-up)', () => {
	beforeEach(() => {
		resetSwarmState();
		ensureAgentSession(SESSION);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('a publishing reservation cannot be superseded until publication ends', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		recordStageBRouteEvidence(session, TASK, valid);
		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackA?.beginPublication()).toBe(true);
		expect(
			reserveStageBRouteEvidence(
				session,
				TASK,
				binding('reviewer-a', 1, 'call-b', 3),
			),
		).toBeNull();
		expect(rollbackA?.isCurrent()).toBe(true);
		rollbackA?.endPublication();
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		expect(rollbackB).not.toBeNull();
		rollbackB?.settle();
		rollbackA?.settle();
	});

	test("A replaces valid, B replaces A, A fails then B fails: the last VALID binding is restored, never A's failed token", () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		const sibling = binding('reviewer-b', 2, 'call-sibling');
		recordStageBRouteEvidence(session, TASK, valid);
		recordStageBRouteEvidence(session, TASK, sibling);

		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackB).not.toBeNull();

		// A fails first: its token is gone (B took the slot), so its rollback
		// must not disturb B's still-in-flight reservation.
		rollbackA?.();
		expect(slot('reviewer-a')).toMatchObject({
			callId: 'call-b',
			generation: 3,
		});

		// Then B fails: the slot falls back past A's FAILED token to the last
		// valid binding. (Prior bug: restored A's token — call-a/generation 2.)
		rollbackB?.();
		expect(slot('reviewer-a')).toEqual(valid);
		// Sibling slots are preserved throughout.
		expect(slot('reviewer-b')).toEqual(sibling);
		expect(getStageBRouteEvidence(session, TASK)).toHaveLength(2);
	});

	test('mirrored failure order (B fails then A fails) converges on the same last valid binding', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		recordStageBRouteEvidence(session, TASK, valid);

		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackB).not.toBeNull();

		rollbackB?.();
		// B unwinds onto A — still valid (not failed) at this point.
		expect(slot('reviewer-a')).toMatchObject({ callId: 'call-a' });
		rollbackA?.();
		expect(slot('reviewer-a')).toEqual(valid);
	});

	test('three-deep chain with mixed failure order (A, C, B) still lands on the last valid binding', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		recordStageBRouteEvidence(session, TASK, valid);

		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		const rollbackC = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-c', 4),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackB).not.toBeNull();
		expect(rollbackC).not.toBeNull();

		rollbackA?.(); // token gone: marks the chain link failed only
		expect(slot('reviewer-a')).toMatchObject({ callId: 'call-c' });
		rollbackC?.(); // unwinds onto B (not yet failed)…
		expect(slot('reviewer-a')).toMatchObject({ callId: 'call-b' });
		rollbackB?.(); // …whose failure then skips A and lands on `valid`
		expect(slot('reviewer-a')).toEqual(valid);
	});

	test('a newer SETTLED reservation is never overwritten by a late failed one', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		recordStageBRouteEvidence(session, TASK, valid);

		// B settles (its rollback is discarded without firing)…
		reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 2),
		);
		// …then an earlier failed dispatch's rollback arrives late.
		const lateA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 3),
		);
		expect(lateA).not.toBeNull();
		lateA?.();

		expect(slot('reviewer-a')).toMatchObject({ callId: 'call-b' });
		expect(slot('reviewer-a')).not.toEqual(valid);
	});

	test('an append-rooted chain that fully fails releases the slot so a retry can reclaim it', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		recordStageBRouteEvidence(session, TASK, valid);

		// A first-ever dispatch for a new identity APPENDS its slot…
		const rollbackAppend = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-c', 3, 'call-c1', 1),
		);
		expect(rollbackAppend).not.toBeNull();
		expect(slot('reviewer-c')).toMatchObject({ callId: 'call-c1' });
		// …a re-dispatch of that identity replaces the appended token…
		const rollbackReplace = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-c', 3, 'call-c2', 2),
		);
		expect(rollbackReplace).not.toBeNull();

		// Both fail (append first — its token is gone, so it only marks the
		// chain root failed): the slot never legitimately existed, so it is
		// released rather than left holding a failed dispatch's binding.
		rollbackAppend?.();
		rollbackReplace?.();
		expect(slot('reviewer-c')).toBeUndefined();
		expect(getStageBRouteEvidence(session, TASK)).toEqual([valid]);
	});

	// PR 3919 round-2 review finding: a reservation whose durable evidence
	// write SUCCEEDED (rollback discarded) kept its WeakMap record with the
	// predecessor link forever — settled slots retained the binding history of
	// every re-dispatch. settle() must prune that metadata; the assertions
	// below read it through the _test_exports introspection.
	test('settling prunes the reservation metadata: settled slots retain no predecessor links', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		// The fire-and-forget recorder commits immediately (no pending durable
		// write), so its seeded entries carry no chain metadata at all.
		recordStageBRouteEvidence(session, TASK, valid);
		expect(
			_test_exports.liveStageBRouteReservation(session, TASK, 'reviewer-a'),
		).toBeUndefined();

		// In-flight reservations carry their record; settling removes it.
		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		expect(rollbackA).not.toBeNull();
		expect(
			_test_exports.liveStageBRouteReservation(session, TASK, 'reviewer-a'),
		).toEqual({ kind: 'replace', failed: false });
		rollbackA?.settle();
		expect(
			_test_exports.liveStageBRouteReservation(session, TASK, 'reviewer-a'),
		).toBeUndefined();
		expect(slot('reviewer-a')).toEqual(binding('reviewer-a', 1, 'call-a', 2));
	});

	test('a later predecessor failure cannot overwrite a settled reservation', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		recordStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-valid'),
		);

		// A's durable write is still in flight when B takes the slot over and
		// B's write succeeds first: B settles, A fails afterwards.
		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackB).not.toBeNull();
		rollbackB?.settle();
		rollbackA?.();

		// The settled binding stays; A's failed token never resurfaces, and the
		// settled slot's record is pruned.
		expect(slot('reviewer-a')).toEqual(binding('reviewer-a', 1, 'call-b', 3));
		expect(
			_test_exports.liveStageBRouteReservation(session, TASK, 'reviewer-a'),
		).toBeUndefined();
	});

	test('the resolve walk stops at a SETTLED predecessor: pruning does not break overlapping rollback', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		recordStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-valid'),
		);

		// Chain valid → A → B → C with B settled in the middle.
		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		const rollbackC = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-c', 4),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackB).not.toBeNull();
		expect(rollbackC).not.toBeNull();
		rollbackB?.settle();

		// C fails: the walk stops at B's record-less settled token — never
		// falls through to A or valid.
		rollbackC?.();
		expect(slot('reviewer-a')).toEqual(binding('reviewer-a', 1, 'call-b', 3));
		// A fails late: its token is gone; the settled state is untouched.
		rollbackA?.();
		expect(slot('reviewer-a')).toEqual(binding('reviewer-a', 1, 'call-b', 3));
	});

	test('settling after a rollback cannot un-fail the chain link for later rollbacks', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		const valid = binding('reviewer-a', 1, 'call-valid');
		recordStageBRouteEvidence(session, TASK, valid);

		const rollbackA = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-a', 2),
		);
		const rollbackB = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-b', 3),
		);
		expect(rollbackA).not.toBeNull();
		expect(rollbackB).not.toBeNull();

		// A fails, then its caller erroneously reports success (settles). The
		// settle must be a no-op: pruning A's FAILED record would let B's
		// rollback restore A's failed token instead of the last valid binding.
		rollbackA?.();
		rollbackA?.settle();
		rollbackB?.();
		expect(slot('reviewer-a')).toEqual(valid);
	});

	test('a settled append is a valid restore stop: a failed re-dispatch restores it instead of releasing the slot', () => {
		const session = swarmState.agentSessions.get(SESSION)!;
		recordStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-a', 1, 'call-valid'),
		);

		// A first-ever dispatch for a new identity APPENDS and settles…
		const settledAppend = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-c', 3, 'call-c1', 1),
		);
		expect(settledAppend).not.toBeNull();
		settledAppend?.settle();
		// …a re-dispatch replaces the settled token and then fails: the slot
		// falls back to the settled binding, NOT to slot-release.
		const rollbackReplace = reserveStageBRouteEvidence(
			session,
			TASK,
			binding('reviewer-c', 3, 'call-c2', 2),
		);
		expect(rollbackReplace).not.toBeNull();
		rollbackReplace?.();
		expect(slot('reviewer-c')).toEqual(binding('reviewer-c', 3, 'call-c1', 1));
	});
});

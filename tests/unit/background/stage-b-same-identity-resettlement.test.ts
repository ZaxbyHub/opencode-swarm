/**
 * Regression (Wirtschaftssimulation 2026-11-25, task 2.20 Gen 8/9 — the
 * post-catch-22 accumulation wedge): after the tests_run required-gate
 * counting fix, a task that legitimately re-settles the SAME gate identity
 * twice in one serve instance (recover_* opening → re-dispatch, no restart
 * and no completion clearing the session in between) APPENDED a second
 * in-memory route-evidence entry for the same (role, identity), and every
 * later Stage-B completion of the task was then terminally consumed with
 * outcome "rejected" (ROUTE_RECEIPT_DUPLICATE) — the gate could never bind,
 * tests_run unreachable (fresh single-dispatch tasks completed normally).
 *
 * The fix: reserveStageBRouteEvidence replaces the existing entry for the
 * same (role, identity) instead of appending — the one-entry-per-identity
 * invariant the route duplicate check requires. On the full consumer line
 * (fork main, which also carries the Stage-B re-dispatch slot reclamation
 * from ed10b5870) the end-to-end sequence is pinned by
 * stage-b-same-identity-resettlement.test.ts; THIS branch (upstream base)
 * does not carry the reclamation, so the second same-identity settlement
 * cannot bind here at all and the accumulation case is unreachable through
 * the pipeline — the replacement invariant is therefore pinned directly at
 * the source.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReviewRouteEvidence } from '../../../src/review/routing-enforcement';
import {
	resetSwarmState,
	reserveStageBRouteEvidence,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function binding(
	taskId: string,
	role: 'reviewer' | 'test_engineer',
	callId: string,
	childSessionId: string,
	generation: number,
): ReviewRouteEvidence {
	return {
		role,
		identity: `${taskId}:${role}:1`,
		sessionId: 'parent-session',
		taskId,
		slotId: `${taskId}:${role}:1`,
		callId,
		childSessionId,
		generation,
	};
}

describe('reserveStageBRouteEvidence same-identity replacement (accumulation wedge)', () => {
	let testDirectory: string;

	beforeEach(() => {
		testDirectory = canonicalMkdtemp('sb-accumulation-invariant-');
		startAgentSession('parent-session', 'architect', testDirectory);
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('a second binding for the same (role, identity) replaces the obsolete entry instead of appending', () => {
		const session = swarmState.agentSessions.get('parent-session');
		if (!session) throw new Error('session missing');

		const first = reserveStageBRouteEvidence(
			session,
			'2.20',
			binding('2.20', 'reviewer', 'call-r1', 'child-r1', 1),
		);
		expect(first).toBeInstanceOf(Function);

		// The recover_* re-dispatch shape: a DIFFERENT dispatch (fresh
		// call/child, rotated generation) of the SAME gate identity, in the
		// SAME serve instance — pre-fix this appended and every later
		// Stage-B completion of the task died on ROUTE_RECEIPT_DUPLICATE.
		const second = reserveStageBRouteEvidence(
			session,
			'2.20',
			binding('2.20', 'reviewer', 'call-r2', 'child-r2', 2),
		);
		expect(second).toBeInstanceOf(Function);

		const entries = session.stageBRouteEvidence?.get('2.20') ?? [];
		expect(entries).toHaveLength(1);
		expect(entries[0]?.callId).toBe('call-r2');
		expect(entries[0]?.childSessionId).toBe('child-r2');
		expect(entries[0]?.generation).toBe(2);

		// Distinct identities stay distinct entries (the multi-slot receipt
		// shape: two reviewer identities must coexist).
		reserveStageBRouteEvidence(
			session,
			'2.20',
			{
				...binding('2.20', 'reviewer', 'call-r3', 'child-r3', 2),
				identity: '2.20:reviewer:2',
				slotId: '2.20:reviewer:2',
			},
		);
		const after = session.stageBRouteEvidence?.get('2.20') ?? [];
		expect(after).toHaveLength(2);

		// The rollback of the superseding reservation restores the exact
		// previous entry (the durable-write failure path must not lose the
		// identity's binding).
		second?.();
		const rolledBack = session.stageBRouteEvidence?.get('2.20') ?? [];
		expect(rolledBack).toHaveLength(2);
		expect(
			rolledBack.find((e) => e.identity === '2.20:reviewer:1')?.callId,
		).toBe('call-r1');
	});
});

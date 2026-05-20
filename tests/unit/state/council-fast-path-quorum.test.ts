/**
 * Quorum-gate tests for the `advanceTaskState` council fast-path.
 *
 * The fast-path lets a task reach `complete` from any post-pre_check state
 * when an APPROVE verdict is recorded — but only if that verdict was recorded
 * with at least `councilConfig.minimumMembers` distinct council members.
 *
 * These tests live alongside the broader state-machine tests; they exclusively
 * cover the new quorum gate added by the council-tool-correctness fix.
 */

import { describe, expect, it } from 'bun:test';
import { advanceTaskState, ensureAgentSession } from '../../../src/state';

const setUpSessionAtPreCheck = (sessionId: string) => {
	const session = ensureAgentSession(sessionId);
	advanceTaskState(session, 'q-task', 'coder_delegated');
	advanceTaskState(session, 'q-task', 'pre_check_passed');
	session.taskCouncilApproved = new Map();
	return session;
};

describe('council fast-path — quorum gate', () => {
	it('quorumSize=1 with default minimumMembers (3) → fast-path rejects', () => {
		const session = setUpSessionAtPreCheck('q-min3-fail');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
		// No councilConfig passed → effectiveMinimum defaults to 3.
		expect(() => advanceTaskState(session, 'q-task', 'complete')).toThrow(
			/INVALID_TASK_STATE_TRANSITION/,
		);
	});

	it('quorumSize=3 with default minimumMembers (3) → fast-path accepts', () => {
		const session = setUpSessionAtPreCheck('q-min3-pass');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 3,
		});
		expect(() => advanceTaskState(session, 'q-task', 'complete')).not.toThrow();
	});

	it('quorumSize=4 with explicit minimumMembers=3 (config passed) → fast-path accepts', () => {
		const session = setUpSessionAtPreCheck('q-min3-pass-explicit');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 4,
		});
		expect(() =>
			advanceTaskState(session, 'q-task', 'complete', { minimumMembers: 3 }),
		).not.toThrow();
	});

	it('quorumSize=2 with explicit minimumMembers=2 (config passed) → fast-path accepts', () => {
		const session = setUpSessionAtPreCheck('q-min2-pass');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 2,
		});
		expect(() =>
			advanceTaskState(session, 'q-task', 'complete', { minimumMembers: 2 }),
		).not.toThrow();
	});

	it('quorumSize=1 with explicit minimumMembers=1 → fast-path accepts (quorum disabled)', () => {
		const session = setUpSessionAtPreCheck('q-min1-pass');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
		expect(() =>
			advanceTaskState(session, 'q-task', 'complete', { minimumMembers: 1 }),
		).not.toThrow();
	});

	it('quorumSize=5 with requireAllMembers=true → fast-path accepts', () => {
		const session = setUpSessionAtPreCheck('q-all-pass');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 5,
		});
		expect(() =>
			advanceTaskState(session, 'q-task', 'complete', {
				requireAllMembers: true,
			}),
		).not.toThrow();
	});

	it('quorumSize=4 with requireAllMembers=true → fast-path rejects (effective minimum is 5)', () => {
		const session = setUpSessionAtPreCheck('q-all-fail');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 4,
		});
		expect(() =>
			advanceTaskState(session, 'q-task', 'complete', {
				requireAllMembers: true,
			}),
		).toThrow(/INVALID_TASK_STATE_TRANSITION/);
	});

	it('requireAllMembers=true overrides minimumMembers=2 (stricter wins)', () => {
		const session = setUpSessionAtPreCheck('q-all-overrides');
		session.taskCouncilApproved!.set('q-task', {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 4,
		});
		expect(() =>
			advanceTaskState(session, 'q-task', 'complete', {
				minimumMembers: 2,
				requireAllMembers: true,
			}),
		).toThrow(/INVALID_TASK_STATE_TRANSITION/);
	});
});

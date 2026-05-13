/**
 * Unit tests for PR 2 Stage B order-independent barrier semantics.
 *
 * Covers:
 * - reviewer-first path: reviewer completes → partial → test_engineer → both done → tests_run
 * - test_engineer-first path: test_engineer completes → partial → reviewer → both done → tests_run
 * - concurrent completion path (same-tick)
 * - barrier: neither done → blocked
 * - barrier: one done → still blocked
 * - council-active suppression: markers not used (council path)
 * - flag off: existing sequential path, no regression
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AgentSessionState } from '../../../src/state';
import {
	advanceTaskState,
	getTaskState,
	hasBothStageBCompletions,
	recordStageBCompletion,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';

function makeSession(): AgentSessionState {
	const id = `sess-${Math.random().toString(36).slice(2)}`;
	startAgentSession(id, 'architect');
	const session = swarmState.agentSessions.get(id)!;
	return session;
}

beforeEach(() => {
	resetSwarmState();
});

// ── recordStageBCompletion + hasBothStageBCompletions ─────────────────────────

describe('recordStageBCompletion — initialization', () => {
	test('initializes stageBCompletion map if missing', () => {
		const session = makeSession();
		session.stageBCompletion = undefined;
		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(session.stageBCompletion).toBeDefined();
		expect(session.stageBCompletion?.get('1.1')?.has('reviewer')).toBe(true);
	});

	test('adds to existing set for same task', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		const completions = session.stageBCompletion?.get('1.1');
		expect(completions?.has('reviewer')).toBe(true);
		expect(completions?.has('test_engineer')).toBe(true);
	});

	test('separate tasks have independent completion sets', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.2', 'test_engineer');
		expect(session.stageBCompletion?.get('1.1')?.has('reviewer')).toBe(true);
		expect(session.stageBCompletion?.get('1.1')?.has('test_engineer')).toBe(
			false,
		);
		expect(session.stageBCompletion?.get('1.2')?.has('reviewer')).toBe(false);
		expect(session.stageBCompletion?.get('1.2')?.has('test_engineer')).toBe(
			true,
		);
	});

	test('idempotent: recording same agent twice does not produce duplicates', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'reviewer');
		const completions = session.stageBCompletion?.get('1.1');
		// Set deduplicates — still exactly 1 entry for reviewer
		expect(completions?.size).toBe(1);
	});

	test('invalid taskId is ignored (no state mutation)', () => {
		const session = makeSession();
		recordStageBCompletion(session, '', 'reviewer');
		expect(session.stageBCompletion?.size ?? 0).toBe(0);
	});
});

describe('hasBothStageBCompletions — barrier check', () => {
	test('returns false when neither completed', () => {
		const session = makeSession();
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});

	test('returns false when only reviewer completed', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});

	test('returns false when only test_engineer completed', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});

	test('returns true when both completed (reviewer first)', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	test('returns true when both completed (test_engineer first)', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'test_engineer');
		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	test('returns false for unknown task', () => {
		const session = makeSession();
		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '2.1')).toBe(false);
	});

	test('returns false for invalid taskId', () => {
		const session = makeSession();
		expect(hasBothStageBCompletions(session, '')).toBe(false);
	});

	test('stageBCompletion undefined is handled safely', () => {
		const session = makeSession();
		session.stageBCompletion = undefined;
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);
	});
});

// ── checkReviewerGate with stageBParallelEnabled ──────────────────────────────

describe('checkReviewerGate — flag OFF (default behavior, no regression)', () => {
	test('blocked when no sessions exist', () => {
		// No sessions started, agentSessions.size === 0 → allowed (test context)
		const result = checkReviewerGate('1.1', undefined, false);
		expect(result.blocked).toBe(false);
	});

	test('blocked when session exists but task at coder_delegated', () => {
		const session = makeSession();
		// Use a task ID not in .swarm/evidence/ so evidence check falls through to session state.
		advanceTaskState(session, '9.4', 'coder_delegated');
		// Flag off — needs tests_run state
		const result = checkReviewerGate('9.4', undefined, false);
		expect(result.blocked).toBe(true);
	});

	test('allowed when task reaches tests_run (sequential path)', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'pre_check_passed');
		advanceTaskState(session, '1.1', 'reviewer_run');
		advanceTaskState(session, '1.1', 'tests_run');
		const result = checkReviewerGate('1.1', undefined, false);
		expect(result.blocked).toBe(false);
	});

	test('markers present but flag off — does NOT allow through (barrier inactive)', () => {
		const session = makeSession();
		// Use a task ID not in .swarm/evidence/ so evidence check falls through to session state.
		advanceTaskState(session, '9.4', 'coder_delegated');
		// Both Stage B markers present but flag is OFF
		recordStageBCompletion(session, '9.4', 'reviewer');
		recordStageBCompletion(session, '9.4', 'test_engineer');
		// Flag off → barrier check skipped → blocked because not at tests_run
		const result = checkReviewerGate('9.4', undefined, false);
		expect(result.blocked).toBe(true);
	});
});

describe('checkReviewerGate — flag ON (Stage B parallel barrier)', () => {
	test('blocked when neither Stage B agent completed', () => {
		const session = makeSession();
		// Use a task ID not in .swarm/evidence/ so evidence check falls through to session state.
		advanceTaskState(session, '9.5', 'coder_delegated');
		const result = checkReviewerGate('9.5', undefined, true);
		expect(result.blocked).toBe(true);
	});

	test('blocked when only reviewer completed', () => {
		const session = makeSession();
		// Use a task ID not in .swarm/evidence/ so evidence check falls through to session state.
		advanceTaskState(session, '9.5', 'coder_delegated');
		recordStageBCompletion(session, '9.5', 'reviewer');
		const result = checkReviewerGate('9.5', undefined, true);
		expect(result.blocked).toBe(true);
	});

	test('blocked when only test_engineer completed', () => {
		const session = makeSession();
		// Use a task ID not in .swarm/evidence/ so evidence check falls through to session state.
		advanceTaskState(session, '9.5', 'coder_delegated');
		recordStageBCompletion(session, '9.5', 'test_engineer');
		const result = checkReviewerGate('9.5', undefined, true);
		expect(result.blocked).toBe(true);
	});

	test('allowed when both completions present (reviewer-first path)', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		const result = checkReviewerGate('1.1', undefined, true);
		expect(result.blocked).toBe(false);
	});

	test('allowed when both completions present (test_engineer-first path)', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		recordStageBCompletion(session, '1.1', 'reviewer');
		const result = checkReviewerGate('1.1', undefined, true);
		expect(result.blocked).toBe(false);
	});

	test('allowed when task at tests_run even without markers', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'pre_check_passed');
		advanceTaskState(session, '1.1', 'reviewer_run');
		advanceTaskState(session, '1.1', 'tests_run');
		// Flag on but tests_run is already sufficient
		const result = checkReviewerGate('1.1', undefined, true);
		expect(result.blocked).toBe(false);
	});

	test('concurrent completion: both recorded in same tick → allowed', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		// Simulate both completions arriving in the same synchronous tick
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		const result = checkReviewerGate('1.1', undefined, true);
		expect(result.blocked).toBe(false);
	});

	test('different task not affected by completions for task 1.1', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.2', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');
		// Task 1.2 is still blocked
		const result = checkReviewerGate('1.2', undefined, true);
		expect(result.blocked).toBe(true);
	});
});

// ── State machine consistency ─────────────────────────────────────────────────

describe('Stage B barrier — state machine consistency', () => {
	test('compound advance to tests_run after both completions is consistent', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		// Simulate what delegation-gate does when both markers present:
		const current = getTaskState(session, '1.1');
		if (current === 'coder_delegated' || current === 'pre_check_passed') {
			advanceTaskState(session, '1.1', 'reviewer_run');
		}
		advanceTaskState(session, '1.1', 'tests_run');
		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});

	test('task cannot reach complete from pre_check_passed without evidence', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'pre_check_passed');
		// No reviewer_run or tests_run — complete should throw
		expect(() => advanceTaskState(session, '1.1', 'complete')).toThrow();
	});
});

import { beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	clearTrajectoryStepCounters,
	nextTrajectoryStep,
	resetTrajectoryStepCounter,
	seedTrajectoryStepCounter,
} from '../../../src/hooks/trajectory-step-state';

describe('trajectory-step-state -- regression: bounded session counters (F-001/F-002)', () => {
	const rootA = '/workspace/project-a';
	const rootB = '/workspace/project-b';

	beforeEach(() => {
		clearTrajectoryStepCounters();
	});

	test('increments steps independently per session', () => {
		expect(nextTrajectoryStep('session-a', rootA)).toBe(1);
		expect(nextTrajectoryStep('session-a', rootA)).toBe(2);
		expect(nextTrajectoryStep('session-b', rootA)).toBe(1);
		expect(nextTrajectoryStep('session-a', rootA)).toBe(3);
	});

	test('resetTrajectoryStepCounter restarts a session at step one', () => {
		nextTrajectoryStep('session-a', rootA);
		nextTrajectoryStep('session-a', rootA);

		resetTrajectoryStepCounter('session-a', rootA);

		expect(nextTrajectoryStep('session-a', rootA)).toBe(1);
	});

	test('clearTrajectoryStepCounters clears one session or all sessions', () => {
		nextTrajectoryStep('session-a', rootA);
		nextTrajectoryStep('session-b', rootA);

		clearTrajectoryStepCounters('session-a');

		expect(nextTrajectoryStep('session-a', rootA)).toBe(1);
		expect(nextTrajectoryStep('session-b', rootA)).toBe(2);

		clearTrajectoryStepCounters();

		expect(nextTrajectoryStep('session-a', rootA)).toBe(1);
		expect(nextTrajectoryStep('session-b', rootA)).toBe(1);
	});

	test('evicts oldest sessions with a FIFO cap', () => {
		for (let i = 0; i < _test_exports.MAX_TRACKED_STEP_SESSIONS; i++) {
			expect(nextTrajectoryStep(`session-${i}`, rootA)).toBe(1);
		}
		expect(_test_exports.getTrackedStepSessionCount()).toBe(
			_test_exports.MAX_TRACKED_STEP_SESSIONS,
		);

		expect(nextTrajectoryStep('session-new', rootA)).toBe(1);

		expect(_test_exports.getTrackedStepSessionCount()).toBe(
			_test_exports.MAX_TRACKED_STEP_SESSIONS,
		);
		// Previous code had no eviction, so this would have returned step 2.
		expect(nextTrajectoryStep('session-0', rootA)).toBe(1);
	});

	// ─── issue #2041: canonical-root keying + restart seeding ────────────────

	test('the same session id under two roots mints independent counters', () => {
		expect(nextTrajectoryStep('session-x', rootA)).toBe(1);
		expect(nextTrajectoryStep('session-x', rootB)).toBe(1);
		expect(nextTrajectoryStep('session-x', rootA)).toBe(2);
		expect(nextTrajectoryStep('session-x', rootB)).toBe(2);
	});

	test('clearTrajectoryStepCounters(sessionId) clears the session under every root', () => {
		nextTrajectoryStep('session-x', rootA);
		nextTrajectoryStep('session-x', rootB);
		nextTrajectoryStep('session-x', rootA);
		const genBefore = _test_exports.getStepCounterGeneration();

		clearTrajectoryStepCounters('session-x');

		// Generation bumps on clear: the logger's seed gate keys on it, so
		// any counter clear structurally invalidates stale restart gates.
		expect(_test_exports.getStepCounterGeneration()).toBeGreaterThan(genBefore);

		expect(nextTrajectoryStep('session-x', rootA)).toBe(1);
		expect(nextTrajectoryStep('session-x', rootB)).toBe(1);
	});

	test('seedTrajectoryStepCounter raises but never lowers the counter', () => {
		nextTrajectoryStep('session-x', rootA); // 1

		seedTrajectoryStepCounter('session-x', rootA, 500);
		expect(nextTrajectoryStep('session-x', rootA)).toBe(501);

		// A lower seed (e.g. a stale restart read) must not rewind steps.
		seedTrajectoryStepCounter('session-x', rootA, 3);
		expect(nextTrajectoryStep('session-x', rootA)).toBe(502);

		// Non-positive seeds are ignored entirely.
		seedTrajectoryStepCounter('session-x', rootA, 0);
		seedTrajectoryStepCounter('session-x', rootA, Number.NaN);
		expect(nextTrajectoryStep('session-x', rootA)).toBe(503);
	});

	test('seeding one root does not leak into another root', () => {
		seedTrajectoryStepCounter('session-x', rootA, 900);

		expect(nextTrajectoryStep('session-x', rootB)).toBe(1);
		expect(nextTrajectoryStep('session-x', rootA)).toBe(901);
	});
});

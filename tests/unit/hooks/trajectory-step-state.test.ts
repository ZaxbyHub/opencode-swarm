import { beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
	clearTrajectoryStepCounters,
	nextTrajectoryStep,
	resetTrajectoryStepCounter,
} from '../../../src/hooks/trajectory-step-state';

describe('trajectory-step-state -- regression: bounded session counters (F-001/F-002)', () => {
	beforeEach(() => {
		clearTrajectoryStepCounters();
	});

	test('increments steps independently per session', () => {
		expect(nextTrajectoryStep('session-a')).toBe(1);
		expect(nextTrajectoryStep('session-a')).toBe(2);
		expect(nextTrajectoryStep('session-b')).toBe(1);
		expect(nextTrajectoryStep('session-a')).toBe(3);
	});

	test('resetTrajectoryStepCounter restarts a session at step one', () => {
		nextTrajectoryStep('session-a');
		nextTrajectoryStep('session-a');

		resetTrajectoryStepCounter('session-a');

		expect(nextTrajectoryStep('session-a')).toBe(1);
	});

	test('clearTrajectoryStepCounters clears one session or all sessions', () => {
		nextTrajectoryStep('session-a');
		nextTrajectoryStep('session-b');

		clearTrajectoryStepCounters('session-a');

		expect(nextTrajectoryStep('session-a')).toBe(1);
		expect(nextTrajectoryStep('session-b')).toBe(2);

		clearTrajectoryStepCounters();

		expect(nextTrajectoryStep('session-a')).toBe(1);
		expect(nextTrajectoryStep('session-b')).toBe(1);
	});

	test('evicts oldest sessions with a FIFO cap', () => {
		for (let i = 0; i < _test_exports.MAX_TRACKED_STEP_SESSIONS; i++) {
			expect(nextTrajectoryStep(`session-${i}`)).toBe(1);
		}
		expect(_test_exports.getTrackedStepSessionCount()).toBe(
			_test_exports.MAX_TRACKED_STEP_SESSIONS,
		);

		expect(nextTrajectoryStep('session-new')).toBe(1);

		expect(_test_exports.getTrackedStepSessionCount()).toBe(
			_test_exports.MAX_TRACKED_STEP_SESSIONS,
		);
		// Previous code had no eviction, so this would have returned step 2.
		expect(nextTrajectoryStep('session-0')).toBe(1);
	});
});

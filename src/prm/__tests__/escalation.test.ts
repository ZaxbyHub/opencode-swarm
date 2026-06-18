import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { createDefaultEscalationState, EscalationTracker } from '../escalation';
import type { CourseCorrection, EscalationState, PatternMatch } from '../types';

// Mock telemetry module - must use correct relative path from __tests__/
vi.mock('../../telemetry', () => ({
	telemetry: {
		prmEscalationTriggered: vi.fn(),
		prmHardStop: vi.fn(),
	},
}));

import { telemetry } from '../../telemetry';

function createMockPatternMatch(
	pattern: PatternMatch['pattern'] = 'repetition_loop',
	overrides: Partial<PatternMatch> = {},
): PatternMatch {
	return {
		pattern,
		severity: 'medium',
		category: 'coordination_error',
		stepRange: [1, 3],
		description: 'Test pattern',
		affectedAgents: ['agent-a'],
		affectedTargets: ['src/foo.ts'],
		occurrenceCount: 1,
		...overrides,
	};
}

describe('createDefaultEscalationState', () => {
	test('returns correct default state', () => {
		const state = createDefaultEscalationState();
		expect(state.patternCounts.size).toBe(0);
		expect(state.escalationLevel).toBe(0);
		expect(state.lastPatternDetected).toBeNull();
		expect(state.hardStopPending).toBe(false);
		expect(state.correctionsPending).toEqual([]);
	});
});

describe('EscalationTracker', () => {
	describe('constructor', () => {
		test('creates tracker with sessionId and empty state', () => {
			const tracker = new EscalationTracker('session-1');
			const state = tracker.getState();
			expect(state.patternCounts.size).toBe(0);
			expect(state.escalationLevel).toBe(0);
			expect(state.lastPatternDetected).toBeNull();
			expect(state.hardStopPending).toBe(false);
			expect(state.correctionsPending).toEqual([]);
		});

		test('creates tracker with initial state', () => {
			const initialState: EscalationState = {
				patternCounts: new Map([['repetition_loop', 2]]),
				escalationLevel: 2,
				lastPatternDetected: createMockPatternMatch('repetition_loop'),
				hardStopPending: false,
				correctionsPending: [
					{
						alert: 'GUIDANCE: Test',
						category: 'coordination_error',
						guidance: 'Test guidance',
						action: 'Test action',
						pattern: 'repetition_loop',
						stepRange: [1, 3],
					},
				],
			};
			const tracker = new EscalationTracker('session-2', initialState);
			const state = tracker.getState();
			expect(state.patternCounts.get('repetition_loop')).toBe(2);
			expect(state.escalationLevel).toBe(2);
			expect(state.lastPatternDetected?.pattern).toBe('repetition_loop');
			expect(state.correctionsPending.length).toBe(1);
		});
	});

	describe('recordDetection - 3-strike protocol', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		test('first detection returns level 1 with correction, no hard stop', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			const result = tracker.recordDetection(match);

			expect(result.level).toBe(1);
			expect(result.hardStop).toBe(false);
			expect(result.correction).not.toBeNull();
			expect(result.correction?.pattern).toBe('repetition_loop');
			expect(result.correction?.alert).toContain('GUIDANCE');
			expect(telemetry.prmEscalationTriggered).not.toHaveBeenCalled();
			expect(telemetry.prmHardStop).not.toHaveBeenCalled();
		});

		test('second detection returns level 2 with correction, no hard stop, emits telemetry', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			tracker.recordDetection(match); // First detection
			const result = tracker.recordDetection(match); // Second detection

			expect(result.level).toBe(2);
			expect(result.hardStop).toBe(false);
			expect(result.correction).not.toBeNull();
			expect(result.correction?.alert).toContain('STRONG GUIDANCE');
			expect(telemetry.prmEscalationTriggered).toHaveBeenCalledWith(
				'session-1',
				'repetition_loop',
				2,
				2,
			);
			expect(telemetry.prmHardStop).not.toHaveBeenCalled();
		});

		test('third detection returns level 3 with correction and hard stop, emits telemetry', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			tracker.recordDetection(match); // 1st
			tracker.recordDetection(match); // 2nd
			const result = tracker.recordDetection(match); // 3rd

			expect(result.level).toBe(3);
			expect(result.hardStop).toBe(true);
			expect(result.correction).not.toBeNull();
			expect(result.correction?.alert).toContain('HARD STOP');
			expect(telemetry.prmHardStop).toHaveBeenCalledWith(
				'session-1',
				'repetition_loop',
				3,
				3,
			);
			expect(telemetry.prmEscalationTriggered).toHaveBeenCalledTimes(1); // Only from 2nd
		});

		test('fourth+ detection continues to return level 3 and hard stop', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			tracker.recordDetection(match); // 1
			tracker.recordDetection(match); // 2
			tracker.recordDetection(match); // 3
			const result = tracker.recordDetection(match); // 4

			expect(result.level).toBe(3);
			expect(result.hardStop).toBe(true);
		});

		test('each pattern type tracks counts independently', () => {
			const tracker = new EscalationTracker('session-1');
			const loopMatch = createMockPatternMatch('repetition_loop');
			const pingMatch = createMockPatternMatch('ping_pong');

			const r1 = tracker.recordDetection(loopMatch);
			expect(r1.level).toBe(1);

			const r2 = tracker.recordDetection(pingMatch);
			expect(r2.level).toBe(1); // First for ping_pong

			const r3 = tracker.recordDetection(loopMatch);
			expect(r3.level).toBe(2); // Second for repetition_loop

			const r4 = tracker.recordDetection(pingMatch);
			expect(r4.level).toBe(2); // Second for ping_pong
		});

		test('corrections are accumulated in pending array', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			tracker.recordDetection(match);
			tracker.recordDetection(match);

			const corrections = tracker.getPendingCorrections();
			expect(corrections.length).toBe(2);
			expect(corrections[0].alert).toContain('GUIDANCE');
			expect(corrections[1].alert).toContain('STRONG GUIDANCE');
		});

		test('lastPatternDetected is updated on each detection', () => {
			const tracker = new EscalationTracker('session-1');
			const loopMatch = createMockPatternMatch('repetition_loop');
			const pingMatch = createMockPatternMatch('ping_pong');

			tracker.recordDetection(loopMatch);
			expect(tracker.getState().lastPatternDetected?.pattern).toBe(
				'repetition_loop',
			);

			tracker.recordDetection(pingMatch);
			expect(tracker.getState().lastPatternDetected?.pattern).toBe('ping_pong');
		});

		test('escalationLevel is set correctly per strike', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			tracker.recordDetection(match);
			expect(tracker.getState().escalationLevel).toBe(1);

			tracker.recordDetection(match);
			expect(tracker.getState().escalationLevel).toBe(2);

			tracker.recordDetection(match);
			expect(tracker.getState().escalationLevel).toBe(3);
		});

		test('hardStopPending flag is set on third strike', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			expect(tracker.isHardStopPending()).toBe(false);

			tracker.recordDetection(match);
			expect(tracker.isHardStopPending()).toBe(false);

			tracker.recordDetection(match);
			expect(tracker.isHardStopPending()).toBe(false);

			tracker.recordDetection(match);
			expect(tracker.isHardStopPending()).toBe(true);
		});
	});

	describe('recordDetection - all pattern types', () => {
		const patternTypes: PatternMatch['pattern'][] = [
			'repetition_loop',
			'ping_pong',
			'expansion_drift',
			'stuck_on_test',
			'context_thrash',
		];

		test.each(
			patternTypes,
		)('generates correction for %s pattern type', (pattern) => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch(pattern);

			const result = tracker.recordDetection(match);

			expect(result.level).toBe(1);
			expect(result.correction?.pattern).toBe(pattern);
			// Alert uses human-readable description, pattern field contains identifier
			expect(result.correction).toBeDefined();
		});
	});

	describe('getState', () => {
		test('returns a defensive copy of internal state', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);

			const state1 = tracker.getState();
			const state2 = tracker.getState();

			expect(state1).not.toBe(state2);
			expect(state1.patternCounts.get('repetition_loop')).toBe(1);
			state1.patternCounts.set('repetition_loop', 99);
			state1.lastPatternDetected?.affectedAgents.push('mutated-agent');
			state1.lastPatternDetected?.affectedTargets.push('mutated-target');
			state1.correctionsPending.push({
				alert: 'mutated',
				category: 'reasoning_error',
				pattern: 'repetition_loop',
				guidance: 'mutated',
				action: 'mutated',
				stepRange: [1, 1],
				timestamp: new Date().toISOString(),
			});

			const freshState = tracker.getState();
			expect(freshState.patternCounts.get('repetition_loop')).toBe(1);
			expect(freshState.lastPatternDetected?.affectedAgents).toEqual([
				'agent-a',
			]);
			expect(freshState.lastPatternDetected?.affectedTargets).toEqual([
				'src/foo.ts',
			]);
			expect(freshState.correctionsPending).toHaveLength(1);
		});
	});

	describe('reset', () => {
		test('clears all pattern counts', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			expect(tracker.getState().patternCounts.get('repetition_loop')).toBe(2);

			tracker.reset();

			expect(tracker.getState().patternCounts.size).toBe(0);
		});

		test('resets escalationLevel to 0', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			expect(tracker.getState().escalationLevel).toBe(2);

			tracker.reset();

			expect(tracker.getState().escalationLevel).toBe(0);
		});

		test('clears lastPatternDetected', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);

			expect(tracker.getState().lastPatternDetected).not.toBeNull();

			tracker.reset();

			expect(tracker.getState().lastPatternDetected).toBeNull();
		});

		test('clears hardStopPending flag', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			expect(tracker.isHardStopPending()).toBe(true);

			tracker.reset();

			expect(tracker.isHardStopPending()).toBe(false);
		});

		test('clears correctionsPending', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			expect(tracker.getPendingCorrections().length).toBe(2);

			tracker.reset();

			expect(tracker.getPendingCorrections().length).toBe(0);
		});
	});

	describe('getPendingCorrections', () => {
		test('returns empty array initially', () => {
			const tracker = new EscalationTracker('session-1');
			expect(tracker.getPendingCorrections()).toEqual([]);
		});

		test('returns defensive copies of internal corrections array', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);

			const corrections = tracker.getPendingCorrections();
			expect(corrections.length).toBe(1);
			corrections.push({} as CourseCorrection);
			corrections[0].stepRange[0] = 99;

			const freshCorrections = tracker.getPendingCorrections();
			expect(freshCorrections.length).toBe(1);
			expect(freshCorrections[0].stepRange[0]).not.toBe(99);
		});
	});

	describe('clearPendingCorrections', () => {
		test('clears all pending corrections', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			expect(tracker.getPendingCorrections().length).toBe(2);

			tracker.clearPendingCorrections();

			expect(tracker.getPendingCorrections().length).toBe(0);
		});

		test('does not reset pattern counts or escalation level', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			tracker.clearPendingCorrections();

			// Pattern counts still tracked
			expect(tracker.getState().patternCounts.get('repetition_loop')).toBe(2);
			expect(tracker.getState().escalationLevel).toBe(2);
		});
	});

	describe('isHardStopPending', () => {
		test('returns false initially', () => {
			const tracker = new EscalationTracker('session-1');
			expect(tracker.isHardStopPending()).toBe(false);
		});

		test('returns true after third strike', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			expect(tracker.isHardStopPending()).toBe(true);
		});

		test('returns false after reset', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');
			tracker.recordDetection(match);
			tracker.recordDetection(match);
			tracker.recordDetection(match);

			tracker.reset();

			expect(tracker.isHardStopPending()).toBe(false);
		});
	});

	describe('correction content', () => {
		test('correction includes all required fields', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop', {
				affectedAgents: ['coder', 'reviewer'],
				affectedTargets: ['src/a.ts', 'src/b.ts'],
			});

			const result = tracker.recordDetection(match);

			expect(result.correction).toEqual({
				alert: expect.stringContaining('GUIDANCE'),
				category: 'coordination_error',
				guidance: expect.any(String),
				action: expect.any(String),
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
		});

		test('level 2 correction has STRONG GUIDANCE prefix', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('ping_pong');
			tracker.recordDetection(match);
			const result = tracker.recordDetection(match);

			expect(result.correction?.alert).toContain('STRONG GUIDANCE');
			expect(result.correction?.alert).toContain(
				'Delegation ping-pong detected',
			);
		});

		test('level 3 correction has HARD STOP prefix', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('expansion_drift');
			tracker.recordDetection(match);
			tracker.recordDetection(match);
			const result = tracker.recordDetection(match);

			expect(result.correction?.alert).toContain('HARD STOP');
			expect(result.correction?.alert).toContain(
				'Scope expansion drift detected',
			);
		});
	});

	describe('edge cases', () => {
		test('handles different severity levels in match', () => {
			const severities: Array<PatternMatch['severity']> = [
				'low',
				'medium',
				'high',
				'critical',
			];

			severities.forEach((severity) => {
				const tracker = new EscalationTracker(`session-${severity}`);
				const match = createMockPatternMatch('stuck_on_test', { severity });
				const result = tracker.recordDetection(match);

				expect(result.correction?.pattern).toBe('stuck_on_test');
				expect(result.level).toBe(1);
			});
		});

		test('handles different taxonomy categories', () => {
			const categories: Array<PatternMatch['category']> = [
				'specification_error',
				'reasoning_error',
				'coordination_error',
			];

			categories.forEach((category) => {
				const tracker = new EscalationTracker(`session-${category}`);
				const match = createMockPatternMatch('context_thrash', { category });
				const result = tracker.recordDetection(match);

				expect(result.correction?.category).toBe(category);
			});
		});

		test('handles various step ranges', () => {
			const tracker = new EscalationTracker('session-1');
			const match1 = createMockPatternMatch('repetition_loop', {
				stepRange: [1, 1],
			});
			const match2 = createMockPatternMatch('repetition_loop', {
				stepRange: [100, 200],
			});

			const result1 = tracker.recordDetection(match1);
			expect(result1.correction?.stepRange).toEqual([1, 1]);

			const result2 = tracker.recordDetection(match2);
			expect(result2.correction?.stepRange).toEqual([100, 200]);
		});

		test('handles empty affectedAgents and affectedTargets', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop', {
				affectedAgents: [],
				affectedTargets: [],
			});

			const result = tracker.recordDetection(match);

			expect(result.correction).toBeDefined();
			expect(result.correction?.pattern).toBe('repetition_loop');
		});

		test('tracker is reusable after reset', () => {
			const tracker = new EscalationTracker('session-1');
			const match = createMockPatternMatch('repetition_loop');

			// First cycle
			tracker.recordDetection(match);
			tracker.recordDetection(match);
			tracker.recordDetection(match);
			expect(tracker.isHardStopPending()).toBe(true);

			// Reset
			tracker.reset();

			// Second cycle
			const result = tracker.recordDetection(match);
			expect(result.level).toBe(1);
			expect(tracker.isHardStopPending()).toBe(false);
		});
	});
});

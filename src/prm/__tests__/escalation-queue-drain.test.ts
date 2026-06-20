import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { _internals, createPrmHook } from '../index';
import { clearTrajectoryCache } from '../trajectory-store';
import type { PatternMatch, PrmConfig, TrajectoryEntry } from '../types';

const originalGetAgentSession = _internals.getAgentSession;
const originalReadTrajectory = _internals.readTrajectory;
const originalGetInMemoryTrajectory = _internals.getInMemoryTrajectory;
const originalDetectPatterns = _internals.detectPatterns;
const originalGenerateCourseCorrection = _internals.generateCourseCorrection;
const originalFormatCourseCorrectionForInjection =
	_internals.formatCourseCorrectionForInjection;
const originalCleanupOldTrajectoryFiles = _internals.cleanupOldTrajectoryFiles;
const originalRecordReplayEntry = _internals.recordReplayEntry;
const originalStartReplayRecording = _internals.startReplayRecording;
const originalTelemetry = _internals.telemetry;

function createMockConfig(overrides: Partial<PrmConfig> = {}): PrmConfig {
	return {
		enabled: true,
		pattern_thresholds: {
			repetition_loop: 2,
			ping_pong: 4,
			expansion_drift: 3,
			stuck_on_test: 3,
			context_thrash: 5,
		},
		max_trajectory_lines: 100,
		escalation_enabled: true,
		detection_timeout_ms: 5000,
		...overrides,
	};
}

function createMockTrajectory(): TrajectoryEntry[] {
	return [
		{
			step: 1,
			agent: 'coder',
			action: 'edit',
			target: 'src/foo.ts',
			intent: 'Add feature',
			timestamp: '2024-01-01T00:00:00Z',
			result: 'success',
			tool: 'edit',
			args_summary: 'src/foo.ts',
		},
	];
}

function createMockPatternMatch(
	pattern: PatternMatch['pattern'] = 'repetition_loop',
	overrides: Partial<PatternMatch> = {},
): PatternMatch {
	return {
		pattern,
		severity: 'medium',
		category: 'coordination_error',
		stepRange: [1, 3],
		description: 'Test pattern detected',
		affectedAgents: ['coder'],
		affectedTargets: ['src/foo.ts'],
		occurrenceCount: 1,
		...overrides,
	};
}

function createMockSession(sessionId: string, delegationActive = true) {
	return {
		sessionId,
		agentName: 'test-agent',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive,
		activeInvocationId: 1,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: '1.1',
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
		stageBCompletion: new Map(),
		taskCouncilApproved: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		scopeViolationDetected: false,
		modifiedFilesThisCoderTask: [],
		turboMode: false,
		qaGateSessionOverrides: {},
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		coderRevisions: 0,
		revisionLimitHit: false,
		loopDetectionWindow: [],
		pendingAdvisoryMessages: [] as string[],
		sessionRehydratedAt: 0,
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		prmPatternCounts: new Map<string, number>(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null as PatternMatch | null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		prmEscalationTracker: undefined,
	};
}

function setupMocks(
	sessionId: string,
	trajectory: TrajectoryEntry[],
	matches: PatternMatch[],
) {
	const session = createMockSession(sessionId);
	_internals.getAgentSession = () => session;
	_internals.readTrajectory = async () => trajectory;
	_internals.getInMemoryTrajectory = () => [];
	_internals.detectPatterns = () => ({
		matches,
		detectionTimeMs: 5,
		patternsChecked: 5,
	});
	_internals.generateCourseCorrection = () => ({
		alert: 'TRAJECTORY ALERT: repetition_loop detected',
		category: 'coordination_error',
		guidance: 'Stop the repetitive loop',
		action: 'Consolidate changes',
		pattern: 'repetition_loop',
		stepRange: [1, 3],
	});
	_internals.formatCourseCorrectionForInjection = () => 'FORMATTED CORRECTION';
	_internals.cleanupOldTrajectoryFiles = async () => {};
	_internals.recordReplayEntry = async () => {};
	_internals.startReplayRecording = async () => null;
	_internals.telemetry = {
		...originalTelemetry,
		prmPatternDetected: mock(() => {}),
		prmCourseCorrectionInjected: mock(() => {}),
		prmEscalationTriggered: mock(() => {}),
		prmHardStop: mock(() => {}),
	};
	return session;
}

describe('Escalation Correction Queue Drain', () => {
	const sessionId = 'test-session-escalation-123';
	const directory = '/test/project';

	beforeEach(() => {
		clearTrajectoryCache();
	});

	afterEach(() => {
		_internals.getAgentSession = originalGetAgentSession;
		_internals.readTrajectory = originalReadTrajectory;
		_internals.getInMemoryTrajectory = originalGetInMemoryTrajectory;
		_internals.detectPatterns = originalDetectPatterns;
		_internals.generateCourseCorrection = originalGenerateCourseCorrection;
		_internals.formatCourseCorrectionForInjection =
			originalFormatCourseCorrectionForInjection;
		_internals.cleanupOldTrajectoryFiles = originalCleanupOldTrajectoryFiles;
		_internals.recordReplayEntry = originalRecordReplayEntry;
		_internals.startReplayRecording = originalStartReplayRecording;
		_internals.telemetry = originalTelemetry;
		clearTrajectoryCache();
	});

	describe('Task 3.6: clearPendingCorrections after injection', () => {
		test('pending corrections queue is empty after single toolAfter call with pattern match', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.prmEscalationTracker).not.toBeUndefined();

			const pendingCorrections =
				session.prmEscalationTracker!.getPendingCorrections();
			expect(pendingCorrections).toEqual([]);
		});

		test('pending corrections queue is empty after toolAfter with multiple pattern matches', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match1 = createMockPatternMatch('repetition_loop');
			const match2 = createMockPatternMatch('ping_pong');
			const session = setupMocks(sessionId, trajectory, [match1, match2]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			const pendingCorrections =
				session.prmEscalationTracker!.getPendingCorrections();
			expect(pendingCorrections).toEqual([]);

			expect(session.pendingAdvisoryMessages).toHaveLength(2);
			expect(session.pendingAdvisoryMessages).toContain('FORMATTED CORRECTION');
		});

		test('pending corrections queue does not accumulate across multiple toolAfter calls', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmEscalationTracker!.getPendingCorrections()).toEqual([]);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmEscalationTracker!.getPendingCorrections()).toEqual([]);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmEscalationTracker!.getPendingCorrections()).toEqual([]);

			expect(session.prmPatternCounts.get('repetition_loop')).toBe(3);
			expect(session.prmEscalationLevel).toBe(3);
			expect(session.prmHardStopPending).toBe(true);
			expect(session.pendingAdvisoryMessages).toHaveLength(3);
		});

		test('correction is injected to pendingAdvisoryMessages before queue is cleared', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.pendingAdvisoryMessages).toContain('FORMATTED CORRECTION');
			expect(session.prmEscalationTracker!.getPendingCorrections()).toEqual([]);
		});

		test('session without pattern matches has empty pending corrections', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const session = setupMocks(sessionId, trajectory, []);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			if (session.prmEscalationTracker) {
				expect(session.prmEscalationTracker.getPendingCorrections()).toEqual(
					[],
				);
			}
		});
	});
});

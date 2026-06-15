import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EscalationTracker } from '../escalation';
import { _internals, createPrmHook } from '../index';
import type { PatternMatch, PrmConfig, TrajectoryEntry } from '../types';

// Original function references saved once at module load for save/restore
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
		{
			step: 2,
			agent: 'reviewer',
			action: 'review',
			target: 'src/foo.ts',
			intent: 'Review changes',
			timestamp: '2024-01-01T00:01:00Z',
			result: 'success',
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
		partialGateWarningsIssuedForTask: new Set<string>(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set<number>(),
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
		pendingAdvisoryMessages: [],
		sessionRehydratedAt: 0,
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set<string>(),
		lastCompletedPhaseAgentsDispatched: new Set<string>(),
		// PRM fields
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null as PatternMatch | null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		prmEscalationTracker: undefined,
	};
}

/**
 * No-op mock for telemetry methods — tests verify the calls happen,
 * not the telemetry payload transport.
 */
function createNoopTelemetry(): typeof originalTelemetry {
	return {
		...originalTelemetry,
		prmPatternDetected: () => {},
		prmCourseCorrectionInjected: () => {},
		prmEscalationTriggered: () => {},
		prmHardStop: () => {},
	};
}

function setupHappyPathMocks(
	_sessionId: string,
	trajectory: TrajectoryEntry[],
	matches: PatternMatch[],
) {
	_internals.getAgentSession = () => createMockSession(_sessionId);

	_internals.readTrajectory = async () => trajectory;

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
}

describe('createPrmHook', () => {
	const sessionId = 'test-session-123';
	const directory = '/test/project';

	beforeEach(() => {
		// Restore all originals before each test
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
		_internals.telemetry = createNoopTelemetry();
	});

	afterEach(() => {
		// Restore all originals to prevent cross-file leakage
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
	});

	describe('enabled/disabled config', () => {
		test('returns early when config.enabled is false', async () => {
			const config = createMockConfig({ enabled: false });
			_internals.getAgentSession = () => createMockSession(sessionId);

			// Track calls
			let readTrajectoryCalled = false;
			_internals.readTrajectory = async () => {
				readTrajectoryCalled = true;
				return [];
			};
			let detectPatternsCalled = false;
			_internals.detectPatterns = () => {
				detectPatternsCalled = true;
				return { matches: [], detectionTimeMs: 5, patternsChecked: 5 };
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			// Should NOT call trajectory or detection
			expect(readTrajectoryCalled).toBe(false);
			expect(detectPatternsCalled).toBe(false);
		});

		test('processes when config.enabled is true', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;

			const trajectory = createMockTrajectory();
			let readTrajectoryArgs: [string, string] | null = null;
			_internals.readTrajectory = async (...args) => {
				readTrajectoryArgs = args;
				return trajectory;
			};
			let detectPatternsCalled = false;
			_internals.detectPatterns = () => {
				detectPatternsCalled = true;
				return { matches: [], detectionTimeMs: 5, patternsChecked: 5 };
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(readTrajectoryArgs).toEqual([sessionId, directory]);
			expect(detectPatternsCalled).toBe(true);
		});

		test('returns early when session not found', async () => {
			const config = createMockConfig({ enabled: true });
			_internals.getAgentSession = () => undefined;

			let readTrajectoryCalled = false;
			_internals.readTrajectory = async () => {
				readTrajectoryCalled = true;
				return [];
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(readTrajectoryCalled).toBe(false);
		});

		test('returns early when delegationActive is false', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId, false);
			_internals.getAgentSession = () => session;

			let readTrajectoryCalled = false;
			_internals.readTrajectory = async () => {
				readTrajectoryCalled = true;
				return [];
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(readTrajectoryCalled).toBe(false);
		});

		test('returns early when no pattern matches found', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => createMockTrajectory();
			_internals.detectPatterns = () => ({
				matches: [],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			// No escalation tracker should be created when no matches
			expect(session.prmEscalationTracker).toBeUndefined();
		});
	});

	describe('pattern detection integration', () => {
		test('processes single pattern match correctly', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			setupHappyPathMocks(sessionId, trajectory, [match]);

			// Track calls via call log
			const generateCCArgs: [PatternMatch, TrajectoryEntry[]][] = [];
			_internals.generateCourseCorrection = (...args) => {
				generateCCArgs.push(args as [PatternMatch, TrajectoryEntry[]]);
				return {
					alert: 'ALERT',
					category: 'coordination_error',
					guidance: 'Stop the repetitive loop',
					action: 'Consolidate changes',
					pattern: 'repetition_loop',
					stepRange: [1, 3],
				};
			};
			let formatCalled = false;
			_internals.formatCourseCorrectionForInjection = () => {
				formatCalled = true;
				return 'FORMATTED CORRECTION';
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(generateCCArgs).toHaveLength(1);
			expect(generateCCArgs[0]).toEqual([match, trajectory]);
			expect(formatCalled).toBe(true);
		});

		test('processes multiple pattern matches in sequence', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match1 = createMockPatternMatch('repetition_loop');
			const match2 = createMockPatternMatch('ping_pong');

			// Create a single session instance to track state mutations
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match1, match2],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});

			// Track call counts
			let generateCCCount = 0;
			_internals.generateCourseCorrection = () => {
				generateCCCount++;
				return {
					alert: 'ALERT',
					category: 'coordination_error',
					guidance: 'GUIDANCE',
					action: 'ACTION',
					pattern: 'repetition_loop',
					stepRange: [1, 3],
				};
			};
			let formatCount = 0;
			_internals.formatCourseCorrectionForInjection = () => {
				formatCount++;
				return 'FORMATTED';
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			// Should process both matches
			expect(generateCCCount).toBe(2);
			expect(formatCount).toBe(2);
			expect(session.pendingAdvisoryMessages ?? []).toHaveLength(2);
		});

		test('passes correct config to detectPatterns', async () => {
			const config = createMockConfig({
				enabled: true,
				pattern_thresholds: {
					repetition_loop: 5,
					ping_pong: 10,
					expansion_drift: 3,
					stuck_on_test: 3,
					context_thrash: 5,
				},
			});
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			const trajectory = createMockTrajectory();
			_internals.readTrajectory = async () => trajectory;

			const detectPatternsArgs: [TrajectoryEntry[], PrmConfig, number][] = [];
			_internals.detectPatterns = (...args) => {
				detectPatternsArgs.push(args as [TrajectoryEntry[], PrmConfig, number]);
				return { matches: [], detectionTimeMs: 5, patternsChecked: 5 };
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(detectPatternsArgs).toHaveLength(1);
			expect(detectPatternsArgs[0][0]).toEqual(trajectory);
			expect(detectPatternsArgs[0][1]).toEqual(config);
			expect(detectPatternsArgs[0][2]).toBe(0);
		});
	});

	describe('session state updates', () => {
		test('creates new escalation tracker on first pattern detection', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.prmEscalationTracker).toBeInstanceOf(EscalationTracker);
		});

		test('reuses existing escalation tracker on subsequent detections', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			// First call
			await toolAfter({ sessionID: sessionId });
			const firstTracker = session.prmEscalationTracker;

			// Second call - same tracker should be reused
			await toolAfter({ sessionID: sessionId });

			expect(session.prmEscalationTracker).toBe(firstTracker);
		});

		test('adds formatted correction to pendingAdvisoryMessages', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () =>
				'FORMATTED CORRECTION STRING';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(
				(session.pendingAdvisoryMessages as string[]).includes(
					'FORMATTED CORRECTION STRING',
				),
			).toBe(true);
		});

		test('updates prmPatternCounts for detected pattern', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);
		});

		test('increments prmPatternCounts on subsequent detections', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(2);
		});

		test('updates prmEscalationLevel from escalation tracker', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			// First detection = level 1
			await toolAfter({ sessionID: sessionId });
			expect(session.prmEscalationLevel).toBe(1);

			// Second detection = level 2
			await toolAfter({ sessionID: sessionId });
			expect(session.prmEscalationLevel).toBe(2);

			// Third detection = level 3
			await toolAfter({ sessionID: sessionId });
			expect(session.prmEscalationLevel).toBe(3);
		});

		test('updates prmLastPatternDetected with current match', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match1 = createMockPatternMatch('repetition_loop');
			const match2 = createMockPatternMatch('ping_pong');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;

			// detectPatterns returns first pattern on first call, second on second call
			let detectCallCount = 0;
			_internals.detectPatterns = () => {
				detectCallCount++;
				if (detectCallCount === 1) {
					return { matches: [match1], detectionTimeMs: 5, patternsChecked: 5 };
				}
				return { matches: [match2], detectionTimeMs: 5, patternsChecked: 5 };
			};

			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmLastPatternDetected?.pattern).toBe('repetition_loop');

			await toolAfter({ sessionID: sessionId });
			expect(session.prmLastPatternDetected?.pattern).toBe('ping_pong');
		});

		test('sets prmHardStopPending on third detection', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			// First - should not be hard stop
			await toolAfter({ sessionID: sessionId });
			expect(session.prmHardStopPending).toBe(false);

			// Second - should not be hard stop
			await toolAfter({ sessionID: sessionId });
			expect(session.prmHardStopPending).toBe(false);

			// Third - should be hard stop
			await toolAfter({ sessionID: sessionId });
			expect(session.prmHardStopPending).toBe(true);
		});

		test('restores escalation tracker state from session for session resumption', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const session = createMockSession(sessionId);

			// Pre-populate PRM state as if session was being resumed
			session.prmPatternCounts = new Map([['repetition_loop', 2]]);
			session.prmEscalationLevel = 2;
			session.prmLastPatternDetected =
				createMockPatternMatch('repetition_loop');
			session.prmHardStopPending = false;

			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;

			const match = createMockPatternMatch('repetition_loop');
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			// The tracker should start from the restored state
			// Next detection should be level 3 (3rd occurrence)
			expect(session.prmEscalationLevel).toBe(3);
		});
	});

	describe('telemetry emission', () => {
		test('emits prmPatternDetected for each pattern match', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop', {
				severity: 'high',
				category: 'coordination_error',
				stepRange: [1, 5] as [number, number],
			});
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			// Track telemetry calls
			const prmPatternDetectedCalls: unknown[][] = [];
			_internals.telemetry = {
				...originalTelemetry,
				prmPatternDetected: (...args: unknown[]) => {
					prmPatternDetectedCalls.push(args);
				},
				prmCourseCorrectionInjected: () => {},
				prmEscalationTriggered: () => {},
				prmHardStop: () => {},
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(prmPatternDetectedCalls).toHaveLength(1);
			expect(prmPatternDetectedCalls[0]).toEqual([
				sessionId,
				'repetition_loop',
				'high',
				'coordination_error',
				[1, 5],
			]);
		});

		test('emits prmCourseCorrectionInjected for each pattern match', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			// Track telemetry calls
			const prmCCICalls: unknown[][] = [];
			_internals.telemetry = {
				...originalTelemetry,
				prmPatternDetected: () => {},
				prmCourseCorrectionInjected: (...args: unknown[]) => {
					prmCCICalls.push(args);
				},
				prmEscalationTriggered: () => {},
				prmHardStop: () => {},
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			// prmCourseCorrectionInjected is called with sessionId, pattern, escalationLevel
			expect(prmCCICalls).toHaveLength(1);
			expect(prmCCICalls[0]).toEqual([
				sessionId,
				'repetition_loop',
				1, // escalation level
			]);
		});

		test('emits telemetry for multiple pattern matches', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match1 = createMockPatternMatch('repetition_loop');
			const match2 = createMockPatternMatch('ping_pong');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match1, match2],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			// Track telemetry calls
			const prmPatternCalls: unknown[][] = [];
			const prmCCICalls: unknown[][] = [];
			_internals.telemetry = {
				...originalTelemetry,
				prmPatternDetected: (...args: unknown[]) => {
					prmPatternCalls.push(args);
				},
				prmCourseCorrectionInjected: (...args: unknown[]) => {
					prmCCICalls.push(args);
				},
				prmEscalationTriggered: () => {},
				prmHardStop: () => {},
			};

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(prmPatternCalls).toHaveLength(2);
			expect(prmCCICalls).toHaveLength(2);
		});
	});

	describe('error handling', () => {
		test('catches and logs error from readTrajectory without throwing', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			// Throw synchronously to simulate error
			_internals.readTrajectory = () => {
				throw new Error('Trajectory read failed');
			};

			const { toolAfter } = createPrmHook(config, directory);

			// Should NOT throw - error should be caught internally
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
		});

		test('catches and logs error from detectPatterns without throwing', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => createMockTrajectory();
			// Throw synchronously to simulate error
			_internals.detectPatterns = () => {
				throw new Error('Detection failed');
			};

			const { toolAfter } = createPrmHook(config, directory);

			// Should NOT throw - error should be caught internally
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
		});

		test('catches and logs error from generateCourseCorrection without throwing', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => createMockTrajectory();
			_internals.detectPatterns = () => ({
				matches: [createMockPatternMatch('repetition_loop')],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			// Throw synchronously to simulate error
			_internals.generateCourseCorrection = () => {
				throw new Error('Course correction failed');
			};

			const { toolAfter } = createPrmHook(config, directory);

			// Should NOT throw - error should be caught internally
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
		});

		test('error in toolAfter does not affect subsequent calls', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = () => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			// First call succeeds
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();

			// Second call should still work
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
			expect(session.pendingAdvisoryMessages).toHaveLength(2);
		});

		test('continues processing remaining matches when one generates error', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createMockTrajectory();
			const match1 = createMockPatternMatch('repetition_loop');
			const match2 = createMockPatternMatch('ping_pong');
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;

			// detectPatterns returns first pattern on first call, second on second call
			let detectCallCount = 0;
			_internals.detectPatterns = () => {
				detectCallCount++;
				if (detectCallCount === 1) {
					return { matches: [match1], detectionTimeMs: 5, patternsChecked: 5 };
				}
				return { matches: [match2], detectionTimeMs: 5, patternsChecked: 5 };
			};

			// First call throws, second succeeds
			let ccCallCount = 0;
			_internals.generateCourseCorrection = (match) => {
				ccCallCount++;
				if (ccCallCount === 1) {
					throw new Error('First correction failed');
				}
				return {
					alert: 'ALERT',
					category: 'coordination_error',
					guidance: 'GUIDANCE',
					action: 'ACTION',
					pattern: match.pattern,
					stepRange: [1, 3],
				};
			};

			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			// First toolAfter call - throws on first correction but catches and continues
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
			expect(ccCallCount).toBe(1);

			// Second toolAfter call - succeeds
			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
			expect(ccCallCount).toBe(2);

			// Second correction was added
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
		});
	});

	describe('return value', () => {
		test('createPrmHook returns object with toolAfter function', () => {
			const config = createMockConfig();
			const hook = createPrmHook(config, directory);

			expect(hook).toHaveProperty('toolAfter');
			expect(typeof hook.toolAfter).toBe('function');
		});

		test('toolAfter returns Promise<void>', async () => {
			const config = createMockConfig({ enabled: false });
			_internals.getAgentSession = () => createMockSession(sessionId);

			const { toolAfter } = createPrmHook(config, directory);

			const result = toolAfter({ sessionID: sessionId });

			expect(result).toBeInstanceOf(Promise);
			await expect(result).resolves.toBeUndefined();
		});
	});

	describe('edge cases', () => {
		test('handles empty trajectory array', async () => {
			const config = createMockConfig({ enabled: true });
			_internals.getAgentSession = () => createMockSession(sessionId);
			_internals.readTrajectory = async () => [];
			_internals.detectPatterns = () => ({
				matches: [],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});

			const { toolAfter } = createPrmHook(config, directory);

			await expect(
				toolAfter({ sessionID: sessionId }),
			).resolves.toBeUndefined();
		});

		test('handles missing optional fields in ToolAfterContext', async () => {
			const config = createMockConfig({ enabled: true });
			_internals.getAgentSession = () => createMockSession(sessionId);
			_internals.readTrajectory = async () => createMockTrajectory();
			_internals.detectPatterns = () => ({
				matches: [],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});

			const { toolAfter } = createPrmHook(config, directory);

			// Minimal context - only sessionId is required
			// Should not throw
			const result = toolAfter({ sessionID: sessionId });
			await expect(result).resolves.toBeUndefined();
		});

		test('handles all pattern types', async () => {
			const patternTypes: PatternMatch['pattern'][] = [
				'repetition_loop',
				'ping_pong',
				'expansion_drift',
				'stuck_on_test',
				'context_thrash',
			];

			for (const pattern of patternTypes) {
				const config = createMockConfig({ enabled: true });
				const session = createMockSession(`${sessionId}-${pattern}`);
				_internals.getAgentSession = () => session;
				_internals.readTrajectory = async () => createMockTrajectory();

				const match = createMockPatternMatch(pattern);
				_internals.detectPatterns = () => ({
					matches: [match],
					detectionTimeMs: 5,
					patternsChecked: 5,
				});
				_internals.generateCourseCorrection = () => ({
					alert: 'ALERT',
					category: 'coordination_error',
					guidance: 'GUIDANCE',
					action: 'ACTION',
					pattern,
					stepRange: [1, 3],
				});
				_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

				const { toolAfter } = createPrmHook(config, directory);

				await expect(
					toolAfter({ sessionID: `${sessionId}-${pattern}` }),
				).resolves.toBeUndefined();
				expect(session.prmPatternCounts.get(pattern)).toBe(1);
			}
		});

		test('handles all severity levels', async () => {
			const severities: PatternMatch['severity'][] = [
				'low',
				'medium',
				'high',
				'critical',
			];

			for (const severity of severities) {
				const config = createMockConfig({ enabled: true });
				const session = createMockSession(`${sessionId}-${severity}`);
				_internals.getAgentSession = () => session;
				_internals.readTrajectory = async () => createMockTrajectory();

				const match = createMockPatternMatch('repetition_loop', { severity });
				_internals.detectPatterns = () => ({
					matches: [match],
					detectionTimeMs: 5,
					patternsChecked: 5,
				});
				_internals.generateCourseCorrection = () => ({
					alert: 'ALERT',
					category: 'coordination_error',
					guidance: 'GUIDANCE',
					action: 'ACTION',
					pattern: 'repetition_loop',
					stepRange: [1, 3],
				});
				_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

				const { toolAfter } = createPrmHook(config, directory);

				await expect(
					toolAfter({ sessionID: `${sessionId}-${severity}` }),
				).resolves.toBeUndefined();
			}
		});

		test('handles all taxonomy categories', async () => {
			const categories: PatternMatch['category'][] = [
				'specification_error',
				'reasoning_error',
				'coordination_error',
			];

			for (const category of categories) {
				const config = createMockConfig({ enabled: true });
				const session = createMockSession(`${sessionId}-${category}`);
				_internals.getAgentSession = () => session;
				_internals.readTrajectory = async () => createMockTrajectory();

				const match = createMockPatternMatch('repetition_loop', { category });
				_internals.detectPatterns = () => ({
					matches: [match],
					detectionTimeMs: 5,
					patternsChecked: 5,
				});
				_internals.generateCourseCorrection = () => ({
					alert: 'ALERT',
					category,
					guidance: 'GUIDANCE',
					action: 'ACTION',
					pattern: 'repetition_loop',
					stepRange: [1, 3],
				});
				_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

				const { toolAfter } = createPrmHook(config, directory);

				await expect(
					toolAfter({ sessionID: `${sessionId}-${category}` }),
				).resolves.toBeUndefined();
			}
		});
	});
});

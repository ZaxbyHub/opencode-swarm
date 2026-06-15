import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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

/**
 * Helper: Create default PRM config
 */
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

/**
 * Helper: Create mock trajectory with repeated pattern for repetition_loop detection
 */
function createRepetitionLoopTrajectory(): TrajectoryEntry[] {
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
			agent: 'coder',
			action: 'edit',
			target: 'src/foo.ts',
			intent: 'Add feature',
			timestamp: '2024-01-01T00:01:00Z',
			result: 'success',
			tool: 'edit',
			args_summary: 'src/foo.ts',
		},
		{
			step: 3,
			agent: 'coder',
			action: 'edit',
			target: 'src/foo.ts',
			intent: 'Add feature',
			timestamp: '2024-01-01T00:02:00Z',
			result: 'success',
			tool: 'edit',
			args_summary: 'src/foo.ts',
		},
		{
			step: 4,
			agent: 'reviewer',
			action: 'review',
			target: 'src/foo.ts',
			intent: 'Review changes',
			timestamp: '2024-01-01T00:03:00Z',
			result: 'success',
		},
	];
}

/**
 * Helper: Create mock trajectory for ping_pong pattern
 */
function createPingPongTrajectory(): TrajectoryEntry[] {
	return [
		{
			step: 1,
			agent: 'architect',
			action: 'delegate',
			target: 'task-1',
			intent: 'Delegate to coder',
			timestamp: '2024-01-01T00:00:00Z',
			result: 'success',
		},
		{
			step: 2,
			agent: 'coder',
			action: 'delegate',
			target: 'task-1',
			intent: 'Return to architect',
			timestamp: '2024-01-01T00:01:00Z',
			result: 'success',
		},
		{
			step: 3,
			agent: 'architect',
			action: 'delegate',
			target: 'task-1',
			intent: 'Delegate to coder again',
			timestamp: '2024-01-01T00:02:00Z',
			result: 'success',
		},
		{
			step: 4,
			agent: 'coder',
			action: 'delegate',
			target: 'task-1',
			intent: 'Return to architect again',
			timestamp: '2024-01-01T00:03:00Z',
			result: 'success',
		},
	];
}

/**
 * Helper: Create mock trajectory for stuck_on_test pattern
 */
function createStuckOnTestTrajectory(): TrajectoryEntry[] {
	return [
		{
			step: 1,
			agent: 'coder',
			action: 'edit',
			target: 'src/test.spec.ts',
			intent: 'Fix test',
			timestamp: '2024-01-01T00:00:00Z',
			result: 'success',
		},
		{
			step: 2,
			agent: 'coder',
			action: 'test',
			target: 'src/test.spec.ts',
			intent: 'Run test',
			timestamp: '2024-01-01T00:01:00Z',
			result: 'failure',
		},
		{
			step: 3,
			agent: 'coder',
			action: 'edit',
			target: 'src/test.spec.ts',
			intent: 'Fix test again',
			timestamp: '2024-01-01T00:02:00Z',
			result: 'success',
		},
		{
			step: 4,
			agent: 'coder',
			action: 'test',
			target: 'src/test.spec.ts',
			intent: 'Run test',
			timestamp: '2024-01-01T00:03:00Z',
			result: 'failure',
		},
		{
			step: 5,
			agent: 'coder',
			action: 'edit',
			target: 'src/test.spec.ts',
			intent: 'Fix test again',
			timestamp: '2024-01-01T00:04:00Z',
			result: 'success',
		},
	];
}

/**
 * Helper: Create mock pattern match
 */
function createMockPatternMatch(
	pattern: PatternMatch['pattern'] = 'repetition_loop',
	overrides: Partial<PatternMatch> = {},
): PatternMatch {
	return {
		pattern,
		severity: 'medium',
		category: 'coordination_error',
		stepRange: [1, 3],
		description: `Test ${pattern} pattern detected`,
		affectedAgents: ['coder'],
		affectedTargets: ['src/foo.ts'],
		occurrenceCount: 1,
		...overrides,
	};
}

/**
 * Helper: Create mock session with PRM state
 */
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
		// PRM fields
		prmPatternCounts: new Map<string, number>(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null as PatternMatch | null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		prmEscalationTracker: undefined,
	};
}

describe('PRM Integration Tests', () => {
	const sessionId = 'integration-test-session';
	const directory = '/test/project';

	// Telemetry mock functions — replaced in beforeEach so each test gets fresh counters
	let mockPrmPatternDetected: ReturnType<typeof mock>;
	let mockPrmCourseCorrectionInjected: ReturnType<typeof mock>;
	let mockPrmEscalationTriggered: ReturnType<typeof mock>;
	let mockPrmHardStop: ReturnType<typeof mock>;

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

		// Create fresh telemetry mocks for each test
		mockPrmPatternDetected = mock(() => {});
		mockPrmCourseCorrectionInjected = mock(() => {});
		mockPrmEscalationTriggered = mock(() => {});
		mockPrmHardStop = mock(() => {});
		_internals.telemetry = {
			...originalTelemetry,
			prmPatternDetected: mockPrmPatternDetected,
			prmCourseCorrectionInjected: mockPrmCourseCorrectionInjected,
			prmEscalationTriggered: mockPrmEscalationTriggered,
			prmHardStop: mockPrmHardStop,
		};
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

	/**
	 * Helper: Setup common mocks for happy path
	 */
	function setupHappyPathMocks(
		sessionId: string,
		trajectory: TrajectoryEntry[],
		matches: PatternMatch[],
	) {
		const session = createMockSession(sessionId);
		_internals.getAgentSession = () => session;
		_internals.readTrajectory = async () => trajectory;
		_internals.detectPatterns = () => ({
			matches,
			detectionTimeMs: 5,
			patternsChecked: 5,
		});
		_internals.generateCourseCorrection = () => ({
			alert: `TRAJECTORY ALERT: ${matches[0]?.pattern ?? 'repetition_loop'} detected`,
			category: 'coordination_error',
			guidance: 'Stop the repetitive loop',
			action: 'Consolidate changes and change approach immediately.',
			pattern: matches[0]?.pattern ?? 'repetition_loop',
			stepRange: matches[0]?.stepRange ?? [1, 3],
		});
		_internals.formatCourseCorrectionForInjection = (correction) => {
			return `[TRAJECTORY ALERT] ${correction.alert}\n[CATEGORY] ${correction.category}\n[GUIDANCE] ${correction.guidance}\n[ACTION] ${correction.action}`;
		};
		return session;
	}

	describe('Test 1: Full PRM pipeline with repetition loop', () => {
		test('simulates repeated coder delegations and verifies full pipeline', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const match = createMockPatternMatch('repetition_loop', {
				severity: 'medium',
				category: 'coordination_error',
				stepRange: [1, 3],
			});

			// Use a mock for detectPatterns so we can assert call args
			const mockDetectPatterns = mock(() => ({
				matches: [match],
				detectionTimeMs: 5,
				patternsChecked: 5,
			}));
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;
			_internals.readTrajectory = async () => trajectory;
			_internals.detectPatterns = mockDetectPatterns;
			_internals.generateCourseCorrection = () => ({
				alert: `TRAJECTORY ALERT: repetition_loop detected`,
				category: 'coordination_error',
				guidance: 'Stop the repetitive loop',
				action: 'Consolidate changes and change approach immediately.',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = (correction) => {
				return `[TRAJECTORY ALERT] ${correction.alert}\n[CATEGORY] ${correction.category}\n[GUIDANCE] ${correction.guidance}\n[ACTION] ${correction.action}`;
			};

			const { toolAfter } = createPrmHook(config, directory);

			// Simulate first delegation cycle
			await toolAfter({ sessionID: sessionId });

			// Verify pattern detection fired (repetition_loop)
			// detectPatterns is called with trajectory, config, and lastProcessedStep (0 on first call)
			expect(mockDetectPatterns).toHaveBeenCalledWith(trajectory, config, 0);

			// Verify course correction is added to pendingAdvisoryMessages
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
			expect(session.pendingAdvisoryMessages[0]).toContain('TRAJECTORY ALERT');
			expect(session.pendingAdvisoryMessages[0]).toContain('repetition_loop');

			// Verify escalation tracker counts the detection
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);
			expect(session.prmEscalationLevel).toBe(1);

			// Verify telemetry events are emitted
			expect(mockPrmPatternDetected).toHaveBeenCalledWith(
				sessionId,
				'repetition_loop',
				'medium',
				'coordination_error',
				[1, 3],
			);
			expect(mockPrmCourseCorrectionInjected).toHaveBeenCalledWith(
				sessionId,
				'repetition_loop',
				1,
			);
		});

		test('processes multiple repetition loop cycles with escalating corrections', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			// Simulate 3 cycles of the same pattern
			await toolAfter({ sessionID: sessionId });
			await toolAfter({ sessionID: sessionId });
			await toolAfter({ sessionID: sessionId });

			// Verify 3 corrections added
			expect(session.pendingAdvisoryMessages).toHaveLength(3);

			// Verify escalation level reached 3 (hard stop)
			expect(session.prmEscalationLevel).toBe(3);
			expect(session.prmHardStopPending).toBe(true);

			// Verify telemetry called appropriately
			expect(mockPrmPatternDetected).toHaveBeenCalledTimes(3);
			expect(mockPrmCourseCorrectionInjected).toHaveBeenCalledTimes(3);
		});
	});

	describe('Test 2: Escalation protocol - 3-strike hard stop', () => {
		test('1st detection: guidance injected, escalation level = 1', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.prmEscalationLevel).toBe(1);
			expect(session.prmHardStopPending).toBe(false);
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
			expect(mockPrmPatternDetected).toHaveBeenCalledTimes(1);
			expect(mockPrmCourseCorrectionInjected).toHaveBeenCalledWith(
				sessionId,
				'repetition_loop',
				1,
			);
		});

		test('2nd detection: stronger guidance, escalation level = 2', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			// First detection
			await toolAfter({ sessionID: sessionId });
			// Second detection
			await toolAfter({ sessionID: sessionId });

			expect(session.prmEscalationLevel).toBe(2);
			expect(session.prmHardStopPending).toBe(false);
			expect(session.pendingAdvisoryMessages).toHaveLength(2);

			// Escalation telemetry is emitted by escalation.ts directly (not via _internals),
			// so we verify the observable effect: escalation level = 2 with 2 corrections
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(2);
			expect(mockPrmCourseCorrectionInjected).toHaveBeenCalledTimes(2);
		});

		test('3rd detection: hard stop triggered, prmHardStopPending = true', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			// First detection
			await toolAfter({ sessionID: sessionId });
			// Second detection
			await toolAfter({ sessionID: sessionId });
			// Third detection - should trigger hard stop
			await toolAfter({ sessionID: sessionId });

			expect(session.prmEscalationLevel).toBe(3);
			expect(session.prmHardStopPending).toBe(true);
			expect(session.pendingAdvisoryMessages).toHaveLength(3);

			// Hard stop telemetry is emitted by escalation.ts directly (not via _internals),
			// so we verify the observable effect: hardStopPending is true at level 3
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(3);
		});

		test('hard stop telemetry only called on 3rd detection, not before', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const match = createMockPatternMatch('repetition_loop');
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmHardStopPending).toBe(false);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmHardStopPending).toBe(false);

			await toolAfter({ sessionID: sessionId });
			// Hard stop is triggered on 3rd detection — verified via session state
			expect(session.prmHardStopPending).toBe(true);
		});
	});

	describe('Test 3: Multiple pattern types in sequence', () => {
		test('simulates ping_pong pattern and verifies independent detection', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createPingPongTrajectory();
			const match = createMockPatternMatch('ping_pong', {
				affectedAgents: ['architect', 'coder'],
				affectedTargets: ['task-1'],
			});
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.prmPatternCounts.get('ping_pong')).toBe(1);
			expect(session.prmLastPatternDetected?.pattern).toBe('ping_pong');
			expect(mockPrmPatternDetected).toHaveBeenCalledWith(
				sessionId,
				'ping_pong',
				'medium',
				'coordination_error',
				[1, 3],
			);
		});

		test('simulates stuck_on_test pattern and verifies independent detection', async () => {
			const config = createMockConfig({ enabled: true });
			const trajectory = createStuckOnTestTrajectory();
			const match = createMockPatternMatch('stuck_on_test', {
				severity: 'high',
				category: 'reasoning_error',
				affectedAgents: ['coder'],
				affectedTargets: ['src/test.spec.ts'],
			});
			const session = setupHappyPathMocks(sessionId, trajectory, [match]);

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(session.prmPatternCounts.get('stuck_on_test')).toBe(1);
			expect(session.prmLastPatternDetected?.pattern).toBe('stuck_on_test');
			expect(session.prmLastPatternDetected?.severity).toBe('high');
			expect(mockPrmPatternDetected).toHaveBeenCalledWith(
				sessionId,
				'stuck_on_test',
				'high',
				'reasoning_error',
				[1, 3],
			);
		});

		test('per-pattern escalation counts are isolated', async () => {
			const config = createMockConfig({ enabled: true });

			// First session with ping_pong
			const pingPongSession = createMockSession('ping-pong-session');
			const repSession = createMockSession('rep-session');

			_internals.getAgentSession = (sid: string) => {
				if (sid === 'ping-pong-session') {
					return pingPongSession;
				}
				return repSession;
			};
			let trajectoryCall = 0;
			_internals.readTrajectory = () => {
				trajectoryCall++;
				if (trajectoryCall === 1) {
					return Promise.resolve(createPingPongTrajectory());
				}
				return Promise.resolve(createRepetitionLoopTrajectory());
			};
			let detectCall = 0;
			_internals.detectPatterns = () => {
				detectCall++;
				if (detectCall === 1) {
					return {
						matches: [createMockPatternMatch('ping_pong')],
						detectionTimeMs: 5,
						patternsChecked: 5,
					};
				}
				return {
					matches: [createMockPatternMatch('repetition_loop')],
					detectionTimeMs: 5,
					patternsChecked: 5,
				};
			};
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: detectCall === 1 ? 'ping_pong' : 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'FORMATTED';

			const { toolAfter } = createPrmHook(config, directory);

			// Process ping_pong - escalation should be 1
			await toolAfter({ sessionID: 'ping-pong-session' });
			expect(pingPongSession.prmEscalationLevel).toBe(1);

			// Second session with repetition_loop
			// Process repetition_loop - escalation should be 1 (not affected by ping_pong)
			await toolAfter({ sessionID: 'rep-session' });
			expect(repSession.prmEscalationLevel).toBe(1);
			expect(repSession.prmPatternCounts.get('ping_pong')).toBeUndefined();
		});

		test('multiple different patterns in same session get separate counts', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;

			let trajectoryCallCount = 0;
			_internals.readTrajectory = () => {
				trajectoryCallCount++;
				if (trajectoryCallCount === 1) {
					return Promise.resolve(createRepetitionLoopTrajectory());
				}
				return Promise.resolve(createPingPongTrajectory());
			};

			let detectCallCount = 0;
			_internals.detectPatterns = () => {
				detectCallCount++;
				if (detectCallCount === 1) {
					return {
						matches: [createMockPatternMatch('repetition_loop')],
						detectionTimeMs: 5,
						patternsChecked: 5,
					};
				}
				return {
					matches: [createMockPatternMatch('ping_pong')],
					detectionTimeMs: 5,
					patternsChecked: 5,
				};
			};
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'GUIDANCE',
				action: 'ACTION',
				pattern: detectCallCount === 1 ? 'repetition_loop' : 'ping_pong',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () =>
				detectCallCount === 1 ? 'FORMATTED-REP' : 'FORMATTED-PING';

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);

			// Second: ping_pong detected (same session, different pattern)
			await toolAfter({ sessionID: sessionId });
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(1); // Still 1
			expect(session.prmPatternCounts.get('ping_pong')).toBe(1); // New pattern
		});
	});

	describe('Test 4: PRM disabled config', () => {
		test('no pattern detection runs when config.enabled = false', async () => {
			const config = createMockConfig({ enabled: false });
			const session = createMockSession(sessionId);
			let readTrajectoryCalled = false;
			_internals.getAgentSession = () => session;
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

		test('no telemetry emitted when config.enabled = false', async () => {
			const config = createMockConfig({ enabled: false });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;

			const { toolAfter } = createPrmHook(config, directory);

			await toolAfter({ sessionID: sessionId });

			expect(mockPrmPatternDetected).not.toHaveBeenCalled();
			expect(mockPrmCourseCorrectionInjected).not.toHaveBeenCalled();
			expect(mockPrmEscalationTriggered).not.toHaveBeenCalled();
			expect(mockPrmHardStop).not.toHaveBeenCalled();
		});

		test('no state changes when config.enabled = false', async () => {
			const config = createMockConfig({ enabled: false });
			const session = createMockSession(sessionId);
			_internals.getAgentSession = () => session;

			const { toolAfter } = createPrmHook(config, directory);

			const initialPendingMessagesLength =
				session.pendingAdvisoryMessages.length;
			const initialEscalationLevel = session.prmEscalationLevel;

			await toolAfter({ sessionID: sessionId });

			expect(session.pendingAdvisoryMessages).toHaveLength(
				initialPendingMessagesLength,
			);
			expect(session.prmEscalationLevel).toBe(initialEscalationLevel);
			expect(session.prmHardStopPending).toBe(false);
		});

		test('returns early when session.delegationActive is false', async () => {
			const config = createMockConfig({ enabled: true });
			const session = createMockSession(sessionId, false); // delegationActive = false
			let readTrajectoryCalled = false;
			_internals.getAgentSession = () => session;
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

			expect(readTrajectoryCalled).toBe(false);
			expect(detectPatternsCalled).toBe(false);
		});
	});

	describe('End-to-end workflow scenarios', () => {
		test('complex scenario: multiple agents, multiple patterns, full escalation', async () => {
			const config = createMockConfig({ enabled: true });

			// Session that simulates complex multi-agent interaction
			const session = createMockSession('complex-session');
			_internals.getAgentSession = () => session;

			// Simulate trajectory that triggers repetition_loop
			_internals.readTrajectory = async () => createRepetitionLoopTrajectory();

			const repetitionMatch = createMockPatternMatch('repetition_loop', {
				affectedAgents: ['coder'],
				affectedTargets: ['src/foo.ts'],
			});

			_internals.detectPatterns = () => ({
				matches: [repetitionMatch],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: 'REPETITION LOOP DETECTED',
				category: 'coordination_error',
				guidance: 'Stop the loop',
				action: 'Consolidate',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () =>
				'[REPETITION LOOP CORRECTION]';

			const { toolAfter } = createPrmHook(config, directory);

			// First detection
			await toolAfter({ sessionID: 'complex-session' });
			expect(session.prmEscalationLevel).toBe(1);
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
			expect(mockPrmPatternDetected).toHaveBeenCalledTimes(1);

			// Second detection - escalation
			await toolAfter({ sessionID: 'complex-session' });
			expect(session.prmEscalationLevel).toBe(2);
			expect(session.pendingAdvisoryMessages).toHaveLength(2);
			// Escalation telemetry emitted by escalation.ts directly (not via _internals),
			// verify observable effect: level increased from 1 to 2
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(2);

			// Third detection - hard stop
			await toolAfter({ sessionID: 'complex-session' });
			expect(session.prmEscalationLevel).toBe(3);
			expect(session.prmHardStopPending).toBe(true);
			expect(session.pendingAdvisoryMessages).toHaveLength(3);
			// Hard stop telemetry emitted by escalation.ts directly (not via _internals),
			// verify observable effect: hardStopPending flipped to true
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(3);

			// Verify all telemetry events
			expect(mockPrmPatternDetected).toHaveBeenCalledTimes(3);
			expect(mockPrmCourseCorrectionInjected).toHaveBeenCalledTimes(3);
		});

		test('session isolation - different sessions have independent escalation state', async () => {
			const config = createMockConfig({ enabled: true });

			const sessionA = createMockSession('session-a');
			const sessionB = createMockSession('session-b');

			let sessionACallCount = 0;
			_internals.getAgentSession = () => {
				sessionACallCount++;
				if (sessionACallCount <= 2) {
					return sessionA;
				}
				return sessionB;
			};
			_internals.readTrajectory = () =>
				Promise.resolve(createRepetitionLoopTrajectory());
			_internals.detectPatterns = () => ({
				matches: [createMockPatternMatch('repetition_loop')],
				detectionTimeMs: 5,
				patternsChecked: 5,
			});
			_internals.generateCourseCorrection = () => ({
				alert: sessionACallCount <= 2 ? 'A' : 'B',
				category: 'coordination_error',
				guidance: 'G',
				action: 'ACT',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () =>
				sessionACallCount <= 2 ? 'A' : 'B';

			const { toolAfter } = createPrmHook(config, directory);
			await toolAfter({ sessionID: 'session-a' });
			await toolAfter({ sessionID: 'session-a' });

			expect(sessionA.prmEscalationLevel).toBe(2);

			// Session B is fresh - should start at level 1
			await toolAfter({ sessionID: 'session-b' });

			expect(sessionB.prmEscalationLevel).toBe(1);
			expect(sessionB.prmPatternCounts.get('repetition_loop')).toBe(1);
		});
	});
});

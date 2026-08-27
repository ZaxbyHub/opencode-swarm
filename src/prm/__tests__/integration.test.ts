import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { _internals, createPrmHook } from '../index';
import type { PatternMatch, TrajectoryEntry } from '../types';
import { createTickingDetectPatterns, episodeAt } from './helpers/episodes';
import {
	createMockConfig,
	createMockPatternMatch,
	createMockSession,
	setupEscalatingRepetitionMocks,
} from './helpers/fixtures';

// Original function references saved once at module load for save/restore
const originalGetAgentSession = _internals.getAgentSession;
const originalReadTrajectoryWithCoverage =
	_internals.readTrajectoryWithCoverage;
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
		_internals.readTrajectoryWithCoverage = originalReadTrajectoryWithCoverage;
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
		_internals.readTrajectoryWithCoverage = originalReadTrajectoryWithCoverage;
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
		_internals.readTrajectoryWithCoverage = async () => ({
			entries: trajectory,
			coverage: 'complete' as const,
			droppedByCompaction: 0,
			skippedMalformed: 0,
		});
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
			_internals.readTrajectoryWithCoverage = async () => ({
				entries: trajectory,
				coverage: 'complete' as const,
				droppedByCompaction: 0,
				skippedMalformed: 0,
			});
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
			// Issue #2134: three real cycles modeled as three distinct,
			// non-overlapping episodes — see helpers/episodes.ts.
			const config = createMockConfig({ enabled: true });
			const trajectory = createRepetitionLoopTrajectory();
			const session = setupEscalatingRepetitionMocks(
				_internals,
				sessionId,
				trajectory,
			);

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

	// Issue #2134: `setupEscalatingRepetitionMocks` (see helpers/fixtures.ts)
	// feeds each tick a distinct, non-overlapping episode — see
	// helpers/episodes.ts. Required for every test below that expects N
	// strikes across N `toolAfter` calls.
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
			const session = setupEscalatingRepetitionMocks(
				_internals,
				sessionId,
				trajectory,
			);

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
			const session = setupEscalatingRepetitionMocks(
				_internals,
				sessionId,
				trajectory,
			);

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
			const session = setupEscalatingRepetitionMocks(
				_internals,
				sessionId,
				trajectory,
			);

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
			_internals.readTrajectoryWithCoverage = () => {
				trajectoryCall++;
				if (trajectoryCall === 1) {
					return Promise.resolve({
						entries: createPingPongTrajectory(),
						coverage: 'complete' as const,
						droppedByCompaction: 0,
						skippedMalformed: 0,
					});
				}
				return Promise.resolve({
					entries: createRepetitionLoopTrajectory(),
					coverage: 'complete' as const,
					droppedByCompaction: 0,
					skippedMalformed: 0,
				});
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
			_internals.readTrajectoryWithCoverage = () => {
				trajectoryCallCount++;
				if (trajectoryCallCount === 1) {
					return Promise.resolve({
						entries: createRepetitionLoopTrajectory(),
						coverage: 'complete' as const,
						droppedByCompaction: 0,
						skippedMalformed: 0,
					});
				}
				return Promise.resolve({
					entries: createPingPongTrajectory(),
					coverage: 'complete' as const,
					droppedByCompaction: 0,
					skippedMalformed: 0,
				});
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
			_internals.readTrajectoryWithCoverage = async () => {
				readTrajectoryCalled = true;
				return {
					entries: [],
					coverage: 'complete' as const,
					droppedByCompaction: 0,
					skippedMalformed: 0,
				};
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
			_internals.readTrajectoryWithCoverage = async () => {
				readTrajectoryCalled = true;
				return {
					entries: [],
					coverage: 'complete' as const,
					droppedByCompaction: 0,
					skippedMalformed: 0,
				};
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
			_internals.readTrajectoryWithCoverage = async () => ({
				entries: createRepetitionLoopTrajectory(),
				coverage: 'complete' as const,
				droppedByCompaction: 0,
				skippedMalformed: 0,
			});

			// Issue #2134: distinct, non-overlapping episodes per tick — see
			// helpers/episodes.ts.
			_internals.detectPatterns = createTickingDetectPatterns((overrides) =>
				createMockPatternMatch('repetition_loop', {
					affectedAgents: ['coder'],
					affectedTargets: ['src/foo.ts'],
					...overrides,
				}),
			);
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

		test('issue #1976 B1: same pattern@level is not re-injected across turns after the drain clears', async () => {
			// The pushAdvisory helper only dedupes WITHIN a turn (the drain clears
			// pendingAdvisoryMessages each turn). prmInjectedAdvisoryKeys is the
			// cross-turn suppressor: once a (pattern, level) advisory is delivered,
			// re-detection at the SAME level on a later tool call does not re-inject
			// (escalation counting/telemetry still run). Escalation to a new level
			// (distinct key) still injects.
			//
			// Issue #2134: distinct, non-overlapping episodes per tick (see
			// helpers/episodes.ts) so both strikes clear the episode gate.
			// Escalation is disabled so the level stays 0 across both strikes,
			// which is the condition this test exercises: the cross-turn
			// ADVISORY dedupe (same pattern@level) suppressing re-injection even
			// though the underlying episode gate allowed the second strike through.
			const config = createMockConfig({
				enabled: true,
				escalation_enabled: false, // hold level at 0 so the key stays constant
			});
			const session = createMockSession('b1-cross-turn');
			_internals.getAgentSession = () => session;
			_internals.readTrajectoryWithCoverage = async () => ({
				entries: createRepetitionLoopTrajectory(),
				coverage: 'complete' as const,
				droppedByCompaction: 0,
				skippedMalformed: 0,
			});
			_internals.detectPatterns = createTickingDetectPatterns((overrides) =>
				createMockPatternMatch('repetition_loop', overrides),
			);
			_internals.generateCourseCorrection = () => ({
				alert: 'ALERT',
				category: 'coordination_error',
				guidance: 'g',
				action: 'a',
				pattern: 'repetition_loop',
				stepRange: [1, 3],
			});
			_internals.formatCourseCorrectionForInjection = () => 'CORRECTION';

			const { toolAfter } = createPrmHook(config, directory);

			// Turn 1: first detection at level 0 → injects once.
			await toolAfter({ sessionID: 'b1-cross-turn' });
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
			// Pattern counting still ran (unconditional).
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);

			// Simulate the drain clearing the queue between turns.
			session.pendingAdvisoryMessages = [];

			// Turn 2: same pattern, same level 0 → must NOT re-inject (cross-turn
			// dedupe), but counting must still advance.
			await toolAfter({ sessionID: 'b1-cross-turn' });
			expect(session.pendingAdvisoryMessages).toHaveLength(0);
			expect(session.prmPatternCounts.get('repetition_loop')).toBe(2);
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
			_internals.readTrajectoryWithCoverage = () =>
				Promise.resolve({
					entries: createRepetitionLoopTrajectory(),
					coverage: 'complete' as const,
					droppedByCompaction: 0,
					skippedMalformed: 0,
				});
			// Issue #2134: `sessionACallCount` doubles as a monotonic tick, so
			// episodeAt() keeps sessionA's two episodes distinct (see
			// helpers/episodes.ts) without affecting sessionB's fresh ledger.
			_internals.detectPatterns = () => ({
				matches: [
					createMockPatternMatch('repetition_loop', {
						stepRange: episodeAt(sessionACallCount),
					}),
				],
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

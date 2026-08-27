import type { _internals } from '../../index';
import type { PatternMatch, PrmConfig, TrajectoryEntry } from '../../types';
import { createTickingDetectPatterns } from './episodes';

/**
 * Shared PRM test fixtures used by both `index.test.ts` and
 * `integration.test.ts`. Identical/near-identical mock builders that used to
 * be duplicated in each file live here — a non-test module does not count
 * toward the FR-006 500-line test-file cap (`scripts/check-test-file-cap.ts`
 * only matches `*.test.ts`).
 */

/**
 * One-line coverage wrapper for `readTrajectoryWithCoverage` mocks: the
 * complete-window verdict for a fixture trajectory. Exists so migrating the
 * old `readTrajectory` mocks to the coverage seam does not grow the
 * over-cap (FR-006 ratchet) test files.
 */
export function covOf(entries: TrajectoryEntry[]): {
	entries: TrajectoryEntry[];
	coverage: 'complete';
	droppedByCompaction: 0;
	skippedMalformed: 0;
} {
	return {
		entries,
		coverage: 'complete',
		droppedByCompaction: 0,
		skippedMalformed: 0,
	};
}

export function createMockConfig(
	overrides: Partial<PrmConfig> = {},
): PrmConfig {
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

export function createMockPatternMatch(
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
 * Full mock `AgentSession` shape (superset of every field either test file
 * needs). Extra fields beyond what a given test asserts on are harmless —
 * no test in either file does a deep-equality check of the whole session
 * object, only of specific PRM fields.
 */
export function createMockSession(sessionId: string, delegationActive = true) {
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
		pendingAdvisoryMessages: [] as string[],
		sessionRehydratedAt: 0,
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set<string>(),
		lastCompletedPhaseAgentsDispatched: new Set<string>(),
		// PRM fields
		prmPatternCounts: new Map<string, number>(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null as PatternMatch | null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		prmEscalationTracker: undefined,
	};
}

/**
 * Issue #2134 escalation-ladder tests (`integration.test.ts`) drive the same
 * "distinct, non-overlapping episode per tick + fixed repetition_loop
 * course-correction" mock setup from two different `describe` blocks that
 * cannot see each other's local functions. Centralizing it here also lets
 * both call sites share one definition instead of two byte-identical
 * inline copies. `internals` is threaded in as a parameter (rather than
 * imported directly) so this stays a pure builder with no coupling to the
 * `_internals` singleton.
 */
export function setupEscalatingRepetitionMocks(
	internals: typeof _internals,
	sessId: string,
	trajectory: TrajectoryEntry[],
) {
	const session = createMockSession(sessId);
	internals.getAgentSession = () => session;
	internals.readTrajectory = async () => trajectory;
	internals.detectPatterns = createTickingDetectPatterns((overrides) =>
		createMockPatternMatch('repetition_loop', overrides),
	);
	internals.generateCourseCorrection = () => ({
		alert: 'TRAJECTORY ALERT: repetition_loop detected',
		category: 'coordination_error',
		guidance: 'Stop the repetitive loop',
		action: 'Consolidate changes and change approach immediately.',
		pattern: 'repetition_loop',
		stepRange: [1, 3],
	});
	internals.formatCourseCorrectionForInjection = (correction) => {
		return `[TRAJECTORY ALERT] ${correction.alert}\n[CATEGORY] ${correction.category}\n[GUIDANCE] ${correction.guidance}\n[ACTION] ${correction.action}`;
	};
	return session;
}

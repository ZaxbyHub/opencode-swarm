/**
 * Verification tests for stageBCompletion serialization round-trip.
 * Tests src/session/snapshot-writer.ts serializeAgentSession and
 * src/session/snapshot-reader.ts deserializeAgentSession.
 */

import { describe, expect, it } from 'bun:test';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import type { SerializedAgentSession } from '../../../src/session/snapshot-writer';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import type { AgentSessionState } from '../../../src/state';

/**
 * Minimal AgentSessionState factory for round-trip tests.
 * Only stageBCompletion is varied; all other fields use safe defaults.
 */
function makeMinimalSession(
	overrides: Partial<AgentSessionState> = {},
): AgentSessionState {
	return {
		agentName: 'architect',
		lastToolCallTime: 123456,
		lastAgentEventTime: 123456,
		delegationActive: false,
		activeInvocationId: 1,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		pendingAdvisoryMessages: [],
		taskWorkflowStates: new Map(),
		scopeViolationDetected: false,
		modifiedFilesThisCoderTask: [],
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		coderRevisions: 0,
		revisionLimitHit: false,
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		sessionRehydratedAt: 0,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		stageBCompletion: new Map(),
		...overrides,
	};
}

/**
 * Minimal SerializedAgentSession factory for backward-compat tests.
 */
function makeMinimalSerialized(
	overrides: Partial<SerializedAgentSession> = {},
): SerializedAgentSession {
	return {
		agentName: 'architect',
		lastToolCallTime: 123456,
		lastAgentEventTime: 123456,
		delegationActive: false,
		activeInvocationId: 1,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		turboMode: false,
		gateLog: {},
		reviewerCallCount: {},
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: [],
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: [],
		lastCompletedPhaseAgentsDispatched: [],
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		pendingAdvisoryMessages: [],
		taskWorkflowStates: {},
		scopeViolationDetected: false,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		coderRevisions: 0,
		revisionLimitHit: false,
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		sessionRehydratedAt: 0,
		...overrides,
	};
}

describe('stageBCompletion round-trip', () => {
	it('round-trips with data: multiple tasks and multiple agents per task', () => {
		// Arrange: AgentSessionState with stageBCompletion having entries for multiple tasks
		const original: AgentSessionState = makeMinimalSession({
			stageBCompletion: new Map([
				['1.1', new Set(['reviewer', 'test_engineer'] as const)],
				['2.3', new Set(['reviewer'] as const)],
			]),
		});

		// Act: serialize → deserialize
		const serialized = serializeAgentSession(original);
		const deserialized = deserializeAgentSession(
			serialized as SerializedAgentSession,
		);

		// Assert: Map matches original
		expect(deserialized.stageBCompletion).toBeInstanceOf(Map);
		expect(deserialized.stageBCompletion!.get('1.1')).toEqual(
			new Set(['reviewer', 'test_engineer']),
		);
		expect(deserialized.stageBCompletion!.get('2.3')).toEqual(
			new Set(['reviewer']),
		);
	});

	it('round-trip empty: empty Map is omitted from serialized output', () => {
		// Arrange: AgentSessionState with empty stageBCompletion Map
		const original: AgentSessionState = makeMinimalSession({
			stageBCompletion: new Map(),
		});

		// Act
		const serialized = serializeAgentSession(original);
		const deserialized = deserializeAgentSession(
			serialized as SerializedAgentSession,
		);

		// Assert: serialized output does NOT include stageBCompletion field (conditional spread)
		expect(serialized).not.toHaveProperty('stageBCompletion');

		// Assert: deserialized is empty Map (not undefined, not null)
		expect(deserialized.stageBCompletion).toBeInstanceOf(Map);
		expect(deserialized.stageBCompletion!.size).toBe(0);
	});

	it('old snapshot compat: SerializedAgentSession WITHOUT stageBCompletion deserializes to empty Map', () => {
		// Arrange: SerializedAgentSession without stageBCompletion field (old snapshot)
		const oldSnapshot = makeMinimalSerialized({
			// stageBCompletion is intentionally omitted
		});

		// Act
		const deserialized = deserializeAgentSession(oldSnapshot);

		// Assert: stageBCompletion is an empty Map (not undefined, not null)
		expect(deserialized.stageBCompletion).toBeInstanceOf(Map);
		expect(deserialized.stageBCompletion).not.toBeUndefined();
		expect(deserialized.stageBCompletion!.size).toBe(0);
	});

	it('round-trips single agent completion: only reviewer completed', () => {
		// Arrange
		const original: AgentSessionState = makeMinimalSession({
			stageBCompletion: new Map([['1.1', new Set(['reviewer'] as const)]]),
		});

		// Act: serialize → deserialize
		const serialized = serializeAgentSession(original);
		const deserialized = deserializeAgentSession(
			serialized as SerializedAgentSession,
		);

		// Assert
		expect(deserialized.stageBCompletion).toBeInstanceOf(Map);
		expect(deserialized.stageBCompletion!.get('1.1')).toEqual(
			new Set(['reviewer']),
		);
	});

	it('serialize produces Record<string, string[]> with correct values', () => {
		// Arrange
		const original: AgentSessionState = makeMinimalSession({
			stageBCompletion: new Map([
				['1.1', new Set(['reviewer', 'test_engineer'] as const)],
				['2.3', new Set(['test_engineer'] as const)],
			]),
		});

		// Act
		const serialized = serializeAgentSession(original);

		// Assert
		expect(serialized.stageBCompletion).toEqual({
			'1.1': ['reviewer', 'test_engineer'],
			'2.3': ['test_engineer'],
		});
	});

	it('round-trips stageBCompletion with empty agents set for a task', () => {
		// Arrange: task exists in stageBCompletion but no agents completed yet
		const original = makeMinimalSession({
			stageBCompletion: new Map([['3.1', new Set<string>()]]),
		});

		// Act
		const serialized = serializeAgentSession(original);
		const deserialized = deserializeAgentSession(
			serialized as SerializedAgentSession,
		);

		// Assert: key preserved with empty set
		expect(deserialized.stageBCompletion).toBeInstanceOf(Map);
		expect(deserialized.stageBCompletion!.has('3.1')).toBe(true);
		expect(deserialized.stageBCompletion!.get('3.1')!.size).toBe(0);
	});

	it('round-trips stageBCompletion with test_engineer-only completion', () => {
		// Arrange
		const original = makeMinimalSession({
			stageBCompletion: new Map([['2.1', new Set(['test_engineer'] as const)]]),
		});

		// Act
		const serialized = serializeAgentSession(original);
		const deserialized = deserializeAgentSession(
			serialized as SerializedAgentSession,
		);

		// Assert
		expect(deserialized.stageBCompletion).toBeInstanceOf(Map);
		expect(deserialized.stageBCompletion!.get('2.1')).toEqual(
			new Set(['test_engineer']),
		);
	});
});

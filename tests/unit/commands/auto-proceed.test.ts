/**
 * Tests for handleAutoProceedCommand function.
 * Covers:
 * - "on" sets autoProceedOverride=true
 * - "off" sets autoProceedOverride=false
 * - toggle (no args): false/undefined -> true, true -> false
 * - Invalid argument returns error message
 * - Empty/blank sessionID returns error
 * - Session not found returns error
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { handleAutoProceedCommand } from '../../../src/commands/auto-proceed';
import { getAgentSession, swarmState } from '../../../src/state';

function createTestSession(
	sessionId: string,
	overrides?: { autoProceedOverride?: boolean; agentName?: string },
): void {
	swarmState.agentSessions.set(sessionId, {
		agentName: overrides?.agentName ?? 'architect',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive: false,
		activeInvocationId: 0,
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
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		modifiedFilesThisCoderTask: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		turboMode: false,
		fullAutoMode: false,
		fullAutoInteractionCount: 0,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: null,
		coderRevisions: 0,
		revisionLimitHit: false,
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		sessionRehydratedAt: 0,
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		maxConcurrencyOverride: undefined,
		autoProceedOverride: overrides?.autoProceedOverride,
		autoProceedNudgeDone: false,
	});
}

const TEST_SESSION_ID = 'test-session-auto-proceed';

beforeEach(() => {
	swarmState.agentSessions.clear();
	createTestSession(TEST_SESSION_ID);
});

afterEach(() => {
	swarmState.agentSessions.clear();
});

describe('handleAutoProceedCommand', () => {
	describe('"on" argument', () => {
		test('sets autoProceedOverride to true', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
		});

		test('overwrites existing false value', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: false });
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
		});
	});

	describe('"off" argument', () => {
		test('sets autoProceedOverride to false', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: true });
			const result = await handleAutoProceedCommand(
				'/fake',
				['off'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now OFF');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(false);
		});

		test('overwrites existing true value', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: true });
			const result = await handleAutoProceedCommand(
				'/fake',
				['off'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now OFF');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(false);
		});
	});

	describe('toggle (no args)', () => {
		test('toggles undefined to true', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: undefined });
			const result = await handleAutoProceedCommand(
				'/fake',
				[],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
		});

		test('toggles false to true', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: false });
			const result = await handleAutoProceedCommand(
				'/fake',
				[],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
		});

		test('toggles true to false', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: true });
			const result = await handleAutoProceedCommand(
				'/fake',
				[],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now OFF');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(false);
		});
	});

	describe('invalid arguments', () => {
		test('returns error for invalid string argument', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['yesplease'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('Error');
			expect(result).toContain('Invalid argument');
		});

		test('case-insensitive: "ON" is accepted', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['ON'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
		});

		test('case-insensitive: "OFF" is accepted', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['OFF'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now OFF');
		});

		test('case-insensitive: "On" is accepted', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['On'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
		});
	});

	describe('session validation', () => {
		test('returns error for empty sessionID', async () => {
			const result = await handleAutoProceedCommand('/fake', ['on'], '');
			expect(result).toContain('Error');
			expect(result).toContain('No active session');
		});

		test('returns error for blank sessionID', async () => {
			const result = await handleAutoProceedCommand('/fake', ['on'], '   ');
			expect(result).toContain('Error');
			expect(result).toContain('No active session');
		});

		test('returns error for unknown sessionID', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				'unknown-session',
			);
			expect(result).toContain('Error');
			expect(result).toContain('No active session');
		});
	});

	// -------------------------------------------------------------------------
	// Architect-only enforcement
	// -------------------------------------------------------------------------
	describe('architect-only enforcement', () => {
		test('rejects non-architect session with error message', async () => {
			createTestSession(TEST_SESSION_ID, { agentName: 'coder' });
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('Error');
			expect(result).toContain(
				'Auto-proceed can only be toggled from the architect session',
			);
			// State must not have changed
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBeUndefined();
		});

		test('accepts architect session (unprefixed)', async () => {
			createTestSession(TEST_SESSION_ID, { agentName: 'architect' });
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
		});

		test('accepts prefixed architect session (lowtier_architect)', async () => {
			createTestSession(TEST_SESSION_ID, { agentName: 'lowtier_architect' });
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
		});

		test('rejects reviewer session with error', async () => {
			createTestSession(TEST_SESSION_ID, { agentName: 'reviewer' });
			const result = await handleAutoProceedCommand(
				'/fake',
				['off'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('Error');
			expect(result).toContain('architect');
		});

		test('non-architect session with "on": returns error, does NOT set anything', async () => {
			createTestSession(TEST_SESSION_ID, { agentName: 'coder' });
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('Error');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBeUndefined();
			expect(session?.autoProceedNudgeDone).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// autoProceedNudgeDone semantics
	// -------------------------------------------------------------------------
	describe('"on" sets autoProceedNudgeDone=true alongside override', () => {
		test('"on": sets BOTH autoProceedOverride=true AND autoProceedNudgeDone=true', async () => {
			const result = await handleAutoProceedCommand(
				'/fake',
				['on'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
			expect(session?.autoProceedNudgeDone).toBe(true);
		});

		test('"on" from non-architect: does NOT set nudgeDone (returns error first)', async () => {
			createTestSession(TEST_SESSION_ID, { agentName: 'coder' });
			await handleAutoProceedCommand('/fake', ['on'], TEST_SESSION_ID);
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedNudgeDone).toBe(false);
		});
	});

	describe('"off" sets autoProceedNudgeDone=true alongside override', () => {
		test('"off": sets BOTH autoProceedOverride=false AND autoProceedNudgeDone=true', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: true });
			const result = await handleAutoProceedCommand(
				'/fake',
				['off'],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now OFF');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(false);
			expect(session?.autoProceedNudgeDone).toBe(true);
		});
	});

	describe('toggle nudgeDone semantics', () => {
		test('toggle from undefined: sets BOTH override (true) AND nudgeDone (true)', async () => {
			createTestSession(TEST_SESSION_ID, { autoProceedOverride: undefined });
			const result = await handleAutoProceedCommand(
				'/fake',
				[],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now ON');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(true);
			expect(session?.autoProceedNudgeDone).toBe(true);
		});

		test('toggle from existing true value: sets ONLY override (false), NOT nudgeDone', async () => {
			// Pre-set nudgeDone to false to prove it does NOT get flipped to true on re-toggle
			swarmState.agentSessions.set(TEST_SESSION_ID, {
				agentName: 'architect',
				lastToolCallTime: Date.now(),
				lastAgentEventTime: Date.now(),
				delegationActive: false,
				activeInvocationId: 0,
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
				qaSkipCount: 0,
				qaSkipTaskIds: [],
				taskWorkflowStates: new Map(),
				lastGateOutcome: null,
				declaredCoderScope: null,
				lastScopeViolation: null,
				modifiedFilesThisCoderTask: [],
				lastPhaseCompleteTimestamp: 0,
				lastPhaseCompletePhase: 0,
				phaseAgentsDispatched: new Set(),
				lastCompletedPhaseAgentsDispatched: new Set(),
				turboMode: false,
				fullAutoMode: false,
				fullAutoInteractionCount: 0,
				fullAutoDeadlockCount: 0,
				fullAutoLastQuestionHash: null,
				coderRevisions: 0,
				revisionLimitHit: false,
				model_fallback_index: 0,
				modelFallbackExhausted: false,
				sessionRehydratedAt: 0,
				prmPatternCounts: new Map(),
				prmEscalationLevel: 0,
				prmLastPatternDetected: null,
				prmTrajectoryStep: 0,
				prmHardStopPending: false,
				maxConcurrencyOverride: undefined,
				autoProceedOverride: true,
				autoProceedNudgeDone: false, // already set — must NOT be overwritten on re-toggle
			});
			const result = await handleAutoProceedCommand(
				'/fake',
				[],
				TEST_SESSION_ID,
			);
			expect(result).toContain('now OFF');
			const session = getAgentSession(TEST_SESSION_ID);
			expect(session?.autoProceedOverride).toBe(false);
			expect(session?.autoProceedNudgeDone).toBe(false); // NOT set to true — already true was already set
		});
	});
});

/**
 * Tests for auto_proceed session state fields added in Phase 1.
 *
 * Covers:
 * - autoProceedOverride?: boolean  — session-scoped override for execution_profile.auto_proceed
 * - autoProceedNudgeDone?: boolean — tracks whether the FR-004 nudge has been shown this session
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
	deserializeAgentSession,
	rehydrateState,
} from '../../../src/session/snapshot-reader';
import type {
	SerializedAgentSession,
	SnapshotData,
} from '../../../src/session/snapshot-writer';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import type { AgentSessionState } from '../../../src/state';
import {
	ensureAgentSession,
	getAgentSession,
	getResolvedAutoProceed,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

describe('auto_proceed session state fields', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// Field presence: fields exist on AgentSessionState interface
	// -------------------------------------------------------------------------
	describe('AgentSessionState interface has the new fields', () => {
		test('autoProceedOverride is a valid AgentSessionState field', () => {
			// Create a session and verify the field can be assigned
			const session = ensureAgentSession('auto-proceed-field-test');
			// TypeScript would catch this at compile time if the field didn't exist
			session.autoProceedOverride = true;
			expect(session.autoProceedOverride).toBe(true);
		});

		test('autoProceedNudgeDone is a valid AgentSessionState field', () => {
			const session = ensureAgentSession('auto-proceed-nudge-test');
			session.autoProceedNudgeDone = true;
			expect(session.autoProceedNudgeDone).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Fresh session: fields are undefined on new sessions from ensureAgentSession
	// -------------------------------------------------------------------------
	describe('fresh sessions have undefined auto_proceed fields', () => {
		test('autoProceedOverride is undefined on a fresh session', () => {
			const session = ensureAgentSession('fresh-auto-proceed-override');
			expect(session.autoProceedOverride).toBeUndefined();
		});

		test('autoProceedNudgeDone is undefined on a fresh session', () => {
			const session = ensureAgentSession('fresh-auto-proceed-nudge');
			expect(session.autoProceedNudgeDone).toBeUndefined();
		});

		test('both fields are undefined on the same fresh session', () => {
			const session = ensureAgentSession('fresh-both-fields');
			expect(session.autoProceedOverride).toBeUndefined();
			expect(session.autoProceedNudgeDone).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Fields can be set and read
	// -------------------------------------------------------------------------
	describe('fields can be set and read', () => {
		test('autoProceedOverride can be set to true', () => {
			const session = ensureAgentSession('set-override-true');
			session.autoProceedOverride = true;
			expect(session.autoProceedOverride).toBe(true);
		});

		test('autoProceedOverride can be set to false', () => {
			const session = ensureAgentSession('set-override-false');
			session.autoProceedOverride = false;
			expect(session.autoProceedOverride).toBe(false);
		});

		test('autoProceedNudgeDone can be set to true', () => {
			const session = ensureAgentSession('set-nudge-true');
			session.autoProceedNudgeDone = true;
			expect(session.autoProceedNudgeDone).toBe(true);
		});

		test('autoProceedNudgeDone can be set to false', () => {
			const session = ensureAgentSession('set-nudge-false');
			session.autoProceedNudgeDone = false;
			expect(session.autoProceedNudgeDone).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// Fields survive session operations (remain set on subsequent ensureAgentSession calls)
	// -------------------------------------------------------------------------
	describe('fields survive subsequent ensureAgentSession calls', () => {
		test('autoProceedOverride persists after re-ensuring the same session', () => {
			const session1 = ensureAgentSession('persist-override');
			session1.autoProceedOverride = true;

			// Re-ensure the same session (should return existing session, not create new)
			const session2 = ensureAgentSession('persist-override');
			expect(session2).toBe(session1);
			expect(session2.autoProceedOverride).toBe(true);
		});

		test('autoProceedNudgeDone persists after re-ensuring the same session', () => {
			const session1 = ensureAgentSession('persist-nudge');
			session1.autoProceedNudgeDone = true;

			const session2 = ensureAgentSession('persist-nudge');
			expect(session2).toBe(session1);
			expect(session2.autoProceedNudgeDone).toBe(true);
		});

		test('both fields persist together across re-ensure', () => {
			const session1 = ensureAgentSession('persist-both');
			session1.autoProceedOverride = true;
			session1.autoProceedNudgeDone = true;

			const session2 = ensureAgentSession('persist-both');
			expect(session2.autoProceedOverride).toBe(true);
			expect(session2.autoProceedNudgeDone).toBe(true);
		});

		test('overriding autoProceedOverride to false is readable', () => {
			const session1 = ensureAgentSession('override-false-test');
			session1.autoProceedOverride = true;
			session1.autoProceedOverride = false;

			const session2 = ensureAgentSession('override-false-test');
			expect(session2.autoProceedOverride).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// Reset clears sessions (which removes auto_proceed state)
	// -------------------------------------------------------------------------
	describe('resetSwarmState clears auto_proceed session state', () => {
		test('autoProceedOverride is gone after resetSwarmState', () => {
			const session1 = ensureAgentSession('reset-override');
			session1.autoProceedOverride = true;

			resetSwarmState();

			// After reset, a new session is created (old one is gone)
			const session2 = ensureAgentSession('reset-override');
			expect(session2.autoProceedOverride).toBeUndefined();
		});

		test('autoProceedNudgeDone is gone after resetSwarmState', () => {
			const session1 = ensureAgentSession('reset-nudge');
			session1.autoProceedNudgeDone = true;

			resetSwarmState();

			const session2 = ensureAgentSession('reset-nudge');
			expect(session2.autoProceedNudgeDone).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// Type-level: round-trip through getAgentSession
	// -------------------------------------------------------------------------
	describe('round-trip through getAgentSession', () => {
		test('set via ensureAgentSession, read via getAgentSession', () => {
			const session = ensureAgentSession('round-trip');
			session.autoProceedOverride = true;
			session.autoProceedNudgeDone = true;

			const retrieved = getAgentSession('round-trip');
			expect(retrieved).toBeDefined();
			expect(retrieved!.autoProceedOverride).toBe(true);
			expect(retrieved!.autoProceedNudgeDone).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Snapshot round-trip: serializeAgentSession → deserializeAgentSession
	// -------------------------------------------------------------------------
	/**
	 * Minimal AgentSessionState factory for snapshot round-trip tests.
	 * Only autoProceedOverride / autoProceedNudgeDone are varied;
	 * all other fields use safe defaults to keep the test surface small.
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
			turboMode: false,
			...overrides,
		};
	}

	describe('snapshot round-trip: autoProceedOverride', () => {
		test('undefined autoProceedOverride round-trips as undefined', () => {
			const original = makeMinimalSession({ autoProceedOverride: undefined });
			const serialized = serializeAgentSession(original);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBeUndefined();
		});

		test('autoProceedOverride=true round-trips as true', () => {
			const original = makeMinimalSession({ autoProceedOverride: true });
			const serialized = serializeAgentSession(original);
			expect(serialized).toHaveProperty('autoProceedOverride');
			expect((serialized as SerializedAgentSession).autoProceedOverride).toBe(
				true,
			);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBe(true);
		});

		test('autoProceedOverride=false round-trips as false', () => {
			const original = makeMinimalSession({ autoProceedOverride: false });
			const serialized = serializeAgentSession(original);
			expect(serialized).toHaveProperty('autoProceedOverride');
			expect((serialized as SerializedAgentSession).autoProceedOverride).toBe(
				false,
			);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBe(false);
		});
	});

	describe('snapshot round-trip: autoProceedNudgeDone', () => {
		test('undefined autoProceedNudgeDone round-trips as undefined', () => {
			const original = makeMinimalSession({ autoProceedNudgeDone: undefined });
			const serialized = serializeAgentSession(original);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedNudgeDone).toBeUndefined();
		});

		test('autoProceedNudgeDone=true round-trips as true', () => {
			const original = makeMinimalSession({ autoProceedNudgeDone: true });
			const serialized = serializeAgentSession(original);
			expect(serialized).toHaveProperty('autoProceedNudgeDone');
			expect((serialized as SerializedAgentSession).autoProceedNudgeDone).toBe(
				true,
			);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedNudgeDone).toBe(true);
		});

		test('autoProceedNudgeDone=false round-trips as false', () => {
			const original = makeMinimalSession({ autoProceedNudgeDone: false });
			const serialized = serializeAgentSession(original);
			expect(serialized).toHaveProperty('autoProceedNudgeDone');
			expect((serialized as SerializedAgentSession).autoProceedNudgeDone).toBe(
				false,
			);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedNudgeDone).toBe(false);
		});
	});

	describe('snapshot round-trip: both fields together', () => {
		test('both undefined round-trips as undefined', () => {
			const original = makeMinimalSession({
				autoProceedOverride: undefined,
				autoProceedNudgeDone: undefined,
			});
			const serialized = serializeAgentSession(original);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBeUndefined();
			expect(deserialized.autoProceedNudgeDone).toBeUndefined();
		});

		test('both true round-trips as true', () => {
			const original = makeMinimalSession({
				autoProceedOverride: true,
				autoProceedNudgeDone: true,
			});
			const serialized = serializeAgentSession(original);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBe(true);
			expect(deserialized.autoProceedNudgeDone).toBe(true);
		});

		test('both false round-trips as false', () => {
			const original = makeMinimalSession({
				autoProceedOverride: false,
				autoProceedNudgeDone: false,
			});
			const serialized = serializeAgentSession(original);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBe(false);
			expect(deserialized.autoProceedNudgeDone).toBe(false);
		});

		test('mixed values (override=true, nudgeDone=false) round-trip correctly', () => {
			const original = makeMinimalSession({
				autoProceedOverride: true,
				autoProceedNudgeDone: false,
			});
			const serialized = serializeAgentSession(original);
			const deserialized = deserializeAgentSession(
				serialized as SerializedAgentSession,
			);
			expect(deserialized.autoProceedOverride).toBe(true);
			expect(deserialized.autoProceedNudgeDone).toBe(false);
		});
	});
});

describe('getResolvedAutoProceed — session override wins over plan default', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	test('case 1: override=true, plan=false → returns true (session wins)', () => {
		const session = ensureAgentSession('case-1');
		session.autoProceedOverride = true;
		expect(getResolvedAutoProceed(session, false)).toBe(true);
	});

	test('case 2: override=false, plan=true → returns false (session wins)', () => {
		const session = ensureAgentSession('case-2');
		session.autoProceedOverride = false;
		expect(getResolvedAutoProceed(session, true)).toBe(false);
	});

	test('case 3: override=undefined, plan=true → returns true (plan default)', () => {
		const session = ensureAgentSession('case-3');
		// autoProceedOverride is undefined on fresh session
		expect(session.autoProceedOverride).toBeUndefined();
		expect(getResolvedAutoProceed(session, true)).toBe(true);
	});

	test('case 4: override=undefined, plan=false → returns false (plan default)', () => {
		const session = ensureAgentSession('case-4');
		expect(session.autoProceedOverride).toBeUndefined();
		expect(getResolvedAutoProceed(session, false)).toBe(false);
	});

	test('case 5: both true → returns true', () => {
		const session = ensureAgentSession('case-5');
		session.autoProceedOverride = true;
		expect(getResolvedAutoProceed(session, true)).toBe(true);
	});

	test('case 6: both false → returns false', () => {
		const session = ensureAgentSession('case-6');
		session.autoProceedOverride = false;
		expect(getResolvedAutoProceed(session, false)).toBe(false);
	});

	test('case 7: override=undefined, plan=undefined (plan defaults to false in practice)', () => {
		const session = ensureAgentSession('case-7');
		expect(session.autoProceedOverride).toBeUndefined();
		// Pass false as plan default (the practical default)
		expect(getResolvedAutoProceed(session, false)).toBe(false);
	});
});

// -------------------------------------------------------------------------
// Snapshot rehydration (TRANSIENT_SESSION_FIELDS reset)
// -------------------------------------------------------------------------
describe('snapshot rehydration resets auto_proceed transient fields to undefined', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	test('rehydrateState resets autoProceedOverride to undefined even if snapshot had true', async () => {
		const snapshot: SnapshotData = {
			version: 2,
			schema_version: '1.0.0',
			title: 'Transient Reset Test',
			swarm: 'test',
			phases: [],
			agentSessions: {
				'transient-reset-test': {
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
					prmPatternCounts: {},
					prmEscalationLevel: 0,
					prmLastPatternDetected: null,
					prmTrajectoryStep: 0,
					prmHardStopPending: false,
					stageBCompletion: {},
					turboMode: false,
					autoProceedOverride: true, // transient — should be reset
					autoProceedNudgeDone: true, // transient — should be reset
				} as SerializedAgentSession,
			},
		};

		await rehydrateState(snapshot);

		const session = swarmState.agentSessions.get('transient-reset-test');
		expect(session).toBeDefined();
		expect(session!.autoProceedOverride).toBeUndefined();
		expect(session!.autoProceedNudgeDone).toBeUndefined();
	});

	test('rehydrateState resets autoProceedOverride=false to undefined', async () => {
		const snapshot: SnapshotData = {
			version: 2,
			schema_version: '1.0.0',
			title: 'Transient Reset False Test',
			swarm: 'test',
			phases: [],
			agentSessions: {
				'transient-reset-false-test': {
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
					prmPatternCounts: {},
					prmEscalationLevel: 0,
					prmLastPatternDetected: null,
					prmTrajectoryStep: 0,
					prmHardStopPending: false,
					stageBCompletion: {},
					turboMode: false,
					autoProceedOverride: false, // transient — should be reset
					autoProceedNudgeDone: false, // transient — should be reset
				} as SerializedAgentSession,
			},
		};

		await rehydrateState(snapshot);

		const session = swarmState.agentSessions.get('transient-reset-false-test');
		expect(session).toBeDefined();
		expect(session!.autoProceedOverride).toBeUndefined();
		expect(session!.autoProceedNudgeDone).toBeUndefined();
	});
});

/**
 * Runtime half of the snapshot-field parity guard (issue #2472 W6 / AC-7).
 *
 * The compile-time half lives in src/session/snapshot-writer.ts
 * (`SESSION_TRANSIENT_FIELDS` + the `_serializedFieldsExistOnState` reverse
 * assertion): `tsc --noEmit` fails when an AgentSessionState field is neither
 * serialized nor carried in the map, or when a SerializedAgentSession field
 * has no state counterpart. This file pins the SAME contract at runtime so
 * `bun test` alone (which does not typecheck) still catches drift:
 *
 *  1. every SESSION_TRANSIENT_FIELDS key is absent from a real
 *     serializeAgentSession sample;
 *  2. the map's key set is EXACTLY the unserialized set derived at runtime
 *     from a fixture state that materializes every AgentSessionState field
 *     (catches both a stale map entry and a serializer that quietly starts
 *     or stops emitting a field);
 *  3. no serialized key appears in the map — i.e. every serialized field is
 *     in the map's complement — and every serialized key exists on the state
 *     fixture (the runtime mirror of the reverse-direction guard);
 *  4. the serialized sample's keys survive a real on-disk JSON round-trip
 *     through deserializeAgentSession.
 *
 * Mutation probe (done at implementation time; rerun when touching this file):
 * adding a key to the map that the serializer emits, or removing a field from
 * the fixture without updating the map (or vice versa), fails test 2; renaming
 * a serialized field fails tests 3 and 4.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import {
	SESSION_TRANSIENT_FIELDS,
	serializeAgentSession,
} from '../../../src/session/snapshot-writer';
import type { AgentSessionState } from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tmpDir = canonicalMkdtemp('snapshot-parity-guard-');

/**
 * Materializes EVERY AgentSessionState field as an own enumerable key, with
 * values chosen so serializeAgentSession emits its full (unconditional +
 * conditional) field set — the derivation below is only exact when both sides
 * are complete. Fields that the snapshot deliberately never persists are set
 * to plausible live values here precisely so their absence from the output is
 * observable behavior, not an accident of the fixture.
 *
 * Maintained together with SESSION_TRANSIENT_FIELDS: a new AgentSessionState
 * field must be added here AND either serialized or given a map entry.
 */
function buildFullSessionState(): AgentSessionState {
	return {
		agentName: 'architect',
		lastToolCallTime: 1700_000_000_000,
		lastAgentEventTime: 1700_000_000_001,
		delegationActive: true,
		lastDelegationReason:
			'phase_task' as AgentSessionState['lastDelegationReason'],
		activeInvocationId: 1,
		lastInvocationIdByAgent: { architect: 1, coder: 2 },
		windows: {},
		nonTransientCircuit: {
			ownerAgent: 'coder',
			ownerInvocationId: 2,
			category: 'command_not_found',
			sameCategoryCount: 1,
			hardStop: false,
			lastSignal: 'x not found',
		},
		pendingToolExecutions: new Map([
			[
				'call-1',
				{
					tool: 'bash',
					originalCommand: 'ls',
					sandboxWrapped: false,
					ownerAgent: 'coder',
					ownerInvocationId: 2,
				},
			],
		]),
		lastCompactionHint: 0,
		architectWriteCount: 1,
		lastCoderDelegationTaskId: 'task-1',
		currentTaskId: 'task-1',
		gateLog: new Map([['task-1', new Set(['gate-a', 'gate-b'])]]),
		reviewerCallCount: new Map([[1, 2]]),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(['task-0']),
		completionGateWarnedForTask: new Set(['task-0']),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set([1]),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map([['task-1', 'idle']]),
		taskWorkflowCache: new Map(),
		stageBCompletion: new Map([['task-1', new Set(['reviewer'])]]),
		taskCouncilApproved: new Map(),
		taskCouncilWorkflowGeneration: new Map(),
		pendingCouncilRequirements: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		// Deliberately-transient trust-boundary field (issue #2002): the value
		// is present on the live state so its omission from the snapshot is
		// asserted as real behavior below.
		workspaceDirectory: path.join(tmpDir, 'lane-task-1'),
		lastScopeViolation: null,
		scopeViolationDetected: true,
		modifiedFilesByTask: new Map([['task-1', ['src/a.ts', 'src/b.ts']]]),
		modifiedFilesThisCoderTask: ['src/a.ts'],
		reviewerScopeGenerations: new Map(),
		reviewerScopeGenerationCounter: 1,
		reviewerScopeIncarnation: 'incarnation-1',
		reviewerScopeLatestGenerationByTask: new Map(),
		reviewerScopeOwnershipHistory: new Map(),
		coderRevisions: 1,
		revisionLimitHit: false,
		lastPhaseCompleteTimestamp: 1700_000_000_000,
		lastPhaseCompletePhase: 1,
		phaseAgentsDispatched: new Set(['coder']),
		lastCompletedPhaseAgentsDispatched: new Set(['reviewer']),
		model_fallback_index: 0,
		modelFallbackExhausted: false,
		turboMode: true,
		turboStrategy: 'lean',
		leanTurboActive: true,
		leanTurboCurrentPhase: 2,
		maxConcurrencyOverride: 4,
		epicModeActive: true,
		autoProceedOverride: true,
		autoProceedNudgeDone: true,
		qaGateSessionOverrides: { requireSecurityGate: true },
		fullAutoMode: true,
		fullAutoInteractionCount: 1,
		fullAutoDeadlockCount: 0,
		fullAutoLastQuestionHash: 'question-hash-1',
		loopDetectionWindow: [{ hash: 'delegation-hash-1', timestamp: 1 }],
		loopWarningPending: {
			agent: 'coder',
			message: 'loop detected',
			timestamp: 1,
		},
		contextPressureWarningSent: true,
		pendingAdvisoryMessages: ['advisory-1'],
		lastProviderRecoveryFingerprint: 'fingerprint-1',
		sessionRehydratedAt: 42,
		prmPatternCounts: new Map([['context_thrash', 1]]),
		prmEscalationLevel: 1,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 3,
		prmHardStopPending: false,
		prmHardStopInjectPending: false,
		prmStruckEpisodes: new Map(),
		prmLadderCounts: new Map(),
		prmDelegationCallId: 'call-9',
		// Own key with an undefined value keeps the field enumerable in
		// Object.keys below; the tracker is a process-local class instance.
		prmEscalationTracker: undefined,
		prmInjectedAdvisoryKeys: new Set(['context_thrash@1']),
		executionEpisodeArmed: true,
		prSubscriptions: new Map(),
		cachedCohortId: 'cohort-1',
		lastObservedModel: 'anthropic/claude-sonnet-4-5',
		lastObservedProviderID: 'anthropic',
		resumeModelAdvisoryDone: true,
		configModelAdvisoryDone: true,
		nonArchitectAdvisoryDone: true,
	} as AgentSessionState;
}

describe('snapshot field parity guard (issue #2472 W6 / AC-7)', () => {
	const fixtureState = buildFullSessionState();
	const serialized = serializeAgentSession(fixtureState);
	const serializedKeys = Object.keys(serialized).sort();
	const transientMapKeys = Object.keys(SESSION_TRANSIENT_FIELDS).sort();
	const fixtureKeys = new Set(Object.keys(fixtureState));

	it('serializes a non-trivial field set from the full fixture', () => {
		// Sanity anchor: the derived checks below are only meaningful when the
		// sample is real. If the serializer ever collapsed to a near-empty
		// object, every subsequent parity assertion would pass vacuously.
		expect(serializedKeys.length).toBeGreaterThan(40);
		expect(transientMapKeys.length).toBeGreaterThan(20);
	});

	it('every SESSION_TRANSIENT_FIELDS key is absent from the serialized sample', () => {
		const leaked = transientMapKeys.filter((key) => key in serialized);
		expect(leaked).toEqual([]);
		// Spot-prove the sample is not simply empty (which would make the
		// absence check vacuous): a serialized sibling IS present.
		expect('agentName' in serialized).toBe(true);
	});

	it('SESSION_TRANSIENT_FIELDS keys are exactly the unserialized state fields', () => {
		// Derive the transient set at runtime: fixture keys that did not reach
		// the serialized sample. Fails when either side drifts — a state field
		// added to the fixture without a map entry, a map entry whose field
		// became serialized, or a serializer that quietly drops a field.
		const derivedTransient = [...fixtureKeys]
			.filter((key) => !(key in serialized))
			.sort();
		expect(new Set(transientMapKeys)).toEqual(new Set(derivedTransient));
		// And no duplicates smuggled through the sorted array comparison.
		expect(transientMapKeys.length).toBe(new Set(transientMapKeys).size);
	});

	it('no serialized key is transient: serialized fields are exactly the map complement', () => {
		// The map's complement within the state fixture must contain every
		// serialized key — i.e. a field is either serialized or transient,
		// never both, and serialized keys never name unknown state fields
		// (runtime mirror of the reverse-direction compile-time guard).
		const transientSet = new Set(transientMapKeys);
		const overlapping = serializedKeys.filter((key) => transientSet.has(key));
		expect(overlapping).toEqual([]);
		const notOnState = serializedKeys.filter((key) => !fixtureKeys.has(key));
		expect(notOnState).toEqual([]);
	});

	it('serialized keys round-trip through deserializeAgentSession via real JSON on disk', () => {
		// The wire form is JSON on disk, not the in-memory object — round-trip
		// through an actual file so key loss (e.g. a field renamed in only one
		// direction) is observed at the boundary that matters.
		const snapshotFile = path.join(tmpDir, 'parity-round-trip.json');
		writeFileSync(snapshotFile, JSON.stringify(serialized), 'utf-8');
		const fromDisk = JSON.parse(
			readFileSync(snapshotFile, 'utf-8'),
		) as typeof serialized;
		expect(Object.keys(fromDisk).sort()).toEqual(serializedKeys);

		const deserialized = deserializeAgentSession(fromDisk);
		const missing = serializedKeys.filter((key) => !(key in deserialized));
		expect(missing).toEqual([]);

		// Value-level spot checks across representative conversion shapes:
		// direct primitive, optional string, Map/Set rehydration.
		expect(deserialized.agentName).toBe(fixtureState.agentName);
		expect(deserialized.turboStrategy).toBe('lean');
		expect(deserialized.cachedCohortId).toBe('cohort-1');
		expect(deserialized.gateLog.get('task-1')).toEqual(
			new Set(['gate-a', 'gate-b']),
		);
		expect(deserialized.modifiedFilesByTask.get('task-1')).toEqual([
			'src/a.ts',
			'src/b.ts',
		]);
	});

	// Bounded cleanup of the canonical tmpdir (the parity derivation itself is
	// pure, but the disk round-trip above and the fixture's workspaceDirectory
	// make the directory load-bearing).
	afterAll(() => {
		safeRmRecursive(tmpDir);
	});
});

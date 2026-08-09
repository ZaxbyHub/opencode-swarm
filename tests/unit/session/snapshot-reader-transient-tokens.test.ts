/**
 * Rehydration resets the #2063 one-shot containment tokens
 * (reviewer round-4 REQUIRED 4).
 *
 * Sibling file rather than an addition to `snapshot-reader.test.ts`, which is
 * already 1548 lines — well over the FR-006 500-line cap.
 *
 * Two fields must come back FALSE from `deserializeAgentSession` no matter what
 * a snapshot claims:
 *
 *   - `prmHardStopInjectPending` (issue #2063 C2). It is a one-shot token whose
 *     consumer prepends a `[HARD STOP]` block to the next completion. A
 *     snapshot captured mid-escalation that restored it armed would replay a
 *     hard stop for an escalation the resumed run has no current cause for —
 *     the agent gets told to stop and report with no detectable pattern behind
 *     it. Every other PRM field is reset for the same reason; this one is
 *     newer, so it is pinned explicitly.
 *
 *   - `executionEpisodeArmed` (issue #2063 B3/B5). An execution episode is a
 *     per-session fact by construction: arming requires an in-session execution
 *     ATTEMPT. Restoring it armed would hand a fresh session a hard lever
 *     (read/glob/grep/bash denial at 60 non-progress calls) that it never
 *     earned — precisely the "stale in_progress task arms a new session" shape
 *     the episode predicate was designed to exclude.
 *
 * Neither field is written by `snapshot-writer.ts`, so a truthy value can only
 * arrive from a hand-edited, forged, or future-schema snapshot. That is exactly
 * why the reset must be unconditional rather than "absent, therefore false":
 * `deserializeAgentSession` is the trust boundary.
 *
 * `prmHardStopDeliveredAt` is deliberately NOT referenced here — the field was
 * deleted (reviewer round-4 REQUIRED 3) and its absence from
 * `AgentSessionState` is a compile-level fact.
 */

import { describe, expect, it } from 'bun:test';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import type { SerializedAgentSession } from '../../../src/session/snapshot-writer';

/**
 * A minimal valid serialized session. The two token fields are attached via an
 * intersection type because `SerializedAgentSession` does not declare them —
 * the writer never persists them, which is half the point of the assertion.
 */
function serializedWithArmedTokens(): SerializedAgentSession {
	const base: SerializedAgentSession = {
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
		catastrophicPhaseWarnings: [],
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: [],
		qaSkipCount: 0,
		qaSkipTaskIds: [],
	};
	return {
		...base,
		// Forged / future-schema fields: armed in the snapshot.
		prmHardStopInjectPending: true,
		executionEpisodeArmed: true,
		// The rest of the PRM token surface, armed alongside them.
		prmHardStopPending: true,
		prmEscalationLevel: 3,
	} as SerializedAgentSession;
}

describe('deserializeAgentSession — #2063 one-shot token reset', () => {
	it('resets prmHardStopInjectPending and executionEpisodeArmed to false', () => {
		const result = deserializeAgentSession(serializedWithArmedTokens());

		expect(result.prmHardStopInjectPending).toBe(false);
		expect(result.executionEpisodeArmed).toBe(false);
	});

	it('resets the rest of the PRM escalation surface alongside them', () => {
		// The inject token is only meaningful next to its deny counterpart and the
		// escalation level that produced it; resetting one and restoring the
		// others would resurrect a partial escalation.
		const result = deserializeAgentSession(serializedWithArmedTokens());

		expect(result.prmHardStopPending).toBe(false);
		expect(result.prmEscalationLevel).toBe(0);
		expect(result.prmLastPatternDetected).toBeNull();
		expect(result.prmTrajectoryStep).toBe(0);
		expect(result.prmPatternCounts.size).toBe(0);
		expect(result.prmInjectedAdvisoryKeys.size).toBe(0);
	});

	it('still reports false when the snapshot omits the fields entirely', () => {
		// The ordinary case — the writer never persists them. Pinned so a future
		// change to `undefined` (which is falsy but not `false`) is caught: the
		// execution-episode consumer reads the field directly.
		const bare = serializedWithArmedTokens() as SerializedAgentSession &
			Record<string, unknown>;
		bare.prmHardStopInjectPending = undefined;
		bare.executionEpisodeArmed = undefined;

		const result = deserializeAgentSession(bare);

		expect(result.prmHardStopInjectPending).toBe(false);
		expect(result.executionEpisodeArmed).toBe(false);
	});
});

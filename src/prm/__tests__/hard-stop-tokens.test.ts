/**
 * PRM hard-stop token production (issue #2063 C2).
 *
 * Two defects are pinned here:
 *
 *  1. `session.prmHardStopPending = hardStopPending` was assigned PER MATCH, so
 *     a detection tick that produced a level-3 match followed by a level-1
 *     match of a different pattern overwrote the hard stop with `false` before
 *     any consumer could see it. The maximum escalation was silently discarded.
 *
 *  2. There was only ONE flag for two consumers (the guardrails `toolBefore`
 *     denial and the `messagesTransform` injection). Whichever ran first
 *     disarmed the other. `prmHardStopInjectPending` is the second, independent
 *     one-shot; it is SET by this producer and cleared only by its own
 *     consumer, so an unconsumed injection cannot be cancelled by a later,
 *     lower-severity tick.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PRM_ADVISORY_FORWARD_PREFIX } from '../../hooks/guardrails/messages-transform';
import { _internals, createPrmHook } from '../index';
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

const DIRECTORY = '/test/project';
const SESSION_ID = 'prm-token-session';

function createMockConfig(): PrmConfig {
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
	};
}

function createMatch(
	pattern: PatternMatch['pattern'],
	stepRange: [number, number] = [1, 3],
): PatternMatch {
	return {
		pattern,
		severity: 'medium',
		category: 'coordination_error',
		stepRange,
		description: `${pattern} detected`,
		affectedAgents: ['coder'],
		affectedTargets: ['src/foo.ts'],
		occurrenceCount: 1,
	};
}

/**
 * Minimal session stand-in. Only the fields the PRM hook reads or writes are
 * present; the hook accesses the real session through `_internals`, so a plain
 * object is enough and no `mock.module` is needed.
 */
type TokenTestSession = {
	delegationActive: boolean;
	pendingAdvisoryMessages: string[];
	prmPatternCounts: Map<string, number>;
	prmEscalationLevel: number;
	prmLastPatternDetected: PatternMatch | null;
	prmTrajectoryStep: number;
	prmHardStopPending: boolean;
	prmHardStopInjectPending?: boolean;
	prmInjectedAdvisoryKeys: Set<string>;
};

function createSession(): TokenTestSession {
	return {
		delegationActive: true,
		pendingAdvisoryMessages: [],
		prmPatternCounts: new Map(),
		prmEscalationLevel: 0,
		prmLastPatternDetected: null,
		prmTrajectoryStep: 0,
		prmHardStopPending: false,
		prmHardStopInjectPending: false,
		prmInjectedAdvisoryKeys: new Set(),
	};
}

const TRAJECTORY: TrajectoryEntry[] = [
	{
		step: 1,
		agent: 'coder',
		action: 'edit',
		target: 'src/foo.ts',
		intent: 'Add feature',
		timestamp: '2024-01-01T00:00:00Z',
		result: 'success',
	},
];

/**
 * Installs the seam replacements shared by every test here. `matchesPerTick`
 * is consumed one entry per `toolAfter` invocation, so a test can script a
 * sequence of detection ticks.
 *
 * Untested branches of the real seams (durable persistence, replay recording,
 * real trajectory IO) are deliberately stubbed out: they are covered by
 * `index.test.ts` / `integration.test.ts` / `prm-durable-backstop.test.ts` and
 * are irrelevant to token arithmetic.
 */
function installMocks(
	session: TokenTestSession,
	matchesPerTick: PatternMatch[][],
): void {
	let tick = 0;
	_internals.getAgentSession = (() =>
		session) as typeof originalGetAgentSession;
	_internals.getInMemoryTrajectory = (() =>
		TRAJECTORY) as typeof originalGetInMemoryTrajectory;
	_internals.readTrajectory = (async () =>
		TRAJECTORY) as typeof originalReadTrajectory;
	_internals.detectPatterns = (() => {
		const matches = matchesPerTick[tick] ?? [];
		tick += 1;
		return { matches, detectionTimeMs: 1, patternsChecked: 5 };
	}) as typeof originalDetectPatterns;
	_internals.generateCourseCorrection = ((match: PatternMatch) => ({
		alert: `ALERT: ${match.pattern}`,
		category: match.category,
		guidance: 'guidance',
		action: 'action',
		pattern: match.pattern,
		stepRange: match.stepRange,
	})) as typeof originalGenerateCourseCorrection;
	_internals.formatCourseCorrectionForInjection = (() =>
		'FORMATTED') as typeof originalFormatCourseCorrectionForInjection;
	_internals.cleanupOldTrajectoryFiles = (async () => {
		/* no-op */
	}) as typeof originalCleanupOldTrajectoryFiles;
	// null artifact path ⇒ replay recording is skipped entirely.
	_internals.startReplayRecording = (async () =>
		null) as typeof originalStartReplayRecording;
	_internals.recordReplayEntry = (async () => {
		/* unreachable while artifactPath is null */
	}) as typeof originalRecordReplayEntry;
	_internals.telemetry = {
		...originalTelemetry,
		prmPatternDetected: () => {},
		prmCourseCorrectionInjected: () => {},
		prmEscalationTriggered: () => {},
		prmHardStop: () => {},
		prmHardStopDelivered: () => {},
	};
}

function restoreMocks(): void {
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
}

describe('PRM hard-stop tokens (issue #2063 C2)', () => {
	beforeEach(restoreMocks);
	afterEach(restoreMocks);

	test('same-tick level-1 AFTER level-3 clears neither token', async () => {
		// Previously `session.prmHardStopPending = hardStopPending` ran once per
		// match, so the trailing ping_pong match (count 1 ⇒ level 1 ⇒
		// hardStop:false) overwrote the repetition_loop hard stop set two
		// assignments earlier and the escalation vanished within a single tick.
		//
		// Issue #2134: the episode gate caps a single tick at ONE strike per
		// pattern, so the three repetition_loop strikes that drive the ladder to
		// level 3 must now arrive as three genuinely distinct, non-overlapping
		// episodes across three ticks — not three matches crammed into one tick,
		// which the gate would collapse to a single strike. The THIRD tick still
		// carries a trailing ping_pong match (a different pattern, so it is not
		// claimed by the repetition_loop strike and survives the same-tick gate)
		// with a LATER stepRange so it sorts and is processed after the
		// repetition_loop match — reproducing the exact same-tick ordering the
		// original defect required.
		const session = createSession();
		installMocks(session, [
			[createMatch('repetition_loop', [1, 3])], // 1st ⇒ level 1
			[createMatch('repetition_loop', [4, 6])], // 2nd ⇒ level 2
			[
				createMatch('repetition_loop', [7, 9]), // 3rd ⇒ level 3 ⇒ hardStop
				createMatch('ping_pong', [10, 12]), // 1st ⇒ level 1 ⇒ hardStop false
			],
		]);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });

		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmHardStopInjectPending).toBe(true);
		// The trailing level-1 match still won the escalation-level assignment —
		// that part of the producer's semantics is unchanged.
		expect(session.prmEscalationLevel).toBe(1);
	});

	test('level-3 arms BOTH tokens; the inject token is set, not merely mirrored', async () => {
		// Issue #2134: three genuinely distinct, non-overlapping episodes — a
		// repeated stepRange would be recognized as a re-report of the same
		// episode and suppressed by the episode gate after the first strike.
		const session = createSession();
		installMocks(session, [
			[createMatch('repetition_loop', [1, 3])],
			[createMatch('repetition_loop', [4, 6])],
			[createMatch('repetition_loop', [7, 9])],
		]);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmHardStopInjectPending).toBe(false);

		await toolAfter({ sessionID: SESSION_ID });
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmHardStopInjectPending).toBe(false);

		await toolAfter({ sessionID: SESSION_ID });
		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmHardStopInjectPending).toBe(true);
	});

	test('the pushed advisory carries the prefix the subagent forward filter matches', async () => {
		// Producer↔filter binding (issue #2063 C1). The non-architect drain in
		// `guardrails/messages-transform.ts` forwards an advisory only when it
		// STARTS WITH `PRM_ADVISORY_FORWARD_PREFIX`. Renaming the dedupe key here
		// would make that filter silently inert — the exact failure
		// `RUNAWAY_OUTPUT_ADVISORY_MARKER` was introduced to prevent. Asserting
		// against the imported constant rather than a hand-copied literal is what
		// makes the two move together.
		const session = createSession();
		installMocks(session, [[createMatch('repetition_loop')]]);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(
			session.pendingAdvisoryMessages[0].startsWith(
				PRM_ADVISORY_FORWARD_PREFIX,
			),
		).toBe(true);
	});

	test('a LATER low-severity tick does not cancel an unconsumed injection', async () => {
		// The discriminating case for the "set-only" inject token. Mirroring the
		// deny token's assignment (`= tickHardStop`) passes the same-tick test
		// above but fails here: the deny token is legitimately cleared by the
		// level-1 tick, and a mirrored inject token would be cleared with it —
		// so an agent that was denied would never be told why.
		//
		// Issue #2134: the first three repetition_loop ticks use distinct,
		// non-overlapping stepRanges so each is a genuinely new episode that
		// clears the episode gate and strikes; a repeated stepRange would be
		// suppressed as a re-report of the same episode after the first strike.
		const session = createSession();
		installMocks(session, [
			[createMatch('repetition_loop', [1, 3])],
			[createMatch('repetition_loop', [4, 6])],
			[createMatch('repetition_loop', [7, 9])], // level 3 ⇒ both tokens armed
			[createMatch('ping_pong', [10, 12])], // level 1, different pattern
		]);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmHardStopInjectPending).toBe(true);

		await toolAfter({ sessionID: SESSION_ID });
		// Deny-token semantics are deliberately UNCHANGED by this issue: a tick
		// whose matches are all level 1 clears it.
		expect(session.prmHardStopPending).toBe(false);
		// The injection has not been consumed yet, so it survives.
		expect(session.prmHardStopInjectPending).toBe(true);
	});

	test('a tick with no matches leaves both tokens untouched', async () => {
		// The producer's assignments live INSIDE the match loop. If they were
		// hoisted out, a routine no-pattern tool call would clear a hard stop the
		// consumers had not yet seen.
		const session = createSession();
		session.prmHardStopPending = true;
		session.prmHardStopInjectPending = true;
		installMocks(session, [[]]);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });

		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmHardStopInjectPending).toBe(true);
	});
});

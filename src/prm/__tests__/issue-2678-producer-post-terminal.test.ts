/**
 * Issue #2678 / swarm-pr-review PRR-103 — the POST-TERMINAL PRODUCER path.
 *
 * The tracker-level episode semantics are pinned by
 * `issue-2678-bounded-episode.test.ts` (including the trigger/terminal
 * telemetry payloads). Until now, however, no TRACKED test drove
 * `createPrmHook().toolAfter` past the third detection, so the producer glue
 * was covered only by git-ignored trace-local checks:
 *
 *  - the `:terminal` advisory (generation-scoped dedupe key, PRR-104) is
 *    actually pushed through `pushAdvisory` exactly once;
 *  - post-terminal ticks do NOT re-arm either one-shot delivery token;
 *  - the episode keyspace and generation are mirrored onto the session, and a
 *    mid-session tracker REBUILD restores them (an absorbed detection stays
 *    absorbed — no fresh trigger from a stale baseline).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
const SESSION_ID = 'prm-post-terminal-session';

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

function createMatch(stepRange: [number, number]): PatternMatch {
	return {
		pattern: 'repetition_loop',
		severity: 'medium',
		category: 'coordination_error',
		stepRange,
		description: 'repetition_loop detected',
		affectedAgents: ['coder'],
		affectedTargets: ['src/foo.ts'],
		occurrenceCount: 1,
	};
}

type PostTerminalSession = {
	delegationActive: boolean;
	pendingAdvisoryMessages: string[];
	prmPatternCounts: Map<string, number>;
	prmEscalationLevel: number;
	prmLastPatternDetected: PatternMatch | null;
	prmTrajectoryStep: number;
	prmHardStopPending: boolean;
	prmHardStopInjectPending?: boolean;
	prmInjectedAdvisoryKeys: Set<string>;
	prmLadderCounts?: Map<string, number>;
	prmEpisodes?: Map<string, unknown>;
	prmEpisodeGeneration?: number;
	prmEscalationTracker?: unknown;
	prmDelegationCallId?: string;
	replayArtifactPath?: string | null;
};

function createSession(): PostTerminalSession {
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
 * The tracker's own telemetry emissions are NOT spied here (they are covered
 * by the vi.mock-based tracker tests); the producer's emissions are stubbed
 * via the established `_internals.telemetry` seam.
 */
function installMocks(
	session: PostTerminalSession,
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
		prmHardStopTerminal: () => {},
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

function fourStopTicks(session: PostTerminalSession) {
	installMocks(session, [
		[createMatch([1, 3])],
		[createMatch([4, 6])],
		[createMatch([7, 9])], // first stop: trigger, both tokens arm
		[createMatch([10, 12])], // first repeat: TERMINAL — tokens not re-armed
	]);
}

describe('PRM post-terminal producer path (issue #2678 / PRR-103)', () => {
	beforeEach(restoreMocks);
	afterEach(restoreMocks);

	test('the terminal tick pushes the generation-scoped :terminal advisory exactly once and does not re-arm either token', async () => {
		const session = createSession();
		fourStopTicks(session);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmHardStopInjectPending).toBe(true);

		// Simulate the consumers (toolBefore deny / messagesTransform inject)
		// clearing their one-shots, so tick 4's non-re-arm is observable.
		session.prmHardStopPending = false;
		session.prmHardStopInjectPending = false;

		await toolAfter({ sessionID: SESSION_ID });
		// Post-terminal: no re-arm of either one-shot token.
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmHardStopInjectPending).toBe(false);
		// The terminal advisory was delivered once, under the
		// generation-scoped `:terminal` key (PRR-104).
		const terminalAdvisories = session.pendingAdvisoryMessages.filter((m) =>
			m.includes(':terminal:g'),
		);
		expect(terminalAdvisories).toHaveLength(1);
		// The episode keyspace and generation are mirrored onto the session.
		expect(session.prmEpisodes?.size).toBe(1);
		expect(session.prmEpisodeGeneration).toBeGreaterThanOrEqual(2);

		// Further same-ladder ticks stay absorbed: no re-arm, no duplicate
		// advisory.
		installMocks(session, [[createMatch([13, 15])]]);
		await toolAfter({ sessionID: SESSION_ID });
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmHardStopInjectPending).toBe(false);
		expect(
			session.pendingAdvisoryMessages.filter((m) => m.includes(':terminal:g')),
		).toHaveLength(1);
	});

	test('a mid-session tracker rebuild restores the episode keyspace and keeps the absorbed state', async () => {
		const session = createSession();
		fourStopTicks(session);
		const { toolAfter } = createPrmHook(createMockConfig(), DIRECTORY);

		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		await toolAfter({ sessionID: SESSION_ID });
		const mirroredGeneration = session.prmEpisodeGeneration;
		expect(mirroredGeneration).toBeGreaterThanOrEqual(2);
		// Consume both one-shots so the rebuilt tracker's non-re-arm is
		// observable on the next tick.
		session.prmHardStopPending = false;
		session.prmHardStopInjectPending = false;
		// Snapshot the non-terminal level-3 advisories (tick 3 legitimately
		// pushed one) so the rebuild tick's no-fresh-trigger is provable as
		// "no NEW entry", not "zero overall".
		const nonTerminalLevel3Before = session.pendingAdvisoryMessages.filter(
			(m) => m.includes(':3:g') && !m.includes(':terminal:g'),
		).length;

		// Force the rebuild path: the hook lazily re-creates the tracker from
		// the session mirrors when prmEscalationTracker is missing.
		session.prmEscalationTracker = undefined;
		installMocks(session, [[createMatch([13, 15])]]);
		await toolAfter({ sessionID: SESSION_ID });

		// The rebuilt tracker restored the terminal episode from the session
		// mirrors: the detection is ABSORBED — no fresh trigger, no re-arm,
		// no generation advance (a fresh trigger would have bumped it and
		// re-armed the deny token).
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmHardStopInjectPending).toBe(false);
		expect(session.prmEpisodeGeneration).toBe(mirroredGeneration);
		expect(session.prmEscalationLevel).toBe(3);
		expect(
			session.pendingAdvisoryMessages.filter(
				(m) => m.includes(':3:g') && !m.includes(':terminal:g'),
			),
		).toHaveLength(nonTerminalLevel3Before);
	});
});

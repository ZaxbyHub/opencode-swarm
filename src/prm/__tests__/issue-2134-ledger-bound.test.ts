/**
 * PRM episode-ledger eviction (issue #2134, PRR-004 — PR #2139 review).
 *
 * `session.prmStruckEpisodes` in `src/prm/index.ts` is bounded at
 * `MAX_TRACKED_EPISODES = 256`. Every strike now does `delete(key)` before
 * `set(key, ...)`, so an episode that strikes AGAIN moves to the BACK of the
 * Map's insertion order. Before that fix, `Map.set` on an existing key kept
 * its ORIGINAL position, so the eviction loop below (`keys().next().value`,
 * i.e. oldest-first) evicted an episode purely because it was struck first —
 * even while it was still actively re-striking — as long as enough newer,
 * inert episodes piled up around it. Delete-then-set makes eviction track
 * least-recently-struck instead of first-struck.
 *
 * `_internals.detectPatterns` is replaced with a scripted stub returning one
 * synthetic `PatternMatch` per tick (seam pattern mirrors
 * `issue-2134-episode-gate.test.ts`'s `installMocks`/`restoreMocks`). This
 * lets the test dictate exactly which episode key strikes on which tick,
 * rather than reverse-engineering a real trajectory that produces the same
 * sequence — the eviction-order property under test depends only on episode
 * KEYS and OCCURRENCE COUNTS, not on which detector produced them.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { _internals, createPrmHook } from '../index';
import type {
	PatternMatch,
	PrmConfig,
	TaxonomyCategory,
	TrajectoryEntry,
} from '../types';

const originalGetAgentSession = _internals.getAgentSession;
const originalReadTrajectory = _internals.readTrajectory;
const originalGetInMemoryTrajectory = _internals.getInMemoryTrajectory;
const originalDetectPatterns = _internals.detectPatterns;
const originalCleanupOldTrajectoryFiles = _internals.cleanupOldTrajectoryFiles;
const originalRecordReplayEntry = _internals.recordReplayEntry;
const originalStartReplayRecording = _internals.startReplayRecording;
const originalTelemetry = _internals.telemetry;

const DIRECTORY = '/test/project';

function mkConfig(): PrmConfig {
	return {
		enabled: true,
		pattern_thresholds: {
			repetition_loop: 2,
			ping_pong: 2,
			expansion_drift: 3,
			stuck_on_test: 3,
			context_thrash: 10,
		},
		max_trajectory_lines: 100000,
		escalation_enabled: true,
		detection_timeout_ms: 5000,
	};
}

type LedgerSession = {
	delegationActive: boolean;
	pendingAdvisoryMessages: string[];
	prmPatternCounts: Map<string, number>;
	prmEscalationLevel: number;
	prmLastPatternDetected: PatternMatch | null;
	prmTrajectoryStep: number;
	prmHardStopPending: boolean;
	prmHardStopInjectPending?: boolean;
	prmInjectedAdvisoryKeys: Set<string>;
	prmStruckEpisodes?: Map<string, number>;
};

function createSession(): LedgerSession {
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

/** One fixed dummy trajectory entry — its content is irrelevant; only its
 * non-empty length matters, so `toolAfter` advances `prmTrajectoryStep`. */
const DUMMY_TRAJECTORY: TrajectoryEntry[] = [
	{
		step: 1,
		agent: 'coder',
		action: 'edit',
		target: 'src/dummy.ts',
		intent: 'x',
		timestamp: new Date(2024, 0, 1).toISOString(),
		result: 'success',
	},
];

function match(
	pattern: PatternMatch['pattern'],
	startStep: number,
	occurrenceCount: number,
): PatternMatch {
	const category: TaxonomyCategory =
		pattern === 'repetition_loop'
			? 'coordination_error'
			: 'specification_error';
	return {
		pattern,
		severity: 'medium',
		category,
		stepRange: [startStep, startStep],
		description: `synthetic ${pattern} at ${startStep}`,
		affectedAgents: ['coder'],
		affectedTargets: [`src/synthetic-${startStep}.ts`],
		occurrenceCount,
	};
}

/** Installs the scripted seam. `nextMatch` is mutated by each test to drive
 * exactly one match per `toolAfter` tick. */
function installMocks(
	session: LedgerSession,
	nextMatch: { current: PatternMatch | null },
) {
	_internals.getAgentSession = ((_id: string) =>
		session) as typeof originalGetAgentSession;
	_internals.getInMemoryTrajectory = (() =>
		DUMMY_TRAJECTORY) as typeof originalGetInMemoryTrajectory;
	_internals.readTrajectory = (async () =>
		DUMMY_TRAJECTORY) as typeof originalReadTrajectory;
	_internals.detectPatterns = ((..._args: unknown[]) => ({
		matches: nextMatch.current ? [nextMatch.current] : [],
		detectionTimeMs: 0,
		patternsChecked: 5,
	})) as typeof originalDetectPatterns;
	_internals.cleanupOldTrajectoryFiles =
		(async () => {}) as typeof originalCleanupOldTrajectoryFiles;
	_internals.startReplayRecording = (async () =>
		null) as typeof originalStartReplayRecording;
	_internals.recordReplayEntry =
		(async () => {}) as typeof originalRecordReplayEntry;
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
	_internals.cleanupOldTrajectoryFiles = originalCleanupOldTrajectoryFiles;
	_internals.recordReplayEntry = originalRecordReplayEntry;
	_internals.startReplayRecording = originalStartReplayRecording;
	_internals.telemetry = originalTelemetry;
}

describe('PRM episode ledger — MAX_TRACKED_EPISODES eviction (issue #2134, PRR-004)', () => {
	afterEach(restoreMocks);

	test('the ledger never exceeds 256 entries across 300 distinct episodes', async () => {
		const session = createSession();
		const nextMatch: { current: PatternMatch | null } = { current: null };
		installMocks(session, nextMatch);
		const { toolAfter } = createPrmHook(mkConfig(), DIRECTORY);

		for (let i = 1; i <= 300; i++) {
			// Every tick is a brand-new episode key (`context_thrash|i`), so all
			// 300 strike as "new episode" (ground (a) — no ledger entry yet).
			nextMatch.current = match('context_thrash', i, 1);
			await toolAfter({ sessionID: 'many-episodes' });
		}

		expect(session.prmStruckEpisodes).toBeInstanceOf(Map);
		expect(session.prmStruckEpisodes?.size).toBeLessThanOrEqual(256);
		// 300 distinct keys offered, cap 256 → exactly 256 survive.
		expect(session.prmStruckEpisodes?.size).toBe(256);
	});

	test('a continuously re-striking episode survives eviction while inert episodes are evicted around it (delete-then-set)', async () => {
		const session = createSession();
		const nextMatch: { current: PatternMatch | null } = { current: null };
		installMocks(session, nextMatch);
		const { toolAfter } = createPrmHook(mkConfig(), DIRECTORY);

		const STICKY_KEY = 'repetition_loop|0';

		// 1) The sticky episode strikes first — as "new", it lands at the FRONT
		// (oldest) of Map insertion order.
		nextMatch.current = match('repetition_loop', 0, 2);
		await toolAfter({ sessionID: 'sticky' });
		expect(session.prmStruckEpisodes?.get(STICKY_KEY)).toBe(2);

		// 2) 200 inert, never-repeated episodes pile up after it. Total ledger
		// size (201) stays under the 256 cap — no eviction yet.
		for (let i = 1; i <= 200; i++) {
			nextMatch.current = match('context_thrash', i, 1);
			await toolAfter({ sessionID: 'sticky' });
		}
		expect(session.prmStruckEpisodes?.size).toBe(201);
		expect(session.prmStruckEpisodes?.has(STICKY_KEY)).toBe(true);

		// 3) The sticky episode strikes AGAIN via material growth
		// (occurrenceCount 2 -> 4, exactly `struckAtCount + threshold`).
		// Delete-then-set moves its ledger entry to the BACK — the most
		// recently struck position — without changing the map's size.
		nextMatch.current = match('repetition_loop', 0, 4);
		await toolAfter({ sessionID: 'sticky' });
		expect(session.prmStruckEpisodes?.get(STICKY_KEY)).toBe(4);
		expect(session.prmStruckEpisodes?.size).toBe(201);

		// 4) 100 more inert episodes arrive. Ledger size grows past 256 and the
		// eviction loop trims from the FRONT. Because the sticky episode was
		// repositioned to the back in step 3, the entries evicted are the
		// EARLIEST inert episodes (context_thrash|1 .. |45), never the sticky
		// one — this is exactly the assertion that fails without
		// delete-then-set, where the sticky entry never leaves the front and
		// gets evicted the moment the map exceeds 256.
		for (let i = 201; i <= 300; i++) {
			nextMatch.current = match('context_thrash', i, 1);
			await toolAfter({ sessionID: 'sticky' });
		}

		expect(session.prmStruckEpisodes?.size).toBe(256);
		expect(session.prmStruckEpisodes?.has(STICKY_KEY)).toBe(true);
		// The oldest surviving inert episodes are pushed out; the earliest ones
		// from step 2 (context_thrash|1) are gone.
		expect(session.prmStruckEpisodes?.has('context_thrash|1')).toBe(false);
	});
});

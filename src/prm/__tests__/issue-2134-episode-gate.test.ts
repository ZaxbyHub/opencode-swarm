/**
 * PRM 3-strike escalation ladder — episode gate (issue #2134).
 *
 * Pre-fix, the ladder counted DETECTIONS, not OCCURRENCES: detectors re-emit
 * the SAME ongoing episode on every tool call with a growing `stepRange[1]`,
 * and the trajectory cursor (`detectPatterns(traj, cfg, lastProcessedStep)`)
 * could never suppress that because the end step always advances. One
 * ordinary episode got counted three times and armed the hard stop on a
 * healthy session.
 *
 * The fix, pinned here:
 *  1. `detectPatterns`' in-tick dedup key drops the volatile `stepRange[1]`
 *     (pattern-detector.ts), so one episode collapses to one match per call.
 *  2. `toolAfter` (index.ts) adds an EPISODE GATE keyed on
 *     `session.prmStruckEpisodes: Map<episodeKey, occurrenceCountWhenItLastStruck>`,
 *     where `episodeKey = "${pattern}|${stepRange[0]}"`. A match strikes when
 *     EITHER (a) its episode key has no ledger entry ("new episode"), OR
 *     (b) `occurrenceCount >= ledgerValue + resolvePatternThreshold(pattern)`
 *     ("material growth"). (b) is load-bearing for `context_thrash`,
 *     `ping_pong` and `stuck_on_test`, whose `stepRange[0]` does NOT advance
 *     as the episode runs (only `repetition_loop` and `expansion_drift`
 *     advance it) — without (b) those three would strike exactly once and
 *     could never reach level 2 or 3.
 *
 * All step numbers cited below (hard-stop steps, ledger values) were
 * empirically verified by driving the real detectors through `toolAfter`
 * with the fixed production code at default thresholds (repetition_loop 2,
 * ping_pong 2, expansion_drift 3, stuck_on_test 3, context_thrash 10).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { _internals, createPrmHook, resetPrmSessionState } from '../index';
import { detectPatterns } from '../pattern-detector';
import type { PatternMatch, PrmConfig, TrajectoryEntry } from '../types';

const originalGetAgentSession = _internals.getAgentSession;
const originalReadTrajectory = _internals.readTrajectory;
const originalGetInMemoryTrajectory = _internals.getInMemoryTrajectory;
const originalCleanupOldTrajectoryFiles = _internals.cleanupOldTrajectoryFiles;
const originalRecordReplayEntry = _internals.recordReplayEntry;
const originalStartReplayRecording = _internals.startReplayRecording;
const originalTelemetry = _internals.telemetry;

const DIRECTORY = '/test/project';

function mkConfig(): PrmConfig {
	return {
		enabled: true,
		// Production defaults post issue #2134 tuning — pattern-detector.ts DEFAULT_THRESHOLDS.
		pattern_thresholds: {
			repetition_loop: 2,
			ping_pong: 2,
			expansion_drift: 3,
			stuck_on_test: 3,
			context_thrash: 10,
		},
		max_trajectory_lines: 10000,
		escalation_enabled: true,
		detection_timeout_ms: 5000,
	};
}

function entry(
	step: number,
	agent: string,
	action: string,
	target: string,
	result: 'success' | 'failure' = 'success',
): TrajectoryEntry {
	return {
		step,
		agent,
		action,
		target,
		intent: 'x',
		timestamp: new Date(2024, 0, 1, 0, 0, step).toISOString(),
		result,
	};
}

/**
 * Fires `expansion_drift` repeatedly WITHOUT `context_thrash` or `repetition_loop`
 * co-firing. Even blocks touch 2 unique targets (each hit >1x but with a DIFFERENT
 * action each repeat, so no (agent,action,target) tuple repeats); odd blocks touch
 * 5 brand-new targets — 2 vs 5 gives a 2.5x ratio (>1.5) every other boundary.
 * Every target is scoped to its own block, so context_thrash's monotonic
 * new-target run resets every block and never nears its threshold of 10.
 */
const EXPANSION_ACTIONS = ['inspect', 'scan', 'peek', 'probe', 'glance'];
function buildExpansionOnlyBlocks(numBlocks: number): TrajectoryEntry[] {
	const traj: TrajectoryEntry[] = [];
	let step = 1;
	for (let b = 0; b < numBlocks; b++) {
		if (b % 2 === 0) {
			const a = `anchor${b}-A.ts`;
			const bb = `anchor${b}-B.ts`;
			traj.push(entry(step++, 'coder', 'read', `src/${a}`));
			traj.push(entry(step++, 'coder', EXPANSION_ACTIONS[b % 5], `src/${a}`));
			traj.push(entry(step++, 'coder', 'read', `src/${bb}`));
			traj.push(
				entry(step++, 'coder', EXPANSION_ACTIONS[(b + 1) % 5], `src/${bb}`),
			);
			traj.push(
				entry(step++, 'coder', EXPANSION_ACTIONS[(b + 2) % 5], `src/${a}`),
			);
		} else {
			for (let k = 0; k < 5; k++)
				traj.push(entry(step++, 'coder', 'read', `src/hi${b}-${k}.ts`));
		}
	}
	return traj;
}

/** Minimal session stand-in mirroring hard-stop-tokens.test.ts's TokenTestSession, plus the #2134 ledger. */
type EpisodeGateSession = {
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

function createSession(): EpisodeGateSession {
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

type Registered = {
	session: EpisodeGateSession;
	trajectory: TrajectoryEntry[];
};

/**
 * Installs the seam replacements shared by every hook-level test. `_internals.detectPatterns`
 * is DELIBERATELY left untouched (real detectors). Untested seam branches (durable persistence,
 * replay recording, real trajectory IO, telemetry) are stubbed — covered by index.test.ts /
 * integration.test.ts, irrelevant to episode-gate math.
 */
function installMocks(registry: Map<string, Registered>): void {
	_internals.getAgentSession = ((sessionID: string) =>
		registry.get(sessionID)?.session) as typeof originalGetAgentSession;
	_internals.getInMemoryTrajectory = ((sessionID: string) =>
		registry.get(sessionID)?.trajectory ??
		[]) as typeof originalGetInMemoryTrajectory;
	_internals.readTrajectory = (async () => []) as typeof originalReadTrajectory;
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
	_internals.cleanupOldTrajectoryFiles = originalCleanupOldTrajectoryFiles;
	_internals.recordReplayEntry = originalRecordReplayEntry;
	_internals.startReplayRecording = originalStartReplayRecording;
	_internals.telemetry = originalTelemetry;
}

type ToolAfter = (ctx: { sessionID: string }) => Promise<void>;

/** Appends one trajectory entry for `sessionID` and drives a real toolAfter tick. */
async function driveTick(
	toolAfter: ToolAfter,
	registry: Map<string, Registered>,
	sessionID: string,
	e: TrajectoryEntry,
): Promise<void> {
	registry.get(sessionID)?.trajectory.push(e);
	await toolAfter({ sessionID });
}

/**
 * Wires up ONE session (registry + mocks + a real hook) and returns short-hand drivers bound to
 * it, so individual tests read as a plain sequence of ticks instead of repeated boilerplate.
 */
function setupSession(sessionID: string) {
	const registry = new Map<string, Registered>();
	const session = createSession();
	registry.set(sessionID, { session, trajectory: [] });
	installMocks(registry);
	const { toolAfter } = createPrmHook(mkConfig(), DIRECTORY);
	const tick = (e: TrajectoryEntry) =>
		driveTick(toolAfter, registry, sessionID, e);
	const n = async (
		count: number,
		entryFn: (step: number) => TrajectoryEntry,
	) => {
		for (let step = 1; step <= count; step++) await tick(entryFn(step));
	};
	return { session, registry, toolAfter, tick, n };
}

describe('detectPatterns (real, no mocks) — in-tick episode dedup (issue #2134)', () => {
	test('5 identical entries in one call collapse to exactly one repetition_loop match, covering the widest step range', () => {
		// Pre-fix, the dedup key included stepRange[1] (volatile), so the sliding window's 4 distinct
		// end-step positions survived as 4 separate matches — the reproduction from the issue.
		const traj: TrajectoryEntry[] = [];
		for (let step = 1; step <= 5; step++)
			traj.push(entry(step, 'coder', 'edit', 'src/a.ts'));
		const result = detectPatterns(traj, mkConfig(), 0);
		const reps = result.matches.filter((m) => m.pattern === 'repetition_loop');

		expect(reps.length).toBe(1);
		// Tie-break: on equal severity the WIDER step range wins.
		expect(reps[0].stepRange).toEqual([1, 5]);
	});

	test('two genuinely distinct, non-overlapping repetition episodes still yield two matches', () => {
		const traj: TrajectoryEntry[] = [];
		let step = 1;
		for (let i = 0; i < 2; i++)
			traj.push(entry(step++, 'coderA', 'edit', 'src/a.ts'));
		for (let i = 0; i < 12; i++)
			traj.push(entry(step++, 'filler', 'read', `src/filler${i}.ts`));
		for (let i = 0; i < 2; i++)
			traj.push(entry(step++, 'coderB', 'edit', 'src/b.ts'));

		const result = detectPatterns(traj, mkConfig(), 0);
		const reps = result.matches.filter((m) => m.pattern === 'repetition_loop');

		expect(reps.length).toBe(2);
		expect(reps.map((m) => m.stepRange)).toEqual([
			[1, 2],
			[15, 16],
		]);
	});
});

describe('createPrmHook toolAfter — episode gate (issue #2134)', () => {
	afterEach(restoreMocks);

	test('regression: a healthy coder reading many distinct files never arms the hard stop', async () => {
		// Pre-fix, detectContextThrash's re-emitted match walked a healthy session to level 3 in
		// three tool calls. 25 ticks legitimately arms context_thrash's early rungs (level 1 @ 10,
		// level 2 @ 20 — a monotonic 25-new-target run IS a real signal) but must stay below the
		// empirically-verified hard-stop step of 30 (see the context_thrash containment test).
		const { session, tick } = setupSession('healthy-coder');

		const hardStopHistory: boolean[] = [];
		for (let step = 1; step <= 25; step++) {
			await tick(entry(step, 'coder', 'read', `src/file${step}.ts`));
			hardStopHistory.push(session.prmHardStopPending);
		}

		expect(hardStopHistory.every((v) => v === false)).toBe(true);
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmEscalationLevel).toBeLessThan(3);
	});

	test('a continuing episode does not re-strike on sub-threshold growth; it strikes again once growth reaches a full threshold', async () => {
		// Empirically verified: NOT "at most once" — the ledger value is an OCCURRENCE COUNT, so a
		// still-growing episode re-strikes every time it gains another full threshold's worth of
		// occurrences. What must hold: growth BELOW threshold is suppressed, AT/ABOVE strikes.
		const { session, tick } = setupSession('sub-threshold-growth');

		// steps 1,2: 2 occurrences of (coder,edit,a.ts) -> strikes (key `repetition_loop|1`, ledger=2).
		await tick(entry(1, 'coder', 'edit', 'src/a.ts'));
		await tick(entry(2, 'coder', 'edit', 'src/a.ts'));
		expect(session.prmEscalationLevel).toBe(1);
		expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);
		expect(session.prmStruckEpisodes?.get('repetition_loop|1')).toBe(2);

		// step 3: unrelated single read of a different file — no repeated tuple.
		await tick(entry(3, 'coder', 'read', 'src/other.ts'));
		expect(session.prmEscalationLevel).toBe(1);
		expect(session.prmHardStopPending).toBe(false);

		// step 4: 3rd occurrence. Growth since last strike = 3-2=1, BELOW threshold 2 -> suppressed.
		await tick(entry(4, 'coder', 'edit', 'src/a.ts'));
		expect(session.prmEscalationLevel).toBe(1);
		expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmStruckEpisodes?.get('repetition_loop|1')).toBe(2);

		// step 5: 4th occurrence. Growth = 4-2=2, AT threshold -> strikes again.
		await tick(entry(5, 'coder', 'edit', 'src/a.ts'));
		expect(session.prmEscalationLevel).toBe(2);
		expect(session.prmPatternCounts.get('repetition_loop')).toBe(2);
		expect(session.prmStruckEpisodes?.get('repetition_loop|1')).toBe(4);
	});

	test('containment: repetition_loop — a genuinely stuck agent still escalates to a hard stop', async () => {
		// Empirically verified: unbroken repetition (threshold 2) strikes at occurrence counts 2, 4,
		// 6 -> level 1 @ step 2, level 2 @ step 4, hard stop (level 3) @ step 6.
		const { session, tick, n } = setupSession('genuinely-stuck');

		await n(5, (step) => entry(step, 'coder', 'edit', 'src/stuck.ts'));
		expect(session.prmEscalationLevel).toBe(2);
		expect(session.prmHardStopPending).toBe(false);

		await tick(entry(6, 'coder', 'edit', 'src/stuck.ts'));

		expect(session.prmEscalationLevel).toBe(3);
		expect(session.prmHardStopPending).toBe(true);
		expect(
			session.prmPatternCounts.get('repetition_loop'),
		).toBeGreaterThanOrEqual(3);
	});

	test('containment: context_thrash independently escalates to a hard stop', async () => {
		// Empirically verified: an unbroken run of brand-new targets (threshold 10) strikes at
		// run-lengths 10, 20, 30 -> hard stop @ step 30. Every strike here is earned via "material
		// growth" (ground (b)) since runStart never advances — the rung added for this detector.
		const { session, tick, n } = setupSession('context-thrash-stuck');

		await n(29, (step) => entry(step, 'coder', 'read', `src/f${step}.ts`));
		expect(session.prmHardStopPending).toBe(false);

		await tick(entry(30, 'coder', 'read', 'src/f30.ts'));

		expect(session.prmEscalationLevel).toBe(3);
		expect(session.prmHardStopPending).toBe(true);
		expect(
			session.prmPatternCounts.get('context_thrash'),
		).toBeGreaterThanOrEqual(3);
	});

	test('containment: ping_pong independently escalates to a hard stop', async () => {
		// repetition_loop ALSO co-fires here and reaches ITS OWN hard stop first, @ step 7 — that
		// alone would not prove ping_pong survived the gate. Driving to step 10 and asserting
		// ping_pong's own strike count (empirically crosses 3 there) is what pins its containment.
		const { session, n } = setupSession('ping-pong-stuck');

		await n(10, (step) =>
			entry(
				step,
				step % 2 === 1 ? 'architect' : 'coder',
				'delegate',
				'src/shared.ts',
			),
		);

		expect(session.prmEscalationLevel).toBe(3);
		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmPatternCounts.get('ping_pong')).toBeGreaterThanOrEqual(3);
	});

	test('containment: stuck_on_test independently escalates to a hard stop', async () => {
		// repetition_loop ALSO co-fires (the edit half repeats the same tuple) and hard-stops first
		// @ step 7. As with ping_pong, the load-bearing assertion is stuck_on_test's OWN strike
		// count, which empirically crosses 3 @ step 19 on this trajectory.
		const { session, n } = setupSession('stuck-on-test-stuck');

		await n(19, (step) =>
			step % 2 === 1
				? entry(step, 'coder', 'edit', 'src/tested.ts')
				: entry(step, 'coder', 'test', 'src/tested.ts', 'failure'),
		);

		expect(session.prmEscalationLevel).toBe(3);
		expect(session.prmHardStopPending).toBe(true);
		expect(
			session.prmPatternCounts.get('stuck_on_test'),
		).toBeGreaterThanOrEqual(3);
	});

	test('containment: expansion_drift independently escalates to a hard stop, isolated from context_thrash and repetition_loop', async () => {
		// Unlike ping_pong/stuck_on_test above, buildExpansionOnlyBlocks fires NEITHER repetition_loop
		// NOR context_thrash — every strike is unambiguously expansion_drift's own. Empirically
		// verified: strikes @ steps 10, 20, 30 (occurrenceCount 1, 2, 3) -> hard stop @ step 30.
		const { session, tick } = setupSession('expansion-drift-stuck');

		for (const e of buildExpansionOnlyBlocks(12)) {
			await tick(e);
			if (session.prmHardStopPending) break;
		}

		expect(session.prmEscalationLevel).toBe(3);
		expect(session.prmHardStopPending).toBe(true);
		expect(session.prmPatternCounts.get('expansion_drift')).toBe(3);
		expect(session.prmTrajectoryStep).toBe(30);
		expect(session.prmPatternCounts.has('context_thrash')).toBe(false);
		expect(session.prmPatternCounts.has('repetition_loop')).toBe(false);
	});

	test('two genuinely distinct, overlapping repetition_loop episodes on different targets both strike', async () => {
		// Review finding 3: the old pattern-type-only ledger key let ONE struck episode suppress
		// every other episode of that pattern type forever, regardless of target. Here an a.ts loop
		// (key `repetition_loop|1`) and a b.ts loop starting mid-flight (key `repetition_loop|3`)
		// overlap. Both must strike independently — proven by both distinct keys appearing in the
		// ledger with their own counts, not merely the shared pattern tally advancing (which the
		// pre-fix single-episode ledger could also produce from one episode re-striking alone).
		const { session, tick } = setupSession('two-overlapping-episodes');

		const seq: TrajectoryEntry[] = [
			entry(1, 'coderA', 'edit', 'src/a.ts'),
			entry(2, 'coderA', 'edit', 'src/a.ts'), // a.ts strikes: repetition_loop|1
			entry(3, 'coderB', 'edit', 'src/b.ts'),
			entry(4, 'coderA', 'edit', 'src/a.ts'),
			entry(5, 'coderB', 'edit', 'src/b.ts'), // b.ts strikes: repetition_loop|3
		];
		for (const e of seq) await tick(e);

		expect(session.prmPatternCounts.get('repetition_loop')).toBe(2);
		expect(session.prmStruckEpisodes?.get('repetition_loop|1')).toBe(2);
		expect(session.prmStruckEpisodes?.get('repetition_loop|3')).toBe(2);
	});

	test('the episode ledger is session-scoped: two sessions do not share suppression', async () => {
		const registry = new Map<string, Registered>();
		const sessionA = createSession();
		const sessionB = createSession();
		registry.set('session-a', { session: sessionA, trajectory: [] });
		registry.set('session-b', { session: sessionB, trajectory: [] });
		installMocks(registry);
		const { toolAfter } = createPrmHook(mkConfig(), DIRECTORY);

		// Session A: 4 ticks on a.ts -> 2 strikes (level 2), ledger `repetition_loop|1` = 4
		// (occurrenceCount, empirically verified).
		for (let step = 1; step <= 4; step++) {
			await driveTick(
				toolAfter,
				registry,
				'session-a',
				entry(step, 'coder', 'edit', 'src/a.ts'),
			);
		}
		expect(sessionA.prmEscalationLevel).toBe(2);

		// Session B starts fresh and deliberately arrives at the exact SAME episode key as session A
		// ('repetition_loop|1'). If the ledger were shared (e.g. module-level instead of per-session),
		// session B's first episode would be suppressed by session A's already-struck entry.
		for (let step = 1; step <= 2; step++) {
			await driveTick(
				toolAfter,
				registry,
				'session-b',
				entry(step, 'coder', 'edit', 'src/b.ts'),
			);
		}

		expect(sessionB.prmEscalationLevel).toBe(1);
		expect(sessionB.prmHardStopPending).toBe(false);
		expect(sessionA.prmStruckEpisodes?.get('repetition_loop|1')).toBe(4);
		expect(sessionB.prmStruckEpisodes?.get('repetition_loop|1')).toBe(2);
	});

	test('resetPrmSessionState clears the episode ledger; a reset does not leave a stale high-water mark', async () => {
		const { session, tick, toolAfter } = setupSession('reset-session');

		// Strike once: episode key `repetition_loop|1` (start step 1), ledger value = occurrenceCount 2.
		await tick(entry(1, 'coder', 'edit', 'src/reset.ts'));
		await tick(entry(2, 'coder', 'edit', 'src/reset.ts'));
		expect(session.prmEscalationLevel).toBe(1);
		expect(session.prmStruckEpisodes?.get('repetition_loop|1')).toBe(2);

		resetPrmSessionState(session, 'reset-session');

		expect(session.prmStruckEpisodes).toBeInstanceOf(Map);
		expect(session.prmStruckEpisodes?.size).toBe(0);
		expect(session.prmEscalationLevel).toBe(0);

		// Replay the SAME 2-entry episode (trajectory untouched, cursor reset to 0 so detectPatterns
		// re-derives it as "new"). A reset that failed to clear prmStruckEpisodes would compare fresh
		// stepRange[0]=1 against the stale ledger entry, suppress it forever, and the session would
		// stay wedged at level 0 despite having just been reset to "fresh".
		await toolAfter({ sessionID: 'reset-session' });

		expect(session.prmEscalationLevel).toBe(1);
		expect(session.prmPatternCounts.get('repetition_loop')).toBe(1);
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmStruckEpisodes?.get('repetition_loop|1')).toBe(2);
	});
});

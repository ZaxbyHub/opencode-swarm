/**
 * PRM 3-strike escalation ladder — ladder KEY regression (issue #2134 follow-up).
 *
 * Pre-fix, `EscalationTracker.recordDetection` keyed `patternCounts` by pattern
 * TYPE alone (`patternCounts.get(match.pattern)`). Unrelated occurrences of the
 * same pattern TYPE on unrelated targets therefore accumulated into ONE strike
 * count: a coder that read-then-re-read three different files each produced its
 * own `repetition_loop` match, but all three counted against a single
 * "repetition_loop" ladder and hard-stopped at the third — without the coder
 * having repeated itself even twice on any single file.
 *
 * The fix, pinned here: `resolveLadderKey(match)` in `../escalation` resolves
 * the ladder identity a match strikes against.
 *   - `affectedTargets.length === 1` -> `${pattern}|${target}` (per-target
 *     ladder). `repetition_loop`, `ping_pong`, `stuck_on_test` each name the
 *     single target they are about.
 *   - otherwise -> bare `pattern` (per-pattern-type ladder, unchanged).
 *     `context_thrash`/`expansion_drift` describe one episode over a GROWING
 *     target set; a per-target key would mint a fresh ladder every tool call
 *     and they could never escalate.
 *
 * `EscalationState.patternCounts` is `Map<string, number>` keyed by ladder key,
 * not `Map<PatternType, number>`. `session.prmLadderCounts` mirrors it so a
 * tracker rebuilt mid-session restores the same keyspace; `prmPatternCounts`
 * stays keyed by bare pattern TYPE as the observable tally.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { EscalationTracker } from '../escalation';
import {
	_internals,
	createPrmHook,
	resetPrmSessionState,
	resolveLadderKey,
} from '../index';
import type { PatternMatch, PrmConfig, TrajectoryEntry } from '../types';
import { createMockConfig, createMockPatternMatch } from './helpers/fixtures';

describe('resolveLadderKey', () => {
	test('single-target match returns the template `pattern|target`', () => {
		const match = createMockPatternMatch('repetition_loop', {
			affectedTargets: ['src/a.ts'],
		});
		expect(resolveLadderKey(match)).toBe('repetition_loop|src/a.ts');
	});

	test('two single-target matches of the SAME pattern on DIFFERENT targets yield DIFFERENT keys', () => {
		const a = createMockPatternMatch('repetition_loop', {
			affectedTargets: ['src/a.ts'],
		});
		const b = createMockPatternMatch('repetition_loop', {
			affectedTargets: ['src/b.ts'],
		});
		expect(resolveLadderKey(a)).not.toBe(resolveLadderKey(b));
	});

	test('a multi-target match (2+ affectedTargets) returns the bare pattern', () => {
		const match = createMockPatternMatch('context_thrash', {
			affectedTargets: ['src/a.ts', 'src/b.ts'],
		});
		expect(resolveLadderKey(match)).toBe('context_thrash');
	});

	test('two multi-target matches of the same pattern with DIFFERENT target sets yield the SAME key', () => {
		const a = createMockPatternMatch('context_thrash', {
			affectedTargets: ['src/a.ts', 'src/b.ts'],
		});
		const b = createMockPatternMatch('context_thrash', {
			affectedTargets: ['src/c.ts', 'src/d.ts', 'src/e.ts'],
		});
		expect(resolveLadderKey(a)).toBe(resolveLadderKey(b));
	});

	test('a zero-target match falls through to the bare-pattern branch (defensive: never throws on affectedTargets[0])', () => {
		const match = createMockPatternMatch('expansion_drift', {
			affectedTargets: [],
		});
		expect(resolveLadderKey(match)).toBe('expansion_drift');
	});

	test('agents are NOT part of the key: two matches identical except affectedAgents yield the SAME key', () => {
		const a = createMockPatternMatch('ping_pong', {
			affectedTargets: ['src/shared.ts'],
			affectedAgents: ['architect'],
		});
		const b = createMockPatternMatch('ping_pong', {
			affectedTargets: ['src/shared.ts'],
			affectedAgents: ['architect', 'coder', 'reviewer'],
		});
		expect(resolveLadderKey(a)).toBe(resolveLadderKey(b));
	});
});

describe('EscalationTracker — ladder independence (issue #2134 follow-up)', () => {
	test('repetition_loop struck once each on 3 different targets stays at level 1 x3 — no hard stop', () => {
		// THE regression: pre-fix (bare-pattern key) this would be level 1, 2, 3
		// and isHardStopPending() === true after the third call.
		const tracker = new EscalationTracker('ladder-independence');

		const r1 = tracker.recordDetection(
			createMockPatternMatch('repetition_loop', {
				affectedTargets: ['src/a.ts'],
			}),
		);
		const r2 = tracker.recordDetection(
			createMockPatternMatch('repetition_loop', {
				affectedTargets: ['src/b.ts'],
			}),
		);
		const r3 = tracker.recordDetection(
			createMockPatternMatch('repetition_loop', {
				affectedTargets: ['src/c.ts'],
			}),
		);

		expect(r1.level).toBe(1);
		expect(r2.level).toBe(1);
		expect(r3.level).toBe(1);
		expect(r1.hardStop).toBe(false);
		expect(r2.hardStop).toBe(false);
		expect(r3.hardStop).toBe(false);
		expect(tracker.isHardStopPending()).toBe(false);
	});

	test('repetition_loop struck 3x on the SAME target still escalates to a hard stop (containment preserved)', () => {
		const tracker = new EscalationTracker('containment-preserved');
		const strike = () =>
			tracker.recordDetection(
				createMockPatternMatch('repetition_loop', {
					affectedTargets: ['src/stuck.ts'],
				}),
			);

		expect(strike().level).toBe(1);
		expect(strike().level).toBe(2);
		const third = strike();
		expect(third.level).toBe(3);
		expect(third.hardStop).toBe(true);
		expect(tracker.isHardStopPending()).toBe(true);
	});

	test('a multi-target pattern (context_thrash) still escalates 1->2->3 across 3 detections despite a different target set each time', () => {
		const tracker = new EscalationTracker('multi-target-escalates');

		const r1 = tracker.recordDetection(
			createMockPatternMatch('context_thrash', {
				affectedTargets: ['src/a.ts', 'src/b.ts'],
			}),
		);
		const r2 = tracker.recordDetection(
			createMockPatternMatch('context_thrash', {
				affectedTargets: ['src/c.ts', 'src/d.ts', 'src/e.ts'],
			}),
		);
		const r3 = tracker.recordDetection(
			createMockPatternMatch('context_thrash', {
				affectedTargets: ['src/f.ts', 'src/g.ts'],
			}),
		);

		expect(r1.level).toBe(1);
		expect(r2.level).toBe(2);
		expect(r3.level).toBe(3);
		expect(r3.hardStop).toBe(true);
		expect(tracker.isHardStopPending()).toBe(true);
	});
});

describe('resetPrmSessionState — ladder keyspace', () => {
	test('clears prmLadderCounts back to an empty Map', () => {
		const session: {
			prmEscalationTracker?: EscalationTracker;
			prmInitialized?: boolean;
			prmPatternCounts?: Map<string, number>;
			prmEscalationLevel?: number;
			prmLastPatternDetected?: unknown;
			prmHardStopPending?: boolean;
			prmHardStopInjectPending?: boolean;
			prmTrajectoryStep?: number;
			prmInjectedAdvisoryKeys?: Set<string>;
			prmStruckEpisodes?: Map<string, number>;
			prmLadderCounts?: Map<string, number>;
			replayArtifactPath?: string | null;
		} = {
			prmLadderCounts: new Map([
				['repetition_loop|src/a.ts', 4],
				['context_thrash', 12],
			]),
		};

		expect(session.prmLadderCounts.size).toBe(2);

		resetPrmSessionState(session);

		expect(session.prmLadderCounts).toBeInstanceOf(Map);
		expect(session.prmLadderCounts?.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Hook-level: the user-reported workflow, real detectors (issue #2134 report)
// ---------------------------------------------------------------------------

const originalGetAgentSession = _internals.getAgentSession;
const originalReadTrajectory = _internals.readTrajectory;
const originalGetInMemoryTrajectory = _internals.getInMemoryTrajectory;
const originalCleanupOldTrajectoryFiles = _internals.cleanupOldTrajectoryFiles;
const originalRecordReplayEntry = _internals.recordReplayEntry;
const originalStartReplayRecording = _internals.startReplayRecording;
const originalTelemetry = _internals.telemetry;

const DIRECTORY = '/test/project';

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
 * One "round" of the user-reported benign coder loop: read the module, read
 * its test file, edit the module, run the tests, re-read the module, re-run
 * the tests — 6 tool calls per module, a DIFFERENT module every round so
 * `repetition_loop`'s per-target ladder key never crosses rounds.
 */
function roundEntries(
	moduleIndex: number,
	startStep: number,
): TrajectoryEntry[] {
	const src = `src/mod${moduleIndex}.ts`;
	const testFile = `src/mod${moduleIndex}.test.ts`;
	const runTests = `bun test ${testFile}`;
	return [
		entry(startStep, 'coder', 'read', src),
		entry(startStep + 1, 'coder', 'read', testFile),
		entry(startStep + 2, 'coder', 'edit', src),
		entry(startStep + 3, 'coder', 'execute', runTests),
		entry(startStep + 4, 'coder', 'read', src),
		entry(startStep + 5, 'coder', 'execute', runTests),
	];
}

type LadderTestSession = {
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
	prmLadderCounts?: Map<string, number>;
};

function createSession(): LadderTestSession {
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

type Registered = { session: LadderTestSession; trajectory: TrajectoryEntry[] };

/** Seam pattern mirrors `issue-2134-episode-gate.test.ts`: real detectors, everything else stubbed. */
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

function mkConfig(): PrmConfig {
	return createMockConfig({
		pattern_thresholds: {
			repetition_loop: 2,
			ping_pong: 2,
			expansion_drift: 3,
			stuck_on_test: 3,
			context_thrash: 10,
		},
		max_trajectory_lines: 10000,
	});
}

describe('createPrmHook toolAfter — realistic multi-module coder loop (issue #2134 follow-up)', () => {
	afterEach(restoreMocks);

	test('8 rounds of read/read/edit/execute/read/execute across 8 DIFFERENT modules never arms the hard stop', async () => {
		// Empirically verified against the pre-fix (bare-pattern-keyed) ladder:
		// each round strikes `repetition_loop` twice (the repeated read of the
		// module, the repeated test-execute) on a NEW target every round, so a
		// pattern-type-only ladder reaches its 3rd strike mid round 2 and hard
		// stops. Ladder-keyed by `pattern|target`, each round's strikes land on
		// their own fresh per-target ladder and never leave level 1.
		const sessionID = 'multi-module-coder';
		const registry = new Map<string, Registered>();
		const session = createSession();
		registry.set(sessionID, { session, trajectory: [] });
		installMocks(registry);
		const { toolAfter } = createPrmHook(mkConfig(), DIRECTORY);

		const hardStopHistory: boolean[] = [];
		const levelHistory: number[] = [];
		let step = 1;
		for (let moduleIndex = 1; moduleIndex <= 8; moduleIndex++) {
			for (const e of roundEntries(moduleIndex, step)) {
				registry.get(sessionID)?.trajectory.push(e);
				await toolAfter({ sessionID });
				hardStopHistory.push(session.prmHardStopPending);
				levelHistory.push(session.prmEscalationLevel);
			}
			step += 6;
		}

		// Pre-fix reproduction: this exact trajectory hard-stopped mid round 2
		// (repetition_loop's bare-pattern ladder hitting its 3rd cross-module
		// strike). Post-fix it must never arm across all 48 ticks.
		expect(hardStopHistory.every((v) => v === false)).toBe(true);
		expect(session.prmHardStopPending).toBe(false);
		expect(session.prmEscalationLevel).toBeLessThan(3);
		expect(levelHistory.every((lvl) => lvl < 3)).toBe(true);

		// Mirror keyspace check: the ladder counts are keyed by ladder identity
		// (contains a `|` for the single-target repetition_loop strikes this
		// trajectory produces every round), while the observable per-pattern
		// tally stays keyed by bare pattern type.
		expect(session.prmLadderCounts).toBeInstanceOf(Map);
		expect(session.prmLadderCounts?.size).toBeGreaterThan(0);
		const ladderKeys = [...(session.prmLadderCounts?.keys() ?? [])];
		expect(ladderKeys.some((k) => k.includes('|'))).toBe(true);

		expect(session.prmPatternCounts.size).toBeGreaterThan(0);
		const patternCountKeys = [...session.prmPatternCounts.keys()];
		expect(patternCountKeys.every((k) => !k.includes('|'))).toBe(true);
	});
});

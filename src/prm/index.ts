/**
 * PRM (Process Remediation Manager) Facade
 *
 * Integration layer that wires together all PRM components:
 * - Trajectory logging via trajectory-store
 * - Pattern detection via pattern-detector
 * - Course correction via course-correction
 * - Escalation tracking via escalation
 *
 * This module provides the createPrmHook factory that returns the toolAfter
 * handler used by the swarm hook system. PRM complements loop-detector.ts:
 * loop-detector.ts remains the fast circuit breaker in guardrails/tool-before,
 * while PRM provides deeper multi-pattern detection and escalation.
 */

// Course correction
export {
	formatCourseCorrectionForInjection,
	generateCourseCorrection,
} from './course-correction';
// Escalation
export {
	createDefaultEscalationState,
	EscalationTracker,
	resolveLadderKey,
} from './escalation';
// Pattern detector
export {
	detectContextThrash,
	detectExpansionDrift,
	detectPatterns,
	detectPingPong,
	detectRepetitionLoop,
	detectStuckOnTest,
	resolvePatternThreshold,
} from './pattern-detector';
// Types
export type {
	CourseCorrection,
	EscalationState,
	PatternDetectionResult,
	PatternMatch,
	PatternSeverity,
	PatternType,
	PrmConfig,
	TaxonomyCategory,
	TrajectoryEntry,
} from './types';

import type { LearningConfig } from '../config/schema.js';
import { appendInsightCandidates } from '../hooks/micro-reflector.js';
import { enqueueCandidate } from '../learning/candidate-queue.js';
import { recordPatternObservation } from '../learning/prm-pattern-support.js';
import { getAgentSession } from '../state';
import { telemetry } from '../telemetry';
import { pushAdvisory } from '../utils/advisory-queue';
import * as logger from '../utils/logger.js';
import {
	formatCourseCorrectionForInjection,
	generateCourseCorrection,
} from './course-correction';
import { EscalationTracker, resolveLadderKey } from './escalation';
import { detectPatterns, resolvePatternThreshold } from './pattern-detector';
import { recordReplayEntry, startReplayRecording } from './replay';
import {
	cleanupOldTrajectoryFiles,
	clearTrajectoryCache,
	getInMemoryTrajectory,
	readTrajectory,
} from './trajectory-store';
import type { PatternMatch, PrmConfig } from './types';

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`.
 *
 * Production code calls `_internals.fn(...)` so tests can replace each
 * function on this object without touching the real module.  `vi.spyOn` from
 * `bun:test` leaks across files in Bun's shared test-runner process, which
 * would corrupt unrelated suites that import the same modules.
 */
export const _internals: {
	getAgentSession: typeof getAgentSession;
	readTrajectory: typeof readTrajectory;
	getInMemoryTrajectory: typeof getInMemoryTrajectory;
	detectPatterns: typeof detectPatterns;
	generateCourseCorrection: typeof generateCourseCorrection;
	formatCourseCorrectionForInjection: typeof formatCourseCorrectionForInjection;
	cleanupOldTrajectoryFiles: typeof cleanupOldTrajectoryFiles;
	clearTrajectoryCache: typeof clearTrajectoryCache;
	recordReplayEntry: typeof recordReplayEntry;
	startReplayRecording: typeof startReplayRecording;
	telemetry: typeof telemetry;
	recordPatternObservation: typeof recordPatternObservation;
	enqueueCandidate: typeof enqueueCandidate;
	appendInsightCandidates: typeof appendInsightCandidates;
} = {
	getAgentSession,
	readTrajectory,
	getInMemoryTrajectory,
	detectPatterns,
	generateCourseCorrection,
	formatCourseCorrectionForInjection,
	cleanupOldTrajectoryFiles,
	clearTrajectoryCache,
	recordReplayEntry,
	startReplayRecording,
	telemetry,
	recordPatternObservation,
	enqueueCandidate,
	appendInsightCandidates,
};

/**
 * Context passed to toolAfter handler
 */
interface ToolAfterContext {
	sessionID: string;
	tool?: string;
	args_summary?: string;
	result?: 'success' | 'failure' | 'pending';
}

/**
 * PRM hook interface returned by createPrmHook
 */
interface PrmHook {
	toolAfter: (context: ToolAfterContext) => Promise<void>;
}

/**
 * Per-session PRM state stored on the session object
 */
interface SessionPrmState {
	/** Escalation tracker instance for this session */
	prmEscalationTracker?: EscalationTracker;
	/** Whether PRM has been initialized for this session */
	prmInitialized?: boolean;
	/** Replay artifact path for this session */
	replayArtifactPath?: string | null;
}

/**
 * Upper bound on `session.prmStruckEpisodes` (issue #2134).
 *
 * Episode keys are minted per distinct start step, so a long-running session
 * with a sliding detection window accumulates them steadily and the map would
 * otherwise grow without limit on a hot, per-tool-call session object. Generous
 * relative to the default `max_trajectory_lines` of 1000: the trajectory a
 * session can still re-detect against is itself truncated, so evicted keys
 * belong to episodes that can no longer reappear.
 */
const MAX_TRACKED_EPISODES = 256;

interface ResettablePrmSessionState {
	prmEscalationTracker?: EscalationTracker;
	prmInitialized?: boolean;
	prmPatternCounts?: Map<string, number>;
	prmEscalationLevel?: number;
	prmLastPatternDetected?: unknown;
	prmHardStopPending?: boolean;
	/** Issue #2063 C2 — twin one-shot token; reset with its deny counterpart. */
	prmHardStopInjectPending?: boolean;
	prmTrajectoryStep?: number;
	prmInjectedAdvisoryKeys?: Set<string>;
	/** Issue #2134 — episode ledger; reset with the trajectory cursor it indexes. */
	prmStruckEpisodes?: Map<string, number>;
	/** Issue #2134 follow-up — ladder counts; reset with the ledger. */
	prmLadderCounts?: Map<string, number>;
	replayArtifactPath?: string | null;
}

export function resetPrmSessionState(
	session: ResettablePrmSessionState,
	sessionId?: string,
): void {
	session.prmEscalationTracker = undefined;
	session.prmInitialized = false;
	session.prmPatternCounts = new Map();
	session.prmEscalationLevel = 0;
	session.prmLastPatternDetected = null;
	session.prmHardStopPending = false;
	// Issue #2063 C2: both hard-stop tokens are cleared together. Leaving the
	// inject token armed across a PRM reset would replay a `[HARD STOP]` for an
	// escalation the reset just erased.
	session.prmHardStopInjectPending = false;
	session.prmTrajectoryStep = 0;
	// Clear cross-turn injection-dedupe state so a reset re-evaluates patterns
	// fresh (issue #1976 B1).
	session.prmInjectedAdvisoryKeys = new Set();
	// Issue #2134: the episode ledger holds trajectory STEP numbers and is only
	// meaningful relative to `prmTrajectoryStep`, which this function just reset
	// to 0. Leaving it populated would compare fresh step numbers against a stale
	// high-water mark and suppress every subsequent strike — a reset intended to
	// unwedge a session would instead disable its containment.
	session.prmStruckEpisodes = new Map<string, number>();
	session.prmLadderCounts = new Map<string, number>();
	session.replayArtifactPath = null;

	if (sessionId) {
		_internals.clearTrajectoryCache(sessionId);
	}
}

/**
 * Creates a PRM hook for the given configuration.
 *
 * The returned toolAfter handler:
 * - Runs after each tool execution when PRM is enabled
 * - Reads the session trajectory
 * - Runs pattern detection
 * - Generates course corrections for detected patterns
 * - Updates session state with corrections and escalation level
 * - Emits telemetry events
 *
 * This function is non-blocking: errors are caught and logged, never thrown.
 *
 * @param config - PRM configuration (enabled, thresholds, etc.)
 * @param directory - Project directory for trajectory storage
 * @returns PrmHook with toolAfter handler
 *
 * @example
 * ```typescript
 * const prmHook = createPrmHook(prmConfig, directory);
 * // Wire prmHook.toolAfter into your tool.execute.after hook
 * ```
 */
/**
 * Knobs the PRM hook needs to hand supported patterns to the real-time
 * admission queue (issue #1821, AC10). Optional so existing callers and tests
 * keep working unchanged; when absent, pattern persistence is simply off.
 */
export interface PrmPatternPersistenceOptions {
	/**
	 * `learning.prm_persistence.enabled`. Governs the WHOLE producer, durable
	 * append included.
	 */
	enabled: boolean;
	min_support: number;
	cooldown_ms: number;
	/**
	 * `learning.realtime_admission.enabled`. Governs ONLY the in-memory enqueue.
	 *
	 * It must never gate the durable append (issue #1821 F3): AC8 says disabled
	 * or crashed real-time work loses nothing, and the phase-boundary backstop
	 * can only see candidates that reached `.swarm/insight-candidates.jsonl`.
	 * ANDing the two flags at the call site made `realtime_admission.enabled=false`
	 * silently discard every PRM candidate. Mirrors `micro-reflector.ts`, which
	 * appends unconditionally and gates only its enqueue.
	 */
	admission_enabled: boolean;
	/** `learning.realtime_admission.max_queue_size` — bounds the shared queue. */
	max_queue_size: number;
}

/**
 * Map a parsed `learning` config onto the PRM producer's knobs (issue #1821 F3).
 *
 * The mapping lives here, beside the interface that documents which flag governs
 * what, and `src/index.ts` is its only production caller — so the AC8 coupling
 * ("durable persistence is gated by `prm_persistence.enabled` ALONE") is
 * expressed once and can be asserted directly by a test instead of being
 * re-derived from an object literal at the plugin's wiring site, where the two
 * flags were previously ANDed together.
 */
export function resolvePrmPatternPersistenceOptions(
	learning: LearningConfig,
): PrmPatternPersistenceOptions {
	return {
		// NOT ANDed with `realtime_admission.enabled`. See `admission_enabled`.
		enabled: learning.prm_persistence.enabled,
		min_support: learning.prm_persistence.min_support,
		cooldown_ms: learning.prm_persistence.cooldown_ms,
		admission_enabled: learning.realtime_admission.enabled,
		max_queue_size: learning.realtime_admission.max_queue_size,
	};
}

export function createPrmHook(
	config: PrmConfig,
	directory: string,
	patternPersistence?: PrmPatternPersistenceOptions,
): PrmHook {
	/**
	 * Async handler called after each tool execution.
	 * Non-blocking - errors are caught and logged.
	 */
	async function toolAfter(context: ToolAfterContext): Promise<void> {
		// Skip if PRM is disabled
		if (!config.enabled) {
			return;
		}

		const { sessionID } = context;

		// Get session from state
		const session = _internals.getAgentSession(sessionID);
		if (!session || !session.delegationActive) {
			return;
		}

		try {
			// Use in-memory cache (O(1)) with disk fallback on cold start (process restart)
			const cachedTrajectory = _internals.getInMemoryTrajectory(sessionID);
			const trajectory =
				cachedTrajectory.length > 0
					? cachedTrajectory
					: await _internals.readTrajectory(sessionID, directory);

			// Run pattern detection, filtering out historical matches already processed
			const detectionResult = _internals.detectPatterns(
				trajectory,
				config,
				session.prmTrajectoryStep,
			);

			if (detectionResult.matches.length === 0) {
				return;
			}

			/**
			 * Issue #2134 — EPISODE GATE. Everything below this point treats a match
			 * as "the agent did the bad thing AGAIN"; this is the filter that makes
			 * that true.
			 *
			 * A detector re-emits the SAME ongoing episode on every tool call with a
			 * growing `stepRange[1]`: a coder reading one more file extends its single
			 * `context_thrash` run. The trajectory cursor
			 * (`detectPatterns(..., lastProcessedStep)`) cannot suppress that, because
			 * the episode's end step always advances past the cursor. So the ladder
			 * counted one ordinary episode three times and reached level 3 — the hard
			 * stop — within three tool calls of perfectly healthy work.
			 *
			 * A match may strike on exactly two grounds:
			 *
			 *   (a) NEW EPISODE — no ledger entry for its episode key. The key is
			 *       `pattern|startStep`, because the START step is an episode's stable
			 *       identity while the end step is a volatile "how far has it grown"
			 *       cursor. Agents and targets are deliberately NOT in the key:
			 *       `detectContextThrash` and `detectExpansionDrift` report the target
			 *       SET accumulated so far (`pattern-detector.ts` — `affectedTargets`
			 *       is built from a growing slice), so a target-bearing key would mint
			 *       a fresh identity on every tool call and reproduce the exact bug
			 *       this gate exists to close.
			 *
			 *   (b) MATERIAL GROWTH — the same episode has gained another full
			 *       threshold's worth of occurrences since it last struck. This rung
			 *       is load-bearing, not belt-and-braces: only `detectRepetitionLoop`
			 *       and `detectExpansionDrift` advance `stepRange[0]` as an episode
			 *       runs. `detectPingPong` pins it at the first delegation
			 *       (`pattern-detector.ts` `delegateEntries[0].step`), `detectStuckOnTest`
			 *       assigns `cycleStart` once and never reassigns it, and
			 *       `detectContextThrash` only moves `runStart` when the monotonic run
			 *       BREAKS — which a sustained thrash by definition never does. Without
			 *       (b) those three patterns would strike exactly once and could never
			 *       reach level 2 or 3: a guardrail permanently disarmed against its
			 *       own worst case.
			 *
			 * Containment therefore holds for all five detectors. Worked examples at
			 * default thresholds: an unbroken `repetition_loop` strikes at 2, 4 and 6
			 * occurrences (hard stop by step 6); a `context_thrash` run strikes at 10,
			 * 20 and 30 consecutive brand-new targets with zero revisits. What can no
			 * longer happen is a hard stop earned by making tool calls rather than by
			 * repeating the behaviour.
			 *
			 * At most ONE strike per pattern type per tick, mirroring the intent
			 * documented on the detector's dedup: a single tool call must never
			 * advance the ladder by more than one rung. When several genuinely
			 * distinct episodes of one type surface together the EARLIEST is taken,
			 * and the rest are simply not counted — the cursor advance below can put
			 * an already-complete co-occurring episode below `lastProcessedStep`, so
			 * it may never be re-detected. That is deliberate: the ladder measures
			 * how insistently ONE behaviour continues, and an episode that is still
			 * running keeps earning rungs through the growth ground above. Losing a
			 * second, already-finished episode delays escalation by a tick or two at
			 * worst; counting both would restore the multi-rung jump per tool call
			 * that this gate exists to prevent.
			 */
			session.prmStruckEpisodes ??= new Map<string, number>();
			const struckEpisodes = session.prmStruckEpisodes;
			const strikeable: PatternMatch[] = [];
			const claimedThisTick = new Set<string>();
			for (const match of [...detectionResult.matches].sort(
				(a, b) => a.stepRange[0] - b.stepRange[0],
			)) {
				if (claimedThisTick.has(match.pattern)) continue;
				const episodeKey = `${match.pattern}|${match.stepRange[0]}`;
				const struckAtCount = struckEpisodes.get(episodeKey);
				if (struckAtCount !== undefined) {
					const threshold = resolvePatternThreshold(config, match.pattern);
					if (match.occurrenceCount < struckAtCount + threshold) continue;
				}
				claimedThisTick.add(match.pattern);
				strikeable.push(match);
			}

			if (strikeable.length === 0) {
				// Every match was a re-report of an already-reported episode that has
				// not yet grown enough to earn the next rung. Advance the cursor so the
				// next tick does not re-derive the same suppressed set, and leave BOTH
				// hard-stop tokens untouched — this tick observed no new occurrence, so
				// it must neither arm nor disarm them.
				if (trajectory.length > 0) {
					session.prmTrajectoryStep = trajectory[trajectory.length - 1].step;
				}
				return;
			}

			for (const match of strikeable) {
				const episodeKey = `${match.pattern}|${match.stepRange[0]}`;
				// PRR-004 (PR #2139 review): delete-then-set, so an episode that
				// strikes AGAIN moves to the back of the insertion order. `Map.set`
				// on an existing key preserves its original position, which made the
				// bound below evict by oldest-FIRST-SEEN rather than least-recently-
				// struck — able to drop the very episode an agent is still tripping
				// while keeping 255 inert ones. Mirrors the ladder bound in
				// `escalation.ts`.
				struckEpisodes.delete(episodeKey);
				struckEpisodes.set(episodeKey, match.occurrenceCount);
			}
			// Bound the ledger. Episode keys are minted per distinct start step, so a
			// very long session with a sliding detection window accumulates them
			// steadily. Map preserves insertion order, so dropping from the front
			// evicts the least recently struck episode.
			while (struckEpisodes.size > MAX_TRACKED_EPISODES) {
				const oldest = struckEpisodes.keys().next().value;
				if (oldest === undefined) break;
				struckEpisodes.delete(oldest);
			}

			// #1821 AC10: record pattern support for durable persistence.
			// PLACEMENT IS LOAD-BEARING — this sits AFTER the no-match early return
			// above, so the overwhelmingly common "tool call produced no pattern"
			// path (every tool call in a healthy session) costs nothing.
			//
			// Tallying is in-memory (no I/O, no lock, no knowledge-store access),
			// but the persistable branch below DOES do a locked append. Support and
			// cooldown gating keep that rare — see the comment on the append itself.
			// Issue #2134: iterates the EPISODE-GATED set, not every re-emission.
			// `recordPatternObservation` tallies support toward a durable insight
			// candidate (default `min_support` 3), and a single continuing episode
			// re-emitted on three consecutive tool calls used to reach that support
			// on its own — promoting a "learned" pattern the agent had exhibited
			// exactly once.
			if (patternPersistence?.enabled) {
				for (const match of strikeable) {
					const observation = _internals.recordPatternObservation(
						sessionID,
						match,
						{
							minSupport: patternPersistence.min_support,
							cooldownMs: patternPersistence.cooldown_ms,
						},
					);
					if (observation.persistable && observation.candidate) {
						// Durable backstop FIRST, mirroring `micro-reflector.ts`. Support
						// and cooldown gating make this rare (default: 3 distinct
						// occurrences, then once per 15 min per identity), so the write
						// stays off the common path. Without it a PRM candidate lost to a
						// drain failure, queue overflow, or process death is gone for good
						// AND suppressed for the whole cooldown, because
						// `recordPatternObservation` starts the cooldown at hand-over.
						//
						// UNCONDITIONAL on `admission_enabled` by design (issue #1821 F3):
						// this IS the AC8 backstop, so turning real-time admission off must
						// not turn durable persistence off with it.
						//
						// Its own try/catch, NOT the shared outer one (issue #1821 F3):
						// `appendInsightCandidates` deliberately rethrows a non-ENOENT
						// failure under its `transactFile` lock, and the outer catch is the
						// last statement's — an EACCES/ELOCKED there would skip the course
						// correction push, the hard-stop recording, and the trajectory-cursor
						// advance below, all while `recordPatternObservation` has already
						// started the 15-minute cooldown. Warn and continue instead, exactly
						// as `micro-reflector.ts` does around its own append.
						try {
							await _internals.appendInsightCandidates(directory, [
								observation.candidate,
							]);
						} catch (err) {
							logger.warn(
								`[prm] insight-candidate append failed (non-fatal): ${
									err instanceof Error ? err.message : String(err)
								}`,
							);
						}
						// In-memory enqueue only — the one thing `realtime_admission`
						// legitimately gates.
						if (patternPersistence.admission_enabled) {
							_internals.enqueueCandidate(sessionID, observation.candidate, {
								maxQueueSize: patternPersistence.max_queue_size,
							});
						}
					}
				}
			}

			// Get or create escalation tracker for this session
			const sessionPrmState = session as typeof session & SessionPrmState;
			let escalationTracker = sessionPrmState.prmEscalationTracker;

			// Initialize replay recording on first use (lazy initialization)
			if (!sessionPrmState.replayArtifactPath) {
				sessionPrmState.replayArtifactPath =
					await _internals.startReplayRecording(sessionID, directory);
			}

			const artifactPath = sessionPrmState.replayArtifactPath;

			// One-time per session: run file TTL cleanup (non-blocking, fire-and-forget)
			if (!sessionPrmState.prmInitialized) {
				sessionPrmState.prmInitialized = true;
				_internals.cleanupOldTrajectoryFiles(directory).catch(() => {
					/* non-blocking */
				});
			}

			if (!escalationTracker) {
				// PRM escalation state is session-scoped and transient — resets on session start.
				// This code reuses state from prior detections WITHIN the session, not across restarts.
				// Issue #2134 follow-up: seeds from `prmLadderCounts`, NOT
				// `prmPatternCounts`. The tracker counts by LADDER identity
				// (`pattern|target`, or bare `pattern` for a growing target set) while
				// `prmPatternCounts` stays keyed by pattern type as the observable
				// tally. Seeding the ladder from pattern-type keys would restore every
				// count under the wrong identity — silently resetting a target's real
				// strike count to zero while inventing one for a key it never uses.
				const initialState = session.prmLastPatternDetected
					? {
							patternCounts: new Map(session.prmLadderCounts ?? []),
							escalationLevel: session.prmEscalationLevel,
							lastPatternDetected: session.prmLastPatternDetected,
							hardStopPending: session.prmHardStopPending,
						}
					: undefined;

				escalationTracker = new EscalationTracker(sessionID, initialState);
				sessionPrmState.prmEscalationTracker = escalationTracker;
			}

			// Track previous escalation level for change detection
			const previousEscalationLevel = session.prmEscalationLevel;

			/**
			 * Issue #2063 C2 — hard stop is an OR across THIS tick's matches.
			 *
			 * The assignment used to be per-match (`= hardStopPending`), so when a
			 * single detection tick produced a level-3 match followed by a level-1
			 * match of a different pattern, the level-1 match overwrote the hard
			 * stop with `false` before either consumer could see it. The escalation
			 * that had genuinely reached the maximum was silently discarded.
			 *
			 * The OR is scoped to the tick, not accumulated across ticks: the
			 * assignment stays INSIDE the loop and starts from `false` on every
			 * invocation, so a later tick with only level-1 matches still clears the
			 * token (unchanged producer semantics — pinned by
			 * `__tests__/integration.test.ts` "hard stop telemetry only called on
			 * 3rd detection").
			 */
			let tickHardStop = false;

			// Process each pattern match that cleared the episode gate above.
			for (const match of strikeable) {
				// Generate course correction
				const correction = _internals.generateCourseCorrection(
					match,
					trajectory,
				);
				const formattedCorrection =
					_internals.formatCourseCorrectionForInjection(correction);

				// Record detection for escalation tracking
				let escalationLevel = 0;
				let hardStopPending = false;
				if (config.escalation_enabled !== false) {
					const escalationResult = escalationTracker.recordDetection(match);
					escalationLevel = escalationResult.level;
					hardStopPending = escalationResult.hardStop;
				}

				// Add to session pending advisory messages for injection.
				// dedupeKey = pattern + escalationLevel so within-level re-detections
				// (same pattern, new step window) dedupe, while genuine escalation
				// (level 1→2→3) survives. recordDetection / counts / telemetry /
				// replay below run unconditionally — only the INJECTION is gated.
				// The key tag is embedded in the rendered message (same convention
				// as council-advisory `[council:...]` and pr-event `[pr-monitor:...]`)
				// so the helper's key-presence dedupe can match it despite the
				// volatile step range in the alert line.
				//
				// B1 (issue #1976): the helper only dedupes WITHIN a turn (the drain
				// clears pendingAdvisoryMessages each turn), so a per-tool-call
				// re-detection of the same pattern@level would re-inject across
				// turns. prmInjectedAdvisoryKeys is the cross-turn suppressor: skip
				// injection once a (pattern, level) advisory has been delivered,
				// until escalation advances to a new level (distinct key). This does
				// NOT gate recordDetection/counts/telemetry/replay below.
				//
				// Issue #2134 follow-up: the key is scoped to the LADDER, not the
				// pattern type, because the ladder is now per-target. With a
				// pattern-scoped key and every target sitting at level 1, exactly ONE
				// advisory was delivered per pattern for the whole session and every
				// subsequent target's guidance was silently dropped — the agent was
				// neither stopped (per-target ladders escalate independently) nor
				// told. Measured: 40 distinct repeating files produced 1 advisory.
				// Scoping by ladder means each distinct behaviour is reported once per
				// level, which is the invariant this dedupe was always meant to have.
				const prmDedupeKey = `prm:${resolveLadderKey(match)}:${escalationLevel}`;
				// Defensive: the field is initialized by ensureAgentSession, but
				// guard so a session object lacking it (e.g. a minimal test mock)
				// does not throw and abort the unconditional match-processing.
				if (!session.prmInjectedAdvisoryKeys?.has(prmDedupeKey)) {
					pushAdvisory(session, `[${prmDedupeKey}] ${formattedCorrection}`, {
						dedupeKey: prmDedupeKey,
					});
					session.prmInjectedAdvisoryKeys ??= new Set();
					session.prmInjectedAdvisoryKeys.add(prmDedupeKey);
				}

				// Update session PRM state fields. `prmPatternCounts` stays keyed by
				// pattern TYPE — it is the observable per-pattern tally that telemetry
				// and tests read, and is deliberately a different keyspace from the
				// tracker's ladder counts mirrored just below.
				session.prmPatternCounts.set(
					match.pattern,
					(session.prmPatternCounts.get(match.pattern) ?? 0) + 1,
				);
				// Issue #2134 follow-up: mirror the tracker's LADDER counts onto the
				// session so a tracker rebuilt later in this session restores the same
				// keyspace it counts in. `getState()` already returns a defensive copy.
				session.prmLadderCounts = escalationTracker.getLadderCounts();
				session.prmEscalationLevel = escalationLevel;
				session.prmLastPatternDetected = match;
				tickHardStop = tickHardStop || hardStopPending;
				// DENY token — consumed once by guardrails toolBefore.
				session.prmHardStopPending = tickHardStop;
				// INJECT token — consumed once by guardrails messagesTransform.
				// Deliberately SET-only here: the two tokens are independent
				// one-shots, and mirroring the deny token's clear would let a later
				// level-1 tick disarm an inject that no consumer has seen yet,
				// re-opening the "denied but never explained" failure this design
				// exists to close.
				if (tickHardStop) {
					session.prmHardStopInjectPending = true;
				}

				// Emit telemetry for pattern detection
				_internals.telemetry.prmPatternDetected(
					sessionID,
					match.pattern,
					match.severity,
					match.category,
					match.stepRange,
				);

				// Emit telemetry for course correction injection
				_internals.telemetry.prmCourseCorrectionInjected(
					sessionID,
					match.pattern,
					escalationLevel,
				);

				// Record pattern detected for replay (non-blocking, serialized)
				if (artifactPath) {
					await _internals.recordReplayEntry(artifactPath, sessionID, {
						type: 'pattern_detected',
						data: {
							pattern: match.pattern,
							severity: match.severity,
							category: match.category,
							stepRange: match.stepRange,
							description: match.description,
							affectedAgents: match.affectedAgents,
							affectedTargets: match.affectedTargets,
							occurrenceCount: match.occurrenceCount,
						},
					});
				}

				// Record course correction for replay (non-blocking, serialized)
				if (artifactPath) {
					await _internals.recordReplayEntry(artifactPath, sessionID, {
						type: 'course_correction',
						data: {
							pattern: correction.pattern,
							alert: correction.alert,
							category: correction.category,
							guidance: correction.guidance,
							action: correction.action,
							stepRange: correction.stepRange,
							escalationLevel,
						},
					});
				}
			}

			// Record escalation level change for replay (non-blocking, serialized)
			if (
				artifactPath &&
				session.prmEscalationLevel > previousEscalationLevel
			) {
				await _internals.recordReplayEntry(artifactPath, sessionID, {
					type: 'escalation',
					data: {
						previousLevel: previousEscalationLevel,
						newLevel: session.prmEscalationLevel,
						hardStopPending: session.prmHardStopPending,
					},
				});
			}

			// Record hard stop trigger for replay (non-blocking, serialized)
			if (
				artifactPath &&
				session.prmHardStopPending &&
				previousEscalationLevel < 3
			) {
				await _internals.recordReplayEntry(artifactPath, sessionID, {
					type: 'hard_stop',
					data: {
						escalationLevel: session.prmEscalationLevel,
						triggeredAt: new Date().toISOString(),
					},
				});
			}

			// Update last-processed trajectory step to prevent re-reporting historical matches
			if (trajectory.length > 0) {
				session.prmTrajectoryStep = trajectory[trajectory.length - 1].step;
			}
		} catch (err) {
			// Non-blocking: log error and continue
			logger.log(`[prm] toolAfter error for session ${sessionID}: ${err}`);
		}
	}

	return { toolAfter };
}

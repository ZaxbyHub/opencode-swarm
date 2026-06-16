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
 * handler used by the swarm hook system. PRM replaces loop-detector.ts for
 * repetition_loop detection, but loop-detector.ts is kept as a fast circuit
 * breaker for backward compatibility.
 */

// Course correction
export {
	formatCourseCorrectionForInjection,
	generateCourseCorrection,
} from './course-correction';
// Escalation
export { createDefaultEscalationState, EscalationTracker } from './escalation';
// Pattern detector
export {
	detectContextThrash,
	detectExpansionDrift,
	detectPatterns,
	detectPingPong,
	detectRepetitionLoop,
	detectStuckOnTest,
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

import { getAgentSession } from '../state';
import { telemetry } from '../telemetry';
import {
	formatCourseCorrectionForInjection,
	generateCourseCorrection,
} from './course-correction';
import { EscalationTracker } from './escalation';
import { detectPatterns } from './pattern-detector';
import { recordReplayEntry, startReplayRecording } from './replay';
import {
	cleanupOldTrajectoryFiles,
	getInMemoryTrajectory,
	readTrajectory,
} from './trajectory-store';
import type { PatternType, PrmConfig } from './types';

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
	recordReplayEntry: typeof recordReplayEntry;
	startReplayRecording: typeof startReplayRecording;
	telemetry: typeof telemetry;
} = {
	getAgentSession,
	readTrajectory,
	getInMemoryTrajectory,
	detectPatterns,
	generateCourseCorrection,
	formatCourseCorrectionForInjection,
	cleanupOldTrajectoryFiles,
	recordReplayEntry,
	startReplayRecording,
	telemetry,
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
export function createPrmHook(config: PrmConfig, directory: string): PrmHook {
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
				const initialState = session.prmLastPatternDetected
					? {
							patternCounts: new Map(session.prmPatternCounts.entries()) as Map<
								PatternType,
								number
							>,
							escalationLevel: session.prmEscalationLevel,
							lastPatternDetected: session.prmLastPatternDetected,
							hardStopPending: session.prmHardStopPending,
							correctionsPending: [],
						}
					: undefined;

				escalationTracker = new EscalationTracker(sessionID, initialState);
				sessionPrmState.prmEscalationTracker = escalationTracker;
			}

			// Track previous escalation level for change detection
			const previousEscalationLevel = session.prmEscalationLevel;

			// Process each pattern match
			for (const match of detectionResult.matches) {
				// Generate course correction
				const correction = _internals.generateCourseCorrection(
					match,
					trajectory,
				);
				const formattedCorrection =
					_internals.formatCourseCorrectionForInjection(correction);

				// Add to session pending advisory messages for injection
				if (!session.pendingAdvisoryMessages) {
					session.pendingAdvisoryMessages = [];
				}
				session.pendingAdvisoryMessages.push(formattedCorrection);

				// Record detection for escalation tracking
				let escalationLevel = 0;
				let hardStopPending = false;
				if (config.escalation_enabled !== false) {
					const escalationResult = escalationTracker.recordDetection(match);
					escalationLevel = escalationResult.level;
					hardStopPending = escalationResult.hardStop;
				}

				// Clear the corrections queue after injection to prevent unbounded growth
				escalationTracker.clearPendingCorrections();

				// Update session PRM state fields
				session.prmPatternCounts.set(
					match.pattern,
					(session.prmPatternCounts.get(match.pattern) ?? 0) + 1,
				);
				session.prmEscalationLevel = escalationLevel;
				session.prmLastPatternDetected = match;
				session.prmHardStopPending = hardStopPending;

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
			console.warn(`[prm] toolAfter error for session ${sessionID}: ${err}`);
		}
	}

	return { toolAfter };
}

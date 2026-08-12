/**
 * PRM (Prompt Response Monitoring) Type Definitions
 * Core types for trajectory logging, pattern detection, and course correction
 */

/**
 * All detectable pattern types in the SWE-PRM system
 */
export type PatternType =
	| 'repetition_loop'
	| 'ping_pong'
	| 'expansion_drift'
	| 'stuck_on_test'
	| 'context_thrash';

/**
 * SWE-PRM taxonomy classification for categorizing pattern root causes
 */
export type TaxonomyCategory =
	| 'specification_error'
	| 'reasoning_error'
	| 'coordination_error';

/**
 * Severity levels for pattern detection responses
 */
export type PatternSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * A single trajectory log entry recording one agent action
 */
export interface TrajectoryEntry {
	/** Sequential step number (1-indexed) */
	step: number;
	/** Agent name */
	agent: string;
	/** Action type (plan, edit, review, test, delegate, etc.) */
	action: string;
	/** File or task being targeted */
	target: string;
	/** Human-readable description of intended outcome */
	intent: string;
	/** ISO 8601 timestamp */
	timestamp: string;
	/** Outcome of the action */
	result: 'success' | 'failure' | 'pending';
	/** Optional: tool name (for compatibility with existing logger) */
	tool?: string;
	/** Optional: tool arguments summary */
	args_summary?: string;
	/** Optional: elapsed time in milliseconds */
	elapsed_ms?: number;
}

/**
 * Result of pattern detection indicating a detected problematic trajectory pattern
 */
export interface PatternMatch {
	/** The type of pattern detected */
	pattern: PatternType;
	/** Severity level of the detected pattern */
	severity: PatternSeverity;
	/** Taxonomy category for the pattern */
	category: TaxonomyCategory;
	/** Start and end step numbers of the pattern occurrence */
	stepRange: [number, number];
	/** Human-readable description of the pattern */
	description: string;
	/** Agents involved in the pattern */
	affectedAgents: string[];
	/** Files/tasks involved in the pattern */
	affectedTargets: string[];
	/** How many times this pattern has been detected */
	occurrenceCount: number;
}

/**
 * Structured guidance message for steering agent behavior
 */
export interface CourseCorrection {
	/** Alert header with pattern context */
	alert: string;
	/** Taxonomy category of the underlying issue */
	category: TaxonomyCategory;
	/** Concrete next-step instruction */
	guidance: string;
	/** Specific action to take */
	action: string;
	/** Pattern type being addressed */
	pattern: PatternType;
	/** Step range where the pattern was detected */
	stepRange: [number, number];
}

/**
 * Aggregate result from running all pattern detectors
 */
export interface PatternDetectionResult {
	/** All pattern matches found in this detection pass */
	matches: PatternMatch[];
	/** Time taken to run detection in milliseconds */
	detectionTimeMs: number;
	/** Number of patterns checked in this pass */
	patternsChecked: number;
}

/**
 * Configuration for the PRM system
 */
export interface PrmConfig {
	/** Whether PRM is enabled */
	enabled: boolean;
	/** Threshold per pattern type (number of occurrences before alert) */
	pattern_thresholds: Record<PatternType, number>;
	/** Max trajectory lines before truncation */
	max_trajectory_lines: number;
	/** Whether 3-strike escalation is active */
	escalation_enabled: boolean;
	/** Max time for detection in milliseconds */
	detection_timeout_ms: number;
}

/**
 * Per-session escalation tracking state
 */
export interface EscalationState {
	/**
	 * Ladder identity to strike-count mapping.
	 *
	 * Keyed by `resolveLadderKey(match)` (issue #2134 follow-up), NOT by pattern
	 * type: `pattern|target` for a single-target pattern, bare `pattern` for one
	 * reporting a growing target set. Keying the ladder by pattern type alone let
	 * unrelated occurrences on different files accumulate into a hard stop.
	 *
	 * Distinct from `AgentSessionState.prmPatternCounts`, which stays keyed by
	 * pattern type as the observable per-pattern tally.
	 */
	patternCounts: Map<string, number>;
	/** Current escalation level (0=none, 1=guidance, 2=strong guidance, 3=hard stop) */
	escalationLevel: number;
	/** Last pattern detected (if any) */
	lastPatternDetected: PatternMatch | null;
	/** Whether a hard stop has been triggered */
	hardStopPending: boolean;
}

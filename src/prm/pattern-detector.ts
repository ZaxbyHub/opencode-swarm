/**
 * PRM Pattern Detector
 * Rule-based pattern detection for trajectory analysis
 */

import type {
	PatternDetectionResult,
	PatternMatch,
	PatternSeverity,
	PatternType,
	PrmConfig,
	TrajectoryEntry,
} from './types';

/**
 * Maximum length for sanitized strings to prevent overflow
 */
const MAX_SANITIZED_LENGTH = 200;

/**
 * Patterns indicative of prompt injection attempts
 */
const INJECTION_PATTERNS = [
	/\[SYSTEM\]/gi,
	/SYSTEM\s*OVERRIDE/gi,
	/IGNORE\s*PREVIOUS/gi,
	/IGNORE\s*ALL/gi,
	/NEW\s*INSTRUCTION/gi,
	/Override\s*instructions/gi,
	/\bJAILBREAK/gi,
	/\bDAN\s*MODE/gi,
	/\bBYPASS/gi,
];

/**
 * Sanitize a string to prevent prompt injection attacks.
 * Removes newlines, carriage returns, backticks, and common injection patterns.
 * Limits length to prevent overflow.
 *
 * @param input - The string to sanitize
 * @returns Sanitized string safe for embedding in prompts
 */
export function sanitizeString(input: string): string {
	if (!input || typeof input !== 'string') {
		return '';
	}

	let result = input;

	// Remove newlines and carriage returns
	result = result.replace(/[\n\r]/g, '');

	// Remove backticks to prevent template literal injection
	result = result.replace(/`/g, '');

	// Remove HTML/script-style tags from prompt-bound diagnostic text
	result = result.replace(/<[^>]*>/g, '');

	// Remove prompt injection patterns
	for (const pattern of INJECTION_PATTERNS) {
		result = result.replace(pattern, '[REDACTED]');
	}

	// Trim and limit length
	result = result.trim();

	if (result.length > MAX_SANITIZED_LENGTH) {
		result = `${result.slice(0, MAX_SANITIZED_LENGTH - 3)}...`;
	}

	return result;
}

/**
 * Default pattern thresholds
 */
const DEFAULT_THRESHOLDS: Record<PatternType, number> = {
	repetition_loop: 2,
	ping_pong: 2,
	expansion_drift: 3,
	stuck_on_test: 3,
	context_thrash: 3,
};

/**
 * Detect repetition_loop pattern
 * Same agent targets same file with same action within N steps
 *
 * @param trajectory - Array of trajectory entries
 * @param config - PRM configuration
 * @returns Array of detected pattern matches
 */
export function detectRepetitionLoop(
	trajectory: TrajectoryEntry[],
	config: PrmConfig,
): PatternMatch[] {
	const matches: PatternMatch[] = [];

	if (trajectory.length < 2) {
		return matches;
	}

	const windowSize = 10;
	const threshold =
		config.pattern_thresholds?.repetition_loop ??
		DEFAULT_THRESHOLDS.repetition_loop;

	// Check each position as potential end of pattern
	for (let i = 0; i < trajectory.length; i++) {
		const windowStart = Math.max(0, i - windowSize + 1);
		const window = trajectory.slice(windowStart, i + 1);

		// Count (agent, action, target) combinations
		const counts = new Map<
			string,
			{ count: number; startStep: number; endStep: number }
		>();

		for (const entry of window) {
			const key = `${entry.agent}|${entry.action}|${entry.target}`;
			const existing = counts.get(key);

			if (existing) {
				existing.count++;
				existing.endStep = entry.step;
			} else {
				counts.set(key, {
					count: 1,
					startStep: entry.step,
					endStep: entry.step,
				});
			}
		}

		// Check for combinations meeting threshold
		for (const [key, data] of counts) {
			if (data.count >= threshold) {
				const [agent, action, target] = key.split('|');
				const severity: PatternSeverity = data.count >= 3 ? 'high' : 'medium';

				matches.push({
					pattern: 'repetition_loop',
					severity,
					category: 'coordination_error',
					stepRange: [data.startStep, data.endStep],
					description: `Agent "${sanitizeString(agent)}" performed "${sanitizeString(action)}" on "${sanitizeString(target)}" ${data.count} times within ${windowSize} steps`,
					affectedAgents: [sanitizeString(agent)],
					affectedTargets: [sanitizeString(target)],
					occurrenceCount: data.count,
				});
			}
		}
	}

	return matches;
}

/**
 * Detect ping_pong pattern
 * Agent A delegates to B, B completes, A delegates to B again
 * Alternating agent patterns with same target
 *
 * @param trajectory - Array of trajectory entries
 * @param config - PRM configuration
 * @returns Array of detected pattern matches
 */
export function detectPingPong(
	trajectory: TrajectoryEntry[],
	config: PrmConfig,
): PatternMatch[] {
	const matches: PatternMatch[] = [];

	const threshold =
		config.pattern_thresholds?.ping_pong ?? DEFAULT_THRESHOLDS.ping_pong;

	// Minimum threshold for meaningful ping-pong is 3 (A-B-A pattern)
	const minThreshold = 3;
	const effectiveThreshold = Math.max(threshold, minThreshold);

	// Pre-filter: examine only delegation handoffs (regardless of non-delegate actions between them)
	const delegateEntries = trajectory.filter((e) => e.action === 'delegate');

	if (delegateEntries.length < effectiveThreshold) {
		return matches;
	}

	// Track already-detected ping-pong pairs to emit one match per agent pair + target
	const detectedPairs = new Set<string>();

	// Find all alternating delegation sequences over delegate-only entries
	let i = 0;
	while (i < delegateEntries.length) {
		if (i + 1 >= delegateEntries.length) break;

		const firstAgent = delegateEntries[i].agent;
		const secondAgent = delegateEntries[i + 1].agent;
		const target = delegateEntries[i].target;

		if (firstAgent === secondAgent) {
			i++;
			continue;
		}

		// Find the full extent of the alternating sequence over delegate entries
		let endIndex = i + 1;
		for (let j = i + 2; j < delegateEntries.length; j++) {
			const expectedAgent = (j - i) % 2 === 0 ? firstAgent : secondAgent;
			if (
				delegateEntries[j].agent !== expectedAgent ||
				delegateEntries[j].target !== target
			) {
				break;
			}
			endIndex = j;
		}

		const patternLength = endIndex - i + 1;

		if (patternLength >= effectiveThreshold) {
			const pairKey = `${[firstAgent, secondAgent].sort().join(',')}-${target}`;
			if (!detectedPairs.has(pairKey)) {
				detectedPairs.add(pairKey);
				const roundTrips = Math.floor(patternLength / 2);

				matches.push({
					pattern: 'ping_pong',
					severity: 'high',
					category: 'coordination_error',
					stepRange: [delegateEntries[i].step, delegateEntries[endIndex].step],
					description: `Ping-pong delegation detected: "${sanitizeString(firstAgent)}" and "${sanitizeString(secondAgent)}" alternating on "${sanitizeString(target)}"`,
					affectedAgents: [
						sanitizeString(firstAgent),
						sanitizeString(secondAgent),
					],
					affectedTargets: [sanitizeString(target)],
					occurrenceCount: roundTrips,
				});
			}

			i = endIndex + 1;
		} else {
			i++;
		}
	}

	return matches;
}

/**
 * Detect expansion_drift pattern
 * Successive plans grow in scope (unique targets increase >50%)
 *
 * @param trajectory - Array of trajectory entries
 * @param config - PRM configuration
 * @returns Array of detected pattern matches
 */
export function detectExpansionDrift(
	trajectory: TrajectoryEntry[],
	config: PrmConfig,
): PatternMatch[] {
	const matches: PatternMatch[] = [];

	const threshold =
		config.pattern_thresholds?.expansion_drift ??
		DEFAULT_THRESHOLDS.expansion_drift;

	// Window size based on threshold; minimum 5 for meaningful comparison
	const windowSize = Math.max(threshold, 5);
	const minTrajectoryLength = windowSize * 2;

	if (trajectory.length < minTrajectoryLength) {
		return matches;
	}

	for (let i = windowSize * 2; i <= trajectory.length; i += windowSize) {
		const recentWindow = trajectory.slice(i - windowSize, i);
		const previousWindow = trajectory.slice(i - windowSize * 2, i - windowSize);

		const recentTargets = new Set(recentWindow.map((e) => e.target));
		const previousTargets = new Set(previousWindow.map((e) => e.target));

		// Expansion ratio: recent / previous
		// Trigger when ratio > 1.5 (50% increase)
		if (previousTargets.size > 0) {
			const expansionRatio = recentTargets.size / previousTargets.size;

			if (expansionRatio > 1.5) {
				matches.push({
					pattern: 'expansion_drift',
					severity: 'medium',
					category: 'specification_error',
					stepRange: [
						previousWindow[0].step,
						recentWindow[recentWindow.length - 1].step,
					],
					description: `Scope expansion detected: ${previousTargets.size} unique targets → ${recentTargets.size} unique targets (${expansionRatio.toFixed(1)}x increase)`,
					affectedAgents: [
						...new Set(recentWindow.map((e) => sanitizeString(e.agent))),
					],
					affectedTargets: [...recentTargets].map((t) => sanitizeString(t)),
					occurrenceCount: Math.floor(expansionRatio * 10) / 10,
				});
			}
		}
	}

	return matches;
}

/**
 * Detect stuck_on_test pattern
 * Edit -> test fail -> edit same file cycle
 *
 * @param trajectory - Array of trajectory entries
 * @param config - PRM configuration
 * @returns Array of detected pattern matches
 */
export function detectStuckOnTest(
	trajectory: TrajectoryEntry[],
	config: PrmConfig,
): PatternMatch[] {
	const matches: PatternMatch[] = [];

	if (trajectory.length < 3) {
		return matches;
	}

	const threshold =
		config.pattern_thresholds?.stuck_on_test ??
		DEFAULT_THRESHOLDS.stuck_on_test;

	// Group entries by target file
	const fileCycles = new Map<
		string,
		{ edits: number; tests: number; steps: number[]; agents: string[] }
	>();

	for (let i = 0; i < trajectory.length; i++) {
		const entry = trajectory[i];

		if (entry.action === 'edit') {
			const existing = fileCycles.get(entry.target);
			if (existing) {
				existing.edits++;
				existing.steps.push(entry.step);
				if (!existing.agents.includes(entry.agent)) {
					existing.agents.push(entry.agent);
				}
			} else {
				fileCycles.set(entry.target, {
					edits: 1,
					tests: 0,
					steps: [entry.step],
					agents: [entry.agent],
				});
			}
		} else if (entry.action === 'test') {
			const existing = fileCycles.get(entry.target);
			if (existing) {
				existing.tests++;
			}
		}
	}

	// Check for edit-test cycles on same file
	for (const [file, data] of fileCycles) {
		if (data.edits >= threshold && data.tests >= 1) {
			// Detect actual edit -> test -> edit cycles
			let cycleCount = 0;
			let lastEditStep = -1;
			let lastTestStep = -1;
			let cycleStart = -1;
			let cycleEnd = -1;

			for (let i = 0; i < trajectory.length; i++) {
				const entry = trajectory[i];

				if (entry.target === file) {
					if (entry.action === 'edit') {
						if (lastTestStep > lastEditStep && lastEditStep > 0) {
							// Found edit -> test cycle
							cycleCount++;
							if (cycleStart === -1) cycleStart = lastEditStep;
							cycleEnd = entry.step;
						}
						lastEditStep = entry.step;
					} else if (entry.action === 'test' && entry.result === 'failure') {
						lastTestStep = entry.step;
					}
				}
			}

			if (cycleCount >= threshold) {
				matches.push({
					pattern: 'stuck_on_test',
					severity: 'high',
					category: 'reasoning_error',
					stepRange: [cycleStart, cycleEnd],
					description: `Stuck on test detected: ${cycleCount} edit-test cycles on "${sanitizeString(file)}"`,
					affectedAgents: data.agents.map((a) => sanitizeString(a)),
					affectedTargets: [sanitizeString(file)],
					occurrenceCount: cycleCount,
				});
			}
		}
	}

	return matches;
}

/**
 * Detect context_thrash pattern
 * Agent requests increasingly large file sets (monotonic increase in unique targets)
 * Context thrash is detected when the agent keeps introducing NEW targets without
 * revisiting old ones - i.e., the unique target count increases for consecutive steps
 * with NO plateaus in between.
 *
 * @param trajectory - Array of trajectory entries
 * @param config - PRM configuration
 * @returns Array of detected pattern matches
 */
export function detectContextThrash(
	trajectory: TrajectoryEntry[],
	config: PrmConfig,
): PatternMatch[] {
	const matches: PatternMatch[] = [];

	if (trajectory.length < 2) {
		return matches;
	}

	const threshold =
		config.pattern_thresholds?.context_thrash ??
		DEFAULT_THRESHOLDS.context_thrash;

	// O(n): Build cumulative unique-target counts with running Set
	const seenTargets = new Set<string>();
	const cumulativeCounts: number[] = [];
	for (const entry of trajectory) {
		seenTargets.add(entry.target);
		cumulativeCounts.push(seenTargets.size);
	}

	// O(n): Single forward pass to find monotonic-increasing runs >= threshold
	let runStart = 0;
	let runLength = 1;

	for (let i = 1; i <= cumulativeCounts.length; i++) {
		const extending =
			i < cumulativeCounts.length &&
			cumulativeCounts[i] > cumulativeCounts[i - 1];

		if (extending) {
			runLength++;
		} else {
			if (runLength >= threshold) {
				const runEnd = i - 1;
				const priorCount = runStart > 0 ? cumulativeCounts[runStart - 1] : 0;
				const finalCount = cumulativeCounts[runEnd];

				matches.push({
					pattern: 'context_thrash',
					severity: 'medium',
					category: 'coordination_error',
					stepRange: [trajectory[runStart].step, trajectory[runEnd].step],
					description: `Context thrash detected: unique targets grew monotonically from ${priorCount} to ${finalCount} over ${runLength} steps`,
					affectedAgents: [
						...new Set(
							trajectory
								.slice(runStart, runEnd + 1)
								.map((e) => sanitizeString(e.agent)),
						),
					],
					affectedTargets: [
						...new Set(
							trajectory
								.slice(runStart, runEnd + 1)
								.map((e) => sanitizeString(e.target)),
						),
					],
					occurrenceCount: runLength,
				});
			}

			runStart = i;
			runLength = 1;
		}
	}

	return matches;
}

/**
 * Run all pattern detectors on a trajectory
 *
 * @param trajectory - Array of trajectory entries to analyze
 * @param config - PRM configuration with thresholds
 * @returns PatternDetectionResult with all matches and timing info
 */
export function detectPatterns(
	trajectory: TrajectoryEntry[],
	config: PrmConfig,
	lastProcessedStep: number = 0,
): PatternDetectionResult {
	const startTime = Date.now();

	// Early return when PRM is disabled
	if (config.enabled === false) {
		return {
			matches: [],
			detectionTimeMs: 0,
			patternsChecked: 5,
		};
	}

	const allMatches: PatternMatch[] = [];

	// Run all detectors
	allMatches.push(...detectRepetitionLoop(trajectory, config));
	allMatches.push(...detectPingPong(trajectory, config));
	allMatches.push(...detectExpansionDrift(trajectory, config));
	allMatches.push(...detectStuckOnTest(trajectory, config));
	allMatches.push(...detectContextThrash(trajectory, config));

	const detectionTimeMs = Date.now() - startTime;

	// Deduplicate matches to prevent multiple escalation advances from a single toolAfter call.
	// A trajectory with 3 identical entries would otherwise emit 3 matches (one per window position),
	// causing escalation to jump multiple levels in a single invocation.
	const severityRank: Record<PatternSeverity, number> = {
		critical: 4,
		high: 3,
		medium: 2,
		low: 1,
	};
	const dedupedMatches = new Map<string, PatternMatch>();

	for (const match of allMatches) {
		// Create dedup key: pattern + affectedAgents + affectedTargets + stepRange
		const key = `${match.pattern}-${match.affectedAgents.join(',')}-${match.affectedTargets.join(',')}-${match.stepRange[0]}-${match.stepRange[1]}`;
		const existing = dedupedMatches.get(key);

		if (!existing) {
			dedupedMatches.set(key, match);
		} else {
			// Keep the more severe match when duplicates exist
			const existingRank = severityRank[existing.severity] ?? 0;
			const newRank = severityRank[match.severity] ?? 0;
			if (newRank > existingRank) {
				dedupedMatches.set(key, match);
			}
		}
	}

	// Filter to only include matches involving new steps (stepRange end > lastProcessedStep)
	// This prevents re-reporting historical patterns on every toolAfter call
	const newMatches = Array.from(dedupedMatches.values()).filter(
		(match) => match.stepRange[1] > lastProcessedStep,
	);

	return {
		matches: newMatches,
		detectionTimeMs,
		patternsChecked: 5,
	};
}

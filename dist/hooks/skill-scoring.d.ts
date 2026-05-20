/**
 * Skill scoring — computes skill relevance scores based on historical
 * usage data from `.swarm/skill-usage.jsonl`.
 *
 * All public functions are pure over their inputs. File I/O goes through
 * `readSkillUsageEntries` (imported from `skill-usage-log.ts`).
 * An `_internals` DI seam mirrors the pattern in `skill-usage-log.ts`
 * and `skill-propagation-gate.ts` for testability.
 */
import { type SkillUsageEntry } from './skill-usage-log.js';
/** Per-skill ranking entry returned by `rankSkillsForContext`. */
export interface SkillRankEntry {
    /** Repo-relative path to the skill file. */
    skillPath: string;
    /** Composite relevance score in [0, 1]. */
    score: number;
    /** Total number of recorded usages for this skill. */
    usageCount: number;
    /** Ratio of compliant verdicts to total verdicts in [0, 1]. */
    complianceRate: number;
}
/** Aggregate statistics for a single skill. */
export interface SkillStats {
    /** Total number of recorded usages. */
    totalUsage: number;
    /** Ratio of compliant verdicts to total verdicts in [0, 1]. */
    complianceRate: number;
    /** ISO 8601 timestamp of the most recent usage, or empty string. */
    lastUsed: string;
    /** Top agents by usage count, sorted descending. */
    topAgents: Array<{
        agent: string;
        count: number;
    }>;
}
export declare const _internals: {
    computeSkillRelevanceScore: typeof computeSkillRelevanceScore;
    rankSkillsForContext: typeof rankSkillsForContext;
    getSkillStats: typeof getSkillStats;
    formatSkillIndexWithContext: typeof formatSkillIndexWithContext;
    extractSkillName: typeof extractSkillName;
    computeRecencyScore: typeof computeRecencyScore;
    computeContextMatchScore: typeof computeContextMatchScore;
};
/**
 * Extracts a human-readable skill name from its file path.
 * E.g. `.claude/skills/writing-tests/SKILL.md` → `writing-tests`
 */
declare function extractSkillName(skillPath: string): string;
/**
 * Computes a recency score in [0, 1] based on how recently the skill was used.
 * Full score (1.0) for usage within 24 hours, linearly decaying to 0 over 30 days.
 */
declare function computeRecencyScore(lastUsedTimestamp: string): number;
/**
 * Computes a keyword-overlap context match score between a task description and a skill.
 *
 * Extracts keywords from both the task description and the skill's path + name,
 * then returns the ratio of matching keywords to the total task keywords.
 * Returns 0 when the task description has no extractable keywords.
 *
 * @param taskDescription - Free-text description of the current task.
 * @param skillPath       - Repo-relative path to the skill file.
 * @returns Context match score in [0, 1].
 */
declare function computeContextMatchScore(taskDescription: string, skillPath: string): number;
/**
 * Compute a composite relevance score for a skill based on its usage history
 * and keyword overlap with the task description.
 *
 * Spec compliance: FR-002 requires scoring "based on historical usage data using the skill
 * usage log and task descriptions." This function uses the usage log (frequency, compliance,
 * recency, taskID diversity) and the current task description (keyword overlap with skill
 * name/path) to produce context-aware rankings.
 *
 * Formula (all components clamped to [0, 1]):
 *   frequencyScore    = min(1.0, usageCount / FREQUENCY_CAP) * FREQUENCY_WEIGHT
 *   complianceScore   = (compliantCount / max(1, totalWithVerdict)) * COMPLIANCE_WEIGHT
 *   recencyScore      = linearDecay(lastUsed) * RECENCY_WEIGHT
 *   taskDiversityScore = (distinctTaskIDs / max(1, usageHistory.length)) * TASK_DIVERSITY_WEIGHT
 *   contextScore      = keywordOverlap(taskDescription, skillPath) * CONTEXT_WEIGHT
 *   total             = frequencyScore + complianceScore + recencyScore + taskDiversityScore + contextScore
 *
 * The context component ensures different task descriptions produce different
 * rankings: keywords from the task description are matched against the skill's
 * file path and name via simple set intersection.
 *
 * @param skillPath        - Repo-relative path to the skill file.
 * @param taskDescription  - Free-text description of the current task.
 * @param usageHistory     - Pre-loaded usage entries for this skill.
 * @returns Composite score in [0, 1]. Returns contextScore only when history is empty.
 */
export declare function computeSkillRelevanceScore(skillPath: string, taskDescription: string, usageHistory: SkillUsageEntry[]): number;
/**
 * Rank an array of skill paths by relevance to a task context.
 *
 * Reads `.swarm/skill-usage.jsonl` for historical data, computes composite
 * scores for each skill, and returns entries sorted by score descending.
 *
 * @param skills      - Array of repo-relative skill paths.
 * @param taskContext  - Free-text description of the task.
 * @param directory    - Project root directory (used to locate `.swarm/`).
 * @returns Sorted array of `SkillRankEntry`, highest score first.
 */
export declare function rankSkillsForContext(skills: string[], taskContext: string, directory: string): SkillRankEntry[];
/**
 * Read usage log and compute aggregate statistics for a single skill.
 *
 * @param skillPath - Repo-relative path to the skill file.
 * @param directory - Project root directory.
 * @returns `SkillStats` with aggregate metrics. Returns zeros/empty when log is missing.
 */
export declare function getSkillStats(skillPath: string, directory: string): SkillStats;
/**
 * Produce a formatted skill index string with contextual usage stats.
 *
 * Each line looks like:
 *   `engineering-conventions: Engineering invariants (used: 12, compliance: 95%) → coder, reviewer`
 *
 * Falls back to a simple index without stats if the usage log does not exist.
 *
 * @param skills    - Array of repo-relative skill paths.
 * @param directory - Project root directory.
 * @returns Multi-line formatted string, one line per skill.
 */
export declare function formatSkillIndexWithContext(skills: string[], directory: string): string;
export {};

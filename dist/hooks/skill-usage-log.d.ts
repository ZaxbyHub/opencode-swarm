/**
 * Skill usage log — tracks skill delegations and compliance outcomes.
 *
 * Writes one JSONL line per skill-usage event to `.swarm/skill-usage.jsonl`.
 * Follows the same append-only JSONL pattern as knowledge-application.jsonl.
 */
import * as fs from 'node:fs';
/** Single entry in the skill-usage audit log. */
export interface SkillUsageEntry {
    /** Auto-generated unique identifier (UUID v4). */
    id: string;
    /** Repo-relative path to the skill file. */
    skillPath: string;
    /** Name of the agent receiving the skill. */
    agentName: string;
    /** Plan task ID the skill was loaded for. */
    taskID: string;
    /** ISO 8601 timestamp of the event. */
    timestamp: string;
    /** Compliance outcome — 'compliant' | 'violation' | 'partial' | 'not_checked' | custom. */
    complianceVerdict: string;
    /** Optional free-text notes from the reviewer. */
    reviewerNotes?: string;
    /** Session identifier. */
    sessionID: string;
}
/** Filter options for reading skill-usage entries. */
export interface SkillUsageFilterOptions {
    /** Filter entries by session ID (exact match). */
    sessionID?: string;
    /** Filter entries by skill path (exact match). */
    skillPath?: string;
    /** Filter entries by agent name (exact match). */
    agentName?: string;
    /** Filter entries by plan task ID (exact match). */
    taskID?: string;
    /** Filter entries to timestamps within this ISO 8601 range (inclusive). */
    dateRange?: {
        start: string;
        end: string;
    };
}
/** Return value from prune operations. */
export interface PruneResult {
    /** Number of entries removed. */
    pruned: number;
    /** Number of entries remaining in the log. */
    remaining: number;
    /** Error message when the write/rename step fails; absent on success. */
    error?: string;
}
/**
 * Test-only dependency-injection seam. Tests override these without
 * `mock.module` (which leaks across files in Bun's shared test-runner).
 * Restore in `afterEach`.
 */
export declare const _internals: {
    generateId: () => string;
    appendFileSync: typeof fs.appendFileSync;
    readFileSync: typeof fs.readFileSync;
    writeFileSync: typeof fs.writeFileSync;
    renameSync: typeof fs.renameSync;
    mkdirSync: typeof fs.mkdirSync;
    existsSync: typeof fs.existsSync;
    statSync: any;
    openSync: typeof fs.openSync;
    readSync: typeof fs.readSync;
    closeSync: typeof fs.closeSync;
    resolveSourceKnowledgeIds: typeof resolveSourceKnowledgeIds;
    applySkillUsageFeedback: typeof applySkillUsageFeedback;
    parseGeneratedFromKnowledge: typeof parseGeneratedFromKnowledge;
};
/**
 * Validate and append a single skill-usage entry to the JSONL log.
 *
 * The `id` field is auto-generated; callers provide all other fields.
 * Uses synchronous I/O for consistency with the JSONL append pattern.
 */
export declare function appendSkillUsageEntry(directory: string, entry: Omit<SkillUsageEntry, 'id'>): void;
/**
 * Read and parse skill-usage entries from the JSONL log, optionally filtered.
 *
 * Malformed lines are silently skipped (no throw). Returns an empty array
 * if the log file does not exist.
 */
export declare function readSkillUsageEntries(directory: string, options?: SkillUsageFilterOptions): SkillUsageEntry[];
/** Default maximum bytes to read from the end of the log file. */
export declare const TAIL_BYTES_DEFAULT: number;
/**
 * Read the last `maxBytes` of the skill-usage JSONL log and parse matching
 * entries. Much faster than `readSkillUsageEntries` for large logs because
 * it reads only a bounded number of bytes from the end of the file instead
 * of loading the entire file into memory.
 *
 * Uses low-level `openSync` / `readSync` / `closeSync` to seek to the last
 * `maxBytes` of the file. Skips the first (potentially partial) line that
 * results from starting mid-file. Best-effort: returns an empty array on any
 * I/O or parse error.
 */
export declare function readSkillUsageEntriesTail(directory: string, filters: {
    sessionID?: string;
}, maxBytes?: number): SkillUsageEntry[];
/**
 * Prune the skill-usage log, keeping at most `maxEntriesPerSkill` entries
 * per unique skillPath. Oldest entries beyond the limit are removed.
 *
 * Writes atomically (temp file + rename). No-op if the log file doesn't
 * exist or all skills are within their limits.
 *
 * @returns Stats about how many entries were pruned and how many remain.
 */
export declare function pruneSkillUsageLog(directory: string, maxEntriesPerSkill?: number): PruneResult;
/**
 * Read a SKILL.md file and extract the `generated_from_knowledge` UUIDs
 * from its YAML frontmatter.
 *
 * Expected frontmatter shape:
 * ```yaml
 * ---
 * name: some-skill
 * generated_from_knowledge:
 *   - uuid-1
 *   - uuid-2
 * ---
 * ```
 *
 * Returns an empty array if the file doesn't exist, has no frontmatter,
 * or the `generated_from_knowledge` key is absent.
 */
export declare function resolveSourceKnowledgeIds(directory: string, skillPath: string): Promise<string[]>;
/**
 * Pure helper: parse `generated_from_knowledge:` YAML list from frontmatter.
 * Uses a minimal regex-based parser — the SKILL.md format is well-known and narrow.
 * Does NOT use a full YAML parser to avoid adding a dependency.
 */
declare function parseGeneratedFromKnowledge(content: string): string[];
/**
 * Read skill-usage entries, resolve source knowledge IDs for each skill,
 * and apply confidence bumps/decays to the originating knowledge entries.
 *
 * For each unique skillPath with at least one compliance or violation entry:
 * 1. Resolve source knowledge UUIDs from the skill's SKILL.md frontmatter.
 * 2. Count compliant and violation events for that skill.
 * 3. Compute net delta: if compliant count > violation count → +0.05; else → -0.1.
 * 4. Call `bumpKnowledgeConfidenceBatch` with the aggregated deltas.
 *
 * @param directory       - Project root directory.
 * @param options.sinceTimestamp - Optional ISO 8601 cutoff; only process entries after this time.
 * @returns Count of processed skills and total confidence bumps/decays applied.
 */
export declare function applySkillUsageFeedback(directory: string, options?: {
    sinceTimestamp?: string;
}): Promise<{
    processed: number;
    bumps: number;
}>;
export {};

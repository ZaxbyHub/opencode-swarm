/**
 * Skill propagation gate — warns when the architect delegates to a
 * skill-capable agent without providing a SKILLS field.
 *
 * Two integration points:
 *
 *   1. `tool.execute.before` — when the architect delegates via the Task
 *      tool to a skill-capable agent (coder, reviewer, test_engineer, sme,
 *      docs, designer) and the SKILLS field is missing or "none" while
 *      skills exist in the project, appends a warning event to
 *      `.swarm/events.jsonl`. This is a SOFT WARNING — it NEVER blocks
 *      tool execution. Also records skill delegation entries to
 *      `.swarm/skill-usage.jsonl` for auditability.
 *
 *   2. `experimental.chat.messages.transform` — scans reviewer output
 *      for SKILL_COMPLIANCE verdicts and records compliance outcomes
 *      to `.swarm/skill-usage.jsonl`.
 */
import * as fs from 'node:fs';
import type { MessageWithParts } from './knowledge-types.js';
import { computeSkillRelevanceScore, formatSkillIndexWithContext } from './skill-scoring.js';
import { appendSkillUsageEntry, readSkillUsageEntries, readSkillUsageEntriesTail } from './skill-usage-log.js';
/** Agents that should receive skill context in delegations. */
export declare const SKILL_CAPABLE_AGENTS: Set<string>;
/**
 * Maximum number of session-scoped skill-usage entries to process for
 * skill scoring. When a session accumulates more entries than this
 * limit, scoring is skipped to prevent unbounded file reads from
 * stalling every delegated Task call.
 */
export declare const MAX_SCORING_SESSION_ENTRIES = 500;
export interface SkillGateInput {
    tool: unknown;
    agent?: unknown;
    sessionID?: unknown;
    args?: unknown;
}
export interface SkillPropagationConfig {
    enabled: boolean;
    /** When true, blocks delegations missing SKILLS field instead of warning. */
    enforce?: boolean;
}
export declare const _internals: {
    readdirSync: typeof fs.readdirSync;
    existsSync: typeof fs.existsSync;
    statSync: typeof fs.statSync;
    mkdirSync: typeof fs.mkdirSync;
    appendFileSync: typeof fs.appendFileSync;
    readFileSync: typeof fs.readFileSync;
    writeFileSync: typeof fs.writeFileSync;
    skillPropagationGateBefore: typeof skillPropagationGateBefore;
    skillPropagationTransformScan: typeof skillPropagationTransformScan;
    SKILL_CAPABLE_AGENTS: Set<string>;
    MAX_SCORING_SESSION_ENTRIES: number;
    writeWarnEvent: typeof writeWarnEvent;
    discoverAvailableSkills: typeof discoverAvailableSkills;
    parseDelegationArgs: typeof parseDelegationArgs;
    appendSkillUsageEntry: typeof appendSkillUsageEntry;
    readSkillUsageEntries: typeof readSkillUsageEntries;
    readSkillUsageEntriesTail: typeof readSkillUsageEntriesTail;
    parseSkillPaths: typeof parseSkillPaths;
    extractTaskIdFromPrompt: typeof extractTaskIdFromPrompt;
    computeSkillRelevanceScore: typeof computeSkillRelevanceScore;
    formatSkillIndexWithContext: typeof formatSkillIndexWithContext;
};
/**
 * Scans project for available skill SKILL.md files.
 * Returns array of relative skill paths (e.g., '.claude/skills/writing-tests/SKILL.md').
 * Best-effort: returns empty array on any error.
 */
export declare function discoverAvailableSkills(directory: string): string[];
/**
 * Parse delegation args to extract target agent name and SKILLS field.
 * Returns { targetAgent, skillsField } or null if not parseable.
 *
 * The args for Task tool are a JSON object with a "subagent_type" field
 * (e.g., "mega_coder") which is the authoritative target agent name, and
 * a "prompt" field containing the delegation text. The SKILLS: line from
 * the prompt (if present) provides the skills field value.
 */
export declare function parseDelegationArgs(args: unknown): {
    targetAgent: string;
    skillsField: string;
} | null;
/** Write a warning event to .swarm/events.jsonl (sync, best-effort). */
export declare function writeWarnEvent(directory: string, record: Record<string, unknown>): void;
/**
 * Parse a SKILLS or SKILLS_USED_BY_CODER field value into individual skill paths.
 * Handles comma-separated paths and strips surrounding whitespace.
 * Returns empty array for empty, "none", or unparseable values.
 */
export declare function parseSkillPaths(fieldValue: string): string[];
/**
 * Extract a task ID from a delegation prompt string.
 * Looks for patterns like "taskId: <id>" or "TASK: <id>" (case-insensitive).
 * Returns "unknown" when no pattern is found.
 */
export declare function extractTaskIdFromPrompt(prompt: string): string;
/**
 * Pre-tool gate. When the architect delegates via Task tool to a skill-capable
 * agent and the SKILLS field is missing or 'none' while skills exist in the
 * project, logs a warning event to events.jsonl and returns a warning string
 * for visible injection into the architect prompt. When config.enforce is true,
 * blocks the delegation entirely instead of merely warning.
 *
 * Also records skill delegation entries to `.swarm/skill-usage.jsonl` when
 * the architect delegates to a skill-capable agent with a non-empty, non-"none"
 * SKILLS field.
 *
 * @returns { blocked: false, reason: null } when no action needed.
 *          { blocked: false, reason: "warning message" } when warning only (enforce=false).
 *          { blocked: true, reason: "blocked: ..." } when blocking (enforce=true).
 */
export declare function skillPropagationGateBefore(directory: string, input: SkillGateInput, config: SkillPropagationConfig): Promise<{
    blocked: boolean;
    reason: string | null;
}>;
/**
 * Chat messages transform hook. Scans reviewer output for SKILL_COMPLIANCE
 * verdicts and records compliance outcomes to `.swarm/skill-usage.jsonl`.
 * Also scans architect messages for skill delegation patterns.
 *
 * Best-effort: never throws; never mutates the messages array.
 */
export declare function skillPropagationTransformScan(directory: string, output: {
    messages?: MessageWithParts[];
}, sessionID?: string): Promise<void>;

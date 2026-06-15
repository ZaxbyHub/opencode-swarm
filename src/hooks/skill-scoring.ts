/**
 * Skill scoring — computes skill relevance scores based on historical
 * usage data from `.swarm/skill-usage.jsonl`.
 *
 * All public functions are pure over their inputs. File I/O goes through
 * `readSkillUsageEntries` (imported from `skill-usage-log.ts`).
 * An `_internals` DI seam mirrors the pattern in `skill-usage-log.ts`
 * and `skill-propagation-gate.ts` for testability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readSkillUsageEntries,
	type SkillUsageEntry,
} from './skill-usage-log.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum usage count before frequency component saturates at 1.0. */
const FREQUENCY_CAP = 10;

/** Weight assigned to historical usage frequency in the composite score. */
const FREQUENCY_WEIGHT = 0.3;

/** Weight assigned to compliance rate in the composite score. */
const COMPLIANCE_WEIGHT = 0.3;

/** Weight assigned to recency in the composite score. */
const RECENCY_WEIGHT = 0.15;

/** Weight assigned to taskID diversity (breadth across tasks) in the composite score. */
const TASK_DIVERSITY_WEIGHT = 0.05;

/** Weight assigned to keyword-based context matching in the composite score. */
const CONTEXT_WEIGHT = 0.2;

/** Additive bonus for workflow-type skills when the task mentions their tools. */
const WORKFLOW_BOOST = 0.1;

/** Additive bonus when a declared skill trigger phrase appears in the task. */
const SKILL_TRIGGER_BOOST = 0.3;

/** Ignore very short trigger strings so broad tokens like "ci" do not dominate. */
const SKILL_TRIGGER_MIN_LENGTH = 3;

/** Bound metadata extracted from skill frontmatter. */
const MAX_SKILL_TRIGGERS = 20;
const MAX_SKILL_TRIGGER_LENGTH = 120;

/**
 * Minimum weighted context score (≈25% task-keyword overlap, since
 * contextScore = matchRatio * CONTEXT_WEIGHT) required before a workflow skill
 * earns the boost. Guards against a single weak keyword match triggering the
 * full bonus, which would dwarf its own tiny context contribution.
 */
const WORKFLOW_BOOST_MIN_CONTEXT = 0.05;

/** Age in milliseconds at which recency score decays to zero (30 days). */
const RECENCY_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum bytes read from a SKILL.md when extracting frontmatter metadata. */
const SKILL_FRONTMATTER_READ_BYTES = 16 * 1024;

// ============================================================================
// Types
// ============================================================================

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
	topAgents: Array<{ agent: string; count: number }>;
}

/** Metadata extracted from a SKILL.md frontmatter block. */
export interface SkillMetadata {
	/** Repo-relative path to the skill file. */
	path: string;
	/** Human-readable skill name. */
	name: string;
	/** Short description from frontmatter, or a fallback when absent. */
	description: string;
	/** Skill type from frontmatter (directive or workflow). */
	skillType?: 'directive' | 'workflow';
	/** Literal trigger phrases from frontmatter. */
	triggers?: string[];
}

// ============================================================================
// DI seam — function references assigned after their declarations at end of file
// ============================================================================

export const _internals: {
	computeSkillRelevanceScore: typeof computeSkillRelevanceScore;
	rankSkillsForContext: typeof rankSkillsForContext;
	getSkillStats: typeof getSkillStats;
	formatSkillIndexWithContext: typeof formatSkillIndexWithContext;
	parseSkillFrontmatter: typeof parseSkillFrontmatter;
	readSkillMetadata: typeof readSkillMetadata;
	extractSkillName: typeof extractSkillName;
	computeRecencyScore: typeof computeRecencyScore;
	computeContextMatchScore: typeof computeContextMatchScore;
	computeTriggerMatchBoost: typeof computeTriggerMatchBoost;
} = {
	computeSkillRelevanceScore:
		null as unknown as typeof computeSkillRelevanceScore,
	rankSkillsForContext: null as unknown as typeof rankSkillsForContext,
	getSkillStats: null as unknown as typeof getSkillStats,
	formatSkillIndexWithContext:
		null as unknown as typeof formatSkillIndexWithContext,
	parseSkillFrontmatter: null as unknown as typeof parseSkillFrontmatter,
	readSkillMetadata: null as unknown as typeof readSkillMetadata,
	extractSkillName: null as unknown as typeof extractSkillName,
	computeRecencyScore: null as unknown as typeof computeRecencyScore,
	computeContextMatchScore: null as unknown as typeof computeContextMatchScore,
	computeTriggerMatchBoost: null as unknown as typeof computeTriggerMatchBoost,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extracts a human-readable skill name from its file path.
 * E.g. `.claude/skills/writing-tests/SKILL.md` → `writing-tests`
 */
function extractSkillName(skillPath: string): string {
	const base = path.basename(skillPath, path.extname(skillPath));
	if (base !== 'SKILL') return base;
	// Fall back to parent directory name
	const parent = path.basename(path.dirname(skillPath));
	return parent;
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function normalizeDescription(description: string): string {
	const singleLine = description.replace(/\s+/g, ' ').trim();
	if (!singleLine) return 'No description provided';
	return singleLine.length > 240
		? `${singleLine.slice(0, 237)}...`
		: singleLine;
}

function normalizeTrigger(value: string): string {
	return stripQuotes(value)
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_SKILL_TRIGGER_LENGTH);
}

function normalizeTriggerList(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of values) {
		const value = normalizeTrigger(raw);
		if (!value) continue;
		const key = value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
		if (out.length >= MAX_SKILL_TRIGGERS) break;
	}
	return out;
}

function parseInlineStringList(rawValue: string): string[] {
	const trimmed = rawValue.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		const body = trimmed.slice(1, -1).trim();
		if (!body) return [];
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return parsed.filter(
					(entry): entry is string => typeof entry === 'string',
				);
			}
		} catch {
			// Fall back to a conservative comma split below.
		}
		return body.split(',').map((entry) => stripQuotes(entry));
	}
	return [trimmed];
}

function collectYamlList(
	lines: string[],
	start: number,
	end: number,
): { values: string[]; nextIndex: number } {
	const values: string[] = [];
	let i = start;
	for (; i < end; i++) {
		const line = lines[i] ?? '';
		if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) break;
		const match = line.match(/^\s+-\s+(.+?)\s*$/);
		if (match) values.push(match[1]);
	}
	return { values, nextIndex: i - 1 };
}

/**
 * Parse the YAML-like frontmatter from a SKILL.md file. This intentionally
 * supports only the small subset skills use today: scalar `name` and scalar,
 * folded (`>`), or literal (`|`) `description`.
 */
export function parseSkillFrontmatter(
	content: string,
	skillPath: string,
): SkillMetadata {
	const normalizedPath = skillPath.replace(/^file:/, '').replace(/\\/g, '/');
	const fallbackName = extractSkillName(normalizedPath);
	const fallback: SkillMetadata = {
		path: normalizedPath,
		name: fallbackName,
		description: 'No description provided',
	};

	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return fallback;

	const end = lines.findIndex(
		(line, index) => index > 0 && line.trim() === '---',
	);
	if (end === -1) return fallback;

	let name = fallbackName;
	let description = '';
	let skillType: 'directive' | 'workflow' | undefined;
	let triggers: string[] = [];

	for (let i = 1; i < end; i++) {
		const line = lines[i] ?? '';
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
		if (!match) continue;

		const key = match[1].toLowerCase();
		const rawValue = match[2].trim();

		if (key === 'name') {
			const parsed = stripQuotes(rawValue);
			if (parsed) name = parsed;
			continue;
		}

		if (key === 'skill_type') {
			if (rawValue === 'directive' || rawValue === 'workflow') {
				skillType = rawValue;
			}
			continue;
		}

		if (key === 'triggers') {
			if (rawValue === '') {
				const collected = collectYamlList(lines, i + 1, end);
				triggers = normalizeTriggerList(collected.values);
				i = collected.nextIndex;
			} else {
				triggers = normalizeTriggerList(parseInlineStringList(rawValue));
			}
			continue;
		}

		if (key !== 'description') continue;

		if (rawValue === '>' || rawValue === '|') {
			const collected: string[] = [];
			for (let j = i + 1; j < end; j++) {
				const next = lines[j] ?? '';
				if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(next)) break;
				collected.push(next.trim());
				i = j;
			}
			description = collected.join(' ');
		} else {
			description = stripQuotes(rawValue);
		}
	}

	const meta: SkillMetadata = {
		path: normalizedPath,
		name: name || fallbackName,
		description: normalizeDescription(description),
	};
	if (skillType) meta.skillType = skillType;
	if (triggers.length > 0) meta.triggers = triggers;
	return meta;
}

function readFilePrefix(filePath: string): string {
	const fd = fs.openSync(filePath, 'r');
	try {
		const buffer = Buffer.alloc(SKILL_FRONTMATTER_READ_BYTES);
		const bytesRead = fs.readSync(
			fd,
			buffer,
			0,
			SKILL_FRONTMATTER_READ_BYTES,
			0,
		);
		return buffer.toString('utf-8', 0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Extract skill metadata from a repo-relative SKILL.md path. Fails open to
 * path-derived metadata when the file is missing, outside the project, or has
 * malformed frontmatter.
 */
export function readSkillMetadata(
	skillPath: string,
	directory: string,
): SkillMetadata {
	const normalizedPath = skillPath.replace(/^file:/, '').replace(/\\/g, '/');
	const fallback = parseSkillFrontmatter('', normalizedPath);

	try {
		if (
			path.isAbsolute(normalizedPath) ||
			normalizedPath.split('/').includes('..')
		) {
			return fallback;
		}
		const root = path.resolve(directory);
		const absolutePath = path.resolve(directory, normalizedPath);
		if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) {
			return fallback;
		}

		const content = readFilePrefix(absolutePath);
		return parseSkillFrontmatter(content, normalizedPath);
	} catch {
		return fallback;
	}
}

/**
 * Computes a recency score in [0, 1] based on how recently the skill was used.
 * Full score (1.0) for usage within 24 hours, linearly decaying to 0 over 30 days.
 */
function computeRecencyScore(lastUsedTimestamp: string): number {
	if (!lastUsedTimestamp) return 0;
	const lastUsed = new Date(lastUsedTimestamp).getTime();
	if (Number.isNaN(lastUsed)) return 0;
	const ageMs = Date.now() - lastUsed;
	if (ageMs <= 0) return 1.0;
	if (ageMs >= RECENCY_DECAY_MS) return 0;
	// Linear decay from 1.0 to 0 over RECENCY_DECAY_MS
	return 1.0 - ageMs / RECENCY_DECAY_MS;
}

/** Minimum word length for keyword extraction (skip short stopwords). */
const MIN_KEYWORD_LENGTH = 3;

/**
 * Extracts lowercase alphanumeric keywords from a string, filtering by minimum length.
 * Splits on non-alphanumeric characters and deduplicates the result.
 */
function extractKeywords(text: string): Set<string> {
	const words = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= MIN_KEYWORD_LENGTH);
	return new Set(words);
}

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
function computeContextMatchScore(
	taskDescription: string,
	skillPath: string,
	metadata?: SkillMetadata,
): number {
	const taskKeywords = extractKeywords(taskDescription);
	if (taskKeywords.size === 0) return 0;

	const skillName = extractSkillName(skillPath);
	const skillText = `${skillPath} ${skillName} ${metadata?.name ?? ''} ${metadata?.description ?? ''}`;
	const skillKeywords = extractKeywords(skillText);

	let matchCount = 0;
	for (const kw of taskKeywords) {
		if (skillKeywords.has(kw)) {
			matchCount++;
		}
	}

	return matchCount / taskKeywords.size;
}

function normalizeTriggerMatchText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function computeTriggerMatchBoost(
	taskDescription: string,
	triggers?: string[],
): number {
	if (!triggers || triggers.length === 0) return 0;
	const task = normalizeTriggerMatchText(taskDescription);
	if (!task) return 0;
	for (const raw of triggers) {
		const trigger = normalizeTriggerMatchText(raw);
		if (trigger.length >= SKILL_TRIGGER_MIN_LENGTH && task.includes(trigger)) {
			return SKILL_TRIGGER_BOOST;
		}
	}
	return 0;
}

// ============================================================================
// Public API
// ============================================================================

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
export function computeSkillRelevanceScore(
	skillPath: string,
	taskDescription: string,
	usageHistory: SkillUsageEntry[],
	metadata?: SkillMetadata,
): number {
	// --- Context component (0-0.20) ---
	const contextScore =
		computeContextMatchScore(taskDescription, skillPath, metadata) *
		CONTEXT_WEIGHT;
	const triggerBoost = computeTriggerMatchBoost(
		taskDescription,
		metadata?.triggers,
	);

	if (usageHistory.length === 0) {
		return Math.min(1.0, contextScore + triggerBoost);
	}

	// --- Frequency component (0-0.3) ---
	const usageCount = usageHistory.length;
	const frequencyScore =
		Math.min(1.0, usageCount / FREQUENCY_CAP) * FREQUENCY_WEIGHT;

	// --- Compliance component (0-0.3) ---
	const entriesWithVerdict = usageHistory.filter(
		(e) =>
			e.complianceVerdict !== undefined &&
			e.complianceVerdict !== 'not_checked',
	);
	const compliantCount = entriesWithVerdict.filter(
		(e) => e.complianceVerdict === 'compliant',
	).length;
	const denominator = Math.max(1, entriesWithVerdict.length);
	const complianceScore = (compliantCount / denominator) * COMPLIANCE_WEIGHT;

	// --- Recency component (0-0.15) ---
	// Sort newest-first by ISO 8601 timestamp
	const sortedByTime = [...usageHistory].sort((a, b) =>
		b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0,
	);
	const lastUsedTimestamp = sortedByTime[0]?.timestamp ?? '';
	const recencyScore = computeRecencyScore(lastUsedTimestamp) * RECENCY_WEIGHT;

	// --- TaskID diversity component (0-0.05) ---
	// Rewards skills used across many distinct tasks vs repeatedly for one task
	const distinctTaskIDs = new Set(
		usageHistory.map((e) => e.taskID).filter(Boolean),
	).size;
	const taskDiversityScore =
		(distinctTaskIDs / Math.max(1, usageHistory.length)) *
		TASK_DIVERSITY_WEIGHT;

	// --- Workflow boost (#1234 Part 4D) ---
	// Workflow-type skills get an additive bonus when the task description
	// meaningfully overlaps the skill's path/name (contextScore is the weighted
	// tool-overlap proxy). A minimum threshold avoids rewarding a single weak
	// keyword match with the full boost.
	let workflowBoost = 0;
	if (
		metadata?.skillType === 'workflow' &&
		contextScore >= WORKFLOW_BOOST_MIN_CONTEXT
	) {
		workflowBoost = WORKFLOW_BOOST;
	}

	return Math.min(
		1.0,
		frequencyScore +
			complianceScore +
			recencyScore +
			taskDiversityScore +
			contextScore +
			triggerBoost +
			workflowBoost,
	);
}

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
export function rankSkillsForContext(
	skills: string[],
	taskContext: string,
	directory: string,
): SkillRankEntry[] {
	const allEntries = readSkillUsageEntries(directory);

	const results: SkillRankEntry[] = [];

	for (const skillPath of skills) {
		const skillEntries = allEntries.filter((e) => e.skillPath === skillPath);
		const metadata = _internals.readSkillMetadata(skillPath, directory);
		const score = computeSkillRelevanceScore(
			skillPath,
			taskContext,
			skillEntries,
			metadata,
		);

		const entriesWithVerdict = skillEntries.filter(
			(e) =>
				e.complianceVerdict !== undefined &&
				e.complianceVerdict !== 'not_checked',
		);
		const compliantCount = entriesWithVerdict.filter(
			(e) => e.complianceVerdict === 'compliant',
		).length;
		const complianceRate =
			entriesWithVerdict.length > 0
				? compliantCount / entriesWithVerdict.length
				: 0;

		results.push({
			skillPath,
			score,
			usageCount: skillEntries.length,
			complianceRate,
		});
	}

	// Sort by score descending; break ties by usage count descending
	results.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return b.usageCount - a.usageCount;
	});

	return results;
}

/**
 * Read usage log and compute aggregate statistics for a single skill.
 *
 * @param skillPath - Repo-relative path to the skill file.
 * @param directory - Project root directory.
 * @returns `SkillStats` with aggregate metrics. Returns zeros/empty when log is missing.
 */
export function getSkillStats(
	skillPath: string,
	directory: string,
): SkillStats {
	const entries = readSkillUsageEntries(directory, { skillPath });

	if (entries.length === 0) {
		return {
			totalUsage: 0,
			complianceRate: 0,
			lastUsed: '',
			topAgents: [],
		};
	}

	// Compliance rate
	const entriesWithVerdict = entries.filter(
		(e) =>
			e.complianceVerdict !== undefined &&
			e.complianceVerdict !== 'not_checked',
	);
	const compliantCount = entriesWithVerdict.filter(
		(e) => e.complianceVerdict === 'compliant',
	).length;
	const complianceRate =
		entriesWithVerdict.length > 0
			? compliantCount / entriesWithVerdict.length
			: 0;

	// Last used (newest timestamp)
	const sortedByTime = [...entries].sort((a, b) =>
		b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0,
	);
	const lastUsed = sortedByTime[0]?.timestamp ?? '';

	// Top agents
	const agentCounts = new Map<string, number>();
	for (const entry of entries) {
		agentCounts.set(
			entry.agentName,
			(agentCounts.get(entry.agentName) ?? 0) + 1,
		);
	}
	const topAgents = Array.from(agentCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([agent, count]) => ({ agent, count }));

	return {
		totalUsage: entries.length,
		complianceRate,
		lastUsed,
		topAgents,
	};
}

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
export function formatSkillIndexWithContext(
	skills: string[],
	directory: string,
): string {
	// Bounded check: just verify the log file exists and has content
	// instead of reading the entire file on every delegation.
	const usageLogPath = path.join(directory, '.swarm', 'skill-usage.jsonl');
	let hasHistory = false;
	try {
		const stat = fs.statSync(usageLogPath);
		hasHistory = stat.size > 0;
	} catch {
		// File doesn't exist — no history yet
	}

	if (!hasHistory) {
		// Simple index without stats, but with enough metadata for agents to
		// decide whether to load the full skill body on demand.
		return skills
			.map((sp) => {
				const meta = _internals.readSkillMetadata(sp, directory);
				return `  - file:${meta.path} - ${meta.name}: ${meta.description}`;
			})
			.join('\n');
	}

	const lines: string[] = [];

	for (const skillPath of skills) {
		const stats = getSkillStats(skillPath, directory);
		const meta = _internals.readSkillMetadata(skillPath, directory);
		const compliancePct = Math.round(stats.complianceRate * 100);
		const topAgentNames = stats.topAgents
			.slice(0, 3)
			.map((a) => a.agent)
			.join(', ');

		lines.push(
			`  - file:${meta.path} - ${meta.name}: ${meta.description} (used: ${stats.totalUsage}, compliance: ${compliancePct}%)` +
				(stats.topAgents.length > 0 ? ` → ${topAgentNames}` : ''),
		);
	}

	return lines.join('\n');
}

// ============================================================================
// Populate function references on DI seam
// ============================================================================

_internals.computeSkillRelevanceScore = computeSkillRelevanceScore;
_internals.rankSkillsForContext = rankSkillsForContext;
_internals.getSkillStats = getSkillStats;
_internals.formatSkillIndexWithContext = formatSkillIndexWithContext;
_internals.parseSkillFrontmatter = parseSkillFrontmatter;
_internals.readSkillMetadata = readSkillMetadata;
_internals.extractSkillName = extractSkillName;
_internals.computeRecencyScore = computeRecencyScore;
_internals.computeContextMatchScore = computeContextMatchScore;
_internals.computeTriggerMatchBoost = computeTriggerMatchBoost;

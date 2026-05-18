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
import * as path from 'node:path';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { warn } from '../utils/logger.js';
import type { MessageWithParts } from './knowledge-types.js';
import {
	computeSkillRelevanceScore,
	formatSkillIndexWithContext,
} from './skill-scoring.js';
import {
	appendSkillUsageEntry,
	readSkillUsageEntries,
	readSkillUsageEntriesTail,
} from './skill-usage-log.js';

// ============================================================================
// Constants
// ============================================================================

/** Agents that should receive skill context in delegations. */
export const SKILL_CAPABLE_AGENTS = new Set([
	'coder',
	'reviewer',
	'test_engineer',
	'sme',
	'docs',
	'designer',
]);

/** Skill root directories to scan for SKILL.md files. */
const SKILL_SEARCH_ROOTS = [
	'.opencode/skills',
	'.opencode/skills/generated',
	'.claude/skills',
];

/**
 * Maximum number of session-scoped skill-usage entries to process for
 * skill scoring. When a session accumulates more entries than this
 * limit, scoring is skipped to prevent unbounded file reads from
 * stalling every delegated Task call.
 */
export const MAX_SCORING_SESSION_ENTRIES = 500;

// ============================================================================
// Types
// ============================================================================

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

// ============================================================================
// DI seam — fs stubs declared before functions that reference them;
// function references assigned after their declarations at end of file.
// ============================================================================

export const _internals: {
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
} = {
	readdirSync: fs.readdirSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	statSync: fs.statSync.bind(fs),
	mkdirSync: fs.mkdirSync.bind(fs),
	appendFileSync: fs.appendFileSync.bind(fs),
	readFileSync: fs.readFileSync.bind(fs),
	writeFileSync: fs.writeFileSync.bind(fs),
	// Function references assigned after declaration (see end of file)
	skillPropagationGateBefore:
		null as unknown as typeof skillPropagationGateBefore,
	skillPropagationTransformScan:
		null as unknown as typeof skillPropagationTransformScan,
	SKILL_CAPABLE_AGENTS,
	MAX_SCORING_SESSION_ENTRIES,
	writeWarnEvent: null as unknown as typeof writeWarnEvent,
	discoverAvailableSkills: null as unknown as typeof discoverAvailableSkills,
	parseDelegationArgs: null as unknown as typeof parseDelegationArgs,
	appendSkillUsageEntry,
	readSkillUsageEntries,
	readSkillUsageEntriesTail,
	parseSkillPaths: null as unknown as typeof parseSkillPaths,
	extractTaskIdFromPrompt: null as unknown as typeof extractTaskIdFromPrompt,
	computeSkillRelevanceScore,
	formatSkillIndexWithContext,
};

// ============================================================================
// Skill discovery
// ============================================================================

/**
 * Scans project for available skill SKILL.md files.
 * Returns array of relative skill paths (e.g., '.claude/skills/writing-tests/SKILL.md').
 * Best-effort: returns empty array on any error.
 */
export function discoverAvailableSkills(directory: string): string[] {
	const results: string[] = [];

	for (const root of SKILL_SEARCH_ROOTS) {
		const rootPath = path.join(directory, root);
		if (!_internals.existsSync(rootPath)) continue;

		let entries: string[];
		try {
			entries = _internals.readdirSync(rootPath);
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.startsWith('.')) continue;
			const skillDir = path.join(rootPath, entry);
			const skillFile = path.join(skillDir, 'SKILL.md');
			try {
				if (
					_internals.statSync(skillDir).isDirectory() &&
					_internals.existsSync(skillFile)
				) {
					results.push(path.join(root, entry, 'SKILL.md'));
				}
			} catch (err) {
				warn(
					`[skill-propagation-gate] failed to stat skill directory ${entry}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	return [...new Set(results)];
}

// ============================================================================
// Delegation parsing
// ============================================================================

/**
 * Parse delegation args to extract target agent name and SKILLS field.
 * Returns { targetAgent, skillsField } or null if not parseable.
 *
 * The args for Task tool are a JSON object with a "subagent_type" field
 * (e.g., "mega_coder") which is the authoritative target agent name, and
 * a "prompt" field containing the delegation text. The SKILLS: line from
 * the prompt (if present) provides the skills field value.
 */
export function parseDelegationArgs(
	args: unknown,
): { targetAgent: string; skillsField: string } | null {
	if (!args || typeof args !== 'object') return null;
	const record = args as Record<string, unknown>;

	// Prefer subagent_type from args — it is the authoritative target agent
	const subagentType =
		typeof record.subagent_type === 'string' ? record.subagent_type : '';

	const prompt = typeof record.prompt === 'string' ? record.prompt : '';

	// We need at least one source of agent identity
	if (!subagentType && !prompt) return null;

	// Determine target agent: subagent_type takes priority, fallback to first
	// non-empty prompt line for backward compatibility
	let targetAgent = subagentType;
	if (!targetAgent && prompt) {
		const lines = prompt.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed) {
				targetAgent = trimmed;
				break;
			}
		}
	}
	if (!targetAgent) return null;

	// Extract SKILLS: field value from prompt text only
	let skillsField = '';
	if (prompt) {
		const lines = prompt.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.startsWith('SKILLS:')) {
				skillsField = trimmed.slice('SKILLS:'.length).trim();
				break;
			}
		}
	}

	return { targetAgent, skillsField };
}

// ============================================================================
// Warning event writer
// ============================================================================

/** Write a warning event to .swarm/events.jsonl (sync, best-effort). */
export function writeWarnEvent(
	directory: string,
	record: Record<string, unknown>,
): void {
	const filePath = path.join(directory, '.swarm', 'events.jsonl');
	try {
		const dir = path.dirname(filePath);
		if (!_internals.existsSync(dir)) {
			_internals.mkdirSync(dir, { recursive: true });
		}
		_internals.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
	} catch (err) {
		warn(
			`[skill-propagation-gate] failed to write warning event: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ============================================================================
// Skill usage recording helpers
// ============================================================================

/**
 * Parse a SKILLS or SKILLS_USED_BY_CODER field value into individual skill paths.
 * Handles comma-separated paths and strips surrounding whitespace.
 * Returns empty array for empty, "none", or unparseable values.
 */
export function parseSkillPaths(fieldValue: string): string[] {
	if (!fieldValue || typeof fieldValue !== 'string') return [];
	const trimmed = fieldValue.trim();
	if (trimmed.toLowerCase() === 'none' || trimmed === '') return [];

	return trimmed
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/**
 * Extract a task ID from a delegation prompt string.
 * Looks for patterns like "taskId: <id>" or "TASK: <id>" (case-insensitive).
 * Returns "unknown" when no pattern is found.
 */
export function extractTaskIdFromPrompt(prompt: string): string {
	if (!prompt || typeof prompt !== 'string') return 'unknown';

	const taskIdMatch = prompt.match(/\btaskId\s*[:=]\s*(\S+)/i);
	if (taskIdMatch) return taskIdMatch[1];

	const taskMatch = prompt.match(/\bTASK\s*[:=]\s*(\S+)/i);
	if (taskMatch) return taskMatch[1];

	return 'unknown';
}

// ============================================================================
// Before-tool hook
// ============================================================================

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
export async function skillPropagationGateBefore(
	directory: string,
	input: SkillGateInput,
	config: SkillPropagationConfig,
): Promise<{ blocked: boolean; reason: string | null }> {
	if (!config.enabled) return { blocked: false, reason: null };

	const toolName = typeof input.tool === 'string' ? input.tool : '';
	if (toolName !== 'task' && toolName !== 'Task')
		return { blocked: false, reason: null };

	const agentRaw = typeof input.agent === 'string' ? input.agent : '';
	if (!agentRaw) return { blocked: false, reason: null };
	const baseAgent = stripKnownSwarmPrefix(agentRaw);
	if (baseAgent !== 'architect') return { blocked: false, reason: null };

	// Parse delegation to find target agent and SKILLS field
	const parsed = _internals.parseDelegationArgs(input.args);
	if (!parsed) return { blocked: false, reason: null };

	// Only process skill-capable target agents
	const targetBase = stripKnownSwarmPrefix(parsed.targetAgent);
	if (!_internals.SKILL_CAPABLE_AGENTS.has(targetBase))
		return { blocked: false, reason: null };

	const sessionID =
		typeof input.sessionID === 'string' ? input.sessionID : 'unknown';

	// --- Discover available skills early (used by scoring and warning blocks) ---
	const availableSkills = _internals.discoverAvailableSkills(directory);

	// --- Record skill delegation usage (best-effort, never block) ---
	const skillsValue = parsed.skillsField.trim();
	if (skillsValue && skillsValue.toLowerCase() !== 'none') {
		const prompt =
			typeof (input.args as Record<string, unknown>)?.prompt === 'string'
				? String((input.args as Record<string, unknown>).prompt)
				: '';
		const taskId = _internals.extractTaskIdFromPrompt(prompt);

		// Parse SKILLS field for primary skill paths
		const skillPaths = _internals.parseSkillPaths(skillsValue);

		// Also parse SKILLS_USED_BY_CODER from prompt if present
		let coderSkillPaths: string[] = [];
		if (prompt) {
			for (const line of prompt.split('\n')) {
				const trimmed = line.trim();
				if (trimmed.startsWith('SKILLS_USED_BY_CODER:')) {
					const fieldVal = trimmed.slice('SKILLS_USED_BY_CODER:'.length).trim();
					coderSkillPaths = _internals.parseSkillPaths(fieldVal);
					break;
				}
			}
		}

		// Combine and deduplicate all skill paths
		const allPaths = [...new Set([...skillPaths, ...coderSkillPaths])];

		for (const skillPath of allPaths) {
			try {
				_internals.appendSkillUsageEntry(directory, {
					skillPath,
					agentName: targetBase,
					taskID: taskId,
					complianceVerdict: 'not_checked',
					sessionID,
					timestamp: new Date().toISOString(),
				});
			} catch (err) {
				warn(
					`[skill-propagation-gate] failed to record skill usage entry: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	// --- Skill scoring: rank available skills by relevance to the task ---
	// Best-effort: errors in scoring never block the hook.
	// Bounded: skip scoring when session has too many entries to avoid
	// unbounded file reads stalling every delegated Task call.
	// Uses ONLY pre-loaded session entries — no additional file reads.
	let scoringSkipped = false;
	let scored: Array<{ skillPath: string; score: number; usageCount: number }> =
		[];
	if (
		skillsValue &&
		skillsValue.toLowerCase() !== 'none' &&
		availableSkills.length > 0
	) {
		try {
			const sessionEntries = _internals.readSkillUsageEntriesTail(directory, {
				sessionID,
			});
			if (sessionEntries.length > _internals.MAX_SCORING_SESSION_ENTRIES) {
				scoringSkipped = true;
				warn(
					`[skill-propagation-gate] skipping scoring — session has ${sessionEntries.length} entries (limit: ${_internals.MAX_SCORING_SESSION_ENTRIES})`,
				);
			} else {
				const prompt =
					typeof (input.args as Record<string, unknown>)?.prompt === 'string'
						? String((input.args as Record<string, unknown>).prompt)
						: '';
				// Score each available skill using pre-loaded session entries (no additional file reads)
				scored = availableSkills
					.map((skillPath) => {
						const skillEntries = sessionEntries.filter(
							(e) => e.skillPath === skillPath,
						);
						const score = _internals.computeSkillRelevanceScore(
							skillPath,
							prompt,
							skillEntries,
						);
						return { skillPath, score, usageCount: skillEntries.length };
					})
					.sort((a, b) => b.score - a.score || b.usageCount - a.usageCount);
				if (scored.length > 0) {
					const topSkills = scored
						.slice(0, 5)
						.map(
							(r) =>
								`  ${r.skillPath} (score: ${r.score.toFixed(3)}, used: ${r.usageCount})`,
						)
						.join('\n');
					warn(
						`[skill-propagation-gate] Skill recommendations for task: ${topSkills}`,
					);
				}
			}
		} catch (err) {
			warn(
				`[skill-propagation-gate] skill scoring failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// --- Skill index auto-population for context.md ---
	// Writes/updates ## Available Skills section in .swarm/context.md so the
	// architect can read available skills without needing to discover them.
	// Runs once per delegation (but is idempotent — replaces existing section).
	// Fail-open: never throws; any error (including formatSkillIndexWithContext
	// throwing) is logged and swallowed.
	if (availableSkills.length > 0) {
		try {
			// When scoring was skipped (budget exceeded), sort skills alphabetically
			// as a stable fallback ordering instead of filesystem discovery order.
			let skillsForIndex = availableSkills;
			if (scoringSkipped) {
				skillsForIndex = [...availableSkills].sort((a, b) => {
					const nameA = path.basename(path.dirname(a));
					const nameB = path.basename(path.dirname(b));
					return nameA.localeCompare(nameB);
				});
			} else if (typeof scored !== 'undefined' && scored.length > 0) {
				skillsForIndex = scored.map((r) => r.skillPath);
			}
			const formattedIndex = _internals.formatSkillIndexWithContext(
				skillsForIndex,
				directory,
			);
			if (formattedIndex.length > 0) {
				const contextPath = path.join(directory, '.swarm', 'context.md');
				let existingContent = '';
				if (_internals.existsSync(contextPath)) {
					existingContent = _internals.readFileSync(contextPath, 'utf-8');
				}

				const sectionHeader = '## Available Skills';
				const newSection = `${sectionHeader}\n${formattedIndex}\n`;

				let updatedContent: string;
				if (existingContent.includes(sectionHeader)) {
					// Replace existing ## Available Skills section
					const sectionStart = existingContent.indexOf(sectionHeader);
					const sectionEnd = existingContent.indexOf(
						'\n## ',
						sectionStart + sectionHeader.length,
					);
					if (sectionEnd !== -1) {
						updatedContent =
							existingContent.slice(0, sectionStart) +
							newSection +
							existingContent.slice(sectionEnd + 1);
					} else {
						// Section at end of file, no following heading
						updatedContent =
							existingContent.slice(0, sectionStart) + newSection;
					}
				} else {
					// Append new section
					if (existingContent.length > 0 && !existingContent.endsWith('\n')) {
						updatedContent = `${existingContent}\n${newSection}`;
					} else {
						updatedContent = existingContent + newSection;
					}
				}

				// Ensure .swarm/ directory exists
				const swarmDir = path.dirname(contextPath);
				if (!_internals.existsSync(swarmDir)) {
					_internals.mkdirSync(swarmDir, { recursive: true });
				}
				_internals.writeFileSync(contextPath, updatedContent, 'utf-8');
			}
		} catch (err) {
			warn(
				`[skill-propagation-gate] failed to write skill index to context.md: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// --- SKILLS_USED_BY_CODER forwarding check ---
	// When delegating to reviewer after coder, warn if SKILLS_USED_BY_CODER is missing
	// AND the coder had skills (skillsValue is non-empty and not "none").
	// Non-blocking: always returns warning, never blocks.
	// targetBase is already declared above (line 339)
	if (targetBase === 'reviewer') {
		const prompt =
			typeof (input.args as Record<string, unknown>)?.prompt === 'string'
				? String((input.args as Record<string, unknown>).prompt)
				: '';
		const hasSkillsUsedByCoder = /SKILLS_USED_BY_CODER\s*:/i.test(prompt);
		const coderHadSkills =
			skillsValue.length > 0 && skillsValue.toLowerCase() !== 'none';
		if (!hasSkillsUsedByCoder && coderHadSkills) {
			const message =
				`SKILLS_USED_BY_CODER warning: Delegating to reviewer without SKILLS_USED_BY_CODER field. ` +
				`Add SKILLS_USED_BY_CODER with the skills the coder received for this task.`;
			return { blocked: false, reason: message };
		}
	}

	// --- Skill propagation warning ---
	// Check if skills exist in the project
	if (availableSkills.length === 0) return { blocked: false, reason: null };

	// Check if SKILLS field is present and not 'none'
	const skillsLower = skillsValue.toLowerCase();
	if (skillsValue && skillsLower !== 'none')
		return { blocked: false, reason: null };

	// Derive human-readable skill names from paths
	const skillNames = availableSkills.map((p) => {
		// e.g. '.claude/skills/writing-tests/SKILL.md' -> 'writing-tests'
		const parts = p.split('/');
		return parts[parts.length - 2] ?? p;
	});

	// Build the visible warning message
	const warningMsg =
		`Skill propagation warning: Delegating to ${targetBase} without SKILLS field. ` +
		`Available skills: ${skillNames.join(', ')}`;

	// Log warning event to events.jsonl (best-effort, never throw)
	// writeWarnEvent is sync and internally catches its own errors
	try {
		_internals.writeWarnEvent(directory, {
			type: 'skill_propagation_warn',
			timestamp: new Date().toISOString(),
			tool: toolName,
			agent: agentRaw,
			target_agent: parsed.targetAgent,
			sessionID,
			skills_missing: true,
			available_skills: availableSkills,
		});
	} catch {
		/* never block tool path — redundant safety since writeWarnEvent
		   already catches internally, but keeps the async contract clean */
	}

	// When enforce mode is active, block the delegation instead of warning
	if (config.enforce) {
		const blockedMsg =
			`Blocked by skill propagation gate: Delegating to ${targetBase} without SKILLS field. ` +
			`Available skills: ${skillNames.join(', ')}. ` +
			`Add a SKILLS: field or set enforce: false in config.`;
		return { blocked: true, reason: blockedMsg };
	}

	return { blocked: false, reason: warningMsg };
}

// ============================================================================
// Chat messages transform hook
// ============================================================================

/** Compliance verdict pattern: SKILL_COMPLIANCE: COMPLIANT|PARTIAL|VIOLATED [— notes] */
const COMPLIANCE_PATTERN =
	/SKILL_COMPLIANCE\s*:\s*(COMPLIANT|PARTIAL|VIOLATED)(?:\s*(?:—|-)\s*(.*))?\s*$/i;

/** Skill path pattern: SKILLS_USED_BY_CODER: <path> */
const CODER_SKILLS_PATTERN = /SKILLS_USED_BY_CODER\s*:\s*(.+)/i;

/**
 * Chat messages transform hook. Scans reviewer output for SKILL_COMPLIANCE
 * verdicts and records compliance outcomes to `.swarm/skill-usage.jsonl`.
 * Also scans architect messages for skill delegation patterns.
 *
 * Best-effort: never throws; never mutates the messages array.
 */
export async function skillPropagationTransformScan(
	directory: string,
	output: { messages?: MessageWithParts[] },
	sessionID?: string,
): Promise<void> {
	if (!output?.messages) return;
	if (!sessionID) return;

	const messages = output.messages;
	let hadRecordingError = false;

	// --- Build dedup set from existing entries for this session ---
	// Prevents duplicate entries when the same message is scanned on
	// repeated messagesTransform calls.
	let dedupKeys = new Set<string>();
	let existingEntries: ReturnType<typeof _internals.readSkillUsageEntriesTail> =
		[];
	try {
		existingEntries = _internals.readSkillUsageEntriesTail(directory, {
			sessionID,
		});
		dedupKeys = new Set<string>(
			existingEntries.map((e, i) => {
				const taskKey = e.taskID === 'unknown' ? `unknown-${i}` : e.taskID;
				return `${e.skillPath}|${e.agentName}|${taskKey}`;
			}),
		);
	} catch (err) {
		warn(
			`[skill-propagation-gate] dedup preload failed, continuing without dedup: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	/**
	 * Check whether an entry with the given key already exists in the log
	 * for this session. Returns true if the entry is a duplicate and should
	 * be skipped.
	 */
	function isDuplicate(
		skillPath: string,
		agentName: string,
		taskID: string,
	): boolean {
		const key = `${skillPath}|${agentName}|${taskID}`;
		if (dedupKeys.has(key)) return true;
		dedupKeys.add(key);
		return false;
	}

	// --- Scan reviewer messages for SKILL_COMPLIANCE verdicts ---
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const agent = m.info?.agent;
		if (
			typeof agent !== 'string' ||
			stripKnownSwarmPrefix(agent) !== 'reviewer'
		) {
			continue;
		}

		const text = (m.parts ?? [])
			.map((p) => (typeof p.text === 'string' ? p.text : ''))
			.join('\n');
		if (!text) continue;

		// Extract SKILLS_USED_BY_CODER paths from the reviewer text
		const skillPaths: string[] = [];
		for (const line of text.split('\n')) {
			const coderMatch = line.trim().match(CODER_SKILLS_PATTERN);
			if (coderMatch) {
				const parsed = _internals.parseSkillPaths(coderMatch[1]);
				skillPaths.push(...parsed);
			}
		}

		// Resolve taskID and skill paths from the latest delegation for
		// compliance attribution. TaskID is always resolved when a delegation
		// exists; skill paths are only populated as fallback when the reviewer
		// didn't include SKILLS_USED_BY_CODER.
		let resolvedTaskID = 'unknown';
		if (existingEntries.length > 0) {
			const latestDelegation = [...existingEntries]
				.reverse()
				.find(
					(e) => e.agentName !== 'reviewer' && e.skillPath !== '__overall__',
				);
			if (latestDelegation) {
				resolvedTaskID = latestDelegation.taskID;
				// Only populate skillPaths as fallback when reviewer didn't echo
				// SKILLS_USED_BY_CODER
				if (skillPaths.length === 0) {
					const delegatedPaths = existingEntries
						.filter(
							(e) =>
								e.agentName !== 'reviewer' &&
								e.skillPath !== '__overall__' &&
								e.taskID === resolvedTaskID,
						)
						.map((e) => e.skillPath);
					if (delegatedPaths.length > 0) {
						skillPaths.push(...new Set(delegatedPaths));
					}
				}
			}
		}

		// Extract SKILL_COMPLIANCE verdict
		for (const line of text.split('\n')) {
			const complianceMatch = line.trim().match(COMPLIANCE_PATTERN);
			if (!complianceMatch) continue;

			const verdict = complianceMatch[1].toLowerCase();
			const notes = (complianceMatch[2] ?? '').trim();

			// Record an entry per skill path; if no skill paths found,
			// record a single entry with the verdict
			const paths = skillPaths.length > 0 ? skillPaths : ['__overall__'];

			for (const skillPath of paths) {
				if (hadRecordingError) break;
				if (isDuplicate(skillPath, 'reviewer', resolvedTaskID)) continue;
				try {
					_internals.appendSkillUsageEntry(directory, {
						skillPath,
						agentName: 'reviewer',
						taskID: resolvedTaskID,
						complianceVerdict: verdict,
						reviewerNotes: notes || undefined,
						sessionID,
						timestamp: new Date().toISOString(),
					});
				} catch (err) {
					hadRecordingError = true;
					warn(
						`[skill-propagation-gate] transform-scan compliance recording failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			break; // only process the first compliance verdict per message
		}

		// Only scan the most recent reviewer message
		break;
	}

	// --- Scan architect messages for skill delegation patterns ---
	if (hadRecordingError) return;

	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const agent = m.info?.agent;
		if (
			typeof agent !== 'string' ||
			stripKnownSwarmPrefix(agent) !== 'architect'
		) {
			continue;
		}

		const text = (m.parts ?? [])
			.map((p) => (typeof p.text === 'string' ? p.text : ''))
			.join('\n');
		if (!text) continue;

		// Look for delegation patterns containing SKILLS: field
		let currentTargetAgent = '';
		let skillsField = '';

		for (const line of text.split('\n')) {
			const trimmed = line.trim();

			// Detect delegation to a skill-capable agent
			if (
				trimmed.match(/TO\s+(coder|reviewer|test_engineer|sme|docs|designer)/i)
			) {
				const agentMatch = trimmed.match(
					/TO\s+(coder|reviewer|test_engineer|sme|docs|designer)/i,
				);
				if (agentMatch) currentTargetAgent = agentMatch[1].toLowerCase();
			}

			if (trimmed.startsWith('SKILLS:')) {
				skillsField = trimmed.slice('SKILLS:'.length).trim();
			}

			// When we have both, record and reset
			if (
				currentTargetAgent &&
				skillsField &&
				skillsField.toLowerCase() !== 'none'
			) {
				const skillPaths = _internals.parseSkillPaths(skillsField);
				const taskId = _internals.extractTaskIdFromPrompt(text);

				for (const skillPath of skillPaths) {
					if (hadRecordingError) break;
					if (isDuplicate(skillPath, currentTargetAgent, taskId)) continue;
					try {
						_internals.appendSkillUsageEntry(directory, {
							skillPath,
							agentName: currentTargetAgent,
							taskID: taskId,
							complianceVerdict: 'not_checked',
							sessionID,
							timestamp: new Date().toISOString(),
						});
					} catch (err) {
						hadRecordingError = true;
						warn(
							`[skill-propagation-gate] transform-scan delegation recording failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				currentTargetAgent = '';
				skillsField = '';
			}
		}

		// Only scan the most recent architect message
		break;
	}
}

// ============================================================================
// Populate function references on DI seam (functions now declared above)
// ============================================================================

_internals.skillPropagationGateBefore = skillPropagationGateBefore;
_internals.skillPropagationTransformScan = skillPropagationTransformScan;
_internals.writeWarnEvent = writeWarnEvent;
_internals.discoverAvailableSkills = discoverAvailableSkills;
_internals.parseDelegationArgs = parseDelegationArgs;
_internals.parseSkillPaths = parseSkillPaths;
_internals.extractTaskIdFromPrompt = extractTaskIdFromPrompt;
_internals.formatSkillIndexWithContext = formatSkillIndexWithContext;

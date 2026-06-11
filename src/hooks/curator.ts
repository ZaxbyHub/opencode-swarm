/**
 * Curator core — file I/O for curator summary persistence.
 * Extended incrementally: filterPhaseEvents, checkPhaseCompliance,
 * runCuratorInit, runCuratorPhase, applyCuratorKnowledgeUpdates added in subsequent tasks.
 *
 * LLM delegation: runCuratorPhase and runCuratorInit accept an optional llmDelegate
 * callback for LLM-based analysis. When provided, the prepared data context is sent
 * to the explorer agent in CURATOR_PHASE/CURATOR_INIT mode for richer analysis.
 * When the delegate is absent or fails, falls back to data-only behavior.
 *
 * ## Curator Agent Dispatch Modes
 *
 * Curator agents are dispatched in two ways:
 *
 * 1. **Factory dispatch** (standard): Created via `createCuratorAgent` from curator-agent.ts,
 *    exposed through agents/index.ts. These appear in agent lists and are part of the
 *    standard agent factory.
 *
 * 2. **Hook dispatch** (internal): curator.ts imports CURATOR_INIT_PROMPT and CURATOR_PHASE_PROMPT
 *    from explorer.ts and dispatches curator analysis directly via hook callbacks. These
 *    hook-dispatched curators do NOT go through the standard agent factory and are NOT
 *    included in agent lists (e.g., AGENTS.md, agent discovery, the agent registry).
 *
 * This dual dispatch means agent lists are incomplete — they capture factory-dispatched
 * curators but omit hook-dispatched ones. This is by design for hook-internal operations.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	CURATOR_INIT_PROMPT,
	CURATOR_PHASE_PROMPT,
} from '../agents/explorer.js';
import { getGlobalEventBus } from '../background/event-bus.js';
import { getCanonicalAgentRole } from '../config/schema.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	listSkills,
	parseDraftFrontmatter,
	retireSkill,
} from '../services/skill-generator.js';
import { swarmState } from '../state.js';
import { bunWrite } from '../utils/bun-compat';
import * as logger from '../utils/logger';
import type {
	ComplianceObservation,
	CuratorConfig,
	CuratorInitResult,
	CuratorPhaseResult,
	CuratorSummary,
	KnowledgeRecommendation,
	PhaseDigestEntry,
} from './curator-types.js';
import {
	appendKnowledge,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import {
	appendUnactionable,
	validateActionability,
	validateLesson,
} from './knowledge-validator.js';
import { readSkillUsageEntries } from './skill-usage-log.js';
import { readSwarmFileAsync, validateSwarmPath } from './utils.js';

/**
 * Optional LLM delegate callback type.
 * Takes a system prompt and user input, returns the LLM output text.
 * Used to delegate analysis to the explorer agent in CURATOR mode.
 */
export type CuratorLLMDelegate = (
	systemPrompt: string,
	userInput: string,
	signal?: AbortSignal,
) => Promise<string>;

/** Default timeout for curator LLM delegation calls (ms).
 * Used as fallback when config.llm_timeout_ms is not set. */
const DEFAULT_CURATOR_LLM_TIMEOUT_MS = 300_000;

// ============================================================================
// DI Seam — _internals (declared before functions that use it to avoid TDZ)
// ============================================================================

export const _internals = {
	parseKnowledgeRecommendations,
	readCuratorSummary,
	writeCuratorSummary,
	filterPhaseEvents,
	checkPhaseCompliance,
	normalizeAgentName,
	autoRetireSkills,
	readSkillUsageEntries,
	listSkills,
	parseDraftFrontmatter,
	retireSkill,
	readFileAsync: (filePath: string, encoding: string) =>
		import('node:fs/promises').then((fs) =>
			fs.readFile(filePath, encoding as BufferEncoding),
		),
	readKnowledge,
};

/**
 * Auto-retire generated skills whose violation rate exceeds 30% or
 * whose source knowledge entries are all archived.
 *
 * Non-blocking: errors are caught and logged but never propagated.
 * Returns an array of observation strings to include in the phase digest.
 */
async function autoRetireSkills(
	directory: string,
	curatorKnowledgePath: string,
): Promise<string[]> {
	const observations: string[] = [];
	try {
		const skillListResult = await _internals.listSkills(directory);
		const usageEntries = _internals.readSkillUsageEntries(directory);

		for (const active of skillListResult.active) {
			const skillUsage = usageEntries.filter((e) => {
				let p = e.skillPath;
				if (p.startsWith('file:')) p = p.slice(5);
				// Normalize both paths to forward slashes for comparison
				const normalizedUsage = p.replace(/\\/g, '/');
				const normalizedActive = active.path.replace(/\\/g, '/');
				// Exact match, or suffix match for relative vs absolute paths
				if (normalizedUsage === normalizedActive) return true;
				if (normalizedActive.endsWith(`/${normalizedUsage}`)) return true;
				if (normalizedUsage.endsWith(`/${normalizedActive}`)) return true;
				return false;
			});

			const violations = skillUsage.filter(
				(e) => e.complianceVerdict === 'violation',
			).length;
			const violationRate =
				skillUsage.length > 0 ? violations / skillUsage.length : 0;

			// Check if all source knowledge is archived
			let allArchived = false;
			try {
				const content = await _internals.readFileAsync(active.path, 'utf-8');
				const fm = _internals.parseDraftFrontmatter(content);
				if (fm && fm.sourceKnowledgeIds.length > 0) {
					const swarmKnowledge =
						await _internals.readKnowledge<SwarmKnowledgeEntry>(
							curatorKnowledgePath,
						);
					let hiveKnowledge: HiveKnowledgeEntry[] = [];
					try {
						const hivePath = resolveHiveKnowledgePath();
						if (fs.existsSync(hivePath)) {
							hiveKnowledge =
								await _internals.readKnowledge<HiveKnowledgeEntry>(hivePath);
						}
					} catch {
						/* hive not available — non-blocking */
					}
					const allKnowledge = [...swarmKnowledge, ...hiveKnowledge];
					const sourceIds = new Set(fm.sourceKnowledgeIds);
					const sources = allKnowledge.filter((e) => sourceIds.has(e.id));
					allArchived =
						sources.length === sourceIds.size &&
						sources.every((e) => e.status === 'archived');
				}
			} catch {
				/* best effort frontmatter read */
			}

			if (violationRate > 0.3 || allArchived) {
				const reason =
					violationRate > 0.3
						? `auto-retire: violation rate ${(violationRate * 100).toFixed(0)}% exceeds 30% threshold`
						: 'auto-retire: all source knowledge entries archived';
				await _internals.retireSkill(directory, active.slug, reason);
				observations.push(`Skill '${active.slug}' auto-retired: ${reason}`);
				logger.warn(`[curator] ${observations[observations.length - 1]}`);
			}
		}
	} catch (autoRetireErr) {
		// Non-blocking — log but don't fail curator
		logger.warn(
			`[curator] auto-retire health check failed: ${autoRetireErr instanceof Error ? autoRetireErr.message : String(autoRetireErr)}`,
		);
	}
	return observations;
}

/**
 * Parse OBSERVATIONS section from curator LLM output.
 * Expected format per line: "- entry <uuid> (<observable>): [text]"
 * Observable types: appears high-confidence, appears stale, could be tighter,
 * contradicts project state, new candidate
 * Action hints are extracted from parenthetical directives like "(suggests boost confidence, mark hive_eligible)"
 */
export function parseKnowledgeRecommendations(
	llmOutput: string,
): KnowledgeRecommendation[] {
	const recommendations: KnowledgeRecommendation[] = [];
	const UUID_V4 =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

	// Parse OBSERVATIONS: section (legacy format: "- entry <uuid> (parenthetical): text")
	const obsSection = llmOutput.match(
		/OBSERVATIONS:\s*\n([\s\S]*?)(?:\n\n|\n[A-Z_]+:|$)/,
	);
	if (obsSection) {
		const lines = obsSection[1].split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('-')) continue;

			// Match "- entry <uuid> (observable): text" or "- entry <uuid> (observable, directive hint): text"
			const match = trimmed.match(/^-\s+entry\s+(\S+)\s+\(([^)]+)\):\s+(.+)$/i);
			if (!match) continue;

			const uuid = match[1];
			const parenthetical = match[2];
			const text = match[3].trim().replace(/\s+\([^)]+\)$/, '');

			// Determine entryId: only treat as real UUID if UUID v4 format
			const entryId = uuid === 'new' || !UUID_V4.test(uuid) ? undefined : uuid;

			// Extract action hint from parenthetical content
			let action: KnowledgeRecommendation['action'] = 'rewrite';
			const lowerParenthetical = parenthetical.toLowerCase();

			if (
				lowerParenthetical.includes('suggests boost confidence') ||
				lowerParenthetical.includes('mark hive_eligible') ||
				lowerParenthetical.includes('appears high-confidence')
			) {
				action = 'promote';
			} else if (
				lowerParenthetical.includes('suggests archive') ||
				lowerParenthetical.includes('appears stale')
			) {
				action = 'archive';
			} else if (lowerParenthetical.includes('contradicts project state')) {
				action = 'flag_contradiction';
			} else if (
				lowerParenthetical.includes('suggests rewrite') ||
				lowerParenthetical.includes('could be tighter')
			) {
				action = 'rewrite';
			} else if (lowerParenthetical.includes('new candidate')) {
				action = 'promote';
			}

			recommendations.push({
				action,
				entry_id: entryId,
				lesson: text,
				reason: text,
			});
		}
	}

	// Parse KNOWLEDGE_UPDATES: section (direct format: "- <action> <id>: <text>")
	const updatesSection = llmOutput.match(
		/KNOWLEDGE_UPDATES:\s*\n([\s\S]*?)(?:\n\n|\n[A-Z_]+:|$)/,
	);
	if (updatesSection) {
		const validActions = new Set([
			'promote',
			'archive',
			'rewrite',
			'flag_contradiction',
		]);
		const lines = updatesSection[1].split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('-')) continue;

			// Match "- <action> <id>: <text>"
			const match = trimmed.match(/^-\s+(\S+)\s+(\S+):\s+(.+)$/);
			if (!match) continue;

			const action = match[1].toLowerCase();
			if (!validActions.has(action)) continue;

			const id = match[2];
			const text = match[3].trim();
			const entryId = UUID_V4.test(id) ? id : undefined;

			recommendations.push({
				action: action as KnowledgeRecommendation['action'],
				entry_id: entryId,
				lesson: text,
				reason: text,
			});
		}
	}

	return recommendations;
}

/**
 * v2: Strict-JSON parser for the new curator output blocks.
 *
 * Curator prompts may now emit JSON-fenced blocks like:
 *
 * ```json knowledge_application_findings
 * [{ "knowledge_id": "...", "expected_behavior": "...", ... }]
 * ```
 *
 * ```json skill_candidates
 * [{ "slug": "...", "title": "...", ... }]
 * ```
 *
 * Malformed JSON or unexpected types are silently dropped: no knowledge or
 * skill writes happen when curator output is malformed.
 */
export function parseStructuredCuratorBlocks(llmOutput: string): {
	findings: import('./curator-types.js').KnowledgeApplicationFinding[];
	candidates: import('./curator-types.js').SkillCandidate[];
} {
	const out: {
		findings: import('./curator-types.js').KnowledgeApplicationFinding[];
		candidates: import('./curator-types.js').SkillCandidate[];
	} = { findings: [], candidates: [] };
	if (!llmOutput || typeof llmOutput !== 'string') return out;

	const fences =
		/```(?:json|jsonc)?\s+(knowledge_application_findings|skill_candidates)\s*\n([\s\S]*?)\n```/g;
	for (const m of llmOutput.matchAll(fences)) {
		const kind = m[1];
		const body = m[2];
		try {
			const parsed = JSON.parse(body);
			if (!Array.isArray(parsed)) continue;
			if (kind === 'knowledge_application_findings') {
				for (const item of parsed) {
					if (!item || typeof item !== 'object') continue;
					const knowledge_id = (item as { knowledge_id?: unknown })
						.knowledge_id;
					const verdict = (item as { verdict?: unknown }).verdict;
					if (
						typeof knowledge_id !== 'string' ||
						typeof verdict !== 'string' ||
						!['applied', 'ignored', 'violated', 'not_applicable'].includes(
							verdict,
						)
					) {
						continue;
					}
					const expected = String(
						(item as { expected_behavior?: unknown }).expected_behavior ?? '',
					).slice(0, 500);
					const observed = String(
						(item as { observed_behavior?: unknown }).observed_behavior ?? '',
					).slice(0, 500);
					const refs = Array.isArray(
						(item as { evidence_refs?: unknown }).evidence_refs,
					)
						? (
								(item as { evidence_refs: unknown[] }).evidence_refs.filter(
									(r) => typeof r === 'string',
								) as string[]
							).slice(0, 20)
						: [];
					out.findings.push({
						knowledge_id,
						expected_behavior: expected,
						observed_behavior: observed,
						verdict: verdict as
							| 'applied'
							| 'ignored'
							| 'violated'
							| 'not_applicable',
						evidence_refs: refs,
					});
				}
			} else if (kind === 'skill_candidates') {
				for (const item of parsed) {
					if (!item || typeof item !== 'object') continue;
					const slug = (item as { slug?: unknown }).slug;
					const title = (item as { title?: unknown }).title;
					if (typeof slug !== 'string' || typeof title !== 'string') continue;
					const ids = Array.isArray(
						(item as { source_knowledge_ids?: unknown }).source_knowledge_ids,
					)
						? (
								(
									item as { source_knowledge_ids: unknown[] }
								).source_knowledge_ids.filter(
									(s) => typeof s === 'string',
								) as string[]
							).slice(0, 50)
						: [];
					if (ids.length === 0) continue;
					out.candidates.push({
						slug: String(slug).slice(0, 64),
						title: String(title).slice(0, 200),
						source_knowledge_ids: ids,
						trigger: String(
							(item as { trigger?: unknown }).trigger ?? '',
						).slice(0, 200),
						required_procedure: arrayOfStrings(
							(item as { required_procedure?: unknown }).required_procedure,
						),
						forbidden_shortcuts: arrayOfStrings(
							(item as { forbidden_shortcuts?: unknown }).forbidden_shortcuts,
						),
						target_agents: arrayOfStrings(
							(item as { target_agents?: unknown }).target_agents,
						),
						reviewer_checks: arrayOfStrings(
							(item as { reviewer_checks?: unknown }).reviewer_checks,
						),
						confidence: clampConf(
							(item as { confidence?: unknown }).confidence,
						),
						reason: String((item as { reason?: unknown }).reason ?? '').slice(
							0,
							280,
						),
					});
				}
			}
		} catch {
			// malformed JSON — silently skip; never mutate knowledge from bad output.
		}
	}
	return out;
}

function arrayOfStrings(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v
		.filter((x) => typeof x === 'string')
		.map((x) => (x as string).slice(0, 200))
		.slice(0, 20);
}

function clampConf(v: unknown): number {
	if (typeof v !== 'number') return 0.85;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}

/**
 * Read curator summary from .swarm/curator-summary.json
 * @param directory - The workspace directory
 * @returns CuratorSummary if valid, null if missing or invalid
 */
export async function readCuratorSummary(
	directory: string,
): Promise<CuratorSummary | null> {
	const content = await readSwarmFileAsync(directory, 'curator-summary.json');

	if (content === null) {
		return null;
	}

	try {
		const parsed = JSON.parse(content) as CuratorSummary;

		if (parsed.schema_version !== 1) {
			logger.warn(
				`Curator summary has unsupported schema version: ${parsed.schema_version}. Expected 1.`,
			);
			return null;
		}

		return parsed;
	} catch {
		logger.warn('Failed to parse curator-summary.json: invalid JSON');
		return null;
	}
}

/**
 * Write curator summary to .swarm/curator-summary.json
 * @param directory - The workspace directory
 * @param summary - The curator summary to write
 */
export async function writeCuratorSummary(
	directory: string,
	summary: CuratorSummary,
): Promise<void> {
	const resolvedPath = validateSwarmPath(directory, 'curator-summary.json');

	// Ensure .swarm/ directory exists
	fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

	// Atomic write: write to temp file then rename
	const tempPath = `${resolvedPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
	await bunWrite(tempPath, JSON.stringify(summary, null, 2));
	fs.renameSync(tempPath, resolvedPath);
}

/**
 * Normalize an agent name to its canonical role.
 *
 * v2 (Phase F′ remediation): use the repository's canonical resolver
 * `getCanonicalAgentRole`, registry-aware. When the generated-agent registry
 * is populated (post plugin-init), an arbitrary swarm id like
 * `banana_coder` resolves to `coder` IFF it appears in the registry.
 * Pre-init (registry empty), the resolver falls back to a permissive
 * suffix-match against ALL_AGENT_NAMES — preserving today's behaviour for
 * arbitrary user prefixes without the hard-coded
 * `(mega|paid|local|lowtier|modelrelay)_` whitelist.
 *
 * Lower-casing is preserved for backwards compatibility with the prior
 * comparator code paths in this file.
 */
function normalizeAgentName(name: string): string {
	const registry =
		swarmState.generatedAgentNames.length > 0
			? swarmState.generatedAgentNames
			: undefined;
	return getCanonicalAgentRole(name, registry).toLowerCase();
}

/**
 * Filter events from JSONL by phase or timestamp.
 * @param eventsJsonl - Raw JSONL string of events
 * @param phase - Phase number to filter by
 * @param sinceTimestamp - Optional ISO 8601 timestamp to filter events after
 * @returns Array of parsed event objects
 */
export function filterPhaseEvents(
	eventsJsonl: string,
	phase: number,
	sinceTimestamp?: string,
): object[] {
	const lines = eventsJsonl.split('\n');
	const filtered: object[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		try {
			const event = JSON.parse(line);

			if (sinceTimestamp) {
				// Include all events after the timestamp
				if (event.timestamp > sinceTimestamp) {
					filtered.push(event);
				}
			} else {
				// Filter by phase
				if ((event as Record<string, unknown>).phase === phase) {
					filtered.push(event);
				}
			}
		} catch {
			logger.warn('filterPhaseEvents: skipping malformed line');
		}
	}

	return filtered;
}

/**
 * Check compliance for a phase based on events and dispatched agents.
 * @param phaseEvents - Array of events for the phase
 * @param agentsDispatched - List of agent names that were dispatched
 * @param requiredAgents - List of required agent names for this phase
 * @param phase - Phase number
 * @returns Array of compliance observations
 */
export function checkPhaseCompliance(
	phaseEvents: object[],
	agentsDispatched: string[],
	requiredAgents: string[],
	phase: number,
): ComplianceObservation[] {
	const observations: ComplianceObservation[] = [];
	const timestamp = new Date().toISOString();

	// Check 1: Missing required agents
	for (const agent of requiredAgents) {
		const normalizedAgent = _internals.normalizeAgentName(agent);
		const isDispatched = agentsDispatched.some(
			(a) => _internals.normalizeAgentName(a) === normalizedAgent,
		);

		if (!isDispatched) {
			observations.push({
				phase,
				timestamp,
				type: 'workflow_deviation',
				severity: 'warning',
				description: `Agent '${agent}' required but not dispatched in phase ${phase}`,
			});
		}
	}

	// Check 2: Reviewer after every coder delegation

	const coderDelegations: { event: object; index: number }[] = [];
	const reviewerDelegations: { event: object; index: number }[] = [];

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			if ((e as Record<string, unknown>).type === 'agent.delegation') {
				const agent = (e as Record<string, unknown>).agent;
				if (agent && typeof agent === 'string') {
					const normalized = _internals.normalizeAgentName(agent);
					if (normalized === 'coder') {
						coderDelegations.push({ event: e, index: i });
					} else if (normalized === 'reviewer') {
						reviewerDelegations.push({ event: e, index: i });
					}
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	for (const coderEvent of coderDelegations) {
		const hasSubsequentReviewer = reviewerDelegations.some(
			(r) => r.index > coderEvent.index,
		);

		if (!hasSubsequentReviewer) {
			observations.push({
				phase,
				timestamp,
				type: 'missing_reviewer',
				severity: 'warning',
				description: `Coder delegation in phase ${phase} has no subsequent reviewer delegation`,
			});
		}
	}

	// Check 3: Retrospective before phase_complete
	let phaseCompleteIndex = -1;
	let retroIndex = -1;

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			// v2 baseline fix: some emitters use {type: ...} and some use {event: ...}.
			// Accept either so phase events emitted under the legacy 'event' key are
			// still recognised (e.g. when phase_complete writes via different paths).
			const eventType =
				(e as Record<string, unknown>).type ??
				(e as Record<string, unknown>).event;
			const evidenceType = (e as Record<string, unknown>).evidence_type;

			if (
				typeof eventType === 'string' &&
				(eventType === 'phase_complete' || eventType === 'phase.complete')
			) {
				phaseCompleteIndex = i;
			}
			if (
				(typeof eventType === 'string' &&
					eventType === 'retrospective.written') ||
				(typeof evidenceType === 'string' && evidenceType === 'retrospective')
			) {
				retroIndex = i;
			}
		} catch {
			// Skip events that fail access
		}
	}

	if (phaseCompleteIndex !== -1 && retroIndex === -1) {
		observations.push({
			phase,
			timestamp,
			type: 'missing_retro',
			severity: 'warning',
			description: `Phase ${phase} completed without retrospective evidence`,
		});
	}

	// Check 4: SME after domain detection
	const domainDetectionEvents: { event: object; index: number }[] = [];
	const smeDelegations: { event: object; index: number }[] = [];

	for (let i = 0; i < phaseEvents.length; i++) {
		const e = phaseEvents[i];
		try {
			if ((e as Record<string, unknown>).type === 'domains.detected') {
				domainDetectionEvents.push({ event: e, index: i });
			}
			if (
				(e as Record<string, unknown>).type === 'agent.delegation' &&
				(e as Record<string, unknown>).agent
			) {
				const agent = (e as Record<string, unknown>).agent;
				if (agent && typeof agent === 'string') {
					const normalized = _internals.normalizeAgentName(agent);
					if (normalized === 'sme') {
						smeDelegations.push({ event: e, index: i });
					}
				}
			}
		} catch {
			// Skip events that fail access
		}
	}

	for (const domainEvent of domainDetectionEvents) {
		const hasSubsequentSme = smeDelegations.some(
			(s) => s.index > domainEvent.index,
		);

		if (!hasSubsequentSme) {
			observations.push({
				phase,
				timestamp,
				type: 'missing_sme',
				severity: 'info',
				description: `Domains detected in phase ${phase} but no SME consultation found`,
			});
		}
	}

	return observations;
}

/**
 * Prepare curator init data: reads prior summary, knowledge entries, and context.md.
 * When an llmDelegate is provided, delegates to the explorer agent in CURATOR_INIT mode
 * for LLM-based analysis that enhances the data-only briefing.
 * @param directory - The workspace directory
 * @param config - Curator configuration
 * @param llmDelegate - Optional LLM delegate for enhanced analysis
 * @returns CuratorInitResult with briefing text, contradictions, and stats
 */
export async function runCuratorInit(
	directory: string,
	config: CuratorConfig,
	llmDelegate?: CuratorLLMDelegate,
): Promise<CuratorInitResult> {
	try {
		// 1. Read prior curator summary
		const priorSummary = await _internals.readCuratorSummary(directory);

		// 2. Read high-confidence knowledge entries
		const knowledgePath = resolveSwarmKnowledgePath(directory);
		const allEntries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
		const highConfidenceEntries = allEntries.filter(
			(e) =>
				typeof e.confidence === 'number' &&
				e.confidence >= config.min_knowledge_confidence,
		);

		// 3. Read context.md
		const contextMd = await readSwarmFileAsync(directory, 'context.md');

		// 4. Build briefing text from available data
		const briefingParts: string[] = [];

		if (priorSummary) {
			briefingParts.push(
				`## Prior Session Summary (Phase ${priorSummary.last_phase_covered})`,
			);
			briefingParts.push(priorSummary.digest);

			if (
				priorSummary.compliance_observations.length > 0 &&
				!config.suppress_warnings
			) {
				briefingParts.push('\n## Compliance Observations');
				for (const obs of priorSummary.compliance_observations) {
					briefingParts.push(
						`- [${obs.severity.toUpperCase()}] Phase ${obs.phase}: ${obs.description}`,
					);
				}
			}

			if (priorSummary.knowledge_recommendations.length > 0) {
				briefingParts.push('\n## Knowledge Recommendations');
				for (const rec of priorSummary.knowledge_recommendations) {
					briefingParts.push(`- ${rec.action}: ${rec.lesson} (${rec.reason})`);
				}
			}
		} else {
			briefingParts.push('## First Session — No Prior Summary');
			briefingParts.push(
				'This is the first curator run for this project. No prior phase data available.',
			);
		}

		if (highConfidenceEntries.length > 0) {
			briefingParts.push('\n## High-Confidence Knowledge');
			for (const entry of highConfidenceEntries.slice(0, 10)) {
				// Cap at 10 entries to stay within token budget
				const lesson =
					typeof entry.lesson === 'string'
						? entry.lesson
						: JSON.stringify(entry.lesson);
				briefingParts.push(`- ${lesson}`);
			}
		}

		if (contextMd) {
			briefingParts.push('\n## Context Summary');
			// Truncate to stay within token budget (approx 4 chars per token)
			const maxContextChars = config.max_summary_tokens * 2;
			briefingParts.push(contextMd.slice(0, maxContextChars));
		}

		// 5. Find contradictions in knowledge entries (entries with 'contradiction' in tags)
		const contradictions = allEntries
			.filter(
				(e) =>
					Array.isArray(e.tags) &&
					e.tags.some((t: string) => t.includes('contradiction')),
			)
			.map((e) =>
				typeof e.lesson === 'string' ? e.lesson : JSON.stringify(e.lesson),
			);

		let briefingText = briefingParts.join('\n');

		// 6. LLM delegation: enhance briefing with CURATOR_INIT agent analysis
		// Pass all entries (capped at 30) with IDs for curator review
		const allEntriesForCurator = [...allEntries]
			.sort(
				(a, b) =>
					new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
			)
			.slice(0, 30)
			.map((e) => ({
				id: e.id,
				lesson: e.lesson,
				status: e.status,
				confidence: e.confidence,
				category: e.category,
			}));

		if (llmDelegate) {
			try {
				const userInput = [
					'TASK: CURATOR_INIT',
					`PRIOR_SUMMARY: ${priorSummary ? JSON.stringify(priorSummary) : 'none'}`,
					`KNOWLEDGE_ENTRIES: ${JSON.stringify(allEntriesForCurator)}`,
					`PROJECT_CONTEXT: ${contextMd?.slice(0, config.max_summary_tokens * 2) ?? 'none'}`,
				].join('\n');

				const systemPrompt = CURATOR_INIT_PROMPT;
				const timeoutMs =
					config.llm_timeout_ms ?? DEFAULT_CURATOR_LLM_TIMEOUT_MS;
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), timeoutMs);
				let llmOutput: string;
				try {
					// Hoist the delegate promise so we can attach a no-op catch
					// before the race. Without this, if the timeout fires first,
					// the delegate promise becomes the race loser and its
					// subsequent rejection (NotFoundError from the deleted
					// ephemeral session) would be an unhandled rejection.
					const delegatePromise = llmDelegate(
						systemPrompt,
						userInput,
						ac.signal,
					);
					void delegatePromise.catch(() => {});
					llmOutput = await Promise.race([
						delegatePromise,
						new Promise<never>((_, reject) => {
							ac.signal.addEventListener('abort', () =>
								reject(new Error('CURATOR_LLM_TIMEOUT')),
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}

				// Enhance briefing with LLM output if available
				if (llmOutput?.trim()) {
					briefingText = `${briefingText}\n\n## LLM-Enhanced Analysis\n${llmOutput.trim()}`;
				}

				getGlobalEventBus().publish('curator.init.llm_completed', {
					enhanced: true,
				});
			} catch (err) {
				// LLM failure: fall back to data-only mode with warning
				logger.warn(
					`[curator] LLM delegation failed during CURATOR_INIT, using data-only mode: ${err instanceof Error ? err.message : String(err)}`,
				);
				getGlobalEventBus().publish('curator.init.llm_fallback', {
					error: String(err),
				});
			}
		}

		const result: CuratorInitResult = {
			briefing: briefingText,
			contradictions,
			knowledge_entries_reviewed: allEntries.length,
			prior_phases_covered: priorSummary ? priorSummary.last_phase_covered : 0,
		};

		// 7. Emit event
		getGlobalEventBus().publish('curator.init.completed', {
			prior_phases_covered: result.prior_phases_covered,
			knowledge_entries_reviewed: result.knowledge_entries_reviewed,
			contradictions_found: contradictions.length,
		});

		return result;
	} catch (err) {
		// Curator failures must NEVER block the caller
		getGlobalEventBus().publish('curator.error', {
			operation: 'init',
			error: String(err),
		});
		return {
			briefing: '## Curator Init Failed\nCould not load prior session context.',
			contradictions: [],
			knowledge_entries_reviewed: 0,
			prior_phases_covered: 0,
		};
	}
}

/**
 * Run curator phase analysis: reads events, runs compliance, updates and writes summary.
 * When an llmDelegate is provided, delegates to the explorer agent in CURATOR_PHASE mode
 * for LLM-based architectural drift analysis and knowledge recommendations.
 * @param directory - The workspace directory
 * @param phase - The phase number that just completed
 * @param agentsDispatched - List of agent names dispatched in this phase
 * @param config - Curator configuration
 * @param knowledgeConfig - Knowledge configuration (used for knowledge path resolution)
 * @param llmDelegate - Optional LLM delegate for enhanced analysis
 * @returns CuratorPhaseResult with digest, compliance, and recommendations
 */
export async function runCuratorPhase(
	directory: string,
	phase: number,
	agentsDispatched: string[],
	config: CuratorConfig,
	_knowledgeConfig: { directory?: string },
	llmDelegate?: CuratorLLMDelegate,
): Promise<CuratorPhaseResult> {
	try {
		// 1. Read prior curator summary
		const priorSummary = await _internals.readCuratorSummary(directory);

		// 1b. Deduplication guard: skip if this phase was already digested.
		// Without this, repeated phase_complete or curator_analyze calls for
		// the same phase append duplicate digest entries and re-emit compliance
		// events, causing the summary to balloon and ephemeral sessions to leak.
		if (priorSummary?.phase_digests.some((d) => d.phase === phase)) {
			const existingDigest = priorSummary.phase_digests.find(
				(d) => d.phase === phase,
			)!;
			return {
				phase,
				digest: existingDigest,
				compliance: priorSummary.compliance_observations.filter(
					(c) => c.phase === phase,
				),
				knowledge_recommendations: [],
				summary_updated: false,
				already_digested: true,
			};
		}

		// 2. Read events.jsonl filtered to this phase window
		const eventsJsonlContent = await readSwarmFileAsync(
			directory,
			'events.jsonl',
		);
		const phaseEvents = eventsJsonlContent
			? _internals.filterPhaseEvents(eventsJsonlContent, phase)
			: [];

		// 3. Read context.md decisions
		const contextMd = await readSwarmFileAsync(directory, 'context.md');

		// 4. Run compliance check
		// Required agents for a standard phase: reviewer, test_engineer
		const requiredAgents = ['reviewer', 'test_engineer'];
		const complianceObservations = _internals.checkPhaseCompliance(
			phaseEvents,
			agentsDispatched,
			requiredAgents,
			phase,
		);

		// 5. Build phase digest entry from plan.json (source of truth for task status).
		// Previously this filtered events.jsonl for 'task.completed' events, but that
		// event type is never emitted — task status lives in plan.json only.
		const plan = await loadPlanJsonOnly(directory);
		const phaseData = plan?.phases.find((p) => p.id === phase);
		const tasksCompleted = phaseData
			? phaseData.tasks.filter((t) => t.status === 'completed').length
			: 0;
		const tasksTotal = phaseData ? phaseData.tasks.length : 0;

		// Extract key decisions from context.md (lines starting with '- ')
		const keyDecisions: string[] = [];
		if (contextMd) {
			const decisionSection = contextMd.match(
				/## Decisions\r?\n([\s\S]*?)(?:\r?\n##|$)/,
			);
			if (decisionSection) {
				const lines = decisionSection[1].split('\n');
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('- ')) {
						keyDecisions.push(trimmed.slice(2));
					}
				}
			}
		}

		const phaseDigest: PhaseDigestEntry = {
			phase,
			timestamp: new Date().toISOString(),
			summary: `Phase ${phase} completed. ${tasksCompleted}/${tasksTotal} tasks completed. ${complianceObservations.length} compliance observations.`,
			agents_used: [
				...new Set(
					agentsDispatched.map((a) => _internals.normalizeAgentName(a)),
				),
			],
			tasks_completed: tasksCompleted,
			tasks_total: tasksTotal,
			key_decisions: keyDecisions.slice(0, 5),
			blockers_resolved: [],
		};

		// 6. LLM delegation: delegate to explorer agent in CURATOR_PHASE mode
		// for knowledge recommendations and enhanced phase analysis
		// Read current knowledge entries for curator review (capped to avoid context bloat)
		const curatorKnowledgePath = resolveSwarmKnowledgePath(directory);
		const allKnowledgeEntries =
			await readKnowledge<SwarmKnowledgeEntry>(curatorKnowledgePath);
		const knowledgeForCurator = [...allKnowledgeEntries]
			.sort(
				(a, b) =>
					new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
			)
			.slice(0, 30)
			.map((e) => ({
				id: e.id,
				lesson: e.lesson,
				status: e.status,
				confidence: e.confidence,
				category: e.category,
			}));

		let knowledgeRecommendations: KnowledgeRecommendation[] = [];
		let knowledgeApplicationFindings: import('./curator-types.js').KnowledgeApplicationFinding[] =
			[];
		let skillCandidates: import('./curator-types.js').SkillCandidate[] = [];
		if (llmDelegate) {
			try {
				const priorDigest = priorSummary?.digest ?? 'none';
				const systemPrompt = CURATOR_PHASE_PROMPT;
				const userInput = [
					`TASK: CURATOR_PHASE ${phase}`,
					`PRIOR_DIGEST: ${priorDigest}`,
					`PHASE_EVENTS: ${JSON.stringify(phaseEvents.slice(0, 50))}`,
					`PHASE_DECISIONS: ${JSON.stringify(keyDecisions)}`,
					`AGENTS_DISPATCHED: ${JSON.stringify(agentsDispatched)}`,
					`AGENTS_EXPECTED: ["reviewer", "test_engineer"]`,
					`KNOWLEDGE_ENTRIES: ${JSON.stringify(knowledgeForCurator)}`,
				].join('\n');

				const timeoutMs =
					config.llm_timeout_ms ?? DEFAULT_CURATOR_LLM_TIMEOUT_MS;
				const ac = new AbortController();
				const timer = setTimeout(() => ac.abort(), timeoutMs);
				let llmOutput: string;
				try {
					// Hoist the delegate promise so we can attach a no-op catch
					// before the race. Without this, if the timeout fires first,
					// the delegate promise becomes the race loser and its
					// subsequent rejection (NotFoundError from the deleted
					// ephemeral session) would be an unhandled rejection.
					const delegatePromise = llmDelegate(
						systemPrompt,
						userInput,
						ac.signal,
					);
					void delegatePromise.catch(() => {});
					llmOutput = await Promise.race([
						delegatePromise,
						new Promise<never>((_, reject) => {
							ac.signal.addEventListener('abort', () =>
								reject(new Error('CURATOR_LLM_TIMEOUT')),
							);
						}),
					]);
				} finally {
					clearTimeout(timer);
				}

				if (llmOutput?.trim()) {
					knowledgeRecommendations =
						_internals.parseKnowledgeRecommendations(llmOutput);
					const structured = parseStructuredCuratorBlocks(llmOutput);
					knowledgeApplicationFindings = structured.findings;
					skillCandidates = structured.candidates;
				}

				getGlobalEventBus().publish('curator.phase.llm_completed', {
					phase,
					recommendations: knowledgeRecommendations.length,
					skill_candidates: skillCandidates.length,
					application_findings: knowledgeApplicationFindings.length,
				});
			} catch (err) {
				// LLM failure: fall back to data-only mode (empty recommendations)
				logger.warn(
					`[curator] LLM delegation failed during CURATOR_PHASE ${phase}, using data-only mode: ${err instanceof Error ? err.message : String(err)}`,
				);
				getGlobalEventBus().publish('curator.phase.llm_fallback', {
					phase,
					error: String(err),
				});
			}
		}

		// 7. Update and write curator summary
		const sessionId = `session-${Date.now()}`;
		const now = new Date().toISOString();

		let updatedSummary: CuratorSummary;
		if (priorSummary) {
			// Extend existing summary
			updatedSummary = {
				...priorSummary,
				last_updated: now,
				last_phase_covered: Math.max(priorSummary.last_phase_covered, phase),
				digest:
					priorSummary.digest +
					`\n\n### Phase ${phase}\n${phaseDigest.summary}`,
				phase_digests: [...priorSummary.phase_digests, phaseDigest],
				compliance_observations: [
					...priorSummary.compliance_observations,
					...complianceObservations,
				],
				knowledge_recommendations: knowledgeRecommendations,
			};
		} else {
			updatedSummary = {
				schema_version: 1,
				session_id: sessionId,
				last_updated: now,
				last_phase_covered: phase,
				digest: `### Phase ${phase}\n${phaseDigest.summary}`,
				phase_digests: [phaseDigest],
				compliance_observations: complianceObservations,
				knowledge_recommendations: knowledgeRecommendations,
			};
		}

		await _internals.writeCuratorSummary(directory, updatedSummary);

		// 7b. Persist knowledge application findings to per-phase evidence.
		if (knowledgeApplicationFindings.length > 0) {
			try {
				const evidenceDir = path.join(
					directory,
					'.swarm',
					'evidence',
					String(phase),
				);
				fs.mkdirSync(evidenceDir, { recursive: true });
				const findingsPath = path.join(evidenceDir, 'curator-findings.json');
				const tmpPath = `${findingsPath}.tmp.${Date.now()}`;
				fs.writeFileSync(
					tmpPath,
					JSON.stringify({ findings: knowledgeApplicationFindings }, null, 2),
				);
				fs.renameSync(tmpPath, findingsPath);
			} catch (err) {
				logger.warn(
					`[curator] failed to persist application findings: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// 8. Write compliance observations to events.jsonl as curator_compliance events
		const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
		for (const obs of complianceObservations) {
			await appendKnowledge(eventsPath, {
				type: 'curator_compliance',
				timestamp: obs.timestamp,
				phase: obs.phase,
				observation_type: obs.type,
				severity: obs.severity,
				description: obs.description,
			});
		}

		// v2: optional skill generation when curator returns skill_candidates and
		// the curator config opts in. Always uses 'draft' mode here — we never
		// auto-activate a generated skill from a curator pass; the architect or
		// a human must call skill_apply explicitly.
		if (
			(config as { skill_generation_enabled?: boolean })
				.skill_generation_enabled === true &&
			skillCandidates.length > 0
		) {
			try {
				const skillModule = await import('../services/skill-generator.js');
				for (const cand of skillCandidates) {
					if (
						cand.confidence <
						((config as { min_skill_confidence?: number })
							.min_skill_confidence ?? 0.85)
					) {
						continue;
					}
					await skillModule.generateSkills({
						directory,
						mode: 'draft',
						slug: cand.slug,
						sourceKnowledgeIds: cand.source_knowledge_ids,
					});
				}
			} catch (err) {
				logger.warn(
					`[curator] skill draft generation failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// 9. Auto-retire health check for generated skills.
		// Retires skills whose violation rate exceeds 30% or whose source
		// knowledge entries are all archived. Non-blocking: errors are
		// caught internally and logged without failing the curator.
		const autoRetireObservations = await _internals.autoRetireSkills(
			directory,
			curatorKnowledgePath,
		);
		if (autoRetireObservations.length > 0) {
			// Append auto-retire observations to the phase digest summary
			const retireNote = ` [${autoRetireObservations.length} skill(s) auto-retired]`;
			phaseDigest.summary += retireNote;
		}

		const result: CuratorPhaseResult = {
			phase,
			digest: phaseDigest,
			compliance: complianceObservations,
			knowledge_recommendations: knowledgeRecommendations,
			summary_updated: true,
			knowledge_application_findings: knowledgeApplicationFindings,
			skill_candidates: skillCandidates,
		};

		// 10. Emit event
		getGlobalEventBus().publish('curator.phase.completed', {
			phase,
			compliance_count: complianceObservations.length,
			summary_updated: true,
		});

		return result;
	} catch (err) {
		// Curator failures must NEVER block phase_complete
		getGlobalEventBus().publish('curator.error', {
			operation: 'phase',
			phase,
			error: String(err),
		});
		return {
			phase,
			digest: {
				phase,
				timestamp: new Date().toISOString(),
				summary: `Phase ${phase} curator run failed: ${String(err)}`,
				agents_used: [],
				tasks_completed: 0,
				tasks_total: 0,
				key_decisions: [],
				blockers_resolved: [],
			},
			compliance: [],
			knowledge_recommendations: [],
			summary_updated: false,
		};
	}
}

/**
 * Apply curator knowledge recommendations: promote, archive, or flag contradictions.
 * Uses transactKnowledge for atomic locked read-modify-write updates.
 * @param directory - The workspace directory
 * @param recommendations - Array of knowledge recommendations to apply
 * @param knowledgeConfig - Knowledge configuration (for path resolution)
 * @returns Counts of applied and skipped recommendations
 */
export async function applyCuratorKnowledgeUpdates(
	directory: string,
	recommendations: KnowledgeRecommendation[],
	knowledgeConfig: KnowledgeConfig,
): Promise<{ applied: number; skipped: number }> {
	let applied = 0;
	let skipped = 0;

	// Guard: treat null/undefined recommendations as empty
	if (!recommendations || recommendations.length === 0) {
		return { applied, skipped };
	}

	// Guard: return no-op when knowledgeConfig is null or undefined
	if (knowledgeConfig == null) {
		return { applied: 0, skipped: 0 };
	}

	// Filter out null/undefined recommendation items before processing
	const validRecommendations = recommendations.filter(
		(rec): rec is KnowledgeRecommendation => rec != null,
	);

	const knowledgePath = resolveSwarmKnowledgePath(directory);

	// Closure variables written by the transactKnowledge callback so the
	// post-transaction code (skipped counting, new-entry append) can see them.
	const appliedIds = new Set<string>();
	const foundIds = new Set<string>();

	// Atomically read, mutate, and rewrite existing entries under a directory lock
	// (CF-2 TOCTOU fix: concurrent appendKnowledge calls between an unlocked read
	// and a locked rewrite can no longer silently drop entries).
	await transactKnowledge<SwarmKnowledgeEntry>(knowledgePath, (entries) => {
		// Reset closure state on each call (in case of future retry semantics).
		appliedIds.clear();
		foundIds.clear();
		let txApplied = 0;
		let modified = false;

		for (const e of entries) foundIds.add(e.id);

		const updatedEntries = entries.map((entry) => {
			const rec = validRecommendations.find((r) => r.entry_id === entry.id);
			if (!rec) return entry;

			switch (rec.action) {
				case 'promote':
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					return {
						...entry,
						hive_eligible: true,
						confidence: Math.min(1.0, (entry.confidence ?? 0) + 0.1),
						updated_at: new Date().toISOString(),
					};
				case 'archive':
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					return {
						...entry,
						status: 'archived' as const,
						updated_at: new Date().toISOString(),
					};
				case 'flag_contradiction':
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					return {
						...entry,
						tags: [
							...(entry.tags ?? []),
							`contradiction:${(rec.reason ?? '').slice(0, 50)}`,
						],
						updated_at: new Date().toISOString(),
					};
				case 'rewrite': {
					const newLesson = (rec.lesson ?? '').trim();
					if (newLesson.length < 15 || newLesson.length > 280) {
						return entry;
					}
					appliedIds.add(entry.id);
					txApplied++;
					modified = true;
					return {
						...entry,
						lesson: newLesson,
						updated_at: new Date().toISOString(),
						confidence: Math.max(0.1, (entry.confidence ?? 0.5) - 0.05),
					};
				}
				default:
					return entry;
			}
		});

		applied += txApplied;
		return modified ? updatedEntries : null;
	});

	// Count skipped: recommendations that were not applied to existing entries
	for (const rec of validRecommendations) {
		if (rec.entry_id !== undefined && !appliedIds.has(rec.entry_id)) {
			if (!foundIds.has(rec.entry_id)) {
				logger.warn(
					`[curator] applyCuratorKnowledgeUpdates: entry_id '${rec.entry_id}' not found — skipping`,
				);
			}
			skipped++;
		}
	}

	// Create new entries for recommendations that used the "new" token.
	// entry_id === undefined means the LLM requested a new knowledge entry.
	// Only 'promote' actions are meaningful without an existing entry_id —
	// 'archive' and 'flag_contradiction' require a real entry to operate on.
	// These are appended after the transaction to avoid nested locking.
	// Re-read lessons from the file for dedup purposes.
	// This is a separate unlocked read; the append below is independently locked.
	const currentEntries =
		await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);
	const currentLessons: string[] = currentEntries.map((e) => e.lesson);

	for (const rec of validRecommendations) {
		if (rec.entry_id !== undefined) continue;
		if (rec.action !== 'promote') {
			skipped++;
			continue;
		}
		const lesson = (rec.lesson?.trim() ?? '').slice(0, 280);
		if (lesson.length < 15) {
			skipped++;
			continue;
		}
		if (
			currentLessons.some((el) => el.toLowerCase() === lesson.toLowerCase())
		) {
			skipped++;
			continue;
		}
		if (knowledgeConfig.validation_enabled !== false) {
			const validation = validateLesson(lesson, currentLessons, {
				category: rec.category ?? 'other',
				scope: 'global',
				confidence: rec.confidence ?? 0.5,
			});
			if (!validation.valid) {
				skipped++;
				continue;
			}
		}
		const now = new Date().toISOString();
		const newEntry: SwarmKnowledgeEntry = {
			id: randomUUID(),
			tier: 'swarm',
			lesson: lesson,
			category: rec.category ?? 'other',
			tags: [],
			scope: 'global',
			confidence: rec.confidence ?? 0.5,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: now,
			updated_at: now,
			auto_generated: true,
			project_name: path.basename(directory),
		};
		// Layer-5 actionability gate (Change 4): prose "new candidate"
		// recommendations carry no predicate/scope fields, so they are routed to
		// the unactionable queue (recoverable by the hardening loop) instead of
		// the active store. No LLM delegate is available in this path.
		if (!validateActionability(newEntry).actionable) {
			try {
				await appendUnactionable(
					directory,
					newEntry,
					'curator_recommendation_unactionable',
				);
			} catch {
				// queue write is best-effort; the entry is still withheld
			}
			skipped++;
			continue;
		}
		await appendKnowledge(knowledgePath, newEntry);
		applied++;
		currentLessons.push(lesson);
	}

	return { applied, skipped };
}

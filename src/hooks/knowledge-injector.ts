/** Phase-Start Knowledge Injection Hook for opencode-swarm v6.17.
 *
 * Injects relevant knowledge (from both swarm + hive tiers) into the architect's
 * context at phase start. Caches the injection text for re-injection after
 * compaction. Skips for non-architect agents. Appends rejected-pattern warnings
 * to prevent re-learning loops.
 */

import { createHash } from 'node:crypto';
import { stripKnownSwarmPrefix } from '../config/schema.js';
import { getCurrentTaskId, loadPlan } from '../plan/manager.js';
import { getRunMemorySummary } from '../services/run-memory.js';
import { clearCriticalShownIds, setCriticalShownIds } from '../state.js';
import { warn } from '../utils/logger.js';
import {
	buildDriftInjectionText,
	readPriorDriftReports,
} from './curator-drift.js';
import { extractCurrentPhaseFromPlan } from './extractors.js';
import {
	filterHighConfidenceKnowledge,
	recordKnowledgeShown,
} from './knowledge-application.js';
import type { ProjectContext, RankedEntry } from './knowledge-reader.js';
import { readRejectedLessons } from './knowledge-store.js';
import type {
	KnowledgeConfig,
	KnowledgeRetrievalContext,
	MessageWithParts,
} from './knowledge-types.js';
import { searchKnowledge } from './search-knowledge.js';
import { readSwarmFileAsync, safeHook } from './utils.js';

// ============================================================================
// Internal Helpers (NOT exported)
// ============================================================================

/**
 * Sentinel marker for idempotency detection.
 * Uses zero-width non-joiner (U+200C) + ASCII sentinel — extremely unlikely to
 * appear in natural text or knowledge lessons. Replaces the prior BOOK emoji
 * (📖, U+1F4DA) which was fragile across system encodings.
 */
const INJECTION_SENTINEL = '\u200c[[KNOWLEDGE-INJECTED]]';

/**
 * Builds a compact knowledge block from ranked entries, respecting a character budget.
 * Returns the formatted block string, or null if entries is empty.
 *
 * Compact format per entry: `[S] lesson text ✓✓`
 * - Tier: [S] for swarm, [H] for hive
 * - Confirmation: ✓✓ if confirmed_by.length >= 3, ✓ if >= 1, empty otherwise
 * - Source (hive only): appended when source_project differs from current project
 * - Each lesson truncated at max_lesson_display_chars (stored entry never modified)
 * - Whole entries trimmed from end if block exceeds charBudget
 */
function buildKnowledgeBlock(
	entries: RankedEntry[],
	charBudget: number,
	cfg: KnowledgeConfig,
	currentProject?: string,
): string | null {
	if (entries.length === 0) return null;

	const maxDisplayChars = cfg.max_lesson_display_chars ?? 120;

	const lines: string[] = entries.map((entry) => {
		const tier = entry.tier === 'hive' ? '[H]' : '[S]';
		const confirmedBy = entry.confirmed_by?.length ?? 0;
		const confirm =
			confirmedBy >= 3 ? ' \u2713\u2713' : confirmedBy >= 1 ? ' \u2713' : '';

		let lessonText = sanitizeLessonForContext(entry.lesson);
		if (lessonText.length > maxDisplayChars) {
			lessonText = `${lessonText.slice(0, maxDisplayChars)}\u2026`;
		}

		// source_project only for hive entries when it differs from current project
		const rawSource =
			entry.tier === 'hive' && 'source_project' in entry
				? ((entry as { source_project?: string }).source_project ?? null)
				: null;
		const source =
			rawSource !== null && rawSource !== currentProject
				? ` (from: ${sanitizeLessonForContext(rawSource)})`
				: '';

		return `${tier} ${lessonText}${source}${confirm}`;
	});

	const header = '\ud83d\udcda Lessons:\n';

	// Trim whole entries from end if block exceeds charBudget
	let block = `${header}\n${lines.join('\n')}`;
	while (block.length > charBudget && lines.length > 0) {
		lines.pop();
		block = `${header}\n${lines.join('\n')}`;
	}

	return lines.length > 0 ? block : null;
}

/**
 * v2: Build the structured `<swarm_knowledge_directives>` block. This is the
 * actionable directive surface architects must inspect/acknowledge.
 * Returns null if there's nothing actionable to emit.
 */
function buildDirectiveBlock(
	entries: RankedEntry[],
	charBudget: number,
	cfg: KnowledgeConfig,
): string | null {
	if (entries.length === 0) return null;
	const maxDisplay = cfg.max_lesson_display_chars ?? 120;
	const lines: string[] = [];
	lines.push('<swarm_knowledge_directives>');
	for (const e of entries) {
		const trigger =
			e.triggers && e.triggers.length > 0
				? sanitizeLessonForContext(e.triggers[0]).slice(0, maxDisplay)
				: '';
		const required =
			e.required_actions && e.required_actions.length > 0
				? sanitizeLessonForContext(e.required_actions[0]).slice(0, maxDisplay)
				: '';
		const forbidden =
			e.forbidden_actions && e.forbidden_actions.length > 0
				? sanitizeLessonForContext(e.forbidden_actions[0]).slice(0, maxDisplay)
				: '';
		const verification =
			e.verification_checks && e.verification_checks.length > 0
				? sanitizeLessonForContext(e.verification_checks[0]).slice(
						0,
						maxDisplay,
					)
				: '';
		const skillRef = e.generated_skill_path
			? `file:${sanitizeLessonForContext(e.generated_skill_path)}`
			: '';
		const priority = e.directive_priority ?? 'medium';
		const lesson = sanitizeLessonForContext(e.lesson).slice(0, maxDisplay);
		// Each directive is one record. Keep YAML-ish for parser-friendliness.
		lines.push(`- id: ${e.id}`);
		lines.push(`  confidence: ${Number(e.confidence).toFixed(2)}`);
		lines.push(`  priority: ${priority}`);
		lines.push(`  lesson: ${lesson}`);
		if (trigger) lines.push(`  trigger: ${trigger}`);
		if (required) lines.push(`  required: ${required}`);
		if (forbidden) lines.push(`  forbidden: ${forbidden}`);
		if (skillRef) lines.push(`  skill: ${skillRef}`);
		if (verification) lines.push(`  verification: ${verification}`);
	}
	lines.push('</swarm_knowledge_directives>');
	let block = lines.join('\n');
	while (block.length > charBudget && lines.length > 3) {
		// Pop the last directive record (find the last '- id:' line)
		let lastIdx = -1;
		for (let i = lines.length - 2; i >= 0; i--) {
			if (lines[i].startsWith('- id:')) {
				lastIdx = i;
				break;
			}
		}
		if (lastIdx < 0) break;
		lines.splice(lastIdx, lines.length - 1 - lastIdx);
		block = lines.join('\n');
	}
	// If we trimmed everything to header+footer, return null.
	if (lines.length <= 2) return null;
	return block;
}

/** Sanitizes lesson text to prevent prompt injection into LLM context. */
function sanitizeLessonForContext(text: string): string {
	return text
		.split('')
		.filter((char) => {
			const code = char.charCodeAt(0);
			return (
				code === 9 || code === 10 || code === 13 || (code > 31 && code !== 127)
			);
		})
		.join('')
		.replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width chars
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, '') // BiDi override chars
		.replace(/```/g, '` ` `') // Break code block escapes
		.replace(/^system\s*:/gim, '[BLOCKED]:'); // Block system: prefix
}

/** Returns true if this agent is the architect (the sole intended recipient of knowledge injection). */
function isOrchestratorAgent(agentName: string): boolean {
	const stripped = stripKnownSwarmPrefix(agentName);
	// Only the architect receives knowledge injection.
	// Using an explicit allowlist prevents unintentional injection into future agents.
	return stripped.toLowerCase() === 'architect';
}

/** Inserts the knowledge block just before the last user message (recency position). */
function injectKnowledgeMessage(
	output: { messages?: MessageWithParts[] },
	text: string,
): void {
	if (!output.messages) return;

	// Idempotency guard: skip if already injected in this transform
	const alreadyInjected = output.messages.some((m) =>
		m.parts?.some((p) => p.text?.includes(INJECTION_SENTINEL)),
	);
	if (alreadyInjected) return;

	// Insert just before the last user message (recency position).
	// Avoids the "lost in the middle" attention dead zone that mid-array injection creates.
	let insertIdx = output.messages.length - 1; // fallback: append before last message
	for (let i = output.messages.length - 1; i >= 0; i--) {
		if (output.messages[i].info?.role === 'user') {
			insertIdx = i;
			break;
		}
	}

	const knowledgeMessage: MessageWithParts = {
		info: { role: 'system' },
		parts: [{ type: 'text', text: `${INJECTION_SENTINEL}${text}` }],
	};

	output.messages.splice(insertIdx, 0, knowledgeMessage);
}

// ============================================================================
// Exported Factory Function
// ============================================================================

/**
 * Creates a knowledge injection hook that injects relevant knowledge into the
 * architect's message context at phase start. Supports caching for re-injection
 * after compaction. Cache is per-instance (bound to the returned hook closure),
 * ensuring no cross-test pollution in Bun's shared test-runner process.
 *
 * @param directory - The project directory containing .swarm/
 * @param config - Knowledge system configuration
 * @returns A hook function that injects knowledge into messages
 */
export function createKnowledgeInjectorHook(
	directory: string,
	config: KnowledgeConfig,
): (
	input: Record<string, never>,
	output: { messages?: MessageWithParts[] },
) => Promise<void> {
	function buildContextCacheKey(
		phase: number,
		ctx: KnowledgeRetrievalContext,
	): string {
		const parts = [
			String(phase),
			ctx.currentTool ?? '',
			ctx.currentAction ?? '',
			ctx.targetAgent ?? '',
			ctx.taskId ?? '',
			(ctx.filePaths ?? []).slice(0, 8).join(','),
		].join('|');
		return createHash('sha1').update(parts).digest('hex').slice(0, 16);
	}

	let lastSeenCacheKey: string | null = null;
	let cachedInjectionText: string | null = null;
	let cachedShownIds: string[] = [];

	return safeHook(
		async (
			_input: Record<string, never>,
			output: { messages?: MessageWithParts[] },
		) => {
			if (!output.messages || output.messages.length === 0) return;

			// Load plan — proceed with default context if no plan exists
			const plan = await loadPlan(directory);
			const currentPhase = plan?.current_phase ?? 1;

			// Budget-residual check (BACM-style: evaluate headroom before appending)
			// Uses the same 0.33 tok/char ratio as estimateTokens() in context-budget.ts
			const CHARS_PER_TOKEN = 1 / 0.33;
			const MODEL_LIMIT_CHARS = Math.floor(128_000 * CHARS_PER_TOKEN); // ~387,878
			const existingChars = output.messages.reduce((sum, msg) => {
				return (
					sum + (msg.parts?.reduce((s, p) => s + (p.text?.length ?? 0), 0) ?? 0)
				);
			}, 0);
			const headroomChars = MODEL_LIMIT_CHARS - existingChars;
			const MIN_INJECT_CHARS = config.context_budget_threshold ?? 300;

			if (headroomChars < MIN_INJECT_CHARS) {
				warn(
					`[knowledge-injector] Skipping: only ${headroomChars} chars of headroom remain (existing: ${existingChars}, limit: ${MODEL_LIMIT_CHARS})`,
				);
				return;
			}

			// Three-regime injection budget (maps to BACM high/moderate/low budget regimes)
			const maxInjectChars = config.inject_char_budget ?? 2_000;
			const effectiveBudget =
				headroomChars >= MODEL_LIMIT_CHARS * 0.6
					? maxInjectChars // high: >60% remaining — full budget
					: headroomChars >= MODEL_LIMIT_CHARS * 0.2
						? Math.floor(maxInjectChars * 0.5) // moderate: 20–60% — half budget
						: Math.floor(maxInjectChars * 0.25); // low: 5–20% — quarter budget

			// Agent check — only inject for architect/orchestrator agents
			const systemMsg = output.messages.find((m) => m.info?.role === 'system');
			const agentName = systemMsg?.info?.agent;
			if (!agentName || !isOrchestratorAgent(agentName)) return;

			// Build retrieval context: extend ProjectContext with v2 task/action signals.
			const phaseDescription = plan
				? (extractCurrentPhaseFromPlan(plan) ?? `Phase ${currentPhase}`)
				: 'Phase 0';
			const projectName = plan?.title ?? 'unknown';
			// Pull the most recent user message text for context awareness.
			let lastUserMessage: string | undefined;
			for (let i = output.messages.length - 1; i >= 0; i--) {
				const m = output.messages[i];
				if (m.info?.role === 'user') {
					const t = m.parts
						?.map((p) => p.text ?? '')
						.join(' ')
						.trim();
					if (t) {
						lastUserMessage = t.slice(0, 800);
						break;
					}
				}
			}
			const taskId = getCurrentTaskId(plan);
			const retrievalCtx: KnowledgeRetrievalContext = {
				projectName,
				currentPhase: phaseDescription,
				mode: 'phase_start',
				lastUserMessage,
				taskId,
			};

			// v2: cache key now includes action/task/agent/files signature, not just phase.
			const cacheKey = buildContextCacheKey(currentPhase, retrievalCtx);
			if (cacheKey === lastSeenCacheKey && cachedInjectionText !== null) {
				// Same context, cached text available — re-inject (handles compaction).
				injectKnowledgeMessage(output, cachedInjectionText);
				return;
			}
			lastSeenCacheKey = cacheKey;
			cachedInjectionText = null;

			// Build legacy ProjectContext for the lesson-block fallback path.
			const _context: ProjectContext = {
				projectName,
				currentPhase: phaseDescription,
			};

			// Retrieve action-aware ranked entries (uses triggers/applies_to/priority).
			const search = await searchKnowledge({
				directory,
				config,
				context: retrievalCtx,
				mode: 'auto_injection',
				agent: 'architect',
				sessionId: systemMsg?.info?.sessionID,
			});
			const entries = search.results;
			// Filter to high-confidence entries only (confidence >= 0.8)
			const filteredEntries = filterHighConfidenceKnowledge(entries);
			// Track which IDs we showed so application-tracking can split shown from applied.
			cachedShownIds = filteredEntries.map((e) => e.id);

			// Build drift/briefing preamble into a LOCAL variable so cachedInjectionText
			// is never mutated before we know whether entries exist. This prevents the
			// phase-detection early-return (cachedInjectionText !== null) from firing
			// on subsequent calls with only a partial drift-only cache.
			let freshPreamble: string | null = null;

			// Drift injection: prepend latest drift report summary
			try {
				const driftReports = await readPriorDriftReports(directory);
				if (driftReports.length > 0) {
					const latestReport = driftReports[driftReports.length - 1];
					const driftText = buildDriftInjectionText(latestReport, 500);
					if (driftText) {
						freshPreamble = driftText;
					}
				}
			} catch {
				// drift injection failures must never propagate
			}

			// Curator briefing injection: include session-start briefing from curator init
			try {
				const briefingContent = await readSwarmFileAsync(
					directory,
					'curator-briefing.md',
				);
				if (briefingContent) {
					// Truncate to stay within token budget (same 500 char limit as drift)
					const truncatedBriefing = briefingContent.slice(0, 500);
					freshPreamble = freshPreamble
						? `<curator_briefing>${truncatedBriefing}</curator_briefing>\n\n${freshPreamble}`
						: `<curator_briefing>${truncatedBriefing}</curator_briefing>`;
				}
			} catch {
				// curator briefing injection failures must never propagate
			}

			// If no knowledge entries AND no drift/briefing, nothing to inject
			if (filteredEntries.length === 0) {
				if (freshPreamble === null) return;
				// Drift or briefing exists — cache and inject it directly
				cachedInjectionText = freshPreamble;
				injectKnowledgeMessage(output, cachedInjectionText);
				return;
			}

			// Get run memory summary
			const runMemory = await getRunMemorySummary(directory);

			// Priority-ordered assembly respecting effectiveBudget
			// Priority: 1. Lessons, 2. Run memory, 3. Drift preamble, 4. Rejected warnings
			// Curator briefing dropped at moderate/low regimes (already in context.md)
			const isFullBudget = effectiveBudget === maxInjectChars;

			// Split budget between actionable directives and legacy lesson block.
			const directiveBudget = Math.floor(effectiveBudget * 0.45);
			const lessonBudget = Math.floor(effectiveBudget * 0.3);

			// v2: Emit structured directive block for entries that have actionable metadata.
			const directiveEntries = filteredEntries.filter(
				(e) =>
					(e.triggers && e.triggers.length > 0) ||
					(e.required_actions && e.required_actions.length > 0) ||
					(e.forbidden_actions && e.forbidden_actions.length > 0) ||
					e.directive_priority === 'critical' ||
					e.directive_priority === 'high' ||
					e.generated_skill_path,
			);
			const directiveBlock = buildDirectiveBlock(
				directiveEntries,
				directiveBudget,
				config,
			);

			const lessonBlock = buildKnowledgeBlock(
				filteredEntries,
				lessonBudget,
				config,
				projectName,
			);

			const parts: string[] = [];
			let remaining = effectiveBudget;

			// 1a. Actionable directives (highest priority — architect must acknowledge).
			if (directiveBlock) {
				parts.push(directiveBlock);
				remaining -= directiveBlock.length;
			}

			// 1b. Legacy lesson block (informational).
			if (lessonBlock) {
				parts.push(lessonBlock);
				remaining -= lessonBlock.length;
			}

			// 2. Run memory
			if (runMemory && remaining > 300) {
				parts.push(runMemory);
				remaining -= runMemory.length;
			}

			// 3. Drift preamble (freshPreamble without curator briefing at reduced budgets)
			if (freshPreamble && remaining > 200) {
				// At moderate/low budgets, strip curator briefing from freshPreamble
				let preambleToUse = freshPreamble;
				if (!isFullBudget) {
					preambleToUse = preambleToUse.replace(
						/<curator_briefing>[\s\S]*?<\/curator_briefing>\s*/g,
						'',
					);
				}
				if (
					preambleToUse.trim().length > 0 &&
					preambleToUse.length <= remaining
				) {
					parts.push(preambleToUse);
					remaining -= preambleToUse.length;
				}
			}

			// 4. Rejected warnings (lowest priority)
			const rejected = await readRejectedLessons(directory);
			if (rejected.length > 0 && remaining > 150) {
				const recentRejected = rejected.slice(-3);
				const rejectedLines = recentRejected.map(
					(r) =>
						`  \u26a0\ufe0f REJECTED PATTERN: "${sanitizeLessonForContext(r.lesson).slice(0, 80)}" \u2014 ${sanitizeLessonForContext(r.rejection_reason)}`,
				);
				const rejectedBlock =
					'\u26a0\ufe0f Previously rejected patterns (do not re-learn):\n' +
					rejectedLines.join('\n');
				if (rejectedBlock.length <= remaining) {
					parts.push(rejectedBlock);
				}
			}

			cachedInjectionText = parts.join('\n\n');
			injectKnowledgeMessage(output, cachedInjectionText);

			// v2: Populate in-memory currentCriticalShownIds so the toolBefore
			// enforcement gate can read O(1) without re-scanning JSONL.
			// Keyed by sessionID — the gate consults this exact key.
			const sessionID = systemMsg?.info?.sessionID;
			if (sessionID) {
				const criticalIds = filteredEntries
					.filter(
						(e) =>
							e.directive_priority === 'critical' && e.status !== 'archived',
					)
					.map((e) => e.id);
				if (criticalIds.length > 0) {
					setCriticalShownIds(sessionID, {
						ids: criticalIds,
						phase: `Phase ${currentPhase}`,
						generatedAt: Date.now(),
					});
				} else {
					// Clear stale critical-set when no criticals were injected this turn
					clearCriticalShownIds(sessionID);
				}
			}

			// v2: Audit "shown" outcome for each entry that was actually included.
			// This is fire-and-forget; failures must never propagate.
			if (cachedShownIds.length > 0) {
				const phaseLabel = `Phase ${currentPhase}`;
				recordKnowledgeShown(directory, cachedShownIds, {
					phase: phaseLabel,
					tool: retrievalCtx.currentTool,
					action: retrievalCtx.currentAction,
					targetAgent: retrievalCtx.targetAgent,
					taskId: retrievalCtx.taskId,
				}).catch(() => {
					// swallow — non-critical telemetry
				});
			}
		},
	);
}

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
import { sanitizeContextText } from './context-sanitizer.js';
import {
	buildDriftInjectionText,
	readPriorDriftReports,
} from './curator-drift.js';
import { extractCurrentPhaseFromPlan } from './extractors.js';
import { recordKnowledgeShown } from './knowledge-application.js';
import {
	buildEscalationBriefing,
	readRecentEscalations,
} from './knowledge-escalator.js';
import { recordKnowledgeEvent } from './knowledge-events.js';
import type { ProjectContext, RankedEntry } from './knowledge-reader.js';
import { readRejectedLessons } from './knowledge-store.js';
import type {
	DirectivePriority,
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
const INJECTION_SENTINEL = `${String.fromCharCode(0x200c)}[[KNOWLEDGE-INJECTED]]`;
const defaultSearchKnowledge = searchKnowledge;

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
		const confirm = confirmedBy >= 3 ? ' ✓✓' : confirmedBy >= 1 ? ' ✓' : '';

		let lessonText = sanitizeLessonForContext(entry.lesson);
		if (lessonText.length > maxDisplayChars) {
			lessonText = `${lessonText.slice(0, maxDisplayChars)}…`;
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

	const header = '📚 Lessons:\n';

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
const sanitizeLessonForContext = sanitizeContextText;

/** Marker that uniquely identifies the delegate directive block in a transcript. */
export const DELEGATE_DIRECTIVE_BLOCK_TAG = '<delegate_knowledge_directives>';

/**
 * Render a sanitized, deterministic `<delegate_knowledge_directives>` block for
 * a delegated subagent (Change 1, Task 1.3). Entries are sorted by priority
 * (critical first) then ID so the block is stable across runs and prompt caches
 * remain warm. Returns null when there are no entries (no empty wrapper).
 */
export function buildDelegateDirectiveBlock(
	entries: RankedEntry[],
	cfg: KnowledgeConfig,
): string | null {
	if (entries.length === 0) return null;
	const maxDisplay = cfg.max_lesson_display_chars ?? 120;
	const FIELD_CAP = 240;
	const renderList = (items: string[] | undefined): string | null => {
		if (!items || items.length === 0) return null;
		const joined = items
			.map((s) => sanitizeLessonForContext(s))
			.filter((s) => s.length > 0)
			.join('; ');
		if (!joined) return null;
		return joined.length > FIELD_CAP
			? `${joined.slice(0, FIELD_CAP)}…`
			: joined;
	};

	const sorted = [...entries].sort((a, b) => {
		const pr =
			directivePriorityRank(a.directive_priority) -
			directivePriorityRank(b.directive_priority);
		if (pr !== 0) return pr;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});

	const lines: string[] = [];
	lines.push(DELEGATE_DIRECTIVE_BLOCK_TAG);
	lines.push(
		'These directives were learned from prior swarm runs and scoped to your role. Apply them to the task below.',
	);
	lines.push(
		'ACK CONTRACT: end your FINAL message with one line per CRITICAL directive in this block:',
	);
	lines.push('  KNOWLEDGE_APPLIED:<id> — you applied it');
	lines.push(
		'  KNOWLEDGE_IGNORED:<id> reason=<short why> — you intentionally did not apply it',
	);
	lines.push(
		'  KNOWLEDGE_N_A:<id> reason=<why> — it did not apply to your task',
	);
	lines.push('Omitting a critical id is a contract violation.');
	for (const e of sorted) {
		const priority = e.directive_priority ?? 'medium';
		const lesson = sanitizeLessonForContext(e.lesson).slice(0, maxDisplay);
		lines.push(`- id: ${e.id}`);
		lines.push(`  priority: ${priority}`);
		lines.push(`  lesson: ${lesson}`);
		const forbidden = renderList(e.forbidden_actions);
		if (forbidden) lines.push(`  forbidden: ${forbidden}`);
		const required = renderList(e.required_actions);
		if (required) lines.push(`  required: ${required}`);
		const verification = renderList(e.verification_checks);
		if (verification) lines.push(`  verification: ${verification}`);
	}
	lines.push('</delegate_knowledge_directives>');
	return lines.join('\n');
}

/** A directive that was rendered into a delegate block, recovered by parsing. */
export interface ShownDelegateDirective {
	id: string;
	priority: DirectivePriority;
}

/**
 * Recover the directive IDs (and priorities) that were rendered into a
 * `<delegate_knowledge_directives>` block. Used by the ack-collector
 * (Task 1.5) to reconcile a delegate's ack markers against what was actually
 * shown — only IDs present here are honored, so a delegate cannot fabricate an
 * ack for a directive it never received. Returns [] when no block is present.
 */
export function parseDelegateDirectiveBlock(
	text: string,
): ShownDelegateDirective[] {
	if (!text || !text.includes(DELEGATE_DIRECTIVE_BLOCK_TAG)) return [];
	const start = text.indexOf(DELEGATE_DIRECTIVE_BLOCK_TAG);
	const endTag = '</delegate_knowledge_directives>';
	const endIdx = text.indexOf(endTag, start);
	const body = endIdx >= 0 ? text.slice(start, endIdx) : text.slice(start);
	const out: ShownDelegateDirective[] = [];
	for (const line of body.split('\n')) {
		const idM = /^- id:\s*(\S+)\s*$/.exec(line);
		if (idM) {
			out.push({ id: idM[1], priority: 'medium' });
			continue;
		}
		const prM = /^\s+priority:\s*(low|medium|high|critical)\s*$/.exec(line);
		if (prM && out.length > 0) {
			out[out.length - 1].priority = prM[1] as DirectivePriority;
		}
	}
	return out;
}

export interface InjectForDelegateParams {
	directory: string;
	agent: string;
	expectedTools?: string[];
	taskTitle?: string;
	sessionId?: string;
	config: KnowledgeConfig;
	/**
	 * Phase label recorded on the emitted `delegate_inject` event. Threading the
	 * real plan phase (rather than the task title) lets the reviewer verdict loop
	 * and the phase-complete gate window directives by phase (Change 2).
	 */
	phase?: string;
	/** Test seam: override the search function. Defaults to the live one. */
	searchFn?: typeof searchKnowledge;
}

export interface InjectForDelegateResult {
	entries: RankedEntry[];
	trace_id: string;
}

/**
 * Retrieve the subset of active knowledge directives scoped to a delegated
 * subagent's role + expected tools (Change 1, Task 1.2). Emits a single
 * `retrieved` event tagged `mode:'delegate_inject'` with the capped, in-scope
 * entry IDs. Fail-open: any error yields an empty result.
 */
export async function injectForDelegate(
	params: InjectForDelegateParams,
): Promise<InjectForDelegateResult> {
	const { directory, agent, taskTitle, sessionId, config } = params;
	const cap = config.delegate_max_inject_count ?? 8;
	const expectedTools =
		params.expectedTools && params.expectedTools.length > 0
			? params.expectedTools
			: defaultExpectedToolsForAgent(agent);
	if (cap <= 0) return { entries: [], trace_id: '' };
	const role = stripKnownSwarmPrefix(agent).toLowerCase();
	const firstTool = expectedTools.length > 0 ? expectedTools[0] : undefined;
	const context: KnowledgeRetrievalContext = {
		currentPhase: taskTitle ?? '',
		taskTitle,
		lastUserMessage: taskTitle,
		targetAgent: agent,
		currentTool: firstTool,
		mode: 'delegation',
	};
	// Mirror the architect-path DI seam: prefer an explicit searchFn, else use the
	// live `searchKnowledge` import binding (which test mocks replace) unless
	// `_internals.searchKnowledge` was manually overridden.
	const searchFn =
		params.searchFn ??
		(_internals.searchKnowledge === defaultSearchKnowledge
			? searchKnowledge
			: _internals.searchKnowledge);
	try {
		const search = await searchFn({
			directory,
			config,
			context,
			mode: 'delegate_inject',
			agent,
			sessionId,
			tier: 'all',
			applyScopeFilter: true,
			// We apply the per-delegate OR scope (agent OR tool OR untargeted)
			// ourselves below, so disable searchKnowledge's agent-only role gate.
			applyRoleScope: false,
			maxResults: Math.max(40, cap * 4),
			emitEvent: false,
		});
		const scoped = search.results.filter((e) =>
			matchesDelegateScope(e, role, expectedTools),
		);
		const capped = scoped.slice(0, cap);

		// Emit a single delegate_inject retrieval event with the IDs actually shown.
		if (capped.length > 0) {
			const ranks: Record<string, number> = {};
			const scores: Record<string, number> = {};
			capped.forEach((e, idx) => {
				ranks[e.id] = idx + 1;
				scores[e.id] = e.finalScore;
			});
			await _internals.recordKnowledgeEvent(directory, {
				type: 'retrieved',
				trace_id: search.trace_id,
				session_id: sessionId ?? 'unknown',
				phase: params.phase ?? taskTitle,
				agent,
				query: taskTitle ?? '',
				retrieval_mode: 'delegate_inject',
				result_ids: capped.map((e) => e.id),
				ranks,
				scores,
			});
		}
		return { entries: capped, trace_id: search.trace_id };
	} catch {
		return { entries: [], trace_id: '' };
	}
}

/**
 * Delegate-side injection path used by the chat.messages.transform hook when it
 * fires inside a delegated subagent's session (Change 1, Task 1.1). Builds the
 * `<delegate_knowledge_directives>` block from the delegation prompt + role and
 * injects it as a system message. Idempotent with the architect-side prompt
 * prepend (Task 1.4): if a delegate block already exists in the transcript, this
 * is a no-op, so the two paths never double-inject. Compaction-resilient: when
 * the original prompt-borne block was dropped, this re-delivers it. Fail-open.
 */
async function injectForDelegateIntoMessages(
	directory: string,
	config: KnowledgeConfig,
	output: { messages?: MessageWithParts[] },
	agentName: string,
	sessionId: string | undefined,
): Promise<void> {
	if (!output.messages || output.messages.length === 0) return;
	// Idempotency: if a delegate directive block is already present (delivered by
	// the architect-side prompt prepend), do not inject a second copy.
	const alreadyPresent = output.messages.some((m) =>
		m.parts?.some((p) => p.text?.includes(DELEGATE_DIRECTIVE_BLOCK_TAG)),
	);
	if (alreadyPresent) return;

	// The delegation prompt is the most recent user message in the subagent's
	// session — use it as the retrieval query / task title.
	let taskTitle: string | undefined;
	for (let i = output.messages.length - 1; i >= 0; i--) {
		const m = output.messages[i];
		if (m.info?.role === 'user') {
			const t = m.parts
				?.map((p) => p.text ?? '')
				.join(' ')
				.trim();
			if (t) {
				taskTitle = t.slice(0, 800);
				break;
			}
		}
	}

	const { entries } = await injectForDelegate({
		directory,
		agent: agentName,
		expectedTools: defaultExpectedToolsForAgent(agentName),
		taskTitle,
		sessionId,
		config,
	});
	const block = buildDelegateDirectiveBlock(entries, config);
	if (!block) return;
	injectKnowledgeMessage(output, block);
}

/** Returns true if this agent is the architect (the sole intended recipient of orchestrator-tier knowledge injection). */
export function isOrchestratorAgent(agentName: string): boolean {
	const stripped = stripKnownSwarmPrefix(agentName);
	// Only the architect receives knowledge injection.
	// Using an explicit allowlist prevents unintentional injection into future agents.
	return stripped.toLowerCase() === 'architect';
}

/**
 * Delegated subagent roles that receive per-agent directive injection (Change 1).
 * The architect is intentionally excluded — it goes through the richer
 * orchestrator injection path (`<swarm_knowledge_directives>`), not the
 * delegate path (`<delegate_knowledge_directives>`).
 */
const DELEGATED_AGENTS: ReadonlySet<string> = new Set([
	'coder',
	'reviewer',
	'test_engineer',
	'sme',
	'docs',
	'designer',
	'critic',
	'curator',
]);

/**
 * Returns true if this agent is a delegated subagent that should receive the
 * per-agent directive block. Swarm prefixes (e.g. `mega_coder`) are stripped so
 * prefixed agent names still match their canonical role.
 */
export function isDelegatedAgent(agentName: string): boolean {
	const stripped = stripKnownSwarmPrefix(agentName).toLowerCase();
	return DELEGATED_AGENTS.has(stripped);
}

/**
 * Best-known tool whitelist per delegated role, used to scope which directives
 * (by `applies_to_tools`) a delegate should see when the caller does not supply
 * an explicit expected-tools list. Lower-cased canonical tool names.
 */
const DELEGATE_DEFAULT_TOOLS: Readonly<Record<string, readonly string[]>> = {
	coder: ['edit', 'write', 'patch', 'bash'],
	reviewer: ['read', 'grep', 'glob'],
	test_engineer: ['edit', 'write', 'bash', 'read'],
	sme: ['read', 'grep', 'glob', 'webfetch'],
	docs: ['read', 'edit', 'write', 'grep'],
	designer: ['read', 'write', 'edit'],
	critic: ['read', 'grep', 'glob'],
	curator: ['read', 'grep', 'glob'],
};

/** Returns the default expected-tools list for a delegated agent role. */
export function defaultExpectedToolsForAgent(agentName: string): string[] {
	const role = stripKnownSwarmPrefix(agentName).toLowerCase();
	return [...(DELEGATE_DEFAULT_TOOLS[role] ?? [])];
}

/** Deterministic priority ordering (critical first) for delegate directive blocks. */
const DIRECTIVE_PRIORITY_RANK: Record<DirectivePriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

function directivePriorityRank(p: DirectivePriority | undefined): number {
	return DIRECTIVE_PRIORITY_RANK[p ?? 'medium'] ?? 2;
}

/**
 * Per-delegate scope match implementing the Change-1 OR semantics: an entry is
 * in scope for a delegate when it is untargeted (no agent and no tool scope),
 * OR its `applies_to_agents` includes the delegate's role, OR its
 * `applies_to_tools` intersects the delegate's expected tools. Swarm prefixes
 * are stripped on both sides so `mega_coder` matches a bare `coder`.
 */
export function matchesDelegateScope(
	entry: Pick<RankedEntry, 'applies_to_agents' | 'applies_to_tools'>,
	role: string,
	expectedTools: readonly string[],
): boolean {
	const agents = (entry.applies_to_agents ?? []).map((a) =>
		stripKnownSwarmPrefix(a).toLowerCase(),
	);
	const tools = (entry.applies_to_tools ?? []).map((t) => t.toLowerCase());
	const untargeted = agents.length === 0 && tools.length === 0;
	if (untargeted) return true;
	const normRole = stripKnownSwarmPrefix(role).toLowerCase();
	if (agents.includes(normRole)) return true;
	const expected = expectedTools.map((t) => t.toLowerCase());
	if (tools.some((t) => expected.includes(t))) return true;
	return false;
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

			// Agent check — architects go through the orchestrator path below;
			// delegated subagents go through the per-agent directive path; all
			// other (unrecognized) agents return early.
			const systemMsg = output.messages.find((m) => m.info?.role === 'system');
			const agentName = systemMsg?.info?.agent;
			if (!agentName) return;
			if (isDelegatedAgent(agentName)) {
				await injectForDelegateIntoMessages(
					directory,
					config,
					output,
					agentName,
					systemMsg?.info?.sessionID,
				);
				return;
			}
			if (!isOrchestratorAgent(agentName)) return;

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
			const searchFn =
				_internals.searchKnowledge === defaultSearchKnowledge
					? searchKnowledge
					: _internals.searchKnowledge;
			const search = await searchFn({
				directory,
				config,
				context: retrievalCtx,
				mode: 'auto_injection',
				agent: 'architect',
				sessionId: systemMsg?.info?.sessionID,
				emitEvent: false,
			});
			// Change 5 (Task 6.1): the ≥0.8 hard confidence pre-filter is REMOVED.
			// Confidence already participates in the hybrid score (the metadata
			// signal in search-knowledge.ts), so a hard pre-filter on top of it
			// double-counted confidence and was the cold-start killer — a fresh,
			// in-scope, low-confidence directive could never surface. Ranking +
			// MMR + the cold-start bonus now govern which entries appear.
			const filteredEntries = search.results;
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
						freshPreamble = sanitizeContextText(driftText);
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
					// Sanitize and truncate to stay within token budget (same 500 char limit as drift)
					const truncatedBriefing = sanitizeContextText(briefingContent).slice(
						0,
						500,
					);
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

			// 1. Recently-escalated directives (Change 3) — prepended above the
			// directive block so the architect sees auto-escalations first.
			try {
				const escalations = await readRecentEscalations(directory);
				const escalationBriefing = buildEscalationBriefing(escalations);
				if (escalationBriefing && escalationBriefing.length <= remaining) {
					parts.push(escalationBriefing);
					remaining -= escalationBriefing.length;
				}
			} catch {
				// escalation briefing failures must never break injection
			}

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
				const sanitizedRunMemory = sanitizeContextText(runMemory);
				parts.push(sanitizedRunMemory);
				remaining -= sanitizedRunMemory.length;
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
						`  ⚠️ REJECTED PATTERN: "${sanitizeLessonForContext(r.lesson).slice(0, 80)}" — ${sanitizeLessonForContext(r.rejection_reason)}`,
				);
				const rejectedBlock =
					'⚠️ Previously rejected patterns (do not re-learn):\n' +
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
				const scoreById = new Map(
					filteredEntries.map((e) => [e.id, e.finalScore]),
				);
				const ranks: Record<string, number> = {};
				const scores: Record<string, number> = {};
				cachedShownIds.forEach((id, idx) => {
					ranks[id] = idx + 1;
					scores[id] = scoreById.get(id) ?? 0;
				});
				await _internals.recordKnowledgeEvent(directory, {
					type: 'retrieved',
					trace_id: search.trace_id,
					session_id: systemMsg?.info?.sessionID ?? 'unknown',
					phase: retrievalCtx.currentPhase,
					task_id: retrievalCtx.taskId,
					agent: 'architect',
					query:
						retrievalCtx.lastUserMessage ?? retrievalCtx.currentPhase ?? '',
					retrieval_mode: 'auto_injection',
					result_ids: cachedShownIds,
					ranks,
					scores,
				});
				_internals
					.recordKnowledgeShown(directory, cachedShownIds, {
						phase: phaseLabel,
						tool: retrievalCtx.currentTool,
						action: retrievalCtx.currentAction,
						targetAgent: retrievalCtx.targetAgent,
						taskId: retrievalCtx.taskId,
					})
					.catch(() => {
						// swallow — non-critical telemetry
					});
			}
		},
	);
}

export const _internals: {
	searchKnowledge: typeof searchKnowledge;
	recordKnowledgeEvent: typeof recordKnowledgeEvent;
	recordKnowledgeShown: typeof recordKnowledgeShown;
} = {
	searchKnowledge,
	recordKnowledgeEvent,
	recordKnowledgeShown,
};

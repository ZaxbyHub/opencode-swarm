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
import {
	allocateInjectionBudget,
	getProducerEmission,
	recordProducerEmission,
	recordProducerGrant,
} from '../services/injection-budget.js';
import { getRunMemorySummary } from '../services/run-memory.js';
import {
	clearCriticalShownIds,
	getLiveContextModelIdentity,
	getLiveContextWindow,
	setCriticalShownIds,
} from '../state.js';
import { warn } from '../utils/logger.js';
import { ensureCohortIdCached } from './cohort-cache.js';
import { sanitizeContextText } from './context-sanitizer.js';
import {
	buildDriftInjectionText,
	readPriorDriftReports,
} from './curator-drift.js';
import { extractCurrentPhaseFromPlan } from './extractors.js';
import { resolveMessageTransformContext } from './host-boundary.js';
import { recordKnowledgeShown } from './knowledge-application.js';
import {
	buildEscalationBriefing,
	readRecentEscalations,
} from './knowledge-escalator.js';
import { recordKnowledgeEvent } from './knowledge-events.js';
import { readLinkPointer } from './knowledge-link.js';
import type { RankedEntry } from './knowledge-reader.js';
import { recordLessonsShown } from './knowledge-reader.js';
import {
	commitDisplayedMembership,
	commitEmptyRetrieval,
	queryLiveMemberships,
} from './knowledge-receipt-ledger.js';
import { confirmEntriesPhase, readRejectedLessons } from './knowledge-store.js';
import type {
	DirectivePriority,
	KnowledgeConfig,
	KnowledgeRetrievalContext,
	MessageWithParts,
} from './knowledge-types.js';
import { isActiveStatus } from './knowledge-types.js';
import { extractModelInfo, resolveModelLimit } from './model-limits.js';
import { searchKnowledge } from './search-knowledge.js';
import {
	estimateCharsForTokens,
	estimateTokens,
	estimateTokensFromCharCount,
	readSwarmFileAsync,
	safeHook,
} from './utils.js';

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
 * Result of building a knowledge block: the rendered text AND the ids of the
 * entries that survived the budget trim. Returning the surviving ids
 * structurally (instead of reverse-parsing them out of the rendered text) makes
 * `cachedShownIds` deterministic regardless of sanitization quirks. Issue #1768
 * Change 2.
 */
interface BuiltBlock {
	block: string | null;
	renderedIds: string[];
}

/**
 * Extract the integer phase number from a canonical `Phase N` label, or
 * `undefined` if the string is not a canonical phase label. Used to feed
 * {@link confirmEntriesPhase} / the `injection_skip` telemetry.
 */
function phaseNumberOf(label: string | undefined): number | undefined {
	if (!label) return undefined;
	const m = /^Phase\s+(\d+)/i.exec(label);
	return m ? Number(m[1]) : undefined;
}

/**
 * Emits a structured `injection_skip` diagnostic event so the reason the
 * architect auto-injection path went dark is recoverable from
 * `.swarm/knowledge-events.jsonl` (issue #1768). Fire-and-forget + fail-open:
 * telemetry must never break injection. Every silent early-return in the
 * architect path calls this instead of (or alongside) a bare `warn`.
 */
function recordInjectionSkip(
	directory: string,
	reason: string,
	detail?: {
		agent?: string;
		sessionId?: string;
		phase?: number;
		extra?: Record<string, unknown>;
	},
): void {
	_internals
		.recordKnowledgeEvent(directory, {
			type: 'injection_skip',
			reason,
			agent: detail?.agent,
			session_id: detail?.sessionId,
			phase: detail?.phase,
			detail: detail?.extra,
		})
		.catch(() => {
			// swallow — diagnostic telemetry must never propagate
		});
}

/**
 * Builds a compact knowledge block from ranked entries, respecting a character budget.
 * Returns the formatted block string (or null if empty/fully trimmed) plus the ids
 * of the entries that survived the budget trim.
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
): BuiltBlock {
	if (entries.length === 0) return { block: null, renderedIds: [] };

	const maxDisplayChars = cfg.max_lesson_display_chars ?? 120;

	// Zip each entry with its rendered line so the budget-trim loop can drop
	// both together, preserving the id ↔ line association structurally.
	const rendered: { id: string; line: string }[] = entries.map((entry) => {
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

		return { id: entry.id, line: `${tier} ${lessonText}${source}${confirm}` };
	});

	const header = '📚 Lessons:\n';

	// Trim whole entries from end if block exceeds charBudget
	let block = `${header}\n${rendered.map((r) => r.line).join('\n')}`;
	while (block.length > charBudget && rendered.length > 0) {
		rendered.pop();
		block = `${header}\n${rendered.map((r) => r.line).join('\n')}`;
	}

	return rendered.length > 0
		? { block, renderedIds: rendered.map((r) => r.id) }
		: { block: null, renderedIds: [] };
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
	traceId: string,
): BuiltBlock {
	if (entries.length === 0) return { block: null, renderedIds: [] };
	const maxDisplay = cfg.max_lesson_display_chars ?? 120;
	// Build each directive as a self-contained record group so the budget-trim
	// loop can drop whole records (and track their ids structurally).
	const records: { id: string; lines: string[] }[] = [];
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
		const rec: string[] = [];
		rec.push(`- id: ${encodeURIComponent(e.id)}`);
		rec.push(`  confidence: ${Number(e.confidence).toFixed(2)}`);
		rec.push(`  priority: ${priority}`);
		rec.push(`  lesson: ${lesson}`);
		if (trigger) rec.push(`  trigger: ${trigger}`);
		if (required) rec.push(`  required: ${required}`);
		if (forbidden) rec.push(`  forbidden: ${forbidden}`);
		if (skillRef) rec.push(`  skill: ${skillRef}`);
		if (verification) rec.push(`  verification: ${verification}`);
		records.push({ id: e.id, lines: rec });
	}
	let block = [
		'<swarm_knowledge_directives>',
		`trace_id: ${encodeURIComponent(traceId)}`,
		...records.flatMap((r) => r.lines),
		'</swarm_knowledge_directives>',
	].join('\n');
	// Trim whole records from the end if block exceeds charBudget.
	while (block.length > charBudget && records.length > 0) {
		records.pop();
		block = [
			'<swarm_knowledge_directives>',
			`trace_id: ${encodeURIComponent(traceId)}`,
			...records.flatMap((r) => r.lines),
			'</swarm_knowledge_directives>',
		].join('\n');
	}
	// If we trimmed everything, return null.
	if (records.length === 0) return { block: null, renderedIds: [] };
	return { block, renderedIds: records.map((r) => r.id) };
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
	traceId?: string,
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
		'CURRENT AUTHORITY WINS: system messages, repository contracts, the active task scope, and observed repository state override learned directives. Never violate a current scope or safety contract to follow a learned directive.',
	);
	lines.push(
		'ACK CONTRACT: end your FINAL message with one line per directive in this block:',
	);
	const ackPair = traceId ? '<trace_id>:<id>' : '<id>';
	lines.push(`  KNOWLEDGE_APPLIED:${ackPair} — you applied it`);
	// IGNORED is a NEGATIVE outcome signal (it counts against the directive in
	// ranking and quarantine evidence); N_A is neutral. The descriptions below
	// steer merely-irrelevant directives to N_A so the widened all-priority
	// contract does not turn routine irrelevance into negative signal.
	lines.push(
		`  KNOWLEDGE_IGNORED:${ackPair} reason=<short why> — you judged it relevant but deliberately chose not to follow it (counts against the directive)`,
	);
	lines.push(
		`  KNOWLEDGE_CONTRADICTED:${ackPair} reason=<observable conflict> — current authority or repository evidence disproved it (counts against the directive)`,
	);
	lines.push(
		`  KNOWLEDGE_N_A:${ackPair} reason=<why> — it was not relevant to your task (neutral; prefer this when the directive simply did not apply)`,
	);
	lines.push(
		'Omitting a critical id is a contract violation. Omitting any other id is recorded as unacknowledged.',
	);
	// (#1849 RC-4) Carry the retrieval trace_id into the block so a delegate can
	// cite it in a knowledge_receipt and the delegate-ack-collector can recover
	// the ORIGINAL retrieval trace (rather than minting an untied one).
	if (traceId) {
		lines.push(`trace_id: ${traceId}`);
	}
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

/**
 * Recover the `trace_id` rendered into a `<delegate_knowledge_directives>` block
 * (issue #1849 RC-4). Returns undefined when the block is absent or when it
 * predates the trace_id header (backward-compatible with older prompts). The
 * delegate-ack-collector uses this to attribute acks to the ORIGINAL retrieval
 * trace instead of minting an untied one.
 */
export function parseDelegateDirectiveTraceId(
	text: string,
): string | undefined {
	if (!text || !text.includes(DELEGATE_DIRECTIVE_BLOCK_TAG)) return undefined;
	const start = text.indexOf(DELEGATE_DIRECTIVE_BLOCK_TAG);
	const endTag = '</delegate_knowledge_directives>';
	const endIdx = text.indexOf(endTag, start);
	const body = endIdx >= 0 ? text.slice(start, endIdx) : text.slice(start);
	for (const line of body.split('\n')) {
		const m = /^trace_id:\s*(\S+)\s*$/m.exec(line);
		if (m) return m[1];
	}
	return undefined;
}

export interface InjectForDelegateParams {
	directory: string;
	agent: string;
	expectedTools?: string[];
	taskTitle?: string;
	taskId?: string;
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
 * Monotonic counter bumped whenever the knowledge corpus changes underneath a
 * live session (issue #1821, Workstream B).
 *
 * The architect injector memoizes its rendered block against a cache key built
 * from the retrieval CONTEXT only (phase, tool, agent, task, files, last user
 * message). Real-time admission changes the corpus without changing any of
 * those, so an architect sitting in the same phase would keep seeing the
 * pre-admission block — the newly learned lesson would be invisible for the
 * rest of the phase. Folding this counter into the cache key makes an
 * admission invalidate the memo exactly once.
 *
 * The delegate path (`injectForDelegate`) is UNCACHED and `readKnowledge`'s
 * parse cache is already invalidated by `atomicWriteFile`, so only this
 * architect-side memo needed the extra signal.
 */
let knowledgeGeneration = 0;

/** Invalidate memoized injections. Called by the admission path after a write. */
export function bumpKnowledgeGeneration(): number {
	knowledgeGeneration++;
	return knowledgeGeneration;
}

/** Current corpus generation. Part of the architect injection cache key. */
export function getKnowledgeGeneration(): number {
	return knowledgeGeneration;
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
	// V2 receipt authority is session-bound. Without a real host session there is
	// no truthful membership to persist, so optional delegate injection is skipped.
	if (!sessionId) return { entries: [], trace_id: '' };
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

		// Persist the exact final displayed set before returning it to the caller.
		// Failure skips optional injection; no unverifiable directive is exposed.
		if (capped.length > 0) {
			const ranks: Record<string, number> = {};
			const scores: Record<string, number> = {};
			capped.forEach((e, idx) => {
				ranks[e.id] = idx + 1;
				scores[e.id] = e.finalScore;
			});
			const cohortId = await _internals.ensureCohortIdCached(
				directory,
				sessionId,
			);
			const sourceLinkId = _internals.readLinkPointer(directory)?.linkId;
			const membership = await _internals.commitDisplayedMembership(directory, {
				trace_id: search.trace_id,
				session_id: sessionId,
				exposure_kind: 'delegate_directive',
				phase: params.phase,
				task_id: params.taskId,
				agent,
				cohort_id: cohortId,
				source_link_id: sourceLinkId,
				grace_days: config.receipt_close_grace_days,
				entries: capped.map((entry, index) => ({
					entry_id: entry.id,
					critical:
						entry.directive_priority === 'critical' &&
						isActiveStatus(entry.status),
					rank: index + 1,
					score: entry.finalScore,
				})),
			});
			if (
				!membership.ok ||
				membership.memberships.some((item) => item.terminal)
			) {
				recordInjectionSkip(
					directory,
					membership.ok ? 'terminal_trace_reuse' : membership.code,
					{
						agent,
						sessionId,
						extra: { trace_id: search.trace_id },
					},
				);
				return { entries: [], trace_id: '' };
			}

			// Diagnostic dual-write occurs only after V2 commit and lock release.
			await _internals.recordKnowledgeEvent(directory, {
				type: 'retrieved',
				trace_id: search.trace_id,
				session_id: sessionId,
				phase: params.phase,
				task_id: params.taskId,
				agent,
				query: taskTitle ?? '',
				retrieval_mode: 'delegate_inject',
				result_ids: capped.map((e) => e.id),
				ranks,
				scores,
			});
			// (#1768 Change 3c + Change 4) When the canonical `Phase N` label is
			// available, record the delegate-shown set under that key (union-merged
			// with any architect-shown set for the same phase) and bump shown_count,
			// so delegate-shown knowledge receives outcome attribution at
			// phase-complete and accumulates phase confirmation — previously the
			// delegate path recorded only the retrieved event, under the raw task
			// title, which updateRetrievalOutcome never matched.
			if (params.phase) {
				const shownIds = capped.map((e) => e.id);
				_internals
					.recordLessonsShown(directory, shownIds, params.phase)
					.catch(() => {});
				_internals
					.recordKnowledgeShown(directory, shownIds, {
						phase: params.phase,
						targetAgent: agent,
						sessionId,
					})
					.catch(() => {});
				const phaseNum = phaseNumberOf(params.phase);
				if (phaseNum !== undefined) {
					// Resolve projectName for the confirmation record. The canonical
					// caller passes params.phase from the plan; derive projectName
					// from the same plan here to avoid widening the param interface.
					const plan = await loadPlan(directory).catch(() => null);
					const projectName = plan?.title ?? 'unknown';
					_internals
						.confirmEntriesPhase(directory, shownIds, phaseNum, projectName)
						.catch(() => {});
				}
			}
		}
		// Empty retrieval uses a trace-level V2 lifecycle without inventing a pair.
		if (capped.length === 0) {
			try {
				const empty = await _internals.commitEmptyRetrieval(directory, {
					trace_id: search.trace_id,
					session_id: sessionId,
					phase: params.phase,
					agent,
					grace_days: config.receipt_close_grace_days,
				});
				if (!empty.ok || !empty.terminal_event_id)
					return { entries: [], trace_id: '' };
				await _internals.recordKnowledgeEvent(directory, {
					type: 'retrieved',
					trace_id: search.trace_id,
					session_id: sessionId,
					phase: params.phase,
					agent,
					query: taskTitle ?? '',
					retrieval_mode: 'delegate_inject',
					result_ids: [],
					ranks: {},
					scores: {},
				});
				await _internals.recordKnowledgeEvent(directory, {
					type: 'no_relevant',
					trace_id: search.trace_id,
					session_id: sessionId,
					phase: params.phase,
					agent,
					reason: 'empty delegate retrieval',
				});
			} catch {
				/* non-blocking */
			}
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

	// (#1768 Change 3c) Resolve the canonical `Phase N` label from the plan
	// so delegate-shown knowledge is recorded under the SAME key the architect
	// path + updateRetrievalOutcome use — eliminating orphaned task-title keys
	// that previously received no outcome attribution. Mirrors the
	// delegate-directive-injection.ts tool.execute.before caller. loadPlan is
	// bounded (cached; same call the architect path makes) and this is a
	// runtime hook, so there is no init-path concern.
	const plan = await loadPlan(directory).catch(() => null);
	const phaseLabel = plan
		? (extractCurrentPhaseFromPlan(plan) ?? `Phase ${plan.current_phase ?? 1}`)
		: undefined;

	const { entries, trace_id } = await injectForDelegate({
		directory,
		agent: agentName,
		expectedTools: defaultExpectedToolsForAgent(agentName),
		taskTitle,
		sessionId,
		phase: phaseLabel,
		config,
	});
	// (#1849 RC-4) Thread the retrieval trace_id into the rendered block so the
	// delegate can cite it and the ack-collector recovers the original trace.
	const block = buildDelegateDirectiveBlock(entries, config, trace_id);
	if (!block) return;
	injectKnowledgeMessage(output, block, sessionId);
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
	sessionId?: string,
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

	// #2107 §2: record what actually reached the model-visible surface (this is
	// a messages-surface producer — final accounting measures it directly, so
	// this entry is attribution-only and is never added to the measured total).
	if (sessionId) {
		recordProducerEmission(
			sessionId,
			'knowledge-injector',
			estimateTokens(knowledgeMessage.parts[0]?.text ?? ''),
			0,
			'messages',
		);
	}
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
	modelLimitOverrides: Record<string, number> = {},
	unifiedInjectionTokens: number | undefined = undefined,
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
			// #1821: corpus generation. Without it a real-time admission cannot
			// invalidate this memo, because none of the context fields below change
			// when knowledge is added mid-phase.
			String(getKnowledgeGeneration()),
			ctx.currentTool ?? '',
			ctx.currentAction ?? '',
			ctx.targetAgent ?? '',
			ctx.taskId ?? '',
			(ctx.filePaths ?? []).slice(0, 8).join(','),
			ctx.lastUserMessage
				? createHash('sha1')
						.update(ctx.lastUserMessage)
						.digest('hex')
						.slice(0, 16)
				: '',
		].join('|');
		return createHash('sha1').update(parts).digest('hex').slice(0, 16);
	}

	let lastSeenCacheKey: string | null = null;
	let cachedInjectionText: string | null = null;
	let cachedShownIds: string[] = [];
	let cachedCriticalIds: string[] = [];
	let cachedTraceId: string | null = null;

	return safeHook(
		async (
			_input: Record<string, never>,
			output: { messages?: MessageWithParts[] },
		) => {
			if (!output.messages || output.messages.length === 0) return;

			// Load plan — proceed with default context if no plan exists
			const plan = await loadPlan(directory);
			const currentPhase = plan?.current_phase ?? 1;

			// (#1849/headroom-attribution) Identity recovery via the host-boundary
			// adapter, resolved BEFORE the headroom gate below. This is pure
			// in-memory recovery (swarmState.activeAgent / message info scan — no
			// I/O, see resolveMessageTransformContext in host-boundary.ts), so
			// resolving it early is cheap and lets the headroom_budget skip event
			// carry agent/session identity instead of firing anonymously.
			const mctx = resolveMessageTransformContext(output);
			const agentName = mctx.agent;
			const sessionId = mctx.sessionID;
			if (!sessionId) {
				recordInjectionSkip(directory, 'missing_session_id', {
					agent: agentName,
				});
				return;
			}

			// Budget-residual check (BACM-style: evaluate headroom before appending)
			// Uses the canonical estimator's inverse (estimateCharsForTokens) — the
			// single sanctioned char/token conversion (issue #1616/#2107).
			const liveModelInfo = getLiveContextModelIdentity(sessionId);
			const { modelID, providerID } =
				liveModelInfo ?? extractModelInfo(output.messages);
			// Live `model.limit.context` relayed from the system.transform hook via
			// session state (this hook receives messages, never a `Model`). Without
			// it the headroom gate below measured against a stale 128000, so a
			// session on a 200k–1M model looked out of headroom — and
			// `recordInjectionSkip('headroom_budget')` shows this gate is already a
			// known dark-in-production suspect. `undefined` before the first
			// system.transform of a session; that falls back to the static rungs.
			const liveContextLimit = getLiveContextWindow(sessionId, {
				modelID,
				providerID,
			});
			const modelLimitTokens = resolveModelLimit(
				modelID,
				providerID,
				modelLimitOverrides,
				liveContextLimit,
			);
			const MODEL_LIMIT_CHARS = estimateCharsForTokens(modelLimitTokens);
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
				// (#1768) structured skip telemetry — the headroom gate is a prime
				// candidate for the dark-in-production symptom (a small/default model
				// limit makes headroom negative permanently). Diagnose from .swarm.
				recordInjectionSkip(directory, 'headroom_budget', {
					agent: agentName,
					sessionId,
					extra: {
						headroomChars,
						existingChars,
						modelLimitChars: MODEL_LIMIT_CHARS,
						modelID,
					},
				});
				return;
			}

			// Three-regime injection budget (maps to BACM high/moderate/low budget regimes)
			const maxInjectChars = config.inject_char_budget ?? 2_000;
			let effectiveBudget =
				headroomChars >= MODEL_LIMIT_CHARS * 0.6
					? maxInjectChars // high: >60% remaining — full budget
					: headroomChars >= MODEL_LIMIT_CHARS * 0.2
						? Math.floor(maxInjectChars * 0.5) // moderate: 20–60% — half budget
						: Math.floor(maxInjectChars * 0.25); // low: 5–20% — quarter budget

			// (#1849) `agentName`/`sessionId` were resolved above (before the
			// headroom gate) via the host-boundary adapter. The SDK
			// `experimental.chat.messages.transform` input is `{}` and the
			// `Message` union has NO `role:'system'` variant — so the pre-#1849
			// `output.messages.find(role==='system')` lookup was always undefined,
			// `agentName` was always undefined, and the `no_agent_name` skip fired
			// every architect turn (the dark-in-production root cause, #1768).
			// The adapter recovers agent from swarmState.activeAgent (primary, set
			// by chat.message) with the last user message's info.agent as a
			// first-turn fallback, and sessionID from any message's info.sessionID.
			if (!agentName) {
				// (#1768/#1849) Genuine empty case: no swarmState entry AND no user
				// message carrying info.agent. Diagnostic tombstone only.
				recordInjectionSkip(directory, 'no_agent_name', { sessionId });
				return;
			}

			// FR-002 / #2107 §2: unified injection budget — draw from shared ceiling so
			// system-enhancer + knowledge-injector combined stay within budget, and
			// book the allocator-derived grant + actual emission into the turn ledger.
			if (unifiedInjectionTokens !== undefined) {
				const sessionID = sessionId;
				const seDemand = sessionID
					? getProducerEmission(sessionID, 'system-enhancer')
					: 0;
				const requestedTokens = estimateTokensFromCharCount(effectiveBudget);
				const allocation = allocateInjectionBudget(seDemand, effectiveBudget, {
					totalBudgetTokens: unifiedInjectionTokens,
				});
				effectiveBudget = estimateCharsForTokens(
					allocation.knowledgeInjectorTokens,
				);
				if (sessionID) {
					recordProducerGrant(
						sessionID,
						'knowledge-injector',
						requestedTokens,
						allocation.knowledgeInjectorTokens,
						'messages',
					);
				}
			}

			if (isDelegatedAgent(agentName)) {
				await injectForDelegateIntoMessages(
					directory,
					config,
					output,
					agentName,
					sessionId,
				);
				return;
			}
			if (!isOrchestratorAgent(agentName)) {
				// (#1768) an agent we recognize (so not the delegate path) but is
				// not the architect. Emit only for the non-delegate, non-architect
				// case to avoid noise from legitimate delegate traffic (handled above).
				recordInjectionSkip(directory, 'not_architect', {
					agent: agentName,
					sessionId,
				});
				return;
			}

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
				let cacheVerifiable = cachedShownIds.length === 0;
				if (cachedShownIds.length > 0 && cachedTraceId) {
					const live = await _internals.queryLiveMemberships(directory, {
						session_id: sessionId,
						include_terminal: false,
					});
					if (live.ok) {
						const liveIds = new Set(
							live.memberships
								.filter((membership) => membership.trace_id === cachedTraceId)
								.map((membership) => membership.entry_id),
						);
						cacheVerifiable = cachedShownIds.every((id) => liveIds.has(id));
					}
				}
				if (cacheVerifiable)
					injectKnowledgeMessage(output, cachedInjectionText, sessionId);
				const sessionID = sessionId;
				if (sessionID && cacheVerifiable) {
					if (cachedCriticalIds.length > 0) {
						setCriticalShownIds(sessionID, {
							ids: cachedCriticalIds,
							phase: `Phase ${currentPhase}`,
							generatedAt: Date.now(),
						});
					} else {
						clearCriticalShownIds(sessionID);
					}
				}
				if (cacheVerifiable) return;
			}
			lastSeenCacheKey = cacheKey;
			cachedInjectionText = null;
			cachedShownIds = [];
			cachedCriticalIds = [];
			cachedTraceId = null;

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
				sessionId: sessionId,
				emitEvent: false,
			});
			cachedTraceId = search.trace_id;
			// Change 5 (Task 6.1): the ≥0.8 hard confidence pre-filter is REMOVED.
			// Confidence already participates in the hybrid score (the metadata
			// signal in search-knowledge.ts), so a hard pre-filter on top of it
			// double-counted confidence and was the cold-start killer — a fresh,
			// in-scope, low-confidence directive could never surface. Ranking +
			// MMR + the cold-start bonus now govern which entries appear.
			const filteredEntries = search.results;

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
				const sessionID = sessionId;
				if (sessionID) {
					clearCriticalShownIds(sessionID);
				}
				cachedShownIds = [];
				cachedCriticalIds = [];
				// (#1768) the gate opened (architect + headroom OK) but search
				// returned zero matching entries — the knowledge loop has nothing
				// to feed it this turn. Diagnose from .swarm (cold store, role
				// gating, or all-quarantined).
				recordInjectionSkip(directory, 'no_matching_entries', {
					agent: agentName,
					sessionId: sessionID,
					phase: currentPhase,
				});
				const empty = await _internals.commitEmptyRetrieval(directory, {
					trace_id: search.trace_id,
					session_id: sessionId,
					phase: retrievalCtx.currentPhase,
					task_id: retrievalCtx.taskId,
					agent: 'architect',
					grace_days: config.receipt_close_grace_days,
				});
				const emptyCommitted = empty.ok && Boolean(empty.terminal_event_id);
				// (#1849 R1) Every retrieval attempt — including an empty one — must
				// leave one durable terminal accounting path. Emit a `retrieved`
				// event with empty result_ids (carrying the real trace_id) so a
				// receipt can reference it, then a `no_relevant` terminal tombstone
				// when there is genuinely nothing to inject (no drift/briefing
				// fallback either). Fail-open: recording errors never block injection.
				try {
					if (emptyCommitted)
						await _internals.recordKnowledgeEvent(directory, {
							type: 'retrieved',
							trace_id: search.trace_id,
							session_id: sessionId,
							phase: retrievalCtx.currentPhase,
							task_id: retrievalCtx.taskId,
							agent: 'architect',
							query:
								retrievalCtx.lastUserMessage ?? retrievalCtx.currentPhase ?? '',
							retrieval_mode: 'auto_injection',
							result_ids: [],
							ranks: {},
							scores: {},
						});
				} catch {
					/* non-blocking — diagnostics only */
				}
				if (freshPreamble === null) {
					// Real empty retrieval: file a `no_relevant` terminal so the cycle
					// is accountable in diagnostics and the trace is closeable.
					try {
						if (emptyCommitted)
							await _internals.recordKnowledgeEvent(directory, {
								type: 'no_relevant',
								trace_id: search.trace_id,
								session_id: sessionId,
								phase: retrievalCtx.currentPhase,
								task_id: retrievalCtx.taskId,
								agent: 'architect',
								reason: 'empty auto-injection retrieval',
							});
					} catch {
						/* non-blocking */
					}
					return;
				}
				// Drift or briefing exists — cache and inject it directly
				cachedInjectionText = freshPreamble;
				injectKnowledgeMessage(output, cachedInjectionText, sessionId);
				return;
			}

			// Get run memory summary. This is optional context; failures must not
			// suppress the knowledge block retrieved above.
			let runMemory: string | null = null;
			try {
				runMemory = await getRunMemorySummary(directory);
			} catch (err) {
				warn(
					`[knowledge-injector] run memory summary unavailable: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}

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
			const directiveBuilt = buildDirectiveBlock(
				directiveEntries,
				directiveBudget,
				config,
				search.trace_id,
			);
			const directiveBlock = directiveBuilt.block;

			const lessonBuilt = buildKnowledgeBlock(
				filteredEntries,
				lessonBudget,
				config,
				projectName,
			);
			const lessonBlock = lessonBuilt.block;

			// (#1768 Change 2) cachedShownIds is now derived STRUCTURALLY from
			// the ids each builder reported as surviving the budget trim — no
			// more fragile reverse text-substring matching.
			const renderedDirectiveIdSet = new Set(directiveBuilt.renderedIds);
			cachedShownIds = [
				...new Set([...directiveBuilt.renderedIds, ...lessonBuilt.renderedIds]),
			];
			// (#1768) entries existed but the budget trim dropped every one of
			// them — nothing was actually rendered, so nothing can be recorded.
			// Diagnostic for the rare tight-budget case.
			if (cachedShownIds.length === 0) {
				recordInjectionSkip(directory, 'rendered_id_match_failed', {
					agent: agentName,
					sessionId: sessionId,
					phase: currentPhase,
					extra: {
						filteredCount: filteredEntries.length,
						directiveCount: directiveEntries.length,
					},
				});
			}

			const parts: string[] = [];
			let remaining = effectiveBudget;

			// 1. Recently-escalated directives (Change 3) — prepended above the
			// directive block so the architect sees auto-escalations first.
			try {
				const escalations = await _internals.readRecentEscalations(directory);
				const escalationBriefing =
					_internals.buildEscalationBriefing(escalations);
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

			// 2. Run memory. The `remaining > 300` floor keeps a tiny leftover
			// budget from being spent on a truncated block, but it is not a fit
			// check: getRunMemorySummary is capped at ~500 tokens (~1500 chars),
			// so a summary well over `remaining` would previously be pushed
			// whole and overshoot the budget, driving `remaining` negative and
			// starving every lower-priority section. Sanitize first (sanitizing
			// can lengthen the text) and then require the final string to fit,
			// mirroring the drift-preamble check below.
			if (runMemory && remaining > 300) {
				const sanitizedRunMemory = sanitizeContextText(runMemory);
				if (sanitizedRunMemory.length <= remaining) {
					parts.push(sanitizedRunMemory);
					remaining -= sanitizedRunMemory.length;
				}
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

			// 4. Rejected warnings (lowest priority). Optional guardrail context must
			// not suppress the primary knowledge block.
			try {
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
			} catch (err) {
				warn(
					`[knowledge-injector] rejected pattern warnings unavailable: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}

			cachedInjectionText = parts.join('\n\n');
			const criticalIds = filteredEntries
				.filter((e) => renderedDirectiveIdSet.has(e.id))
				.filter(
					(e) =>
						e.directive_priority === 'critical' && isActiveStatus(e.status),
				)
				.map((e) => e.id);

			if (cachedShownIds.length > 0) {
				const byId = new Map(filteredEntries.map((entry) => [entry.id, entry]));
				// Issue #2031: lineage is display-time truth. Capture it on the
				// membership before the directive reaches chat so a later architect
				// application terminal remains eligible for cohort-scoped promotion.
				const cohortId = await _internals.ensureCohortIdCached(
					directory,
					sessionId,
				);
				const sourceLinkId = _internals.readLinkPointer(directory)?.linkId;
				const membership = await _internals.commitDisplayedMembership(
					directory,
					{
						trace_id: search.trace_id,
						session_id: sessionId,
						exposure_kind: 'architect_directive',
						phase: retrievalCtx.currentPhase,
						task_id: retrievalCtx.taskId,
						agent: 'architect',
						cohort_id: cohortId,
						source_link_id: sourceLinkId,
						grace_days: config.receipt_close_grace_days,
						entries: cachedShownIds.map((id, index) => ({
							entry_id: id,
							critical: criticalIds.includes(id),
							rank: index + 1,
							score: byId.get(id)?.finalScore,
						})),
					},
				);
				if (
					!membership.ok ||
					membership.memberships.some((item) => item.terminal)
				) {
					cachedInjectionText = '';
					cachedShownIds = [];
					cachedCriticalIds = [];
					if (sessionId) clearCriticalShownIds(sessionId);
					recordInjectionSkip(
						directory,
						membership.ok ? 'terminal_trace_reuse' : membership.code,
						{
							agent: agentName,
							sessionId,
							phase: currentPhase,
							extra: { trace_id: search.trace_id },
						},
					);
					return;
				}
			}
			injectKnowledgeMessage(output, cachedInjectionText, sessionId);

			// v2: Populate in-memory currentCriticalShownIds so the toolBefore
			// enforcement gate can read O(1) without re-scanning JSONL.
			// Keyed by sessionID — the gate consults this exact key.
			const sessionID = sessionId;
			if (sessionID) {
				cachedCriticalIds = criticalIds;
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
					session_id: sessionId,
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
				// (#1768 Change 3b) Record the FINAL rendered set under the
				// canonical `Phase N` key so updateRetrievalOutcome attributes
				// the phase outcome to exactly these entries (not the widened
				// pre-rerank pool the old readMergedKnowledge side effect recorded).
				// Union-merge inside recordLessonsShown makes this safe alongside
				// concurrent delegate writes.
				_internals
					.recordLessonsShown(directory, cachedShownIds, phaseLabel)
					.catch(() => {
						// swallow — non-critical attribution telemetry
					});
				// (#1768 Change 4) Retrieval is a phase-confirmation signal:
				// surfacing an entry in phase N counts as a confirmation, so
				// multi-phase confirmation can accumulate from normal loop
				// activity (previously only near-duplicate re-add confirmed).
				// Batched + fail-open; reuses reinforceSwarmKnowledgeEntry so
				// confidence stays consistent with confirmed_by.
				_internals
					.confirmEntriesPhase(
						directory,
						cachedShownIds,
						currentPhase,
						projectName,
					)
					.catch(() => {
						// swallow — best-effort confirmation telemetry
					});
			}
		},
	);
}

export const _internals: {
	searchKnowledge: typeof searchKnowledge;
	recordKnowledgeEvent: typeof recordKnowledgeEvent;
	recordKnowledgeShown: typeof recordKnowledgeShown;
	readRecentEscalations: typeof readRecentEscalations;
	buildEscalationBriefing: typeof buildEscalationBriefing;
	recordLessonsShown: typeof recordLessonsShown;
	confirmEntriesPhase: typeof confirmEntriesPhase;
	commitDisplayedMembership: typeof commitDisplayedMembership;
	commitEmptyRetrieval: typeof commitEmptyRetrieval;
	queryLiveMemberships: typeof queryLiveMemberships;
	ensureCohortIdCached: typeof ensureCohortIdCached;
	readLinkPointer: typeof readLinkPointer;
} = {
	searchKnowledge,
	recordKnowledgeEvent,
	recordKnowledgeShown,
	readRecentEscalations,
	buildEscalationBriefing,
	recordLessonsShown,
	confirmEntriesPhase,
	commitDisplayedMembership,
	commitEmptyRetrieval,
	queryLiveMemberships,
	ensureCohortIdCached,
	readLinkPointer,
};

/**
 * Tier-0 test seam (see `.opencode/skills/writing-tests/SKILL.md`). Exposes the
 * real injection primitive and its sentinel so the
 * `consolidateSystemMessages` interaction test (issue #1619) exercises the
 * production splice position and message shape instead of a hand-copied fixture
 * that could silently drift from this module.
 */
export const _test_exports = {
	injectKnowledgeMessage,
	INJECTION_SENTINEL,
};

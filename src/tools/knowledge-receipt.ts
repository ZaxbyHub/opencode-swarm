/**
 * knowledge_receipt — the knowledge acknowledgment tool (replaces the former knowledge_ack).
 *
 * An agent files a single receipt summarizing how it considered the knowledge
 * surfaced by a retrieval (referenced by `trace_id`): which entries were
 * applied, which were ignored (with a reason), which were contradicted by
 * current evidence (with a proposed remediation), and any new lessons learned.
 *
 * Each applied/ignored/contradicted item becomes one immutable event in
 * `.swarm/knowledge-events.jsonl`. New lessons are persisted through the normal
 * knowledge_add validation/dedup path. When a retrieval surfaced nothing
 * relevant, the receipt can set `no_relevant_knowledge: true` — the point is to
 * force explicit consideration, not fake usage.
 */

import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config/index.js';
import {
	KnowledgeConfigSchema,
	stripKnownSwarmPrefix,
} from '../config/schema.js';
import { ensureCohortIdCached } from '../hooks/cohort-cache.js';
import {
	type KnowledgeEventInput,
	recordKnowledgeEvent,
} from '../hooks/knowledge-events.js';
import { readLinkPointer } from '../hooks/knowledge-link.js';
import {
	type ReceiptItem,
	validateReceipt,
} from '../hooks/knowledge-receipt-validator.js';
import type { PromotionEvidenceRecord } from '../hooks/knowledge-types.js';
import { appendPromotionEvidence } from '../hooks/promotion-evidence-store.js';
import { log } from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';
import { knowledge_add } from './knowledge-add.js';

/** Read the link pointer id if present, fail-open. */
async function readLinkPointerSafe(
	directory: string,
): Promise<string | undefined> {
	try {
		return readLinkPointer(directory)?.linkId;
	} catch {
		return undefined;
	}
}

/**
 * Reasons a RELEVANT directive was deliberately not followed (issue #2032).
 * Mere non-applicability is NOT an ignore reason — it files a neutral `n_a`
 * item instead, so routine irrelevance never produces negative signal.
 */
const IGNORE_REASONS = [
	'stale',
	'superseded',
	'unsafe',
	'too_generic',
	'already_satisfied',
	'other',
] as const;

const PROPOSED_ACTIONS = ['archive', 'revise', 'quarantine'] as const;

const VERIFIED_BY = ['reviewer', 'test_engineer', 'architect'] as const;

const appliedItem = z.object({
	id: z.string().min(1),
	how: z.string().min(1).max(500),
	evidence_files: z.array(z.string()).optional(),
	evidence_commands: z.array(z.string()).optional(),
	verified_by: z.enum(VERIFIED_BY).optional(),
});

const ignoredItem = z.object({
	id: z.string().min(1),
	reason: z.enum(IGNORE_REASONS),
	note: z.string().max(500).optional(),
});

/**
 * A shown entry that did not apply to the task at hand (issue #2032).
 * Reasoned: the reason is required so `n_a` cannot be used as a silent
 * evasion channel — a gate consumer can always ask "why not applicable?".
 * The reason is trimmed before validation (min(1) after trim), so a
 * whitespace-only reason is rejected exactly like an empty one — matching
 * the phase gate's `reason?.trim()` resolution rule.
 */
const notApplicableItem = z.object({
	id: z.string().min(1),
	reason: z.string().trim().min(1).max(500),
});

const contradictedItem = z.object({
	id: z.string().min(1),
	evidence: z.string().min(1).max(500),
	proposed_action: z.enum(PROPOSED_ACTIONS),
});

const newLessonItem = z.object({
	lesson: z.string().min(15).max(280),
	category: z.string().min(1),
	evidence: z.string().max(500).optional(),
	// v3 actionability fields — forwarded to knowledge_add so a receipt can file
	// an actionable lesson. Without at least one predicate AND one scope field,
	// knowledge_add's Layer-5 gate quarantines the lesson instead of activating it.
	applies_to_agents: z.array(z.string()).optional(),
	applies_to_tools: z.array(z.string()).optional(),
	required_actions: z.array(z.string()).optional(),
	forbidden_actions: z.array(z.string()).optional(),
	verification_checks: z.array(z.string()).optional(),
});

/**
 * Map the calling agent to a canonical receipt-source class (issue #2032).
 * Explicit allowlist — do NOT widen silently. The three independent-verifier
 * roles the knowledge contract names get their own class; every other
 * non-empty role (coder, spec_writer, sme, docs, designer, custom roles) is
 * the exposed agent reporting on itself, which is exactly what the
 * `'delegate'` source class means — a self-report, NOT "subagent of an
 * architect". Unknown/absent caller stays honestly `'unknown'`; missing
 * legacy source is never inferred.
 */
function receiptSourceForAgent(agent: string): string {
	// Trim first: host-supplied names should never carry whitespace, but a
	// defensive trim keeps 'reviewer ' from silently classifying as 'delegate'
	// (#2032 review PRR-004) instead of failing loudly in telemetry.
	const base = stripKnownSwarmPrefix(agent.trim());
	if (!base || base === 'unknown') return 'unknown';
	if (base === 'reviewer') return 'reviewer';
	if (base === 'test_engineer') return 'test_engineer';
	if (base === 'architect') return 'architect';
	return 'delegate';
}

export const knowledge_receipt: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'File a receipt for knowledge surfaced by a retrieval (by trace_id): which entries were applied (with evidence), ignored with a reason (relevant but deliberately not followed — counts against the entry), marked n_a with a reason (not applicable to this task — neutral), or contradicted (with proposed remediation), plus any new lessons. Each item is recorded as an immutable knowledge event. Set no_relevant_knowledge:true when a retrieval surfaced nothing useful.',
		args: {
			trace_id: z
				.string()
				.min(1)
				.describe(
					"trace_id from a prior knowledge_recall/injection, or 'none' if no retrieval occurred",
				),
			task_id: z.string().min(1).optional(),
			phase: z.string().optional(),
			applied: z.array(appliedItem).optional(),
			ignored: z
				.array(ignoredItem)
				.optional()
				.describe(
					'entries you judged relevant but deliberately did not follow (counts against the entry). NOT for not-applicable entries — file those under n_a',
				),
			n_a: z
				.array(notApplicableItem)
				.optional()
				.describe(
					'entries that did not apply to this task (neutral; reasoned). Replaces the removed not_relevant ignore reason',
				),
			contradicted: z.array(contradictedItem).optional(),
			new_lessons: z.array(newLessonItem).optional(),
			no_relevant_knowledge: z.boolean().optional(),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			const a = (args ?? {}) as {
				trace_id?: unknown;
				task_id?: unknown;
				phase?: unknown;
				applied?: z.infer<typeof appliedItem>[];
				ignored?: z.infer<typeof ignoredItem>[];
				n_a?: z.infer<typeof notApplicableItem>[];
				contradicted?: z.infer<typeof contradictedItem>[];
				new_lessons?: z.infer<typeof newLessonItem>[];
				no_relevant_knowledge?: unknown;
			};

			const traceId = typeof a.trace_id === 'string' ? a.trace_id : '';
			if (!traceId) {
				return JSON.stringify({
					recorded: false,
					error: 'trace_id is required (use "none" if no retrieval occurred)',
				});
			}
			const taskId =
				typeof a.task_id === 'string' && a.task_id.trim()
					? a.task_id.trim()
					: undefined;
			const phase = typeof a.phase === 'string' ? a.phase : undefined;
			const applied = Array.isArray(a.applied) ? a.applied : [];
			const ignored = Array.isArray(a.ignored) ? a.ignored : [];
			const notApplicable = Array.isArray(a.n_a) ? a.n_a : [];
			const contradicted = Array.isArray(a.contradicted) ? a.contradicted : [];
			const newLessons = Array.isArray(a.new_lessons) ? a.new_lessons : [];
			const noRelevant = a.no_relevant_knowledge === true;

			// Force a meaningful receipt: either it considered something, proposed a
			// new lesson, or it explicitly states nothing relevant was found.
			if (
				applied.length === 0 &&
				ignored.length === 0 &&
				notApplicable.length === 0 &&
				contradicted.length === 0 &&
				newLessons.length === 0 &&
				!noRelevant
			) {
				return JSON.stringify({
					recorded: false,
					error:
						'empty receipt: provide at least one applied/ignored/n_a/contradicted entry, a new lesson, or set no_relevant_knowledge:true',
				});
			}

			const sessionId = ctx?.sessionID ?? 'unknown';
			const agent = ctx?.agent ?? 'unknown';
			// (#2032) Terminal provenance class, distinct from agent identity.
			const receiptSource = receiptSourceForAgent(agent);
			let knowledgeConfig = KnowledgeConfigSchema.parse({});
			try {
				const { config } = loadPluginConfigWithMeta(directory);
				knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
			} catch {
				// Invalid/unavailable optional config falls back to schema defaults.
			}
			const base = {
				trace_id: traceId,
				session_id: sessionId,
				phase,
				task_id: taskId,
				agent,
				source: receiptSource,
			};

			const recordedEventIds: string[] = [];
			const diagnosticEventIds: string[] = [];
			// (#PRR-001) emit returns the written event_id (or '' on write failure)
			// so promotion-evidence pairing is exact per-item, not fragile tail-slice
			// arithmetic that misaligns when a write fails or no_relevant precedes.
			const emit = async (event: KnowledgeEventInput): Promise<string> => {
				const written = await recordKnowledgeEvent(directory, event);
				const id = written?.event_id ?? '';
				if (id) diagnosticEventIds.push(id);
				return id;
			};
			// Map knowledge_id -> receipt_event_id for the accepted applied/violated/
			// contradicted items (the only outcomes that feed PromotionEvidenceRecord).
			const eventIdByKnowledgeId = new Map<string, string>();

			// (#1849) Validate the receipt against the authoritative event log
			// BEFORE emitting. Reject forged / expired / conflicting / non-trace
			// receipts; idempotent retries are accepted as skips (not re-emitted).
			// `no_relevant_knowledge` files one durable `no_relevant` terminal.
			// A lessons-only receipt (no items, no no_relevant, but new_lessons) is
			// meaningful and skips items-validation — it just persists lessons.
			const validationItems = [
				...applied.map((i) => ({
					id: i.id,
					outcome: 'applied' as const,
					reason: i.how,
				})),
				...ignored.map((i) => ({
					id: i.id,
					outcome: 'ignored' as const,
					reason: i.note ? `${i.reason}: ${i.note}` : i.reason,
				})),
				...notApplicable.map((i) => ({
					id: i.id,
					outcome: 'n_a' as const,
					reason: i.reason,
				})),
				...contradicted.map((i) => ({
					id: i.id,
					outcome: 'contradicted' as const,
					reason: `${i.proposed_action}: ${i.evidence}`,
				})),
			];
			const needsValidation = validationItems.length > 0 || noRelevant;
			let acceptedIds = new Set<string>();
			let closesNoRelevant = false;
			let acceptedItems: ReceiptItem[] = [];
			let authoritativeEventIds: Record<string, string> = {};
			let cohortId: string | undefined;
			let linkId: string | undefined;
			if (needsValidation) {
				try {
					cohortId = await ensureCohortIdCached(directory, sessionId);
					linkId = await readLinkPointerSafe(directory);
				} catch {
					// Cohort correlation is optional metadata; receipt authority remains local.
				}
				const validation = await validateReceipt({
					directory,
					trace_id: traceId,
					session_id: sessionId,
					task_id: taskId,
					phase,
					agent,
					source: receiptSource,
					cohort_id: cohortId,
					source_link_id: linkId,
					items: validationItems,
					no_relevant_knowledge: noRelevant,
					grace_days: knowledgeConfig.receipt_close_grace_days,
				});

				if (!validation.ok) {
					// Rejection: the validator audited it. Return a clear JSON error to
					// the agent without emitting any terminal events.
					return JSON.stringify({
						recorded: false,
						rejected: true,
						reason: validation.reason,
						detail: validation.detail,
						rejected_items: validation.rejected_items,
					});
				}
				acceptedIds = new Set(validation.accepted.map((i) => i.id));
				closesNoRelevant = validation.closes_no_relevant;
				acceptedItems = validation.accepted;
				authoritativeEventIds = validation.authoritative_event_ids;
				recordedEventIds.push(...Object.values(authoritativeEventIds));
				if (validation.no_relevant_event_id) {
					recordedEventIds.push(validation.no_relevant_event_id);
				}
			}

			// `no_relevant` terminal for an empty/real-empty trace.
			if (closesNoRelevant) {
				await emit({
					type: 'no_relevant',
					...base,
					reason: 'no relevant knowledge surfaced by the trace',
				});
			}

			for (const item of applied) {
				if (!acceptedIds.has(item.id)) continue;
				await emit({
					type: 'applied',
					...base,
					knowledge_id: item.id,
					reason: item.how,
					evidence: {
						files: item.evidence_files,
						commands: item.evidence_commands,
						summary: item.verified_by
							? `verified_by=${item.verified_by}`
							: undefined,
					},
				});
				const eid = authoritativeEventIds[item.id];
				if (eid) eventIdByKnowledgeId.set(item.id, eid);
			}
			for (const item of ignored) {
				if (!acceptedIds.has(item.id)) continue;
				await emit({
					type: 'ignored',
					...base,
					knowledge_id: item.id,
					reason: item.note ? `${item.reason}: ${item.note}` : item.reason,
				});
			}
			for (const item of notApplicable) {
				if (!acceptedIds.has(item.id)) continue;
				await emit({
					type: 'n_a',
					...base,
					knowledge_id: item.id,
					reason: item.reason,
				});
			}
			for (const item of contradicted) {
				if (!acceptedIds.has(item.id)) continue;
				await emit({
					type: 'contradicted',
					...base,
					knowledge_id: item.id,
					reason: `${item.proposed_action}: ${item.evidence}`,
					evidence: { summary: item.evidence },
				});
				const eid = authoritativeEventIds[item.id];
				if (eid) eventIdByKnowledgeId.set(item.id, eid);
			}

			// (#1849 §B2) Derive PromotionEvidenceRecords from validated
			// applied/contradicted receipts and persist them so #1847's
			// evaluatePromotionPolicy finally consumes real evidence. cohort_id is
			// resolved once-bounded + cached; never re-runs git per receipt.
			// (#PRR-001) Pairing is EXACT per-item via eventIdByKnowledgeId (captured
			// at emit time), not fragile tail-slice cursor arithmetic.
			if (acceptedItems.length > 0) {
				try {
					const now = new Date().toISOString();
					const evidenceRecords: PromotionEvidenceRecord[] = [];
					for (const item of acceptedItems) {
						// Only applied/contradicted feed promotion evidence here (violated
						// comes from the delegate-ack path; ignored/n_a do not).
						if (item.outcome !== 'applied' && item.outcome !== 'contradicted') {
							continue;
						}
						const receiptEventId = eventIdByKnowledgeId.get(item.id);
						if (!cohortId || !receiptEventId) continue;
						evidenceRecords.push({
							cohort_id: cohortId,
							source_link_id: linkId,
							entry_id: item.id,
							retrieval_trace_id: traceId,
							receipt_outcome:
								item.outcome === 'applied' ? 'applied' : 'contradicted',
							// (#2032 F-003) Preserve the caller's provenance class;
							// source 'delegate' stays non-independent for promotion.
							receipt_source: receiptSource,
							receipt_event_id: receiptEventId,
							phase,
							timestamp: now,
						});
					}
					await appendPromotionEvidence(directory, evidenceRecords);
				} catch {
					/* non-blocking — evidence is a derived consumer */
				}
			}

			// Persist new lessons through the normal validation/dedup path.
			const newLessonResults: Array<Record<string, unknown>> = [];
			for (const item of newLessons) {
				const raw = await knowledge_add.execute(
					{
						lesson: item.lesson,
						category: item.category,
						applies_to_agents: item.applies_to_agents,
						applies_to_tools: item.applies_to_tools,
						required_actions: item.required_actions,
						forbidden_actions: item.forbidden_actions,
						verification_checks: item.verification_checks,
					},
					ctx as Parameters<typeof knowledge_add.execute>[1],
				);
				try {
					const output =
						typeof raw === 'string'
							? raw
							: typeof raw === 'object' &&
									raw !== null &&
									'output' in raw &&
									typeof (raw as { output?: unknown }).output === 'string'
								? (raw as { output: string }).output
								: '';
					newLessonResults.push(JSON.parse(output));
				} catch {
					newLessonResults.push({ success: false });
				}
			}
			log('[knowledge_receipt] completed', {
				agent,
				source: receiptSource,
				session_id: sessionId,
				trace_id: traceId,
				applied: applied.length,
				ignored: ignored.length,
				n_a: notApplicable.length,
				contradicted: contradicted.length,
				new_lessons: newLessonResults.length,
				no_relevant_knowledge: noRelevant,
				event_count: recordedEventIds.length,
				diagnostic_event_count: diagnosticEventIds.length,
			});

			return JSON.stringify({
				recorded: true,
				trace_id: traceId,
				applied: applied.length,
				ignored: ignored.length,
				n_a: notApplicable.length,
				contradicted: contradicted.length,
				new_lessons: newLessonResults,
				no_relevant_knowledge: noRelevant,
				event_ids: recordedEventIds,
			});
		},
	});

export const _internals: {
	knowledge_receipt: typeof knowledge_receipt;
	receiptSourceForAgent: typeof receiptSourceForAgent;
	ignoredItemSchema: typeof ignoredItem;
	notApplicableItemSchema: typeof notApplicableItem;
} = {
	knowledge_receipt,
	receiptSourceForAgent,
	ignoredItemSchema: ignoredItem,
	notApplicableItemSchema: notApplicableItem,
};

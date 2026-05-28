/**
 * knowledge_receipt — the strong successor to knowledge_ack.
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
import {
	type KnowledgeEventInput,
	recordKnowledgeEvent,
} from '../hooks/knowledge-events.js';
import { createSwarmTool } from './create-tool.js';
import { knowledge_add } from './knowledge-add.js';

const IGNORE_REASONS = [
	'not_relevant',
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

const contradictedItem = z.object({
	id: z.string().min(1),
	evidence: z.string().min(1).max(500),
	proposed_action: z.enum(PROPOSED_ACTIONS),
});

const newLessonItem = z.object({
	lesson: z.string().min(15).max(280),
	category: z.string().min(1),
	evidence: z.string().max(500).optional(),
});

export const knowledge_receipt: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'File a receipt for knowledge surfaced by a retrieval (by trace_id): which entries were applied (with evidence), ignored (with reason), or contradicted (with proposed remediation), plus any new lessons. Each item is recorded as an immutable knowledge event. Set no_relevant_knowledge:true when a retrieval surfaced nothing useful.',
		args: {
			trace_id: z
				.string()
				.min(1)
				.describe(
					"trace_id from a prior knowledge_recall/injection, or 'none' if no retrieval occurred",
				),
			task_id: z.string().optional(),
			phase: z.string().optional(),
			applied: z.array(appliedItem).optional(),
			ignored: z.array(ignoredItem).optional(),
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
			const taskId = typeof a.task_id === 'string' ? a.task_id : undefined;
			const phase = typeof a.phase === 'string' ? a.phase : undefined;
			const applied = Array.isArray(a.applied) ? a.applied : [];
			const ignored = Array.isArray(a.ignored) ? a.ignored : [];
			const contradicted = Array.isArray(a.contradicted) ? a.contradicted : [];
			const newLessons = Array.isArray(a.new_lessons) ? a.new_lessons : [];
			const noRelevant = a.no_relevant_knowledge === true;

			// Force a meaningful receipt: either it considered something, proposed a
			// new lesson, or it explicitly states nothing relevant was found.
			if (
				applied.length === 0 &&
				ignored.length === 0 &&
				contradicted.length === 0 &&
				newLessons.length === 0 &&
				!noRelevant
			) {
				return JSON.stringify({
					recorded: false,
					error:
						'empty receipt: provide at least one applied/ignored/contradicted entry, a new lesson, or set no_relevant_knowledge:true',
				});
			}

			const sessionId = ctx?.sessionID ?? 'unknown';
			const agent = ctx?.agent ?? 'unknown';
			const base = {
				trace_id: traceId,
				session_id: sessionId,
				phase,
				task_id: taskId,
				agent,
			};

			const recordedEventIds: string[] = [];
			const emit = async (event: KnowledgeEventInput): Promise<void> => {
				const written = await recordKnowledgeEvent(directory, event);
				if (written) recordedEventIds.push(written.event_id);
			};

			for (const item of applied) {
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
			}
			for (const item of ignored) {
				await emit({
					type: 'ignored',
					...base,
					knowledge_id: item.id,
					reason: item.note ? `${item.reason}: ${item.note}` : item.reason,
				});
			}
			for (const item of contradicted) {
				await emit({
					type: 'contradicted',
					...base,
					knowledge_id: item.id,
					reason: `${item.proposed_action}: ${item.evidence}`,
					evidence: { summary: item.evidence },
				});
			}

			// Persist new lessons through the normal validation/dedup path.
			const newLessonResults: Array<Record<string, unknown>> = [];
			for (const item of newLessons) {
				const raw = await knowledge_add.execute(
					{ lesson: item.lesson, category: item.category },
					ctx as Parameters<typeof knowledge_add.execute>[1],
				);
				try {
					newLessonResults.push(JSON.parse(raw));
				} catch {
					newLessonResults.push({ success: false });
				}
			}

			return JSON.stringify({
				recorded: true,
				trace_id: traceId,
				applied: applied.length,
				ignored: ignored.length,
				contradicted: contradicted.length,
				new_lessons: newLessonResults,
				no_relevant_knowledge: noRelevant,
				event_ids: recordedEventIds,
			});
		},
	});

export const _internals: { knowledge_receipt: typeof knowledge_receipt } = {
	knowledge_receipt,
};

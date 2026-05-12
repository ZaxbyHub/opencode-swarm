/**
 * knowledge_ack — Architect-facing tool to record an explicit acknowledgment
 * outcome for an injected knowledge directive.
 *
 * The same outcome can also be expressed inline in chat with markers like
 *   KNOWLEDGE_APPLIED: <id>
 *   KNOWLEDGE_IGNORED: <id> reason=<reason>
 * but this tool gives a deterministic, auditable surface that doesn't depend
 * on chat-text scanning.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
	buildAckDedupKey,
	type ParsedAcknowledgment,
	recordAcknowledgment,
} from '../hooks/knowledge-application.js';
import { addKnowledgeAckDedup, swarmState } from '../state.js';
import { warn } from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

export const knowledge_ack: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record an acknowledgment outcome (applied/ignored/violated) for a previously-injected knowledge directive. Updates retrieval-outcome counters and appends a record to .swarm/knowledge-application.jsonl.',
		args: {
			id: z
				.string()
				.min(8)
				.describe('Knowledge entry id from <swarm_knowledge_directives>.'),
			result: z.enum(['applied', 'ignored', 'violated']),
			reason: z.string().max(280).optional(),
			phase: z.string().optional(),
			task_id: z.string().optional(),
			action: z.string().optional(),
			tool: z.string().optional(),
			target_agent: z.string().optional(),
			generated_skill_path: z.string().optional(),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			const a = (args ?? {}) as {
				id?: string;
				result?: 'applied' | 'ignored' | 'violated';
				reason?: string;
				phase?: string;
				task_id?: string;
				action?: string;
				tool?: string;
				target_agent?: string;
			};
			if (!a.id || typeof a.id !== 'string' || a.id.length < 8) {
				return JSON.stringify({ recorded: false, error: 'invalid id' });
			}
			if (
				a.result !== 'applied' &&
				a.result !== 'ignored' &&
				a.result !== 'violated'
			) {
				return JSON.stringify({ recorded: false, error: 'invalid result' });
			}
			const ack: ParsedAcknowledgment = {
				id: a.id,
				result: a.result,
				reason: a.reason,
			};
			let sessionId = ctx?.sessionID;
			if (!sessionId) {
				warn(
					'[knowledge-ack] No sessionID in tool context — dedup disabled for this acknowledgment',
				);
				sessionId = randomUUID();
			}
			const dedupKey = buildAckDedupKey(sessionId, a.id, a.result);
			if (swarmState.knowledgeAckDedup.has(dedupKey)) {
				return JSON.stringify(
					{
						recorded: false,
						reason: 'duplicate_ack',
						id: a.id,
						result: a.result,
					},
					null,
					2,
				);
			}
			addKnowledgeAckDedup(dedupKey);
			await recordAcknowledgment(directory, ack, {
				phase: a.phase,
				taskId: a.task_id,
				action: a.action,
				tool: a.tool,
				targetAgent: a.target_agent,
				sessionId,
			});
			return JSON.stringify(
				{ recorded: true, id: a.id, result: a.result },
				null,
				2,
			);
		},
	});

export const _internals: { knowledge_ack: typeof knowledge_ack } = {
	knowledge_ack,
};

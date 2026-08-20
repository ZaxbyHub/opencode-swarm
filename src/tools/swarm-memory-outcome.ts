import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import {
	createMemoryGateway,
	MemoryAnchorSchema,
	recordOutcomeWithReflection,
} from '../memory';
import { getAgentSession } from '../state';
import { createSwarmTool } from './create-tool';

const OutcomeArgsSchema = z
	.object({
		memory_id: z
			.string()
			.regex(/^mem_[a-f0-9]{16}$/)
			.optional(),
		question: z.string().trim().min(1).max(2000).optional(),
		outcome: z.enum(['useful', 'dead_end', 'corrected']),
		anchors: z.array(MemoryAnchorSchema).max(20).optional(),
		correction: z.string().trim().min(1).max(4000).optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (Boolean(value.memory_id) === Boolean(value.question)) {
			context.addIssue({
				code: 'custom',
				message: 'exactly one of memory_id or question is required',
			});
		}
		if (value.outcome === 'corrected' && !value.correction) {
			context.addIssue({
				code: 'custom',
				message: 'corrected outcomes require correction text',
			});
		}
	});

export const swarm_memory_outcome: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Record whether recalled memory or a graph answer was useful, a dead end, or corrected; when reflection is enabled, synchronously refresh deterministic reflection artifacts.',
		args: {
			memory_id: z
				.string()
				.regex(/^mem_[a-f0-9]{16}$/)
				.optional()
				.describe('Existing memory id to update'),
			question: z
				.string()
				.trim()
				.min(1)
				.max(2000)
				.optional()
				.describe(
					'Question for a lightweight result memory when no id is known',
				),
			outcome: z
				.enum(['useful', 'dead_end', 'corrected'])
				.describe('Observed result'),
			anchors: z
				.array(MemoryAnchorSchema)
				.max(20)
				.optional()
				.describe('Repository-relative file and optional symbol anchors'),
			correction: z
				.string()
				.trim()
				.min(1)
				.max(4000)
				.optional()
				.describe('Required corrected claim text for corrected outcomes'),
		},
		execute: async (args: unknown, directory: string, ctx): Promise<string> => {
			const { config } = _internals.loadPluginConfigWithMeta(directory);
			if (config.memory?.enabled !== true) {
				return JSON.stringify({
					success: false,
					disabled: true,
					message: 'Swarm memory is disabled. Set swarm.memory.enabled=true.',
				});
			}
			const parsed = OutcomeArgsSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({
					success: false,
					error: parsed.error.issues.map((issue) => issue.message).join('; '),
				});
			}
			const agent = typeof ctx?.agent === 'string' ? ctx.agent : undefined;
			const taskId = ctx?.sessionID
				? (_internals.getAgentSession(ctx.sessionID)?.currentTaskId ??
					undefined)
				: undefined;
			const gateway = _internals.createMemoryGateway(
				{
					directory,
					sessionID: ctx?.sessionID,
					agentRole: agent,
					agentId: agent,
					runId: ctx?.sessionID,
					unitId: taskId,
				},
				{ config: config.memory },
			);
			const eventId =
				ctx?.sessionID && ctx.messageID
					? `tool-${createHash('sha256')
							.update(
								JSON.stringify({
									sessionID: ctx.sessionID,
									messageID: ctx.messageID,
									args: parsed.data,
								}),
							)
							.digest('hex')
							.slice(0, 32)}`
					: undefined;
			try {
				const result = await _internals.recordOutcomeWithReflection(
					directory,
					config.memory,
					gateway,
					{
						memoryId: parsed.data.memory_id,
						question: parsed.data.question,
						outcome: parsed.data.outcome,
						anchors: parsed.data.anchors,
						correction: parsed.data.correction,
						eventId,
					},
				);
				const reflectionUpdated = result.reflectionUpdated;
				const reflectionAttempted = result.reflectionAttempted;
				const partial =
					result.reflectionEnabled === true &&
					reflectionAttempted &&
					!reflectionUpdated;
				const reflectionError = 'error' in result ? result.error : undefined;
				return JSON.stringify(
					{
						success: true,
						status: partial ? 'partial' : 'complete',
						partial,
						outcome_recorded: result.outcomeRecorded,
						event_id: result.eventId,
						memory_id: result.record.id,
						outcome: parsed.data.outcome,
						outcomes: result.record.outcomes?.length ?? 0,
						reflection_enabled: result.reflectionEnabled,
						reflection_attempted: reflectionAttempted,
						reflection_updated: reflectionUpdated,
						reflection_entries: reflectionUpdated
							? result.digest.generatedFrom.entries
							: undefined,
						error: partial ? reflectionError : undefined,
						reflection_error: partial ? reflectionError : undefined,
					},
					null,
					2,
				);
			} finally {
				await gateway.dispose();
			}
		},
	});

export const _internals = {
	loadPluginConfigWithMeta,
	createMemoryGateway,
	getAgentSession,
	recordOutcomeWithReflection,
};

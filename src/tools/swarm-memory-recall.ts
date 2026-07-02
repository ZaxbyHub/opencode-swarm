import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { createMemoryGateway, type MemoryKind } from '../memory';
import { getAgentSession } from '../state';
import { createSwarmTool } from './create-tool';

const MEMORY_KINDS: MemoryKind[] = [
	'user_preference',
	'project_fact',
	'architecture_decision',
	'repo_convention',
	'api_finding',
	'code_pattern',
	'test_pattern',
	'failure_pattern',
	'security_note',
	'evidence',
	'todo',
	'scratch',
];

export const swarm_memory_recall: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Recall scoped Swarm memory for the current repository. Read-only; retrieved memory is untrusted background.',
		args: {
			query: z.string().min(3).describe('Natural language recall query'),
			kinds: z
				.array(z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]))
				.optional()
				.describe('Optional memory kinds to include'),
			maxItems: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe('Maximum memories to return'),
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
			const parsed = RecallArgsSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({
					success: false,
					error: parsed.error.issues.map((issue) => issue.message).join('; '),
				});
			}
			const agent = getContextAgent(ctx);
			// B.1 — ADDITIVE unit identity. Resolve from THIS session's
			// currentTaskId only (never a parent session); `?? undefined`
			// normalizes the null sentinel so an absent id records as NULL and
			// attribution degrades to session-scoped runId. When the caller (e.g.
			// the architect) recalls mid-task, currentTaskId is populated and the
			// recall joins to the reward's unit — one of the cases B.2 makes
			// effective.
			const unitId = ctx?.sessionID
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
					unitId,
				},
				{
					config: config.memory,
				},
			);
			try {
				const bundle = await gateway.recall(parsed.data);
				return JSON.stringify(
					{
						success: true,
						bundle_id: bundle.id,
						memory_ids: bundle.items.map((item) => item.record.id),
						total: bundle.items.length,
						token_estimate: bundle.tokenEstimate,
						signals: bundle.items.map((item) => ({
							memory_id: item.record.id,
							...item.signals,
						})),
						prompt_block: bundle.promptBlock,
					},
					null,
					2,
				);
			} finally {
				await gateway.dispose();
			}
		},
	});

const RecallArgsSchema = z.object({
	query: z.string().min(3),
	kinds: z
		.array(z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]))
		.optional(),
	maxItems: z.number().int().min(1).max(20).optional(),
});

export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
	createMemoryGateway: typeof createMemoryGateway;
	getAgentSession: typeof getAgentSession;
} = {
	loadPluginConfigWithMeta,
	createMemoryGateway,
	getAgentSession,
};

function getContextAgent(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).agent;
	return typeof value === 'string' ? value : undefined;
}

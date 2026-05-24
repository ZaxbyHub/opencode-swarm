import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { createMemoryGateway, type MemoryKind } from '../memory';
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

const ProposalArgsSchema = z.object({
	operation: z.enum([
		'add',
		'update',
		'delete',
		'ignore',
		'merge',
		'supersede',
	]),
	kind: z.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]]).optional(),
	text: z.string().min(1).max(2000).optional(),
	targetMemoryId: z.string().optional(),
	relatedMemoryIds: z.array(z.string()).optional(),
	rationale: z.string().min(1).max(2000),
	evidenceRefs: z.array(z.string().min(1).max(500)).max(20).optional(),
});

export const swarm_memory_propose: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Create a pending Swarm memory proposal. This never writes durable memory directly; curator review is required.',
		args: {
			operation: z
				.enum(['add', 'update', 'delete', 'ignore', 'merge', 'supersede'])
				.describe('Proposal operation'),
			kind: z
				.enum(MEMORY_KINDS as [MemoryKind, ...MemoryKind[]])
				.optional()
				.describe('Memory kind for add/update/supersede proposals'),
			text: z
				.string()
				.min(1)
				.max(2000)
				.optional()
				.describe('Canonical fact text for add/update/supersede proposals'),
			targetMemoryId: z
				.string()
				.optional()
				.describe('Target memory ID for update/delete/supersede proposals'),
			relatedMemoryIds: z
				.array(z.string())
				.optional()
				.describe('Related memory IDs for merge/supersede proposals'),
			rationale: z
				.string()
				.min(1)
				.max(2000)
				.describe('Why this proposal matters'),
			evidenceRefs: z
				.array(z.string().min(1).max(500))
				.max(20)
				.optional()
				.describe(
					'Evidence refs such as files, commits, test outputs, or URLs',
				),
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
			const parsed = ProposalArgsSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({
					success: false,
					error: parsed.error.issues.map((issue) => issue.message).join('; '),
				});
			}
			const agent = getContextAgent(ctx);
			const gateway = _internals.createMemoryGateway(
				{
					directory,
					sessionID: ctx?.sessionID,
					agentRole: agent,
					agentId: agent,
					runId: ctx?.sessionID,
				},
				{
					config: config.memory,
				},
			);
			const proposal = await gateway.propose(parsed.data);
			return JSON.stringify(
				{
					success: proposal.status !== 'rejected',
					proposal_id: proposal.id,
					status: proposal.status,
					operation: proposal.operation,
					memory_id: proposal.proposedRecord?.id,
					rejection_reason: proposal.rejectionReason,
					message:
						proposal.status === 'pending'
							? 'Memory proposal created. Durable memory was not written.'
							: 'Memory proposal was captured with policy rejection metadata.',
				},
				null,
				2,
			);
		},
	});

export const _internals: {
	loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
	createMemoryGateway: typeof createMemoryGateway;
} = {
	loadPluginConfigWithMeta,
	createMemoryGateway,
};

function getContextAgent(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== 'object') return undefined;
	const value = (ctx as Record<string, unknown>).agent;
	return typeof value === 'string' ? value : undefined;
}

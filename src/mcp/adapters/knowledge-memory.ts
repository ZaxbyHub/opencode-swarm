/**
 * Knowledge + memory adapters for the read-only MCP surface (#2499).
 *
 * `knowledge_recall` calls `searchKnowledge` — the exact retrieval core the
 * registered `knowledge_recall` tool uses — WITHOUT the receipt-ledger writes
 * (those commits are session display-membership bookkeeping, not part of
 * retrieval). `swarm_memory_recall` goes through the registered tool with a
 * synthetic sessionless context, but ONLY after read-only probes confirm the
 * feature is enabled AND a store already exists, so no `.swarm/` state is
 * ever materialized by a query.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../../config';
import { KnowledgeConfigSchema } from '../../config/schema.js';
import { searchKnowledge } from '../../hooks/search-knowledge.js';
import { swarm_memory_recall } from '../../tools/swarm-memory-recall.js';
import type { McpReadTool } from '../registry.js';
import { mcpToolContext, safeParseJson } from './verification.js';

const knowledgeRecallSchema = z.object({
	query: z.string().min(3).describe('Natural language search query'),
	top_n: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe('Maximum results (default: 5)'),
	tier: z
		.enum(['all', 'swarm', 'hive'])
		.optional()
		.describe("Knowledge tier to search (default: 'all')"),
});

const memoryRecallSchema = z.object({
	query: z.string().min(3).describe('Natural language recall query'),
});

export const knowledgeRecallAdapter: McpReadTool = {
	name: 'knowledge_recall',
	description:
		'Performs semantic natural-language search across the knowledge base for relevant past decisions, patterns, and lessons learned.',
	kind: 'read',
	pathFields: [],
	inputSchema: knowledgeRecallSchema,
	execute: async (rawArgs, root) => {
		const args = knowledgeRecallSchema.parse(rawArgs);
		// Read-only probes first: never materialize a knowledge store from a query.
		const knowledgePath = path.join(root, '.swarm', 'knowledge');
		if (!existsSync(knowledgePath)) {
			return {
				results: [],
				total: 0,
				available: false,
				reason: 'no_knowledge_base',
				message:
					'No knowledge base exists under this project root yet; a read-only query never creates one.',
			};
		}
		let knowledgeConfig = KnowledgeConfigSchema.parse({});
		try {
			const { config } = loadPluginConfigWithMeta(root);
			knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
		} catch {
			// Default config when the project config cannot be loaded (read-only).
		}
		const { trace_id, results } = await searchKnowledge({
			directory: root,
			config: knowledgeConfig,
			query: args.query,
			mode: 'manual',
			agent: 'mcp',
			sessionId: 'mcp',
			tier: args.tier,
			maxResults: args.top_n,
			// Preserve the registered tool's manual-recall semantics.
			applyScopeFilter: false,
			forceReadHive: true,
			applyRoleScope: false,
		});
		return { trace_id, results, total: results.length };
	},
};

export const swarmMemoryRecallAdapter: McpReadTool = {
	name: 'swarm_memory_recall',
	description:
		'recall scoped Swarm memory for the current repository as untrusted background',
	kind: 'read',
	pathFields: [],
	inputSchema: memoryRecallSchema,
	execute: async (rawArgs, root) => {
		const args = memoryRecallSchema.parse(rawArgs);
		// Probe 1: feature flag (reads .opencode config — never writes).
		const { config } = loadPluginConfigWithMeta(root);
		if (config.memory?.enabled !== true) {
			return {
				available: false,
				reason: 'memory_disabled',
				message: 'Swarm memory is disabled. Set swarm.memory.enabled=true.',
			};
		}
		// Probe 2: an existing store. `createConfiguredMemoryProviderForRoot`
		// lazily creates storage directories, so a storeless root must degrade
		// instead of constructing any provider.
		if (!existsSync(path.join(root, '.swarm', 'memory'))) {
			return {
				available: false,
				reason: 'no_store',
				message:
					'No memory store exists under this project root; a read-only query never creates one.',
			};
		}
		// Registered production path with a sessionless synthetic context.
		const result = await swarm_memory_recall.execute(
			{ query: args.query },
			// The registered tool reads only directory/sessionID off the context;
			// the empty session id keeps attribution session-scoped and read-only.
			{ ...mcpToolContext(root), sessionID: '' },
		);
		return typeof result === 'string' ? safeParseJson(result) : result;
	},
};

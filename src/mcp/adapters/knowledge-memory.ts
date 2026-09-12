/**
 * Knowledge + memory adapters for the read-only MCP surface (#2499).
 *
 * `knowledge_recall` calls `searchKnowledge` — the exact retrieval core the
 * registered `knowledge_recall` tool uses — with `skipLedgerGenesis` so a
 * query never performs the receipt ledger's one-time `runLocked` genesis.
 * `swarm_memory_recall` calls the registered tool's compute core with
 * `{recordUsage: false}` (identical retrieval, no telemetry write) — but ONLY
 * after read-only probes confirm the feature is enabled AND the configured
 * provider's store artifact already exists, so no `.swarm/` state (sqlite
 * `memory.db` genesis, WAL/SHM files, migration reports) is ever materialized
 * by a query.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../../config';
import { KnowledgeConfigSchema } from '../../config/schema.js';
import { searchKnowledge } from '../../hooks/search-knowledge.js';
import { computeSwarmMemoryRecall } from '../../tools/swarm-memory-recall.js';
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
			// Read-only surface: never materialize the receipts ledger (#2499).
			skipLedgerGenesis: true,
		});
		return { trace_id, results, total: results.length };
	},
};

export const swarmMemoryRecallAdapter: McpReadTool = {
	name: 'swarm_memory_recall',
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
		// Probe 2: the configured provider's INITIALIZED store artifact. The
		// sqlite provider lazily creates `memory.db` (migrations + WAL/SHM) on
		// construction, so a root whose provider has never persisted anything
		// must degrade instead of letting a query perform that genesis.
		const storeArtifact =
			(config.memory.provider ?? 'sqlite') === 'sqlite'
				? path.join(root, '.swarm', 'memory', 'memory.db')
				: path.join(root, '.swarm', 'memory', 'memories.jsonl');
		if (!existsSync(storeArtifact)) {
			return {
				available: false,
				reason: 'no_store',
				message:
					'No memory store exists under this project root; a read-only query never creates one.',
			};
		}
		// Registered production compute core with a sessionless synthetic
		// context and usage telemetry disabled — identical retrieval, no write.
		const result = await computeSwarmMemoryRecall(
			{ query: args.query },
			root,
			// The registered tool reads only directory/sessionID off the context;
			// the empty session id keeps attribution session-scoped and read-only.
			{ ...mcpToolContext(root), sessionID: '' },
			{ recordUsage: false },
		);
		return safeParseJson(result);
	},
};

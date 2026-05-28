import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { KnowledgeConfigSchema } from '../config/schema.js';
import { searchKnowledge } from '../hooks/search-knowledge.js';
import { computeKnowledgeDebug } from '../services/knowledge-diagnostics.js';
import { createSwarmTool } from './create-tool.js';

interface ScoredEntry {
	id: string;
	confidence: number;
	category: string;
	lesson: string;
	score: number;
}

interface KnowledgeRecallResult {
	results: ScoredEntry[];
	total: number;
	trace_id?: string;
	debug?: unknown;
}

export const knowledge_recall: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Search the knowledge base for relevant past decisions, patterns, and lessons learned. Returns ranked results via the unified hybrid retrieval service and a trace_id for knowledge_receipt.',
		args: {
			query: z.string().min(3).describe('Natural language search query'),
			top_n: z
				.number()
				.int()
				.min(1)
				.max(20)
				.optional()
				.describe('Maximum results to return (default: 5)'),
			tier: z
				.enum(['all', 'swarm', 'hive'])
				.optional()
				.describe("Knowledge tier to search (default: 'all')"),
			debug: z
				.boolean()
				.optional()
				.describe('Include path/version/health debug metadata in the response'),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			// Safe args extraction
			let queryInput: unknown;
			let topNInput: unknown;
			let tierInput: unknown;
			let debugInput: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					queryInput = obj.query;
					topNInput = obj.top_n;
					tierInput = obj.tier;
					debugInput = obj.debug;
				}
			} catch {
				// Malicious getter threw
			}
			const wantDebug = debugInput === true;

			// Validate query
			if (typeof queryInput !== 'string' || queryInput.length < 3) {
				return JSON.stringify({
					results: [],
					total: 0,
					error: 'query must be a string with at least 3 characters',
				});
			}

			// Parse top_n with default
			let topN = 5;
			if (typeof topNInput === 'number' && Number.isInteger(topNInput)) {
				topN = Math.max(1, Math.min(20, topNInput));
			}

			// Parse tier with default
			let tier: 'all' | 'swarm' | 'hive' = 'all';
			if (tierInput === 'swarm' || tierInput === 'hive') {
				tier = tierInput;
			}

			// Load knowledge config (best-effort; defaults are safe).
			let knowledgeConfig = KnowledgeConfigSchema.parse({});
			try {
				const { config } = loadPluginConfigWithMeta(directory);
				knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
			} catch {
				// fall back to schema defaults
			}

			// Route through the unified retrieval service. It filters
			// archived/quarantined, applies the hybrid score, emits the
			// `retrieved` event, and returns a trace_id.
			const { trace_id, results } = await searchKnowledge({
				directory,
				config: knowledgeConfig,
				query: queryInput,
				mode: 'manual',
				agent: ctx?.agent ?? 'unknown',
				sessionId: ctx?.sessionID ?? 'unknown',
				tier,
				maxResults: topN,
				// Preserve pre-unification manual-recall semantics: an explicit query
				// returns all scopes, reads hive regardless of the injection-only
				// hive_enabled knob, and is not silently role-gated.
				applyScopeFilter: false,
				forceReadHive: true,
				applyRoleScope: false,
			});

			const scored: ScoredEntry[] = results.map((e) => ({
				id: e.id,
				confidence: e.confidence,
				category: e.category,
				lesson: e.lesson,
				score: e.finalScore,
			}));

			const result: KnowledgeRecallResult = {
				results: scored,
				total: scored.length,
				trace_id,
			};
			if (wantDebug) result.debug = await computeKnowledgeDebug(directory);

			return JSON.stringify(result);
		},
	});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	knowledge_recall: typeof knowledge_recall;
} = {
	knowledge_recall,
} as const;

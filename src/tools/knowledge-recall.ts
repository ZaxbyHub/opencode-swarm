import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import {
	KnowledgeConfigSchema,
	stripKnownSwarmPrefix,
} from '../config/schema.js';
import { recordKnowledgeEvent } from '../hooks/knowledge-events.js';
import {
	commitDisplayedMembership,
	commitEmptyRetrieval,
	type ReceiptRepairReevaluationProof,
} from '../hooks/knowledge-receipt-ledger.js';
import { isActiveStatus } from '../hooks/knowledge-types.js';
import { searchKnowledge } from '../hooks/search-knowledge.js';
import { computeKnowledgeDebug } from '../services/knowledge-diagnostics.js';
import { log } from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

interface ScoredEntry {
	id: string;
	confidence: number;
	category: string;
	lesson: string;
	score: number;
	score_breakdown?: Record<string, unknown>;
}

interface KnowledgeRecallResult {
	results: ScoredEntry[];
	total: number;
	trace_id?: string;
	debug?: unknown;
}

export const knowledge_recall: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		allowWorkingDirectoryOverride: true,
		description:
			'Performs semantic natural-language search across the knowledge base for relevant past decisions, patterns, and lessons learned. Returns ranked results via the unified hybrid retrieval service and a trace_id for knowledge_receipt. This is the tool to use when the user has a QUESTION about what the knowledge base contains. For structured filter-based retrieval (by category, status, or score), use `knowledge_query` instead.',
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
			repair_re_evaluation: z
				.object({
					repair_id: z.string().uuid(),
					phase: z.string().min(1).max(256),
					task_id: z.string().min(1).max(256).optional(),
					// Gemini-family APIs reject single-value enum constraints on
					// boolean literals (z.literal(true) serializes to either
					// {"const":true,"type":"boolean"} under Zod v4 default target or
					// {"enum":[true],"type":"boolean"} under draft-04/openapi-3.0; both
					// forms are rejected by Gemini/Google Antigravity validators).
					// Runtime check below still requires === true.
					scope_complete: z.boolean(),
				})
				.optional()
				.describe(
					'Architect-only explicit completion of a repaired receipt scope. The query must comprehensively re-evaluate the exact affected phase/session scope.',
				),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			// Safe args extraction
			let queryInput: unknown;
			let topNInput: unknown;
			let tierInput: unknown;
			let debugInput: unknown;
			let repairInput: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					queryInput = obj.query;
					topNInput = obj.top_n;
					tierInput = obj.tier;
					debugInput = obj.debug;
					repairInput = obj.repair_re_evaluation;
				}
			} catch {
				// Malicious getter threw
			}
			const wantDebug = debugInput === true;
			let repairReevaluation:
				| (ReceiptRepairReevaluationProof & {
						phase: string;
						task_id?: string;
				  })
				| undefined;
			if (repairInput !== undefined) {
				if (
					stripKnownSwarmPrefix(ctx?.agent ?? '') !== 'architect' ||
					typeof repairInput !== 'object' ||
					repairInput === null
				) {
					return JSON.stringify({
						results: [],
						total: 0,
						unverifiable: true,
						code: 'RECEIPT_REEVALUATION_ARCHITECT_ONLY',
						error:
							'Only the architect may complete an explicit receipt repair re-evaluation.',
					});
				}
				const candidate = repairInput as Record<string, unknown>;
				if (
					typeof candidate.repair_id !== 'string' ||
					!candidate.repair_id ||
					typeof candidate.phase !== 'string' ||
					!candidate.phase ||
					candidate.scope_complete !== true ||
					(candidate.task_id !== undefined &&
						typeof candidate.task_id !== 'string')
				) {
					return JSON.stringify({
						results: [],
						total: 0,
						unverifiable: true,
						code: 'RECEIPT_REEVALUATION_PROOF_INVALID',
						error:
							'Explicit re-evaluation requires repair_id, exact phase, and scope_complete=true.',
					});
				}
				repairReevaluation = {
					repair_id: candidate.repair_id,
					phase: candidate.phase,
					scope_complete: true,
					...(typeof candidate.task_id === 'string'
						? { task_id: candidate.task_id }
						: {}),
				};
			}

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
				emitEvent: false,
			});

			const sessionId = ctx?.sessionID ?? 'unknown';
			if (results.length > 0) {
				const membership = await commitDisplayedMembership(directory, {
					trace_id,
					session_id: sessionId,
					exposure_kind: 'manual_recall',
					agent: ctx?.agent ?? 'unknown',
					grace_days: knowledgeConfig.receipt_close_grace_days,
					phase: repairReevaluation?.phase,
					task_id: repairReevaluation?.task_id,
					repair_re_evaluation: repairReevaluation,
					entries: results.map((entry, index) => ({
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
					return JSON.stringify({
						results: [],
						total: 0,
						unverifiable: true,
						code: membership.ok ? 'terminal_trace_reuse' : membership.code,
						error: membership.ok
							? 'retrieval trace was already terminalized'
							: membership.detail,
					});
				}
			} else {
				const empty = await commitEmptyRetrieval(directory, {
					trace_id,
					session_id: sessionId,
					agent: ctx?.agent ?? 'unknown',
					grace_days: knowledgeConfig.receipt_close_grace_days,
					phase: repairReevaluation?.phase,
					task_id: repairReevaluation?.task_id,
					repair_re_evaluation: repairReevaluation,
				});
				if (!empty.ok) {
					return JSON.stringify({
						results: [],
						total: 0,
						unverifiable: true,
						code: empty.code,
						error: empty.detail,
					});
				}
				if (!empty.terminal_event_id) {
					return JSON.stringify({
						results: [],
						total: 0,
						unverifiable: true,
						code: 'store_unavailable',
						error: 'empty retrieval terminal did not commit',
					});
				}
			}

			// Best-effort diagnostic projection after authoritative commit.
			const ranks = Object.fromEntries(
				results.map((entry, index) => [entry.id, index + 1]),
			);
			const scores = Object.fromEntries(
				results.map((entry) => [entry.id, entry.finalScore]),
			);
			await recordKnowledgeEvent(directory, {
				type: 'retrieved',
				trace_id,
				session_id: sessionId,
				agent: ctx?.agent ?? 'unknown',
				query: queryInput,
				retrieval_mode: 'manual',
				result_ids: results.map((entry) => entry.id),
				ranks,
				scores,
			});

			const scored: ScoredEntry[] = results.map((e) => ({
				id: e.id,
				confidence: e.confidence,
				category: e.category,
				lesson: e.lesson,
				score: e.finalScore,
				score_breakdown: e.score_breakdown,
			}));
			log('[knowledge_recall] completed', {
				agent: ctx?.agent ?? 'unknown',
				session_id: ctx?.sessionID ?? 'unknown',
				query: queryInput,
				tier,
				result_count: scored.length,
				trace_id,
			});

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

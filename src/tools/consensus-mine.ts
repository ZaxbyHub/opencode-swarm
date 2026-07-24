/**
 * `consensus_mine` — run the consensus miner and persist its report.
 *
 * The tool is a thin, fully-wired shell around `src/consensus/`: it resolves the
 * effective consensus config, assembles a `ConsensusMineRequest` from the
 * caller's overrides, optionally supplies an LLM dispatcher, delegates to
 * `mineAndStoreConsensusV1`, applies report retention, and renders a bounded
 * summary.
 *
 * It writes exactly one thing: the report under
 * `.swarm/evolution/consensus/<reportId>.json` (plus retention deletions of
 * *its own* prior reports). It activates no skill, writes no knowledge, and
 * touches no project file — which is why it is classified as a **pathless
 * write-like** tool in `src/full-auto/policy.ts` alongside `write_retro` and
 * `knowledge_add`, and why it is absent from `WRITE_TOOL_NAMES`
 * (`src/config/constants.ts`), whose members are the tools that write PROJECT
 * FILE CONTENTS and are therefore subject to the scope guard.
 *
 * `ctx.directory` is injected by `createSwarmTool`; there is no `process.cwd()`
 * anywhere in this file (AGENTS.md invariant 4).
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { ConsensusConfigSchema } from '../config/schema';
import type { ConsensusMineRequest } from '../consensus/contracts';
import { mineAndStoreConsensusV1 } from '../consensus/public-api';
import { pruneConsensusReports } from '../consensus/store';
import { createEvaluationModelDispatcher } from '../evaluation/model-dispatcher';
import { swarmState } from '../state';
import { createSwarmTool } from './create-tool';

/** Bounds a caller-supplied filter list so a request cannot be unbounded. */
const MAX_FILTER_ENTRIES = 200;

const FilterListSchema = z
	.array(z.string().min(1).max(512))
	.max(MAX_FILTER_ENTRIES);

/** Attributes echoed back inline. The full set always lives in the report. */
const MAX_INLINE_ATTRIBUTES = 25;

export const consensus_mine: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Mine cross-run consensus from existing .swarm evidence (evaluation runs, gate audits, ' +
			'trajectories, skill usage, knowledge outcomes, evidence bundles) and persist an immutable ' +
			'report of agreed-upon attributes plus proposals-only recommendations. Reads and proposes; ' +
			'never activates a skill, writes knowledge, or edits any artifact.',
		args: {
			run_ids: FilterListSchema.optional().describe(
				'Restrict mining to these run ids (raw or namespaced). Omit for all runs.',
			),
			task_categories: FilterListSchema.optional().describe(
				'Restrict to these evaluation task categories. Omit for all categories.',
			),
			agent_roles: FilterListSchema.optional().describe(
				'Restrict to these agent roles. Omit for all roles.',
			),
			model_ids: FilterListSchema.optional().describe(
				'Restrict to these model ids. Omit for all models.',
			),
			min_support: z
				.number()
				.int()
				.min(1)
				.max(10_000)
				.optional()
				.describe(
					'Distinct runs required to emit an attribute. Defaults to consensus.default_min_support.',
				),
			min_successful_runs: z
				.number()
				.int()
				.min(0)
				.max(10_000)
				.optional()
				.describe(
					'Successful runs required. Defaults to consensus.default_min_successful_runs.',
				),
			max_evidence_items: z
				.number()
				.int()
				.min(1)
				.max(10_000)
				.optional()
				.describe(
					'Cap on corpus observations read. Defaults to consensus.default_max_evidence_items.',
				),
		},
		execute: async (
			args: unknown,
			directory: string,
			ctx?: ToolContext,
		): Promise<string> => {
			const input = (args ?? {}) as {
				run_ids?: string[];
				task_categories?: string[];
				agent_roles?: string[];
				model_ids?: string[];
				min_support?: number;
				min_successful_runs?: number;
				max_evidence_items?: number;
			};

			const loaded = loadPluginConfigWithMeta(directory);
			// `consensus` is optional at the top level; parsing `{}` materializes
			// every documented default rather than scattering fallbacks below.
			const config = ConsensusConfigSchema.parse(loaded.config.consensus ?? {});

			if (!config.enabled) {
				return JSON.stringify(
					{
						success: false,
						disabled: true,
						message:
							'Consensus mining is disabled (consensus.enabled = false). No report was written.',
					},
					null,
					2,
				);
			}

			const request: ConsensusMineRequest = {
				...(input.run_ids ? { runIds: input.run_ids } : {}),
				...(input.task_categories
					? { taskCategories: input.task_categories }
					: {}),
				...(input.agent_roles ? { agentRoles: input.agent_roles } : {}),
				...(input.model_ids ? { modelIds: input.model_ids } : {}),
				minSupport: input.min_support ?? config.default_min_support,
				minSuccessfulRuns:
					input.min_successful_runs ?? config.default_min_successful_runs,
				maxEvidenceItems:
					input.max_evidence_items ?? config.default_max_evidence_items,
			};

			// Graceful degradation, not a hard dependency: when the OpenCode runtime
			// has not wired a client (direct CLI, unit tests, Node sidecar without a
			// session), the miner keeps its deterministic statements and the report
			// records why via `summarization_skipped_reason`.
			const client = swarmState.opencodeClient;
			const dispatcher =
				config.llm_summarization_enabled && client
					? createEvaluationModelDispatcher(client)
					: undefined;

			const result = await mineAndStoreConsensusV1({
				directory,
				request,
				deps: {
					config,
					...(dispatcher ? { dispatcher } : {}),
					...(ctx?.sessionID ? { sessionId: ctx.sessionID } : {}),
					agentRole: 'consensus_mine',
				},
			});

			const pruned = await pruneConsensusReports(
				directory,
				config.report_retention,
			);

			const report = result.report;
			return JSON.stringify(
				{
					success: true,
					report_id: report.reportId,
					report_path: `.swarm/evolution/consensus/${report.reportId}.json`,
					generated_at: report.generatedAt,
					integrity_hash: report.integrityHash,
					config_hash: report.configHash,
					redaction_policy_version: report.redactionPolicyVersion,
					thresholds: {
						min_support: request.minSupport,
						min_successful_runs: request.minSuccessfulRuns,
						max_evidence_items: request.maxEvidenceItems,
						min_task_diversity: 2,
					},
					input_run_count: report.inputIds.length,
					corpus: report.corpusHashes.map((entry) => ({
						source: entry.source,
						observations: entry.observations,
					})),
					corpus_truncated: result.truncated,
					unreadable_sources: result.unreadableSources,
					attribute_count: report.attributes.length,
					investigation_note_count: result.investigationNoteCount,
					proposal_count: report.proposals.length,
					deduped_proposal_count: result.dedupedProposalCount,
					summarized_count: result.summarizedCount,
					...(result.summarizationSkippedReason
						? {
								summarization_skipped_reason: result.summarizationSkippedReason,
							}
						: {}),
					attributes: report.attributes
						.slice(0, MAX_INLINE_ATTRIBUTES)
						.map((attribute) => ({
							id: attribute.id,
							statement: attribute.statement,
							support: attribute.support,
							success_support: attribute.successSupport,
							failure_support: attribute.failureSupport,
							task_diversity: attribute.taskDiversity,
							model_diversity: attribute.modelDiversity,
							confidence: attribute.confidence,
							proposed_target: attribute.proposedTarget,
							counterexample_count: attribute.counterexampleRefs.length,
						})),
					attributes_truncated:
						report.attributes.length > MAX_INLINE_ATTRIBUTES,
					retention: {
						configured: config.report_retention,
						deleted: pruned.deleted.length,
						retained: pruned.retained.length,
						failed: pruned.failed.length,
					},
					guarantees: [
						'proposals only — no skill activation, knowledge write, or artifact mutation',
						'model_diversity 0 means "not measurable from this corpus", never "measured as none"',
						'attributes below task diversity 2 are investigation notes, never proposals',
						'negative evidence and counterexamples are always retained',
					],
				},
				null,
				2,
			);
		},
	});

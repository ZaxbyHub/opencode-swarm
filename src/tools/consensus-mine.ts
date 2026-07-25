/**
 * `consensus_mine` — run the consensus miner and persist its report.
 *
 * The tool is a thin, fully-wired shell around `src/consensus/`: it resolves the
 * effective consensus config, assembles a `ConsensusMineRequest` from the
 * caller's overrides, optionally supplies an LLM dispatcher, delegates to
 * `mineAndStoreConsensusV1`, applies report retention, and renders a bounded
 * summary.
 *
 * It writes two artifacts. The first is the report under
 * `.swarm/evolution/consensus/<reportId>.json`, plus retention deletions of
 * *its own* prior reports. The second is the shared cross-producer dedup ledger
 * (issue #1821 AC21), which gains one entry per emitted proposal EXCEPT where
 * another producer already claimed the same recommendation — those are counted
 * as `cross_producer_duplicate_count` instead — and which is rewritten whole,
 * with FIFO eviction, on each append. The ledger normally lives at
 * `.swarm/learning/recommendation-ledger.jsonl`, but its root is
 * `resolveKnowledgeStoreDir`, so under a knowledge-link pointer it lands in the
 * shared cohort root rather than this project's `.swarm/`.
 *
 * Incidental filesystem effects come with those two writes — the consensus
 * directory itself, and lock sentinels under `.swarm/locks/` for the immutable
 * write and the ledger transaction. What the tool does NOT do is mutate any of
 * the evidence it reads. That is a chosen property, not a free one:
 * `loadEvidence` upgrades a legacy flat retrospective in place by default, so
 * `src/consensus/corpus.ts` binds it with `{ migrate: false }`. Without that, a
 * mining run would rewrite evidence bundles — and remap their legacy
 * `task_complexity` values — while advertising itself as read-only.
 *
 * It activates no skill, writes no knowledge, and touches no project file —
 * which is why it is classified as a **pathless write-like** tool in
 * `src/full-auto/policy.ts` alongside `write_retro` and `knowledge_add`, and why
 * it is absent from `WRITE_TOOL_NAMES` (`src/config/constants.ts`), whose
 * members are the tools that write PROJECT FILE CONTENTS and are therefore
 * subject to the scope guard.
 *
 * `ctx.directory` is injected by `createSwarmTool`; there is no `process.cwd()`
 * anywhere in this file (AGENTS.md invariant 4).
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { ConsensusConfigSchema } from '../config/schema';
import type {
	ConsensusMineRequest,
	ConsensusReportV1,
} from '../consensus/contracts';
import { MIN_TASK_DIVERSITY_FOR_PROPOSAL } from '../consensus/miner';
import { mineAndStoreConsensusV1 } from '../consensus/public-api';
import { pruneConsensusReports } from '../consensus/store';
import { createEvaluationModelDispatcher } from '../evaluation/model-dispatcher';
import {
	type RecommendationCandidate,
	recordEmittedRecommendations,
} from '../services/recommendation-ledger';
import { swarmState } from '../state';
import { createSwarmTool } from './create-tool';

/** Bounds a caller-supplied filter list so a request cannot be unbounded. */
const MAX_FILTER_ENTRIES = 200;

const FilterListSchema = z
	.array(z.string().min(1).max(512))
	.max(MAX_FILTER_ENTRIES);

/** Attributes echoed back inline. The full set always lives in the report. */
const MAX_INLINE_ATTRIBUTES = 25;

/**
 * Describe the miner's emissions to the cross-producer dedup ledger
 * (issue #1821 AC21).
 *
 * The statement is the proposal's `intent` — the sentence the miner actually
 * emits — not the internal attribute statement its own `lrec_` fingerprint is
 * built from: only the intent survives onto the persisted report, and it is the
 * text a human reads as "the recommendation". `scopeKeys` stays empty for the
 * same reason the curator's new-knowledge recommendations carry none: content
 * alone is the identity of a freshly-minted lesson, and that is exactly where
 * another producer can legitimately be proposing the same thing.
 */
function buildMinerRecommendationCandidates(
	report: Pick<ConsensusReportV1, 'proposals' | 'generatedAt'>,
	sessionId?: string,
): RecommendationCandidate[] {
	return report.proposals.map((proposal) => ({
		kind: 'miner' as const,
		target: proposal.target,
		statement: proposal.intent,
		scopeKeys: [],
		provenance: {
			mechanism: 'consensus_mine' as const,
			sourceEvidenceRefs: proposal.evidenceRefs,
			sourceRunIds: proposal.provenance.sourceRunIds,
			sourceModelIds: proposal.provenance.sourceModelIds,
			sourceTaskIds: proposal.provenance.sourceTaskIds,
		},
		origin: {
			agentRole: 'consensus_mine',
			...(sessionId ? { sessionId } : {}),
			producedAt: report.generatedAt,
		},
	}));
}

/**
 * Pure-function seam for tests (writing-tests SKILL.md, Tier 0). Exported so a
 * cross-producer dedup test can build the miner's ledger candidates through the
 * same code the tool runs instead of restating the mapping.
 */
export const _test_exports = { buildMinerRecommendationCandidates };

export const consensus_mine: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Mine cross-run consensus from existing .swarm evidence (evaluation runs, gate audits, ' +
			'trajectories, skill usage, knowledge outcomes, evidence bundles) and persist an immutable ' +
			'report of agreed-upon attributes plus proposals-only recommendations. Reads and proposes; ' +
			'never activates a skill, writes knowledge, edits a project file, or mutates any evidence it ' +
			'reads. Its only writes are its own immutable report and an entry per proposal in the shared ' +
			'recommendation dedup ledger.',
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

			const report = result.report;

			// #1821 AC21: register the miner's emissions in the shared dedup ledger
			// so a lesson the miner already proposed is not re-proposed by the
			// curator sweep or the skill improver. The report is already persisted at
			// this point, so these proposals are emitted by definition — this is the
			// record half of the ledger contract, never a speculative claim.
			//
			// Producer-side only. `src/consensus/` mines and persists in one call, so
			// by the time proposals exist the report is already written; the miner
			// therefore keeps its own report-derived `priorFingerprints` for
			// within-producer dedup and cannot itself be suppressed by a
			// curator/improver emission. `cross_producer_duplicate_count` below makes
			// that overlap visible rather than silent.
			const ledger = await recordEmittedRecommendations(
				directory,
				buildMinerRecommendationCandidates(report, ctx?.sessionID),
				{ producedAt: report.generatedAt },
			);

			const pruned = await pruneConsensusReports(
				directory,
				config.report_retention,
			);

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
						// Sourced from the miner rather than restated, so the number the
						// model is told cannot drift from the gate actually applied.
						min_task_diversity: MIN_TASK_DIVERSITY_FOR_PROPOSAL,
					},
					input_run_count: report.inputIds.length,
					corpus: report.corpusHashes.map((entry) => ({
						source: entry.source,
						observations: entry.observations,
					})),
					corpus_truncated: result.truncated,
					// Persisted on the report, not merely returned: every one of these
					// cuts changes what the numbers above MEAN. A reader who cannot see
					// that the corpus was capped cannot tell `failure_support: 0` —
					// "nothing failed" — from "the failures were truncated away".
					truncation: {
						corpus: report.truncation.corpus,
						observations_tallied: report.truncation.observations,
						input_ids_truncated: report.truncation.inputIds,
						total_input_ids: report.truncation.totalInputIds,
						attributes_dropped: report.truncation.attributesDropped,
					},
					unreadable_sources: result.unreadableSources,
					attribute_count: report.attributes.length,
					investigation_note_count: result.investigationNoteCount,
					proposal_count: report.proposals.length,
					deduped_proposal_count: result.dedupedProposalCount,
					cross_producer_duplicate_count: ledger.suppressed,
					// Derived from the PERSISTED report, so it always agrees with the
					// `llm_summary` values echoed below. `result.summarizedCount` counts
					// restatements THIS run accepted, which can differ: an immutable
					// re-mine returns the already-stored artifact (`llmSummary` sits
					// outside the integrity hash, so a differing restatement is not a
					// conflict) and this run's restatements are discarded. Reporting the
					// run's count beside the stored report's text would show a number
					// that matches nothing the caller can see.
					summarized_count: report.attributes.filter(
						(attribute) => attribute.llmSummary !== undefined,
					).length,
					restatements_accepted_this_run: result.summarizedCount,
					...(result.summarizationSkippedReason
						? {
								summarization_skipped_reason: result.summarizationSkippedReason,
							}
						: {}),
					attributes: report.attributes
						.slice(0, MAX_INLINE_ATTRIBUTES)
						.map((attribute) => ({
							id: attribute.id,
							// The deterministic rendering is always authoritative. The
							// optional model restatement is echoed beside it, never in
							// place of it, and is absent unless it passed the miner's
							// single-sentence `FINDING:` guard.
							statement: attribute.statement,
							...(attribute.llmSummary
								? { llm_summary: attribute.llmSummary }
								: {}),
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
					// Every string here is asserted by a test, because these are printed
					// into the model's context and are read as facts. A guarantee the
					// code does not actually deliver is worse than no guarantee at all.
					guarantees: [
						'proposals only — no skill activation, no knowledge write, and no mutation of any evidence read',
						'model_diversity 0 means "not measurable from this corpus", never "measured as none"',
						`attributes below task diversity ${MIN_TASK_DIVERSITY_FOR_PROPOSAL} are investigation notes, never proposals`,
						// Precise on purpose. The schema half is absolute; the truncation
						// half is not — the cut is balanced PER SOURCE, and sources after
						// the budget is spent are dropped whole, so a specific attribute
						// can still lose all its counterexamples. Saying "negative
						// evidence is always retained" would be the same class of
						// overclaim this tool was revised to remove.
						'an attribute counting failing runs always carries counterexample refs (schema-enforced)',
						'truncation is not biased toward successes, but it is still a cut: it balances per source, and drops whole sources once the budget is spent',
						'statement is deterministic; llm_summary is an optional restatement excluded from integrity_hash',
						// Precise: config_hash and request are hashed too, so this holds
						// at a fixed consensus config and fixed thresholds — not across
						// a config change. A model restatement can never move it.
						'reproducible: identical corpus, request, config_hash, and prior proposals yield the same integrity_hash and report_id; model wording never moves it',
						'truncation is declared on the report; read failure_support 0 on a truncated report as "none survived the cut"',
					],
				},
				null,
				2,
			);
		},
	});

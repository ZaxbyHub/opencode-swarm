/**
 * `consensus_mine` — run the consensus miner and persist its report.
 *
 * The tool is a thin, fully-wired shell around `src/consensus/`: it resolves the
 * effective consensus config, assembles a `ConsensusMineRequest` from the
 * caller's overrides, optionally supplies an LLM dispatcher, delegates to
 * `mineAndStoreConsensusV1`, applies report retention, and renders a bounded
 * summary.
 *
 * It is NOT write-minimal, and the description the model reads says so. The
 * complete list of effects, none of which touches a project file:
 *
 * 1. **Its own report** under `.swarm/evolution/consensus/<reportId>.json`.
 * 2. **Deletions of its own prior reports.** `pruneConsensusReports` runs
 *    unconditionally after every mine and `consensus.report_retention` defaults
 *    to 50, so the steady state of a long-lived project is that each run
 *    `unlink`s the oldest report. Only `report_retention: 0` disables it.
 * 3. **The shared dedup ledger** (issue #1821 AC21). It gains one entry per
 *    emitted proposal EXCEPT where it already carries that recommendation's
 *    cross key — those are counted as `duplicate_recommendation_count` instead.
 *    The append is a whole-file rewrite with FIFO eviction at
 *    `MAX_RECOMMENDATION_LEDGER_ENTRIES`, and eviction is by position, not by
 *    producer: a miner append can evict the CURATOR's or the IMPROVER's oldest
 *    entries. The ledger normally lives at
 *    `.swarm/learning/recommendation-ledger.jsonl`, but its root is
 *    `resolveKnowledgeStoreDir`, so under a knowledge-link pointer it lands in
 *    the shared cohort root rather than this project's `.swarm/`.
 * 4. **Lock sentinels.** The report goes through `withEvidenceLock`, whose
 *    sentinel is an empty `<sha256>.lock` file under this project's
 *    `.swarm/locks/`; `proper-lockfile` removes its own lock directory but
 *    NOTHING removes that sentinel, so each distinct report id leaves one behind
 *    permanently. The ledger goes through `transactFile`, which locks the
 *    ledger's own containing directory and therefore produces
 *    `<resolveKnowledgeStoreDir(directory)>/learning.lock` — outside this
 *    project's `.swarm/` entirely whenever a knowledge link is active.
 * 5. **A pending memory proposal per emitted proposal**, but only when
 *    `memory.enabled` is `true` (it defaults to `false`,
 *    `src/config/schema.ts`). This is issue #1821 AC22 — "use existing
 *    proposal/MemoryRecord paths, not another inbox" — so the mirror goes
 *    through the same `MemoryGateway.propose` path `swarm_memory_propose` uses,
 *    which creates a *pending proposal* requiring curator review and never a
 *    durable memory record.
 * 6. **Up to `MAX_LLM_SUMMARIES` (20) `session.create` + `session.prompt`
 *    calls** whenever `consensus.llm_summarization_enabled` (default `true`)
 *    finds a wired OpenCode client.
 *
 * Effects 2-6 were absent from the tool description for four review rounds
 * while it claimed "its only writes are its own immutable report and one entry
 * in the shared recommendation dedup ledger". That string is read by a model as
 * fact and was the premise of the Full-Auto auto-allow in
 * `src/full-auto/policy.ts`; both now state the list above.
 *
 * What the tool does NOT do is mutate any of the evidence it reads. That is a
 * chosen property, not a free one:
 * `loadEvidence` upgrades a legacy flat retrospective in place by default, so
 * `src/consensus/corpus.ts` binds it with `{ migrate: false }`. Without that, a
 * mining run would rewrite evidence bundles — and remap their legacy
 * `task_complexity` values — while advertising itself as read-only.
 *
 * It activates no skill, writes no knowledge entry, admits no durable memory
 * record, and touches no project file — which is why it is classified as a
 * **pathless write-like** tool in `src/full-auto/policy.ts` alongside
 * `write_retro` and `knowledge_add`, and why it is absent from
 * `WRITE_TOOL_NAMES` (`src/config/constants.ts`), whose members are the tools
 * that write PROJECT FILE CONTENTS and are therefore subject to the scope guard.
 * The knowledge-link redirection in effects 3 and 5 does not change that
 * classification: `knowledge_add` and `knowledge_remove` are in the same
 * auto-allow set and have the same redirection, and it comes from operator
 * configuration rather than from anything the caller passed.
 *
 * `ctx.directory` is injected by `createSwarmTool`; there is no `process.cwd()`
 * anywhere in this file (AGENTS.md invariant 4).
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import type { MemoryConfig } from '../config/schema';
import { ConsensusConfigSchema } from '../config/schema';
import type {
	ConsensusAttributeV1,
	ConsensusMineRequest,
	ConsensusReportV1,
} from '../consensus/contracts';
import {
	MAX_LLM_SUMMARIES,
	MIN_SUPPORT_FOR_PROPOSAL,
	MIN_TASK_DIVERSITY_FOR_PROPOSAL,
} from '../consensus/miner';
import { mineAndStoreConsensusV1 } from '../consensus/public-api';
import { pruneConsensusReports } from '../consensus/store';
import { createEvaluationModelDispatcher } from '../evaluation/model-dispatcher';
import { createMemoryGateway } from '../memory';
import {
	type RecommendationCandidate,
	recordEmittedRecommendations,
} from '../services/recommendation-ledger';
import { swarmState } from '../state';
import { warn } from '../utils/logger';
import { createSwarmTool } from './create-tool';

/** Bounds a caller-supplied filter list so a request cannot be unbounded. */
const MAX_FILTER_ENTRIES = 200;

const FilterListSchema = z
	.array(z.string().min(1).max(512))
	.max(MAX_FILTER_ENTRIES);

/** Attributes echoed back inline. The full set always lives in the report. */
const MAX_INLINE_ATTRIBUTES = 25;

/**
 * Reconcile the summary counters with what the inline echo actually shows.
 *
 * These are two different orderings and they do not line up. Restatements are
 * spent on the top `MAX_LLM_SUMMARIES` attributes by CONFIDENCE
 * (`src/consensus/miner.ts`), while the echo below is the first
 * `MAX_INLINE_ATTRIBUTES` in canonical SIGNAL order. With confidence inverted
 * relative to signal order, a report can print `summarized_count: 20` while zero
 * `llm_summary` values are visible — which is exactly what "the count always
 * agrees with the values echoed alongside it" used to claim was impossible.
 * `hidden` is what makes the discrepancy legible instead of mysterious.
 */
function countSummaries(
	attributes: readonly ConsensusAttributeV1[],
	inlineLimit: number,
): { total: number; hidden: number } {
	let total = 0;
	let shown = 0;
	for (const [index, attribute] of attributes.entries()) {
		if (attribute.llmSummary === undefined) continue;
		total += 1;
		if (index < inlineLimit) shown += 1;
	}
	return { total, hidden: total - shown };
}

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
 * What the AC22 memory mirror actually did, reported rather than assumed.
 *
 * `attempted` is 0 whenever `enabled` is false, so a reader can tell "memory is
 * off" from "memory is on and nothing was proposed". `failed` and `error` exist
 * because the mirror is deliberately fail-open — the report is already durably
 * written by the time it runs, and losing the whole mine to a memory-store
 * problem would be worse than losing the mirror — but a fail-open path that
 * reports nothing is exactly the defect `recommendation_ledger.degraded` was
 * added to close.
 */
type MemoryMirrorResult = {
	enabled: boolean;
	attempted: number;
	proposed: number;
	rejected: number;
	failed: number;
	error?: string;
};

/**
 * Memory kind for a mirrored proposal.
 *
 * `todo` is chosen for two reasons, one semantic and one structural. A consensus
 * proposal IS a pending suggested action awaiting review, which is what `todo`
 * means. And `todo` is the only kind that is in neither `DURABLE_MEMORY_KINDS`
 * nor `EVIDENCE_REQUIRED_KINDS` and carries no expiry rule
 * (`src/memory/config.ts`), so a proposal built from an attribute whose corpus
 * refs do not parse as a file path, URL, or commit sha cannot be rejected by
 * `validateMemoryRecordRules` for lacking source evidence. Picking a durable
 * kind would have made the mirror silently throw on exactly the corpus sources
 * (trajectories, skill usage, knowledge outcomes) whose refs are namespaced ids
 * rather than paths.
 */
const MIRRORED_PROPOSAL_KIND = 'todo' as const;

/**
 * Issue #1821 AC22: mirror each emitted proposal into the EXISTING memory
 * proposal path rather than leaving the consensus report as a write-only inbox.
 *
 * `MemoryGateway.propose` is the same entry point `swarm_memory_propose` uses
 * (`src/tools/swarm-memory-propose.ts`), including its `dispose()` in a
 * `finally`. It creates a PENDING proposal — curator review is still required,
 * nothing durable is admitted — which is why the tool's proposals-only guarantee
 * survives the mirror.
 *
 * Fail-open by design and per-proposal: one rejected or throwing proposal must
 * not discard the ones that succeeded, and none of it can unwrite the report.
 * Every outcome is counted and returned, so the tool's response says what
 * happened instead of implying success.
 */
async function mirrorProposalsToMemory(options: {
	directory: string;
	memoryConfig: MemoryConfig | undefined;
	report: Pick<ConsensusReportV1, 'proposals' | 'reportId'>;
	sessionId?: string;
}): Promise<MemoryMirrorResult> {
	if (options.memoryConfig?.enabled !== true) {
		return {
			enabled: false,
			attempted: 0,
			proposed: 0,
			rejected: 0,
			failed: 0,
		};
	}
	const proposals = options.report.proposals;
	if (proposals.length === 0) {
		return { enabled: true, attempted: 0, proposed: 0, rejected: 0, failed: 0 };
	}

	let gateway: ReturnType<typeof createMemoryGateway>;
	try {
		gateway = _internals.createMemoryGateway(
			{
				directory: options.directory,
				...(options.sessionId
					? { sessionID: options.sessionId, runId: options.sessionId }
					: {}),
				agentRole: 'consensus_mine',
			},
			{ config: options.memoryConfig },
		);
	} catch (err) {
		// Provider construction failed (missing driver, unwritable storage dir).
		// Nothing was proposed, and saying so beats reporting zeroes that read as
		// "there was nothing to mirror".
		const message = err instanceof Error ? err.message : String(err);
		warn(`[consensus_mine] memory mirror unavailable (fail-open): ${message}`);
		return {
			enabled: true,
			attempted: proposals.length,
			proposed: 0,
			rejected: 0,
			failed: proposals.length,
			error: message,
		};
	}

	let proposed = 0;
	let rejected = 0;
	let failed = 0;
	let error: string | undefined;
	try {
		for (const proposal of proposals) {
			try {
				const created = await gateway.propose({
					operation: 'add',
					kind: MIRRORED_PROPOSAL_KIND,
					text: proposal.intent,
					rationale: `consensus_mine proposal from report ${options.report.reportId}, attribute ${proposal.sourceAttributeId} (target ${proposal.target}, confidence ${proposal.confidence})`,
					evidenceRefs: proposal.evidenceRefs,
				});
				// `propose` records a policy rejection as a stored proposal rather
				// than throwing, so this is a real outcome, not a failure.
				if (created.status === 'rejected') rejected += 1;
				else proposed += 1;
			} catch (err) {
				failed += 1;
				error ??= err instanceof Error ? err.message : String(err);
			}
		}
	} finally {
		try {
			await gateway.dispose();
		} catch (err) {
			// Disposal closes the provider handle; it cannot unwrite a proposal that
			// was already created, so it is logged rather than counted as a failure.
			warn(
				`[consensus_mine] memory gateway dispose failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	if (error !== undefined) {
		warn(`[consensus_mine] memory mirror partially failed: ${error}`);
	}
	return {
		enabled: true,
		attempted: proposals.length,
		proposed,
		rejected,
		failed,
		...(error ? { error } : {}),
	};
}

/**
 * DI seam (AGENTS.md invariant 7). Lets a test drive the AC22 mirror's
 * failure and rejection branches without a real provider and without
 * `mock.module`. Restore each entry in `afterEach`.
 */
export const _internals: {
	createMemoryGateway: typeof createMemoryGateway;
} = {
	createMemoryGateway,
};

/**
 * Pure-function seam for tests (writing-tests SKILL.md, Tier 0). Exported so a
 * cross-producer dedup test can build the miner's ledger candidates through the
 * same code the tool runs instead of restating the mapping, and so the
 * summary-counter reconciliation can be asserted at the ordering that produces
 * it — 20 summarized attributes with none visible — rather than only at the
 * degenerate all-zero case a dispatcher-less run reaches.
 */
export const _test_exports = {
	buildMinerRecommendationCandidates,
	countSummaries,
	mirrorProposalsToMemory,
	MAX_INLINE_ATTRIBUTES,
	MIRRORED_PROPOSAL_KIND,
};

export const consensus_mine: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Mine cross-run consensus from existing .swarm evidence — evaluation runs, gate audits, gate ' +
			'ground truth, task trajectories, PRM sessions, skill usage, knowledge outcomes, evidence ' +
			'bundles, and curated failures (nine sources) — and persist an immutable report of ' +
			'agreed-upon attributes plus proposals-only recommendations. It never activates a skill, ' +
			'writes a knowledge entry, admits a durable memory record, edits a project file, or mutates ' +
			'any evidence it reads. It is NOT otherwise write-minimal, so plan for these effects: it ' +
			'DELETES its own older reports past consensus.report_retention (default 50) on every run; it ' +
			'rewrites the shared recommendation dedup ledger whole, with FIFO eviction that can drop ' +
			"another producer's oldest entries; it leaves one never-removed lock sentinel per report id " +
			'under .swarm/locks/; when memory.enabled is true it mirrors each proposal into a PENDING ' +
			'swarm-memory proposal (curator review still required); and when ' +
			`consensus.llm_summarization_enabled is true (the default) it issues up to ${MAX_LLM_SUMMARIES} ` +
			'session.create plus session.prompt calls. Under a knowledge or memory link the ledger and ' +
			"the memory store resolve to the shared cohort root, outside this project's .swarm/.",
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
			// curator/improver emission.
			//
			// `duplicate_recommendation_count` below counts ledger-key collisions, and
			// the ledger key is deliberately producer-agnostic (it drops both `kind`
			// and `target`), so "another producer" is NOT what it measures — which is
			// why the field is no longer named `cross_producer_duplicate_count`. The
			// miner's own earlier emissions collide with it, and so do duplicates
			// within a single batch: report retention defaults to 50 while the ledger
			// keeps 500, and `priorFingerprints` only reads reports that still exist,
			// so once a report is pruned its proposals are re-derived, re-emitted — and
			// then matched against the miner's own surviving ledger entries.
			//
			// `recordEmittedRecommendations` is FAIL-OPEN: a broken ledger path returns
			// `{ recorded: 0, suppressed: 0, evicted: 0, degraded: true }` rather than
			// throwing. Reading only `.suppressed` therefore printed a truthful-looking
			// `0` for a run that wrote no ledger at all, so the whole result is
			// surfaced below — `degraded` included.
			const ledger = await recordEmittedRecommendations(
				directory,
				buildMinerRecommendationCandidates(report, ctx?.sessionID),
				{ producedAt: report.generatedAt },
			);
			if (ledger.degraded) {
				warn(
					'[consensus_mine] recommendation ledger write degraded; proposals were not recorded for cross-producer dedup',
				);
			}

			// #1821 AC22: the report is not the only place a proposal lands. When
			// swarm memory is enabled each proposal is mirrored through the EXISTING
			// `MemoryGateway.propose` path — the same one `swarm_memory_propose` uses
			// — so proposals are reachable from a reviewed surface instead of sitting
			// in a directory nothing reads. Memory defaults to OFF, which is why
			// `/swarm status` also counts stored reports (`countConsensusReportFiles`).
			const memoryMirror = await mirrorProposalsToMemory({
				directory,
				memoryConfig: loaded.config.memory,
				report,
				...(ctx?.sessionID ? { sessionId: ctx.sessionID } : {}),
			});

			const pruned = await pruneConsensusReports(
				directory,
				config.report_retention,
			);
			// `report_retention: 0` DISABLES pruning, so `pruneConsensusReports`
			// returns early with four empty arrays: nothing was deleted, and nothing
			// was enumerated either. Printing `retained: 0` there would tell the model
			// every report had been discarded, which is the exact opposite of what
			// happened, and printing `corrupt: 0` would assert a clean store that was
			// never inspected. Neither count exists in that mode, so both fields are
			// omitted and the mode is declared instead.
			const pruningEnabled = config.report_retention > 0;

			const summaries = countSummaries(
				report.attributes,
				MAX_INLINE_ATTRIBUTES,
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
						// Both proposal gates are sourced from the miner rather than
						// restated, so the numbers the model is told cannot drift from the
						// gates actually applied. `min_support_for_proposal` is NOT implied
						// by `min_support`: the argument accepts 1, so without printing it
						// an attribute could clear every other threshold here and still be
						// forced to `proposed_target: 'none'` with nothing explaining why.
						min_task_diversity: MIN_TASK_DIVERSITY_FOR_PROPOSAL,
						min_support_for_proposal: MIN_SUPPORT_FOR_PROPOSAL,
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
					// Everything the shared dedup ledger did, not just the suppression
					// count. `degraded` is the field that matters most: the ledger write
					// is fail-open, so without it a run whose ledger path was unusable
					// reported `0` duplicates exactly like a run that recorded cleanly.
					// The name says "duplicate", not "cross-producer", because the ledger
					// key drops `kind` and `target` — the miner's own re-derived
					// proposals and intra-batch repeats land here too.
					recommendation_ledger: {
						recorded: ledger.recorded,
						duplicate_recommendation_count: ledger.suppressed,
						evicted: ledger.evicted,
						degraded: ledger.degraded,
					},
					// #1821 AC22. `enabled: false` is the default configuration, and it
					// means the mirror did not run — not that it ran and found nothing.
					memory_mirror: memoryMirror,
					// Derived from the PERSISTED report, not from this run.
					// `result.summarizedCount` counts restatements THIS run accepted,
					// which can differ: an immutable re-mine returns the already-stored
					// artifact (`llmSummary` sits outside the integrity hash, so a
					// differing restatement is not a conflict) and this run's restatements
					// are discarded. Reporting the run's count beside the stored report's
					// text would show a number that matches nothing the caller can see.
					summarized_count: summaries.total,
					// How many of those sit OUTSIDE the inline echo below. Zero whenever
					// the report has `MAX_INLINE_ATTRIBUTES` attributes or fewer; above
					// that it can reach `summarized_count` in full, because restatements
					// go to the highest-confidence attributes while the echo is the first
					// slice in signal order and the two orderings are independent. Read a
					// `summarized_count` with no visible `llm_summary` as "they are in the
					// report file", not as a contradiction.
					summarized_but_not_shown: summaries.hidden,
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
							// `FINDING:` whitelist — one envelope line, no bracket markup,
							// no forged redaction marker, no reasoning marker, and — after
							// decimal points and one lower-case-continued abbreviation are
							// masked — at most one sentence-terminator run (so the stored
							// text may still hold several literal periods), and no
							// trimming to fit the length
							// bound. That bounds its shape and size, not whether it reads
							// as narration: a chained single sentence still can.
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
					retention: pruningEnabled
						? {
								configured: config.report_retention,
								pruning_enabled: true,
								deleted: pruned.deleted.length,
								retained: pruned.retained.length,
								failed: pruned.failed.length,
								// Reports on disk that failed to parse or verify. They are
								// deliberately never deleted AND are excluded from `retained`,
								// so `deleted + retained` under-counts the directory by
								// exactly this number. Printing the other three alone made a
								// store with corrupt artifacts look smaller than it is.
								corrupt: pruned.corrupt.length,
							}
						: {
								configured: config.report_retention,
								pruning_enabled: false,
								deleted: 0,
								failed: 0,
							},
					// Every string here is asserted by a test, because these are printed
					// into the model's context and are read as facts. A guarantee the
					// code does not actually deliver is worse than no guarantee at all.
					guarantees: [
						// "no knowledge write" is unchanged by the AC22 mirror: that path
						// creates a PENDING memory proposal, which is reviewed before any
						// durable record exists. Saying "no memory write" would be false —
						// a pending proposal is persisted — so the claim names what is
						// actually guaranteed: nothing durable is admitted.
						'proposals only — no skill activation, no knowledge write, no durable memory record, and no mutation of any evidence read',
						'model_diversity 0 means "not measurable from this corpus", never "measured as none"',
						`attributes below task diversity ${MIN_TASK_DIVERSITY_FOR_PROPOSAL} or below support ${MIN_SUPPORT_FOR_PROPOSAL} are investigation notes, never proposals`,
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

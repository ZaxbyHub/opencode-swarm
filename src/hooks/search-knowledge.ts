/**
 * Unified knowledge retrieval service.
 *
 * This is the single core through which BOTH manual recall (`knowledge_recall`)
 * and automatic injection (the phase-start injector) retrieve knowledge. It
 * replaces the former split between Jaccard-only manual recall and the
 * metadata-only action-aware injection ranker with one hybrid algorithm:
 *
 *   finalScore = TEXT_WEIGHT  * textScore        (Jaccard query↔lesson)
 *              + META_WEIGHT  * metadataScore     (phase/confidence/keywords)
 *              + directiveScore                   (trigger/action/agent/priority)
 *              + boosts (status, generated-skill)
 *
 * Each signal degrades to 0 when its input is absent, so a query-only call
 * (manual recall) is text-dominated while a context-only call (injection) is
 * metadata/directive-dominated — without branching into two algorithms.
 *
 * Responsibilities (per the P0 plan):
 *   load → normalize → filter archived/quarantined → dedup (hive wins) →
 *   apply scope & agent-role constraints → hybrid score → rerank
 *   (critical force-include) → emit a `retrieved` event → return trace_id.
 */

import { stripKnownSwarmPrefix } from '../config/schema.js';
import {
	newTraceId,
	type RetrievalEventMode,
	recordKnowledgeEvent,
} from './knowledge-events.js';
import {
	type RankedEntry,
	readMergedKnowledge,
	scoreDirectiveAgainstContext,
} from './knowledge-reader.js';
import {
	computeOutcomeSignal,
	jaccardBigram,
	normalize,
	wordBigrams,
} from './knowledge-store.js';
import type {
	KnowledgeConfig,
	KnowledgeRetrievalContext,
} from './knowledge-types.js';

const TEXT_WEIGHT = 0.6;
const META_WEIGHT = 0.4;
const DIRECTIVE_BOOST_MIN_CONFIDENCE = 0.75;
// Max absolute ranking adjustment from an entry's event-sourced track record.
// Bounded and small so outcomes nudge relevance ordering without overriding text/
// directive matches — entries that get applied/succeed rise, ones that get
// ignored/contradicted sink (hard exclusion stays the job of retraction filtering).
const OUTCOME_RANK_WEIGHT = 0.1;

export interface SearchKnowledgeParams {
	directory: string;
	config: KnowledgeConfig;
	/** Free-text query (manual recall). */
	query?: string;
	/** Action-aware decision-point context (injection / context packs). */
	context?: KnowledgeRetrievalContext;
	/** Retrieval mode — recorded on the emitted event. */
	mode: RetrievalEventMode;
	/** Agent role doing the retrieval (used for role scoping + the event). */
	agent?: string;
	/** Session id for the emitted event. */
	sessionId?: string;
	/** Tier filter. Default 'all'. */
	tier?: 'all' | 'swarm' | 'hive';
	/** Max results to return. Falls back to config.max_inject_count. */
	maxResults?: number;
	/** Emit a `retrieved` event (default true). */
	emitEvent?: boolean;
	/**
	 * Apply config.scope_filter (default true). Manual recall passes false so an
	 * explicit query can surface non-global-scoped lessons.
	 */
	applyScopeFilter?: boolean;
	/**
	 * Read the hive tier regardless of config.hive_enabled (default false).
	 * Manual recall passes true so `hive_enabled:false` (an injection knob) does
	 * not also hide hive entries from explicit queries.
	 */
	forceReadHive?: boolean;
	/**
	 * Apply agent-role scoping via applies_to_agents (default true). Manual recall
	 * passes false so an explicit query is not silently role-gated.
	 */
	applyRoleScope?: boolean;
}

export interface SearchKnowledgeResult {
	trace_id: string;
	results: RankedEntry[];
}

/** Build the searchable text blob for an entry (lesson + tags + category). */
function entryText(e: {
	lesson: string;
	tags: string[];
	category: string;
}): string {
	return `${e.lesson} ${e.tags.join(' ')} ${e.category}`;
}

/** Status boost mirrors the legacy manual-recall boost. */
function statusBoost(status: string): number {
	if (status === 'established') return 0.1;
	if (status === 'promoted') return 0.05;
	return 0;
}

/**
 * Run unified knowledge retrieval. Returns a trace_id (always minted, even when
 * no entries match) and the ranked results. Reading/scoring failures degrade to
 * an empty result set; the event emission is fail-open.
 */
export async function searchKnowledge(
	params: SearchKnowledgeParams,
): Promise<SearchKnowledgeResult> {
	const {
		directory,
		config,
		query,
		context,
		mode,
		agent = 'unknown',
		sessionId = 'unknown',
		tier = 'all',
		emitEvent = true,
		applyScopeFilter = true,
		forceReadHive = false,
		applyRoleScope = true,
	} = params;

	const traceId = newTraceId();
	const max = params.maxResults ?? config.max_inject_count ?? 5;

	let results: RankedEntry[] = [];
	try {
		// Step 1-4: load + merge + dedup (hive wins) + scope-filter + archived-filter
		// + metadata score, via the shared merge layer. Pull a wide window so the
		// hybrid re-rank has headroom. Tier filter is applied by toggling hive read
		// (swarm-only) or post-filtering (hive-only).
		const mergeConfig: KnowledgeConfig = {
			...config,
			hive_enabled:
				tier === 'swarm' ? false : forceReadHive ? true : config.hive_enabled,
			max_inject_count: Math.max(20, max),
		};
		const projected = {
			projectName: context?.projectName ?? 'unknown',
			// Empty when there is no context (manual recall) so readMergedKnowledge
			// skips its phase-keyed recordLessonsShown side effect — that tracking is
			// only meaningful for phase-start injection.
			currentPhase: context?.currentPhase ?? '',
			techStack: context?.techStack,
			recentErrors: [
				...(context?.recentReviewerFailures ?? []),
				...(context?.recentTestFailures ?? []),
				...(context?.recentToolErrors ?? []),
			],
		};
		let candidates = await readMergedKnowledge(
			directory,
			mergeConfig,
			projected,
			{
				skipScopeFilter: !applyScopeFilter,
			},
		);

		// Tier post-filter (hive-only) and quarantined exclusion. readMergedKnowledge
		// already excludes archived; quarantined entries must also be hidden.
		candidates = candidates.filter((e) => {
			if (e.status === 'quarantined') return false;
			if (tier === 'hive' && e.tier !== 'hive') return false;
			return true;
		});

		// Agent-role scoping: when an entry declares applies_to_agents, only surface
		// it for those roles (plus the architect, which orchestrates everything).
		// Swarm prefixes are stripped so `mega_coder` matches a bare `coder`.
		const role = stripKnownSwarmPrefix(agent).toLowerCase();
		if (applyRoleScope && role && role !== 'unknown') {
			candidates = candidates.filter((e) => {
				if (!e.applies_to_agents || e.applies_to_agents.length === 0)
					return true;
				if (role === 'architect') return true;
				return e.applies_to_agents
					.map((a) => stripKnownSwarmPrefix(a).toLowerCase())
					.includes(role);
			});
		}

		// Step 5-6: hybrid score. Weights adapt to whether a text query is present:
		// with a query (manual recall), blend text + metadata and apply the
		// status boost; without a query (injection), use the metadata score at full
		// weight and no status boost, so injection ranking matches the prior
		// action-aware ranker exactly (only the directive signal differentiates).
		const queryText = (query ?? '').trim();
		const queryBigrams = queryText ? wordBigrams(normalize(queryText)) : null;
		const hasQuery = queryBigrams !== null;
		const textWeight = hasQuery ? TEXT_WEIGHT : 0;
		const metaWeight = hasQuery ? META_WEIGHT : 1;
		const minConf =
			typeof (config as { directive_min_confidence?: number })
				.directive_min_confidence === 'number'
				? (config as { directive_min_confidence?: number })
						.directive_min_confidence!
				: DIRECTIVE_BOOST_MIN_CONFIDENCE;

		type Scored = RankedEntry & {
			__critical: boolean;
		};
		const scored: Scored[] = candidates.map((entry) => {
			// Text signal (Jaccard query ↔ entry text). 0 when no query.
			const textScore = queryBigrams
				? jaccardBigram(queryBigrams, wordBigrams(normalize(entryText(entry))))
				: 0;

			// Metadata signal — readMergedKnowledge already computed entry.finalScore
			// (category/confidence/keywords/tier). Reuse it as the metadata score.
			const metaScore = entry.finalScore;

			// Directive signal (trigger/action/agent/priority match). 0 without context.
			const ds = context
				? scoreDirectiveAgainstContext(entry, context)
				: { triggerHit: false, actionHit: false, agentHit: false, score: 0 };
			const confBoost =
				context && entry.confidence >= minConf && (ds.actionHit || ds.agentHit)
					? 0.25
					: 0;
			const generatedSkillBoost =
				entry.generated_skill_path && entry.status !== 'archived' ? 0.05 : 0;
			// Event-sourced track record: applied/succeeded entries rise, ignored/
			// contradicted ones sink. 0 (neutral) when the entry has no outcome history.
			const outcomeBoost =
				computeOutcomeSignal(entry.retrieval_outcomes) * OUTCOME_RANK_WEIGHT;

			const finalScore = Math.min(
				1,
				Math.max(
					0,
					textWeight * textScore +
						metaWeight * metaScore +
						ds.score +
						confBoost +
						generatedSkillBoost +
						outcomeBoost +
						(hasQuery ? statusBoost(entry.status) : 0),
				),
			);

			const isCritical =
				entry.directive_priority === 'critical' &&
				(ds.triggerHit || ds.actionHit || ds.agentHit);

			return { ...entry, finalScore, __critical: isCritical };
		});

		// Step 7: rerank — critical+matching first (force-include), then by score
		// with recency tiebreak.
		scored.sort((a, b) => {
			const diff = b.finalScore - a.finalScore;
			if (Math.abs(diff) > 0.001) return diff;
			return (
				new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
			);
		});
		const top: Scored[] = [];
		const seen = new Set<string>();
		for (const e of scored) {
			if (top.length >= max) break;
			if (e.__critical && !seen.has(e.id)) {
				top.push(e);
				seen.add(e.id);
			}
		}
		for (const e of scored) {
			if (top.length >= max) break;
			if (!seen.has(e.id)) {
				top.push(e);
				seen.add(e.id);
			}
		}

		results = top.map(({ __critical: _c, ...rest }) => rest as RankedEntry);
	} catch {
		results = [];
	}

	// Step 8: emit the retrieved event (fail-open).
	if (emitEvent) {
		const ranks: Record<string, number> = {};
		const scores: Record<string, number> = {};
		results.forEach((e, idx) => {
			ranks[e.id] = idx + 1;
			scores[e.id] = e.finalScore;
		});
		await recordKnowledgeEvent(directory, {
			type: 'retrieved',
			trace_id: traceId,
			session_id: sessionId,
			phase: context?.currentPhase,
			task_id: context?.taskId,
			agent,
			query: query ?? context?.lastUserMessage ?? context?.currentPhase ?? '',
			retrieval_mode: mode,
			result_ids: results.map((e) => e.id),
			ranks,
			scores,
		});
	}

	return { trace_id: traceId, results };
}

export const _internals: { searchKnowledge: typeof searchKnowledge } = {
	searchKnowledge,
};

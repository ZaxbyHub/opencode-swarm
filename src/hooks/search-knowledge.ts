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
	buildSynonymIndex,
	expandTokens,
	readSynonymMap,
} from '../services/synonym-map.js';
import { warn } from '../utils/logger.js';
import {
	effectiveRetrievalOutcomes,
	newTraceId,
	type RetrievalEventMode,
	readKnowledgeCounterRollups,
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
// Change 5 / Task 6.2 — retrieval recall upgrades.
// A single, bounded boost when a learned synonym of a query term appears in an
// entry's text. Kept below the directive/trigger signals so synonym recall
// nudges ranking without overriding an exact match.
const SYNONYM_TEXT_BOOST = 0.15;
// Boost for an entry whose declared trigger phrase appears in the composite
// query (free-text query + context signals). This is the "trigger-recall union":
// a trigger-matching entry surfaces even when its lesson text shares little
// vocabulary with the query. Triggers are matched as case-insensitive literal
// substrings — consistent with the existing `anyMatch` directive matcher — so a
// (possibly auto-enriched, attacker-influenceable) trigger cannot smuggle a
// regex engine / ReDoS into the hot retrieval path.
const TRIGGER_RECALL_BOOST = 0.3;
// Minimum normalized trigger length for trigger recall. Triggers are
// attacker-influenceable (auto-enrichment / hive import); a 1–2 char trigger
// substring-matches almost any query and would force-surface a poisoned entry,
// so anything shorter than this is ignored for recall purposes.
const TRIGGER_RECALL_MIN_LEN = 3;
// Defaults mirror KnowledgeConfigSchema.retrieval. The retrieval block is
// `.optional()` purely as a zod-v4 typing workaround, NOT to disable the
// feature, so an omitted block still applies the documented defaults (parity
// with MMR, which already defaults to λ=0.5 via clampLambda).
const DEFAULT_COLD_START_BONUS = 0.08;
const DEFAULT_COLD_START_MAX_AGE_PHASES = 3;
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

/**
 * Age of an entry measured in distinct confirming phases (Change 5 / Task 6.2).
 * A brand-new candidate (no confirmations) is age 0; an entry confirmed across
 * many phases is "established" and no longer eligible for the cold-start
 * exploration bonus. Falls back to the raw confirmation count when phase numbers
 * are absent.
 */
function entryAgePhases(e: {
	confirmed_by?: Array<{ phase_number?: number }>;
}): number {
	const cb = e.confirmed_by;
	if (!Array.isArray(cb) || cb.length === 0) return 0;
	const phases = new Set<number>();
	for (const c of cb) {
		if (typeof c?.phase_number === 'number') phases.add(c.phase_number);
	}
	return phases.size > 0 ? phases.size : cb.length;
}

/** Clamp the MMR lambda to [0,1], default 0.5. */
function clampLambda(v: number | undefined): number {
	if (typeof v !== 'number' || Number.isNaN(v)) return 0.5;
	return Math.min(1, Math.max(0, v));
}

/**
 * Maximal Marginal Relevance rerank (Change 5, Task 6.1). Greedily selects from
 * `pool` to fill up to `max` total (counting the already-selected `pinned`),
 * trading relevance against diversity:
 *   mmr(c) = λ·relevance(c) − (1−λ)·max_{s∈selected} bigram_jaccard(lesson_c, lesson_s)
 * Reuses `jaccardBigram` (no second similarity function). Deterministic: ties
 * break by finalScore, then recency, then id, so a query with uniform paraphrase
 * distance yields a stable order.
 */
function mmrRerank<
	T extends {
		id: string;
		finalScore: number;
		lesson: string;
		created_at: string;
	},
>(pool: T[], pinned: T[], max: number, lambda: number): T[] {
	if (pool.length === 0) return [];
	const bigrams = new Map<string, Set<string>>();
	const bg = (e: T): Set<string> => {
		let s = bigrams.get(e.id);
		if (!s) {
			s = wordBigrams(normalize(e.lesson ?? ''));
			bigrams.set(e.id, s);
		}
		return s;
	};
	const selected: T[] = [...pinned];
	const candidates = [...pool];
	const out: T[] = [];
	// `selected` = pinned ++ picked, so gating on its length counts both toward
	// the max (each pick is pushed to both `out` and `selected`).
	while (selected.length < max && candidates.length > 0) {
		let bestIdx = -1;
		let bestScore = Number.NEGATIVE_INFINITY;
		let best: T | null = null;
		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i];
			let maxSim = 0;
			for (const s of selected) {
				const sim = jaccardBigram(bg(c), bg(s));
				if (sim > maxSim) maxSim = sim;
			}
			const score = lambda * c.finalScore - (1 - lambda) * maxSim;
			if (
				score > bestScore + 1e-9 ||
				(Math.abs(score - bestScore) <= 1e-9 &&
					best !== null &&
					tieBreak(c, best) < 0)
			) {
				bestScore = score;
				bestIdx = i;
				best = c;
			}
		}
		if (bestIdx < 0 || best === null) break;
		out.push(best);
		selected.push(best);
		candidates.splice(bestIdx, 1);
	}
	return out;
}

/** Deterministic tiebreak: higher score, then newer, then lexically smaller id. */
function tieBreak(
	a: { finalScore: number; created_at: string; id: string },
	b: { finalScore: number; created_at: string; id: string },
): number {
	if (Math.abs(a.finalScore - b.finalScore) > 1e-9)
		return b.finalScore - a.finalScore;
	const at = new Date(a.created_at).getTime();
	const bt = new Date(b.created_at).getTime();
	if (at !== bt) return bt - at;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
	// Synonym-expansion trace (Change 5 / Task 6.2). Declared at function scope so
	// the post-scoring event emit (outside the try) can record it.
	let synonymTokens: string[] = [];
	const synonymTrace: Record<string, string[]> = {};
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
		const counterRollups = await readKnowledgeCounterRollups(directory);

		// Tier post-filter (hive-only), quarantined exclusion, and archived exclusion.
		// readMergedKnowledge uses a deny-list (excludes only quarantined); archived
		// entries must also be hidden here.
		candidates = candidates.filter((e) => {
			if (e.status === 'archived') return false;
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

		// Composite recall string (Change 5 / Task 6.2): the free-text query plus
		// the salient context signals. Both trigger recall and synonym expansion
		// run against this, so a context-only injection call benefits from the same
		// recall as an explicit query (the directive scorer only sees context, not
		// the query text — this closes that gap).
		const compositeRaw = [
			queryText,
			context?.taskTitle,
			context?.taskDescription,
			context?.lastUserMessage,
			context?.currentAction,
			...(context?.recentReviewerFailures ?? []),
			...(context?.recentTestFailures ?? []),
			...(context?.recentToolErrors ?? []),
		]
			.filter((s): s is string => typeof s === 'string' && s.length > 0)
			.join(' ');
		const compositeNorm = normalize(compositeRaw);
		const hasComposite = compositeNorm.length > 0;

		// Synonym expansion (Change 5 / Task 6.2): pull the learned tag-co-occurrence
		// synonyms of the composite query terms. Best-effort — a missing/corrupt map
		// degrades to no expansion. coerceSynonymMap re-sanitises every token, so the
		// returned synonyms are control-char-free and length-bounded.
		try {
			if (hasComposite) {
				const synMap = await readSynonymMap(
					directory,
					config.retrieval?.synonym_map_max_pairs,
				);
				const synIndex = buildSynonymIndex(
					synMap,
					config.retrieval?.synonym_min_cooccurrence,
				);
				const baseTokens = compositeNorm.split(' ').filter(Boolean);
				synonymTokens = expandTokens(synIndex, baseTokens);
			}
		} catch {
			synonymTokens = [];
		}
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
			const retrievalOutcomes = effectiveRetrievalOutcomes(
				entry.retrieval_outcomes,
				counterRollups.get(entry.id),
			);
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
				computeOutcomeSignal(retrievalOutcomes) * OUTCOME_RANK_WEIGHT;

			// Cold-start exploration bonus (Change 5 / Task 6.2): a small, bounded
			// lift for never-applied, still-young entries so fresh directives get a
			// chance to surface and prove (or disprove) themselves instead of being
			// permanently out-ranked by entrenched lessons.
			const coldStartBonus =
				(retrievalOutcomes.applied_explicit_count ?? 0) === 0 &&
				entryAgePhases(entry) <
					(config.retrieval?.cold_start_max_age_phases ??
						DEFAULT_COLD_START_MAX_AGE_PHASES)
					? (config.retrieval?.cold_start_bonus ?? DEFAULT_COLD_START_BONUS)
					: 0;

			// Synonym recall (Change 5 / Task 6.2): a single bounded boost if any
			// expanded synonym of a query term appears in the entry's text. Multi-word
			// synonyms (e.g. "module mocks") are matched by substring containment.
			let synonymBoost = 0;
			if (synonymTokens.length > 0) {
				const entryHay = normalize(entryText(entry));
				const matched: string[] = [];
				for (const t of synonymTokens) {
					if (t.length > 0 && entryHay.includes(t)) matched.push(t);
				}
				if (matched.length > 0) {
					synonymBoost = SYNONYM_TEXT_BOOST;
					synonymTrace[entry.id] = matched;
				}
			}

			// Trigger-recall union (Change 5 / Task 6.2): surface an entry whose
			// declared trigger phrase appears in the composite query, even if its
			// lesson text shares little vocabulary with the query. This closes the
			// gap on the query-only path where the directive scorer (which only sees
			// context, not the free-text query) never credits a query-side trigger.
			// Suppressed when `ds.triggerHit` already fired so the same trigger is not
			// double-counted with the (larger, priority-weighted) directive term.
			const triggerRecallHit =
				!ds.triggerHit &&
				hasComposite &&
				Array.isArray(entry.triggers) &&
				entry.triggers.some((tr) => {
					const n = normalize(tr);
					return (
						n.length >= TRIGGER_RECALL_MIN_LEN && compositeNorm.includes(n)
					);
				});
			const triggerRecallBoost = triggerRecallHit ? TRIGGER_RECALL_BOOST : 0;

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
						coldStartBonus +
						synonymBoost +
						triggerRecallBoost +
						(hasQuery ? statusBoost(entry.status) : 0),
				),
			);

			const isCritical =
				entry.directive_priority === 'critical' &&
				(ds.triggerHit || ds.actionHit || ds.agentHit);

			return {
				...entry,
				retrieval_outcomes: retrievalOutcomes,
				finalScore,
				coldStartBoost: coldStartBonus,
				__critical: isCritical,
			};
		});

		// Step 7: rerank. Critical+matching directives are force-included first
		// (in score order). The remaining slots are filled by MMR (Change 5,
		// Task 6.1) so near-paraphrases of the same lesson don't crowd the top-K.
		scored.sort((a, b) => {
			const diff = b.finalScore - a.finalScore;
			if (Math.abs(diff) > 0.001) return diff;
			return (
				new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
			);
		});
		// Critical+matching directives are pinned ahead of the MMR fill, but they
		// are NOT exempt from `max`: they are prioritized *within* the top-K cap.
		// If more critical matches exist than `max`, the lowest-ranked criticals
		// overflow and compete in the MMR pool below like any other entry. This is
		// deterministic and intentional — the result cap is a hard bound.
		const top: Scored[] = [];
		const seen = new Set<string>();
		for (const e of scored) {
			if (top.length >= max) break;
			if (e.__critical && !seen.has(e.id)) {
				top.push(e);
				seen.add(e.id);
			}
		}
		// MMR fill for the non-critical remainder.
		const lambda = clampLambda(config.retrieval?.mmr_lambda);
		const remaining = scored.filter((e) => !seen.has(e.id));
		const selected = mmrRerank(remaining, top, max, lambda);
		for (const e of selected) {
			if (top.length >= max) break;
			if (!seen.has(e.id)) {
				top.push(e);
				seen.add(e.id);
			}
		}

		results = top.map(({ __critical: _c, ...rest }) => rest as RankedEntry);
	} catch (err) {
		warn(
			`[search-knowledge] retrieval failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
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
		// Trace visibility (Change 5 / Task 6.2): record which expanded synonyms, if
		// any, contributed to each surfaced entry so retrieval ranking is auditable.
		const synonymBreakdown: Record<string, string[]> = {};
		for (const e of results) {
			if (synonymTrace[e.id]) synonymBreakdown[e.id] = synonymTrace[e.id];
		}
		const scoreBreakdown =
			synonymTokens.length > 0
				? {
						synonyms_expanded: synonymTokens,
						synonym_matches: synonymBreakdown,
					}
				: undefined;
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
			...(scoreBreakdown ? { score_breakdown: scoreBreakdown } : {}),
		});
	}

	return { trace_id: traceId, results };
}

export const _internals: {
	searchKnowledge: typeof searchKnowledge;
	mmrRerank: typeof mmrRerank;
	clampLambda: typeof clampLambda;
	entryAgePhases: typeof entryAgePhases;
} = {
	searchKnowledge,
	mmrRerank,
	clampLambda,
	entryAgePhases,
};

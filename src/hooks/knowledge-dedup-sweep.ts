/**
 * Active-store near-duplicate dedup sweep (issue #1821 Lane A).
 *
 * The swarm knowledge store accretes near-duplicate lessons: the same insight
 * arrives from a curator pass, a retrospective, and a micro-reflection, each
 * with its own id. The `/swarm link` family migration already merges
 * near-duplicates when two cohort stores are unified, but nothing ever did it
 * for the ACTIVE store of a single worktree. This sweep closes that gap using
 * the SAME merge helpers (`knowledge/entry-merge.ts`), so a lesson merged by a
 * sweep and a lesson merged by a link end up in the same shape.
 *
 * ## Contract
 *
 * - ACTIVE entries only (`candidate` / `established` / `promoted`). Archived and
 *   quarantined entries are neither merge targets nor merge sources.
 * - Bucketed by `category` so the pairwise comparison count is bounded by the
 *   sum of per-category squares rather than the whole store squared, and hard
 *   capped by `learning.dedup_sweep.max_comparisons`.
 * - Deterministic: entries are compared in `id` order and clusters are resolved
 *   in `id` order, so two concurrent sweeps converge on the same winner rather
 *   than racing to different survivors.
 * - All merges plus all loser archivals commit inside ONE `transactKnowledge`
 *   transaction, so a crash cannot leave a loser archived with its evidence
 *   never carried to the winner.
 * - IDEMPOTENT. Losers are archived and only active entries are considered, so
 *   a second sweep over an unchanged store is a no-op. See the CLUSTERING note
 *   below for why that holds transitively, and
 *   `tests/unit/hooks/knowledge-dedup-sweep.test.ts` for the assertion — the
 *   underlying `mergeStoreEntries` is NOT idempotent (it re-merges and doubles
 *   counters on a repeat), so this property is earned here, not inherited.
 *
 * ## CLUSTERING (why a second sweep is a no-op)
 *
 * Near-duplication is not transitive: A~B and B~C does not imply A~C. A greedy
 * "compare against the surviving representative" pass would therefore leave C
 * active next to a winner it is a near-duplicate of, and the NEXT sweep would
 * merge them — the sweep would never reach a fixed point.
 *
 * Instead every in-bucket pair is compared and near-duplicate pairs are unioned
 * into connected components (union-find). Each component elects ONE winner that
 * absorbs every other member. Because the winner's surviving lesson is always
 * one of its own component's member lessons, and no member of one component is
 * a near-duplicate of any member of another (that is exactly what the
 * transitive closure guarantees), the surviving winners are pairwise non-
 * duplicate. The next sweep finds nothing.
 *
 * The only ways a follow-up sweep does more work are the explicit budgets
 * (`max_comparisons`, `max_merges_per_sweep`) — that is bounded progress, not
 * non-convergence.
 *
 * ## Configuration
 *
 * The sweep reads its OWN config via `loadPluginConfigWithMeta(directory)`.
 * `runCuratorPhase`'s 5th parameter is `knowledgeConfig: { directory?: string }`
 * and cannot carry thresholds, and widening that signature would ripple through
 * all three curator entry points. The dynamic `import('../config/index.js')`
 * matches the established hook pattern (`knowledge-curator.ts`,
 * `knowledge-escalator.ts`, `phase-monitor.ts`) and keeps `hooks → config` off
 * the static import graph.
 */

import { mergeEntryFields } from '../knowledge/entry-merge.js';
import * as logger from '../utils/logger.js';
import {
	appendRewriteHistory,
	findNearDuplicate,
	getArchivedKnowledgeIds,
	readKnowledge,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from './knowledge-store.js';
import type {
	KnowledgeEntryBase,
	RewriteHistoryRecord,
} from './knowledge-types.js';
import { validateActionability } from './knowledge-validator.js';
import { writeArchiveTombstoneAndInvalidateSkills } from './skill-invalidator.js';

/** Fallback when no config supplies `knowledge.dedup_threshold`. */
const DEFAULT_DEDUP_THRESHOLD = 0.6;
/** Fallback when no config supplies `learning.dedup_sweep.max_comparisons`. */
const DEFAULT_MAX_COMPARISONS = 2000;
/** Fallback when no config supplies `learning.dedup_sweep.max_merges_per_sweep`. */
const DEFAULT_MAX_MERGES_PER_SWEEP = 10;

/**
 * Statuses a sweep will consider. Archived / quarantined /
 * quarantined_unactionable entries are deliberately excluded: they are already
 * out of retrieval, and re-merging an archived entry would resurrect evidence
 * a curator decision removed.
 */
const ACTIVE_STATUSES: ReadonlySet<KnowledgeEntryBase['status']> = new Set([
	'candidate',
	'established',
	'promoted',
]);

export interface DedupSweepOptions {
	/**
	 * Knowledge-store directory override — the curator's
	 * `knowledgeConfig.directory`. Defaults to `directory`. Audit surfaces
	 * (tombstone events, rewrite history) always use `directory`, matching the
	 * curator's own archive-invalidation call.
	 */
	knowledgeDirectory?: string;
}

/** One applied merge: `loserId` was absorbed into `winnerId` and archived. */
export interface DedupSweepMerge {
	winnerId: string;
	loserId: string;
	category: string;
}

export interface DedupSweepResult {
	/** False when `learning.dedup_sweep.enabled` is off (nothing was read). */
	enabled: boolean;
	/** Number of ACTIVE entries considered. */
	scanned: number;
	/** Pairwise near-duplicate comparisons actually performed. */
	comparisons: number;
	/** True when `max_comparisons` cut the scan short. */
	comparisonBudgetExhausted: boolean;
	/** True when `max_merges_per_sweep` cut the merge set short. */
	mergeBudgetExhausted: boolean;
	/** Merges that actually committed. */
	merges: DedupSweepMerge[];
}

function emptyResult(enabled: boolean): DedupSweepResult {
	return {
		enabled,
		scanned: 0,
		comparisons: 0,
		comparisonBudgetExhausted: false,
		mergeBudgetExhausted: false,
		merges: [],
	};
}

function isActive(entry: KnowledgeEntryBase): boolean {
	return ACTIVE_STATUSES.has(entry.status);
}

/**
 * Evidence mass used as the third winner-selection tiebreak. Counts the
 * outcome signals that represent a real interaction with the entry plus the
 * confirmation records.
 */
function evidenceWeight(entry: KnowledgeEntryBase): number {
	const outcomes = entry.retrieval_outcomes as unknown as
		| Record<string, unknown>
		| undefined;
	let total = 0;
	if (outcomes) {
		for (const key of [
			'shown_count',
			'acknowledged_count',
			'applied_explicit_count',
			'applied_count',
		] as const) {
			const value = outcomes[key];
			if (typeof value === 'number' && Number.isFinite(value)) total += value;
		}
	}
	if (Array.isArray(entry.confirmed_by)) total += entry.confirmed_by.length;
	return total;
}

/**
 * Winner-selection order (negative result ⇒ `a` wins):
 *   1. actionable beats non-actionable — an actionable directive is enforceable
 *      and a non-actionable near-duplicate is not; losing the actionable one
 *      would silently downgrade the store even though `mergeEntryFields` now
 *      carries the predicates across.
 *   2. higher confidence
 *   3. more evidence
 *   4. older `created_at` (the original, not the restatement)
 *   5. lexicographic `id` — a total order, so concurrent sweeps converge.
 */
function compareCandidates(
	a: KnowledgeEntryBase,
	b: KnowledgeEntryBase,
): number {
	const aActionable = validateActionability(a).actionable ? 1 : 0;
	const bActionable = validateActionability(b).actionable ? 1 : 0;
	if (aActionable !== bActionable) return bActionable - aActionable;

	const aConfidence = typeof a.confidence === 'number' ? a.confidence : 0;
	const bConfidence = typeof b.confidence === 'number' ? b.confidence : 0;
	if (aConfidence !== bConfidence) return bConfidence - aConfidence;

	const aEvidence = evidenceWeight(a);
	const bEvidence = evidenceWeight(b);
	if (aEvidence !== bEvidence) return bEvidence - aEvidence;

	const aCreated = a.created_at ?? '';
	const bCreated = b.created_at ?? '';
	if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;

	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return 0;
}

/** Minimal union-find over entry ids. */
function makeUnionFind(): {
	find: (id: string) => string;
	union: (a: string, b: string) => void;
} {
	const parent = new Map<string, string>();
	const find = (id: string): string => {
		let root = parent.get(id) ?? id;
		while (root !== (parent.get(root) ?? root)) {
			root = parent.get(root) ?? root;
		}
		// Path compression.
		let cursor = id;
		while (cursor !== root) {
			const next = parent.get(cursor) ?? cursor;
			parent.set(cursor, root);
			cursor = next;
		}
		return root;
	};
	const union = (a: string, b: string): void => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA === rootB) return;
		// Deterministic root: the lexicographically smaller id.
		if (rootA < rootB) parent.set(rootB, rootA);
		else parent.set(rootA, rootB);
	};
	return { find, union };
}

interface PlannedMerge {
	winner: KnowledgeEntryBase;
	loser: KnowledgeEntryBase;
	category: string;
}

/**
 * Build the merge plan from a read-only snapshot. Pure (no I/O), so it is
 * cheap to reason about and the transaction below only has to re-validate.
 */
function planMerges(
	active: KnowledgeEntryBase[],
	threshold: number,
	maxComparisons: number,
	maxMerges: number,
): {
	plan: PlannedMerge[];
	comparisons: number;
	comparisonBudgetExhausted: boolean;
	mergeBudgetExhausted: boolean;
} {
	const buckets = new Map<string, KnowledgeEntryBase[]>();
	for (const entry of active) {
		const category = typeof entry.category === 'string' ? entry.category : '';
		const bucket = buckets.get(category);
		if (bucket) bucket.push(entry);
		else buckets.set(category, [entry]);
	}

	let comparisons = 0;
	let comparisonBudgetExhausted = false;
	const plan: PlannedMerge[] = [];

	const categories = Array.from(buckets.keys()).sort();
	for (const category of categories) {
		if (comparisonBudgetExhausted) break;
		const bucket = buckets.get(category)!;
		if (bucket.length < 2) continue;
		bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

		const { find, union } = makeUnionFind();
		for (let i = 0; i < bucket.length && !comparisonBudgetExhausted; i++) {
			for (let j = i + 1; j < bucket.length; j++) {
				if (comparisons >= maxComparisons) {
					comparisonBudgetExhausted = true;
					break;
				}
				comparisons++;
				// findNearDuplicate over a single-element array is the same Jaccard
				// bigram comparison the rest of the store uses — reusing it keeps one
				// definition of "near-duplicate" repo-wide.
				if (findNearDuplicate(bucket[i].lesson, [bucket[j]], threshold)) {
					union(bucket[i].id, bucket[j].id);
				}
			}
		}

		// Group by connected component, then elect one winner per component.
		const components = new Map<string, KnowledgeEntryBase[]>();
		for (const entry of bucket) {
			const root = find(entry.id);
			const members = components.get(root);
			if (members) members.push(entry);
			else components.set(root, [entry]);
		}
		for (const root of Array.from(components.keys()).sort()) {
			const members = components.get(root)!;
			if (members.length < 2) continue;
			const ordered = [...members].sort(compareCandidates);
			const winner = ordered[0];
			for (const loser of ordered.slice(1)) {
				plan.push({ winner, loser, category });
			}
		}
	}

	// Apply the merge budget last so the plan is a deterministic prefix of the
	// full plan rather than an arbitrary subset.
	const mergeBudgetExhausted = plan.length > maxMerges;
	return {
		plan: mergeBudgetExhausted ? plan.slice(0, maxMerges) : plan,
		comparisons,
		comparisonBudgetExhausted,
		mergeBudgetExhausted,
	};
}

/**
 * Merge active near-duplicate knowledge entries in `directory`'s swarm store.
 *
 * Never throws: every failure path is logged and returns a result describing
 * what did happen. The caller (`runCuratorPhase`) must never be blocked by a
 * background learning loop.
 */
export async function sweepActiveNearDuplicates(
	directory: string,
	options: DedupSweepOptions = {},
): Promise<DedupSweepResult> {
	const { loadPluginConfigWithMeta } = await import('../config/index.js');
	const { config } = loadPluginConfigWithMeta(directory);
	const sweepConfig = config.learning?.dedup_sweep;
	// Default ON, matching the schema default for `learning.dedup_sweep.enabled`.
	// `learning` itself is `.optional()`, so an absent block means "unconfigured",
	// not "disabled".
	if (sweepConfig?.enabled === false) return emptyResult(false);

	const maxComparisons =
		sweepConfig?.max_comparisons ?? DEFAULT_MAX_COMPARISONS;
	const maxMerges =
		sweepConfig?.max_merges_per_sweep ?? DEFAULT_MAX_MERGES_PER_SWEEP;
	const threshold =
		config.knowledge?.dedup_threshold ?? DEFAULT_DEDUP_THRESHOLD;
	if (maxComparisons <= 0 || maxMerges <= 0) return emptyResult(true);

	const knowledgeDirectory = options.knowledgeDirectory ?? directory;
	const knowledgePath = resolveSwarmKnowledgePath(knowledgeDirectory);

	const snapshot = await readKnowledge<KnowledgeEntryBase>(knowledgePath);
	const active = snapshot.filter(
		(entry) =>
			entry &&
			typeof entry.id === 'string' &&
			typeof entry.lesson === 'string' &&
			isActive(entry),
	);
	const result = emptyResult(true);
	result.scanned = active.length;
	if (active.length < 2) return result;

	const planned = planMerges(active, threshold, maxComparisons, maxMerges);
	result.comparisons = planned.comparisons;
	result.comparisonBudgetExhausted = planned.comparisonBudgetExhausted;
	result.mergeBudgetExhausted = planned.mergeBudgetExhausted;
	if (planned.plan.length === 0) return result;

	// Re-resolve every planned pair by id INSIDE the lock. The snapshot above was
	// read unlocked, so a sibling worktree may have archived or rewritten an
	// entry in between; a stale pair is skipped, never force-merged.
	const applied: DedupSweepMerge[] = [];
	const history: RewriteHistoryRecord[] = [];
	const previousStatuses = new Map<string, KnowledgeEntryBase['status']>();
	const timestamp = new Date().toISOString();

	let committed = false;
	try {
		committed = await transactKnowledge<KnowledgeEntryBase>(
			knowledgePath,
			(current) => {
				applied.length = 0;
				history.length = 0;
				previousStatuses.clear();
				const byId = new Map<string, KnowledgeEntryBase>();
				for (const entry of current) {
					if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
				}
				for (const { winner, loser, category } of planned.plan) {
					const liveWinner = byId.get(winner.id);
					const liveLoser = byId.get(loser.id);
					if (!liveWinner || !liveLoser) continue;
					if (!isActive(liveWinner) || !isActive(liveLoser)) continue;

					const beforeLesson = liveWinner.lesson;
					const beforeRevision = liveWinner.revision ?? 0;
					mergeEntryFields(liveWinner, liveLoser);
					liveWinner.updated_at = timestamp;

					previousStatuses.set(liveLoser.id, liveLoser.status);
					liveLoser.archived_from = liveLoser.status;
					liveLoser.archived_at = timestamp;
					liveLoser.status = 'archived';
					liveLoser.updated_at = timestamp;

					applied.push({
						winnerId: liveWinner.id,
						loserId: liveLoser.id,
						category,
					});
					history.push({
						entry_id: liveWinner.id,
						before_lesson: beforeLesson,
						after_lesson: liveWinner.lesson,
						before_revision: beforeRevision,
						after_revision: liveWinner.revision ?? beforeRevision,
						actor: 'auto',
						reason: `near-duplicate dedup sweep (jaccard >= ${threshold})`,
						evidence_refs: [liveLoser.id],
						timestamp,
						action: 'merge',
					});
				}
				return applied.length > 0 ? current : null;
			},
		);
	} catch (err) {
		logger.warn(
			`[knowledge-dedup-sweep] merge transaction failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return result;
	}

	if (!committed || applied.length === 0) return result;
	result.merges = applied;

	// AFTER commit: tombstone + skill invalidation per archived loser, exactly as
	// the curator's own archive-recommendation path does (curator.ts §G11). The
	// archived-id scan is batched once for the whole set. `sourceLabel` names this
	// sweep so an invalidation warning is attributable; tier/actor/mode match the
	// curator so downstream tombstone consumers see one shape.
	let precomputedArchivedIds: Set<string> | undefined;
	try {
		precomputedArchivedIds = await getArchivedKnowledgeIds(directory);
	} catch {
		// Fall back to a per-entry scan inside the invalidator.
	}
	for (const merge of applied) {
		try {
			await writeArchiveTombstoneAndInvalidateSkills({
				directory,
				entryId: merge.loserId,
				tier: 'swarm',
				actor: 'curator',
				reason: `near-duplicate merged into ${merge.winnerId}`,
				mode: 'archive',
				previousStatus: previousStatuses.get(merge.loserId),
				sourceLabel: 'knowledge-dedup-sweep',
				precomputedArchivedIds,
			});
		} catch (err) {
			logger.warn(
				`[knowledge-dedup-sweep] archive invalidation for '${merge.loserId}' failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	// Immutable before/after audit for each merge. `appendRewriteHistory` is
	// fail-open internally: the mutation already committed and is the source of
	// truth, history is audit.
	for (const record of history) {
		await appendRewriteHistory(directory, record);
	}

	return result;
}

/**
 * Tier-0 pure-function test seam (see `.opencode/skills/writing-tests`). These
 * are deterministic and dependency-free at the I/O boundary, so their tests need
 * no mocks at all — planning, winner selection, and evidence weighting are
 * exercised directly instead of through a temp-directory round trip.
 */
export const _test_exports = {
	compareCandidates,
	evidenceWeight,
	isActive,
	planMerges,
};

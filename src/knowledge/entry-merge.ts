/**
 * Field-level merge helpers for near-duplicate knowledge entries (issue #1821
 * Lane A).
 *
 * Extracted verbatim-in-shape from `family-migration.ts` so the SAME merge
 * semantics back both consumers:
 *  - the cohort family migration (`/swarm link` / `/swarm unlink`), via
 *    `mergeStoreEntries`, and
 *  - the active-store near-duplicate sweep (`hooks/knowledge-dedup-sweep.ts`).
 *
 * A near-duplicate merge is PROVENANCE-PRESERVING, not lossless: the losing
 * entry's id survives in `merged_from`, and every field that represents
 * independently-earned evidence is unioned rather than overwritten. Both sides
 * of a merge are genuine near-duplicates, so a predicate present on only one
 * side was still earned and must survive.
 *
 * ## What this module fixes relative to the pre-#1821 implementation
 *
 * 1. **Actionability carry.** `required_actions`, `forbidden_actions`,
 *    `verification_checks`, `applies_to_agents`, `applies_to_tools`,
 *    `triggers`, and `source_knowledge_ids` were dropped entirely — a merge
 *    could silently turn an actionable directive into an inert lesson. They are
 *    now unioned through `dedupeCapped`.
 * 2. **CAS integrity.** Swapping in the loser's longer lesson without
 *    recomputing `content_hash` left the CAS token describing the DISCARDED
 *    text, so every later authorized curation of a merged entry failed the
 *    `transactKnowledgeWithCas` comparison. The hash is now recomputed and
 *    `revision` bumped on any lesson swap.
 * 3. **No shared arrays.** `unionConfirmedBy` returned a source array BY
 *    REFERENCE when one side was absent, so a surviving winner and an archived
 *    loser shared one mutable array. It always copies now.
 * 4. **Symmetric guards.** `source_refs` and `retrieval_outcomes` required BOTH
 *    sides to be populated before merging, so a sweep over mixed
 *    legacy/enriched entries silently dropped the loser's refs and counters.
 *    The one-sided cases are handled.
 * 5. **Tags are unioned under the SAME bounded rule as their five siblings.**
 *    See `TAG_UNION_RULE` below.
 *
 * ## TAG_UNION_RULE — the one place tags can still be lost, stated explicitly
 *
 * `tags` is a bounded field: the store's write boundary
 * (`normalizeEntryArraysForWrite` in `knowledge-store.ts`) runs `dedupeCapped`
 * over it at `WRITE_FIELD_CAP` = 20 on every transaction, and `knowledge_add`
 * caps its producer at 20 as well. A merge therefore CANNOT promise to preserve
 * every tag from both sides — two entries at the cap carry up to 40 distinct
 * tags and only 20 can survive. Pretending otherwise is what the pre-fix code
 * did: it unioned with a bare, uncapped, case-SENSITIVE `new Set(...)`, and the
 * write boundary then silently truncated the result to the first 20 — which are
 * the WINNER's, because the winner's tags come first in the union. The loser was
 * archived in the same transaction, so the discarded tags were unrecoverable.
 *
 * The rule this module now implements and pins is:
 *
 *   1. Winner tags are retained FIRST, in their existing order.
 *   2. Loser tags fill the remaining slots, in their existing order.
 *   3. Dedup is CASE-INSENSITIVE and first-spelling-wins (`dedupeCapped`), the
 *      same comparison the write boundary uses — so a merge no longer emits a
 *      list the very next write would rewrite.
 *   4. Anything past `MERGE_FIELD_CAP` (20) is DROPPED at merge time, visibly,
 *      instead of being handed to the write boundary to drop invisibly.
 *
 * Consequence, stated so nobody has to rediscover it: a winner already holding
 * 20 tags absorbs ZERO tags from the loser. That is not new data loss — it is
 * the pre-existing store cap, now applied where it can be reasoned about and
 * asserted. Order is the whole lever: if tag retention priority ever needs to
 * change (e.g. prefer a rarer loser tag over a generic winner tag), it changes
 * HERE, in the argument order of the union, not at the write boundary.
 *
 * Pinned by `tests/unit/hooks/knowledge-dedup-sweep-tag-cap.test.ts`.
 *
 * ## What this module deliberately does NOT change
 *
 * `weightedConfidence` reads POST-merge target state (it runs after
 * `unionConfirmedBy` and `sumRetrievalOutcomes` have already mutated `target`),
 * so the source's evidence is counted on both sides of the ratio. That is a
 * real wart, but the formula defines `/swarm link` cohort-merge semantics and
 * changing it is out of scope for #1821 Lane A. It is pinned by
 * `tests/unit/knowledge/entry-merge-characterization-confidence.test.ts`.
 */

import { computeContentHash, dedupeCapped } from '../hooks/knowledge-store.js';
import type {
	KnowledgeEntryBase,
	RetrievalOutcome,
} from '../hooks/knowledge-types.js';

/**
 * Cap applied to unioned actionability arrays. Matches `WRITE_FIELD_CAP` in
 * `knowledge-store.ts`, which normalizes the same fields at the write boundary
 * — merging above the cap would only have the excess silently trimmed on the
 * next transaction anyway.
 */
const MERGE_FIELD_CAP = 20;

/**
 * Cap applied to `source_knowledge_ids`. Deliberately 50, NOT 20.
 *
 * `knowledge-store.ts` excludes this field from `WRITE_NORMALIZED_ARRAY_FIELDS`
 * for a documented reason: its producer (`parseStructuredCuratorBlocks` in
 * `curator.ts`) caps it at FIFTY ids, and `skill-invalidator.ts` walks the full
 * list to retire skills whose source entry was archived — a cap of 20 would
 * silently drop ids and leave those generated skills live. Unioning two
 * near-duplicates at cap 20 would reintroduce exactly that defect, so the merge
 * honours the producer's cap instead.
 */
const MERGE_SOURCE_KNOWLEDGE_ID_CAP = 50;

/**
 * Array fields that represent independently-earned actionability predicates or
 * scope. Both sides of a near-duplicate merge earned theirs separately, so the
 * merge unions rather than picking a winner.
 */
const UNIONED_ACTIONABILITY_FIELDS = [
	'required_actions',
	'forbidden_actions',
	'verification_checks',
	'applies_to_agents',
	'applies_to_tools',
	'triggers',
] as const;

/**
 * Union one loosely-typed string-array field from `src` into `target`.
 *
 * Handles the one-sided cases: an absent side contributes nothing rather than
 * aborting the union. When NEITHER side carries an array the key is left
 * untouched, so a merge never materializes an empty array on an entry that
 * never had the field.
 */
function unionArrayField(
	tAny: Record<string, unknown>,
	sAny: Record<string, unknown>,
	field: string,
	cap: number,
): void {
	const tValue = tAny[field];
	const sValue = sAny[field];
	const tIsArray = Array.isArray(tValue);
	const sIsArray = Array.isArray(sValue);
	if (!tIsArray && !sIsArray) return;
	tAny[field] = dedupeCapped(
		[...(tIsArray ? tValue : []), ...(sIsArray ? sValue : [])],
		{ cap },
	);
}

/** Field-level union of `src` into `target` (mutates target). */
export function mergeEntryFields(
	target: KnowledgeEntryBase,
	src: KnowledgeEntryBase,
): void {
	// Loose-record view for optional/extra fields not on the base type.
	const tAny = target as unknown as Record<string, unknown>;
	const sAny = src as unknown as Record<string, unknown>;
	// confirmed_by: array union by a stable key. Always a fresh array — the
	// winner must never share a mutable array with the entry we are about to
	// archive.
	target.confirmed_by = unionConfirmedBy(target.confirmed_by, src.confirmed_by);
	// tags: same bounded union as every other evidence array (see
	// TAG_UNION_RULE above). A bare `new Set(...)` here produced an UNCAPPED,
	// case-SENSITIVE list that the store's write boundary then silently trimmed
	// to 20 — winner-first, so the loser's tags were the ones discarded and the
	// loser was archived in the same transaction, making the loss permanent.
	unionArrayField(tAny, sAny, 'tags', MERGE_FIELD_CAP);
	// `tags` is REQUIRED on the entry shape (the actionability arrays are
	// optional), and the pre-#1821 union always materialized it. `unionArrayField`
	// deliberately leaves a key untouched when NEITHER side carries an array, so
	// restore that one guarantee for this field only.
	if (!Array.isArray(target.tags)) target.tags = [];
	// source_refs is optional on some shapes; union whichever side has it. A
	// one-sided union is still a union: the loser's refs are evidence the winner
	// inherits, and requiring both sides silently dropped them on mixed
	// legacy/enriched stores.
	const tRefs = tAny.source_refs;
	const sRefs = sAny.source_refs;
	if (Array.isArray(tRefs) || Array.isArray(sRefs)) {
		tAny.source_refs = Array.from(
			new Set([
				...(Array.isArray(tRefs) ? tRefs : []),
				...(Array.isArray(sRefs) ? sRefs : []),
			]),
		);
	}
	// Actionability carry: each side of a near-duplicate pair earned its own
	// predicates and scope tags, so they are unioned rather than overwritten.
	// `dedupeCapped` (never a bare positional cap) keeps the result deduped and
	// bounded — see knowledge-store.ts for why the cap and the dedup are one
	// operation.
	for (const field of UNIONED_ACTIONABILITY_FIELDS) {
		unionArrayField(tAny, sAny, field, MERGE_FIELD_CAP);
	}
	unionArrayField(
		tAny,
		sAny,
		'source_knowledge_ids',
		MERGE_SOURCE_KNOWLEDGE_ID_CAP,
	);
	// directive_priority is a SCALAR, not evidence to union: the surviving entry
	// keeps its own posture. The loser's value is adopted only to fill a gap, so
	// a merge can add enforcement metadata but never downgrade or override it.
	if (
		tAny.directive_priority === undefined &&
		sAny.directive_priority !== undefined
	) {
		tAny.directive_priority = sAny.directive_priority;
	}
	// Retrieval outcomes: sum per-counter fields (these are independent event
	// counts, so summing is correct; we do NOT double-count a single human
	// action because each side's counts come from distinct event logs).
	sumRetrievalOutcomes(target, src);
	// Confidence: evidence-weighted average (weight = outcome count + confirmed_by).
	target.confidence = weightedConfidence(target, src);
	// Preserve the losing entry's id for retraction traceability.
	const mergedFrom = tAny.merged_from;
	const trail: string[] = Array.isArray(mergedFrom) ? [...mergedFrom] : [];
	if (!trail.includes(src.id)) trail.push(src.id);
	tAny.merged_from = trail;
	// created_at: keep the earliest; updated_at: keep the latest.
	if (
		src.created_at &&
		src.created_at < (target.created_at ?? src.created_at)
	) {
		target.created_at = src.created_at;
	}
	if (
		src.updated_at &&
		src.updated_at > (target.updated_at ?? src.updated_at)
	) {
		target.updated_at = src.updated_at;
	}
	// Keep the richer (longer) lesson text.
	if (src.lesson.length > target.lesson.length) {
		// Preserve the original id; only swap the text.
		target.lesson = src.lesson;
		// CAS INTEGRITY: `content_hash` is the compare-and-swap token
		// (`transactKnowledgeWithCas` rejects a mutation whose expected hash does
		// not match). Swapping the lesson without restamping the hash left the
		// token describing the DISCARDED text, so every later authorized curation
		// of a merged entry silently failed CAS. Recompute and bump the revision
		// so the mutation is visible to the CAS contract.
		tAny.content_hash = computeContentHash(target.lesson);
		const revision = tAny.revision;
		tAny.revision =
			(typeof revision === 'number' && Number.isFinite(revision)
				? revision
				: 0) + 1;
	}
}

/**
 * Union two `confirmed_by` lists, deduping on the identifying triple
 * `phase_number|project_name|confirmed_at`.
 *
 * ALWAYS returns a fresh array. The pre-#1821 short-circuits returned an input
 * array by reference, so a surviving winner and the archived loser it absorbed
 * shared one mutable list — a later `push` on either side corrupted the other.
 */
export function unionConfirmedBy(
	a: KnowledgeEntryBase['confirmed_by'],
	b: KnowledgeEntryBase['confirmed_by'],
): KnowledgeEntryBase['confirmed_by'] {
	if (!a) return b ? [...b] : [];
	if (!b) return [...a];
	// Dedup by a composite key of available identifying fields.
	const key = (r: unknown): string => {
		if (!r || typeof r !== 'object') return JSON.stringify(r);
		const o = r as Record<string, unknown>;
		return `${o.phase_number ?? ''}|${o.project_name ?? ''}|${o.confirmed_at ?? ''}`;
	};
	const seen = new Set(a.map(key));
	const merged = [...a];
	for (const rec of b) {
		const k = key(rec);
		if (!seen.has(k)) {
			seen.add(k);
			merged.push(rec);
		}
	}
	return merged;
}

/** Deep-enough copy of a retrieval-outcome record (no shared arrays). */
function cloneRetrievalOutcomes(source: RetrievalOutcome): RetrievalOutcome {
	const copy = { ...source } as RetrievalOutcome;
	if (Array.isArray(source.violation_timestamps)) {
		copy.violation_timestamps = [...source.violation_timestamps];
	}
	return copy;
}

/**
 * Sum `src`'s retrieval counters into `target`'s (mutates target).
 *
 * One-sided cases are real on mixed legacy/enriched stores and are handled:
 * a target with no counters ADOPTS a copy of the source's (a copy, so the
 * winner and the archived loser never share one mutable record), and a source
 * with no counters simply contributes nothing. The pre-#1821 guard bailed
 * unless BOTH sides had counters, silently discarding the loser's evidence.
 */
export function sumRetrievalOutcomes(
	target: KnowledgeEntryBase,
	src: KnowledgeEntryBase,
): void {
	const t = target.retrieval_outcomes;
	const s = src.retrieval_outcomes;
	if (!s) return;
	if (!t) {
		target.retrieval_outcomes = cloneRetrievalOutcomes(s);
		return;
	}
	const tAny = t as unknown as Record<string, unknown>;
	const sAny = s as unknown as Record<string, unknown>;
	const numericKeys = [
		'applied_count',
		'succeeded_after_count',
		'failed_after_count',
		'shown_count',
		'acknowledged_count',
		'applied_explicit_count',
		'ignored_count',
		'violated_count',
		'contradicted_count',
		'n_a_count',
		'succeeded_after_shown_count',
		'failed_after_shown_count',
		'partial_after_shown_count',
	] as const;
	for (const k of numericKeys) {
		const tv = tAny[k];
		const sv = sAny[k];
		if (typeof tv === 'number' || typeof sv === 'number') {
			tAny[k] =
				(typeof tv === 'number' ? tv : 0) + (typeof sv === 'number' ? sv : 0);
		}
	}
	// Timestamps: keep the latest.
	if (
		s.last_applied_at &&
		(!t.last_applied_at || s.last_applied_at > t.last_applied_at)
	) {
		t.last_applied_at = s.last_applied_at;
	}
}

/**
 * Evidence-weighted average of the two confidences.
 *
 * INTENTIONALLY UNCHANGED by #1821 Lane A. It runs AFTER `unionConfirmedBy`
 * and `sumRetrievalOutcomes` have mutated `target`, so `wT` reflects POST-merge
 * state and the source's evidence is counted on both sides of the ratio.
 * Correcting that would change `/swarm link` cohort-merge results, which is out
 * of scope for this issue; the behavior is pinned by the characterization
 * suite.
 */
export function weightedConfidence(
	target: KnowledgeEntryBase,
	src: KnowledgeEntryBase,
): number {
	const weightOf = (e: KnowledgeEntryBase): number => {
		const o = e.retrieval_outcomes as unknown as
			| Record<string, unknown>
			| undefined;
		let n = 0;
		if (o) {
			for (const k of [
				'shown_count',
				'acknowledged_count',
				'applied_explicit_count',
			] as const) {
				const v = o[k];
				if (typeof v === 'number') n += v;
			}
		}
		n += Array.isArray(e.confirmed_by) ? e.confirmed_by.length : 0;
		// Floor so an entry with no evidence still gets a tiny weight.
		return Math.max(n, 0.5);
	};
	const wt = weightOf(target);
	const ws = weightOf(src);
	return (target.confidence * wt + src.confidence * ws) / (wt + ws);
}

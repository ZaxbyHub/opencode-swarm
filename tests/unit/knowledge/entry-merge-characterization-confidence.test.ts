import { describe, expect, test } from 'bun:test';
import { computeContentHash } from '../../../src/hooks/knowledge-store.js';
import type { RetrievalOutcome } from '../../../src/hooks/knowledge-types.js';
import { _internals } from '../../../src/knowledge/family-migration.js';
import {
	entry,
	outcomes,
	phaseRecAt as phaseRec,
} from './_entry-merge-fixtures.js';

/**
 * CHARACTERIZATION tests — part 2 of `entry-merge-characterization.test.ts`
 * (split for the 500-line FR-006 cap). The issue #1821 Lane A fixes that are
 * NOT inverted pins live in `entry-merge-fixes.test.ts`.
 *
 * Covers the evidence-weighted confidence formula and the merge's previously
 * asymmetric guards. `weightedConfidence` is INTENTIONALLY unchanged by #1821
 * (changing it would move `/swarm link` cohort-merge results), so everything in
 * the confidence block below is still a pin on current behavior. The
 * asymmetric-guard and dropped-field blocks were inverted by #1821 and each
 * carries an inline note naming the assertion it replaced.
 *
 * `weightedConfidence` is exercised through the `_internals.mergeEntryFields`
 * seam on `family-migration.ts` — the migration engine's production entry point.
 */

const { mergeEntryFields, mergeStoreEntries } = _internals;

// ---------------------------------------------------------------------------
// weightedConfidence — the exact formula
// ---------------------------------------------------------------------------

describe('mergeEntryFields — evidence-weighted confidence', () => {
	/**
	 * The rule, transcribed from `weightedConfidence`:
	 *   weight(e) = max(0.5,
	 *       (shown_count ?? 0) + (acknowledged_count ?? 0)
	 *     + (applied_explicit_count ?? 0) + confirmed_by.length)
	 *   confidence = (target.confidence * wT + src.confidence * wS) / (wT + wS)
	 *
	 * CRITICAL ORDERING: `weightedConfidence` runs AFTER `unionConfirmedBy` and
	 * AFTER `sumRetrievalOutcomes` have already mutated `target`. So `wT` is
	 * computed from the POST-merge target (union'd confirmed_by, summed
	 * counters), while `wS` is computed from the untouched src. The two weights
	 * are therefore NOT symmetric, and src's evidence is counted twice.
	 */

	test('pins the weighted formula — a plain arithmetic mean would FAIL', () => {
		const target = entry({
			confidence: 0.9,
			confirmed_by: [phaseRec(1)],
			retrieval_outcomes: outcomes({
				shown_count: 3,
				acknowledged_count: 1,
				applied_explicit_count: 0,
			}),
		});
		const src = entry({
			id: 'src-1',
			confidence: 0.2,
			confirmed_by: [phaseRec(2)],
			retrieval_outcomes: outcomes({
				shown_count: 1,
				acknowledged_count: 0,
				applied_explicit_count: 0,
			}),
		});

		mergeEntryFields(target, src);

		// Hand computation:
		//   post-merge target: shown 3+1=4, ack 1+0=1, applied_explicit 0,
		//                      confirmed_by [p1, p2] → len 2
		//   wT = 4 + 1 + 0 + 2                       = 7
		//   wS = 1 + 0 + 0 + 1                       = 2
		//   confidence = (0.9*7 + 0.2*2) / (7 + 2) = 6.7 / 9 = 0.744444...
		expect(target.confidence).toBeCloseTo(0.7444444444444445, 12);

		// Falsifier: a plain arithmetic mean would be 0.55. Assert we are far
		// from it so this test cannot pass under an unweighted implementation.
		const plainMean = (0.9 + 0.2) / 2;
		expect(Math.abs(target.confidence - plainMean)).toBeGreaterThan(0.19);
	});

	test('CHARACTERIZATION: target weight uses POST-merge state (src evidence double-counted)', () => {
		const target = entry({
			confidence: 1.0,
			confirmed_by: [],
			retrieval_outcomes: outcomes({ shown_count: 0 }),
		});
		const src = entry({
			id: 'src-1',
			confidence: 0.0,
			confirmed_by: [phaseRec(2), phaseRec(3)],
			retrieval_outcomes: outcomes({ shown_count: 10 }),
		});

		mergeEntryFields(target, src);

		// Post-merge target: shown 10, confirmed_by len 2 → wT = 12.
		// src (untouched):   shown 10, confirmed_by len 2 → wS = 12.
		// confidence = (1.0*12 + 0.0*12) / 24 = 0.5
		expect(target.confidence).toBeCloseTo(0.5, 12);

		// Had the weights been snapshotted BEFORE the union/sum, wT would have
		// been the 0.5 floor and the result would be 0.5/12.5 = 0.04.
		expect(target.confidence).not.toBeCloseTo(0.04, 6);
	});

	test('zero-evidence entries both fall back to the 0.5 weight floor', () => {
		const target = entry({ confidence: 0.8 });
		const src = entry({ id: 'src-1', confidence: 0.4 });

		mergeEntryFields(target, src);

		// wT = wS = max(0, 0.5) = 0.5 → (0.8*0.5 + 0.4*0.5) / 1.0 = 0.6
		expect(target.confidence).toBeCloseTo(0.6, 12);
	});

	test('only shown/acknowledged/applied_explicit feed the weight — other counters do not', () => {
		const target = entry({
			confidence: 1.0,
			retrieval_outcomes: outcomes({
				ignored_count: 1000,
				violated_count: 1000,
				applied_count: 1000,
				succeeded_after_shown_count: 1000,
			}),
		});
		const src = entry({
			id: 'src-1',
			confidence: 0.0,
			retrieval_outcomes: outcomes({
				ignored_count: 0,
				violated_count: 0,
				applied_count: 0,
				succeeded_after_shown_count: 0,
			}),
		});

		mergeEntryFields(target, src);

		// None of those counters are in the weight set, so both sides floor at
		// 0.5 → (1.0*0.5 + 0.0*0.5) / 1.0 = 0.5.
		expect(target.confidence).toBeCloseTo(0.5, 12);
	});

	test('missing retrieval_outcomes on BOTH sides still yields a defined confidence', () => {
		const target = entry({
			confidence: 0.7,
			retrieval_outcomes: undefined,
			confirmed_by: [phaseRec(1), phaseRec(2), phaseRec(3)],
		});
		const src = entry({
			id: 'src-1',
			confidence: 0.1,
			retrieval_outcomes: undefined,
			confirmed_by: [phaseRec(4)],
		});

		mergeEntryFields(target, src);

		// wT = 0 + 4 (union'd confirmed_by) = 4; wS = 0 + 1 = 1
		// (0.7*4 + 0.1*1) / 5 = 2.9 / 5 = 0.58
		expect(target.confidence).toBeCloseTo(0.58, 12);
	});
});

// ---------------------------------------------------------------------------
// Non-idempotency
// ---------------------------------------------------------------------------

describe('mergeEntryFields — repeat merges compound', () => {
	test('CHARACTERIZATION: merging the same src twice double-sums counters', () => {
		const target = entry({ retrieval_outcomes: outcomes({ shown_count: 0 }) });
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes({ shown_count: 5 }),
		});

		mergeEntryFields(target, src);
		expect((target.retrieval_outcomes as RetrievalOutcome).shown_count).toBe(5);

		mergeEntryFields(target, src);
		expect((target.retrieval_outcomes as RetrievalOutcome).shown_count).toBe(
			10,
		);
	});

	test('CHARACTERIZATION: a re-run of mergeStoreEntries re-merges the same near-dup', () => {
		// `merged_from` records the loser id, but `mergeStoreEntries` only skips on
		// exact id match, so on a retry the same source entry is merged again and
		// counters compound. `merged_from` itself stays deduped.
		const dest = entry({
			id: 'dest-1',
			retrieval_outcomes: outcomes({ shown_count: 0 }),
		});
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes({ shown_count: 5 }),
		});

		const first = mergeStoreEntries([dest], [src]);
		const second = mergeStoreEntries(first.merged, [src]);

		expect(second.merged).toHaveLength(1);
		expect(
			(second.merged[0].retrieval_outcomes as RetrievalOutcome).shown_count,
		).toBe(10);
		expect(
			(second.merged[0] as unknown as Record<string, unknown>).merged_from,
		).toEqual(['src-1']);
	});
});

// ---------------------------------------------------------------------------
// Guards that used to silently drop one side (issue #1821 inverted these pins)
// ---------------------------------------------------------------------------

describe('mergeEntryFields — formerly asymmetric guards (#1821 made them symmetric)', () => {
	test('source_refs present on BOTH sides are unioned (unchanged by #1821)', () => {
		const target = entry({ source_refs: ['a.ts:1', 'b.ts:2'] });
		const src = entry({ id: 'src-1', source_refs: ['b.ts:2', 'c.ts:3'] });

		mergeEntryFields(target, src);

		expect(target.source_refs).toEqual(['a.ts:1', 'b.ts:2', 'c.ts:3']);
	});

	test('src-only source_refs are CARRIED, not dropped (issue #1821)', () => {
		// Was pinned as `toBeUndefined()`. The guard was
		// `if (Array.isArray(tRefs) && Array.isArray(sRefs))`, so a target with no
		// array skipped the whole union and the loser's refs vanished — a real
		// loss on a store mixing legacy and enriched entries. #1821 unions
		// whichever side has an array.
		const target = entry({ source_refs: undefined });
		const src = entry({ id: 'src-1', source_refs: ['only-src.ts:9'] });

		mergeEntryFields(target, src);

		expect(target.source_refs).toEqual(['only-src.ts:9']);
	});

	test('target-only source_refs are preserved unchanged', () => {
		const target = entry({ source_refs: ['only-target.ts:1'] });
		const src = entry({ id: 'src-1', source_refs: undefined });

		mergeEntryFields(target, src);

		expect(target.source_refs).toEqual(['only-target.ts:1']);
	});

	test('src-only retrieval_outcomes are ADOPTED, not dropped (issue #1821)', () => {
		// Was pinned as `toBeUndefined()`: `sumRetrievalOutcomes` bailed on
		// `if (!t || !s) return;`, so the loser's entire counter record was
		// discarded. #1821 adopts a COPY (a copy, so the winner and the archived
		// loser never share one mutable record).
		const srcOutcomes = outcomes({ shown_count: 42, applied_count: 7 });
		const target = entry({ retrieval_outcomes: undefined });
		const src = entry({ id: 'src-1', retrieval_outcomes: srcOutcomes });

		mergeEntryFields(target, src);

		expect(target.retrieval_outcomes).toEqual(srcOutcomes);
		expect(target.retrieval_outcomes).not.toBe(srcOutcomes);
	});

	test('target-only retrieval_outcomes are untouched (src has nothing to add)', () => {
		// Not an inverted pin — with no src counters there is nothing to sum, so
		// this stays the correct outcome after #1821. Kept as the symmetric
		// partner of the src-only case above.
		const target = entry({
			retrieval_outcomes: outcomes({ shown_count: 3, applied_count: 2 }),
		});
		const src = entry({ id: 'src-1', retrieval_outcomes: undefined });

		mergeEntryFields(target, src);

		expect(target.retrieval_outcomes).toEqual(
			outcomes({ shown_count: 3, applied_count: 2 }),
		);
	});
});

// ---------------------------------------------------------------------------
// Fields the merge used to drop silently (issue #1821 inverted these pins)
// ---------------------------------------------------------------------------

describe('mergeEntryFields — actionability carry and CAS integrity', () => {
	const ACTIONABILITY_FIELDS = [
		'required_actions',
		'forbidden_actions',
		'verification_checks',
		'applies_to_agents',
		'applies_to_tools',
		'triggers',
	] as const;

	test('src-only actionability fields are CARRIED over (issue #1821)', () => {
		// Was pinned as `expect(target[f]).toBeUndefined()` for all six fields:
		// the merge handled none of them, so absorbing a near-duplicate could turn
		// an enforceable directive into an inert lesson. #1821 unions them.
		const srcFields: Record<string, string[]> = {};
		for (const f of ACTIONABILITY_FIELDS) srcFields[f] = [`src-${f}`];
		const target = entry();
		const src = entry({ id: 'src-1', ...srcFields });

		mergeEntryFields(target, src);

		// Non-vacuity guard: the merge really ran and src was not mutated.
		expect(target.merged_from).toEqual(['src-1']);
		for (const f of ACTIONABILITY_FIELDS) {
			expect(src[f]).toEqual([`src-${f}`]);
			expect(target[f]).toEqual([`src-${f}`]);
			expect(target[f]).not.toBe(src[f]);
		}
	});

	test('actionability fields present on BOTH sides are UNIONED (issue #1821)', () => {
		// Was pinned as target-only (`['t-action']` etc.). Both sides of a
		// near-duplicate independently earned their predicates, so the union is
		// the provenance-preserving answer; target order first, then src.
		const target = entry({
			required_actions: ['t-action'],
			forbidden_actions: ['t-forbidden'],
			verification_checks: ['t-check'],
			applies_to_agents: ['t-agent'],
			applies_to_tools: ['t-tool'],
		});
		const src = entry({
			id: 'src-1',
			required_actions: ['s-action'],
			forbidden_actions: ['s-forbidden'],
			verification_checks: ['s-check'],
			applies_to_agents: ['s-agent'],
			applies_to_tools: ['s-tool'],
		});

		mergeEntryFields(target, src);

		expect(target.required_actions).toEqual(['t-action', 's-action']);
		expect(target.forbidden_actions).toEqual(['t-forbidden', 's-forbidden']);
		expect(target.verification_checks).toEqual(['t-check', 's-check']);
		expect(target.applies_to_agents).toEqual(['t-agent', 's-agent']);
		expect(target.applies_to_tools).toEqual(['t-tool', 's-tool']);
	});

	test('source_knowledge_ids are UNIONED (issue #1821)', () => {
		// Was pinned as `['k-1']`. Capped at 50, not 20: knowledge-store.ts
		// excludes this field from its 20-cap because the producer caps at FIFTY
		// and skill-invalidator walks the full list — a 20-cap here would silently
		// orphan generated skills.
		const target = entry({ source_knowledge_ids: ['k-1'] });
		const src = entry({ id: 'src-1', source_knowledge_ids: ['k-2'] });

		mergeEntryFields(target, src);

		expect(target.source_knowledge_ids).toEqual(['k-1', 'k-2']);
	});

	test('content_hash is RECOMPUTED when the lesson is swapped (issue #1821)', () => {
		// Was pinned as `toBe('aaaaaaaaaaaa')` — the stale hash of the DISCARDED
		// text. `content_hash` is the CAS token `transactKnowledgeWithCas`
		// compares against, so every later authorized curation of a merged entry
		// silently failed CAS. Now restamped from the surviving lesson.
		const target = entry({
			lesson: 'short lesson',
			content_hash: 'aaaaaaaaaaaa',
		});
		const src = entry({
			id: 'src-1',
			lesson: 'a considerably longer and richer lesson text',
			content_hash: 'bbbbbbbbbbbb',
		});

		mergeEntryFields(target, src);

		expect(target.lesson).toBe('a considerably longer and richer lesson text');
		expect(target.content_hash).toBe(
			computeContentHash('a considerably longer and richer lesson text'),
		);
		expect(target.content_hash).not.toBe('aaaaaaaaaaaa');
	});

	test('revision is NOT bumped when the lesson is unchanged', () => {
		// Still the pinned outcome after #1821: both lessons are equal length, so
		// no swap happens and the CAS revision must not move. The original pin's
		// label ("revision is NOT bumped by the merge") was too broad — the swap
		// case now bumps, see `entry-merge-fixes.test.ts`.
		const target = entry({ revision: 3 });
		const src = entry({ id: 'src-1', revision: 7 });

		mergeEntryFields(target, src);

		expect(target.revision).toBe(3);
	});

	test('CHARACTERIZATION: status / category / scope / producer are untouched by the merge', () => {
		const target = entry({
			status: 'candidate',
			category: 'testing',
			scope: 'global',
			producer: null,
		});
		const src = entry({
			id: 'src-1',
			status: 'promoted',
			category: 'security',
			scope: 'stack:bun',
			producer: { cohort_id: 'c', worktree_id: 'w' },
		});

		mergeEntryFields(target, src);

		expect(target.status).toBe('candidate');
		expect(target.category).toBe('testing');
		expect(target.scope).toBe('global');
		expect(target.producer).toBeNull();
	});
});

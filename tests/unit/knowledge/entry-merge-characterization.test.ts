import { describe, expect, test } from 'bun:test';
import type {
	PhaseConfirmationRecord,
	RetrievalOutcome,
} from '../../../src/hooks/knowledge-types.js';
import { _internals } from '../../../src/knowledge/family-migration.js';
import {
	ALL_COUNTERS,
	entry,
	outcomes,
	phaseRec,
} from './_entry-merge-fixtures.js';

/**
 * CHARACTERIZATION tests for the knowledge-entry merge helpers. Split across
 * three files for the 500-line FR-006 cap: confidence weighting and asymmetric
 * guards in `entry-merge-characterization-confidence.test.ts`, the issue #1821
 * Lane A fixes in `entry-merge-fixes.test.ts`.
 *
 * These pin observable merge behavior so a change is a deliberate, visible diff.
 * `CHARACTERIZATION:` means "known wart, pinned deliberately", not an
 * endorsement. Issue #1821 Lane A moved the helpers into
 * `src/knowledge/entry-merge.ts` and fixed the data-destroying ones; every
 * assertion it inverted carries an inline note naming the old pin.
 *
 * Reachability: everything below drives the helpers through
 * `_internals.mergeEntryFields` / `_internals.mergeStoreEntries` on
 * `src/knowledge/family-migration.ts`. Testing through that seam (rather than
 * importing `entry-merge.ts`) is what proves `/swarm link` still routes to the
 * fixed helpers after the extraction.
 */

const { mergeEntryFields, mergeStoreEntries } = _internals;

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

describe('mergeEntryFields — tags', () => {
	test('unions and dedups, target order first then new src tags', () => {
		const targetTags = ['b', 'a'];
		const srcTags = ['a', 'c'];
		const target = entry({ tags: targetTags });
		const src = entry({ id: 'src-1', tags: srcTags });

		mergeEntryFields(target, src);

		// Set insertion order: target's tags in their original order, then only
		// the src tags not already present. Always a fresh array (never aliased).
		expect(target.tags).toEqual(['b', 'a', 'c']);
		expect(target.tags).not.toBe(targetTags);
		expect(target.tags).not.toBe(srcTags);
	});

	test('undefined tags on either side are coalesced to empty', () => {
		const target = entry({ tags: undefined });
		const src = entry({ id: 'src-1', tags: ['only'] });

		mergeEntryFields(target, src);

		expect(target.tags).toEqual(['only']);
	});
});

// ---------------------------------------------------------------------------
// confirmed_by (unionConfirmedBy)
// ---------------------------------------------------------------------------

describe('mergeEntryFields — confirmed_by union', () => {
	test('distinct records are concatenated target-first', () => {
		const target = entry({ confirmed_by: [phaseRec({ phase_number: 1 })] });
		const src = entry({
			id: 'src-1',
			confirmed_by: [phaseRec({ phase_number: 2 })],
		});

		mergeEntryFields(target, src);

		expect(target.confirmed_by).toHaveLength(2);
		expect(
			(target.confirmed_by as PhaseConfirmationRecord[]).map(
				(r) => r.phase_number,
			),
		).toEqual([1, 2]);
	});

	test('DEDUP BRANCH: identical phase_number|project_name|confirmed_at collapse to one', () => {
		// Dedup key is exactly `${phase_number}|${project_name}|${confirmed_at}`.
		const shared = {
			phase_number: 7,
			project_name: 'proj',
			confirmed_at: '2026-02-02T00:00:00.000Z',
		};
		const target = entry({ confirmed_by: [phaseRec(shared)] });
		const src = entry({ id: 'src-1', confirmed_by: [phaseRec(shared)] });

		mergeEntryFields(target, src);

		expect(target.confirmed_by).toHaveLength(1);
		expect((target.confirmed_by as PhaseConfirmationRecord[])[0]).toEqual(
			phaseRec(shared),
		);
	});

	test('DEDUP BRANCH: records differing ONLY outside the key collapse; target wins', () => {
		// CHARACTERIZATION: `cohort_id` is not part of the dedup key, so a src
		// record carrying extra provenance is dropped when the keyed triple
		// matches. Today's behavior; not an endorsement.
		const keyed = phaseRec({ phase_number: 3 });
		const target = entry({ confirmed_by: [keyed] });
		const src = entry({
			id: 'src-1',
			confirmed_by: [{ ...keyed, cohort_id: 'cohort-abc' }],
		});

		mergeEntryFields(target, src);

		expect(target.confirmed_by).toHaveLength(1);
		expect(
			(target.confirmed_by as Array<Record<string, unknown>>)[0].cohort_id,
		).toBeUndefined();
	});

	test('partial dedup: only the colliding record is dropped', () => {
		const target = entry({ confirmed_by: [phaseRec({ phase_number: 1 })] });
		const src = entry({
			id: 'src-1',
			confirmed_by: [
				phaseRec({ phase_number: 1 }),
				phaseRec({ phase_number: 9 }),
			],
		});

		mergeEntryFields(target, src);

		expect(
			(target.confirmed_by as PhaseConfirmationRecord[]).map(
				(r) => r.phase_number,
			),
		).toEqual([1, 9]);
	});

	test('undefined target confirmed_by COPIES the src array (issue #1821)', () => {
		// Was pinned as `toBe(srcConfirmed)`: `unionConfirmedBy` short-circuited
		// `if (!a) return b ?? []` and handed back the SOURCE array by reference,
		// so a surviving winner and the loser it absorbed shared one mutable list
		// — a later push on either corrupted the other. #1821 always copies.
		const srcConfirmed = [phaseRec({ phase_number: 4 })];
		const target = entry({ confirmed_by: undefined });
		const src = entry({ id: 'src-1', confirmed_by: srcConfirmed });

		mergeEntryFields(target, src);

		expect(target.confirmed_by).toEqual(srcConfirmed);
		expect(target.confirmed_by).not.toBe(srcConfirmed);
		// Falsifier: mutating the winner must not reach the archived loser.
		(target.confirmed_by as PhaseConfirmationRecord[]).push(
			phaseRec({ phase_number: 99 }),
		);
		expect(srcConfirmed).toHaveLength(1);
	});

	test('undefined src confirmed_by COPIES the target array (issue #1821)', () => {
		// Was pinned as `toBe(targetConfirmed)`. `unionConfirmedBy` copies on BOTH
		// short-circuits now, so the merge always publishes a fresh array
		// (matching `tags`) and no caller keeps a live handle into the winner.
		const targetConfirmed = [phaseRec({ phase_number: 5 })];
		const target = entry({ confirmed_by: targetConfirmed });
		const src = entry({ id: 'src-1', confirmed_by: undefined });

		mergeEntryFields(target, src);

		expect(target.confirmed_by).toEqual(targetConfirmed);
		expect(target.confirmed_by).not.toBe(targetConfirmed);
	});
});

// ---------------------------------------------------------------------------
// retrieval_outcomes (sumRetrievalOutcomes)
// ---------------------------------------------------------------------------

describe('mergeEntryFields — retrieval_outcomes counters', () => {
	test('all 13 summed counters add correctly', () => {
		const targetCounts: Record<string, number> = {};
		const srcCounts: Record<string, number> = {};
		ALL_COUNTERS.forEach((k, i) => {
			targetCounts[k] = i + 1; // 1..13
			srcCounts[k] = (i + 1) * 100; // 100..1300
		});

		const target = entry({ retrieval_outcomes: outcomes(targetCounts) });
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes(srcCounts),
		});

		mergeEntryFields(target, src);

		const merged = target.retrieval_outcomes as unknown as Record<
			string,
			number
		>;
		ALL_COUNTERS.forEach((k, i) => {
			expect(merged[k]).toBe((i + 1) * 101);
		});
		// Explicit spot-checks so the loop above cannot silently pass empty.
		expect(merged.applied_count).toBe(101);
		expect(merged.n_a_count).toBe(1010);
		expect(merged.partial_after_shown_count).toBe(1313);
	});

	test('a counter present on only ONE side is written using 0 for the missing side', () => {
		const target = entry({
			retrieval_outcomes: outcomes({ ignored_count: 3 }),
		});
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes({ violated_count: 4 }),
		});

		mergeEntryFields(target, src);

		const merged = target.retrieval_outcomes as unknown as Record<
			string,
			number
		>;
		expect(merged.ignored_count).toBe(3);
		expect(merged.violated_count).toBe(4);
	});

	test('a counter absent on BOTH sides stays absent (key is not created)', () => {
		const target = entry({ retrieval_outcomes: outcomes() });
		const src = entry({ id: 'src-1', retrieval_outcomes: outcomes() });

		mergeEntryFields(target, src);

		expect('shown_count' in target.retrieval_outcomes).toBe(false);
		expect('contradicted_count' in target.retrieval_outcomes).toBe(false);
	});

	test('src retrieval_outcomes are NOT mutated by the sum', () => {
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes({ shown_count: 5 }),
		});
		const target = entry({ retrieval_outcomes: outcomes({ shown_count: 2 }) });

		mergeEntryFields(target, src);

		expect((src.retrieval_outcomes as RetrievalOutcome).shown_count).toBe(5);
	});

	test('CHARACTERIZATION: violation_timestamps are NOT unioned — target value is kept', () => {
		const target = entry({
			retrieval_outcomes: outcomes({ violation_timestamps: ['t-target'] }),
		});
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes({ violation_timestamps: ['t-src'] }),
		});

		mergeEntryFields(target, src);

		expect(
			(target.retrieval_outcomes as RetrievalOutcome).violation_timestamps,
		).toEqual(['t-target']);
	});
});

describe('mergeEntryFields — last_applied_at', () => {
	function mergeApplied(
		t: string | undefined,
		s: string | undefined,
	): string | undefined {
		const target = entry({
			retrieval_outcomes: outcomes(t ? { last_applied_at: t } : {}),
		});
		const src = entry({
			id: 'src-1',
			retrieval_outcomes: outcomes(s ? { last_applied_at: s } : {}),
		});
		mergeEntryFields(target, src);
		return (target.retrieval_outcomes as RetrievalOutcome).last_applied_at;
	}

	// Comparison is a plain lexicographic string compare, so short ISO dates
	// exercise the same branches as full timestamps.
	test('keeps the latest (src newer wins)', () => {
		expect(mergeApplied('2026-01-01', '2026-06-01')).toBe('2026-06-01');
	});

	test('keeps the latest (target newer is preserved)', () => {
		expect(mergeApplied('2026-06-01', '2026-01-01')).toBe('2026-06-01');
	});

	test('absent on target adopts the src timestamp', () => {
		expect(mergeApplied(undefined, '2026-04-01')).toBe('2026-04-01');
	});

	test('absent on src leaves the target timestamp untouched', () => {
		expect(mergeApplied('2026-04-01', undefined)).toBe('2026-04-01');
	});
});

// ---------------------------------------------------------------------------
// merged_from, timestamps, lesson
// ---------------------------------------------------------------------------

describe('mergeEntryFields — merged_from provenance trail', () => {
	test('appends the losing id and does not duplicate on a repeat merge', () => {
		const target = entry();
		const src = entry({ id: 'src-1' });

		mergeEntryFields(target, src);
		expect(target.merged_from).toEqual(['src-1']);

		mergeEntryFields(target, src);
		expect(target.merged_from).toEqual(['src-1']);
	});

	test('appends a second distinct loser id in order; target id never changes', () => {
		const target = entry({ id: 'keep-me' });
		mergeEntryFields(target, entry({ id: 'src-1' }));
		mergeEntryFields(target, entry({ id: 'src-2' }));

		expect(target.merged_from).toEqual(['src-1', 'src-2']);
		expect(target.id).toBe('keep-me');
	});

	test('a non-array pre-existing merged_from is discarded, not preserved', () => {
		// CHARACTERIZATION: the code does `Array.isArray(mergedFrom) ? [...] : []`,
		// so a corrupt scalar value is silently replaced.
		const target = entry({ merged_from: 'not-an-array' });

		mergeEntryFields(target, entry({ id: 'src-1' }));

		expect(target.merged_from).toEqual(['src-1']);
	});
});

describe('mergeEntryFields — created_at / updated_at', () => {
	test('keeps the earliest created_at and the latest updated_at', () => {
		const target = entry({
			created_at: '2026-03-01T00:00:00.000Z',
			updated_at: '2026-03-01T00:00:00.000Z',
		});
		const src = entry({
			id: 'src-1',
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-06-01T00:00:00.000Z',
		});

		mergeEntryFields(target, src);

		expect(target.created_at).toBe('2026-01-01T00:00:00.000Z');
		expect(target.updated_at).toBe('2026-06-01T00:00:00.000Z');
	});

	test('target timestamps survive when src is newer-created / older-updated', () => {
		const target = entry({
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-06-01T00:00:00.000Z',
		});
		const src = entry({
			id: 'src-1',
			created_at: '2026-03-01T00:00:00.000Z',
			updated_at: '2026-03-01T00:00:00.000Z',
		});

		mergeEntryFields(target, src);

		expect(target.created_at).toBe('2026-01-01T00:00:00.000Z');
		expect(target.updated_at).toBe('2026-06-01T00:00:00.000Z');
	});

	test('CHARACTERIZATION: updated_at is NOT stamped to merge time', () => {
		// A merge leaves updated_at at the max of the two inputs — a consumer
		// cannot tell the entry was merged from updated_at alone. (The dedup
		// sweep stamps it separately, at the transaction boundary.)
		const target = entry({ updated_at: '2026-01-01T00:00:00.000Z' });
		const src = entry({ id: 'src-1', updated_at: '2026-01-01T00:00:00.000Z' });

		mergeEntryFields(target, src);

		expect(target.updated_at).toBe('2026-01-01T00:00:00.000Z');
	});
});

describe('mergeEntryFields — lesson text', () => {
	test('a strictly longer src lesson replaces the target lesson', () => {
		const target = entry({ lesson: 'short lesson' });
		const src = entry({
			id: 'src-1',
			lesson: 'a considerably longer and richer lesson text',
		});

		mergeEntryFields(target, src);

		expect(target.lesson).toBe('a considerably longer and richer lesson text');
	});

	test('a shorter src lesson does not replace the target lesson', () => {
		const target = entry({ lesson: 'a considerably longer lesson text' });
		const src = entry({ id: 'src-1', lesson: 'short' });

		mergeEntryFields(target, src);

		expect(target.lesson).toBe('a considerably longer lesson text');
	});

	test('an equal-length src lesson does not replace (strict > only)', () => {
		const target = entry({ lesson: 'aaaaa' });
		const src = entry({ id: 'src-1', lesson: 'bbbbb' });

		mergeEntryFields(target, src);

		expect(target.lesson).toBe('aaaaa');
	});
});

// ---------------------------------------------------------------------------
// mergeStoreEntries reachability (the only production caller of the helpers)
// ---------------------------------------------------------------------------

describe('mergeStoreEntries — reachability of mergeEntryFields', () => {
	test('near-duplicate lesson routes through mergeEntryFields (union, not append)', () => {
		const dest = entry({ id: 'dest-1', tags: ['keep'] });
		const src = entry({ id: 'src-1', tags: ['new'] });

		const r = mergeStoreEntries([dest], [src]);

		expect(r.merged).toHaveLength(1);
		expect(r.added).toBe(0);
		expect(r.skipped).toBe(1);
		expect(r.merged[0].tags).toEqual(['keep', 'new']);
		expect(
			(r.merged[0] as unknown as Record<string, unknown>).merged_from,
		).toEqual(['src-1']);
	});

	test('exact id match skips WITHOUT invoking the field merge', () => {
		const dest = entry({ id: 'same', tags: ['keep'] });
		const src = entry({ id: 'same', tags: ['new'] });

		const r = mergeStoreEntries([dest], [src]);

		expect(r.merged).toHaveLength(1);
		expect(r.skipped).toBe(1);
		expect(r.merged[0].tags).toEqual(['keep']);
		expect(
			(r.merged[0] as unknown as Record<string, unknown>).merged_from,
		).toBeUndefined();
	});
});

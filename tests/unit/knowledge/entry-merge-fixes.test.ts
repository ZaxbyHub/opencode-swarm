import { describe, expect, test } from 'bun:test';
import { computeContentHash } from '../../../src/hooks/knowledge-store.js';
import type {
	PhaseConfirmationRecord,
	RetrievalOutcome,
} from '../../../src/hooks/knowledge-types.js';
import {
	mergeEntryFields,
	sumRetrievalOutcomes,
	unionConfirmedBy,
	weightedConfidence,
} from '../../../src/knowledge/entry-merge.js';
import { _internals } from '../../../src/knowledge/family-migration.js';
import { entry, outcomes, phaseRec } from './_entry-merge-fixtures.js';

/**
 * Issue #1821 Lane A — behavior the merge fix ADDS, tested against the new
 * `src/knowledge/entry-merge.ts` module directly. Assertions that INVERT a
 * pre-existing characterization pin stay in
 * `entry-merge-characterization{,-confidence}.test.ts`, where the pin they
 * replaced is documented; this file holds the cases that had no prior pin plus
 * the extraction-seam proof.
 */

// ---------------------------------------------------------------------------
// Extraction seam — family-migration must keep routing through entry-merge
// ---------------------------------------------------------------------------

describe('entry-merge extraction seam', () => {
	test('family-migration._internals.mergeEntryFields IS the extracted helper', () => {
		// AGENTS.md invariant 7: two existing characterization suites reach the
		// helpers only through this `_internals` seam. If the extraction had left
		// a second copy behind, the suites would silently test dead code.
		expect(_internals.mergeEntryFields).toBe(mergeEntryFields);
	});

	test('the helpers are individually importable (no longer module-private)', () => {
		expect(typeof unionConfirmedBy).toBe('function');
		expect(typeof sumRetrievalOutcomes).toBe('function');
		expect(typeof weightedConfidence).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// unionConfirmedBy — no shared arrays, directly
// ---------------------------------------------------------------------------

describe('unionConfirmedBy — never returns an input by reference', () => {
	test('both short-circuits and the merge path return fresh arrays', () => {
		const a: PhaseConfirmationRecord[] = [phaseRec({ phase_number: 1 })];
		const b: PhaseConfirmationRecord[] = [phaseRec({ phase_number: 2 })];

		expect(unionConfirmedBy(undefined, b)).not.toBe(b);
		expect(unionConfirmedBy(a, undefined)).not.toBe(a);
		const merged = unionConfirmedBy(a, b);
		expect(merged).not.toBe(a);
		expect(merged).not.toBe(b);
		expect(merged).toHaveLength(2);
	});

	test('both sides undefined yields a fresh empty array', () => {
		const first = unionConfirmedBy(undefined, undefined);
		const second = unionConfirmedBy(undefined, undefined);
		expect(first).toEqual([]);
		expect(first).not.toBe(second);
	});

	test('a merged entry shares no confirmed_by array with the loser', () => {
		const srcConfirmed = [phaseRec({ phase_number: 4 })];
		const target = entry({ confirmed_by: undefined });
		const src = entry({ id: 'src-1', confirmed_by: srcConfirmed });

		mergeEntryFields(target, src);
		(target.confirmed_by as PhaseConfirmationRecord[]).push(
			phaseRec({ phase_number: 9 }),
		);

		expect(src.confirmed_by).toHaveLength(1);
		expect(srcConfirmed).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Asymmetric guards — the no-op cases
// ---------------------------------------------------------------------------

describe('mergeEntryFields — one-sided field cases', () => {
	test('neither side has source_refs: the key is never materialized', () => {
		// `entry()` must be called with NO source_refs override — passing
		// `{ source_refs: undefined }` would spread the key into existence and
		// make `in` vacuously true.
		const target = entry();
		const src = entry({ id: 'src-1' });

		mergeEntryFields(target, src);

		expect('source_refs' in target).toBe(false);
	});

	test('an adopted retrieval_outcomes record is a COPY, arrays included', () => {
		const srcOutcomes = outcomes({
			shown_count: 4,
			violation_timestamps: ['2026-01-01T00:00:00.000Z'],
		});
		const target = entry({ retrieval_outcomes: undefined });
		const src = entry({ id: 'src-1', retrieval_outcomes: srcOutcomes });

		mergeEntryFields(target, src);

		const adopted = target.retrieval_outcomes as RetrievalOutcome;
		expect(adopted).not.toBe(srcOutcomes);
		expect(adopted.violation_timestamps).not.toBe(
			srcOutcomes.violation_timestamps,
		);
		expect(adopted.shown_count).toBe(4);
		// Falsifier: mutating the winner must not reach the archived loser.
		adopted.shown_count = 999;
		expect(srcOutcomes.shown_count).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Actionability carry — dedupe, cap, and the scalar
// ---------------------------------------------------------------------------

describe('mergeEntryFields — actionability union bounds', () => {
	const ACTIONABILITY_FIELDS = [
		'required_actions',
		'forbidden_actions',
		'verification_checks',
		'applies_to_agents',
		'applies_to_tools',
		'triggers',
	] as const;

	test('a field absent on BOTH sides is not materialized as an empty array', () => {
		const target = entry();
		const src = entry({ id: 'src-1' });

		mergeEntryFields(target, src);

		for (const field of ACTIONABILITY_FIELDS) {
			expect(field in target).toBe(false);
		}
		expect('source_knowledge_ids' in target).toBe(false);
	});

	test('triggers are unioned like the other five actionability arrays', () => {
		const target = entry({ triggers: ['t-trigger'] });
		const src = entry({ id: 'src-1', triggers: ['s-trigger'] });

		mergeEntryFields(target, src);

		expect(target.triggers).toEqual(['t-trigger', 's-trigger']);
	});

	test('the union is deduped case-insensitively and capped at 20', () => {
		// Routed through `dedupeCapped` (truncate → dedupe → cap), never a bare
		// positional `.slice(0, 20)` — see check-invariants.sh Check 5 for why the
		// positional spelling is banned on knowledge array fields.
		const target = entry({
			required_actions: [
				'Run Tests',
				...Array.from({ length: 15 }, (_, i) => `t-${i}`),
			],
		});
		const src = entry({
			id: 'src-1',
			required_actions: [
				'run tests',
				...Array.from({ length: 15 }, (_, i) => `s-${i}`),
			],
		});

		mergeEntryFields(target, src);

		const merged = target.required_actions as string[];
		expect(merged).toHaveLength(20);
		// Case-insensitive dedupe kept the FIRST occurrence's casing.
		expect(merged[0]).toBe('Run Tests');
		expect(merged).not.toContain('run tests');
	});

	test('non-string junk in an actionability array is dropped by the union', () => {
		const target = entry({ required_actions: ['keep', 42, null] });
		const src = entry({ id: 'src-1', required_actions: ['also-keep'] });

		mergeEntryFields(target, src);

		expect(target.required_actions).toEqual(['keep', 'also-keep']);
	});

	test('source_knowledge_ids are capped at 50, not 20', () => {
		// knowledge-store.ts deliberately excludes this field from its 20-cap:
		// the producer caps at FIFTY and skill-invalidator walks the full list to
		// retire skills whose source entry was archived. A 20-cap here would
		// silently orphan generated skills.
		const target = entry({
			source_knowledge_ids: Array.from({ length: 30 }, (_, i) => `t-${i}`),
		});
		const src = entry({
			id: 'src-1',
			source_knowledge_ids: Array.from({ length: 30 }, (_, i) => `s-${i}`),
		});

		mergeEntryFields(target, src);

		const merged = target.source_knowledge_ids as string[];
		expect(merged).toHaveLength(50);
		expect(merged[29]).toBe('t-29');
		expect(merged[30]).toBe('s-0');
	});

	test('directive_priority: the winner keeps its own value', () => {
		const target = entry({ directive_priority: 'low' });
		const src = entry({ id: 'src-1', directive_priority: 'critical' });

		mergeEntryFields(target, src);

		expect(target.directive_priority).toBe('low');
	});

	test('directive_priority: the loser fills a gap on the winner', () => {
		const target = entry({ directive_priority: undefined });
		const src = entry({ id: 'src-1', directive_priority: 'high' });

		mergeEntryFields(target, src);

		expect(target.directive_priority).toBe('high');
	});

	test('directive_priority: absent on both sides stays absent', () => {
		const target = entry();
		const src = entry({ id: 'src-1' });

		mergeEntryFields(target, src);

		expect(target.directive_priority).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// CAS integrity on a lesson swap
// ---------------------------------------------------------------------------

describe('mergeEntryFields — CAS token integrity', () => {
	const LONG = 'a considerably longer and richer lesson text';

	test('content_hash is left alone when the lesson is NOT swapped', () => {
		const target = entry({
			lesson: 'a considerably longer lesson text',
			content_hash: 'aaaaaaaaaaaa',
		});
		const src = entry({ id: 'src-1', lesson: 'short' });

		mergeEntryFields(target, src);

		expect(target.content_hash).toBe('aaaaaaaaaaaa');
	});

	test('revision IS bumped when the lesson is swapped', () => {
		const target = entry({ lesson: 'short lesson', revision: 3 });
		const src = entry({ id: 'src-1', lesson: LONG, revision: 7 });

		mergeEntryFields(target, src);

		// The winner's own revision + 1 — never the loser's.
		expect(target.revision).toBe(4);
	});

	test('a lesson swap on a legacy entry with no revision stamps revision 1', () => {
		const target = entry({ lesson: 'short lesson', revision: undefined });
		const src = entry({ id: 'src-1', lesson: LONG });

		mergeEntryFields(target, src);

		expect(target.revision).toBe(1);
	});

	test('a lesson swap on an entry with no content_hash stamps one', () => {
		const target = entry({ lesson: 'short lesson', content_hash: undefined });
		const src = entry({ id: 'src-1', lesson: LONG });

		mergeEntryFields(target, src);

		expect(target.content_hash).toBe(computeContentHash(LONG));
	});

	test('two successive swaps keep the hash tracking the surviving lesson', () => {
		const target = entry({ lesson: 'short lesson', revision: 0 });

		mergeEntryFields(target, entry({ id: 'src-1', lesson: LONG }));
		expect(target.content_hash).toBe(computeContentHash(LONG));
		expect(target.revision).toBe(1);

		const longer = `${LONG} plus an additional qualifying clause`;
		mergeEntryFields(target, entry({ id: 'src-2', lesson: longer }));
		expect(target.lesson).toBe(longer);
		expect(target.content_hash).toBe(computeContentHash(longer));
		expect(target.revision).toBe(2);
	});
});

/**
 * Recency-aware same-id merges in the knowledge family migration engine
 * (issue #3521 AC1 / frozen check C6's shipped surface; the #2958 stale-wins
 * class fixed in the sibling knowledge engine). Exercises the exported
 * `_internals` seam and the real KNOWLEDGE_FAMILY members.
 */
import { describe, expect, test } from 'bun:test';
import { KNOWLEDGE_FAMILY } from '../../../src/knowledge/family-manifest';
import { _internals } from '../../../src/knowledge/family-migration';

const { mergeStoreEntries, appendUnionById, keySelectorFor } = _internals;

function member(filename: string) {
	const m = KNOWLEDGE_FAMILY.find((x) => x.filename === filename);
	if (!m) throw new Error(`no member ${filename}`);
	return m;
}

describe('mergeStoreEntries recency (knowledge.jsonl)', () => {
	test('source-newer same-id collision replaces with the newer version', () => {
		const dest = {
			id: 'k1',
			lesson: 'older lesson text alpha',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const src = {
			id: 'k1',
			lesson: 'newer lesson text beta',
			revision: 9,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const r = mergeStoreEntries([dest] as never[], [src] as never[]);
		const kept = (r.merged as (typeof dest)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(kept[0].revision).toBe(9);
		expect(kept[0].updated_at).toBe('2026-06-01T00:00:00Z');
		expect(r.superseded).toBe(1);
	});

	test('destination-newer collision keeps the destination (unchanged)', () => {
		const newer = {
			id: 'k1',
			lesson: 'newer',
			revision: 9,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const older = {
			id: 'k1',
			lesson: 'older',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const r = mergeStoreEntries([newer] as never[], [older] as never[]);
		const kept = (r.merged as (typeof newer)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(kept[0].revision).toBe(9);
		expect(r.superseded).toBe(0);
		expect(r.skipped).toBe(1);
	});

	test('revision is the tiebreak when updated_at is equal', () => {
		const dest = {
			id: 'k1',
			lesson: 'low rev',
			revision: 2,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const src = {
			id: 'k1',
			lesson: 'high rev',
			revision: 7,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const r = mergeStoreEntries([dest] as never[], [src] as never[]);
		const kept = (r.merged as (typeof dest)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(kept[0].revision).toBe(7);
	});

	test('no usable recency signal keeps the destination and is reported', () => {
		// A corrupt/missing timestamp is NEVER read as epoch-0 "oldest".
		const dest = { id: 'k1', lesson: 'no stamps here' };
		const src = { id: 'k1', lesson: 'still no stamps' };
		const r = mergeStoreEntries([dest] as never[], [src] as never[]);
		const kept = (r.merged as (typeof dest)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(kept[0].lesson).toBe('no stamps here');
		expect(r.superseded).toBe(0);
		expect(r.noSignal).toBe(1);
	});

	test('within-destination newer duplicate wins at the first position', () => {
		const oldRow = {
			id: 'k1',
			lesson: 'old',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const newRow = {
			id: 'k1',
			lesson: 'new',
			revision: 9,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const r = mergeStoreEntries(
			[oldRow, { ...newRow }] as never[],
			[] as never[],
		);
		const kept = (r.merged as (typeof oldRow)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(kept[0].revision).toBe(9);
	});

	test('within-source newer duplicate beats an older destination', () => {
		const dest = {
			id: 'k1',
			lesson: 'mid',
			revision: 5,
			updated_at: '2026-03-01T00:00:00Z',
		};
		const srcOld = {
			id: 'k1',
			lesson: 'old src',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const srcNew = {
			id: 'k1',
			lesson: 'new src',
			revision: 9,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const r = mergeStoreEntries([dest] as never[], [srcOld, srcNew] as never[]);
		const kept = (r.merged as (typeof dest)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(kept[0].revision).toBe(9);
	});

	test('byte-equal retry is a benign dedupe (idempotent relink)', () => {
		const row = {
			id: 'k1',
			lesson: 'same',
			revision: 3,
			updated_at: '2026-03-01T00:00:00Z',
		};
		const r = mergeStoreEntries([row] as never[], [{ ...row }] as never[]);
		const kept = (r.merged as (typeof row)[]).filter((e) => e.id === 'k1');
		expect(kept).toHaveLength(1);
		expect(r.added).toBe(0);
		expect(r.superseded).toBe(0);
	});
});

describe('appendUnionById recency (versioned append-union members)', () => {
	const unactionable = member('knowledge-unactionable.jsonl');
	const quarantined = member('knowledge-quarantined.jsonl');

	test('unactionable: source-newer updated_at replaces (one row survives)', () => {
		const dest = {
			id: 'u1',
			reason: 'older',
			updated_at: '2026-01-01T00:00:00Z',
		};
		const src = {
			id: 'u1',
			reason: 'newer',
			updated_at: '2026-08-01T00:00:00Z',
		};
		const r = appendUnionById(
			[dest] as never[],
			[src] as never[],
			keySelectorFor(unactionable) as never,
		);
		const kept = (r.merged as (typeof dest)[]).filter((e) => e.id === 'u1');
		expect(kept).toHaveLength(1);
		expect(kept[0].reason).toBe('newer');
	});

	test('unactionable: destination-newer keeps the destination', () => {
		const newer = {
			id: 'u1',
			reason: 'newer',
			updated_at: '2026-08-01T00:00:00Z',
		};
		const older = {
			id: 'u1',
			reason: 'older',
			updated_at: '2026-01-01T00:00:00Z',
		};
		const r = appendUnionById(
			[newer] as never[],
			[older] as never[],
			keySelectorFor(unactionable) as never,
		);
		const kept = (r.merged as (typeof newer)[]).filter((e) => e.id === 'u1');
		expect(kept).toHaveLength(1);
		expect(kept[0].reason).toBe('newer');
	});

	test('quarantined: newer quarantined_at replaces; destination-newer unchanged', () => {
		const selector = keySelectorFor(quarantined);
		const oldRow = { id: 'q1', quarantined_at: '2026-01-01T00:00:00Z' };
		const newRow = { id: 'q1', quarantined_at: '2026-08-01T00:00:00Z' };
		const r = appendUnionById(
			[oldRow] as never[],
			[newRow] as never[],
			selector as never,
		);
		expect(
			(r.merged as (typeof oldRow)[]).filter((e) => e.id === 'q1'),
		).toHaveLength(1);
		expect(r.superseded).toBe(1);

		const r2 = appendUnionById(
			[newRow] as never[],
			[oldRow] as never[],
			selector as never,
		);
		const kept2 = (r2.merged as (typeof oldRow)[]).filter((e) => e.id === 'q1');
		expect(kept2).toHaveLength(1);
		expect(kept2[0].quarantined_at).toBe('2026-08-01T00:00:00Z');
		expect(r2.superseded).toBe(0);
	});

	test('no-signal members (pure event logs) keep the base skip semantics', () => {
		// Same key, no recency fields anywhere: destination wins, one row.
		const selector = keySelectorFor(member('knowledge-events.jsonl'));
		const r = appendUnionById(
			[{ id: 'e1', kind: 'x' }] as never[],
			[{ id: 'e1', kind: 'y' }] as never[],
			selector as never,
		);
		expect(r.merged).toHaveLength(1);
		expect(r.superseded).toBe(0);
		expect(r.noSignal).toBe(1);
	});
});

describe('within-destination pre-reduction keeps unrelated rows (4.5 review blocker 1)', () => {
	// The pre-reduction splices duplicate rows while the source loop keys an
	// id→index map; a stale map made rows positioned AFTER a duplicate pair
	// resolve to the wrong incumbent (or out of bounds) and get dropped.
	// These legs pin the three data-loss shapes from the round-1 review.

	test('a trailing row after a duplicate pair survives an empty-source merge', () => {
		const dupOld = {
			id: 'd1',
			lesson: 'old',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const dupNew = {
			id: 'd1',
			lesson: 'new',
			revision: 2,
			updated_at: '2026-02-01T00:00:00Z',
		};
		const tail = {
			id: 'd2',
			lesson: 'tail',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const r = mergeStoreEntries(
			[dupOld, dupNew, tail] as never[],
			[] as never[],
		);
		const merged = r.merged as (typeof tail)[];
		expect(merged.map((e) => e.id)).toEqual(['d1', 'd2']);
		expect(merged[0]?.lesson).toBe('new');
		expect(merged[1]?.lesson).toBe('tail');
	});

	test('two duplicated ids each reduce to their effective row', () => {
		const y0 = {
			id: 'y',
			lesson: 'y-old',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const y1 = {
			id: 'y',
			lesson: 'y-new',
			revision: 2,
			updated_at: '2026-02-01T00:00:00Z',
		};
		const x0 = {
			id: 'x',
			lesson: 'x-old',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const x1 = {
			id: 'x',
			lesson: 'x-new',
			revision: 2,
			updated_at: '2026-02-01T00:00:00Z',
		};
		const r = mergeStoreEntries([y0, y1, x0, x1] as never[], [] as never[]);
		const merged = r.merged as (typeof y0)[];
		expect(merged.map((e) => `${e.id}:${e.lesson}`)).toEqual([
			'y:y-new',
			'x:x-new',
		]);
	});

	test('a source-newer row for an id AFTER a duplicate pair supersedes', () => {
		const dupOld = {
			id: 'd1',
			lesson: 'old',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const dupNew = {
			id: 'd1',
			lesson: 'new',
			revision: 2,
			updated_at: '2026-02-01T00:00:00Z',
		};
		const tailOld = {
			id: 'd2',
			lesson: 'tail-old',
			revision: 1,
			updated_at: '2026-01-01T00:00:00Z',
		};
		const tailNew = {
			id: 'd2',
			lesson: 'tail-new',
			revision: 9,
			updated_at: '2026-06-01T00:00:00Z',
		};
		const r = mergeStoreEntries(
			[dupOld, dupNew, tailOld] as never[],
			[tailNew] as never[],
		);
		const merged = r.merged as (typeof tailOld)[];
		expect(merged.map((e) => `${e.id}:${e.lesson}`)).toEqual([
			'd1:new',
			'd2:tail-new',
		]);
		expect(r.superseded).toBe(1);
		expect(r.skipped).toBe(0);
	});
});

describe('keyless destination rows survive append-union merges (4.5 review blocker 3)', () => {
	test('a keyless destination row is carried through verbatim, not dropped', () => {
		const selector = keySelectorFor(member('knowledge-unactionable.jsonl'));
		const keyed = { id: 'u1', reason: 'kept' };
		const keyless = { nope: true };
		const r = appendUnionById(
			[keyed, keyless] as never[],
			[] as never[],
			selector as never,
		);
		expect(r.merged).toHaveLength(2);
		expect(r.merged[1]).toBe(keyless);
		// Only keyless SOURCE rows are skipped (unaddressable, as before).
		const r2 = appendUnionById(
			[] as never[],
			[keyless] as never[],
			selector as never,
		);
		expect(r2.merged).toHaveLength(0);
		expect(r2.skipped).toBe(1);
	});
});

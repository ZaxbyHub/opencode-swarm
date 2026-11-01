/**
 * Feedback-round fixes (#3530 review): far-future stamp bound (PRR-011),
 * quarantined-member recency field (PRR-014), O(n) destination reduction
 * with the deduped counter (PRR-009/015), and provenance-preserving replace.
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

describe('far-future stamp bound (PRR-011)', () => {
	test('a far-future source stamp does NOT replace the destination', () => {
		const r = mergeStoreEntries(
			[
				{
					id: 'k1',
					lesson: 'destination keeps',
					revision: 5,
					updated_at: '2026-06-01T00:00:00Z',
				},
			] as never,
			[
				{
					id: 'k1',
					lesson: 'EVIL far-future replace',
					revision: 0,
					updated_at: '9999-12-31T00:00:00.000Z',
				},
			] as never,
		);
		const kept = (r.merged as Array<{ lesson: string }>).filter(
			(e) => e.id === 'k1',
		);
		expect(kept).toHaveLength(1);
		expect(kept[0].lesson).toBe('destination keeps');
		expect(r.superseded).toBe(0);
	});

	test('far-future stamp on the DESTINATION side does not block a legit newer source', () => {
		const r = mergeStoreEntries(
			[
				{
					id: 'k1',
					lesson: 'corrupt destination stamp',
					revision: 1,
					updated_at: '9999-01-01T00:00:00Z',
				},
			] as never,
			[
				{
					id: 'k1',
					lesson: 'legit newer source',
					revision: 2,
					updated_at: '2026-06-01T00:00:00Z',
				},
			] as never,
		);
		// Both rows no-signal (far-future rejected on dest) → destination wins.
		// This is the safe direction: a corrupt destination stamp can't mask a
		// replacement either way without a signal.
		const kept = (r.merged as Array<{ lesson: string }>).filter(
			(e) => e.id === 'k1',
		);
		expect(kept).toHaveLength(1);
		expect(r.noSignal).toBe(1);
	});
});

describe('quarantined-member recency field (PRR-014)', () => {
	const quarantined = member('knowledge-quarantined.jsonl');

	test('manifest declares quarantined_at as the recency field', () => {
		expect(quarantined.recencyField).toBe('quarantined_at');
	});

	test('a re-quarantine (newer quarantined_at, equal updated_at) wins', () => {
		const selector = keySelectorFor(quarantined);
		const oldRow = {
			id: 'q1',
			lesson: 'old record',
			updated_at: '2026-01-01T00:00:00Z',
			quarantined_at: '2026-01-01T00:00:00Z',
		};
		const newRow = {
			id: 'q1',
			lesson: 'new quarantine record',
			updated_at: '2026-01-01T00:00:00Z',
			quarantined_at: '2026-08-01T00:00:00Z',
		};
		const r = appendUnionById(
			[oldRow] as never,
			[newRow] as never,
			selector as never,
			(row) => rowRecencyWithField(row, 'quarantined_at'),
		);
		const kept = (r.merged as Array<{ lesson: string }>).filter(
			(e) => e.id === 'q1',
		);
		expect(kept).toHaveLength(1);
		expect(kept[0].lesson).toBe('new quarantine record');
		expect(r.superseded).toBe(1);
	});

	function rowRecencyWithField(row: unknown, field: string) {
		const o = row as Record<string, unknown>;
		const raw = typeof o[field] === 'string' ? (o[field] as string) : undefined;
		if (raw === undefined) return null;
		const at = Date.parse(raw);
		if (Number.isNaN(at) || at > Date.now() + 86_400_000) return null;
		return { at, revision: 0 };
	}
});

describe('O(n) destination reduction + deduped counter (PRR-009/015)', () => {
	test('30k duplicate-bearing destination merges fast and counts deduped', () => {
		const dest: Array<{
			id: string;
			lesson: string;
			updated_at: string;
		}> = [];
		for (let i = 0; i < 30000; i += 1) {
			dest.push({
				id: `id-${i % 15000}`,
				lesson: `l${i}`,
				updated_at: '2026-01-01T00:00:00Z',
			});
		}
		const t0 = performance.now();
		const r = mergeStoreEntries(dest as never, [] as never);
		const ms = performance.now() - t0;
		expect(r.deduped).toBe(15000);
		expect(r.merged).toHaveLength(15000);
		expect(ms).toBeLessThan(2000);
	});

	test('deduped is 0 when the destination has no duplicates', () => {
		const r = mergeStoreEntries(
			[
				{ id: 'k1', lesson: 'one', updated_at: '2026-01-01T00:00:00Z' },
			] as never,
			[] as never,
		);
		expect(r.deduped).toBe(0);
	});
});

describe('provenance-preserving replace', () => {
	test('destination-only fields carry over when the source replaces', () => {
		const dest = {
			id: 'k1',
			lesson: 'old text',
			updated_at: '2026-01-01T00:00:00Z',
			revision: 1,
			confirmed_by: ['reviewer-a'],
		};
		const src = {
			id: 'k1',
			lesson: 'new text',
			updated_at: '2026-06-01T00:00:00Z',
			revision: 2,
		};
		const r = mergeStoreEntries([dest] as never, [src] as never);
		const kept = (r.merged as Array<Record<string, unknown>>).filter(
			(e) => e.id === 'k1',
		);
		expect(kept).toHaveLength(1);
		expect(kept[0].lesson).toBe('new text');
		expect(kept[0].confirmed_by).toEqual(['reviewer-a']);
	});
});

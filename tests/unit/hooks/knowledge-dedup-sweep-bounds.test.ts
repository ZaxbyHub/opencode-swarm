import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	sweepActiveNearDuplicates,
} from '../../../src/hooks/knowledge-dedup-sweep.js';
import type { KnowledgeEntryBase } from '../../../src/hooks/knowledge-types.js';
import {
	ACTIONABLE_FIELDS,
	type DedupSweepHarness,
	makeEntry,
	makeHarness,
	readEntries,
	UNRELATED_LESSON,
	writeEntries,
	writeProjectConfig,
} from './_dedup-sweep-helpers.js';

/**
 * Budgets, the config gate, winner selection, and scan filtering for the
 * dedup sweep (issue #1821 Lane A). Merge/audit/idempotency behavior lives in
 * `knowledge-dedup-sweep.test.ts` (split for the 500-line FR-006 cap).
 *
 * The winner-selection and planning assertions use the Tier-0 `_test_exports`
 * pure-function seam: `compareCandidates` and `planMerges` do no I/O, so they
 * are exercised directly instead of through a temp-directory round trip.
 */

let h: DedupSweepHarness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	h.cleanup();
});

const { compareCandidates, evidenceWeight, isActive, planMerges } =
	_test_exports;

describe('sweepActiveNearDuplicates — config gate', () => {
	test('learning.dedup_sweep.enabled=false makes the sweep a no-op', async () => {
		writeProjectConfig(h.directory, {
			learning: { dedup_sweep: { enabled: false } },
		});
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.2 }),
		]);
		const before = fs.readFileSync(h.knowledgePath, 'utf-8');

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.enabled).toBe(false);
		expect(result.scanned).toBe(0);
		expect(result.merges).toHaveLength(0);
		expect(fs.readFileSync(h.knowledgePath, 'utf-8')).toBe(before);
	});

	test('an absent learning block leaves the sweep ON (schema default)', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.2 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.enabled).toBe(true);
		expect(result.merges).toHaveLength(1);
	});

	test('a raised knowledge.dedup_threshold suppresses a borderline pair', async () => {
		// 0.636 similar: merged at the 0.6 default, not at 0.9.
		writeProjectConfig(h.directory, { knowledge: { dedup_threshold: 0.9 } });
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a',
				lesson: 'run focused unit tests before claiming the task is done',
			}),
			makeEntry({
				id: 'b',
				lesson: 'unit tests before claiming the task is done and record',
			}),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.comparisons).toBe(1);
		expect(result.merges).toHaveLength(0);
	});
});

describe('sweepActiveNearDuplicates — budgets', () => {
	test('max_merges_per_sweep caps the applied merges and flags the budget', async () => {
		writeProjectConfig(h.directory, {
			learning: { dedup_sweep: { max_merges_per_sweep: 1 } },
		});
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.5 }),
			makeEntry({ id: 'c', confidence: 0.1 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.mergeBudgetExhausted).toBe(true);
		expect(result.merges).toHaveLength(1);
		const active = readEntries(h.knowledgePath).filter(
			(e) => e.status !== 'archived',
		);
		expect(active).toHaveLength(2);
	});

	test('max_comparisons stops the scan early and flags the budget', async () => {
		writeProjectConfig(h.directory, {
			learning: { dedup_sweep: { max_comparisons: 1 } },
		});
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.5 }),
			makeEntry({ id: 'c', confidence: 0.1 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		// Three entries would be three pairs; the budget allowed exactly one.
		expect(result.comparisons).toBe(1);
		expect(result.comparisonBudgetExhausted).toBe(true);
	});

	test('a zero budget disables the work without reporting the sweep disabled', async () => {
		writeProjectConfig(h.directory, {
			learning: { dedup_sweep: { max_merges_per_sweep: 0 } },
		});
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.2 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.enabled).toBe(true);
		expect(result.merges).toHaveLength(0);
		expect(result.comparisons).toBe(0);
	});

	test('a single-entry store performs no comparisons at all', async () => {
		writeEntries(h.knowledgePath, [makeEntry({ id: 'only' })]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.scanned).toBe(1);
		expect(result.comparisons).toBe(0);
		expect(result.merges).toHaveLength(0);
	});

	test('an absent knowledge file is handled without throwing', async () => {
		fs.rmSync(h.knowledgePath, { force: true });

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.scanned).toBe(0);
		expect(result.merges).toHaveLength(0);
	});
});

describe('sweepActiveNearDuplicates — scan filtering', () => {
	test('identical lessons in DIFFERENT categories are never compared', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', category: 'testing' }),
			makeEntry({ id: 'b', category: 'security' }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.scanned).toBe(2);
		expect(result.comparisons).toBe(0);
		expect(result.merges).toHaveLength(0);
	});

	test('quarantined entries are neither merge targets nor merge sources', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', status: 'quarantined' }),
			makeEntry({ id: 'b', status: 'quarantined_unactionable' }),
			makeEntry({ id: 'c', status: 'candidate' }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.scanned).toBe(1);
		expect(result.merges).toHaveLength(0);
	});

	test('promoted and established entries ARE swept', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', status: 'promoted', confidence: 0.9 }),
			makeEntry({ id: 'b', status: 'established', confidence: 0.2 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.merges).toEqual([
			{ winnerId: 'a', loserId: 'b', category: 'testing' },
		]);
		expect(readEntries(h.knowledgePath).find((e) => e.id === 'a')!.status).toBe(
			'promoted',
		);
	});

	test('the knowledgeDirectory option redirects the store, not the audit logs', async () => {
		const storeDir = path.join(h.directory, 'store');
		const storePath = path.join(storeDir, '.swarm', 'knowledge.jsonl');
		writeEntries(storePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.2 }),
		]);
		// The default location stays empty, proving the override was honored.
		writeEntries(h.knowledgePath, [makeEntry({ id: 'untouched' })]);

		const result = await sweepActiveNearDuplicates(h.directory, {
			knowledgeDirectory: storeDir,
		});

		expect(result.merges).toHaveLength(1);
		expect(readEntries(storePath).find((e) => e.id === 'b')!.status).toBe(
			'archived',
		);
		expect(readEntries(h.knowledgePath)).toHaveLength(1);
		// Audit lands under the PROJECT directory, matching curator.ts's own
		// archive-invalidation call which passes `directory`, not the store dir.
		expect(
			fs.existsSync(
				path.join(h.directory, '.swarm', 'knowledge-rewrites.jsonl'),
			),
		).toBe(true);
	});
});

describe('winner selection — compareCandidates', () => {
	const base = (over: Record<string, unknown>): KnowledgeEntryBase =>
		makeEntry(over);

	test('an ACTIONABLE entry beats a higher-confidence non-actionable one', async () => {
		const actionable = base({
			id: 'act',
			confidence: 0.2,
			...ACTIONABLE_FIELDS,
		});
		const richer = base({ id: 'rich', confidence: 0.9 });

		expect(compareCandidates(actionable, richer)).toBeLessThan(0);
		expect(compareCandidates(richer, actionable)).toBeGreaterThan(0);

		// End to end: the actionable entry is the survivor.
		writeEntries(h.knowledgePath, [richer, actionable]);
		const result = await sweepActiveNearDuplicates(h.directory);
		expect(result.merges).toEqual([
			{ winnerId: 'act', loserId: 'rich', category: 'testing' },
		]);
	});

	test('with equal actionability, higher confidence wins', () => {
		const high = base({ id: 'high', confidence: 0.8 });
		const low = base({ id: 'low', confidence: 0.3 });
		expect(compareCandidates(high, low)).toBeLessThan(0);
	});

	test('with equal confidence, more evidence wins', () => {
		const evidenced = base({
			id: 'evidenced',
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
				shown_count: 9,
			},
		});
		const bare = base({ id: 'bare' });
		expect(evidenceWeight(evidenced)).toBe(9);
		expect(evidenceWeight(bare)).toBe(0);
		expect(compareCandidates(evidenced, bare)).toBeLessThan(0);
	});

	test('with equal evidence, the OLDER created_at wins', () => {
		const older = base({
			id: 'zzz-older',
			created_at: '2025-01-01T00:00:00.000Z',
		});
		const newer = base({
			id: 'aaa-newer',
			created_at: '2026-01-01T00:00:00.000Z',
		});
		expect(compareCandidates(older, newer)).toBeLessThan(0);
	});

	test('a total tie falls back to lexicographic id, so the order is total', () => {
		const a = base({ id: 'aaa' });
		const b = base({ id: 'bbb' });
		expect(compareCandidates(a, b)).toBeLessThan(0);
		expect(compareCandidates(b, a)).toBeGreaterThan(0);
		expect(compareCandidates(a, a)).toBe(0);
	});

	test('isActive accepts exactly the three active statuses', () => {
		expect(isActive(base({ status: 'candidate' }))).toBe(true);
		expect(isActive(base({ status: 'established' }))).toBe(true);
		expect(isActive(base({ status: 'promoted' }))).toBe(true);
		expect(isActive(base({ status: 'archived' }))).toBe(false);
		expect(isActive(base({ status: 'quarantined' }))).toBe(false);
		expect(isActive(base({ status: 'quarantined_unactionable' }))).toBe(false);
	});
});

describe('planMerges — determinism and bounds', () => {
	test('input order does not change the plan (concurrent sweeps converge)', () => {
		const a = makeEntry({ id: 'a', confidence: 0.5 });
		const b = makeEntry({ id: 'b', confidence: 0.5 });
		const c = makeEntry({ id: 'c', confidence: 0.5 });

		const forward = planMerges([a, b, c], 0.6, 100, 10);
		const reversed = planMerges([c, b, a], 0.6, 100, 10);

		const shape = (r: ReturnType<typeof planMerges>) =>
			r.plan.map((m) => `${m.winner.id}<-${m.loser.id}`);
		expect(shape(forward)).toEqual(shape(reversed));
		// All three tie on every criterion, so the smallest id is the winner.
		expect(shape(forward)).toEqual(['a<-b', 'a<-c']);
	});

	test('unrelated lessons produce comparisons but no plan', () => {
		const a = makeEntry({ id: 'a' });
		const b = makeEntry({ id: 'b', lesson: UNRELATED_LESSON });

		const result = planMerges([a, b], 0.6, 100, 10);

		expect(result.comparisons).toBe(1);
		expect(result.plan).toHaveLength(0);
		expect(result.comparisonBudgetExhausted).toBe(false);
		expect(result.mergeBudgetExhausted).toBe(false);
	});

	test('per-category bucketing keeps cross-category pairs out of the count', () => {
		const entries = [
			makeEntry({ id: 'a', category: 'testing' }),
			makeEntry({ id: 'b', category: 'testing' }),
			makeEntry({ id: 'c', category: 'security' }),
			makeEntry({ id: 'd', category: 'security' }),
		];

		const result = planMerges(entries, 0.6, 100, 10);

		// Two buckets of two: 2 comparisons, not the 6 an all-pairs scan would do.
		expect(result.comparisons).toBe(2);
		expect(result.plan).toHaveLength(2);
	});
});

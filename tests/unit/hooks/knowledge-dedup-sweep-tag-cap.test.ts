import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sweepActiveNearDuplicates } from '../../../src/hooks/knowledge-dedup-sweep.js';
import type { KnowledgeEntryBase } from '../../../src/hooks/knowledge-types.js';
import { mergeEntryFields } from '../../../src/knowledge/entry-merge.js';
import {
	type DedupSweepHarness,
	makeEntry,
	makeHarness,
	readEntries,
	writeEntries,
} from './_dedup-sweep-helpers.js';

/**
 * TAG_UNION_RULE coverage for the near-duplicate merge (issue #1821 Lane A).
 *
 * `tags` is a BOUNDED field — `knowledge_add` caps its producer at 20 and the
 * store's write boundary (`normalizeEntryArraysForWrite`) re-caps every written
 * entry at `WRITE_FIELD_CAP` = 20 — so a merge cannot promise to preserve every
 * tag from both sides. `src/knowledge/entry-merge.ts` documents the rule this
 * file pins:
 *
 *   winner tags first (in order) → loser tags fill the remaining slots (in
 *   order) → case-insensitive dedup, first spelling wins → overflow past 20
 *   DROPPED at merge time.
 *
 * TWO LEVELS ON PURPOSE, and the difference matters when reading a failure:
 *
 *  - The `mergeEntryFields` block is where the fix is OBSERVABLE. The pre-fix
 *    code unioned tags with a bare `new Set(...)`: uncapped and
 *    case-SENSITIVE. Reverting to it fails every assertion in that block.
 *  - The sweep block is where the COMMITTED consequence is pinned. It passes
 *    against the pre-fix code too, because the write boundary was already
 *    truncating the over-cap list winner-first — which is precisely why the
 *    loss was invisible and why the rule has to be asserted end-to-end rather
 *    than inferred from the merge helper alone.
 *
 * ZERO MOCKS, matching the sibling sweep suites: every sweep assertion reads
 * the real `.swarm/knowledge.jsonl` the sweep wrote inside an isolated temp
 * HOME.
 */

/** The documented cap. Mirrors `MERGE_FIELD_CAP` / `WRITE_FIELD_CAP` (both 20). */
const TAG_CAP = 20;

/** `count` distinct, zero-padded tags with a stable, sortable prefix. */
function tags(prefix: string, count: number): string[] {
	return Array.from(
		{ length: count },
		(_unused, index) => `${prefix}-${String(index).padStart(2, '0')}`,
	);
}

describe('mergeEntryFields — TAG_UNION_RULE', () => {
	test('caps the unioned tag list at 20 instead of handing an over-cap list to the write boundary', () => {
		const winner = makeEntry({ id: 'w', tags: tags('win', 15) });
		const loser = makeEntry({ id: 'l', tags: tags('lose', 10) });

		mergeEntryFields(winner, loser);

		// 15 + 10 = 25 candidates, 20 slots. Winner's 15 are retained in order,
		// the loser's FIRST 5 fill what is left, and `lose-05`..`lose-09` are
		// dropped here — visibly — rather than by the write boundary later.
		expect(winner.tags).toHaveLength(TAG_CAP);
		expect(winner.tags).toEqual([...tags('win', 15), ...tags('lose', 5)]);
		expect(winner.tags).not.toContain('lose-05');
	});

	test('a winner already at the 20-tag cap absorbs ZERO tags from the loser', () => {
		const winner = makeEntry({ id: 'w', tags: tags('win', TAG_CAP) });
		const loser = makeEntry({ id: 'l', tags: ['flaky', 'windows', 'ci'] });

		mergeEntryFields(winner, loser);

		// The documented, deliberate consequence of the cap. Asserted so nobody
		// re-derives it from a surprising bug report.
		expect(winner.tags).toEqual(tags('win', TAG_CAP));
		expect(winner.tags).not.toContain('flaky');
	});

	test('dedups tags case-insensitively, first spelling wins', () => {
		const winner = makeEntry({ id: 'w', tags: ['CI', 'Testing'] });
		const loser = makeEntry({ id: 'l', tags: ['ci', 'TESTING', 'windows'] });

		mergeEntryFields(winner, loser);

		// The write boundary compares lowercased, so a case-sensitive union here
		// only produced a list the very next write would rewrite.
		expect(winner.tags).toEqual(['CI', 'Testing', 'windows']);
	});

	test('every loser tag survives when the union fits under the cap', () => {
		const winner = makeEntry({ id: 'w', tags: tags('win', 8) });
		const loser = makeEntry({ id: 'l', tags: tags('lose', 8) });

		mergeEntryFields(winner, loser);

		expect(winner.tags).toEqual([...tags('win', 8), ...tags('lose', 8)]);
	});

	test('leaves an empty tag list rather than dropping the required field', () => {
		// `tags` is REQUIRED on the entry shape, unlike the optional actionability
		// arrays, so the merge must still materialize it when neither side has one.
		const winner = makeEntry({ id: 'w' }) as unknown as Record<string, unknown>;
		const loser = makeEntry({ id: 'l' }) as unknown as Record<string, unknown>;
		delete winner.tags;
		delete loser.tags;

		mergeEntryFields(
			winner as unknown as KnowledgeEntryBase,
			loser as unknown as KnowledgeEntryBase,
		);

		expect(winner.tags).toEqual([]);
	});
});

describe('sweepActiveNearDuplicates — committed tag outcome at the cap', () => {
	let h: DedupSweepHarness;

	beforeEach(() => {
		h = makeHarness();
	});

	afterEach(() => {
		h.cleanup();
	});

	test('a winner at the cap keeps its own 20 tags and the loser is archived with its tags unreachable', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a-winner',
				confidence: 0.9,
				tags: tags('win', TAG_CAP),
			}),
			makeEntry({
				id: 'b-loser',
				confidence: 0.2,
				tags: ['flaky', 'windows', 'ci'],
			}),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);
		expect(result.merges).toHaveLength(1);

		const after = readEntries(h.knowledgePath);
		const winner = after.find((e) => e.id === 'a-winner')!;
		const loser = after.find((e) => e.id === 'b-loser')!;

		// The rule, end to end: 20 winner tags in, 20 winner tags out.
		expect(winner.tags).toEqual(tags('win', TAG_CAP));
		expect(winner.tags.filter((t) => !t.startsWith('win-'))).toEqual([]);
		// And the loss is PERMANENT: the loser is archived in the same
		// transaction, so its tags are not recoverable from the active store.
		expect(loser.status).toBe('archived');
		expect(loser.archived_from).toBe('candidate');
	});

	test('below the cap every loser tag lands on the winner, winner-first', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9, tags: ['testing', 'unit'] }),
			makeEntry({ id: 'b-loser', confidence: 0.2, tags: ['ci', 'windows'] }),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const winner = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		)!;
		expect(winner.tags).toEqual(['testing', 'unit', 'ci', 'windows']);
	});

	test('a 15-tag winner absorbs exactly the 5 loser tags that fit', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9, tags: tags('win', 15) }),
			makeEntry({ id: 'b-loser', confidence: 0.2, tags: tags('lose', 10) }),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const winner = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		)!;
		expect(winner.tags).toHaveLength(TAG_CAP);
		expect(winner.tags).toEqual([...tags('win', 15), ...tags('lose', 5)]);
	});
});

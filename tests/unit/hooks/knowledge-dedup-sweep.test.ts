import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { sweepActiveNearDuplicates } from '../../../src/hooks/knowledge-dedup-sweep.js';
import { computeContentHash } from '../../../src/hooks/knowledge-store.js';
import type {
	KnowledgeEntryBase,
	RewriteHistoryRecord,
} from '../../../src/hooks/knowledge-types.js';
import {
	ACTIONABLE_FIELDS,
	type DedupSweepHarness,
	makeEntry,
	makeHarness,
	readEntries,
	readSwarmJsonl,
	writeEntries,
} from './_dedup-sweep-helpers.js';

/**
 * Behavior of the active-store near-duplicate dedup sweep (issue #1821 Lane A).
 * Bounds, winner selection, and status filtering live in
 * `knowledge-dedup-sweep-bounds.test.ts`; the curator wiring proof lives in
 * `knowledge-dedup-sweep-wiring.test.ts` (all split for the 500-line FR-006
 * cap).
 *
 * ZERO MOCKS by design. The sweep's whole risk surface is transactional file
 * I/O, tombstone emission, and audit-log append — mocking any of that would
 * test the mock. Every assertion below reads the real `.swarm/` artifacts the
 * sweep wrote inside an isolated temp HOME.
 *
 * Skill retirement inside `writeArchiveTombstoneAndInvalidateSkills` is
 * `queueMicrotask`-deferred (skill-invalidator.ts:79), so nothing here asserts
 * retirement timing — only the synchronously-written `archived` tombstone.
 */

let h: DedupSweepHarness;

beforeEach(() => {
	h = makeHarness();
});

afterEach(() => {
	h.cleanup();
});

const DUP_LESSON =
	'always run focused unit tests before claiming a task is done';

describe('sweepActiveNearDuplicates — merge and archive', () => {
	test('merges a near-duplicate pair: one winner stays active, the loser is archived', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.enabled).toBe(true);
		expect(result.scanned).toBe(2);
		expect(result.comparisons).toBe(1);
		expect(result.merges).toEqual([
			{ winnerId: 'a-winner', loserId: 'b-loser', category: 'testing' },
		]);

		const after = readEntries(h.knowledgePath);
		expect(after).toHaveLength(2);
		const winner = after.find((e) => e.id === 'a-winner')!;
		const loser = after.find((e) => e.id === 'b-loser')!;
		expect(winner.status).toBe('candidate');
		expect(loser.status).toBe('archived');
		expect(loser.archived_from).toBe('candidate');
		expect(typeof loser.archived_at).toBe('string');
		expect((winner as unknown as Record<string, unknown>).merged_from).toEqual([
			'b-loser',
		]);
	});

	test('unions tags and actionability fields onto the winner', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a-winner',
				confidence: 0.9,
				tags: ['testing'],
				required_actions: ['run the focused test'],
				applies_to_agents: ['coder'],
			}),
			makeEntry({
				id: 'b-loser',
				confidence: 0.2,
				tags: ['ci'],
				required_actions: ['capture the command output'],
				applies_to_tools: ['bash'],
				triggers: ['claiming done'],
				source_refs: ['src/foo.ts:12'],
			}),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const winner = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		) as unknown as Record<string, unknown>;
		expect(winner.tags).toEqual(['testing', 'ci']);
		expect(winner.required_actions).toEqual([
			'run the focused test',
			'capture the command output',
		]);
		expect(winner.applies_to_agents).toEqual(['coder']);
		// Carried from the loser — the pre-#1821 merge dropped these entirely.
		expect(winner.applies_to_tools).toEqual(['bash']);
		expect(winner.triggers).toEqual(['claiming done']);
		expect(winner.source_refs).toEqual(['src/foo.ts:12']);
	});

	test('sums the losers retrieval counters into the winner', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a-winner',
				confidence: 0.9,
				retrieval_outcomes: {
					applied_count: 2,
					shown_count: 5,
					succeeded_after_count: 1,
					failed_after_count: 0,
				},
			}),
			makeEntry({
				id: 'b-loser',
				confidence: 0.2,
				retrieval_outcomes: {
					applied_count: 3,
					shown_count: 7,
					succeeded_after_count: 0,
					failed_after_count: 4,
				},
			}),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const winner = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		)!;
		expect(winner.retrieval_outcomes.applied_count).toBe(5);
		expect(winner.retrieval_outcomes.shown_count).toBe(12);
		expect(winner.retrieval_outcomes.failed_after_count).toBe(4);
	});

	test('a longer loser lesson wins and the winner CAS token is restamped', async () => {
		const longer = `${DUP_LESSON} and record the output`;
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a-winner',
				confidence: 0.9,
				revision: 2,
				content_hash: computeContentHash(DUP_LESSON),
			}),
			makeEntry({ id: 'b-loser', confidence: 0.2, lesson: longer }),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const winner = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		)!;
		expect(winner.lesson).toBe(longer);
		// Stale CAS tokens made every later authorized curation of a merged entry
		// fail `transactKnowledgeWithCas`. The hash must describe the SURVIVING text.
		expect(winner.content_hash).toBe(computeContentHash(longer));
		expect(winner.revision).toBe(3);
	});

	test('a whole cluster of three collapses to one winner in a single sweep', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.5 }),
			makeEntry({ id: 'c', confidence: 0.1 }),
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.merges).toHaveLength(2);
		expect(result.merges.map((m) => m.winnerId)).toEqual(['a', 'a']);
		const active = readEntries(h.knowledgePath).filter(
			(e) => e.status !== 'archived',
		);
		expect(active.map((e) => e.id)).toEqual(['a']);
	});

	test('a store with no near-duplicates is left byte-identical', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a',
				lesson: 'prefer dependency injection over module mocking',
			}),
			makeEntry({
				id: 'b',
				lesson: 'never hardcode absolute paths in shell scripts',
			}),
		]);
		const before = fs.readFileSync(h.knowledgePath, 'utf-8');

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.comparisons).toBe(1);
		expect(result.merges).toHaveLength(0);
		expect(fs.readFileSync(h.knowledgePath, 'utf-8')).toBe(before);
	});
});

describe('sweepActiveNearDuplicates — audit trail', () => {
	test('emits an archived tombstone through the shared skill invalidator', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2, status: 'established' }),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const events = readSwarmJsonl<Record<string, unknown>>(
			h.directory,
			'knowledge-events.jsonl',
		);
		const tombstones = events.filter((e) => e.type === 'archived');
		expect(tombstones).toHaveLength(1);
		expect(tombstones[0].entry_id).toBe('b-loser');
		expect(tombstones[0].tier).toBe('swarm');
		expect(tombstones[0].actor).toBe('curator');
		expect(tombstones[0].mode).toBe('archive');
		expect(tombstones[0].previous_status).toBe('established');
		expect(String(tombstones[0].reason)).toContain('a-winner');
	});

	test('emits one tombstone per loser when a cluster collapses', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.5 }),
			makeEntry({ id: 'c', confidence: 0.1 }),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const tombstoned = readSwarmJsonl<Record<string, unknown>>(
			h.directory,
			'knowledge-events.jsonl',
		)
			.filter((e) => e.type === 'archived')
			.map((e) => e.entry_id)
			.sort();
		expect(tombstoned).toEqual(['b', 'c']);
	});

	test("writes a rewrite-history record with action 'merge' and the loser as evidence", async () => {
		const longer = `${DUP_LESSON} and record the output`;
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9, revision: 4 }),
			makeEntry({ id: 'b-loser', confidence: 0.2, lesson: longer }),
		]);

		await sweepActiveNearDuplicates(h.directory);

		const history = readSwarmJsonl<RewriteHistoryRecord>(
			h.directory,
			'knowledge-rewrites.jsonl',
		);
		expect(history).toHaveLength(1);
		expect(history[0].action).toBe('merge');
		expect(history[0].entry_id).toBe('a-winner');
		expect(history[0].evidence_refs).toEqual(['b-loser']);
		expect(history[0].before_lesson).toBe(DUP_LESSON);
		expect(history[0].after_lesson).toBe(longer);
		expect(history[0].before_revision).toBe(4);
		expect(history[0].after_revision).toBe(5);
		expect(typeof history[0].timestamp).toBe('string');
	});

	test('no audit records are written when nothing merges', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a',
				lesson: 'prefer dependency injection over module mocking',
			}),
			makeEntry({
				id: 'b',
				lesson: 'never hardcode absolute paths in shell scripts',
			}),
		]);

		await sweepActiveNearDuplicates(h.directory);

		expect(
			readSwarmJsonl(h.directory, 'knowledge-rewrites.jsonl'),
		).toHaveLength(0);
		expect(
			readSwarmJsonl<Record<string, unknown>>(
				h.directory,
				'knowledge-events.jsonl',
			).filter((e) => e.type === 'archived'),
		).toHaveLength(0);
	});
});

describe('sweepActiveNearDuplicates — idempotency', () => {
	/**
	 * The underlying `mergeEntryFields` is NOT idempotent: merging the same
	 * source twice DOUBLES every counter (pinned in
	 * `tests/unit/knowledge/entry-merge-characterization-confidence.test.ts`).
	 * The sweep must not inherit that. It does not, because losers are archived
	 * and only ACTIVE entries are ever considered — but that is asserted here,
	 * never assumed.
	 */
	test('a second sweep over an unchanged store is a byte-for-byte no-op', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a-winner',
				confidence: 0.9,
				retrieval_outcomes: {
					applied_count: 2,
					shown_count: 5,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
			}),
			makeEntry({
				id: 'b-loser',
				confidence: 0.2,
				retrieval_outcomes: {
					applied_count: 3,
					shown_count: 7,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
			}),
		]);

		const first = await sweepActiveNearDuplicates(h.directory);
		expect(first.merges).toHaveLength(1);
		const afterFirst = fs.readFileSync(h.knowledgePath, 'utf-8');
		const winnerAfterFirst = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		)!;
		expect(winnerAfterFirst.retrieval_outcomes.applied_count).toBe(5);
		expect(winnerAfterFirst.retrieval_outcomes.shown_count).toBe(12);

		const second = await sweepActiveNearDuplicates(h.directory);

		expect(second.merges).toHaveLength(0);
		// Only the surviving winner is active, so there is nothing left to pair.
		expect(second.scanned).toBe(1);
		expect(second.comparisons).toBe(0);
		// Counters did NOT compound — the file is unchanged, byte for byte.
		expect(fs.readFileSync(h.knowledgePath, 'utf-8')).toBe(afterFirst);
	});

	test('a second sweep adds no tombstone and no rewrite-history record', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2 }),
		]);

		await sweepActiveNearDuplicates(h.directory);
		const eventsAfterFirst = readSwarmJsonl(
			h.directory,
			'knowledge-events.jsonl',
		).length;
		const historyAfterFirst = readSwarmJsonl(
			h.directory,
			'knowledge-rewrites.jsonl',
		).length;

		await sweepActiveNearDuplicates(h.directory);

		expect(readSwarmJsonl(h.directory, 'knowledge-events.jsonl')).toHaveLength(
			eventsAfterFirst,
		);
		expect(
			readSwarmJsonl(h.directory, 'knowledge-rewrites.jsonl'),
		).toHaveLength(historyAfterFirst);
	});

	test('a three-entry transitive chain converges in ONE sweep', async () => {
		// A~B (0.636) and B~C (0.636) WITHOUT A~C (0.385) is the case a greedy
		// "compare against the surviving representative" pass would leave
		// unconverged: C would stay active next to the winner and the NEXT sweep
		// would merge it. Union-find clustering closes the chain in one pass.
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a',
				confidence: 0.9,
				lesson: 'run focused unit tests before claiming the task is done',
			}),
			makeEntry({
				id: 'b',
				confidence: 0.5,
				lesson: 'unit tests before claiming the task is done and record',
			}),
			makeEntry({
				id: 'c',
				confidence: 0.1,
				lesson: 'before claiming the task is done and record command output',
			}),
		]);

		const first = await sweepActiveNearDuplicates(h.directory);
		const second = await sweepActiveNearDuplicates(h.directory);

		expect(first.merges.length).toBeGreaterThan(0);
		expect(second.merges).toHaveLength(0);
		const active = readEntries(h.knowledgePath).filter(
			(e) => e.status !== 'archived',
		);
		expect(active).toHaveLength(1);
	});

	test('an already-archived near-duplicate is never resurrected or re-merged', async () => {
		const archived: KnowledgeEntryBase = makeEntry({
			id: 'z-archived',
			status: 'archived',
			archived_from: 'candidate',
			archived_at: '2026-01-02T00:00:00.000Z',
		});
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-active', confidence: 0.9 }),
			archived,
		]);

		const result = await sweepActiveNearDuplicates(h.directory);

		expect(result.scanned).toBe(1);
		expect(result.comparisons).toBe(0);
		expect(result.merges).toHaveLength(0);
		const still = readEntries(h.knowledgePath).find(
			(e) => e.id === 'z-archived',
		)!;
		expect(still.status).toBe('archived');
		expect(
			(
				readEntries(h.knowledgePath).find(
					(e) => e.id === 'a-active',
				) as unknown as Record<string, unknown>
			).merged_from,
		).toBeUndefined();
	});

	test('the winner keeps no shared array with the entry it archived', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9, ...ACTIONABLE_FIELDS }),
			makeEntry({
				id: 'b-loser',
				confidence: 0.2,
				confirmed_by: [
					{
						phase_number: 3,
						confirmed_at: '2026-01-02T00:00:00.000Z',
						project_name: 'proj',
					},
				],
			}),
		]);

		await sweepActiveNearDuplicates(h.directory);

		// Round-tripped through JSONL, so reference identity cannot survive by
		// accident: the real proof is that the loser's own record is untouched.
		const after = readEntries(h.knowledgePath);
		const winner = after.find((e) => e.id === 'a-winner')!;
		const loser = after.find((e) => e.id === 'b-loser')!;
		expect(winner.confirmed_by).toHaveLength(1);
		expect(loser.confirmed_by).toHaveLength(1);
		expect(winner.confirmed_by).not.toBe(loser.confirmed_by);
	});
});

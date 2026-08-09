import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { resetGlobalEventBus } from '../../../src/background/event-bus.js';
import { runCuratorPhase } from '../../../src/hooks/curator.js';
import type { CuratorConfig } from '../../../src/hooks/curator-types.js';
import {
	type DedupSweepHarness,
	makeEntry,
	makeHarness,
	readEntries,
	readSwarmJsonl,
	writeEntries,
	writeProjectConfig,
} from './_dedup-sweep-helpers.js';

/**
 * WIRING proof for the dedup sweep (issue #1821 Lane A, Task 4).
 *
 * AGENTS.md treats unwired code as a blocker, so this file does not assert that
 * `runCuratorPhase` "calls a mock" — it runs the REAL curator phase against a
 * real temp project and asserts the sweep's observable side effects (an
 * archived loser, a merge note on the phase digest, a rewrite-history record).
 * A wiring regression that deleted the call site would fail every test here.
 *
 * `phase_complete`, the `curator_analyze` tool, and `/swarm curate` all funnel
 * through `runCuratorPhase`, so proving reachability here proves it for all
 * three entry points.
 */

const CURATOR_CONFIG: CuratorConfig = {
	enabled: true,
	init_enabled: true,
	phase_enabled: true,
	max_summary_tokens: 2000,
	min_knowledge_confidence: 0.7,
	compliance_report: true,
	suppress_warnings: true,
	drift_inject_max_chars: 500,
};

let h: DedupSweepHarness;

beforeEach(() => {
	h = makeHarness();
	resetGlobalEventBus();
});

afterEach(() => {
	h.cleanup();
	resetGlobalEventBus();
});

describe('runCuratorPhase — dedup sweep wiring', () => {
	test('a curator phase archives the near-duplicate loser', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2 }),
		]);

		await runCuratorPhase(h.directory, 1, ['reviewer'], CURATOR_CONFIG, {
			directory: h.directory,
		});

		const after = readEntries(h.knowledgePath);
		expect(after.find((e) => e.id === 'b-loser')!.status).toBe('archived');
		expect(after.find((e) => e.id === 'a-winner')!.status).toBe('candidate');
		expect(
			(
				after.find((e) => e.id === 'a-winner') as unknown as Record<
					string,
					unknown
				>
			).merged_from,
		).toEqual(['b-loser']);
	});

	test('the phase digest reports how many entries were merged', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2 }),
		]);

		const result = await runCuratorPhase(
			h.directory,
			1,
			['reviewer'],
			CURATOR_CONFIG,
			{ directory: h.directory },
		);

		expect(result.digest.summary).toContain(
			'1 duplicate knowledge entry merged',
		);
	});

	test('the digest note pluralizes for a multi-entry merge', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a', confidence: 0.9 }),
			makeEntry({ id: 'b', confidence: 0.5 }),
			makeEntry({ id: 'c', confidence: 0.1 }),
		]);

		const result = await runCuratorPhase(
			h.directory,
			1,
			['reviewer'],
			CURATOR_CONFIG,
			{ directory: h.directory },
		);

		expect(result.digest.summary).toContain(
			'2 duplicate knowledge entries merged',
		);
	});

	test('the curator phase writes the merge audit trail', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2 }),
		]);

		await runCuratorPhase(h.directory, 1, ['reviewer'], CURATOR_CONFIG, {
			directory: h.directory,
		});

		const history = readSwarmJsonl<{ action: string; entry_id: string }>(
			h.directory,
			'knowledge-rewrites.jsonl',
		);
		expect(history.filter((r) => r.action === 'merge')).toHaveLength(1);
		const tombstones = readSwarmJsonl<{ type: string; entry_id: string }>(
			h.directory,
			'knowledge-events.jsonl',
		).filter((e) => e.type === 'archived');
		expect(tombstones.map((t) => t.entry_id)).toEqual(['b-loser']);
	});

	test('the config flag disables the sweep from inside the curator phase', async () => {
		writeProjectConfig(h.directory, {
			learning: { dedup_sweep: { enabled: false } },
		});
		writeEntries(h.knowledgePath, [
			makeEntry({ id: 'a-winner', confidence: 0.9 }),
			makeEntry({ id: 'b-loser', confidence: 0.2 }),
		]);
		const before = fs.readFileSync(h.knowledgePath, 'utf-8');

		const result = await runCuratorPhase(
			h.directory,
			1,
			['reviewer'],
			CURATOR_CONFIG,
			{ directory: h.directory },
		);

		expect(fs.readFileSync(h.knowledgePath, 'utf-8')).toBe(before);
		expect(result.digest.summary).not.toContain('duplicate knowledge');
	});

	test('a phase with no duplicates leaves the digest note off', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a',
				lesson: 'prefer dependency injection over module level mocking',
			}),
			makeEntry({
				id: 'b',
				lesson: 'never hardcode absolute filesystem paths in shell scripts',
			}),
		]);

		const result = await runCuratorPhase(
			h.directory,
			1,
			['reviewer'],
			CURATOR_CONFIG,
			{ directory: h.directory },
		);

		expect(result.digest.summary).not.toContain('duplicate knowledge');
		expect(
			readEntries(h.knowledgePath).every((e) => e.status === 'candidate'),
		).toBe(true);
	});

	test('running two curator phases does not double-merge (idempotent under repeat)', async () => {
		writeEntries(h.knowledgePath, [
			makeEntry({
				id: 'a-winner',
				confidence: 0.9,
				retrieval_outcomes: {
					applied_count: 1,
					shown_count: 4,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
			}),
			makeEntry({
				id: 'b-loser',
				confidence: 0.2,
				retrieval_outcomes: {
					applied_count: 2,
					shown_count: 6,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
			}),
		]);

		await runCuratorPhase(h.directory, 1, ['reviewer'], CURATOR_CONFIG, {
			directory: h.directory,
		});
		const afterFirst = fs.readFileSync(h.knowledgePath, 'utf-8');

		// A DIFFERENT phase number, so the curator's own already-digested guard
		// cannot be what makes this a no-op — the sweep's own idempotency is.
		const second = await runCuratorPhase(
			h.directory,
			2,
			['reviewer'],
			CURATOR_CONFIG,
			{ directory: h.directory },
		);

		expect(second.already_digested).toBeUndefined();
		expect(second.digest.summary).not.toContain('duplicate knowledge');
		expect(fs.readFileSync(h.knowledgePath, 'utf-8')).toBe(afterFirst);
		const winner = readEntries(h.knowledgePath).find(
			(e) => e.id === 'a-winner',
		)!;
		expect(winner.retrieval_outcomes.applied_count).toBe(3);
		expect(winner.retrieval_outcomes.shown_count).toBe(10);
	});

	test('a curator phase still succeeds when the knowledge store is empty', async () => {
		fs.rmSync(h.knowledgePath, { force: true });

		const result = await runCuratorPhase(
			h.directory,
			1,
			['reviewer'],
			CURATOR_CONFIG,
			{ directory: h.directory },
		);

		expect(result.phase).toBe(1);
		expect(result.digest.summary).not.toContain('duplicate knowledge');
	});
});

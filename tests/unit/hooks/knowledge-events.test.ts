import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendKnowledgeEvent,
	KNOWLEDGE_EVENT_SCHEMA_VERSION,
	type KnowledgeEvent,
	MAX_EVENT_LOG_ENTRIES,
	readKnowledgeEvents,
	recomputeCounters,
	recordKnowledgeEvent,
	resolveKnowledgeEventsPath,
} from '../../../src/hooks/knowledge-events';
import type { KnowledgeApplicationRecord } from '../../../src/hooks/knowledge-types';

function tmp(): string {
	const dir = join(
		tmpdir(),
		`swarm-kevents-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe('knowledge-events: append + read', () => {
	let dir: string;
	beforeEach(() => {
		dir = tmp();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('fills event_id and timestamp when absent and writes a JSONL line', async () => {
		const written = await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 'trace-1',
			session_id: 's1',
			agent: 'architect',
			query: 'how to handle retries',
			retrieval_mode: 'manual',
			result_ids: ['a', 'b'],
			ranks: { a: 1, b: 2 },
			scores: { a: 0.9, b: 0.4 },
		} as unknown as KnowledgeEvent);

		expect(written.event_id).toBeTruthy();
		expect(written.timestamp).toBeTruthy();

		const filePath = resolveKnowledgeEventsPath(dir);
		expect(existsSync(filePath)).toBe(true);
		const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed.type).toBe('retrieved');
		expect(parsed.event_id).toBe(written.event_id);
	});

	it('preserves a caller-supplied event_id and timestamp', async () => {
		const written = await appendKnowledgeEvent(dir, {
			type: 'applied',
			event_id: 'fixed-id',
			trace_id: 't',
			knowledge_id: 'k1',
			timestamp: '2024-01-01T00:00:00.000Z',
			session_id: 's',
			agent: 'coder',
		});
		expect(written.event_id).toBe('fixed-id');
		expect(written.timestamp).toBe('2024-01-01T00:00:00.000Z');
	});

	it('readKnowledgeEvents returns [] when the file does not exist', async () => {
		expect(await readKnowledgeEvents(dir)).toEqual([]);
	});

	it('round-trips multiple events in append order', async () => {
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't1',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k1'],
			ranks: { k1: 1 },
			scores: { k1: 0.5 },
		} as unknown as KnowledgeEvent);
		await appendKnowledgeEvent(dir, {
			type: 'applied',
			trace_id: 't1',
			knowledge_id: 'k1',
			session_id: 's',
			agent: 'coder',
		} as unknown as KnowledgeEvent);

		const events = await readKnowledgeEvents(dir);
		expect(events.map((e) => e.type)).toEqual(['retrieved', 'applied']);
	});

	it('skips corrupted JSONL lines without throwing', async () => {
		const filePath = resolveKnowledgeEventsPath(dir);
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		const good = JSON.stringify({
			type: 'ignored',
			event_id: 'e',
			trace_id: 't',
			knowledge_id: 'k',
			timestamp: '2024-01-01T00:00:00.000Z',
			session_id: 's',
			agent: 'a',
		});
		writeFileSync(filePath, `${good}\n{ not json\n\n${good}\n`, 'utf-8');
		const events = await readKnowledgeEvents(dir);
		expect(events).toHaveLength(2);
	});

	it('recordKnowledgeEvent is fail-open and returns null on write failure', async () => {
		// A path whose parent is a file (not a dir) forces mkdir/append to fail.
		const filePath = join(dir, 'blocker');
		writeFileSync(filePath, 'x', 'utf-8');
		const result = await recordKnowledgeEvent(filePath, {
			type: 'applied',
			trace_id: 't',
			knowledge_id: 'k',
			session_id: 's',
			agent: 'coder',
		} as unknown as KnowledgeEvent);
		expect(result).toBeNull();
	});

	it('stamps schema_version on every written event', async () => {
		const written = await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't-sv',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: [],
			ranks: {},
			scores: {},
		} as unknown as KnowledgeEvent);
		expect(written.schema_version).toBe(KNOWLEDGE_EVENT_SCHEMA_VERSION);

		// And on the persisted line, so future readers can detect the shape.
		const filePath = resolveKnowledgeEventsPath(dir);
		const line = readFileSync(filePath, 'utf-8').trim().split('\n')[0];
		const parsed = JSON.parse(line);
		expect(parsed.schema_version).toBe(KNOWLEDGE_EVENT_SCHEMA_VERSION);
	});

	it('enforces a FIFO cap of MAX_EVENT_LOG_ENTRIES (oldest trimmed)', async () => {
		// MAX_EVENT_LOG_ENTRIES is too large to write in a unit test; this verifies
		// the cap behavior with a tiny synthetic file: write MAX+5 lines directly
		// and confirm that one more append triggers trim down to MAX.
		const filePath = resolveKnowledgeEventsPath(dir);
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		const lines: string[] = [];
		for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 5; i++) {
			lines.push(
				JSON.stringify({
					type: 'retrieved',
					schema_version: KNOWLEDGE_EVENT_SCHEMA_VERSION,
					event_id: `e-${i}`,
					trace_id: `t-${i}`,
					timestamp: new Date(2024, 0, 1, 0, 0, i).toISOString(),
					session_id: 's',
					agent: 'architect',
					query: 'q',
					retrieval_mode: 'manual',
					result_ids: [],
					ranks: {},
					scores: {},
				}),
			);
		}
		writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');

		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: 't-trigger',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: [],
			ranks: {},
			scores: {},
		} as unknown as KnowledgeEvent);

		const all = await readKnowledgeEvents(dir);
		// Cap is honored — the oldest entries were trimmed.
		expect(all.length).toBe(MAX_EVENT_LOG_ENTRIES);
		// The newest record (the one we just appended) is preserved.
		const newest = all[all.length - 1] as {
			trace_id?: string;
		};
		expect(newest.trace_id).toBe('t-trigger');
		// The very oldest entries are gone (e-0 was trimmed).
		expect(
			all.some((e) => (e as { event_id?: string }).event_id === 'e-0'),
		).toBe(false);
	});
});

describe('knowledge-events: recomputeCounters', () => {
	it('returns an empty map for no events', () => {
		expect(recomputeCounters([]).size).toBe(0);
	});

	it('counts shown from retrieved result_ids', () => {
		const events: KnowledgeEvent[] = [
			{
				type: 'retrieved',
				event_id: 'e1',
				trace_id: 't1',
				timestamp: '2024-01-01T00:00:00.000Z',
				session_id: 's',
				agent: 'architect',
				query: 'q',
				retrieval_mode: 'manual',
				result_ids: ['a', 'b'],
				ranks: { a: 1, b: 2 },
				scores: { a: 0.9, b: 0.4 },
			},
			{
				type: 'retrieved',
				event_id: 'e2',
				trace_id: 't2',
				timestamp: '2024-01-02T00:00:00.000Z',
				session_id: 's',
				agent: 'architect',
				query: 'q2',
				retrieval_mode: 'auto_injection',
				result_ids: ['a'],
				ranks: { a: 1 },
				scores: { a: 0.8 },
			},
		];
		const map = recomputeCounters(events);
		expect(map.get('a')?.shown_count).toBe(2);
		expect(map.get('b')?.shown_count).toBe(1);
	});

	it('tallies receipt verbs and tracks last_applied_at / last_acknowledged_at as the max timestamp', () => {
		const mk = (
			type:
				| 'applied'
				| 'acknowledged'
				| 'ignored'
				| 'violated'
				| 'contradicted',
			ts: string,
		): KnowledgeEvent => ({
			type,
			event_id: `${type}-${ts}`,
			trace_id: 't',
			knowledge_id: 'k1',
			timestamp: ts,
			session_id: 's',
			agent: 'coder',
		});
		const map = recomputeCounters([
			mk('applied', '2024-01-01T00:00:00.000Z'),
			mk('applied', '2024-03-01T00:00:00.000Z'),
			mk('acknowledged', '2024-02-01T00:00:00.000Z'),
			mk('ignored', '2024-01-05T00:00:00.000Z'),
			mk('violated', '2024-01-06T00:00:00.000Z'),
			mk('contradicted', '2024-01-07T00:00:00.000Z'),
		]);
		const r = map.get('k1');
		expect(r).toBeDefined();
		expect(r?.applied_explicit_count).toBe(2);
		expect(r?.acknowledged_count).toBe(1);
		expect(r?.ignored_count).toBe(1);
		expect(r?.violated_count).toBe(1);
		expect(r?.contradicted_count).toBe(1);
		expect(r?.last_applied_at).toBe('2024-03-01T00:00:00.000Z');
		expect(r?.last_acknowledged_at).toBe('2024-02-01T00:00:00.000Z');
	});

	it('attributes outcome events to succeeded/failed/partial counters separately', () => {
		const mk = (
			outcome: 'success' | 'failure' | 'partial',
			ts: string,
		): KnowledgeEvent => ({
			type: 'outcome',
			event_id: `o-${ts}`,
			knowledge_id: 'k1',
			timestamp: ts,
			outcome,
			evidence_summary: 'x',
		});
		const map = recomputeCounters([
			mk('success', '2024-01-01T00:00:00.000Z'),
			mk('success', '2024-01-02T00:00:00.000Z'),
			mk('failure', '2024-01-03T00:00:00.000Z'),
			mk('partial', '2024-01-04T00:00:00.000Z'),
			mk('partial', '2024-01-05T00:00:00.000Z'),
		]);
		const r = map.get('k1');
		expect(r?.succeeded_after_shown_count).toBe(2);
		expect(r?.failed_after_shown_count).toBe(1);
		// 'partial' outcomes are tracked in their own counter so they surface in
		// diagnostics but do NOT contribute to computeOutcomeSignal (deliberately
		// neutral — partial is ambiguous).
		expect(r?.partial_after_shown_count).toBe(2);
	});

	it('ignores outcome events without a knowledge_id', () => {
		const map = recomputeCounters([
			{
				type: 'outcome',
				event_id: 'o1',
				timestamp: '2024-01-01T00:00:00.000Z',
				outcome: 'success',
				evidence_summary: 'task-level only',
			},
		]);
		expect(map.size).toBe(0);
	});

	it('does not let archived events contribute to counters', () => {
		const map = recomputeCounters([
			{
				type: 'archived',
				event_id: 'a1',
				timestamp: '2024-01-01T00:00:00.000Z',
				entry_id: 'k1',
				actor: 'architect',
				reason: 'stale',
				mode: 'archive',
			},
		]);
		expect(map.size).toBe(0);
	});

	it('is deterministic regardless of event order', () => {
		const events: KnowledgeEvent[] = [
			{
				type: 'applied',
				event_id: 'e1',
				trace_id: 't',
				knowledge_id: 'k',
				timestamp: '2024-01-02T00:00:00.000Z',
				session_id: 's',
				agent: 'c',
			},
			{
				type: 'applied',
				event_id: 'e2',
				trace_id: 't',
				knowledge_id: 'k',
				timestamp: '2024-01-01T00:00:00.000Z',
				session_id: 's',
				agent: 'c',
			},
		];
		const a = recomputeCounters(events).get('k');
		const b = recomputeCounters([...events].reverse()).get('k');
		expect(a).toEqual(b);
		expect(a?.last_applied_at).toBe('2024-01-02T00:00:00.000Z');
	});
});

describe('knowledge-events: legacy folding', () => {
	const legacy = (
		result: KnowledgeApplicationRecord['result'],
		ts: string,
		knowledgeId = 'k1',
	): KnowledgeApplicationRecord => ({
		timestamp: ts,
		knowledgeId,
		result,
	});

	it('folds all legacy records when the event log is empty', () => {
		const map = recomputeCounters(
			[],
			[
				legacy('shown', '2024-01-01T00:00:00.000Z'),
				legacy('applied', '2024-01-02T00:00:00.000Z'),
			],
		);
		const r = map.get('k1');
		expect(r?.shown_count).toBe(1);
		expect(r?.applied_explicit_count).toBe(1);
	});

	it('folds legacy shown only when no retrieved event exists (race-free)', () => {
		const retrieved: KnowledgeEvent = {
			type: 'retrieved',
			event_id: 'e1',
			trace_id: 't',
			timestamp: '2024-06-01T00:00:00.000Z',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k1'],
			ranks: { k1: 1 },
			scores: { k1: 0.5 },
		};
		// The injector dual-writes a legacy 'shown' AND a 'retrieved' event for the
		// same injection. With a retrieved event present, the legacy 'shown' must
		// NOT be folded — shown_count comes from events alone (1, not 2).
		const withEvent = recomputeCounters(
			[retrieved],
			[legacy('shown', '2024-06-01T00:00:00.001Z')],
		);
		expect(withEvent.get('k1')?.shown_count).toBe(1);

		// With no retrieved event (pure pre-migration), the legacy 'shown' counts.
		const noEvent = recomputeCounters(
			[],
			[legacy('shown', '2024-06-01T00:00:00.001Z')],
		);
		expect(noEvent.get('k1')?.shown_count).toBe(1);
	});

	it('always folds legacy non-shown verbs (no event-log counterpart)', () => {
		const retrieved: KnowledgeEvent = {
			type: 'retrieved',
			event_id: 'e1',
			trace_id: 't',
			timestamp: '2024-06-01T00:00:00.000Z',
			session_id: 's',
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'manual',
			result_ids: ['k1'],
			ranks: { k1: 1 },
			scores: { k1: 0.5 },
		};
		const map = recomputeCounters(
			[retrieved],
			[
				legacy('applied', '2024-05-01T00:00:00.000Z'),
				legacy('ignored', '2024-07-01T00:00:00.000Z'),
			],
		);
		const r = map.get('k1');
		// shown from the event; applied/ignored from legacy (no double count).
		expect(r?.shown_count).toBe(1);
		expect(r?.applied_explicit_count).toBe(1);
		expect(r?.ignored_count).toBe(1);
	});
});

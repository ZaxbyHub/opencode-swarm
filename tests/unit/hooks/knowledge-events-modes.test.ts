/**
 * Tests that the `delegate_inject` retrieval mode (Change 1 / Task 1.2) is a
 * first-class RetrievalEventMode: it round-trips through the append/read event
 * log and its result_ids feed the deterministic counter rollup exactly like the
 * other retrieval modes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendKnowledgeEvent,
	appendKnowledgeEventsBatch,
	type CounterRollup,
	RECEIPT_EVENT_TYPES,
	type RetrievalEventMode,
	readKnowledgeEvents,
	recomputeCounters,
} from '../../../src/hooks/knowledge-events.js';

describe('delegate_inject retrieval mode', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ke-modes-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('is accepted by the type system as a RetrievalEventMode', () => {
		const modes: RetrievalEventMode[] = [
			'manual',
			'auto_injection',
			'coder_context',
			'review_context',
			'curator',
			'delegate_inject',
		];
		expect(modes).toContain('delegate_inject');
	});

	it('round-trips a delegate_inject retrieved event through the log', async () => {
		await appendKnowledgeEvent(tempDir, {
			type: 'retrieved',
			trace_id: 'trace-1',
			session_id: 'sess-1',
			agent: 'coder',
			query: 'implement the feature',
			retrieval_mode: 'delegate_inject',
			result_ids: ['k-1', 'k-2'],
			ranks: { 'k-1': 1, 'k-2': 2 },
			scores: { 'k-1': 0.9, 'k-2': 0.8 },
		});

		const events = await readKnowledgeEvents(tempDir);
		expect(events.length).toBe(1);
		const ev = events[0];
		if (ev.type !== 'retrieved') throw new Error('expected retrieved');
		expect(ev.retrieval_mode).toBe('delegate_inject');
		expect(ev.agent).toBe('coder');
		expect(ev.result_ids).toEqual(['k-1', 'k-2']);
	});

	it('counts delegate_inject result_ids in the shown_count rollup', async () => {
		await appendKnowledgeEvent(tempDir, {
			type: 'retrieved',
			trace_id: 'trace-2',
			session_id: 'sess-2',
			agent: 'reviewer',
			query: 'review',
			retrieval_mode: 'delegate_inject',
			result_ids: ['k-9'],
			ranks: { 'k-9': 1 },
			scores: { 'k-9': 0.7 },
		});

		const events = await readKnowledgeEvents(tempDir);
		const rollup = recomputeCounters(events);
		expect(rollup.get('k-9')?.shown_count).toBe(1);
	});
});

/**
 * `unacknowledged` is the audit-only signal that a shown NON-critical directive
 * reached the end of a delegate Task with no ack marker and no receipt. It is an
 * observation, not a verdict: it must never move a counter, or it would corrupt
 * the application-rate and violation-rate denominators that ranking, promotion
 * and escalation read.
 */
describe('unacknowledged receipt event is counter-neutral', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ke-unack-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function unackEvent(id: string) {
		return {
			type: 'unacknowledged' as const,
			trace_id: 'trace-unack',
			knowledge_id: id,
			session_id: 'sess-unack',
			agent: 'coder',
			source: 'delegate',
			reason: 'no_ack_marker',
		};
	}

	it('round-trips through the event log', async () => {
		await appendKnowledgeEvent(tempDir, unackEvent('k-unack'));
		const events = await readKnowledgeEvents(tempDir);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('unacknowledged');
		expect((events[0] as { knowledge_id?: string }).knowledge_id).toBe(
			'k-unack',
		);
	});

	it('creates no rollup entry at all when it is the only event for an id', async () => {
		await appendKnowledgeEvent(tempDir, unackEvent('k-only'));
		const rollup = recomputeCounters(await readKnowledgeEvents(tempDir));
		// Not merely all-zero — the switch case never touches the map, so no
		// phantom entry is materialized for a silently-delivered directive.
		expect(rollup.get('k-only')).toBeUndefined();
	});

	it('leaves every counter byte-identical to a log without it', async () => {
		const base = [
			{
				type: 'retrieved' as const,
				trace_id: 'trace-unack',
				session_id: 'sess-unack',
				agent: 'coder',
				query: 'work',
				retrieval_mode: 'delegate_inject' as const,
				result_ids: ['k-mix'],
				ranks: { 'k-mix': 1 },
				scores: { 'k-mix': 0.9 },
			},
		];
		for (const e of base) await appendKnowledgeEvent(tempDir, e);
		const before = recomputeCounters(await readKnowledgeEvents(tempDir));

		await appendKnowledgeEvent(tempDir, unackEvent('k-mix'));
		const after = recomputeCounters(await readKnowledgeEvents(tempDir));

		const b = before.get('k-mix') as CounterRollup;
		const a = after.get('k-mix') as CounterRollup;
		expect(a).toEqual(b);
		// Spell out the counters silence must never be misfiled into.
		expect(a.shown_count).toBe(1);
		expect(a.ignored_count).toBe(0);
		expect(a.violated_count).toBe(0);
		expect(a.n_a_count).toBe(0);
		expect(a.acknowledged_count).toBe(0);
		expect(a.applied_explicit_count).toBe(0);
		expect(a.violation_timestamps).toEqual([]);
	});

	it('is intentionally excluded from RECEIPT_EVENT_TYPES', () => {
		// It is not a terminal the delegate filed, so it must never satisfy a
		// terminal / idempotency / conflict allowlist built from this set.
		expect(RECEIPT_EVENT_TYPES.has('unacknowledged')).toBe(false);
		expect(RECEIPT_EVENT_TYPES.has('n_a')).toBe(true);
	});
});

/**
 * Multi-event emitters on awaited paths (the ack-collector's silence loop) use
 * one lock/append/trim cycle for the whole batch instead of N sequential
 * appends. The batch must be byte-compatible with N single appends.
 */
describe('appendKnowledgeEventsBatch', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ke-batch-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('writes all events in order with populated ids and timestamps', async () => {
		const written = await appendKnowledgeEventsBatch(tempDir, [
			{
				type: 'unacknowledged',
				trace_id: 't-batch',
				knowledge_id: 'k-b1',
				session_id: 's-b',
				agent: 'coder',
			},
			{
				type: 'unacknowledged',
				trace_id: 't-batch',
				knowledge_id: 'k-b2',
				session_id: 's-b',
				agent: 'coder',
			},
		]);
		expect(written).toHaveLength(2);
		for (const w of written) {
			expect(w.event_id.length).toBeGreaterThan(0);
			expect(w.timestamp.length).toBeGreaterThan(0);
		}
		const events = await readKnowledgeEvents(tempDir);
		expect(
			events.map((e) => (e as { knowledge_id?: string }).knowledge_id),
		).toEqual(['k-b1', 'k-b2']);
	});

	it('is a no-op for an empty batch (no file, no lock churn)', async () => {
		const written = await appendKnowledgeEventsBatch(tempDir, []);
		expect(written).toEqual([]);
		expect(
			fs.existsSync(path.join(tempDir, '.swarm', 'knowledge-events.jsonl')),
		).toBe(false);
	});

	it('single-event appendKnowledgeEvent still round-trips through the batch path', async () => {
		const written = await appendKnowledgeEvent(tempDir, {
			type: 'unacknowledged',
			trace_id: 't-single',
			knowledge_id: 'k-single',
			session_id: 's-single',
			agent: 'coder',
		});
		expect(written.event_id.length).toBeGreaterThan(0);
		const events = await readKnowledgeEvents(tempDir);
		expect(events).toHaveLength(1);
	});
});

/**
 * Unit tests for the authoritative V2 receipt validator (issue #1849).
 *
 * Uses a real temp `.swarm` project and durable on-disk receipt/legacy-event
 * files, so the validator exercises its real V2-ledger authority and
 * pre-cutover fallback paths. No `mock.module` — the validator is a pure
 * function of (ctx, durable receipt state on disk).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendKnowledgeEvent,
	newTraceId,
} from '../../../src/hooks/knowledge-events';
import {
	NO_TRACE_SENTINEL,
	type ReceiptItem,
	validateReceipt,
} from '../../../src/hooks/knowledge-receipt-validator';

const SESSION = 'sess-validator';

function tmpSwarmDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rv-'));
	fs.mkdirSync(path.join(d, '.swarm'), { recursive: true });
	return d;
}

function rmrf(d: string): void {
	fs.rmSync(d, { recursive: true, force: true });
}

/** Write a retrieved event so a trace exists for receipts to reference. */
async function seedTrace(
	dir: string,
	traceId: string,
	resultIds: string[],
	ageMs = 0,
	sessionId = SESSION,
): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: 'retrieved',
		trace_id: traceId,
		session_id: sessionId,
		agent: 'architect',
		query: 'test',
		retrieval_mode: 'auto_injection',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: new Date(Date.now() - ageMs).toISOString(),
	});
}

async function seedPriorReceipt(
	dir: string,
	traceId: string,
	id: string,
	outcome: ReceiptItem['outcome'],
): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: outcome,
		trace_id: traceId,
		knowledge_id: id,
		session_id: SESSION,
		agent: 'coder',
		timestamp: new Date().toISOString(),
	});
}

function ctx(
	dir: string,
	traceId: string,
	items: ReceiptItem[],
	opts: { no_relevant?: boolean; session?: string } = {},
) {
	return {
		directory: dir,
		trace_id: traceId,
		session_id: opts.session ?? SESSION,
		agent: 'coder',
		items,
		no_relevant_knowledge: opts.no_relevant ?? false,
	};
}

describe('receipt validator', () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpSwarmDir();
	});
	afterEach(() => {
		rmrf(dir);
	});

	test('accepts a valid applied receipt for an id returned by the trace', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1', 'k2']);
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(1);
		expect(r.accepted[0].id).toBe('k1');
		expect(r.idempotent_skips).toHaveLength(0);
		expect(r.trace?.trace_id).toBe(traceId);
	});

	test('fails closed when a pre-cutover trace cannot be proven to exist', async () => {
		const r = await validateReceipt(
			ctx(dir, newTraceId(), [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('legacy_unverifiable');
	});

	test('rejects an id NOT returned by the trace (forged application)', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'forged-id', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('id_not_in_trace');
	});

	test('rejects a receipt from the wrong session', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1'], 0, 'other-session');
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'applied' }], {
				session: 'attacker-session',
			}),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('wrong_session');
	});

	test('imports a complete multi-day pre-cutover membership that is not proven closed', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1'], 3 * 86_400_000);
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(true);
	});

	test('reports malformed pre-cutover membership time as unverifiable', async () => {
		const traceId = newTraceId();
		// Seed a trace with a garbage timestamp directly via appendKnowledgeEvent.
		await appendKnowledgeEvent(dir, {
			type: 'retrieved',
			trace_id: traceId,
			session_id: SESSION,
			agent: 'architect',
			query: 'q',
			retrieval_mode: 'auto_injection',
			result_ids: ['k1'],
			ranks: { k1: 1 },
			scores: { k1: 1 },
			timestamp: 'not-a-real-date',
		});
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('legacy_unverifiable');
	});

	test('(#PRR-007) intra-receipt duplicate id in applied+ignored is a conflicting-terminal rejection', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		// Same id in two outcome arrays within one receipt.
		const r = await validateReceipt(
			ctx(dir, traceId, [
				{ id: 'k1', outcome: 'applied' },
				{ id: 'k1', outcome: 'ignored' },
			]),
		);
		// The first applied is accepted; the second ignored is rejected as
		// duplicate_conflicting_terminal (one terminal per (trace, knowledge_id)).
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(1);
		expect(r.accepted[0].outcome).toBe('applied');
		expect(r.rejected_items).toBeDefined();
		expect(r.rejected_items?.[0].reason).toBe('duplicate_conflicting_terminal');
	});

	test('idempotent retry: same outcome for same (trace, id) is accepted as a skip, not re-counted', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		await seedPriorReceipt(dir, traceId, 'k1', 'applied');
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(0); // NOT re-emitted
		expect(r.idempotent_skips).toHaveLength(1);
	});

	test('conflicting terminal: different outcome for same (trace, id) is rejected', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		await seedPriorReceipt(dir, traceId, 'k1', 'applied');
		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'ignored' }]),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('duplicate_conflicting_terminal');
	});

	test('one terminal per (trace, id): multiple DISTINCT ids in one trace are each accepted', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1', 'k2', 'k3']);
		const r = await validateReceipt(
			ctx(dir, traceId, [
				{ id: 'k1', outcome: 'applied' },
				{ id: 'k2', outcome: 'ignored' },
				{ id: 'k3', outcome: 'contradicted' },
			]),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(3);
	});

	test('same id in DIFFERENT traces is independent (per-(trace,id) grain)', async () => {
		const traceA = newTraceId();
		const traceB = newTraceId();
		await seedTrace(dir, traceA, ['k1']);
		await seedTrace(dir, traceB, ['k1']);
		await seedPriorReceipt(dir, traceA, 'k1', 'applied');
		// Trace B has no prior receipt for k1 → accepted even though traceA did.
		const r = await validateReceipt(
			ctx(dir, traceB, [{ id: 'k1', outcome: 'ignored' }]),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(1);
	});

	test('no_relevant_knowledge with the "none" sentinel is accepted as a real-empty terminal', async () => {
		const r = await validateReceipt(
			ctx(dir, NO_TRACE_SENTINEL, [], {
				no_relevant: true,
			}),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.closes_no_relevant).toBe(true);
		expect(r.accepted).toHaveLength(0);
		expect(r.trace).toBeNull();
	});

	test('no_relevant_knowledge combined with items is rejected', async () => {
		const r = await validateReceipt(
			ctx(dir, NO_TRACE_SENTINEL, [{ id: 'k1', outcome: 'applied' }], {
				no_relevant: true,
			}),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('invalid_outcome');
	});

	test('items filed against the "none" sentinel trace are rejected', async () => {
		const r = await validateReceipt(
			ctx(dir, NO_TRACE_SENTINEL, [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('trace_not_found');
	});

	test('empty receipt (no items, no no_relevant) is rejected', async () => {
		const r = await validateReceipt(ctx(dir, newTraceId(), []));
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('empty_receipt');
	});

	test('partial acceptance: some items accepted, some rejected (id_not_in_trace)', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1', 'k2']);
		const r = await validateReceipt(
			ctx(dir, traceId, [
				{ id: 'k1', outcome: 'applied' },
				{ id: 'forged', outcome: 'applied' },
			]),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(1);
		expect(r.accepted[0].id).toBe('k1');
		expect(r.rejected_items).toHaveLength(1);
		expect(r.rejected_items?.[0].reason).toBe('id_not_in_trace');
	});

	test('fresh pre-cutover log cannot prove an unknown trace was never evicted', async () => {
		// readKnowledgeEvents returns [] when the file is absent, so the validator
		// sees no trace — the correct, non-fail-open outcome. (Fail-open only
		// triggers on a genuine readFile I/O exception, which readKnowledgeEvents
		// itself guards against for missing/corrupt files.)
		const r = await validateReceipt(
			ctx(dir, newTraceId(), [{ id: 'k1', outcome: 'applied' }]),
		);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('legacy_unverifiable');
	});

	test('the "none" no_relevant terminal is accepted on a fresh log (no trace lookup needed)', async () => {
		const r = await validateReceipt(
			ctx(dir, NO_TRACE_SENTINEL, [], { no_relevant: true }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.closes_no_relevant).toBe(true);
	});

	test('an unacknowledged event does not block a later real terminal for the same (trace, id)', async () => {
		// The delegate-ack collector emits `unacknowledged` for a shown non-critical
		// directive the delegate never answered for. It is an OBSERVATION, not a
		// terminal — so it must not enter the validator's prior-terminal index. If
		// it did, a later real receipt for the same (trace, knowledge_id) would be
		// misread as either an idempotent retry or a conflicting terminal, and the
		// delegate's actual verdict would be silently discarded.
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		await appendKnowledgeEvent(dir, {
			type: 'unacknowledged',
			trace_id: traceId,
			knowledge_id: 'k1',
			session_id: SESSION,
			agent: 'coder',
			source: 'delegate',
			reason: 'no_ack_marker',
			timestamp: new Date().toISOString(),
		});

		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'applied' }]),
		);

		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.accepted).toHaveLength(1);
		expect(r.accepted[0].id).toBe('k1');
		expect(r.idempotent_skips).toHaveLength(0);
		expect(r.rejected_items ?? []).toHaveLength(0);
	});

	test('a real terminal after an unacknowledged event still conflicts with a DIFFERENT later outcome', async () => {
		// Guards the other direction: ignoring `unacknowledged` must not weaken the
		// one-terminal-per-(trace, id) rule for the terminals that do count.
		const traceId = newTraceId();
		await seedTrace(dir, traceId, ['k1']);
		await appendKnowledgeEvent(dir, {
			type: 'unacknowledged',
			trace_id: traceId,
			knowledge_id: 'k1',
			session_id: SESSION,
			agent: 'coder',
			source: 'delegate',
			reason: 'no_ack_marker',
			timestamp: new Date().toISOString(),
		});
		await seedPriorReceipt(dir, traceId, 'k1', 'applied');

		const r = await validateReceipt(
			ctx(dir, traceId, [{ id: 'k1', outcome: 'ignored' }]),
		);

		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.reason).toBe('duplicate_conflicting_terminal');
	});
});

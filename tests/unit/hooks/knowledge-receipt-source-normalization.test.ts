/**
 * Receipt terminal source normalization (issue #2032 review F-001 + PRR-004).
 *
 * Split from knowledge-receipt-validator.test.ts at the FR-006 500-line cap.
 * Each case gets its own directory + trace: after the first V2 commit in a
 * directory the cutover is complete, so a second seeded legacy trace would
 * never import — one trace per directory is the validator-test invariant.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	appendKnowledgeEvent,
	newTraceId,
} from '../../../src/hooks/knowledge-events';
import { queryLiveMemberships } from '../../../src/hooks/knowledge-receipt-ledger';
import {
	type ReceiptItem,
	validateReceipt,
} from '../../../src/hooks/knowledge-receipt-validator';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION = 'sess-source-norm';

let dir: string;
beforeEach(() => {
	dir = canonicalMkdtemp('receipt-source-norm-');
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function seedTrace(resultIds: string[]): Promise<string> {
	const traceId = newTraceId();
	await appendKnowledgeEvent(dir, {
		type: 'retrieved',
		trace_id: traceId,
		session_id: SESSION,
		agent: 'architect',
		query: 'source-norm',
		retrieval_mode: 'auto_injection',
		result_ids: resultIds,
		ranks: Object.fromEntries(resultIds.map((id, i) => [id, i + 1])),
		scores: Object.fromEntries(resultIds.map((id) => [id, 1])),
		timestamp: '2026-01-01T00:00:00.000Z',
	});
	return traceId;
}

async function commitWithSource(
	traceId: string,
	source: string,
): Promise<void> {
	const items: ReceiptItem[] = [{ id: 'k1', outcome: 'applied' }];
	const r = await validateReceipt({
		directory: dir,
		trace_id: traceId,
		session_id: SESSION,
		agent: 'coder',
		source,
		items,
		no_relevant_knowledge: false,
	});
	expect(r.ok).toBe(true);
}

async function terminalSource(): Promise<string | undefined> {
	const state = await queryLiveMemberships(dir, {
		session_id: SESSION,
		include_terminal: true,
	});
	expect(state.ok).toBe(true);
	if (!state.ok) return undefined;
	return state.memberships.find((m) => m.entry_id === 'k1')?.terminal?.source;
}

describe('receipt source normalization (#2032 F-001 / PRR-004)', () => {
	test('an out-of-taxonomy source (typo or agent name) normalizes to unknown at the commit boundary', async () => {
		// Previous behavior: any string passed `typeof === 'string'` and was
		// persisted verbatim, so the canonical taxonomy was docs-only. Now the
		// honest 'unknown' class — NOT a hard reject (legacy tolerance kept).
		const traceId = await seedTrace(['k1']);
		await commitWithSource(traceId, 'delegte');
		expect(await terminalSource()).toBe('unknown');
	});

	test('canonical sources pass through verbatim', async () => {
		const traceId = await seedTrace(['k1']);
		await commitWithSource(traceId, 'reviewer');
		expect(await terminalSource()).toBe('reviewer');
	});

	test('a whitespace-only source stamps unknown, never an unbounded-code string', async () => {
		// Previously persisted verbatim while telemetry's BOUNDED_CODE gate
		// silently dropped it — a ledger/telemetry divergence.
		const traceId = await seedTrace(['k1']);
		await commitWithSource(traceId, '   ');
		expect(await terminalSource()).toBe('unknown');
	});

	test('a legacy terminal with a non-canonical source imports as unknown, never inferred', async () => {
		// Pre-#2032 dual-writes sometimes carried agent names as source
		// ('coder'). Legacy ambiguity types as 'unknown' at cutover import;
		// the original string remains in the legacy event log for audit.
		const traceId = await seedTrace(['k1']);
		await appendKnowledgeEvent(dir, {
			type: 'applied',
			event_id: 'evt-legacy-coder-src',
			trace_id: traceId,
			knowledge_id: 'k1',
			timestamp: '2026-01-05T00:00:00.000Z',
			session_id: SESSION,
			agent: 'coder',
			source: 'coder',
		});
		const state = await queryLiveMemberships(dir, {
			session_id: SESSION,
			include_terminal: true,
		});
		expect(state.ok).toBe(true);
		if (!state.ok) return;
		const terminal = state.memberships.find(
			(m) => m.trace_id === traceId && m.entry_id === 'k1',
		)?.terminal;
		expect(terminal?.outcome).toBe('applied');
		expect(terminal?.source).toBe('unknown');
	});
});

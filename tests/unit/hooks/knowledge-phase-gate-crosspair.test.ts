/**
 * Cross-pair phase-complete directive gate coverage (issue #2032 review,
 * PRR-011). Split into its own file because the matrix test sits 9 lines
 * under the FR-006 500-line cap.
 *
 * Pins the gate's per-membership resolution: one critical cleared via a
 * reasoned n_a terminal while a sibling critical on the same trace stays
 * pending must block on the pending one ONLY — the n_a-cleared directive
 * never appears in `unresolved` and never masks its sibling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	appendKnowledgeEvent,
	newTraceId,
} from '../../../src/hooks/knowledge-events';
import {
	type ReceiptItem,
	validateReceipt,
} from '../../../src/hooks/knowledge-receipt-validator';
import { evaluatePhaseCriticalDirectives } from '../../../src/hooks/phase-complete-directive-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION = 'sess-crosspair';
const PHASE = 'Phase 1';
const FIXED_NOW_ISO = '2026-01-01T00:00:00.000Z';
const ID_CLEARED = '11111111-1111-4111-8111-111111111111';
const ID_PENDING = '22222222-2222-4222-8222-222222222222';

async function seedTrace(dir: string, traceId: string): Promise<void> {
	await appendKnowledgeEvent(dir, {
		type: 'retrieved',
		trace_id: traceId,
		session_id: SESSION,
		phase: PHASE,
		agent: 'architect',
		query: 'crosspair',
		retrieval_mode: 'auto_injection',
		result_ids: [ID_CLEARED, ID_PENDING],
		ranks: { [ID_CLEARED]: 1, [ID_PENDING]: 2 },
		scores: { [ID_CLEARED]: 1, [ID_PENDING]: 1 },
		timestamp: FIXED_NOW_ISO,
	});
}

async function commitTerminal(
	dir: string,
	traceId: string,
	items: ReceiptItem[],
): Promise<void> {
	const r = await validateReceipt({
		directory: dir,
		trace_id: traceId,
		session_id: SESSION,
		phase: PHASE,
		agent: 'coder',
		source: 'delegate',
		items,
		no_relevant_knowledge: false,
	});
	if (!r.ok) throw new Error(`terminal fixture failed: ${r.reason ?? 'ok'}`);
}

describe('phase-complete directive gate — cross-pair resolution (#2032 PRR-011)', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('phase-gate-crosspair-');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('an n_a-cleared critical blocks on its pending sibling only', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId);
		await commitTerminal(dir, traceId, [
			{
				id: ID_CLEARED,
				outcome: 'n_a',
				reason: 'targets web routing; task is CLI-only',
			},
		]);

		const gate = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: SESSION,
			phaseLabel: PHASE,
		});
		expect(gate.failedClosed).toBe(false);
		expect(gate.blocked).toBe(true);
		expect(gate.unresolved).toHaveLength(1);
		expect(gate.unresolved[0]?.id).toBe(ID_PENDING);
		expect(gate.unresolved[0]?.reason).toBe('no_verdict');
		// The n_a-cleared directive is resolved and must not appear.
		expect(gate.unresolved.some((u) => u.id === ID_CLEARED)).toBe(false);
	});

	test('clearing the sibling too unblocks the phase', async () => {
		const traceId = newTraceId();
		await seedTrace(dir, traceId);
		await commitTerminal(dir, traceId, [
			{ id: ID_CLEARED, outcome: 'n_a', reason: 'different subsystem' },
			{ id: ID_PENDING, outcome: 'applied' },
		]);

		const gate = await evaluatePhaseCriticalDirectives({
			directory: dir,
			sessionId: SESSION,
			phaseLabel: PHASE,
		});
		expect(gate.failedClosed).toBe(false);
		expect(gate.blocked).toBe(false);
		expect(gate.unresolved).toHaveLength(0);
	});
});

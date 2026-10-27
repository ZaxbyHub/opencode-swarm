/**
 * Directive-gate failure classifier for the receipt conflict codes (#2965,
 * Workstream J slot J15) — split from knowledge-receipt-empty-trace-conflict
 * .test.ts to respect the FR-006 500-line cap. Synthetic seam tests: they
 * drive `_internals.classifyDirectiveGateFailure` directly and are NOT
 * end-to-end gate evidence (the classifier is a defensive design-step-5
 * deliverable, not reachable from today's production gate inputs).
 */
import { describe, expect, test } from 'bun:test';
import { _internals as gateInternals } from '../../../src/hooks/phase-complete-directive-gate.js';

describe('directive-gate failure classifier (#2965, synthetic seam tests)', () => {
	test('ledger-shaped conflict codes map to RECEIPT_CONFLICT ahead of detail sniffing', () => {
		const transientLacedDetail =
			'conflicting immutable empty retrieval for none/sess — temporarily unavailable, transient, EBUSY';
		for (const code of [
			'wrong_task',
			'wrong_phase',
			'duplicate_conflicting_terminal',
		] as const) {
			const classified = gateInternals.classifyDirectiveGateFailure({
				ok: false,
				code,
				detail: transientLacedDetail,
			});
			expect(classified.failure?.code).toBe('RECEIPT_CONFLICT');
			expect(classified.recovery?.kind).toBe('tool');
			expect(classified.recovery?.action).toBe('knowledge_receipt');
		}
	});

	test('validator-shaped rejections (reason field) classify as RECEIPT_CONFLICT too', () => {
		const classified = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			rejected: true,
			reason: 'wrong_task',
			detail:
				'conflicting immutable empty retrieval for none/sess — temporarily unavailable, transient, EBUSY',
		});
		expect(classified.failure?.code).toBe('RECEIPT_CONFLICT');
		expect(classified.recovery?.kind).toBe('tool');
		expect(classified.recovery?.action).toBe('knowledge_receipt');
	});

	test('genuine transient store failure still classifies as retry', () => {
		const classified = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			code: 'store_unavailable',
			detail: 'the operation was temporarily unavailable (EBUSY)',
		});
		expect(classified.failure?.code).toBe('RECEIPT_TRANSIENT');
		expect(classified.recovery?.kind).toBe('retry');
	});

	test('store_corrupt and lock_timeout arms are unchanged', () => {
		const corrupt = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			code: 'store_corrupt',
			detail: 'journal hash mismatch',
		});
		expect(corrupt.failure?.code).toBe('RECEIPT_CORRUPT');
		expect(corrupt.recovery?.action).toBe('repair_knowledge_receipt_ledger');
		const lock = gateInternals.classifyDirectiveGateFailure({
			ok: false,
			code: 'lock_timeout',
			detail: 'receipt correctness lock unavailable before bounded timeout',
		});
		expect(lock.failure?.code).toBe('RECEIPT_LOCK_TIMEOUT');
		expect(lock.recovery?.kind).toBe('retry');
	});
});

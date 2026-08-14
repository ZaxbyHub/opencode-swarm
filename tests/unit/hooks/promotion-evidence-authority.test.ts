import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	ReceiptMembership,
	ReceiptTerminal,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import type { PromotionEvidenceRecord } from '../../../src/hooks/knowledge-types.js';
import {
	_internals,
	appendPromotionEvidence,
	loadPromotionEvidenceByEntry,
} from '../../../src/hooks/promotion-evidence-store.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalQueryHistoricalOutcomes = _internals.queryHistoricalOutcomes;
let directory: string;

function membership(
	entryId: string,
	outcome: 'applied' | 'ignored' | 'violated' | 'contradicted',
	index: number,
): ReceiptMembership {
	return {
		trace_id: `trace-${index}`,
		entry_id: entryId,
		session_id: 'session-1',
		phase: 'review',
		critical: false,
		committed_at: `2026-08-01T00:00:0${index}.000Z`,
		membership_event_id: `membership-${index}`,
		grace_days: 7,
		exposure_kind: 'legacy_unknown',
		origin: 'v2',
		terminal: {
			outcome,
			source: 'reviewer',
			event_id: `terminal-${index}`,
			committed_at: `2026-08-01T00:00:0${index}.000Z`,
		},
	};
}

beforeEach(() => {
	directory = canonicalMkdtemp('promotion-authority-');
});

afterEach(() => {
	_internals.queryHistoricalOutcomes = originalQueryHistoricalOutcomes;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('promotion evidence authority', () => {
	test('maps only qualifying authoritative terminals and preserves exact IDs', async () => {
		const remediated = membership(
			'entry-1',
			'applied',
			1,
		) as ReceiptMembership & {
			terminal_history?: ReceiptTerminal[];
		};
		remediated.terminal_history = [
			{
				outcome: 'violated',
				source: 'delegate',
				event_id: 'prior-violation',
				committed_at: '2026-07-31T23:59:59.000Z',
			} as ReceiptTerminal,
		];
		remediated.cohort_id = 'canonical-cohort';
		const recordedCohort = membership('entry-2', 'contradicted', 3);
		recordedCohort.cohort_id = 'canonical-cohort';
		const missingCohort = membership('entry-3', 'applied', 4);
		const otherCohort = membership('entry-4', 'applied', 5);
		otherCohort.cohort_id = 'other-cohort';
		_internals.queryHistoricalOutcomes = async () => ({
			ok: true,
			memberships: [
				remediated,
				membership('entry-1', 'ignored', 2),
				recordedCohort,
				missingCohort,
				otherCohort,
			],
		});

		const evidence = await loadPromotionEvidenceByEntry(
			directory,
			'canonical-cohort',
		);
		expect(
			evidence['entry-1']?.map((record) => record.receipt_outcome),
		).toEqual(['violated', 'applied']);
		expect(
			evidence['entry-1']?.map((record) => record.receipt_event_id),
		).toEqual(['prior-violation', 'terminal-1']);
		expect(evidence['entry-2']?.[0]?.receipt_outcome).toBe('contradicted');
		expect(evidence['entry-2']?.[0]?.cohort_id).toBe('canonical-cohort');
		expect(evidence['entry-3']).toBeUndefined();
		expect(evidence['entry-4']).toBeUndefined();
	});

	test('does not fall back to a populated diagnostic projection when history is unavailable', async () => {
		const projection: PromotionEvidenceRecord = {
			cohort_id: 'projection-cohort',
			entry_id: 'entry-1',
			retrieval_trace_id: 'projection-trace',
			receipt_outcome: 'applied',
			receipt_event_id: 'projection-terminal',
			timestamp: '2026-08-01T00:00:00.000Z',
		};
		await appendPromotionEvidence(directory, [projection]);
		_internals.queryHistoricalOutcomes = async () => ({
			ok: false,
			code: 'store_unavailable',
			detail: 'unavailable',
			uncertainty: 'unavailable',
		});

		expect(
			await loadPromotionEvidenceByEntry(directory, 'canonical-cohort'),
		).toEqual({});
	});
});

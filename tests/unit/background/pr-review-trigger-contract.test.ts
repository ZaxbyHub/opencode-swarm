import { describe, expect, test } from 'bun:test';
import {
	buildPrReviewTriggerReceiptV2,
	PR_REVIEW_REQUIRED_TRIGGER_IDS,
	PR_REVIEW_TRIGGER_DEFINITIONS,
	parsePrReviewTriggerReceipt,
	validatePrReviewInlineTriggerLedger,
	validatePrReviewWriterInputLedger,
} from '../../../src/background/pr-review-trigger-contract';

function inlineRows() {
	return PR_REVIEW_REQUIRED_TRIGGER_IDS.map((triggerId, index) =>
		triggerId === 'unclassified-risk' || index < 3
			? {
					trigger_id: triggerId,
					result: 'MATCHED' as const,
					evidence: `changed behavior relevant to ${triggerId}`,
				}
			: {
					trigger_id: triggerId,
					result: 'NOT_TRIGGERED' as const,
					evidence: `diff contains no ${triggerId} surface`,
				},
	);
}

function persistedRows() {
	return inlineRows().map((row, index) =>
		row.result === 'MATCHED'
			? {
					...row,
					source_batch_id: `batch-${index}`,
					source_lane_id: `lane-${index}`,
				}
			: row,
	);
}

function legacyRows(includeDefinitionFields = false) {
	return PR_REVIEW_REQUIRED_TRIGGER_IDS.map((triggerId, index) => {
		const definition = PR_REVIEW_TRIGGER_DEFINITIONS.find(
			(candidate) => candidate.id === triggerId,
		);
		if (!definition) throw new Error(`missing test definition: ${triggerId}`);
		return {
			trigger_id: triggerId,
			...(includeDefinitionFields
				? {
						scope: definition.scope,
						trigger_row: definition.trigger_row,
						micro_lane: definition.micro_lane,
					}
				: {}),
			result: 'MATCHED' as const,
			evidence: `legacy evidence ${index}`,
			source_batch_id: `legacy-batch-${index}`,
			source_lane_id: `legacy-lane-${index}`,
		};
	});
}

function legacyV1Receipt(rows: Array<Record<string, unknown>> = legacyRows()) {
	return {
		schema_version: 1 as const,
		run_id: 'legacy-run',
		pr_head_sha: 'a'.repeat(40),
		base_ref: 'origin/main',
		base_sha: 'b'.repeat(40),
		evaluated_at: '2026-08-02T00:00:00.000Z',
		trigger_count: 11,
		matched_count: 11,
		no_match_count: 0,
		dispatched_micro_lane_count: 11,
		rows,
	};
}

describe('inline PR-review trigger ledger', () => {
	test('accepts an exact mixed ledger and returns only matched IDs', () => {
		const parsed = validatePrReviewInlineTriggerLedger(inlineRows());
		expect(parsed.rows).toHaveLength(11);
		expect(parsed.matchedIds).toEqual([
			'auth-identity-secrets',
			'untrusted-input-boundaries',
			'subprocess-platform',
			'unclassified-risk',
		]);
		expect(parsed.notTriggeredIds).toHaveLength(7);
	});

	test('requires unclassified-risk to stay MATCHED', () => {
		const rows = inlineRows().map((row) =>
			row.trigger_id === 'unclassified-risk'
				? {
						trigger_id: row.trigger_id,
						result: 'NOT_TRIGGERED' as const,
						evidence: 'nothing else changed',
					}
				: row,
		);
		expect(() => validatePrReviewInlineTriggerLedger(rows)).toThrow(
			'unclassified-risk',
		);
	});

	test('rejects legacy NO-MATCH with a stable actionable diagnostic', () => {
		const rows = inlineRows() as unknown as Array<Record<string, unknown>>;
		rows[0] = { ...rows[0], result: 'NO-MATCH' };

		expect(() => validatePrReviewInlineTriggerLedger(rows)).toThrow(
			'NO-MATCH is not a valid PR_REVIEW trigger result; use MATCHED or NOT_TRIGGERED',
		);
	});

	test('rejects provenance on NOT_TRIGGERED, including null and empty values', () => {
		for (const provenance of [
			{ source_batch_id: null },
			{ source_lane_id: '' },
			{ source_batch_id: 'batch', source_lane_id: 'lane' },
		]) {
			const rows = inlineRows();
			const index = rows.findIndex((row) => row.result === 'NOT_TRIGGERED');
			(rows as unknown as Array<Record<string, unknown>>)[index] = {
				...rows[index],
				...provenance,
			};
			expect(() => validatePrReviewInlineTriggerLedger(rows)).toThrow();
		}
	});

	test('rejects missing, duplicate, and unknown trigger IDs', () => {
		const missing = inlineRows().slice(1);
		expect(() => validatePrReviewInlineTriggerLedger(missing)).toThrow(
			'missing',
		);

		const duplicate = inlineRows();
		duplicate[1] = { ...duplicate[0] };
		expect(() => validatePrReviewInlineTriggerLedger(duplicate)).toThrow(
			'duplicate',
		);

		const unknown = inlineRows();
		unknown[0] = { ...unknown[0], trigger_id: 'unknown-family' };
		expect(() => validatePrReviewInlineTriggerLedger(unknown)).toThrow(
			'unknown',
		);
	});
});

describe('final-writer PR-review trigger ledger', () => {
	test('accepts omitted or reworded evidence while preserving classification rules', () => {
		const rows = persistedRows();
		const omitted = rows.map(({ evidence: _evidence, ...row }) => row);
		expect(validatePrReviewWriterInputLedger(omitted).matchedIds).toHaveLength(
			4,
		);
		expect(
			validatePrReviewWriterInputLedger(
				rows.map((row) => ({ ...row, evidence: `reworded ${row.trigger_id}` })),
			).matchedIds,
		).toHaveLength(4);
	});

	test('rejects fallback, exact-set, and provenance violations', () => {
		const valid = persistedRows();
		const fallback = valid.map((row) =>
			row.trigger_id === 'unclassified-risk'
				? { trigger_id: row.trigger_id, result: 'NOT_TRIGGERED' as const }
				: row,
		);
		expect(() => validatePrReviewWriterInputLedger(fallback)).toThrow(
			'unclassified-risk',
		);
		expect(() => validatePrReviewWriterInputLedger(valid.slice(1))).toThrow(
			'missing',
		);
		const duplicate = structuredClone(valid);
		duplicate[1] = { ...duplicate[0] };
		expect(() => validatePrReviewWriterInputLedger(duplicate)).toThrow(
			'duplicate',
		);
		const unknown = structuredClone(valid) as Array<Record<string, unknown>>;
		unknown[0].trigger_id = 'unknown-family';
		expect(() => validatePrReviewWriterInputLedger(unknown)).toThrow('unknown');
		const missingProvenance = valid.map((row) =>
			row.result === 'MATCHED' ? { ...row, source_batch_id: undefined } : row,
		);
		expect(() => validatePrReviewWriterInputLedger(missingProvenance)).toThrow(
			'require source_batch_id',
		);
		const notTriggeredIndex = valid.findIndex(
			(row) => row.result === 'NOT_TRIGGERED',
		);
		const forbiddenProvenance = structuredClone(valid) as Array<
			Record<string, unknown>
		>;
		forbiddenProvenance[notTriggeredIndex].source_batch_id = 'forbidden';
		expect(() =>
			validatePrReviewWriterInputLedger(forbiddenProvenance),
		).toThrow();
		expect(() =>
			validatePrReviewWriterInputLedger(
				valid.map((row, index) =>
					index === 0 ? { ...row, evidence: '' } : row,
				),
			),
		).toThrow();
	});
});

describe('persisted PR-review trigger receipts', () => {
	test('builds and reads a strict schema-v2 receipt with exact counts', () => {
		const receipt = buildPrReviewTriggerReceiptV2({
			run_id: 'run-2004',
			pr_head_sha: 'a'.repeat(40),
			base_ref: 'origin/main',
			base_sha: 'b'.repeat(40),
			evaluated_at: '2026-08-02T00:00:00.000Z',
			dispatched_micro_lane_count: 4,
			rows: persistedRows(),
		});

		expect(receipt).toMatchObject({
			schema_version: 2,
			trigger_count: 11,
			matched_count: 4,
			not_triggered_count: 7,
			no_match_count: 0,
		});
		const parsed = parsePrReviewTriggerReceipt(receipt);
		expect(parsed.schemaVersion).toBe(2);
		expect(parsed.matchedRows).toHaveLength(4);
		expect(parsed.notTriggeredRows).toHaveLength(7);
	});

	test('keeps legacy no_match_count at zero for schema v2 receipts (HERMES-001)', () => {
		const receipt = buildPrReviewTriggerReceiptV2({
			run_id: 'run-hermes-001',
			pr_head_sha: 'a'.repeat(40),
			base_ref: 'origin/main',
			base_sha: 'b'.repeat(40),
			evaluated_at: '2026-08-02T00:00:00.000Z',
			dispatched_micro_lane_count: 4,
			rows: persistedRows(),
		});

		// Previous code leaked the seven NOT_TRIGGERED rows into this legacy
		// NO-MATCH counter even though schema v2 rejects NO-MATCH rows entirely.
		expect(receipt.not_triggered_count).toBe(7);
		expect(receipt.no_match_count).toBe(0);
		expect(() => parsePrReviewTriggerReceipt(receipt)).not.toThrow();
	});

	test('rejects v2 count drift and unknown fields', () => {
		const receipt = buildPrReviewTriggerReceiptV2({
			run_id: 'run-2004',
			pr_head_sha: 'a'.repeat(40),
			base_ref: 'origin/main',
			base_sha: 'b'.repeat(40),
			evaluated_at: '2026-08-02T00:00:00.000Z',
			dispatched_micro_lane_count: 4,
			rows: persistedRows(),
		});

		expect(() =>
			parsePrReviewTriggerReceipt({ ...receipt, matched_count: 11 }),
		).toThrow('matched_count');
		expect(() =>
			parsePrReviewTriggerReceipt({ ...receipt, unexpected: true }),
		).toThrow();
		expect(() =>
			parsePrReviewTriggerReceipt({
				...receipt,
				dispatched_micro_lane_count: 11,
			}),
		).toThrow('dispatched_micro_lane_count');

		const rowWithUnknownField = structuredClone(receipt) as unknown as {
			rows: Array<Record<string, unknown>>;
		};
		rowWithUnknownField.rows[0].unexpected = true;
		expect(() => parsePrReviewTriggerReceipt(rowWithUnknownField)).toThrow();
	});

	test.each([
		'scope',
		'trigger_row',
		'micro_lane',
	] as const)('rejects canonical v2 definition drift in %s', (field) => {
		const receipt = buildPrReviewTriggerReceiptV2({
			run_id: 'run-definition-drift',
			pr_head_sha: 'a'.repeat(40),
			base_ref: 'origin/main',
			base_sha: 'b'.repeat(40),
			evaluated_at: '2026-08-02T00:00:00.000Z',
			dispatched_micro_lane_count: 4,
			rows: persistedRows(),
		}) as unknown as { rows: Array<Record<string, unknown>> };
		receipt.rows[0][field] = 'tampered definition';
		const parse = () => parsePrReviewTriggerReceipt(receipt);
		if (field === 'scope') expect(parse).toThrow();
		else expect(parse).toThrow('definition drift');
	});

	test('reads historical unversioned row-only all-MATCHED projections', () => {
		const rows = legacyRows();
		const parsed = parsePrReviewTriggerReceipt({ rows });
		expect(parsed.schemaVersion).toBe(0);
		expect(parsed.matchedRows).toHaveLength(11);
		expect(parsed.notTriggeredRows).toHaveLength(0);
	});

	test('reads full schema-v1 receipts but rejects NOT_TRIGGERED in v1', () => {
		const rows = legacyRows();
		const receipt = legacyV1Receipt(rows);
		expect(parsePrReviewTriggerReceipt(receipt).schemaVersion).toBe(1);

		const mixed = structuredClone(receipt);
		mixed.rows[0] = {
			...mixed.rows[0],
			result: 'NOT_TRIGGERED' as never,
		};
		expect(() => parsePrReviewTriggerReceipt(mixed)).toThrow('MATCHED');

		expect(() =>
			parsePrReviewTriggerReceipt({ schema_version: 1, rows }),
		).toThrow();
		for (const field of [
			'trigger_count',
			'matched_count',
			'no_match_count',
			'dispatched_micro_lane_count',
		] as const) {
			const missing = { ...receipt } as Record<string, unknown>;
			delete missing[field];
			expect(() => parsePrReviewTriggerReceipt(missing)).toThrow();
		}
		expect(() =>
			parsePrReviewTriggerReceipt({
				...receipt,
				dispatched_micro_lane_count: 10,
			}),
		).toThrow('dispatched_micro_lane_count');
	});

	test('rejects unknown fields in legacy envelopes and rows', () => {
		const rowWithUnknown = legacyRows() as Array<Record<string, unknown>>;
		rowWithUnknown[0] = { ...rowWithUnknown[0], unexpected: true };
		for (const receipt of [
			{ rows: rowWithUnknown },
			legacyV1Receipt(rowWithUnknown),
		]) {
			expect(() => parsePrReviewTriggerReceipt(receipt)).toThrow();
		}

		expect(() =>
			parsePrReviewTriggerReceipt({ rows: legacyRows(), unexpected: true }),
		).toThrow();
		expect(() =>
			parsePrReviewTriggerReceipt({
				...legacyV1Receipt(),
				unexpected: true,
			}),
		).toThrow();
	});

	test('reads canonical historical full rows and rejects definition drift', () => {
		const rows = legacyRows(true);
		expect(parsePrReviewTriggerReceipt({ rows }).schemaVersion).toBe(0);
		expect(
			parsePrReviewTriggerReceipt(legacyV1Receipt(rows)).schemaVersion,
		).toBe(1);

		const tampered = structuredClone(rows) as Array<Record<string, unknown>>;
		tampered[0].trigger_row = 'tampered legacy definition';
		expect(() => parsePrReviewTriggerReceipt({ rows: tampered })).toThrow(
			'definition drift',
		);
		expect(() =>
			parsePrReviewTriggerReceipt(legacyV1Receipt(tampered)),
		).toThrow('definition drift');
	});
});

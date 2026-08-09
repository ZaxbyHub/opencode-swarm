import { describe, expect, test } from 'bun:test';
import {
	type ArtifactInput,
	parseCandidates,
} from '../../../src/background/candidate-parser';

const DIGEST = 'a'.repeat(64);
const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';
const CLEAN_SCOPE = 'complete changed-file diff';
const CLEAN_EVIDENCE = 'no candidate survived focused review';

function artifact(text: string): ArtifactInput {
	return {
		output_ref: 'L1:batch:lane:output',
		batchId: 'batch-semantic-contract',
		laneId: 'lane-semantic-contract',
		agent: 'local_explorer',
		role: 'explorer',
		digest: DIGEST,
		text,
		artifact_status: 'ok',
		source: 'collect_lane_results',
		produced_at: '2026-08-02T00:00:00.000Z',
	};
}

function flags(
	overrides: Record<string, unknown> = {},
): Parameters<typeof parseCandidates>[1] {
	return {
		accept_partial: false,
		accept_degraded: false,
		degraded: false,
		row_format_version: 1,
		...overrides,
	} as Parameters<typeof parseCandidates>[1];
}

describe('candidate semantic contract', () => {
	test.each([
		[
			'owned base set without its primary lane',
			{
				expected_family: 'base_explorer',
				expected_lanes: ['intent-architecture'],
			},
			'expected_lane is required',
		],
		[
			'owned base set omitting its primary lane',
			{
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
				expected_lanes: ['intent-architecture'],
			},
			'must contain expected_lane',
		],
		[
			'duplicate owned base set',
			{
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
				expected_lanes: ['correctness-state', 'correctness-state'],
			},
			'must contain unique lane identities',
		],
		[
			'base family with micro ownership',
			{
				expected_family: 'base_explorer',
				expected_micro_lane: 'concurrency-state',
			},
			'base_explorer ownership cannot include',
		],
		[
			'micro family with base ownership',
			{
				expected_family: 'micro_lane',
				expected_lane: 'correctness-state',
			},
			'micro_lane ownership cannot include',
		],
		[
			'base ownership without a family binding',
			{ expected_lane: 'correctness-state' },
			'base ownership fields require expected_family base_explorer',
		],
		[
			'micro ownership without a family binding',
			{ expected_micro_lane: 'concurrency-state' },
			'micro ownership fields require expected_family micro_lane',
		],
	] as const)('rejects relationally invalid flags: %s', (_name, invalidFlags, message) => {
		expect(() =>
			parseCandidates(
				artifact(
					`${BASE_HEADER}\nC-1 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`,
				),
				flags(invalidFlags),
			),
		).toThrow(message);
	});

	test.each([
		['severity', 'URGENT', 'HIGH'],
		['severity', 'high', 'HIGH'],
		['confidence', 'HIGH', '0.95'],
		['confidence', 'HIGH', 'certain'],
	] as const)('excludes invalid %s values with a row-scoped diagnostic', (field, severity, confidence) => {
		const row = `C-1 | correctness-state | ${severity} | correctness | src/a.ts:1 | claim | evidence | impact | ${confidence}`;
		const result = parseCandidates(
			artifact(`${BASE_HEADER}\n${row}`),
			flags({
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
			}),
		);

		expect(result.candidates).toHaveLength(0);
		expect(result.diagnostics.malformed_rows).toBe(1);
		expect(result.diagnostics.parse_error_details).toContainEqual(
			expect.objectContaining({ row_index: 1, field }),
		);
	});

	test('excludes a candidate with any empty canonical field', () => {
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\nC-2 | correctness-state | HIGH |  | src/a.ts:1 | claim | evidence | impact | HIGH`,
			),
			flags({
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
			}),
		);

		expect(result.candidates).toHaveLength(0);
		expect(result.diagnostics.parse_error_details).toContainEqual(
			expect.objectContaining({ row_index: 1, field: 'category' }),
		);
	});

	test('diagnoses a marker-bearing short candidate instead of treating it as continuation', () => {
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\nC-OK | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH\n[CANDIDATE] | C-BAD | correctness-state | HIGH`,
			),
			flags({ expected_family: 'base_explorer' }),
		);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.evidence_summary).toBe('evidence');
		expect(result.diagnostics.parse_error_details).toContainEqual(
			expect.objectContaining({ row_index: 2, field: 'row' }),
		);
	});

	test('diagnoses an unprefixed short foreign row instead of absorbing it as evidence', () => {
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\nC-OK | intent-architecture | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH\nC-FOREIGN | security-trust | HIGH`,
			),
			flags({
				expected_family: 'base_explorer',
				expected_lane: 'intent-architecture',
				expected_lanes: ['intent-architecture'],
			}),
		);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.evidence_summary).toBe('evidence');
		expect(result.diagnostics.parse_error_details).toContainEqual(
			expect.objectContaining({ row_index: 2, field: 'row' }),
		);
	});

	test('keeps ordinary multiline continuation text compatible', () => {
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\nC-3 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH\ncontinued evidence without a candidate row`,
			),
			flags({
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
			}),
		);

		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.evidence_summary).toContain(
			'continued evidence without a candidate row',
		);
		expect(result.diagnostics.malformed_rows).toBe(0);
	});

	test('preserves escaped pipes in required candidate fields', () => {
		const result = parseCandidates(
			artifact(
				`${MICRO_HEADER}\nM-1 | concurrency-state | HIGH | concurrency | src/a.ts:1 | claim | invariant | evidence with \\| pipe | HIGH`,
			),
			flags({
				expected_family: 'micro_lane',
				expected_micro_lane: 'concurrency-state',
			}),
		);

		expect(result.candidates[0]?.evidence_summary).toBe('evidence with | pipe');
	});
});

describe('base and micro CLEAN attestations', () => {
	test('returns a full base CLEAN envelope and credits only the expected owned lane', () => {
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\n[CLEAN] | intent-architecture | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}\n[CLEAN] | correctness-state | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`,
			),
			flags({
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
				expected_lanes: ['intent-architecture', 'correctness-state'],
			}),
		);

		expect(result.clean_attestation).toEqual(
			expect.objectContaining({
				record_type: 'clean_attestation',
				row_format_family: 'base_explorer',
				lane: 'correctness-state',
				source_output_ref: 'L1:batch:lane:output',
				record_version: { major: 1, minor: 1 },
			}),
		);
		expect(result.diagnostics.format_families_detected).toEqual([
			'base_explorer',
		]);
	});

	test('rejects a foreign base CLEAN lane', () => {
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\n[CLEAN] | security-trust | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`,
			),
			flags({
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
				expected_lanes: ['intent-architecture', 'correctness-state'],
			}),
		);

		expect(result.clean_attestation).toBeUndefined();
		expect(result.error_code).toBe('expected-lane-mismatch');
	});

	test('retains the historical full micro CLEAN envelope', () => {
		const result = parseCandidates(
			artifact(
				`${MICRO_HEADER}\n[CLEAN] | concurrency-state | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`,
			),
			flags({
				expected_family: 'micro_lane',
				expected_micro_lane: 'concurrency-state',
			}),
		);

		expect(result.clean_attestation).toEqual(
			expect.objectContaining({
				record_type: 'clean_attestation',
				row_format_family: 'micro_lane',
				micro_lane: 'concurrency-state',
			}),
		);
	});
});

/**
 * Issue #2279 — salvage-tolerant CLEAN attestation handling.
 *
 * A `[CLEAN]` attestation that conflicts with a same-lane `[CANDIDATE]` row used
 * to fail the whole parse even though the candidate rows were retained, so the
 * agent reading the tool receipt re-dispatched a lane that had actually produced
 * findings. It is now a recorded salvage.
 *
 * The load-bearing property under test is NOT "the error went away" — it is that
 * the attestation stays discredited just as hard as before, so a salvage can
 * never be mistaken for coverage.
 */
import { describe, expect, test } from 'bun:test';
import {
	CANDIDATE_SEVERITIES,
	FINDINGS_SEVERITIES,
	normalizeCandidateArtifact,
} from '../../../src/background/candidate-contract';
import {
	type ArtifactInput,
	type ParseFlags,
	parseAndPersist,
	parseCandidates,
} from '../../../src/background/candidate-parser';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';

const candidateRow = (id: string, lane: string): string =>
	`${id} | ${lane} | HIGH | correctness | src/a.ts:10 | a real claim | evidence text here | impact context here | HIGH`;

const cleanRow = (lane: string): string =>
	`[CLEAN] | ${lane} | swept every changed file in the diff | no actionable finding survived triage`;

const input = (text: string): ArtifactInput => ({
	output_ref: 'ref-1',
	batchId: 'batch-1',
	laneId: 'lane-1',
	agent: 'explorer',
	role: 'explorer',
	sessionId: 'session-1',
	parentSessionId: 'parent-1',
	digest: 'a'.repeat(64),
	text,
	artifact_status: 'ok',
	source: 'dispatch_lanes',
	produced_at: '2026-08-23T00:00:00.000Z',
});

const flags = (overrides: Partial<ParseFlags> = {}): ParseFlags =>
	({
		accept_partial: false,
		accept_degraded: false,
		degraded: false,
		row_format_version: 1,
		expected_family: 'base_explorer',
		...overrides,
	}) as ParseFlags;

describe('conflicting CLEAN attestation is salvaged, not fatal (#2279)', () => {
	test('parse succeeds, candidates retained, attestation discredited', () => {
		const result = parseCandidates(
			input(
				[
					BASE_HEADER,
					candidateRow('C-1', 'correctness'),
					cleanRow('correctness'),
				].join('\n'),
			),
			flags({ expected_lane: 'correctness' }),
		);

		expect(result.error).toBeUndefined();
		expect(result.error_code).toBeUndefined();
		expect(result.clean_attestation_salvaged).toBe(true);
		expect(result.clean_attestation_salvage_reason).toContain('correctness');

		// COVERAGE SAFETY. This is the assertion that must never be relaxed: a
		// salvaged attestation contributes no coverage, so a lane cannot be
		// credited with zero-findings coverage it did not earn.
		expect(result.clean_attestation).toBeUndefined();
		expect(result.diagnostics.clean_attestation_count).toBe(0);

		// The findings the old hard error threw away.
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]?.candidate_id).toBe('C-1');
	});

	test('an accepted-degraded artifact hard-errors instead of salvaging', () => {
		// THE BL1 CASE. With accept_degraded the parse gets past the up-front
		// source refusal and reaches CLEAN handling, where `degraded` sets
		// untrusted-clean-attestation BEFORE the conflict check runs. That check is
		// guarded on `!cleanErrorCode` precisely so this artifact cannot report a
		// hard error and a benign salvage at once — which would make the gate write
		// a durable salvage record for a parse that failed.
		const result = parseCandidates(
			input(
				[
					BASE_HEADER,
					candidateRow('C-1', 'correctness'),
					cleanRow('correctness'),
				].join('\n'),
			),
			flags({
				expected_lane: 'correctness',
				degraded: true,
				accept_degraded: true,
			}),
		);

		expect(result.error_code).toBe('untrusted-clean-attestation');
		expect(result.clean_attestation_salvaged).toBeUndefined();
		expect(result.clean_attestation).toBeUndefined();
	});

	test('error and salvage are mutually exclusive on every refusal path', () => {
		// A degraded or partial source is refused before CLEAN handling entirely,
		// under its own code. Whatever the code, the invariant holds: never both.
		const degraded = parseCandidates(
			input(
				[
					BASE_HEADER,
					candidateRow('C-1', 'correctness'),
					cleanRow('correctness'),
				].join('\n'),
			),
			flags({ expected_lane: 'correctness', degraded: true }),
		);
		const partial = parseCandidates(
			{
				...input(
					[
						BASE_HEADER,
						candidateRow('C-1', 'correctness'),
						cleanRow('correctness'),
					].join('\n'),
				),
				transcriptIncomplete: true,
			},
			flags({ expected_lane: 'correctness' }),
		);

		for (const result of [degraded, partial]) {
			expect(result.error_code).toBeDefined();
			expect(result.clean_attestation_salvaged).toBeUndefined();
			expect(result.clean_attestation).toBeUndefined();
		}
	});

	test('a CLEAN for a different lane is untouched by a sibling candidate', () => {
		// Regression guard for the #2131 per-obligation scoping: only a SAME-lane
		// candidate conflicts. A sibling lane's candidate must not discredit this
		// lane's honest zero-findings attestation.
		const result = parseCandidates(
			input(
				[
					BASE_HEADER,
					candidateRow('C-1', 'correctness'),
					cleanRow('security'),
				].join('\n'),
			),
			flags({
				expected_lane: 'security',
				expected_lanes: ['correctness', 'security'],
			}),
		);

		expect(result.error_code).toBeUndefined();
		expect(result.clean_attestation_salvaged).toBeUndefined();
		expect(result.clean_attestation).toBeDefined();
	});
});

describe('duplicate header emitted as a data row is salvaged (#2279)', () => {
	test('a re-emitted header is dropped and disclosed as a repair', () => {
		const normalized = normalizeCandidateArtifact(
			[
				BASE_HEADER,
				candidateRow('C-1', 'correctness'),
				BASE_HEADER,
				cleanRow('security'),
			].join('\n'),
			'base_explorer',
		);

		expect(normalized.repairKinds).toContain('duplicate-header-row-dropped');
		expect(
			normalized.text.split('\n').filter((line) => line === BASE_HEADER),
		).toHaveLength(1);
	});

	test('the surviving header is the marker-bearing one, not merely the first', () => {
		// If "keep the first" were the rule, a markerless field-name list placed
		// above the real header would survive and the real header would be
		// deleted — inventing a header failure that does not exist today.
		const markerless =
			'candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
		const normalized = normalizeCandidateArtifact(
			[markerless, BASE_HEADER, candidateRow('C-1', 'correctness')].join('\n'),
			'base_explorer',
		);

		const lines = normalized.text.split('\n');
		expect(lines).toContain(BASE_HEADER);
		expect(lines).not.toContain(markerless);
	});

	test('a placeholder header no longer destroys a valid CLEAN attestation', () => {
		// Before the repair the re-emitted header counted as a malformed row,
		// which tripped the zero-malformed-rows rule and voided a CLEAN belonging
		// to a DIFFERENT lane.
		const normalized = normalizeCandidateArtifact(
			[BASE_HEADER, BASE_HEADER, cleanRow('security')].join('\n'),
			'base_explorer',
		);
		const result = parseCandidates(
			input(normalized.text),
			flags({ expected_lane: 'security' }),
		);

		expect(result.error_code).toBeUndefined();
		expect(result.diagnostics.malformed_rows).toBe(0);
		expect(result.clean_attestation).toBeDefined();
	});

	test('a legitimate candidate row is never mistaken for a header', () => {
		const normalized = normalizeCandidateArtifact(
			[BASE_HEADER, candidateRow('C-1', 'correctness')].join('\n'),
			'base_explorer',
		);

		expect(normalized.repairKinds).not.toContain(
			'duplicate-header-row-dropped',
		);
		expect(normalized.text.split('\n')).toContain(
			candidateRow('C-1', 'correctness'),
		);
	});
});

describe('severity vocabularies stay distinct (#2279)', () => {
	test('the findings dialect is the candidate dialect plus NONE', () => {
		expect(FINDINGS_SEVERITIES).toEqual([
			...CANDIDATE_SEVERITIES,
			'NONE',
		] as unknown as typeof FINDINGS_SEVERITIES);
	});

	test('a candidate row may never declare NONE', () => {
		// Widening CANDIDATE_SEVERITIES instead of adding a findings-scoped enum
		// would have silently loosened the explorer row contract and the sidecar.
		expect(CANDIDATE_SEVERITIES as readonly string[]).not.toContain('NONE');

		const result = parseCandidates(
			input(
				[
					BASE_HEADER,
					'C-1 | correctness | NONE | correctness | src/a.ts:10 | a real claim | evidence text here | impact context here | HIGH',
				].join('\n'),
			),
			flags({ expected_lane: 'correctness' }),
		);
		expect(result.candidates).toHaveLength(0);
		expect(result.diagnostics.malformed_rows).toBe(1);
	});
});

describe('repair provenance reaches the parse receipt (#2279)', () => {
	// The `parse_lane_candidates` receipt is the ONLY anomaly signal its caller
	// sees. `parseAndPersist` used to discard `normalizeCandidateArtifact`'s
	// repairKinds, so a structurally repaired artifact was indistinguishable from
	// a pristine one. These tests pin the disclosure so a future refactor (e.g. a
	// narrowing projection schema) cannot silently drop it again.
	const persistOptions = () => ({
		projectRoot: canonicalMkdtemp('candidate-repair-receipt-'),
	});

	test('a repaired artifact discloses repair_kinds on the receipt', () => {
		const result = parseAndPersist(
			input(
				[
					BASE_HEADER,
					candidateRow('C-1', 'correctness'),
					BASE_HEADER,
					cleanRow('security'),
				].join('\n'),
			),
			flags({ expected_lane: 'security' }),
			persistOptions(),
		);

		expect(result.repair_kinds).toContain('duplicate-header-row-dropped');
		// The receipt is serialized whole to the caller, so the field must survive
		// JSON round-tripping exactly as the tool emits it.
		expect(JSON.parse(JSON.stringify(result)).repair_kinds).toContain(
			'duplicate-header-row-dropped',
		);
	});

	test('a pristine artifact does not claim a repair', () => {
		const result = parseAndPersist(
			input([BASE_HEADER, candidateRow('C-1', 'correctness')].join('\n')),
			flags({ expected_lane: 'correctness' }),
			persistOptions(),
		);

		expect(result.repair_kinds).toBeUndefined();
	});

	test('a salvaged CLEAN reaches the receipt through parseAndPersist too', () => {
		const result = parseAndPersist(
			input(
				[
					BASE_HEADER,
					candidateRow('C-1', 'correctness'),
					cleanRow('correctness'),
				].join('\n'),
			),
			flags({ expected_lane: 'correctness' }),
			persistOptions(),
		);

		expect(result.error_code).toBeUndefined();
		expect(result.clean_attestation_salvaged).toBe(true);
		expect(result.clean_attestation).toBeUndefined();
	});
});

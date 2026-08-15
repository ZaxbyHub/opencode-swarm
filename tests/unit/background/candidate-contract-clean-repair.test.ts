import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { normalizeCandidateArtifact } from '../../../src/background/candidate-contract';
import {
	type ArtifactInput,
	type ParseFlags,
	parseCandidates,
} from '../../../src/background/candidate-parser';

/**
 * Lane-output recoverability repairs (PR-review deadlock fix).
 *
 * A real /swarm pr-review run (PR #2177, plugin v7.140.1) aborted after four
 * substantively-correct micro-lane outputs were all parser-rejected:
 * - a literal `|` inside [CLEAN] evidence (`validates against \`,;|\` injection
 *   chars`) split the row past CLEAN_FIELD_COUNT;
 * - a trailing `[LANE_SUMMARY] | k=v | k=v` line was misclassified as a
 *   malformed short candidate row and voided the attestation via the
 *   zero-malformed-rows rule.
 *
 * These tests pin the two normalize-boundary repairs and the per-lane CLEAN
 * tolerance that let such artifacts parse as covered.
 */

const digest = createHash('sha256').update('clean-repair').digest('hex');
const microHeader =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';
const capturedFamily = 'untrusted-input-boundaries';
const ownedFamilies = [
	'untrusted-input-boundaries',
	'test-infrastructure',
	'unclassified-risk',
];

function input(text: string, laneId = 'pr2177-micro'): ArtifactInput {
	return {
		output_ref: `L1:${'a'.repeat(64)}:${'b'.repeat(64)}:${digest}`,
		batchId: 'micro-batch',
		laneId,
		agent: 'mega_explorer',
		role: 'explorer',
		digest,
		text,
		artifact_status: 'ok',
		source: 'collect_lane_results',
		produced_at: '2026-08-14T00:00:00.000Z',
	};
}

function microFlags(
	expectedMicroLane: string,
	overrides: Record<string, unknown> = {},
): ParseFlags {
	return {
		accept_partial: false,
		accept_degraded: false,
		degraded: false,
		row_format_version: 1,
		producer: 'swarm-pr-review',
		expected_family: 'micro_lane',
		expected_micro_lane: expectedMicroLane,
		expected_micro_lanes: [
			expectedMicroLane,
			...ownedFamilies.filter((family) => family !== expectedMicroLane),
		],
		...overrides,
	} as unknown as ParseFlags;
}

/** The exact captured artifact shape: preamble prose, three pipe-damaged
 * per-family CLEAN rows (evidence cites `,;|`), and a trailing summary row. */
const capturedArtifact = [
	'Now let me verify the `_internals` export and test execution:',
	microHeader,
	'[CLEAN] | untrusted-input-boundaries | Stripping trailing parenthetical annotations from FILE directives via regex applied to user-provided args; the extractor validates against `,;|` injection chars before path use | Two locations in delegation-gate.ts modified identically; regex anchors to end-of-string preventing partial matches',
	'[CLEAN] | test-infrastructure | New test file is 25 lines under the 500 cap, uses bun:test only, imports the _internals seam, zero mock.module usage | Test exercises the exact function added to _internals; no fixture drift or isolation leakage risks',
	'[CLEAN] | unclassified-risk | Focused 32-line addition across 2 files with no new exports, schema changes, or subprocess modifications | Both duplication sites maintain identical strip logic; PR is a narrow fix with matched test coverage',
	'[LANE_SUMMARY] | micro_lane=consolidated | candidates_emitted=0',
].join('\n');

describe('clean-evidence-pipe-tail-merge repair', () => {
	test('repairs a [CLEAN] row whose evidence contains literal pipes', () => {
		const damaged =
			'[CLEAN] | some-lane | coverage scope text long enough | evidence mentioning `,;|` chars and a | b | c';
		const normalized = normalizeCandidateArtifact(
			`${microHeader}\n${damaged}`,
			'micro_lane',
		);
		expect(normalized.repairKinds).toContain('clean-evidence-pipe-tail-merge');
		const result = parseCandidates(
			input(normalized.text),
			microFlags('some-lane'),
		);
		expect(result.error_code).toBeUndefined();
		expect(result.clean_attestation?.micro_lane).toBe('some-lane');
		expect(result.clean_attestation?.evidence).toContain('`,;|`');
		expect(result.clean_attestation?.evidence).toContain('a | b | c');
		expect(result.diagnostics.malformed_rows).toBe(0);
	});

	test('leaves well-formed and non-CLEAN rows untouched', () => {
		const fine = [
			microHeader,
			'[CLEAN] | some-lane | coverage scope text long enough | plain evidence text with no pipes at all',
			'prose preamble line without pipes',
		].join('\n');
		const normalized = normalizeCandidateArtifact(fine, 'micro_lane');
		expect(normalized.repairKinds).not.toContain(
			'clean-evidence-pipe-tail-merge',
		);
		expect(normalized.repairKinds).not.toContain('summary-row-dropped');
	});
});

describe('summary-row-dropped repair', () => {
	test('drops [LANE_SUMMARY] rows before candidate parsing', () => {
		const withSummary = [
			microHeader,
			'[CLEAN] | some-lane | coverage scope text long enough | plain evidence text describing coverage',
			'[LANE_SUMMARY] | micro_lane=x | candidates_emitted=0',
		].join('\n');
		const normalized = normalizeCandidateArtifact(withSummary, 'micro_lane');
		expect(normalized.repairKinds).toContain('summary-row-dropped');
		expect(normalized.text).not.toContain('[LANE_SUMMARY]');
		const result = parseCandidates(
			input(normalized.text),
			microFlags('some-lane'),
		);
		expect(result.clean_attestation?.micro_lane).toBe('some-lane');
		expect(result.diagnostics.malformed_rows).toBe(0);
	});

	test('[NOTE]/[DONE]/[SUMMARY] marker rows are dropped like [LANE_SUMMARY]', () => {
		// All non-contract bracket-marker rows share the [LANE_SUMMARY] failure
		// shape: 2+ pipe fields after the header → "structurally short candidate
		// row" → malformed → voids the CLEAN attestation. They are dropped, not
		// parsed.
		const artifact = [
			microHeader,
			'[CLEAN] | some-lane | coverage scope text long enough | plain evidence text describing coverage',
			'[NOTE] | an aside | with two pipes',
			'[DONE] | finished',
			'[LANE_SUMMARY] | micro_lane=x | candidates_emitted=0',
		].join('\n');
		const normalized = normalizeCandidateArtifact(artifact, 'micro_lane');
		expect(normalized.repairKinds).toContain('summary-row-dropped');
		expect(normalized.text).not.toContain('[NOTE]');
		expect(normalized.text).not.toContain('[DONE]');
		expect(normalized.text).not.toContain('[LANE_SUMMARY]');
		const result = parseCandidates(
			input(normalized.text),
			microFlags('some-lane'),
		);
		expect(result.clean_attestation?.micro_lane).toBe('some-lane');
		expect(result.diagnostics.malformed_rows).toBe(0);
	});
});

describe('captured consolidated micro artifact (PR #2177 run)', () => {
	test('every owned family parses as covered after repairs', () => {
		for (const family of ownedFamilies) {
			const normalized = normalizeCandidateArtifact(
				capturedArtifact,
				'micro_lane',
			);
			expect(normalized.repairKinds).toContain(
				'clean-evidence-pipe-tail-merge',
			);
			expect(normalized.repairKinds).toContain('summary-row-dropped');
			const result = parseCandidates(
				input(normalized.text),
				microFlags(family),
			);
			expect(
				result.error_code,
				`family ${family} should parse cleanly`,
			).toBeUndefined();
			expect(
				result.diagnostics.parse_errors,
				`family ${family} should have zero parse errors`,
			).toBe(0);
			expect(
				result.clean_attestation?.micro_lane,
				`family ${family} should be attested clean`,
			).toBe(family);
		}
	});

	test('mixed artifact: CANDIDATE for one family + CLEAN for siblings does not conflict', () => {
		const artifact = [
			microHeader,
			'[CANDIDATE] | c-1 | test-infrastructure | MEDIUM | coverage-gap | src/a.ts:1 | claim text here | invariant text | evidence text here | HIGH',
			'[CLEAN] | untrusted-input-boundaries | coverage of input boundary normalization | concrete evidence describing boundary coverage here',
		].join('\n');
		const cleanLane = parseCandidates(
			input(artifact),
			microFlags('untrusted-input-boundaries'),
		);
		expect(cleanLane.error_code).toBeUndefined();
		expect(cleanLane.clean_attestation?.micro_lane).toBe(
			'untrusted-input-boundaries',
		);
		const candidateLane = parseCandidates(
			input(artifact),
			microFlags('test-infrastructure'),
		);
		expect(candidateLane.candidates).toHaveLength(1);
		expect(candidateLane.clean_attestation).toBeUndefined();
	});

	test('unscoped parse: CLEAN rows for two different lanes both survive, no error', () => {
		// No expected_lane flags (a manual parse_lane_candidates call). The first
		// valid CLEAN fills the singular attestation slot; the second lane's valid
		// CLEAN is skipped — not an "Only one CLEAN attestation" error.
		const artifact = [
			microHeader,
			'[CLEAN] | lane-alpha | coverage scope text long enough | evidence for lane alpha here',
			'[CLEAN] | lane-beta | coverage scope text long enough | evidence for lane beta here',
		].join('\n');
		const result = parseCandidates(
			input(normalizeCandidateArtifact(artifact, 'micro_lane').text),
			microFlags('lane-alpha', {
				expected_micro_lane: undefined,
				expected_micro_lanes: undefined,
			}),
		);
		expect(result.error_code).toBeUndefined();
		expect(result.diagnostics.malformed_rows).toBe(0);
		expect(result.clean_attestation?.micro_lane).toBe('lane-alpha');
	});

	test('a pipe-free line starting with a bracket token is preserved', () => {
		// Only pipe-bearing marker rows are dropped; a pipe-free [IMPORTANT] line
		// is harmless prose today (single field, never a short candidate row) and
		// may be a continuation fragment.
		const artifact = [
			microHeader,
			'[CLEAN] | some-lane | coverage scope text long enough | plain evidence text describing coverage',
			'[IMPORTANT] continuation prose without any pipes',
		].join('\n');
		const normalized = normalizeCandidateArtifact(artifact, 'micro_lane');
		expect(normalized.repairKinds).not.toContain('summary-row-dropped');
		expect(normalized.text).toContain('[IMPORTANT]');
	});

	test('duplicate CLEAN for the SAME lane is still rejected', () => {
		const artifact = [
			microHeader,
			'[CLEAN] | some-lane | coverage scope text long enough | first evidence text here',
			'[CLEAN] | some-lane | coverage scope text long enough | second evidence text here',
		].join('\n');
		const result = parseCandidates(
			input(normalizeCandidateArtifact(artifact, 'micro_lane').text),
			microFlags('some-lane'),
		);
		expect(result.diagnostics.parse_error_details).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					field: 'clean_attestation',
				}),
			]),
		);
		expect(result.clean_attestation).toBeUndefined();
	});

	test('CLEAN alongside a CANDIDATE for the same lane still conflicts', () => {
		const artifact = [
			microHeader,
			'[CANDIDATE] | c-1 | some-lane | MEDIUM | coverage-gap | src/a.ts:1 | claim text here | invariant text | evidence text here | HIGH',
			'[CLEAN] | some-lane | coverage scope text long enough | contradictory clean evidence here',
		].join('\n');
		const result = parseCandidates(
			input(normalizeCandidateArtifact(artifact, 'micro_lane').text),
			microFlags('some-lane'),
		);
		expect(result.clean_attestation).toBeUndefined();
		expect(result.diagnostics.parse_error_details).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					field: 'clean_attestation',
					message: expect.stringContaining('same lane'),
				}),
			]),
		);
	});
});

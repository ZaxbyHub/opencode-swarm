import { describe, expect, test } from 'bun:test';
import {
	analyzeCandidateFields,
	analyzeCleanFields,
	CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS,
	candidateHeaderFamily,
	type RowFormatFamily,
	selectCandidateHeader,
	splitPipeFields,
} from '../../../src/background/candidate-contract';
import {
	type ArtifactInput,
	parseCandidates,
} from '../../../src/background/candidate-parser';
import {
	_test_exports,
	prReviewDiscoveryArtifactCoversLane,
} from '../../../src/hooks/pr-workflow-gate';

const DIGEST = 'a'.repeat(64);
const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence';
const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence';
const CLEAN_SCOPE = 'complete changed-file diff';
const CLEAN_EVIDENCE = 'no candidate survived focused review';

function artifact(text: string): ArtifactInput {
	return {
		output_ref: 'L1:contract:lane:output',
		batchId: 'candidate-contract',
		laneId: 'candidate-contract-lane',
		agent: 'local_explorer',
		role: 'explorer',
		digest: DIGEST,
		text,
		artifact_status: 'ok',
		source: 'collect_lane_results',
		produced_at: '2026-08-02T00:00:00.000Z',
	};
}

describe('shared candidate and CLEAN semantics', () => {
	test('bounds attacker-controlled invalid enum diagnostics', () => {
		const invalidSeverity = `BLOCKER-${'x'.repeat(100_000)}`;
		const analysis = analyzeCandidateFields(
			[
				'C-1',
				'correctness-state',
				invalidSeverity,
				'correctness',
				'src/a.ts:1',
				'claim',
				'evidence',
				'impact',
				'HIGH',
			],
			'base_explorer',
		);

		const message = analysis.issues.find(
			(issue) => issue.field === 'severity',
		)?.message;
		expect(message).toContain('Invalid severity: BLOCKER-');
		expect(message?.length).toBeLessThan(
			CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS + 100,
		);
		expect(message).not.toContain('x'.repeat(1_000));
	});

	test('bounds attacker-controlled lane mismatch diagnostics', () => {
		const foreignLane = `foreign-${'x'.repeat(100_000)}`;
		const result = parseCandidates(
			artifact(
				`${BASE_HEADER}\nC-FOREIGN | ${foreignLane} | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH`,
			),
			{
				accept_partial: false,
				accept_degraded: false,
				degraded: false,
				row_format_version: 1,
				expected_family: 'base_explorer',
				expected_lane: 'correctness-state',
			},
		);

		const message = result.diagnostics.parse_error_details[0]?.message;
		expect(message).toContain('received foreign-');
		expect(message?.length).toBeLessThan(
			CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS + 100,
		);
		expect(message).not.toContain('x'.repeat(1_000));
	});

	test.each([
		['base_explorer', BASE_HEADER, 'correctness-state'] as const,
		['micro_lane', MICRO_HEADER, 'concurrency-state'] as const,
	])('keeps parser and workflow-gate CLEAN decisions identical for %s', (family: RowFormatFamily, header: string, lane: string) => {
		const validRow = `[CLEAN] | ${lane} | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`;
		const shortRow = `[CLEAN] | ${lane} | short | too short`;
		const expectedLaneFlags =
			family === 'base_explorer'
				? { expected_lane: lane }
				: { expected_micro_lane: lane };
		const flags = {
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			expected_family: family,
			...expectedLaneFlags,
		};

		expect(analyzeCleanFields(validRow.split('|'), family, lane).valid).toBe(
			true,
		);
		expect(
			parseCandidates(artifact(`${header}\n${validRow}`), flags)
				.clean_attestation,
		).toBeDefined();
		expect(
			prReviewDiscoveryArtifactCoversLane(`${header}\n${validRow}`, lane),
		).toBe(true);

		expect(analyzeCleanFields(shortRow.split('|'), family, lane).valid).toBe(
			false,
		);
		expect(
			parseCandidates(artifact(`${header}\n${shortRow}`), flags)
				.clean_attestation,
		).toBeUndefined();
		expect(
			prReviewDiscoveryArtifactCoversLane(`${header}\n${shortRow}`, lane),
		).toBe(false);
	});

	test.each([
		[
			'base_explorer',
			BASE_HEADER,
			'correctness-state',
			'C-1 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH',
		] as const,
		[
			'micro_lane',
			MICRO_HEADER,
			'concurrency-state',
			'M-1 | concurrency-state | HIGH | concurrency | src/a.ts:1 | claim | invariant | evidence | HIGH',
		] as const,
	])('rejects a wrong canonical header but repairs an absent one for %s', (family, header, lane, row) => {
		const misorderedHeader = header.replace(
			'severity | category',
			'category | severity',
		);
		const parse = (text: string) =>
			parseCandidates(artifact(text), {
				accept_partial: false,
				accept_degraded: false,
				degraded: false,
				row_format_version: 1,
				expected_family: family,
				...(family === 'base_explorer'
					? { expected_lane: lane }
					: { expected_micro_lane: lane }),
			});

		// A header that is PRESENT but wrong (extra field, misordered fields) is a
		// genuine contract violation and still fails closed at both boundaries.
		for (const text of [
			`${header} | extra\n${row}`,
			`${misorderedHeader}\n${row}`,
		]) {
			const parsed = parse(text);
			expect(parsed.candidates).toEqual([]);
			expect(parsed.error_code).toBe('invalid-candidate-header');
			expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(false);
		}

		// A header that is ABSENT, alongside a valid marker-bearing row, is now
		// repaired so the lane's real findings survive (approved salvage). The raw
		// parser still refuses it; only the PR-review boundary, which normalizes
		// the artifact first, accepts.
		const absentHeader = `[CANDIDATE] | ${row}`;
		const parsedAbsent = parse(absentHeader);
		expect(parsedAbsent.candidates).toEqual([]);
		expect(parsedAbsent.error_code).toBe('invalid-candidate-header');
		expect(prReviewDiscoveryArtifactCoversLane(absentHeader, lane)).toBe(true);
	});

	test('uses the shared exact header analyzer at both trust boundaries', () => {
		expect(candidateHeaderFamily(BASE_HEADER.split('|'))).toBe('base_explorer');
		expect(candidateHeaderFamily(MICRO_HEADER.split('|'))).toBe('micro_lane');
		expect(
			candidateHeaderFamily(
				BASE_HEADER.replace('candidate_id', 'candidate:id').split('|'),
			),
		).toBeNull();
		expect(
			candidateHeaderFamily(
				BASE_HEADER.replace('impact_context', 'impact:context').split('|'),
			),
		).toBeNull();
		expect(
			candidateHeaderFamily(
				BASE_HEADER.replace('candidate_id', 'CANDIDATE_ID').split('|'),
			),
		).toBeNull();
		expect(
			candidateHeaderFamily(`${BASE_HEADER} | extra`.split('|')),
		).toBeNull();
	});

	test('selects the first marker-bearing header over a pipe-delimited transcript preamble', () => {
		expect(
			selectCandidateHeader([
				'Review progress | inspected changed files',
				BASE_HEADER,
			]),
		).toEqual({
			lineIndex: 1,
			fields: BASE_HEADER.split('|').map((field) => field.trim()),
			family: 'base_explorer',
			markerBearing: true,
		});
	});

	test('keeps the first malformed candidate marker authoritative', () => {
		expect(
			selectCandidateHeader([
				'[CANDIDATE] | not | a | canonical | header',
				BASE_HEADER,
			]),
		).toMatchObject({
			lineIndex: 0,
			family: null,
			markerBearing: true,
		});
	});

	test('retains the first tabular line only when no candidate marker exists', () => {
		expect(selectCandidateHeader(['legacy | positional header'])).toEqual({
			lineIndex: 0,
			fields: ['legacy', 'positional header'],
			family: null,
			markerBearing: false,
		});
	});

	test('splits escaped pipes without dropping boundary fields', () => {
		expect(splitPipeFields('left\\|escaped | right |')).toEqual([
			'left|escaped ',
			' right ',
			'',
		]);
	});

	test('strips fenced table noise before shared exact-header discovery', () => {
		const row =
			'C-1 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH';
		const text = `\`\`\`text\nfoo | bar\n\`\`\`\n${BASE_HEADER}\n${row}`;
		const parsed = parseCandidates(artifact(text), {
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			expected_family: 'base_explorer',
			expected_lane: 'correctness-state',
		});
		expect(parsed.candidates).toHaveLength(1);
		expect(prReviewDiscoveryArtifactCoversLane(text, 'correctness-state')).toBe(
			true,
		);
	});

	test.each([
		[
			'base candidate',
			'base_explorer',
			BASE_HEADER,
			'correctness-state',
			'C-1 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH',
			false,
		] as const,
		[
			'base CLEAN',
			'base_explorer',
			BASE_HEADER,
			'correctness-state',
			`[CLEAN] | correctness-state | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`,
			true,
		] as const,
		[
			'micro candidate',
			'micro_lane',
			MICRO_HEADER,
			'concurrency-state',
			'M-1 | concurrency-state | HIGH | concurrency | src/a.ts:1 | claim | invariant | evidence | HIGH',
			false,
		] as const,
		[
			'micro CLEAN',
			'micro_lane',
			MICRO_HEADER,
			'concurrency-state',
			`[CLEAN] | concurrency-state | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`,
			true,
		] as const,
	])('ignores pipe-delimited transcript preamble before a canonical %s section', (_label, family, header, lane, row, expectClean) => {
		// Regression: the first incidental pipe line used to become the header,
		// so valid async-lane output failed at both parser trust boundaries.
		const text = `Review progress | inspected changed files\nContinuing analysis before the final machine-readable section.\n${header}\n${row}`;
		const parsed = parseCandidates(artifact(text), {
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			expected_family: family,
			...(family === 'base_explorer'
				? { expected_lane: lane }
				: { expected_micro_lane: lane }),
		});

		expect(parsed.error_code).toBeUndefined();
		expect(parsed.diagnostics.parse_errors).toBe(0);
		expect(parsed.candidates).toHaveLength(expectClean ? 0 : 1);
		expect(parsed.clean_attestation !== undefined).toBe(expectClean);
		expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(true);
	});

	test('rejects a malformed first candidate marker even before a later canonical header', () => {
		const row =
			'C-1 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH';
		const text = `[CANDIDATE] | not | a | canonical | header\n${BASE_HEADER}\n${row}`;
		const parsed = parseCandidates(artifact(text), {
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			expected_family: 'base_explorer',
			expected_lane: 'correctness-state',
		});

		expect(parsed.error_code).toBe('invalid-candidate-header');
		expect(parsed.candidates).toEqual([]);
		expect(prReviewDiscoveryArtifactCoversLane(text, 'correctness-state')).toBe(
			false,
		);
	});

	test('retains parser-only positional fallback when no candidate marker exists', () => {
		const text =
			'legacy | positional header\nC-1 | correctness-state | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH';
		const parsed = parseCandidates(artifact(text), {
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			expected_family: 'base_explorer',
			expected_lane: 'correctness-state',
		});

		expect(parsed.candidates).toHaveLength(1);
		expect(parsed.diagnostics.parse_errors).toBe(0);
		// The controller gate still requires one canonical marker-bearing header.
		expect(prReviewDiscoveryArtifactCoversLane(text, 'correctness-state')).toBe(
			false,
		);
	});

	test('does not let malformed or duplicate rows authenticate a CLEAN artifact', () => {
		const lane = 'correctness-state';
		const clean = `[CLEAN] | ${lane} | ${CLEAN_SCOPE} | ${CLEAN_EVIDENCE}`;
		const malformed =
			'C-BAD | correctness-state | INVALID | correctness | src/a.ts:1 | claim | evidence | impact | HIGH';
		for (const text of [
			`${BASE_HEADER}\n${malformed}\n${clean}`,
			`${BASE_HEADER}\n${clean}\n${clean}`,
		]) {
			const parsed = parseCandidates(artifact(text), {
				accept_partial: false,
				accept_degraded: false,
				degraded: false,
				row_format_version: 1,
				expected_family: 'base_explorer',
				expected_lane: lane,
			});
			expect(parsed.clean_attestation).toBeUndefined();
			expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(false);
		}
	});

	test('rejects unowned rows while accepting every explicitly consolidated sibling', () => {
		const text = `${BASE_HEADER}\n[CLEAN] | intent-architecture | ${CLEAN_SCOPE} | architecture evidence covers the full diff\n[CLEAN] | correctness-state | ${CLEAN_SCOPE} | correctness evidence covers the full diff`;
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'intent-architecture'),
		).toBe(false);
		const owned = ['intent-architecture', 'correctness-state'];
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'intent-architecture', owned),
		).toBe(true);
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'correctness-state', owned),
		).toBe(true);
	});

	test('never credits a micro family outside ownership, even while salvaging', () => {
		const text = `${MICRO_HEADER}\nM-AUTH | auth-identity-secrets | HIGH | security | src/auth.ts:1 | claim | invariant | auth evidence | HIGH\nM-PRIVACY | privacy-observability | HIGH | privacy | src/log.ts:1 | claim | invariant | privacy evidence | HIGH`;
		// The owned row is real work and now establishes coverage (approved
		// salvage) instead of being discarded because a foreign row sits beside it.
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'auth-identity-secrets', [
				'auth-identity-secrets',
			]),
		).toBe(true);
		// The integrity property that must NOT move: when a source is scoped to the
		// lanes it owns, the out-of-ownership row is excluded from the credited
		// inventory.
		expect(
			_test_exports.extractCandidateIds(text, 'micro_lane', [
				'auth-identity-secrets',
			]),
		).toEqual(['M-AUTH']);
		// Unscoped extraction is intentional for full-ownership sources (a
		// subagent's inconsistent lane labelling must not silently drop a real
		// candidate), so it keeps both rows. Pinned so the difference between the
		// two shapes is explicit rather than accidental.
		expect(_test_exports.extractCandidateIds(text, 'micro_lane')).toEqual([
			'M-AUTH',
			'M-PRIVACY',
		]);
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'auth-identity-secrets', [
				'auth-identity-secrets',
				'privacy-observability',
			]),
		).toBe(true);
	});

	test('retains a valid owned candidate despite a short foreign row', () => {
		const text = `${BASE_HEADER}\nC-OWNED | intent-architecture | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH\nC-FOREIGN | security-trust | HIGH`;
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'intent-architecture', [
				'intent-architecture',
			]),
		).toBe(true);
		// The malformed foreign row contributes nothing to the inventory.
		expect(
			_test_exports.extractCandidateIds(text, 'base_explorer', [
				'intent-architecture',
			]),
		).toEqual(['C-OWNED']);
	});
});

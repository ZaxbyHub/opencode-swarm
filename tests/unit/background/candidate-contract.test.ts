import { describe, expect, test } from 'bun:test';
import {
	analyzeCandidateFields,
	analyzeCleanFields,
	CANDIDATE_DIAGNOSTIC_PREVIEW_CHARS,
	candidateHeaderFamily,
	type RowFormatFamily,
} from '../../../src/background/candidate-contract';
import {
	type ArtifactInput,
	parseCandidates,
} from '../../../src/background/candidate-parser';
import { prReviewDiscoveryArtifactCoversLane } from '../../../src/hooks/pr-workflow-gate';

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
	])('rejects malformed or missing canonical headers identically for %s', (family, header, lane, row) => {
		const misorderedHeader = header.replace(
			'severity | category',
			'category | severity',
		);
		const malformedArtifacts = [
			`${header} | extra\n${row}`,
			`${misorderedHeader}\n${row}`,
			`[CANDIDATE] | ${row}`,
		];
		for (const text of malformedArtifacts) {
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
			expect(parsed.candidates).toEqual([]);
			expect(parsed.error_code).toBe('invalid-candidate-header');
			expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(false);
		}
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

	test('rejects a candidate from a NOT_TRIGGERED micro family outside ownership', () => {
		const text = `${MICRO_HEADER}\nM-AUTH | auth-identity-secrets | HIGH | security | src/auth.ts:1 | claim | invariant | auth evidence | HIGH\nM-PRIVACY | privacy-observability | HIGH | privacy | src/log.ts:1 | claim | invariant | privacy evidence | HIGH`;
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'auth-identity-secrets', [
				'auth-identity-secrets',
			]),
		).toBe(false);
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'auth-identity-secrets', [
				'auth-identity-secrets',
				'privacy-observability',
			]),
		).toBe(true);
	});

	test('rejects an unprefixed short foreign row after a valid owned candidate', () => {
		const text = `${BASE_HEADER}\nC-OWNED | intent-architecture | HIGH | correctness | src/a.ts:1 | claim | evidence | impact | HIGH\nC-FOREIGN | security-trust | HIGH`;
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'intent-architecture', [
				'intent-architecture',
			]),
		).toBe(false);
	});
});

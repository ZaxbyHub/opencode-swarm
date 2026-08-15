import { describe, expect, test } from 'bun:test';
import {
	analyzeCleanFields,
	CANDIDATE_HEADERS,
	normalizeCandidateArtifact,
} from '../../../src/background/candidate-contract.js';
import {
	type ArtifactInput,
	parseCandidates,
} from '../../../src/background/candidate-parser.js';
import {
	_test_exports,
	prReviewDiscoveryArtifactCoversLane,
} from '../../../src/hooks/pr-workflow-gate.js';

const BASE_HEADER = CANDIDATE_HEADERS.base_explorer;
const MICRO_HEADER = CANDIDATE_HEADERS.micro_lane;
const SCOPE = 'complete exact changed-file review';
const EVIDENCE = 'no finding after checking the complete changed surface';

function artifact(text: string): ArtifactInput {
	return {
		output_ref: 'L1:batch:lane:digest',
		batchId: 'batch',
		laneId: 'lane',
		agent: 'explorer',
		role: 'explorer',
		digest: 'a'.repeat(64),
		text,
		artifact_status: 'ok',
		source: 'collect_lane_results',
		produced_at: '2026-08-14T00:00:00.000Z',
	};
}

function parseNormalized(
	text: string,
	family: 'base_explorer' | 'micro_lane',
	lane: string,
) {
	return parseCandidates(
		artifact(normalizeCandidateArtifact(text, family).text),
		{
			accept_partial: false,
			accept_degraded: false,
			degraded: false,
			row_format_version: 1,
			producer: 'swarm-pr-review',
			expected_family: family,
			...(family === 'base_explorer'
				? { expected_lane: lane }
				: { expected_micro_lane: lane }),
		},
	);
}

describe('candidate artifact terminal protocol recovery', () => {
	test('recovers the exact v7.139.7 paired-base terminal fence shape', () => {
		// Shipped behavior removed the entire terminal fence before parsing, so a
		// semantically complete third retry failed with discovery.header.
		const text = [
			'Completed the requested security and reliability review.',
			'```',
			BASE_HEADER,
			'[CANDIDATE] | R-1 | reliability-performance | LOW | cleanup | tests/a.test.ts:1 | child cleanup can leak | observed teardown path | repeated runs retain handles | MEDIUM',
			'[CANDIDATE] | R-2 | reliability-performance | INFO | diagnostics | src/a.ts:2 | git error loses context | inspected failure path | debugging becomes slower | LOW',
			`[CLEAN] | security-trust | ${SCOPE} | ${EVIDENCE} | HIGH`,
			'```',
		].join('\n');
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.repairKinds).toEqual([
			'terminal-protocol-fence',
			'redundant-clean-confidence',
		]);
		expect(normalized.synthesizedHeader).toBe(false);

		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'reliability-performance', [
				'security-trust',
				'reliability-performance',
			]),
		).toBe(true);
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'security-trust', [
				'security-trust',
				'reliability-performance',
			]),
		).toBe(true);
		expect(
			_test_exports.extractCandidateIds(text, 'base_explorer', [
				'reliability-performance',
			]),
		).toEqual(['R-1', 'R-2']);
	});

	test('drops one redundant CLEAN confidence token and nothing broader', () => {
		// Shipped behavior rejected this exact retry shape as five total CLEAN
		// fields even though the final token was an unambiguous confidence enum.
		const recoverable = `${BASE_HEADER}\n[CLEAN] | security-trust | ${SCOPE} | ${EVIDENCE} | HIGH`;
		expect(
			analyzeCleanFields(
				recoverable.split('\n')[1].split('|'),
				'base_explorer',
				'security-trust',
			).valid,
		).toBe(false);
		expect(
			normalizeCandidateArtifact(recoverable, 'base_explorer').repairKinds,
		).toEqual(['redundant-clean-confidence']);
		const parsed = parseNormalized(
			recoverable,
			'base_explorer',
			'security-trust',
		);
		expect(parsed.error).toBeUndefined();
		expect(parsed.clean_attestation?.lane).toBe('security-trust');

		// Recoverability contract change (PR-review deadlock fix): extra trailing
		// pipe segments on a [CLEAN] row are tail-merged into the free-text
		// evidence field instead of rejecting the row. Previously-shipped behavior
		// rejected these shapes outright; the captured PR #2177 run showed
		// frontier-model prose (regex chars like `,;|`) reliably trips them.
		for (const salvaged of [
			`${BASE_HEADER}\n[CLEAN] | security-trust | ${SCOPE} | ${EVIDENCE} | CERTAIN`,
			`${BASE_HEADER}\n[CLEAN] | security-trust | ${SCOPE} | ${EVIDENCE} | HIGH | EXTRA`,
		]) {
			const result = parseNormalized(
				salvaged,
				'base_explorer',
				'security-trust',
			);
			expect(result.error).toBeUndefined();
			expect(result.clean_attestation?.lane).toBe('security-trust');
			expect(result.clean_attestation?.evidence).toContain(EVIDENCE);
			expect(
				normalizeCandidateArtifact(salvaged, 'base_explorer').repairKinds,
			).toContain('clean-evidence-pipe-tail-merge');
		}
		// Structurally broken rows stay rejected: evidence below the minimum
		// length is not a pipe defect and must not be salvaged.
		expect(
			parseNormalized(
				`${BASE_HEADER}\n[CLEAN] | security-trust | ${SCOPE} | too short`,
				'base_explorer',
				'security-trust',
			).error,
		).toBeDefined();
	});

	test('recovers the equivalent micro-lane terminal protocol', () => {
		const text = [
			'Final findings:',
			'```text',
			MICRO_HEADER,
			'[CANDIDATE] | M-1 | auth-identity-secrets | HIGH | security | src/auth.ts:4 | missing authorization | authorization invariant | request reaches protected state | HIGH',
			'```',
		].join('\n');
		const parsed = parseNormalized(text, 'micro_lane', 'auth-identity-secrets');
		expect(parsed.error).toBeUndefined();
		expect(parsed.candidates.map((row) => row.candidate_id)).toEqual(['M-1']);
	});

	test('preserves escaped evidence pipes while removing only the final delimiter', () => {
		const text = `${BASE_HEADER}\n[CLEAN] | security-trust | ${SCOPE} | checked LOW \\| HIGH paths without findings | MEDIUM`;
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.text).toContain('checked LOW \\| HIGH paths');
		expect(normalized.text).not.toContain('findings | MEDIUM');
		const parsed = parseNormalized(text, 'base_explorer', 'security-trust');
		expect(parsed.clean_attestation?.evidence).toBe(
			'checked LOW | HIGH paths without findings',
		);
	});

	test('keeps quoted, ambiguous, malformed, and wrong-family fences isolated', () => {
		const validRow =
			'R-1 | reliability-performance | LOW | cleanup | tests/a.test.ts:1 | claim text | evidence summary | impact context | MEDIUM';
		const nonterminal = `\`\`\`\n${BASE_HEADER}\n${validRow}\n\`\`\`\ntrailing prose`;
		const unterminated = `\`\`\`\n${BASE_HEADER}\n${validRow}`;
		for (const rejected of [
			nonterminal,
			unterminated,
			`\`\`\`\n${BASE_HEADER}\n${validRow}\n\`\`\`\ntrailing prose`,
			`\`\`\`\n${BASE_HEADER}\nanalysis prose inside protocol\n${validRow}\n\`\`\``,
			`\`\`\`\n${MICRO_HEADER}\nM-1 | auth-identity-secrets | HIGH | security | src/a.ts:1 | claim | invariant | evidence | HIGH\n\`\`\``,
			`[CANDIDATE] | malformed outer marker\n\`\`\`\n${BASE_HEADER}\n${validRow}\n\`\`\``,
			`\`\`\`\n${BASE_HEADER}\nR-1 | reliability-performance | INVALID | cleanup | tests/a.test.ts:1 | claim | evidence | impact | MEDIUM\n\`\`\``,
		]) {
			expect(
				prReviewDiscoveryArtifactCoversLane(
					rejected,
					'reliability-performance',
				),
			).toBe(false);
		}
	});

	test('rejects an earlier fenced protocol example as ambiguous', () => {
		const validRow =
			'R-1 | reliability-performance | LOW | cleanup | tests/a.test.ts:1 | claim text | evidence summary | impact context | MEDIUM';
		const text = [
			'Example protocol:',
			'```',
			BASE_HEADER,
			validRow,
			'```',
			'Actual protocol:',
			'```',
			BASE_HEADER,
			validRow,
			'```',
		].join('\n');
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'reliability-performance'),
		).toBe(false);
	});

	test('keeps duplicate-id and lane-ownership checks after fence recovery', () => {
		const row =
			'R-1 | reliability-performance | LOW | cleanup | tests/a.test.ts:1 | claim text | evidence summary | impact context | MEDIUM';
		const duplicate = ['```', BASE_HEADER, row, row, '```'].join('\n');
		expect(
			prReviewDiscoveryArtifactCoversLane(duplicate, 'reliability-performance'),
		).toBe(false);

		const foreign = [
			'```',
			BASE_HEADER,
			row.replace('reliability-performance', 'security-trust'),
			'```',
		].join('\n');
		expect(
			prReviewDiscoveryArtifactCoversLane(foreign, 'reliability-performance'),
		).toBe(false);
	});

	test('allows an earlier quoted fence before one valid terminal protocol fence', () => {
		const text = [
			'Example only:',
			'```',
			'foo | bar',
			'```',
			'Actual final protocol:',
			'```',
			BASE_HEADER,
			`[CLEAN] | reliability-performance | ${SCOPE} | ${EVIDENCE}`,
			'```',
		].join('\n');
		expect(
			prReviewDiscoveryArtifactCoversLane(text, 'reliability-performance'),
		).toBe(true);
	});
});

import { describe, expect, test } from 'bun:test';
import { prReviewDiscoveryArtifactCoversLane } from '../../../src/hooks/pr-workflow-gate.js';

/**
 * Issue #2131 finding 1b — consolidated micro/base lanes must accept a MIXED
 * artifact: [CANDIDATE] rows for obligations with findings AND distinct
 * [CLEAN] attestations for sibling obligations that had zero findings.
 *
 * The prompt suffix previously said "[CLEAN] ... never alongside [CANDIDATE]
 * rows" (per-lane), which suppressed the required per-obligation CLEAN rows
 * and stalled Phase 4. The collection routes ONE coverage check per owned
 * lane (pr-workflow-gate.ts analyzePrReviewDiscoveryArtifact), and the parser
 * skips sibling-obligation CLEAN rows (candidate-parser.ts), so a correctly
 * structured mixed artifact already parses. These tests prove that and guard
 * against regression of either the prompt wording or the per-owned-lane
 * extraction.
 */

const MICRO_HEADER =
	'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';

const BASE_HEADER =
	'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags';

describe('consolidated lane mixed CANDIDATE + CLEAN (issue #2131 finding 1b)', () => {
	test('base consolidated lane: CANDIDATE for one obligation + CLEAN for two siblings covers all three', () => {
		const owned = ['intent-architecture', 'data-model', 'error-handling'];
		const artifact = [
			BASE_HEADER,
			'[CANDIDATE] | cand-arch-001 | intent-architecture | HIGH | correctness | src/a.ts:12 | architectural claim text | evidence summary text | impact context text | HIGH',
			'[CLEAN] | data-model | reviewed every data-model touchpoint in the diff | concrete evidence describing the data-model coverage here',
			'[CLEAN] | error-handling | reviewed every error-handling path in the diff | concrete evidence describing the error-handling coverage here',
		].join('\n');

		for (const lane of owned) {
			expect(
				prReviewDiscoveryArtifactCoversLane(
					artifact,
					lane,
					owned,
					'swarm-pr-review:base',
				),
				`lane ${lane} should be covered`,
			).toBe(true);
		}
	});

	test('micro consolidated lane: CANDIDATE for one obligation + CLEAN for two siblings covers all three', () => {
		const owned = [
			'auth-identity-secrets',
			'privacy-data-handling',
			'pii-leakage',
		];
		const artifact = [
			MICRO_HEADER,
			'[CANDIDATE] | cand-auth-001 | auth-identity-secrets | HIGH | correctness | src/auth.ts:42 | token logged to stdout | secrets-in-logs | console.log(token) found | HIGH',
			'[CLEAN] | privacy-data-handling | reviewed all PII sinks across the diff | no unsanitized PII egress found in the changed files',
			'[CLEAN] | pii-leakage | no PII reaches logs or API responses | every egress point redacts PII before output verified',
		].join('\n');

		for (const lane of owned) {
			expect(
				prReviewDiscoveryArtifactCoversLane(
					artifact,
					lane,
					owned,
					'swarm-pr-review:micro',
				),
				`lane ${lane} should be covered`,
			).toBe(true);
		}
	});

	test('two CLEAN attestations for DIFFERENT obligations do NOT trip invalid-clean-attestation', () => {
		// The parser's "Only one CLEAN attestation is allowed per artifact" guard
		// must not fire when the two CLEAN rows name different owned obligations,
		// because each is extracted in its own per-owned-lane pass.
		const owned = ['data-model', 'error-handling'];
		const artifact = [
			BASE_HEADER,
			'[CLEAN] | data-model | coverage of data model dimension | evidence for data model dimension here',
			'[CLEAN] | error-handling | coverage of error handling dimension | evidence for error handling dimension here',
		].join('\n');

		expect(
			prReviewDiscoveryArtifactCoversLane(
				artifact,
				'data-model',
				owned,
				'swarm-pr-review:base',
			),
		).toBe(true);
		expect(
			prReviewDiscoveryArtifactCoversLane(
				artifact,
				'error-handling',
				owned,
				'swarm-pr-review:base',
			),
		).toBe(true);
	});
});

import { describe, expect, test } from 'bun:test';
import {
	buildPrReviewContractCard,
	encodePrReviewVerdictRow,
	PR_REVIEW_CRITIC_STATUSES,
	PR_REVIEW_FINDINGS_WRITE_MAX_BYTES,
	PR_REVIEW_HANDOFF_WRITE_MAX_BYTES,
	PR_REVIEW_REVIEWER_CLASSIFICATIONS,
	PR_REVIEW_REVIEWER_EVIDENCE_TYPES,
	PR_REVIEW_SEVERITIES,
	parsePrReviewVerdictRow,
	serializedPrReviewArtifactInputBytes,
	WritePrReviewArtifactArgsSchema,
} from '../../../src/background/pr-review-contract.js';

describe('PR-review executable contract (#2333)', () => {
	test('canonical REVIEWED free text round-trips pipes, backslashes, and line breaks', () => {
		const fields = [
			'[REVIEWED]',
			'C-1',
			'CONFIRMED',
			'STRUCTURALLY_PROVEN',
			'HIGH',
			'YES',
			'src/a.ts:1',
			'a|b\\c\nd\re',
			'probe',
			'reviewer',
			'HIGH_IMPACT',
			'SECURITY,GIT',
		];
		const encoded = encodePrReviewVerdictRow('reviewer', fields);
		const parsed = parsePrReviewVerdictRow(encoded, 'reviewer');
		expect(parsed?.fields).toEqual(fields);
		expect(parsed?.overflowClass).toBe('canonical');
		expect(parsed?.recoveredOverflow).toBe(false);
	});

	test('legacy overflow remains compatible but is explicitly classified lossy', () => {
		const parsed = parsePrReviewVerdictRow(
			'[CRITIC] | C-1 | UPHELD | HIGH | rationale | required a | b',
			'critic',
		);
		expect(parsed?.fields).toHaveLength(6);
		expect(parsed?.overflowClass).toBe('legacy-lossy');
		expect(parsed?.recoveredOverflow).toBe(true);
	});

	test('a harmless trailing legacy delimiter is classified fidelity-safe', () => {
		const parsed = parsePrReviewVerdictRow(
			'[CRITIC] | C-1 | UPHELD | HIGH | rationale | required change |',
			'critic',
		);
		expect(parsed?.fields).toEqual([
			'[CRITIC]',
			'C-1',
			'UPHELD',
			'HIGH',
			'rationale',
			'required change|',
		]);
		expect(parsed?.overflowClass).toBe('legacy-fidelity-safe');
		expect(parsed?.recoveredOverflow).toBe(true);
	});

	test('serialized writer limits accept the boundary and reject one byte beyond it', () => {
		const exactHandoff = {
			kind: 'handoff' as const,
			run_id: 'size-boundary',
			pr_head_sha: 'abcdef1',
			handoff: {
				pr_url: 'https://github.com/owner/repo/pull/1',
				finding_ids: ['C-1'],
				summary: 'summary',
				provenance: [
					...Array.from({ length: 30 }, () => 'x'.repeat(4000)),
					'x',
				],
			},
		};
		const initialBytes = serializedPrReviewArtifactInputBytes(exactHandoff);
		exactHandoff.handoff.provenance[30] = 'x'.repeat(
			1 + PR_REVIEW_HANDOFF_WRITE_MAX_BYTES - initialBytes,
		);
		expect(serializedPrReviewArtifactInputBytes(exactHandoff)).toBe(
			PR_REVIEW_HANDOFF_WRITE_MAX_BYTES,
		);
		expect(
			WritePrReviewArtifactArgsSchema.safeParse(exactHandoff).success,
		).toBe(true);
		const oversizedHandoff = structuredClone(exactHandoff);
		oversizedHandoff.handoff.provenance[30] += 'x';
		expect(
			WritePrReviewArtifactArgsSchema.safeParse(oversizedHandoff).success,
		).toBe(false);

		const finding = {
			finding_id: 'C-1',
			status: 'PENDING' as const,
			file_line: 'src/a.ts:1',
			evidence: 'x'.repeat(20_000),
			next_action: 'route_to_reviewer' as const,
			severity: 'HIGH' as const,
		};
		const oversizedFindings = {
			kind: 'findings' as const,
			run_id: 'size-overflow',
			pr_head_sha: 'abcdef1',
			boundary: 'post_explorer' as const,
			records: Array.from({ length: 160 }, (_unused, index) => ({
				...finding,
				finding_id: `C-${index}`,
			})),
		};
		expect(
			serializedPrReviewArtifactInputBytes(oversizedFindings),
		).toBeGreaterThan(PR_REVIEW_FINDINGS_WRITE_MAX_BYTES);
		expect(
			WritePrReviewArtifactArgsSchema.safeParse(oversizedFindings).success,
		).toBe(false);
	});

	test('contract card is schema-derived and discarded examples are not live rows', () => {
		const card = buildPrReviewContractCard();
		for (const value of [
			...PR_REVIEW_REVIEWER_CLASSIFICATIONS,
			...PR_REVIEW_REVIEWER_EVIDENCE_TYPES,
			...PR_REVIEW_SEVERITIES,
			...PR_REVIEW_CRITIC_STATUSES,
		]) {
			expect(card).toContain(value);
		}
		expect(card.startsWith('[PR-REVIEW CONTRACT CARD]')).toBe(true);
		expect(card).not.toContain('\n[REVIEWED] | discarded-id |');
		expect(card).not.toContain('\n[CRITIC] | discarded-id |');
	});
});

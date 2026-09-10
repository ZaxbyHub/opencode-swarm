import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { allowedPrReviewReportVerdicts } from '../../../src/pr-review/completion.js';
import {
	assessTerminalReadiness,
	evaluateFinalFindingPolicy,
	MAX_FINDING_SYNTHESIS_CANDIDATES,
	parseCandidateConfidence,
	persistReviewOutcome,
	readReviewOutcome,
	settleCriticFinding,
	synthesizePrReviewFindings,
} from '../../../src/pr-review/finding-policy.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const candidate = (overrides: Record<string, unknown> = {}) => ({
	finding: 'The request path skips authorization before reading the record.',
	severity: 'HIGH',
	action: 'handoff_to_feedback',
	confidence: 'MEDIUM',
	category: 'authorization',
	location: { file: 'src/api/records.ts', line: 42 },
	provenance: { lane: 'reviewer', identity: 'reviewer-a' },
	...overrides,
});

describe('issue #2491 — finding confidence, settlement, and report policy (AC4–AC8)', () => {
	test('parses categorical confidence and synthesizes semantic agreement', () => {
		expect(parseCandidateConfidence('HIGH')).toMatchObject({
			label: 'HIGH',
			score: expect.any(Number),
		});

		const result = synthesizePrReviewFindings({
			candidates: [
				candidate({
					finding: 'Authorization is skipped before reading the record.',
					provenance: { lane: 'reviewer', identity: 'reviewer-a' },
				}),
				candidate({
					finding:
						'The record endpoint reads data before checking the caller permissions.',
					provenance: { lane: 'reviewer', identity: 'reviewer-b' },
				}),
				candidate({
					finding: 'Authorization is skipped before reading the record.',
					provenance: { lane: 'reviewer', identity: 'reviewer-a' },
				}),
				candidate({
					finding: 'The export endpoint has no authorization check.',
					location: { file: 'src/api/export.ts', line: 88 },
					provenance: { lane: 'reviewer', identity: 'reviewer-c' },
				}),
			],
		});

		expect(result.findings).toHaveLength(2);
		expect(result.findings[0]).toMatchObject({
			agreementCount: 2,
			confidence: 'HIGH',
			provenance: [
				{ lane: 'reviewer', identity: 'reviewer-a' },
				{ lane: 'reviewer', identity: 'reviewer-b' },
			],
		});
		expect(result.findings[1]).toMatchObject({
			location: { file: 'src/api/export.ts', line: 88 },
			agreementCount: 1,
		});
	});

	test('never filters or demotes a CRITICAL finding because confidence is LOW', () => {
		const result = synthesizePrReviewFindings({
			candidates: [
				candidate({
					finding:
						'The deployment exposes credentials to unauthenticated callers.',
					severity: 'CRITICAL',
					confidence: 'LOW',
					action: 'report',
				}),
			],
		});

		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]).toMatchObject({
			severity: 'CRITICAL',
			action: 'report',
		});
	});

	describe('finding synthesis regressions (F-002, F-017)', () => {
		test('F-002: weak lexical overlap does not merge distinct same-location findings', () => {
			// Before the fix, a Jaccard threshold of 0.2 merged these two distinct
			// parser defects and retained only the first finding/remediation.
			const result = synthesizePrReviewFindings({
				candidates: [
					candidate({
						finding:
							'The parser accepts untrusted payloads without validation.',
						sourceFindingId: 'f-parser-validation',
					}),
					candidate({
						finding:
							'The parser emits a detailed error for malformed payloads.',
						sourceFindingId: 'f-parser-error',
					}),
				],
			});

			expect(result.findings).toHaveLength(2);
			expect(
				result.findings.map((finding) => finding.sourceFindingIds),
			).toEqual([['f-parser-validation'], ['f-parser-error']]);
		});

		test('F-017: synthesis rejects input above its explicit candidate bound', () => {
			// Before the fix, pairwise synthesis accepted arbitrarily large arrays,
			// allowing a byte-valid artifact to consume unbounded CPU.
			const candidates = Array.from(
				{ length: MAX_FINDING_SYNTHESIS_CANDIDATES + 1 },
				(_, index) =>
					candidate({
						finding: `Distinct finding ${index}`,
						location: { file: 'src/parser.ts', line: index + 1 },
					}),
			);

			expect(() => synthesizePrReviewFindings({ candidates })).toThrow(
				/at most 256 candidates/,
			);
		});
	});

	test('FB-018: complete verdict eligibility requires an explicit finding set', () => {
		const result = evaluateFinalFindingPolicy({
			policyVersion: 1,
			finalStatus: 'COMPLETE',
			coverage: { kind: 'base', quality: 'complete', provenance: 'valid' },
			findings: [
				{
					id: 'high-finding',
					severity: 'HIGH',
					action: 'report',
					status: 'CONFIRMED',
				},
			],
		});
		expect(
			// Callers must pass the authoritative finding projection to the
			// required second argument; a confirmed HIGH finding cannot approve.
			allowedPrReviewReportVerdicts(
				'COMPLETE',
				result.blockingFindingIds.map((id) => ({
					id,
					severity: 'HIGH',
					action: 'report',
					status: 'CONFIRMED',
				})),
			),
		).toEqual(['REQUEST_CHANGES', 'INCOMPLETE']);
	});

	test('projects final status, severity, action, and coverage through a versioned policy', () => {
		const critical = evaluateFinalFindingPolicy({
			policyVersion: 1,
			finalStatus: 'COMPLETE',
			coverage: { kind: 'base', quality: 'complete' },
			findings: [
				{
					severity: 'CRITICAL',
					action: 'report',
					status: 'UNRESOLVED',
				},
			],
		});
		expect(critical.policyVersion).toBe(1);
		expect(critical.permittedVerdicts).not.toContain('APPROVE');
		expect(critical.permittedVerdicts).toContain('REQUEST_CHANGES');

		const explicitCases = [
			{
				finding: {
					severity: 'HIGH',
					action: 'handoff_to_feedback',
					status: 'UNRESOLVED',
				},
				expected: 'REQUEST_CHANGES',
			},
			{
				finding: {
					severity: 'MEDIUM',
					action: 'handoff_to_feedback',
					status: 'UNRESOLVED',
				},
				expected: 'REQUEST_CHANGES',
			},
			{
				finding: {
					severity: 'MEDIUM',
					action: 'suppress_with_reason',
					status: 'NON_ACTIONABLE',
				},
				expected: 'APPROVE',
			},
		] as const;

		for (const { finding, expected } of explicitCases) {
			const result = evaluateFinalFindingPolicy({
				policyVersion: 1,
				finalStatus: 'COMPLETE',
				coverage: { kind: 'base', quality: 'complete' },
				findings: [finding],
			});
			expect(result.permittedVerdicts).toContain(expected);
		}

		const degradedCoverage = evaluateFinalFindingPolicy({
			policyVersion: 1,
			finalStatus: 'COMPLETE',
			coverage: {
				kind: 'micro',
				quality: 'degraded',
				provenance: 'valid',
				disclosed: true,
			},
			findings: [],
		});
		expect(degradedCoverage).toMatchObject({
			coverageDisposition: 'DEGRADED_DISCLOSED',
			permittedVerdicts: expect.arrayContaining(['INCOMPLETE']),
		});
	});

	test('settles critic outcomes into final severity/action and feedback membership', () => {
		const upheld = settleCriticFinding({
			finding: {
				id: 'f-upheld',
				severity: 'HIGH',
				action: 'handoff_to_feedback',
				status: 'UNRESOLVED',
			},
			outcome: 'UPHELD',
		});
		expect(upheld).toMatchObject({
			terminal: true,
			finalFinding: {
				severity: 'HIGH',
				action: 'handoff_to_feedback',
				status: 'UNRESOLVED',
			},
			handoffFindingIds: ['f-upheld'],
		});

		const downgraded = settleCriticFinding({
			finding: {
				id: 'f-downgraded',
				severity: 'HIGH',
				action: 'handoff_to_feedback',
				status: 'UNRESOLVED',
			},
			outcome: 'DOWNGRADED',
			finalSeverity: 'MEDIUM',
			finalAction: 'handoff_to_feedback',
		});
		expect(downgraded).toMatchObject({
			terminal: true,
			finalFinding: {
				severity: 'MEDIUM',
				action: 'handoff_to_feedback',
				status: 'UNRESOLVED',
			},
			handoffFindingIds: ['f-downgraded'],
		});

		const disproved = settleCriticFinding({
			finding: {
				id: 'f-disproved',
				severity: 'HIGH',
				action: 'handoff_to_feedback',
				status: 'UNRESOLVED',
			},
			outcome: 'DISPROVED',
		});
		expect(disproved).toMatchObject({
			terminal: true,
			finalFinding: {
				status: 'DISPROVED',
				action: 'suppress_with_reason',
			},
			handoffFindingIds: [],
		});

		const moreEvidence = settleCriticFinding({
			finding: {
				id: 'f-open',
				severity: 'HIGH',
				action: 'handoff_to_feedback',
				status: 'UNRESOLVED',
			},
			outcome: 'NEEDS_MORE_EVIDENCE',
		});
		expect(moreEvidence).toMatchObject({
			terminal: false,
			status: 'NEEDS_MORE_EVIDENCE',
		});
	});

	test('blocks missing receipts and invalid micro provenance, then discloses valid degraded coverage', () => {
		for (const missing of ['base', 'reviewer', 'critic'] as const) {
			const result = assessTerminalReadiness({
				baseReceipt: missing === 'base' ? null : { id: 'base-1', valid: true },
				reviewerReceipts:
					missing === 'reviewer' ? [] : [{ id: 'reviewer-1', valid: true }],
				criticReceipt:
					missing === 'critic' ? null : { id: 'critic-1', valid: true },
				coverage: { kind: 'base', quality: 'complete', provenance: 'valid' },
				council: { enabled: false },
			});
			expect(result.ready).toBe(false);
			expect(result.blockers).toContain(
				`${missing.toUpperCase()}_RECEIPT_MISSING`,
			);
		}

		const invalidMicro = assessTerminalReadiness({
			baseReceipt: { id: 'base-1', valid: true },
			reviewerReceipts: [{ id: 'reviewer-1', valid: true }],
			criticReceipt: { id: 'critic-1', valid: true },
			coverage: { kind: 'micro', quality: 'degraded', provenance: 'invalid' },
			council: { enabled: false },
		});
		expect(invalidMicro).toMatchObject({ ready: false });
		expect(invalidMicro.blockers).toContain('MICRO_PROVENANCE_INVALID');

		const validDegraded = assessTerminalReadiness({
			baseReceipt: { id: 'base-1', valid: true },
			reviewerReceipts: [{ id: 'reviewer-1', valid: true }],
			criticReceipt: { id: 'critic-1', valid: true },
			coverage: {
				kind: 'micro',
				quality: 'degraded',
				provenance: 'valid',
				disclosed: true,
			},
			council: { enabled: false },
		});
		expect(validDegraded).toMatchObject({
			ready: true,
			degradedCoverageDisclosed: true,
		});

		const councilRequired = assessTerminalReadiness({
			baseReceipt: { id: 'base-1', valid: true },
			reviewerReceipts: [{ id: 'reviewer-1', valid: true }],
			criticReceipt: { id: 'critic-1', valid: true },
			coverage: { kind: 'base', quality: 'complete', provenance: 'valid' },
			council: { enabled: true, receipt: null },
		});
		expect(councilRequired).toMatchObject({ ready: false });
		expect(councilRequired.blockers).toContain('COUNCIL_RECEIPT_MISSING');
	});

	test('persists and reads canonical evidence plus event data from disk', async () => {
		const projectRoot = canonicalMkdtemp('issue-2491-policy-');
		try {
			await mkdir(join(projectRoot, '.opencode'), { recursive: true });
			const persisted = await persistReviewOutcome({
				projectRoot,
				routeReceipt: {
					kind: 'review_route_receipt',
					version: 1,
					sessionId: 'session-2491',
					taskId: '2491-persist',
				},
				synthesis: {
					findings: [
						{
							id: 'f-1',
							confidence: 'HIGH',
							provenance: [{ identity: 'reviewer-a' }],
						},
					],
				},
			});

			const readBack = await readReviewOutcome({
				projectRoot,
				sessionId: 'session-2491',
				taskId: '2491-persist',
			});
			expect(persisted).toMatchObject({ persisted: true });
			expect(readBack).toMatchObject({
				evidence: {
					schemaVersion: 1,
					routeReceipt: { taskId: '2491-persist' },
				},
				events: expect.arrayContaining([
					expect.objectContaining({ type: 'review.route.receipt' }),
					expect.objectContaining({ type: 'review.finding.synthesis' }),
				]),
			});

			// Read both canonical files independently so an in-memory return cannot hide a failed write.
			expect(
				JSON.parse(await readFile(persisted.evidencePath, 'utf8')),
			).toMatchObject(readBack.evidence);
			expect(await readFile(persisted.eventsPath, 'utf8')).toContain(
				'review.route.receipt',
			);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});
});

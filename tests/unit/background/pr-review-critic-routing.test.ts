import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_RISK_IMPACTS,
	PR_REVIEW_RISK_TAGS,
	parsePrReviewRiskTagsField,
	parsePrReviewVerdictRow,
	prReviewFindingRequiresCritic,
} from '../../../src/background/pr-review-contract.js';

const ROOT = process.cwd();

/**
 * Issue #2383 typed critic routing — the full severity × impact × tag/unknown
 * matrix over the ONE shared production predicate, plus the centralization
 * guards: the inline routing triple may not reappear in the gate or tools, and
 * the six-dimension literal may only be defined in the contract module.
 */
describe('prReviewFindingRequiresCritic (issue #2383 typed routing)', () => {
	test('every risk impact and tag vocabulary is exported and closed', () => {
		expect([...PR_REVIEW_RISK_IMPACTS]).toEqual([
			'ORDINARY',
			'HIGH_IMPACT',
			'UNKNOWN',
		]);
		expect([...PR_REVIEW_RISK_TAGS]).toEqual([
			'SECURITY',
			'AUTH_PERMISSIONS',
			'STATE_INTEGRITY',
			'WRITE_PATH',
			'EVIDENCE_INTEGRITY',
			'GIT',
			'CONFIGURATION',
		]);
		expect(PR_REVIEW_BASE_DIMENSION_IDS).toHaveLength(6);
	});

	test('non-CONFIRMED classifications are never critic-routed', () => {
		for (const classification of ['DISPROVED', 'PRE_EXISTING', 'UNVERIFIED']) {
			for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM']) {
				expect(
					prReviewFindingRequiresCritic({
						classification,
						severity,
						risk_impact: 'HIGH_IMPACT',
						risk_tags: ['SECURITY'],
					}),
				).toBe(false);
			}
		}
	});

	test('CRITICAL and HIGH always route to critic regardless of metadata', () => {
		for (const severity of ['CRITICAL', 'HIGH']) {
			expect(
				prReviewFindingRequiresCritic({
					classification: 'CONFIRMED',
					severity,
					risk_impact: 'ORDINARY',
					risk_tags: [],
				}),
			).toBe(true);
		}
	});

	test('MEDIUM routes exactly per the typed policy', () => {
		expect(
			prReviewFindingRequiresCritic({
				classification: 'CONFIRMED',
				severity: 'MEDIUM',
				risk_impact: 'ORDINARY',
				risk_tags: [],
			}),
		).toBe(false);
		expect(
			prReviewFindingRequiresCritic({
				classification: 'CONFIRMED',
				severity: 'MEDIUM',
				risk_impact: 'HIGH_IMPACT',
				risk_tags: [],
			}),
		).toBe(true);
		expect(
			prReviewFindingRequiresCritic({
				classification: 'CONFIRMED',
				severity: 'MEDIUM',
				risk_impact: 'ORDINARY',
				risk_tags: [],
			}),
		).toBe(false);
		// Every single tag routes a MEDIUM.
		for (const tag of PR_REVIEW_RISK_TAGS) {
			expect(
				prReviewFindingRequiresCritic({
					classification: 'CONFIRMED',
					severity: 'MEDIUM',
					risk_impact: 'ORDINARY',
					risk_tags: [tag],
				}),
			).toBe(true);
		}
	});

	test('UNKNOWN/missing risk metadata always routes to critic (fail-safe)', () => {
		for (const severity of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']) {
			expect(
				prReviewFindingRequiresCritic({
					classification: 'CONFIRMED',
					severity,
					risk_impact: 'UNKNOWN',
					risk_tags: [],
				}),
			).toBe(true);
			expect(
				prReviewFindingRequiresCritic({
					classification: 'CONFIRMED',
					severity,
				}),
			).toBe(true);
		}
	});

	test('LOW follows the existing no-critic policy once metadata is known', () => {
		expect(
			prReviewFindingRequiresCritic({
				classification: 'CONFIRMED',
				severity: 'LOW',
				risk_impact: 'ORDINARY',
				risk_tags: [],
			}),
		).toBe(false);
		expect(
			prReviewFindingRequiresCritic({
				classification: 'CONFIRMED',
				severity: 'LOW',
				risk_impact: 'HIGH_IMPACT',
				risk_tags: ['GIT'],
			}),
		).toBe(false);
	});

	test('missing severity with known metadata fails safe to critic', () => {
		expect(
			prReviewFindingRequiresCritic({
				classification: 'CONFIRMED',
				risk_impact: 'ORDINARY',
				risk_tags: [],
			}),
		).toBe(true);
	});
});

describe('typed risk metadata on the REVIEWED row (issue #2383)', () => {
	const row = (
		riskImpact: string,
		riskTags: string,
		severity = 'MEDIUM',
	): string =>
		[
			'[REVIEWED]',
			'C-1',
			'CONFIRMED',
			'STRUCTURALLY_PROVEN',
			severity,
			'YES',
			'src/index.ts:1',
			'rationale text here',
			'probe text here',
			'notes here',
			riskImpact,
			riskTags,
		].join(' | ');

	test('12-field rows parse and project typed risk metadata', () => {
		const parsed = parsePrReviewVerdictRow(
			row('HIGH_IMPACT', 'SECURITY,GIT'),
			'reviewer',
		);
		expect(parsed).not.toBeNull();
		expect(parsed!.fields).toHaveLength(12);
		expect(parsed!.fields[10]).toBe('HIGH_IMPACT');
		expect(parsePrReviewRiskTagsField(parsed!.fields[11] ?? '')).toEqual([
			'SECURITY',
			'GIT',
		]);
	});

	test('legacy 10-field rows normalize to UNKNOWN / no tags (critic-routed)', () => {
		const legacy = [
			'[REVIEWED]',
			'C-1',
			'CONFIRMED',
			'STRUCTURALLY_PROVEN',
			'MEDIUM',
			'YES',
			'src/index.ts:1',
			'rationale text here',
			'probe text here',
			'notes here',
		].join(' | ');
		const parsed = parsePrReviewVerdictRow(legacy, 'reviewer');
		expect(parsed).not.toBeNull();
		expect(parsed!.fields).toHaveLength(12);
		expect(parsed!.fields[10]).toBe('UNKNOWN');
		expect(parsePrReviewRiskTagsField(parsed!.fields[11] ?? '')).toEqual([]);
		// The normalized projection fail-safes to critic under the predicate.
		expect(
			prReviewFindingRequiresCritic({
				classification: parsed!.fields[2]!,
				severity: parsed!.fields[4]!,
				risk_impact: parsed!.fields[10] as 'UNKNOWN',
				risk_tags: parsePrReviewRiskTagsField(parsed!.fields[11] ?? ''),
			}),
		).toBe(true);
	});

	test('a routing-table parity spot check through the row projection', () => {
		// The same projection sites A and B consume: row -> predicate input.
		// ORDINARY MEDIUM with no tags is NOT routed.
		const ordinary = parsePrReviewVerdictRow(row('ORDINARY', ''), 'reviewer')!;
		expect(
			prReviewFindingRequiresCritic({
				classification: ordinary.fields[2]!,
				severity: ordinary.fields[4]!,
				risk_impact: ordinary.fields[10] as 'ORDINARY',
				risk_tags: parsePrReviewRiskTagsField(ordinary.fields[11] ?? ''),
			}),
		).toBe(false);
		// The same row with one tag IS routed.
		const tagged = parsePrReviewVerdictRow(
			row('ORDINARY', 'CONFIGURATION'),
			'reviewer',
		)!;
		expect(
			prReviewFindingRequiresCritic({
				classification: tagged.fields[2]!,
				severity: tagged.fields[4]!,
				risk_impact: tagged.fields[10] as 'ORDINARY',
				risk_tags: parsePrReviewRiskTagsField(tagged.fields[11] ?? ''),
			}),
		).toBe(true);
	});
});

describe('critic-routing centralization guard (issue #2383)', () => {
	test('no inline routing severity triple remains in the gate or tools', () => {
		const files = [
			'src/hooks/pr-workflow-gate.ts',
			'src/tools/write-pr-review-artifact.ts',
			'src/tools/authorize-pr-review-reentry.ts',
		];
		for (const relative of files) {
			const source = readFileSync(join(ROOT, relative), 'utf8');
			expect(
				source.includes("['CRITICAL', 'HIGH', 'MEDIUM']"),
				`${relative} must route critics through prReviewFindingRequiresCritic, not an inline severity triple`,
			).toBe(false);
		}
	});

	test('the gate imports the shared predicate', () => {
		const source = readFileSync(
			join(ROOT, 'src/hooks/pr-workflow-gate.ts'),
			'utf8',
		);
		expect(source).toContain('prReviewFindingRequiresCritic');
	});

	test('the six-dimension literal is defined only in the contract module', () => {
		const contract = readFileSync(
			join(ROOT, 'src/background/pr-review-contract.ts'),
			'utf8',
		);
		expect(contract).toContain("'intent-architecture'");
		const guarded = [
			'src/hooks/pr-workflow-gate.ts',
			'src/tools/write-pr-review-artifact.ts',
			'src/hooks/delegation-gate.ts',
		];
		for (const relative of guarded) {
			const source = readFileSync(join(ROOT, relative), 'utf8');
			expect(
				source.includes("'intent-architecture'"),
				`${relative} must import PR_REVIEW_BASE_DIMENSION_IDS from the contract, not redefine the literal`,
			).toBe(false);
		}
	});
});

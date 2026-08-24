/**
 * Issue #2102 contract G — bounded structured General Council claims.
 *
 * Pins:
 * - structured claims detect disagreement written WITHOUT any marker phrase;
 * - members that omit claims retain the phrase/Jaccard fallback;
 * - malformed/oversized claims are bounded and cannot suppress valid
 *   fallback disagreement (including at the tool's Zod boundary via
 *   `.catch(undefined)`);
 * - marker-based disagreements are never dropped merely because structured
 *   data exists;
 * - detection stays deterministic, pure, and bounded.
 */

import { describe, expect, test } from 'bun:test';
import { detectDisagreements } from '../../../src/council/disagreement-detector';
import type {
	GeneralCouncilClaim,
	GeneralCouncilMemberResponse,
} from '../../../src/council/general-council-types';

function member(
	memberId: string,
	response: string,
	claims?: GeneralCouncilClaim[],
): GeneralCouncilMemberResponse {
	return {
		memberId,
		model: 'test-model',
		role: 'generalist',
		response,
		sources: [],
		searchQueries: [],
		confidence: 0.8,
		areasOfUncertainty: [],
		durationMs: 10,
		...(claims !== undefined ? { claims } : {}),
	};
}

function claim(
	overrides: Partial<GeneralCouncilClaim> = {},
): GeneralCouncilClaim {
	return {
		subject: 'the release strategy',
		statement: 'Ship behind a flag first.',
		stance: 'support',
		confidence: 0.8,
		...overrides,
	};
}

describe('phrase-free disagreement via structured claims', () => {
	test('oppose vs support on the same subject is detected without marker phrases', () => {
		const a = member('m1', 'Ship behind a flag first.', [
			claim({ stance: 'support' }),
		]);
		const b = member('m2', 'A flag adds complexity; land it directly.', [
			claim({
				statement: 'Land the change directly without a flag.',
				stance: 'oppose',
			}),
		]);
		const result = detectDisagreements([a, b]);
		expect(result.length).toBe(1);
		expect(result[0]!.topic).toContain('release strategy');
		const memberIds = result[0]!.positions.map((p) => p.memberId).sort();
		expect(memberIds).toEqual(['m1', 'm2']);
	});

	test('alternative vs support on the same subject is detected', () => {
		const a = member('m1', 'Option one is fine.', [
			claim({ stance: 'support' }),
		]);
		const b = member('m2', 'Another option would serve better.', [
			claim({ stance: 'alternative' }),
		]);
		expect(detectDisagreements([a, b]).length).toBe(1);
	});

	test('same stance on the same subject is not a disagreement', () => {
		const a = member('m1', 'We should ship the flag.', [
			claim({ stance: 'support' }),
		]);
		const b = member('m2', 'Agreed on shipping the flag.', [
			claim({ stance: 'support' }),
		]);
		expect(detectDisagreements([a, b])).toEqual([]);
	});

	test('neutral or concern stances are not auto-detected as contrary', () => {
		const a = member('m1', 'Fine.', [claim({ stance: 'support' })]);
		const b = member('m2', 'Slight worry about rollout.', [
			claim({ stance: 'concern' }),
		]);
		expect(detectDisagreements([a, b])).toEqual([]);
	});

	test('different subjects do not conflict', () => {
		const a = member('m1', 'About pricing.', [
			claim({ subject: 'pricing', stance: 'support' }),
		]);
		const b = member('m2', 'About packaging.', [
			claim({ subject: 'packaging', stance: 'oppose' }),
		]);
		expect(detectDisagreements([a, b])).toEqual([]);
	});

	test('subject overlap above the similarity threshold groups near-duplicates', () => {
		const a = member('m1', 'x', [
			claim({ subject: 'database migration strategy', stance: 'support' }),
		]);
		const b = member('m2', 'y', [
			claim({
				subject: 'migration strategy for the database',
				statement: 'Opposed to this migration plan.',
				stance: 'oppose',
			}),
		]);
		expect(detectDisagreements([a, b]).length).toBe(1);
	});

	test('claims from the same member never conflict with each other', () => {
		// m1 holds contrary stances on two DIFFERENT subjects — the intra-member
		// pairs must be skipped entirely; m2 shares only the first subject.
		const a = member('m1', 'x', [
			claim({ subject: 'release strategy', stance: 'support' }),
			claim({
				subject: 'rollout plan',
				statement: 'Opposed.',
				stance: 'oppose',
			}),
		]);
		const b = member('m2', 'y', [
			claim({ subject: 'release strategy', stance: 'support' }),
		]);
		expect(detectDisagreements([a, b])).toEqual([]);
	});
});

describe('fallback preservation', () => {
	test('members that omit claims keep the marker-phrase behavior', () => {
		const a = member(
			'm1',
			'I recommend Redis as the cache layer because of latency requirements.',
		);
		const b = member(
			'm2',
			'The best approach is Memcached for simplicity and operational maturity.',
		);
		const result = detectDisagreements([a, b]);
		expect(result.length).toBe(1);
	});

	test('marker-based disagreement is retained when structured claims exist', () => {
		const a = member('m1', 'I disagree with the chosen library.', [
			claim({ stance: 'support' }),
		]);
		const b = member('m2', 'The library is fine.', [
			claim({ stance: 'support' }),
		]);
		const result = detectDisagreements([a, b]);
		// The marker detection must survive — union, not replacement.
		expect(
			result.some((d) => d.positions.some((p) => p.memberId === 'm1')),
		).toBe(true);
	});

	test('malformed claims are skipped and cannot suppress fallback disagreement', () => {
		const a = member(
			'm1',
			'I recommend Redis as the cache layer because of latency requirements.',
			[
				// Malformed: empty subject, invalid stance, bad confidence.
				{
					subject: '',
					statement: 'x',
					stance: 'sideways' as never,
					confidence: 9,
				},
				{
					subject: 's',
					statement: 'y'.repeat(601),
					stance: 'support',
					confidence: 0.5,
				},
			],
		);
		const b = member(
			'm2',
			'The best approach is Memcached for simplicity and operational maturity.',
		);
		const result = detectDisagreements([a, b]);
		expect(result.length).toBe(1);
	});

	test('structured flood cannot push marker disagreements out of the cap', () => {
		const a = member('m1', 'I disagree with the primary approach.');
		const b = member('m2', 'I support the primary approach.');
		// Six structured claim-pair disagreements flood the output.
		const extras = Array.from({ length: 6 }, (_, i) => [
			member(`x${i}`, 'one', [
				claim({ subject: `topic ${i}`, stance: 'support' }),
			]),
			member(`y${i}`, 'two', [
				claim({ subject: `topic ${i}`, stance: 'oppose' }),
			]),
		]).flat();
		const result = detectDisagreements([a, b, ...extras]);
		expect(result.length).toBeLessThanOrEqual(10);
		// Marker-based disagreement (the pair m1/m2 wording divergence) is kept.
		expect(
			result.some((d) => d.positions.some((p) => p.memberId === 'm1')),
		).toBe(true);
	});

	test('oversized evidence arrays make an otherwise-contrary claim malformed (F-BOT-1)', () => {
		// Discriminating: m1's claim would conflict with m2's (support vs
		// oppose on the same subject) were it well-formed, but its evidence
		// array violates the bound (5 refs / 241-char ref). With the bound
		// enforced the structured pass contributes nothing, and the free-text
		// responses carry no marker or recommendation phrases, so nothing fires.
		const a = member('m1', 'Position one on the matter.', [
			claim({ stance: 'support', evidence: ['a', 'b', 'c', 'd', 'e'] }),
		]);
		const b = member('m2', 'Position two on the matter.', [
			claim({ statement: 'Opposed.', stance: 'oppose' }),
		]);
		expect(detectDisagreements([a, b])).toEqual([]);
	});

	test('an over-long evidence reference makes the claim malformed (F-BOT-1)', () => {
		const a = member('m1', 'Position one on the matter.', [
			claim({ stance: 'support', evidence: ['x'.repeat(241)] }),
		]);
		const b = member('m2', 'Position two on the matter.', [
			claim({ statement: 'Opposed.', stance: 'oppose' }),
		]);
		expect(detectDisagreements([a, b])).toEqual([]);
	});

	test('bounded evidence arrays keep the claim well-formed (empty refs allowed)', () => {
		const a = member('m1', 'Position one.', [
			claim({ stance: 'support', evidence: ['', 'ok', 'a', 'b'] }),
		]);
		const b = member('m2', 'Position two.', [
			claim({ statement: 'Opposed.', stance: 'oppose' }),
		]);
		expect(detectDisagreements([a, b]).length).toBe(1);
	});

	test('deterministic for identical input', () => {
		const a = member('m1', 'I disagree with the plan.', [
			claim({ stance: 'support' }),
		]);
		const b = member('m2', 'The plan works.', [
			claim({ statement: 'Plan is wrong.', stance: 'oppose' }),
		]);
		expect(detectDisagreements([a, b])).toEqual(detectDisagreements([a, b]));
	});
});

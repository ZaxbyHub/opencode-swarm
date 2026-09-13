import { describe, expect, test } from 'bun:test';
import { synthesizeGeneralCouncil } from '../../../src/council/general-council-service';
import type {
	GeneralCouncilClaim,
	GeneralCouncilDeliberationResponse,
	GeneralCouncilMemberResponse,
	GeneralCouncilMemberRole,
} from '../../../src/council/general-council-types';

/**
 * FAILING-FIRST acceptance tests for issue #2578 — general-council stance parser.
 *
 * Pins the documented contract in src/agents/council-prompts.ts (ROUND PROTOCOL,
 * "Declare your stance explicitly using one of these keywords as the FIRST word
 * of a paragraph: MAINTAIN / CONCEDE / NUANCE") against the synthesis service:
 *
 *   AC1 — a member holding a contrary TYPED claim stance (oppose) on the same
 *         claim subject must never see their position emitted as a consensus
 *         point, while the disagreement on that subject is still detected.
 *   AC2 — identical positive positions must still reach consensus (the fix may
 *         not over-suppress), and the majority positive consensus must survive
 *         alongside a contrary dissenter.
 *   AC3 — a Round 2 response whose paragraphs lead with MAINTAIN and whose prose
 *         contains "I do not concede" must NOT resolve the disagreement.
 *   AC4 — a paragraph-leading CONCEDE on the matched topic resolves the
 *         disagreement; a mid-prose "concede" does NOT.
 *   AC5 — lexically unrelated statements produce no consensus points.
 *
 * These tests are RED at the tree where the fix has not landed:
 *   - buildConsensusClusters clusters on lexical Jaccard only, so the opposing
 *     member's sentence is emitted AS the consensus point (AC1/AC2/AC5).
 *   - computePersistingDisagreements tests /\bconcede\b/i anywhere in the
 *     Round 2 response, so "I do not concede" and mid-prose "concede" wrongly
 *     resolve maintained disagreements (AC3/AC4).
 *
 * Zero mocks (Tier 0): pure-function assertions on the real synthesis service.
 * Deterministic: no timers, no network, no filesystem.
 */

const QUESTION = 'Which deployment strategy should the migration use?';

/** Shared claim subject for the contrary-stance fixtures. */
const SUBJECT = 'deployment strategy for the migration';

/** Supporter free-text sentence (typed claim stance: support). */
const SUPPORTER_SENTENCE =
	'The zero-downtime migration strategy should use blue-green deployment because it eliminates downtime windows during rollout.';

/**
 * Opposing free-text sentence (typed claim stance: oppose). Deliberately
 * lexically near-identical to SUPPORTER_SENTENCE (Jaccard >= 0.5 on the
 * service's token set) so the current lexical-only clustering merges it into
 * the same consensus cluster — that is the defect under test — and slightly
 * longer so the cluster's "longest representative" rule emits the OPPOSING
 * sentence as the consensus point at the unfixed tree.
 */
const OPPOSING_SENTENCE =
	'The zero-downtime migration strategy should use rolling deployment because blue-green doubles the required infrastructure cost.';

/** Distinctive fragment unique to the supporter sentence. */
const POSITIVE_FRAGMENT = 'eliminates downtime windows';

/** Distinctive fragment unique to the opposing sentence. */
const CONTRARY_FRAGMENT = 'doubles the required infrastructure cost';

/** Lexically unrelated statement (no meaningful token overlap with either sentence above). */
const UNRELATED_SENTENCE =
	'Licensing obligations for embedded firmware redistribution hinge on attribution clauses and toolchain provenance.';

function claim(
	subject: string,
	statement: string,
	stance: GeneralCouncilClaim['stance'],
	confidence: number,
): GeneralCouncilClaim {
	return { subject, statement, stance, confidence };
}

function memberResponse(
	memberId: string,
	role: GeneralCouncilMemberRole,
	response: string,
	confidence: number,
	claims?: GeneralCouncilClaim[],
): GeneralCouncilMemberResponse {
	return {
		memberId,
		model: 'test-model',
		role,
		response,
		sources: [],
		searchQueries: [],
		confidence,
		areasOfUncertainty: [],
		durationMs: 10,
		claims,
	};
}

function round2Response(
	memberId: string,
	role: GeneralCouncilMemberRole,
	response: string,
	disagreementTopics: string[],
): GeneralCouncilDeliberationResponse {
	return {
		...memberResponse(memberId, role, response, 0.85),
		disagreementTopics,
	};
}

/** AC1 fixture: two members with contrary typed stances on the same subject. */
function opposingRound1(): GeneralCouncilMemberResponse[] {
	return [
		memberResponse('m1', 'generalist', SUPPORTER_SENTENCE, 0.9, [
			claim(
				SUBJECT,
				'Blue-green deployment is the right approach because it removes downtime windows.',
				'support',
				0.9,
			),
		]),
		memberResponse('m2', 'skeptic', OPPOSING_SENTENCE, 0.85, [
			claim(
				SUBJECT,
				'Blue-green deployment is the wrong approach because it doubles infrastructure cost.',
				'oppose',
				0.85,
			),
		]),
	];
}

/**
 * Derive the detected disagreement topics the way the runtime does: a first
 * synthesis pass with Round 2 omitted, reading result.disagreements[*].topic.
 * Round 2 fixtures echo these topics so the topic-match gate applies.
 */
function detectDisagreementTopics(
	round1: GeneralCouncilMemberResponse[],
): string[] {
	return synthesizeGeneralCouncil(
		QUESTION,
		'general',
		round1,
		[],
	).disagreements.map((d) => d.topic);
}

describe('general council stance persistence — issue #2578 acceptance', () => {
	test('AC1- contrary typed claim stance must not be emitted as consensus while the disagreement is detected', () => {
		const result = synthesizeGeneralCouncil(
			QUESTION,
			'general',
			opposingRound1(),
			[],
		);

		// The structured-claim disagreement on the shared subject is detected
		// (typed support-vs-oppose on the same claim subject).
		expect(
			result.disagreements.length,
			'contrary typed stances on the same claim subject must be detected as a disagreement',
		).toBeGreaterThanOrEqual(1);
		expect(
			result.disagreements.some((d) => d.topic.includes('deployment strategy')),
			'the disagreement topic must reference the disputed subject',
		).toBe(true);

		// RED at the unfixed tree: the opposing member's free-text sentence is
		// currently emitted AS the consensus point (lexical-only clustering).
		expect(
			result.consensusPoints.some((p) => p.includes(CONTRARY_FRAGMENT)),
			`the opposing member's sentence must not appear as or in a consensus point, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(false);
		expect(
			result.consensusPoints.some((p) => p === OPPOSING_SENTENCE),
			"the opposing member's full sentence must not be a consensus point",
		).toBe(false);
	});

	test('AC2- identical positive positions still reach consensus (no over-suppression) while the dissenter is suppressed', () => {
		// Two members with identical positive positions (typed support claims on
		// the subject) plus one contrary dissenter (typed oppose claim) whose
		// free-text sentence is lexically near-identical to the positive one.
		const round1: GeneralCouncilMemberResponse[] = [
			memberResponse('m1', 'generalist', SUPPORTER_SENTENCE, 0.95, [
				claim(SUBJECT, 'Blue-green deployment is right.', 'support', 0.95),
			]),
			memberResponse('m2', 'domain_expert', SUPPORTER_SENTENCE, 0.95, [
				claim(SUBJECT, 'Blue-green deployment is right.', 'support', 0.95),
			]),
			memberResponse('m3', 'skeptic', OPPOSING_SENTENCE, 0.9, [
				claim(SUBJECT, 'Blue-green deployment is wrong.', 'oppose', 0.9),
			]),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);

		// Preserved behavior: the agreeing majority still produces a consensus point.
		expect(
			result.consensusPoints.length,
			'identical positive positions must still produce at least one consensus point',
		).toBeGreaterThanOrEqual(1);
		expect(
			result.consensusPoints.some((p) => p.includes(POSITIVE_FRAGMENT)),
			`the positive consensus must survive, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(true);

		// RED at the unfixed tree: the dissenter's contrary sentence currently
		// wins the cluster representative slot (longest variant).
		expect(
			result.consensusPoints.some((p) => p.includes(CONTRARY_FRAGMENT)),
			`the dissenter's contrary sentence must not appear in consensus points, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(false);
		// The disagreement between the majority and the dissenter is detected.
		expect(result.disagreements.length).toBeGreaterThanOrEqual(1);
	});

	test('AC3- Round 2 MAINTAIN with "I do not concede" prose must NOT resolve the disagreement', () => {
		const round1 = opposingRound1();
		const topics = detectDisagreementTopics(round1);
		expect(topics.length).toBeGreaterThanOrEqual(1);

		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2Response(
				'm2',
				'skeptic',
				'MAINTAIN\n\nI do not concede the point. The infrastructure doubling argument stands.',
				topics,
			),
		]);

		// RED at the unfixed tree: computePersistingDisagreements matches
		// /\bconcede\b/i anywhere in the response, so the negated concession
		// wrongly resolves (drops) the maintained disagreement.
		expect(
			result.persistingDisagreements,
			`a MAINTAIN-leading response whose prose says "I do not concede" must leave the disagreement persisting, got: ${JSON.stringify(result.persistingDisagreements)}`,
		).toContain(topics[0]);
	});

	test('AC4- paragraph-leading CONCEDE on the matched topic resolves; mid-prose concede does not', () => {
		const round1 = opposingRound1();
		const topics = detectDisagreementTopics(round1);
		expect(topics.length).toBeGreaterThanOrEqual(1);

		// Paragraph-leading uppercase CONCEDE on the matched topic resolves the
		// disagreement (documented Round 2 grammar).
		const conceded = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2Response(
				'm2',
				'skeptic',
				'CONCEDE — the opposing position is correct. Blue-green eliminates downtime windows and the extra infrastructure cost is temporary.',
				topics,
			),
		]);
		expect(
			conceded.persistingDisagreements,
			'a paragraph-leading CONCEDE on the matched topic must resolve the disagreement',
		).not.toContain(topics[0]);

		// RED at the unfixed tree: "concede" appearing mid-prose (NOT the first
		// word of any paragraph) currently resolves the disagreement too.
		const midProse = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2Response(
				'm2',
				'skeptic',
				'After re-reading the evidence I concede that my cost estimate was overstated, but the operational risk stands.',
				topics,
			),
		]);
		expect(
			midProse.persistingDisagreements,
			`a mid-prose "concede" that does not lead its paragraph must NOT resolve the disagreement, got: ${JSON.stringify(midProse.persistingDisagreements)}`,
		).toContain(topics[0]);
	});

	test('AC5- lexically unrelated statements produce no consensus points', () => {
		// One supporter, one member making a lexically unrelated statement, and
		// one dissenter whose contrary sentence is lexically near-identical to
		// the supporter's (so the unfixed lexical cluster forms today). After
		// the stance-aware fix no two agreeing members remain in any cluster,
		// so no consensus point may be emitted.
		const round1: GeneralCouncilMemberResponse[] = [
			memberResponse('m1', 'generalist', SUPPORTER_SENTENCE, 0.95, [
				claim(SUBJECT, 'Blue-green deployment is right.', 'support', 0.95),
			]),
			memberResponse('m2', 'domain_expert', UNRELATED_SENTENCE, 0.9, [
				claim(
					'firmware licensing obligations',
					'Attribution clauses dominate redistribution risk.',
					'support',
					0.9,
				),
			]),
			memberResponse('m3', 'skeptic', OPPOSING_SENTENCE, 0.9, [
				claim(SUBJECT, 'Blue-green deployment is wrong.', 'oppose', 0.9),
			]),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);

		// Preserved behavior: the unrelated statement never becomes consensus.
		expect(
			result.consensusPoints.some((p) => p.includes(UNRELATED_SENTENCE)),
			'a lexically unrelated statement must not appear as a consensus point',
		).toBe(false);

		// RED at the unfixed tree: the supporter/dissenter sentences cluster
		// lexically today (weighted agreement (0.95 + 0.9) / 3 >= 0.6), emitting
		// the dissenter's contrary sentence as a consensus point.
		expect(
			result.consensusPoints.some((p) => p.includes(CONTRARY_FRAGMENT)),
			`the dissenter's contrary sentence must not appear in consensus points, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(false);
		expect(
			result.consensusPoints.length,
			`with no two agreeing members on any subject there must be no consensus points, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(0);
	});
});

describe('general council stance persistence — feedback round (review F-3 / F-1)', () => {
	test('F3- a claims-optional dissenter detected by the marker pass is excluded from consensus clustering', () => {
		// The dissenter supplies NO typed claims (the prompt-permitted
		// claims-optional shape) but flags their dissent with a marker phrase
		// the disagreement detector's Pass 1 recognizes, so the detected
		// disagreement must exclude them from clustering — their contrary
		// sentence is lexically near-identical to the supporter's and would
		// otherwise be emitted as the consensus point.
		const round1: GeneralCouncilMemberResponse[] = [
			memberResponse('m1', 'generalist', SUPPORTER_SENTENCE, 0.95, [
				claim(SUBJECT, 'Blue-green deployment is right.', 'support', 0.95),
			]),
			memberResponse('m2', 'domain_expert', SUPPORTER_SENTENCE, 0.95, [
				claim(SUBJECT, 'Blue-green deployment is right.', 'support', 0.95),
			]),
			memberResponse(
				'm3',
				'skeptic',
				`I would push back on the majority view. ${OPPOSING_SENTENCE}`,
				0.9,
			),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);

		// The marker pass detects the dissenter as a disagreement participant.
		expect(
			result.disagreements.length,
			'the marker-phrase dissent must be detected as a disagreement',
		).toBeGreaterThanOrEqual(1);
		// RED at the pre-feedback tree: the claims-optional dissenter stayed in
		// clustering, so their lexically-near-identical contrary sentence won
		// the cluster representative slot.
		expect(
			result.consensusPoints.some((p) => p.includes(CONTRARY_FRAGMENT)),
			`the claims-optional dissenter's contrary sentence must not appear in consensus points, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(false);
		// The agreeing majority's consensus survives (no over-suppression).
		expect(
			result.consensusPoints.some((p) => p.includes(POSITIVE_FRAGMENT)),
			`the positive consensus must survive, but got: ${JSON.stringify(result.consensusPoints)}`,
		).toBe(true);
	});

	test('F1- markdown-decorated and hyphen-joined stance keywords parse (prompt-sanctioned shapes)', () => {
		// council-prompts.ts tells members "Markdown OK inside the string", so
		// every decorator shape here is a sanctioned input that must yield a
		// declaration. Each case resolves the Round 1 disagreement when the
		// disputant uses it on the matched topic.
		const markdownCases: Array<[string, string]> = [
			[
				'bold-wrapped',
				'**CONCEDE** — the opposing position is correct after re-review.',
			],
			['heading', '## CONCEDE\n\nThe cost argument was overstated.'],
			['list', '- CONCEDE: the operational risk is acceptable.'],
			['blockquote', '> CONCEDE — I withdraw my objection.'],
			['ordered list', '1. CONCEDE on the matched topic after re-reading.'],
			[
				'hyphen-joined',
				'CONCEDE-cost was double-counted; the opposing position stands.',
			],
		];
		for (const [shape, response] of markdownCases) {
			const round1 = opposingRound1();
			const topics = detectDisagreementTopics(round1);
			expect(topics.length).toBeGreaterThanOrEqual(1);
			const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
				round2Response('m2', 'skeptic', response, topics),
			]);
			expect(
				result.persistingDisagreements,
				`the ${shape} stance shape must count as a paragraph-leading CONCEDE, got persisting: ${JSON.stringify(result.persistingDisagreements)}`,
			).not.toContain(topics[0]);
		}
	});

	test('PRR-002 - a marker-phrase dissenter with an unrelated-subject support claim is still excluded from consensus', () => {
		// The exclusion escape (typedSupportMembers) must not rescue a
		// member flagged in a detected disagreement whose only support
		// claim is about an unrelated subject: their contrary sentence
		// would otherwise be eligible for consensus clustering (PRR-002).
		const unrelatedSubject = 'firmware licensing obligations';
		const round1: GeneralCouncilMemberResponse[] = [
			memberResponse('m1', 'generalist', SUPPORTER_SENTENCE, 0.9, [
				claim(
					SUBJECT,
					'Blue-green deployment is the right approach because it removes downtime windows.',
					'support',
					0.9,
				),
			]),
			memberResponse('m2', 'releases', SUPPORTER_SENTENCE, 0.85, [
				claim(
					SUBJECT,
					'Blue-green deployment is the right approach because it removes downtime windows.',
					'support',
					0.85,
				),
			]),
			memberResponse('m3', 'skeptic', OPPOSING_SENTENCE, 0.85, [
				claim(
					unrelatedSubject,
					'Firmware redistribution requires attribution clauses per the license text.',
					'support',
					0.9,
				),
			]),
		];
		// m3's marker-phrase contrary sentence must trigger detection; then
		// the unrelated-subject support claim must NOT rescue m3 from the
		// consensus exclusion.
		const m3Response = `${OPPOSING_SENTENCE} I disagree with the majority position here.`;
		round1[2] = memberResponse('m3', 'skeptic', m3Response, 0.85, [
			claim(
				unrelatedSubject,
				'Firmware redistribution requires attribution clauses per the license text.',
				'support',
				0.9,
			),
		]);
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);
		expect(
			result.disagreements.length,
			'the marker phrase must be detected as a disagreement',
		).toBeGreaterThanOrEqual(1);
		for (const point of result.consensusPoints) {
			expect(point).not.toContain(CONTRARY_FRAGMENT);
		}
	});

	test('F2- quotation marks and backticks directly before the keyword do not hide a declaration', () => {
		const round1 = opposingRound1();
		const topics = detectDisagreementTopics(round1);
		expect(topics.length).toBeGreaterThanOrEqual(1);
		const quoted = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2Response(
				'm2',
				'skeptic',
				'"CONCEDE — the opposing position is correct.',
				topics,
			),
		]);
		expect(
			quoted.persistingDisagreements,
			'a quote-prefixed CONCEDE must parse',
		).not.toContain(topics[0]);
		const fenced = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2Response(
				'm2',
				'skeptic',
				'`CONCEDE — the opposing position is correct.',
				topics,
			),
		]);
		expect(
			fenced.persistingDisagreements,
			'a backtick-prefixed CONCEDE must parse',
		).not.toContain(topics[0]);
	});

	test('F1- zero-width characters before the keyword do not hide a declaration', () => {
		const round1 = opposingRound1();
		const topics = detectDisagreementTopics(round1);
		expect(topics.length).toBeGreaterThanOrEqual(1);
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2Response(
				'm2',
				'skeptic',
				'\u200BCONCEDE — the opposing position is correct.',
				topics,
			),
		]);
		expect(
			result.persistingDisagreements,
			`a zero-width-prefixed CONCEDE must parse, got persisting: ${JSON.stringify(result.persistingDisagreements)}`,
		).not.toContain(topics[0]);
	});
});

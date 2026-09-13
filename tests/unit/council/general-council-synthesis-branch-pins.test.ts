import { describe, expect, test } from 'bun:test';
import { synthesizeGeneralCouncil } from '../../../src/council/general-council-service';
import type {
	GeneralCouncilClaim,
	GeneralCouncilDeliberationResponse,
	GeneralCouncilMemberResponse,
} from '../../../src/council/general-council-types';

/**
 * Supplemental coverage pins for the #2578 stance-aware synthesis (review
 * round findings PRR-008/010/011/014/015/016/017): branches the frozen
 * acceptance files do not execute. Zero mocks; pure-function assertions.
 */

const QUESTION = 'Which storage engine should the service use?';
const SUBJECT_A = 'storage engine choice';
const SUBJECT_B = 'backup frequency';

function member(
	memberId: string,
	response: string,
	confidence = 0.9,
	claims?: GeneralCouncilClaim[],
): GeneralCouncilMemberResponse {
	return {
		memberId,
		model: 'test-model',
		role: 'generalist',
		response,
		sources: [],
		searchQueries: [],
		confidence,
		areasOfUncertainty: [],
		durationMs: 1,
		...(claims ? { claims } : {}),
	};
}

function round2(
	memberId: string,
	response: string,
	disagreementTopics: string[],
): GeneralCouncilDeliberationResponse {
	return { ...member(memberId, response), disagreementTopics };
}

const SUPPORT_SENTENCE =
	'The service should adopt a log structured storage engine because it sustains predictable write throughput under compaction.';
const OPPOSE_SENTENCE =
	'The service should adopt a btree storage engine because log structured compaction stalls foreground latency spikes.';

function contraryRound1(): GeneralCouncilMemberResponse[] {
	return [
		member('m1', SUPPORT_SENTENCE, 0.9, [
			{
				subject: SUBJECT_A,
				statement: 'Adopt the log structured engine.',
				stance: 'support',
				confidence: 0.9,
			},
		]),
		member('m2', OPPOSE_SENTENCE, 0.9, [
			{
				subject: SUBJECT_A,
				statement: 'Adopt the btree engine.',
				stance: 'oppose',
				confidence: 0.9,
			},
		]),
	];
}

/** Round-1-only synthesis, whose topics are what Round 2 fixtures echo. */
function detectedTopics(round1: GeneralCouncilMemberResponse[]): string[] {
	return synthesizeGeneralCouncil(
		QUESTION,
		'general',
		round1,
		[],
	).disagreements.map((d) => d.topic);
}

describe('general council synthesis supplemental branch pins (#2578 review)', () => {
	test('fewer than two members yields no consensus points', () => {
		const solo = synthesizeGeneralCouncil(
			QUESTION,
			'general',
			[member('m1', SUPPORT_SENTENCE)],
			[],
		);
		expect(solo.consensusPoints).toEqual([]);
		const empty = synthesizeGeneralCouncil(QUESTION, 'general', [], []);
		expect(empty.consensusPoints).toEqual([]);
	});

	test('malformed claims never exclude a member from consensus clustering', () => {
		// m2's oppose claim is malformed (empty subject), so m2 is NOT added to
		// the contrary set and still contributes to the agreeing cluster.
		const round1: GeneralCouncilMemberResponse[] = [
			member('m1', SUPPORT_SENTENCE, 0.95, [
				{
					subject: SUBJECT_A,
					statement: 'Adopt log structured.',
					stance: 'support',
					confidence: 0.95,
				},
			]),
			member('m2', SUPPORT_SENTENCE, 0.95, [
				{
					subject: '',
					statement: 'Adopt log structured.',
					stance: 'oppose',
					confidence: 0.95,
				},
			]),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);
		expect(result.consensusPoints.length).toBeGreaterThanOrEqual(1);
	});

	test('mixed-stance member is excluded from all clusters (documented conservative behavior)', () => {
		// m2 supports SUBJECT_A but opposes SUBJECT_B; the whole-member
		// exclusion drops m2's agreeing contribution on SUBJECT_A, leaving m1
		// without a second cluster member — no consensus point on A.
		const round1: GeneralCouncilMemberResponse[] = [
			member('m1', SUPPORT_SENTENCE, 0.95, [
				{
					subject: SUBJECT_A,
					statement: 'Adopt log structured.',
					stance: 'support',
					confidence: 0.95,
				},
			]),
			member('m2', SUPPORT_SENTENCE, 0.95, [
				{
					subject: SUBJECT_A,
					statement: 'Log structured is right.',
					stance: 'support',
					confidence: 0.95,
				},
				{
					subject: SUBJECT_B,
					statement: 'Hourly backups are wrong.',
					stance: 'oppose',
					confidence: 0.9,
				},
			]),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);
		expect(result.consensusPoints).toEqual([]);
	});

	test('clamp01 fallback treats missing confidence as 0.5', () => {
		// Two agreeing members with confidence 1.0 and undefined: weighted
		// agreement (1.0 + 0.5) / 2 = 0.75 >= 0.6 -> consensus forms.
		const round1: GeneralCouncilMemberResponse[] = [
			member('m1', SUPPORT_SENTENCE, 1.0),
			member('m2', SUPPORT_SENTENCE, undefined as unknown as number),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);
		expect(result.consensusPoints.length).toBeGreaterThanOrEqual(1);
	});

	test('weighted-agreement threshold is inclusive at exactly 0.6', () => {
		// Deterministic construction: m1 and m2 agree at 0.9 each and form
		// the single cluster; m3 is unrelated and does not join it, so the
		// weighted agreement is (0.9 + 0.9) / 3 members = exactly 0.6.
		const round1: GeneralCouncilMemberResponse[] = [
			member('m1', SUPPORT_SENTENCE, 0.9),
			member('m2', SUPPORT_SENTENCE, 0.9),
			member(
				'm3',
				'Completely unrelated licensing prose about firmware attribution clauses.',
				0.9,
			),
		];
		const result = synthesizeGeneralCouncil(QUESTION, 'general', round1, []);
		expect(result.consensusPoints.length).toBe(1);
	});

	test('parser handles bare keyword, empty string, and non-string responses', () => {
		const round1 = contraryRound1();
		const topics = detectedTopics(round1);
		expect(topics.length).toBeGreaterThanOrEqual(1);

		// Bare CONCEDE as the entire response (boundary == -1 branch).
		const bare = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2('m2', 'CONCEDE', topics),
		]);
		expect(bare.persistingDisagreements).not.toContain(topics[0]);

		// Empty response body: nothing resolves.
		const empty = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2('m2', '', topics),
		]);
		expect(empty.persistingDisagreements).toContain(topics[0]);

		// Paragraph-leading NUANCE persists the disagreement (not a concession).
		const nuance = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2(
				'm2',
				'NUANCE\n\nBoth engines are partially right depending on workload.',
				topics,
			),
		]);
		expect(nuance.persistingDisagreements).toContain(topics[0]);

		// A non-disputant CONCEDE must not resolve the disagreement.
		const outsider = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2('m9', 'CONCEDE\n\nI was wrong about everything.', topics),
		]);
		expect(outsider.persistingDisagreements).toContain(topics[0]);

		// A disputant CONCEDE on an unmatched topic must not resolve either.
		const unmatched = synthesizeGeneralCouncil(QUESTION, 'general', round1, [
			round2(
				'm2',
				'CONCEDE\n\nI withdraw my objection about backup frequency.',
				['backup frequency'],
			),
		]);
		expect(unmatched.persistingDisagreements).toContain(topics[0]);
	});
});

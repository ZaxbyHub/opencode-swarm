/**
 * Custom validation rules on the consensus contracts (issue #1821, Lane C).
 *
 * Scoped deliberately to the `superRefine` logic this repository owns. "Zod
 * parses a valid object" is a test of Zod, not of these schemas, so it is not
 * here; the structural safety nets that stop a miner regression from being
 * persisted are.
 */

import { describe, expect, test } from 'bun:test';
import {
	ConsensusAttributeV1Schema,
	ConsensusMineRequestSchema,
	ConsensusReportV1Schema,
	MAX_CONSENSUS_ATTRIBUTES,
	MAX_CONSENSUS_PROPOSALS,
} from '../../../src/consensus/contracts';
import { FIXTURE_ATTRIBUTE_ID, proposalRecord as proposal } from './fixtures';

function attribute(overrides: Record<string, unknown> = {}) {
	return {
		v: 1,
		id: FIXTURE_ATTRIBUTE_ID,
		statement: 'a finding',
		support: 3,
		successSupport: 2,
		failureSupport: 1,
		taskDiversity: 2,
		modelDiversity: 0,
		evidenceRefs: ['evidence:a'],
		counterexampleRefs: ['evidence:b'],
		confidence: 0.5,
		proposedTarget: 'tooling',
		...overrides,
	};
}

describe('ConsensusAttributeV1 — negative evidence cannot be silently dropped', () => {
	test('rejects failing support with no counterexample references', () => {
		// The exact regression this schema rule exists to make impossible: an
		// attribute that counts failures but ships none of them to the reader.
		const parsed = ConsensusAttributeV1Schema.safeParse(
			attribute({ failureSupport: 1, counterexampleRefs: [] }),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'must retain its counterexample references',
		);
	});

	test('accepts zero failing support with no counterexamples', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(
				attribute({ failureSupport: 0, counterexampleRefs: [] }),
			).success,
		).toBe(true);
	});

	test('rejects successSupport exceeding total support', () => {
		const parsed = ConsensusAttributeV1Schema.safeParse(
			attribute({ support: 2, successSupport: 3 }),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'cannot exceed total run support',
		);
	});

	test('rejects failureSupport exceeding total support', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(
				attribute({ support: 2, failureSupport: 3 }),
			).success,
		).toBe(false);
	});

	test('modelDiversity of 0 is valid — it means "not measurable"', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(attribute({ modelDiversity: 0 }))
				.success,
		).toBe(true);
	});

	test('rejects an unknown key rather than silently dropping it', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(
				attribute({ unexpectedField: 'surprise' }),
			).success,
		).toBe(false);
	});

	test('rejects a version other than 1', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(attribute({ v: 2 })).success,
		).toBe(false);
	});
});

function report(overrides: Record<string, unknown> = {}) {
	return {
		v: 1,
		reportId: 'consensus-0123456789abcdef',
		generatedAt: '2026-07-24T00:00:00.000Z',
		request: { minSupport: 2, minSuccessfulRuns: 1, maxEvidenceItems: 50 },
		inputIds: ['evaluation-run:r1'],
		corpusHashes: [],
		configHash: 'a'.repeat(64),
		integrityHash: 'b'.repeat(64),
		attributes: [attribute()],
		proposals: [proposal()],
		truncation: {
			corpus: false,
			observations: 3,
			inputIds: false,
			totalInputIds: 1,
			attributesDropped: 0,
		},
		redactionPolicyVersion: 1,
		...overrides,
	};
}

describe('ConsensusReportV1 — structural safety nets', () => {
	test('rejects duplicate attribute ids', () => {
		const parsed = ConsensusReportV1Schema.safeParse(
			report({ attributes: [attribute(), attribute()] }),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'duplicate attribute ids',
		);
	});

	test('rejects duplicate proposal fingerprints', () => {
		const parsed = ConsensusReportV1Schema.safeParse(
			report({ proposals: [proposal(), proposal()] }),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'duplicate proposal fingerprints',
		);
	});

	test('rejects a proposal traceable to an investigation-note attribute', () => {
		// A miner regression that promoted an anecdote into a proposal must be
		// rejected at the store boundary, not merely reviewed later.
		//
		// This guard compares ATTRIBUTE ID to ATTRIBUTE ID. It previously compared
		// `provenance.sourceEvidenceRefs` — corpus refs like
		// `evaluation-run:r1:t1:0` — against the set of attribute ids
		// (`cattr_<16hex>`). Those namespaces are disjoint, so the branch could
		// never fire on real miner output; the old test passed only because it
		// hand-planted an attribute id into a field the miner never puts one in.
		const note = attribute({ proposedTarget: 'none' });
		const parsed = ConsensusReportV1Schema.safeParse(
			report({
				attributes: [note],
				proposals: [proposal({ sourceAttributeId: note.id })],
			}),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'investigation-note attribute must not produce a proposal',
		);
	});

	test('the note guard fires on the SHAPE the miner actually emits', () => {
		// Regression lock for the vacuous-guard class: planting corpus evidence
		// refs (what the miner really writes into `sourceEvidenceRefs`) must NOT be
		// what trips the guard, and must not be able to substitute for the
		// back-reference either.
		const note = attribute({ proposedTarget: 'none' });
		const minerShaped = proposal({
			sourceAttributeId: note.id,
			provenance: {
				...proposal().provenance,
				sourceEvidenceRefs: [
					'evaluation-run:r1:t1:0',
					'evaluation-run:r2:t2:0',
				],
			},
		});
		const parsed = ConsensusReportV1Schema.safeParse(
			report({ attributes: [note], proposals: [minerShaped] }),
		);
		expect(parsed.success).toBe(false);
		expect(
			parsed.error?.issues.some((issue) =>
				issue.message.includes(
					'investigation-note attribute must not produce a proposal',
				),
			),
		).toBe(true);
	});

	test('rejects a proposal whose source attribute is not in the report', () => {
		// A recommendation whose derivation cannot be located in the artifact that
		// carries it is unauditable, which is the thing `sourceAttributeId` exists
		// to prevent.
		const parsed = ConsensusReportV1Schema.safeParse(
			report({
				proposals: [proposal({ sourceAttributeId: 'cattr_deadbeefdeadbeef' })],
			}),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'which is not in this report',
		);
	});

	test('requires sourceAttributeId — it is not optional', () => {
		const { sourceAttributeId: _omitted, ...withoutBackReference } = proposal();
		expect(
			ConsensusReportV1Schema.safeParse(
				report({ proposals: [withoutBackReference] }),
			).success,
		).toBe(false);
	});

	test('accepts an investigation note with no proposals at all', () => {
		expect(
			ConsensusReportV1Schema.safeParse(
				report({
					attributes: [attribute({ proposedTarget: 'none' })],
					proposals: [],
				}),
			).success,
		).toBe(true);
	});

	test('rejects an unknown top-level key', () => {
		expect(
			ConsensusReportV1Schema.safeParse(report({ extra: true })).success,
		).toBe(false);
	});

	test('rejects a non-sha256 integrity hash', () => {
		expect(
			ConsensusReportV1Schema.safeParse(report({ integrityHash: 'short' }))
				.success,
		).toBe(false);
	});

	test('requires the truncation record — silence about a cut is not allowed', () => {
		// A report that dropped evidence without saying so is not incomplete, it is
		// misleading: `failureSupport: 0` reads as "nothing failed".
		const { truncation: _omitted, ...withoutTruncation } = report();
		expect(ConsensusReportV1Schema.safeParse(withoutTruncation).success).toBe(
			false,
		);
	});

	test('rejects a truncation record carrying an unknown key', () => {
		expect(
			ConsensusReportV1Schema.safeParse(
				report({
					truncation: { ...report().truncation, proposalsDropped: 0 },
				}),
			).success,
		).toBe(false);
	});
});

describe('ConsensusReportV1 — the array bounds the producer mirrors', () => {
	// `src/consensus/miner.ts` enforces MAX_CONSENSUS_ATTRIBUTES itself so an
	// over-large corpus degrades instead of throwing here. These assert the
	// schema half of that contract, and that the two constants really are the
	// pair the miner's "proposals <= attributes" argument depends on.
	function attributes(count: number) {
		return Array.from({ length: count }, (_, index) =>
			attribute({ id: `cattr_${String(index).padStart(16, '0')}` }),
		);
	}

	test('accepts exactly MAX_CONSENSUS_ATTRIBUTES attributes', () => {
		const parsed = ConsensusReportV1Schema.safeParse(
			report({
				attributes: attributes(MAX_CONSENSUS_ATTRIBUTES),
				proposals: [proposal({ sourceAttributeId: 'cattr_0000000000000000' })],
			}),
		);
		expect(parsed.success).toBe(true);
	});

	test('rejects one attribute over the cap', () => {
		const parsed = ConsensusReportV1Schema.safeParse(
			report({
				attributes: attributes(MAX_CONSENSUS_ATTRIBUTES + 1),
				proposals: [proposal({ sourceAttributeId: 'cattr_0000000000000000' })],
			}),
		);
		expect(parsed.success).toBe(false);
		expect(JSON.stringify(parsed.error?.issues)).toContain('Too big');
	});

	test('the proposal cap equals the attribute cap', () => {
		// The miner emits at most one proposal per attribute, so this equality is
		// what makes a separate producer-side proposal cap unnecessary.
		expect(MAX_CONSENSUS_PROPOSALS).toBe(MAX_CONSENSUS_ATTRIBUTES);
	});
});

describe('ConsensusMineRequestSchema — the request boundary', () => {
	const valid = { minSupport: 2, minSuccessfulRuns: 1, maxEvidenceItems: 50 };

	test('accepts a minimal request with every filter omitted', () => {
		expect(ConsensusMineRequestSchema.safeParse(valid).success).toBe(true);
	});

	test('rejects minSupport below 1 — zero runs is not consensus', () => {
		expect(
			ConsensusMineRequestSchema.safeParse({ ...valid, minSupport: 0 }).success,
		).toBe(false);
	});

	test('allows minSuccessfulRuns of 0, which turns that gate off', () => {
		expect(
			ConsensusMineRequestSchema.safeParse({ ...valid, minSuccessfulRuns: 0 })
				.success,
		).toBe(true);
	});

	test('rejects a non-integer or non-positive maxEvidenceItems', () => {
		expect(
			ConsensusMineRequestSchema.safeParse({ ...valid, maxEvidenceItems: 0 })
				.success,
		).toBe(false);
		expect(
			ConsensusMineRequestSchema.safeParse({ ...valid, maxEvidenceItems: 1.5 })
				.success,
		).toBe(false);
	});

	test('rejects an unknown filter key rather than ignoring it', () => {
		// A typo'd filter that silently widened the corpus would be invisible.
		expect(
			ConsensusMineRequestSchema.safeParse({ ...valid, taskCategory: ['x'] })
				.success,
		).toBe(false);
	});

	test('bounds every filter list at MAX_CONSENSUS_REFS', () => {
		expect(
			ConsensusMineRequestSchema.safeParse({
				...valid,
				runIds: Array.from({ length: 201 }, (_, index) => `r${index}`),
			}).success,
		).toBe(false);
	});
});

describe('ConsensusAttributeV1 — llmSummary is optional and bounded', () => {
	test('accepts an attribute with no llmSummary at all', () => {
		expect(ConsensusAttributeV1Schema.safeParse(attribute()).success).toBe(
			true,
		);
	});

	test('accepts a bounded llmSummary alongside the deterministic statement', () => {
		const parsed = ConsensusAttributeV1Schema.safeParse(
			attribute({ llmSummary: 'Scoring succeeds across both refactor tasks.' }),
		);
		expect(parsed.success).toBe(true);
		// The deterministic statement is never displaced by the restatement.
		expect(parsed.data?.statement).toBe('a finding');
	});

	test('rejects an over-long llmSummary', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(
				attribute({ llmSummary: 'x'.repeat(601) }),
			).success,
		).toBe(false);
	});

	test('rejects an empty llmSummary rather than storing a blank field', () => {
		expect(
			ConsensusAttributeV1Schema.safeParse(attribute({ llmSummary: '' }))
				.success,
		).toBe(false);
	});
});

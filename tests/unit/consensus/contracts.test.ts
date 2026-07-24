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
	ConsensusReportV1Schema,
} from '../../../src/consensus/contracts';

function attribute(overrides: Record<string, unknown> = {}) {
	return {
		v: 1,
		id: 'cattr_0123456789abcdef',
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

function proposal(overrides: Record<string, unknown> = {}) {
	return {
		target: 'tooling',
		intent: 'try the smallest change',
		evidenceRefs: ['evidence:a'],
		counterexampleRefs: [],
		confidence: 0.5,
		expectedMetric: 'evaluation.scored_outcome_rate',
		validationSelector: 'scope=full-corpus',
		fingerprint: 'lrec_0123456789abcdef',
		provenance: {
			v: 1,
			mechanism: 'consensus_mine',
			sourceKnowledgeIds: [],
			sourceTaskIds: [],
			sourceEvidenceRefs: [],
			sourceRunIds: [],
			sourceModelIds: [],
			writeOrigin: { producedAt: '2026-07-24T00:00:00.000Z' },
		},
		...overrides,
	};
}

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
		const note = attribute({ proposedTarget: 'none' });
		const parsed = ConsensusReportV1Schema.safeParse(
			report({
				attributes: [note],
				proposals: [
					proposal({
						provenance: {
							...proposal().provenance,
							sourceEvidenceRefs: [note.id],
						},
					}),
				],
			}),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain(
			'investigation-note attribute must not produce a proposal',
		);
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
});

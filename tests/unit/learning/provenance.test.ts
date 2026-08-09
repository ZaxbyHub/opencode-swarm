/**
 * Unit tests for LearningProvenanceV1 (issue #1821, Lane 0a).
 *
 * The properties under test are: the stamped record is always schema-valid,
 * every reference class is deduplicated + sorted + capped so a long session
 * cannot grow provenance without bound, and the strict schema rejects
 * unknown keys so a typo'd field never lands silently on disk.
 */
import { describe, expect, it } from 'bun:test';
import {
	type LearningProvenanceV1,
	LearningProvenanceV1Schema,
	MAX_REFS_PER_CLASS,
	stampLearningProvenance,
} from '../../../src/learning/provenance.js';
import { withFrozenClock } from '../../helpers/test-clock.js';

const PRODUCED_AT = '2026-07-24T12:00:00.000Z';

const REF_CLASSES = [
	'sourceKnowledgeIds',
	'sourceTaskIds',
	'sourceEvidenceRefs',
	'sourceRunIds',
	'sourceModelIds',
] as const;

describe('stampLearningProvenance — defaults', () => {
	it('fills v, every reference class, and producedAt from minimal input', () => {
		const stamped = stampLearningProvenance(
			{ mechanism: 'curator_sweep' },
			{ producedAt: PRODUCED_AT },
		);

		expect(stamped).toEqual({
			v: 1,
			mechanism: 'curator_sweep',
			sourceKnowledgeIds: [],
			sourceTaskIds: [],
			sourceEvidenceRefs: [],
			sourceRunIds: [],
			sourceModelIds: [],
			writeOrigin: { producedAt: PRODUCED_AT },
		});
	});

	it('defaults producedAt to the current instant when omitted', () => {
		// `stampLearningProvenance` fills the default from `new Date().toISOString()`,
		// so the deterministic seam is `freezeClock`'s `isoNow` (the `toISOString`
		// spy) — `fixedNow` alone does not reach a no-arg `new Date()`.
		// Two SEQUENTIAL freezes (never nested — `freezeClock` throws on nesting)
		// keep the "tracks the clock, is not a hardcoded constant" property that
		// the previous ±1s real-clock window checked, without the live clock.
		const first = '2026-06-01T00:00:00.000Z';
		const second = '2026-06-02T03:04:05.000Z';
		const stampAt = (isoNow: string) =>
			withFrozenClock(
				() => stampLearningProvenance({ mechanism: 'prm_pattern' }),
				{ fixedNow: Date.parse(isoNow), isoNow },
			);

		const a = stampAt(first);
		const b = stampAt(second);

		expect(a.writeOrigin.producedAt).toBe(first);
		expect(b.writeOrigin.producedAt).toBe(second);
		expect(Number.isNaN(Date.parse(a.writeOrigin.producedAt))).toBe(false);
		expect(Number.isNaN(Date.parse(b.writeOrigin.producedAt))).toBe(false);
		expect(a.writeOrigin.producedAt).not.toBe(b.writeOrigin.producedAt);
	});

	it('omits blank write-origin fields rather than storing empty strings', () => {
		const stamped = stampLearningProvenance(
			{ mechanism: 'micro_reflection' },
			{
				sessionId: '  ',
				agentRole: '  architect ',
				producedAt: PRODUCED_AT,
			},
		);

		expect(stamped.writeOrigin).toEqual({
			agentRole: 'architect',
			producedAt: PRODUCED_AT,
		});
		expect('sessionId' in stamped.writeOrigin).toBe(false);
	});

	it('retains supplied write-origin identity fields', () => {
		const stamped = stampLearningProvenance(
			{ mechanism: 'skill_improver' },
			{
				sessionId: 'ses_abc',
				agentRole: 'architect',
				producedAt: PRODUCED_AT,
			},
		);

		expect(stamped.writeOrigin).toEqual({
			sessionId: 'ses_abc',
			agentRole: 'architect',
			producedAt: PRODUCED_AT,
		});
	});
});

/**
 * `writeOrigin.agentId` was declared but unreachable (issue #1821 F-E): no
 * production caller of `stampLearningProvenance` can supply one —
 * `src/consensus/miner.ts`, `src/services/recommendation-ledger.ts`, and
 * `src/learning/admission.ts` all pass exactly `producedAt` / `sessionId` /
 * `agentRole`. It has been removed, matching what `src/consensus/contracts.ts`
 * did to its structural mirror of the same shape. These tests pin the decision
 * so a future edit has to delete an explicit assertion to bring it back.
 */
describe('writeOrigin has no agentId', () => {
	it('the strict schema REJECTS an agentId rather than reserving room for it', () => {
		const result = LearningProvenanceV1Schema.safeParse({
			v: 1,
			mechanism: 'consensus_mine',
			sourceKnowledgeIds: [],
			sourceTaskIds: [],
			sourceEvidenceRefs: [],
			sourceRunIds: [],
			sourceModelIds: [],
			writeOrigin: { producedAt: PRODUCED_AT, agentId: 'agent-1' },
		});
		expect(result.success).toBe(false);
	});

	it('stampLearningProvenance drops an agentId smuggled past the type', () => {
		// The compiler already rejects this; the cast proves the RUNTIME does too,
		// so a JS consumer cannot persist a field nothing produces.
		const stamped = stampLearningProvenance({ mechanism: 'curator_sweep' }, {
			agentRole: 'architect',
			agentId: 'agent-1',
			producedAt: PRODUCED_AT,
		} as unknown as Parameters<typeof stampLearningProvenance>[1]);

		expect(stamped.writeOrigin).toEqual({
			agentRole: 'architect',
			producedAt: PRODUCED_AT,
		});
		expect('agentId' in stamped.writeOrigin).toBe(false);
	});

	it('every production caller passes only producedAt / sessionId / agentRole', () => {
		// The property that makes removal safe, asserted as a shape rather than
		// left to a grep in a review comment.
		const stamped = stampLearningProvenance(
			{ mechanism: 'consensus_mine' },
			{ sessionId: 'ses_1', agentRole: 'critic', producedAt: PRODUCED_AT },
		);
		expect(Object.keys(stamped.writeOrigin).sort()).toEqual([
			'agentRole',
			'producedAt',
			'sessionId',
		]);
	});
});

describe('stampLearningProvenance — reference normalization', () => {
	it('dedups and sorts every reference class independently', () => {
		const stamped = stampLearningProvenance(
			{
				mechanism: 'consensus_mine',
				sourceKnowledgeIds: ['k-2', 'k-1', 'k-2'],
				sourceTaskIds: ['t-b', 't-a', 't-b', 't-a'],
				sourceEvidenceRefs: ['.swarm/e/2.json', '.swarm/e/1.json'],
				sourceRunIds: ['run-9', 'run-1', 'run-9'],
				sourceModelIds: ['z/model-b', 'a/model-a', 'z/model-b'],
			},
			{ producedAt: PRODUCED_AT },
		);

		expect(stamped.sourceKnowledgeIds).toEqual(['k-1', 'k-2']);
		expect(stamped.sourceTaskIds).toEqual(['t-a', 't-b']);
		expect(stamped.sourceEvidenceRefs).toEqual([
			'.swarm/e/1.json',
			'.swarm/e/2.json',
		]);
		expect(stamped.sourceRunIds).toEqual(['run-1', 'run-9']);
		expect(stamped.sourceModelIds).toEqual(['a/model-a', 'z/model-b']);
	});

	it('produces the same record regardless of caller-side ordering', () => {
		const forward = stampLearningProvenance(
			{ mechanism: 'curator_sweep', sourceRunIds: ['a', 'b', 'c'] },
			{ producedAt: PRODUCED_AT },
		);
		const reversed = stampLearningProvenance(
			{ mechanism: 'curator_sweep', sourceRunIds: ['c', 'b', 'a'] },
			{ producedAt: PRODUCED_AT },
		);
		expect(forward).toEqual(reversed);
	});

	it('trims references and drops blank entries', () => {
		const stamped = stampLearningProvenance(
			{
				mechanism: 'curator_sweep',
				sourceKnowledgeIds: [' k-1 ', '', '   ', 'k-1'],
			},
			{ producedAt: PRODUCED_AT },
		);
		expect(stamped.sourceKnowledgeIds).toEqual(['k-1']);
	});
});

describe('stampLearningProvenance — MAX_REFS_PER_CLASS cap', () => {
	it('exposes a cap of 50', () => {
		expect(MAX_REFS_PER_CLASS).toBe(50);
	});

	it('caps every reference class independently at MAX_REFS_PER_CLASS', () => {
		// 120 unique zero-padded ids per class so sort order is lexicographic and
		// the retained window is predictable.
		const many = Array.from(
			{ length: 120 },
			(_unused, index) => `ref-${String(index).padStart(3, '0')}`,
		);
		const stamped = stampLearningProvenance(
			{
				mechanism: 'consensus_mine',
				sourceKnowledgeIds: many,
				sourceTaskIds: many,
				sourceEvidenceRefs: many,
				sourceRunIds: many,
				sourceModelIds: many,
			},
			{ producedAt: PRODUCED_AT },
		);

		for (const refClass of REF_CLASSES) {
			expect(stamped[refClass]).toHaveLength(MAX_REFS_PER_CLASS);
		}
		expect(stamped.sourceKnowledgeIds[0]).toBe('ref-000');
		expect(stamped.sourceKnowledgeIds[MAX_REFS_PER_CLASS - 1]).toBe('ref-049');
	});

	it('truncates deterministically regardless of insertion order', () => {
		const many = Array.from(
			{ length: 200 },
			(_unused, index) => `ref-${String(index).padStart(3, '0')}`,
		);
		const shuffled = [...many].reverse();

		const inOrder = stampLearningProvenance(
			{ mechanism: 'prm_pattern', sourceTaskIds: many },
			{ producedAt: PRODUCED_AT },
		);
		const outOfOrder = stampLearningProvenance(
			{ mechanism: 'prm_pattern', sourceTaskIds: shuffled },
			{ producedAt: PRODUCED_AT },
		);
		expect(inOrder.sourceTaskIds).toEqual(outOfOrder.sourceTaskIds);
	});

	it('keeps a capped record schema-valid (the cap is also a schema bound)', () => {
		const many = Array.from({ length: 80 }, (_unused, i) => `run-${i}`);
		const stamped = stampLearningProvenance(
			{ mechanism: 'curator_sweep', sourceRunIds: many },
			{ producedAt: PRODUCED_AT },
		);
		expect(LearningProvenanceV1Schema.safeParse(stamped).success).toBe(true);
	});
});

describe('LearningProvenanceV1Schema', () => {
	const valid: LearningProvenanceV1 = {
		v: 1,
		mechanism: 'micro_reflection',
		sourceKnowledgeIds: ['k-1'],
		sourceTaskIds: [],
		sourceEvidenceRefs: ['.swarm/evidence/phase-1.json'],
		sourceRunIds: [],
		sourceModelIds: ['anthropic/claude-opus-4'],
		writeOrigin: { sessionId: 'ses_1', producedAt: PRODUCED_AT },
	};

	it('round-trips a stamped record without changing it', () => {
		const stamped = stampLearningProvenance(
			{
				mechanism: 'skill_improver',
				sourceKnowledgeIds: ['k-2', 'k-1'],
				sourceModelIds: ['anthropic/claude-opus-4'],
			},
			{ sessionId: 'ses_2', agentRole: 'critic', producedAt: PRODUCED_AT },
		);
		expect(LearningProvenanceV1Schema.parse(stamped)).toEqual(stamped);
	});

	it('accepts a hand-built valid record', () => {
		expect(LearningProvenanceV1Schema.parse(valid)).toEqual(valid);
	});

	it('rejects unknown top-level keys (.strict)', () => {
		const result = LearningProvenanceV1Schema.safeParse({
			...valid,
			sourceKnowledgeIDs: ['typo'],
		});
		expect(result.success).toBe(false);
	});

	it('rejects unknown writeOrigin keys (.strict)', () => {
		const result = LearningProvenanceV1Schema.safeParse({
			...valid,
			writeOrigin: { ...valid.writeOrigin, agentid: 'lowercase-typo' },
		});
		expect(result.success).toBe(false);
	});

	it('rejects a version other than 1', () => {
		expect(
			LearningProvenanceV1Schema.safeParse({ ...valid, v: 2 }).success,
		).toBe(false);
	});

	it('rejects an unknown mechanism', () => {
		expect(
			LearningProvenanceV1Schema.safeParse({ ...valid, mechanism: 'vibes' })
				.success,
		).toBe(false);
		expect(() =>
			stampLearningProvenance({
				mechanism: 'vibes' as never,
			}),
		).toThrow();
	});

	it('rejects a non-ISO producedAt', () => {
		expect(
			LearningProvenanceV1Schema.safeParse({
				...valid,
				writeOrigin: { producedAt: 'yesterday' },
			}).success,
		).toBe(false);
		expect(() =>
			stampLearningProvenance(
				{ mechanism: 'curator_sweep' },
				{ producedAt: 'yesterday' },
			),
		).toThrow();
	});

	it('rejects a missing producedAt', () => {
		expect(
			LearningProvenanceV1Schema.safeParse({ ...valid, writeOrigin: {} })
				.success,
		).toBe(false);
	});

	it('rejects an over-cap reference class', () => {
		const overCap = Array.from(
			{ length: MAX_REFS_PER_CLASS + 1 },
			(_unused, i) => `k-${i}`,
		);
		expect(
			LearningProvenanceV1Schema.safeParse({
				...valid,
				sourceKnowledgeIds: overCap,
			}).success,
		).toBe(false);
	});

	it('rejects empty and NUL-bearing references', () => {
		expect(
			LearningProvenanceV1Schema.safeParse({
				...valid,
				sourceRunIds: [''],
			}).success,
		).toBe(false);
		expect(
			LearningProvenanceV1Schema.safeParse({
				...valid,
				sourceRunIds: ['run\u00001'],
			}).success,
		).toBe(false);
	});

	it('rejects an over-long reference', () => {
		expect(
			LearningProvenanceV1Schema.safeParse({
				...valid,
				sourceEvidenceRefs: ['x'.repeat(513)],
			}).success,
		).toBe(false);
	});
});

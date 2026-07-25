/**
 * `ProposedSkillChangeSchema` — the proposal boundary, exercised directly.
 *
 * Split from `contracts.test.ts`, which drives proposals only through
 * `ConsensusReportV1Schema` — the schema that embeds this one. Merged they would
 * be ~468 lines, under the FR-006 500-line cap, so the split buys focus and
 * headroom rather than compliance. The rules below belong to the proposal record
 * itself and are mirrored by module-local constants in `src/consensus/miner.ts`. Drift on
 * either side would surface only as a `parse` throw at the very end of a mining
 * run — after every finding had already been computed and none could be
 * written.
 */

import { describe, expect, test } from 'bun:test';
import { ProposedSkillChangeSchema } from '../../../src/consensus/contracts';
import { proposalRecord as proposal } from './fixtures';

describe('ProposedSkillChangeSchema — the proposal boundary itself', () => {
	// Exercised directly, not only through the report schema that embeds it: the
	// two bounds below are mirrored by module-local constants in
	// `src/consensus/miner.ts` (`MAX_VALIDATION_SELECTOR_CHARS`, and the
	// `lrec_<16hex>` shape `computeRecommendationFingerprint` emits), and a
	// silent drift on either side would only surface as a `parse` throw at the
	// very end of a mining run — after every finding had been computed.

	test('accepts the shape the miner emits', () => {
		expect(ProposedSkillChangeSchema.safeParse(proposal()).success).toBe(true);
	});

	test('rejects a fingerprint that is not lrec_<16 hex>', () => {
		// The fingerprint is the cross-report dedup key. A malformed one would not
		// collide with itself, so the same proposal would be re-emitted forever.
		for (const fingerprint of [
			'lrec_0123456789ABCDEF',
			'lrec_0123456789abcde',
			'0123456789abcdef',
			'miner_0123456789abcdef',
		]) {
			expect(
				ProposedSkillChangeSchema.safeParse(proposal({ fingerprint })).success,
			).toBe(false);
		}
	});

	test('bounds validationSelector at 1024 characters', () => {
		// `MAX_VALIDATION_SELECTOR_CHARS` in the miner claims to match this bound.
		// The renderer drops whole identifiers to stay under it rather than
		// truncating one, so the two numbers must not drift apart.
		expect(
			ProposedSkillChangeSchema.safeParse(
				proposal({ validationSelector: `taskIds=${'x'.repeat(1016)}` }),
			).success,
		).toBe(true);
		expect(
			ProposedSkillChangeSchema.safeParse(
				proposal({ validationSelector: `taskIds=${'x'.repeat(1017)}` }),
			).success,
		).toBe(false);
	});

	test('rejects an empty validationSelector — it must name something', () => {
		expect(
			ProposedSkillChangeSchema.safeParse(proposal({ validationSelector: '' }))
				.success,
		).toBe(false);
	});

	test('rejects an unknown key on the proposal and on its writeOrigin', () => {
		expect(
			ProposedSkillChangeSchema.safeParse(proposal({ rationale: 'because' }))
				.success,
		).toBe(false);
		expect(
			ProposedSkillChangeSchema.safeParse(
				proposal({
					provenance: {
						...proposal().provenance,
						writeOrigin: {
							producedAt: '2026-07-24T00:00:00.000Z',
							reasoning: 'I thought about it',
						},
					},
				}),
			).success,
		).toBe(false);
	});

	test('accepts a writeOrigin carrying only producedAt', () => {
		// `sessionId` and `agentRole` are both optional; `producedAt` is not.
		expect(
			ProposedSkillChangeSchema.safeParse(
				proposal({
					provenance: {
						...proposal().provenance,
						writeOrigin: { producedAt: '2026-07-24T00:00:00.000Z' },
					},
				}),
			).success,
		).toBe(true);
	});

	test('REJECTS an agentId — the consensus path can never produce one', () => {
		// The shared `LearningWriteOriginSchema` admits `agentId`, but nothing on
		// this path can set it: `MineConsensusDeps` has no such field and
		// `buildProposals` passes exactly producedAt/sessionId/agentRole. Reserving
		// room for it documented a value that never exists, so the strict schema
		// now rejects it. If a future change makes the miner able to stamp an
		// agent id, this test is the one that must be updated first.
		expect(
			ProposedSkillChangeSchema.safeParse(
				proposal({
					provenance: {
						...proposal().provenance,
						writeOrigin: {
							producedAt: '2026-07-24T00:00:00.000Z',
							agentId: 'agent-7',
						},
					},
				}),
			).success,
		).toBe(false);
	});
});

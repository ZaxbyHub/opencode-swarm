import { describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	type RecallRequest,
} from '../../../src/memory';
import {
	DEFAULT_QLEARNING_CONFIG,
	type QLearningConfig,
} from '../../../src/memory/config';
import {
	scoreMemoryRecord,
	scoreMemoryRecordsWithDiagnostics,
} from '../../../src/memory/scoring';

/**
 * A.5 — recall q-value ranking boost (SC-006 / FR-005).
 *
 * Mirrors the record/request builders in `tests/unit/memory/scoring.test.ts`.
 * These tests exercise the CENTERED q-value ranking term added on top of the
 * existing 9-signal `baseScore`:
 *
 *   qValueBoost = (getQValue(record, 0.5) - 0.5) * qLearningConfig.qValueBoostWeight
 *   rankingScore = baseScore + qValueBoost
 *
 * and the invariant that `minScore` inclusion is gated on `baseScore`, never
 * on the boosted `rankingScore` — the q-term can only reorder already-included
 * memories, never include or exclude one.
 */

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text: 'This repository uses bun for tests.',
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-24T12:00:00.000Z',
		updatedAt: '2026-05-24T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
		...overrides,
	};
}

function makeRequest(overrides: Partial<RecallRequest> = {}): RecallRequest {
	return {
		query: 'bun tests',
		scopes: [{ type: 'repository', repoId: 'repo-a' }],
		maxItems: 5,
		tokenBudget: 1000,
		minScore: 0,
		...overrides,
	};
}

/**
 * Read the pure baseScore (no q-value boost) for a record via the SAME
 * record but with a neutral qValue (0.5). At the neutral q-value the boost
 * term is exactly `(0.5 - 0.5) * weight === 0`, so `scoreMemoryRecord`'s
 * returned `.score` equals `baseScore` precisely. Deriving this from the
 * real implementation (rather than hand-computing the 9-signal sum) keeps
 * these tests robust to unrelated changes in the base scoring formula while
 * still pinning the NEW q-value behavior added on top of it.
 *
 * `scoreMemoryRecord` never applies the `minScore` gate (only
 * `scoreMemoryRecordsWithDiagnostics` does), so this probe is unaffected by
 * whatever `minScore` the caller later uses to test the gate.
 */
function probeBaseScore(record: MemoryRecord, request: RecallRequest): number {
	const neutral = scoreMemoryRecord(
		{ ...record, metadata: { ...record.metadata, qValue: 0.5 } },
		request,
	);
	if (!neutral) throw new Error('probe record unexpectedly filtered');
	return neutral.score;
}

describe('A.5 — q-value ranking boost: order (SC-006)', () => {
	test('higher q-value outranks an otherwise-identical lower q-value record', () => {
		// IDs are deliberately chosen so the sort's id-ascending tiebreak
		// ('mem_a_low_q' < 'mem_z_high_q') fights the outcome we expect from
		// the boost: under a no-op/broken boost (tied scores), the tiebreak
		// alone would put the LOW-q record first. Only a working, correctly
		// signed boost can flip highQ to the top despite that tiebreak — so
		// the ordering assertion below is load-bearing, not incidentally
		// satisfied by id ordering.
		const lowQ = makeRecord({ id: 'mem_a_low_q', metadata: { qValue: 0.1 } });
		const highQ = makeRecord({ id: 'mem_z_high_q', metadata: { qValue: 0.9 } });
		// A.6 suppresses qValue=0.1 (< suppressionThreshold 0.15) from default
		// recall; opt in via `includeLowQ` so this test still exercises the
		// A.5 boost/ordering it was written for, decoupled from A.6 exclusion.
		const request = makeRequest({ includeLowQ: true });

		const { items } = scoreMemoryRecordsWithDiagnostics([lowQ, highQ], request);

		expect(items).toHaveLength(2);
		expect(items[0].record.id).toBe('mem_z_high_q');
		expect(items[1].record.id).toBe('mem_a_low_q');

		// (0.9 - 0.1) * 0.10 = 0.08
		expect(items[0].score - items[1].score).toBeCloseTo(0.08, 10);
	});

	test('reason string surfaces qvalue=X.XX for non-neutral q-values', () => {
		const highQ = makeRecord({
			id: 'mem_reason_high',
			metadata: { qValue: 0.9 },
		});
		const lowQ = makeRecord({
			id: 'mem_reason_low',
			metadata: { qValue: 0.1 },
		});
		// qValue=0.1 is below the A.6 suppression threshold (0.15); opt in so
		// the record is scored at all and its reason string can be inspected.
		const request = makeRequest({ includeLowQ: true });

		expect(scoreMemoryRecord(highQ, request)?.reason).toContain('qvalue=0.90');
		expect(scoreMemoryRecord(lowQ, request)?.reason).toContain('qvalue=0.10');
	});
});

describe('A.5 — q-value ranking boost: neutral is a no-op', () => {
	test('absent qValue and explicit qValue=0.5 score byte-identically, with no qvalue= in reason', () => {
		const absent = makeRecord({ id: 'mem_neutral_absent' }); // metadata: {}
		const explicitNeutral = makeRecord({
			id: 'mem_neutral_explicit',
			metadata: { qValue: 0.5 },
		});
		const request = makeRequest();

		const absentResult = scoreMemoryRecord(absent, request);
		const neutralResult = scoreMemoryRecord(explicitNeutral, request);

		expect(absentResult).not.toBeNull();
		expect(neutralResult).not.toBeNull();
		// Byte-identical score: the boost term is exactly 0 in both cases
		// because getQValue falls back to (or reads) the neutral 0.5.
		expect(absentResult?.score).toBe(neutralResult?.score);

		expect(absentResult?.reason).not.toMatch(/qvalue=/);
		expect(neutralResult?.reason).not.toMatch(/qvalue=/);

		// Compare against a record with a non-neutral qValue to prove the
		// neutral score really is the unmodified baseScore, not coincidence.
		const nonNeutral = makeRecord({
			id: 'mem_neutral_control',
			metadata: { qValue: 0.9 },
		});
		const nonNeutralResult = scoreMemoryRecord(nonNeutral, request);
		expect(nonNeutralResult?.score).not.toBe(absentResult?.score);
	});
});

describe('A.5 — q-value ranking boost: no-exclusion invariant (SC-006 core)', () => {
	test('a strong lexical match with qValue=0.0 (max penalty) is still returned', () => {
		const record = makeRecord({
			id: 'mem_strong_min_q',
			metadata: { qValue: 0 },
		});
		// qValue=0 is below the A.6 suppression threshold (0.15) and would be
		// excluded entirely before the boost is ever computed; opt in via
		// `includeLowQ` so this test isolates the A.5 no-exclusion-by-minScore
		// invariant from the (separate, intentional) A.6 suppression filter.
		const request = makeRequest({ includeLowQ: true });
		const baseScore = probeBaseScore(record, request);

		// Well above minScore: default request.minScore (0) is far below the
		// base score for this strong text-overlap record.
		const { items: wellAbove } = scoreMemoryRecordsWithDiagnostics(
			[record],
			request,
		);
		expect(wellAbove).toHaveLength(1);
		expect(wellAbove[0].record.id).toBe('mem_strong_min_q');

		// Tight margin: choose minScore strictly between the (penalized)
		// rankingScore and the (unpenalized) baseScore. This is the
		// decisive check — if the inclusion gate were mistakenly applied to
		// the BOOSTED rankingScore instead of baseScore, this record would
		// be wrongly excluded here.
		const tightMinScore = baseScore - 0.02;
		const rankingScore = baseScore - 0.05; // qValue=0 => boost = (0-0.5)*0.10 = -0.05
		expect(rankingScore).toBeLessThan(tightMinScore); // sanity: proves the gap is real

		const { items: tight, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[record],
			{ ...request, minScore: tightMinScore },
		);
		expect(tight).toHaveLength(1);
		expect(tight[0].record.id).toBe('mem_strong_min_q');
		expect(tight[0].score).toBeCloseTo(rankingScore, 10);
		expect(diagnostics.belowThresholdCount).toBe(0);
	});
});

describe('A.5 — q-value ranking boost: no-rescue invariant', () => {
	test('a record whose base score fails minScore is NOT rescued by qValue=1.0 (max boost)', () => {
		const record = makeRecord({ id: 'mem_no_rescue', metadata: { qValue: 1 } });
		const request = makeRequest();
		const baseScore = probeBaseScore(record, request);

		// minScore chosen so baseScore fails the gate, but baseScore + the
		// max possible boost (+0.05) would clear it — proving the gate must
		// be reading baseScore, not the boosted rankingScore.
		const minScore = baseScore + 0.02;
		const rankingScore = baseScore + 0.05; // qValue=1 => boost = (1-0.5)*0.10 = +0.05
		expect(baseScore).toBeLessThan(minScore); // sanity: base fails on its own
		expect(rankingScore).toBeGreaterThanOrEqual(minScore); // sanity: boosted score would pass

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics([record], {
			...request,
			minScore,
		});

		expect(items).toHaveLength(0);
		expect(diagnostics.belowThresholdCount).toBe(1);
		expect(diagnostics.returnedCount).toBe(0);
	});
});

describe('A.5 — q-value ranking boost: config weight is honored', () => {
	test('a larger qValueBoostWeight produces a proportionally larger rank separation', () => {
		const record = makeRecord({
			id: 'mem_weight_test',
			metadata: { qValue: 0.9 },
		});
		const request = makeRequest();
		const baseScore = probeBaseScore(record, request);

		const defaultWeightResult = scoreMemoryRecord(record, request); // DEFAULT_QLEARNING_CONFIG (0.10)
		const customConfig: QLearningConfig = {
			...DEFAULT_QLEARNING_CONFIG,
			qValueBoostWeight: 0.4,
		};
		const customWeightResult = scoreMemoryRecord(record, request, customConfig);

		expect(defaultWeightResult).not.toBeNull();
		expect(customWeightResult).not.toBeNull();

		// (0.9 - 0.5) * 0.10 = 0.04
		expect((defaultWeightResult?.score ?? 0) - baseScore).toBeCloseTo(0.04, 10);
		// (0.9 - 0.5) * 0.40 = 0.16
		expect((customWeightResult?.score ?? 0) - baseScore).toBeCloseTo(0.16, 10);

		expect(customWeightResult?.score).toBeGreaterThan(
			defaultWeightResult?.score ?? Number.POSITIVE_INFINITY,
		);
	});
});

describe('A.5 — q-value ranking boost: bounded contribution', () => {
	test('contribution never exceeds +/-(0.5 * weight) at the qValue extremes (default weight 0.10)', () => {
		// qValue=0 (minQ) is below the A.6 suppression threshold (0.15); opt in
		// so minQ is scored at all and its (negative) boost can be measured,
		// rather than being excluded before the boost is ever computed.
		const request = makeRequest({ includeLowQ: true });
		const minQ = makeRecord({ id: 'mem_bound_min', metadata: { qValue: 0 } });
		const maxQ = makeRecord({ id: 'mem_bound_max', metadata: { qValue: 1 } });
		const baseScore = probeBaseScore(minQ, request); // identical base signals for both records

		const minResult = scoreMemoryRecord(minQ, request);
		const maxResult = scoreMemoryRecord(maxQ, request);

		expect((minResult?.score ?? 0) - baseScore).toBeCloseTo(-0.05, 10);
		expect((maxResult?.score ?? 0) - baseScore).toBeCloseTo(0.05, 10);
	});

	test('contribution is bounded to +/-(0.5 * weight) even with a large custom weight', () => {
		// Same rationale as above: qValue=0 would be suppressed by A.6 before
		// the boost is computed; opt in to isolate this A.5 bound assertion.
		const request = makeRequest({ includeLowQ: true });
		const minQ = makeRecord({
			id: 'mem_bound_min_wide',
			metadata: { qValue: 0 },
		});
		const maxQ = makeRecord({
			id: 'mem_bound_max_wide',
			metadata: { qValue: 1 },
		});
		const baseScore = probeBaseScore(minQ, request);
		const wideConfig: QLearningConfig = {
			...DEFAULT_QLEARNING_CONFIG,
			qValueBoostWeight: 1.0,
		};

		const minResult = scoreMemoryRecord(minQ, request, wideConfig);
		const maxResult = scoreMemoryRecord(maxQ, request, wideConfig);

		// (0 - 0.5) * 1.0 = -0.5 ; (1 - 0.5) * 1.0 = +0.5 — the theoretical
		// bound at weight=1.0. A broken implementation that fails to center
		// (e.g. `qValue * weight` instead of `(qValue - 0.5) * weight`) would
		// produce 0 and +1.0 here instead of -0.5 and +0.5.
		expect((minResult?.score ?? 0) - baseScore).toBeCloseTo(-0.5, 10);
		expect((maxResult?.score ?? 0) - baseScore).toBeCloseTo(0.5, 10);
	});
});

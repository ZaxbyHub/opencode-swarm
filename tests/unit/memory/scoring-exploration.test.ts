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
import { scoreMemoryRecordsWithDiagnostics } from '../../../src/memory/scoring';

/**
 * C.1 — active exploration of suppressed memories (FR-014 / SC-016).
 *
 * A.6 (`scoring-suppression.test.ts`) suppresses `qValue < suppressionThreshold`
 * memories from default recall via a per-record filter in
 * `scoreMemoryRecordDetailed` that is NOT touched here. C.1 layers a bounded,
 * probabilistic resurrection ON TOP of that filter inside
 * `scoreMemoryRecordsWithDiagnostics`: with probability
 * `qLearning.explorationRate` (default 0.05), the single highest-baseScore
 * suppressed candidate is resurfaced and flagged `explored: true` so it can
 * earn reward back via the reward-capture loop.
 *
 * The RNG is threaded via an injectable `options.random` seam (default
 * `Math.random`) so exploration is deterministically testable:
 *   - `random: () => 0` always triggers exploration (0 < any positive rate).
 *   - `random: () => 0.99` never triggers it (0.99 is not < the default 0.05).
 */

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a' },
		kind: 'repo_convention' as const,
		text: 'The database pool timeout configuration is documented here.',
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: [],
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
		query: 'database pool timeout',
		scopes: [{ type: 'repository', repoId: 'repo-a' }],
		maxItems: 10,
		tokenBudget: 1000,
		minScore: 0,
		...overrides,
	};
}

// Two suppressed candidates with a deliberate baseScore gap: HIGH has tags
// matching all 3 query tokens (+0.16 tagOverlap weight), LOW has none. Both
// are suppressed (qValue 0.1 / 0.05, both < the default 0.15 threshold).
// baseScore(HIGH) = 0.738, baseScore(LOW) = 0.578 (see scoring.ts weights).
function makeSuppressedHigh(overrides: Partial<MemoryRecord> = {}) {
	return makeRecord({
		id: 'mem_suppressed_high',
		tags: ['database', 'pool', 'timeout'],
		metadata: { qValue: 0.1 },
		...overrides,
	});
}
function makeSuppressedLow(overrides: Partial<MemoryRecord> = {}) {
	return makeRecord({
		id: 'mem_suppressed_low',
		tags: [],
		metadata: { qValue: 0.05 },
		...overrides,
	});
}
function makeNormal(overrides: Partial<MemoryRecord> = {}) {
	return makeRecord({
		id: 'mem_normal_neutral',
		tags: [],
		metadata: { qValue: 0.5 },
		...overrides,
	});
}

describe('C.1 — active exploration: forced explore surfaces exactly one item (SC-016)', () => {
	test('resurfaces the highest-baseScore suppressed candidate, flagged explored:true', () => {
		const high = makeSuppressedHigh();
		const low = makeSuppressedLow();
		const normal = makeNormal();
		const request = makeRequest();

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[high, low, normal],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 },
		);

		// Normal item is present, unaffected, and never flagged explored.
		const normalItem = items.find((item) => item.record.id === normal.id);
		expect(normalItem).toBeDefined();
		expect(normalItem?.explored).toBeUndefined();

		// Exactly one of the two suppressed candidates was resurrected — the
		// higher-baseScore one — and it is flagged.
		const explored = items.filter((item) => item.explored === true);
		expect(explored).toHaveLength(1);
		expect(explored[0].record.id).toBe(high.id);

		// The lower-baseScore suppressed candidate stays excluded.
		expect(items.some((item) => item.record.id === low.id)).toBe(false);

		expect(diagnostics.exploredCount).toBe(1);
		// A.6's own counter is unaffected by exploration — both candidates were
		// still suppressed by the per-record filter; exploration is a layer on
		// top, not a change to what the filter itself counts.
		expect(diagnostics.suppressedLowQCount).toBe(2);
	});

	test('at-most-one: never resurrects more than one candidate regardless of how many are suppressed', () => {
		const high = makeSuppressedHigh();
		const low = makeSuppressedLow();
		const third = makeRecord({
			id: 'mem_suppressed_third',
			tags: [],
			confidence: 0.1, // lower confidence => lower baseScore than `low`
			metadata: { qValue: 0.02 },
		});
		const request = makeRequest();

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[high, low, third],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 },
		);

		const explored = items.filter((item) => item.explored === true);
		expect(explored).toHaveLength(1);
		expect(explored[0].record.id).toBe(high.id);
		expect(items).toHaveLength(1); // only the resurrected item — nothing else clears suppression
	});

	test('tie-break: equal baseScore suppressed candidates resolve by smallest id', () => {
		const a = makeRecord({
			id: 'mem_tie_aaa',
			tags: [],
			metadata: { qValue: 0.1 },
		});
		const z = makeRecord({
			id: 'mem_tie_zzz',
			tags: [],
			metadata: { qValue: 0.05 },
		});
		const request = makeRequest();

		const { items } = scoreMemoryRecordsWithDiagnostics(
			[z, a],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 },
		);

		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe('mem_tie_aaa');
		expect(items[0].explored).toBe(true);
	});
});

describe('C.1 — active exploration: forced no-explore matches today exactly', () => {
	test('suppressed candidates stay excluded, nothing is flagged, normal items unchanged', () => {
		const high = makeSuppressedHigh();
		const low = makeSuppressedLow();
		const normal = makeNormal();
		const request = makeRequest();

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[high, low, normal],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0.99 },
		);

		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe(normal.id);
		expect(items[0].explored).toBeUndefined();
		expect(diagnostics.exploredCount).toBe(0);
		expect(diagnostics.suppressedLowQCount).toBe(2);
	});
});

describe('C.1 — active exploration: includeLowQ opt-out disables the layer entirely', () => {
	test('includeLowQ:true already returns every low-q record via the normal path — nothing gets flagged, even under a forced-explore draw', () => {
		const high = makeSuppressedHigh();
		const low = makeSuppressedLow();
		const request = makeRequest({ includeLowQ: true });

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[high, low],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 }, // would force exploration if the layer ran
		);

		expect(items).toHaveLength(2);
		expect(items.every((item) => item.explored === undefined)).toBe(true);
		expect(diagnostics.exploredCount).toBe(0);
		expect(diagnostics.suppressedLowQCount).toBe(0); // includeLowQ: nothing suppressed either
	});
});

describe('C.1 — active exploration: boundary — never resurrects a non-suppressed record', () => {
	test('an at-threshold record (qValue === suppressionThreshold, NOT suppressed) is never flagged explored, even when it outscores the suppressed candidate', () => {
		const atThreshold = makeRecord({
			id: 'mem_at_threshold_high_score',
			tags: ['database', 'pool', 'timeout'], // deliberately high baseScore
			metadata: { qValue: DEFAULT_QLEARNING_CONFIG.suppressionThreshold },
		});
		const suppressed = makeSuppressedLow();
		const request = makeRequest();

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[atThreshold, suppressed],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 },
		);

		const atThresholdItem = items.find(
			(item) => item.record.id === atThreshold.id,
		);
		expect(atThresholdItem).toBeDefined();
		expect(atThresholdItem?.explored).toBeUndefined();

		// The genuinely-suppressed (lower-baseScore) record is the one
		// resurrected — never the at-threshold record, regardless of score.
		const exploredItem = items.find((item) => item.explored === true);
		expect(exploredItem?.record.id).toBe(suppressed.id);
		expect(diagnostics.exploredCount).toBe(1);
	});
});

describe('C.1 — active exploration: falsifiability — no-op when nothing is suppressed', () => {
	test('a forced-explore draw with zero suppressed candidates is a no-op', () => {
		const normal = makeNormal();
		const request = makeRequest();

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[normal],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 },
		);

		expect(items).toHaveLength(1);
		expect(items[0].explored).toBeUndefined();
		expect(diagnostics.exploredCount).toBe(0);
	});

	test('a suppressed candidate that fails minScore even unsuppressed is never resurrected', () => {
		// This record's baseScore (0.578, no tag overlap) is well below a
		// minScore set just above it — exploration must respect the SAME
		// minScore gate as normal recall, not rescue an otherwise-too-weak
		// suppressed candidate just because it was chosen as "best".
		const suppressed = makeSuppressedLow();
		const request = makeRequest({ minScore: 0.6 });

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[suppressed],
			request,
			DEFAULT_QLEARNING_CONFIG,
			{ random: () => 0 },
		);

		expect(items).toHaveLength(0);
		expect(diagnostics.exploredCount).toBe(0);
	});
});

describe('C.1 — active exploration: explorationRate=0 is a hard off-switch', () => {
	test('even a forced-explore random draw never fires when explorationRate is 0', () => {
		const suppressed = makeSuppressedHigh();
		const request = makeRequest();
		const config: QLearningConfig = {
			...DEFAULT_QLEARNING_CONFIG,
			explorationRate: 0,
		};

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[suppressed],
			request,
			config,
			{ random: () => 0 },
		);

		expect(items).toHaveLength(0);
		expect(diagnostics.exploredCount).toBe(0);
	});
});

describe('C.1 — active exploration: default random seam is Math.random (no options)', () => {
	test('omitting options does not throw and returns a well-formed diagnostics shape', () => {
		const suppressed = makeSuppressedHigh();
		const normal = makeNormal();
		const request = makeRequest();

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[suppressed, normal],
			request,
			DEFAULT_QLEARNING_CONFIG,
		);

		// Cannot assert a specific outcome (real randomness), but the shape and
		// invariants must hold regardless of the draw.
		expect(
			diagnostics.exploredCount === 0 || diagnostics.exploredCount === 1,
		).toBe(true);
		expect(items.filter((item) => item.explored === true).length).toBe(
			diagnostics.exploredCount,
		);
	});
});

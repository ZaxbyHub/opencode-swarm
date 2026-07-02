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
	scoreMemoryRecords,
	scoreMemoryRecordsWithDiagnostics,
} from '../../../src/memory/scoring';

/**
 * A.6 — recall suppression of low-q memories (FR-006 / SC-007).
 *
 * Mirrors the record/request builders in `tests/unit/memory/scoring.test.ts`
 * and `tests/unit/memory/scoring-q-value-boost.test.ts`. Covers the early
 * filter added to `scoreMemoryRecordDetailed`:
 *
 *   if (request.includeLowQ !== true && getQValue(record, initialQValue)
 *       < qLearningConfig.suppressionThreshold)
 *     return { item: null, skipReason: 'suppressed_low_q' };
 *
 * This is distinct from — and applied strictly BEFORE — the A.5 ranking
 * boost: suppression is a hard recall-time omission, never a mutation of
 * the underlying record.
 *
 * C.1 (FR-014/SC-016) layers a bounded, probabilistic active-exploration
 * resurrection ON TOP of this filter (see `scoring-exploration.test.ts`).
 * Every exclusion assertion below pins `explorationRate: 0` via
 * `DETERMINISTIC_CONFIG` so this suite exercises ONLY the A.6 filter itself
 * and stays deterministic — without the pin, `DEFAULT_QLEARNING_CONFIG`'s
 * real `explorationRate` (0.05) combined with the real `Math.random` default
 * would make these assertions flaky (~5% chance of resurrection per run).
 */

const DETERMINISTIC_CONFIG: QLearningConfig = {
	...DEFAULT_QLEARNING_CONFIG,
	explorationRate: 0,
};

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

describe('A.6 — suppression: below-threshold excluded by default (SC-007)', () => {
	test('a record with qValue=0.1 and a strong lexical match is NOT in default results', () => {
		const record = makeRecord({
			id: 'mem_low_q_suppressed',
			metadata: { qValue: 0.1 },
		});
		const request = makeRequest();

		const items = scoreMemoryRecords([record], request, DETERMINISTIC_CONFIG);
		expect(items).toHaveLength(0);

		const { items: itemsWithDiag } = scoreMemoryRecordsWithDiagnostics(
			[record],
			request,
			DETERMINISTIC_CONFIG,
		);
		expect(itemsWithDiag).toHaveLength(0);
	});
});

describe('A.6 — suppression: opt-in restores the record', () => {
	test('the same qValue=0.1 record IS returned with includeLowQ: true', () => {
		const record = makeRecord({
			id: 'mem_low_q_optin',
			metadata: { qValue: 0.1 },
		});
		const suppressed = scoreMemoryRecords(
			[record],
			makeRequest(),
			DETERMINISTIC_CONFIG,
		);
		const optedIn = scoreMemoryRecords(
			[record],
			makeRequest({ includeLowQ: true }),
		);

		expect(suppressed).toHaveLength(0);
		expect(optedIn).toHaveLength(1);
		expect(optedIn[0].record.id).toBe('mem_low_q_optin');
	});
});

describe('A.6 — suppression: boundary is strict "<" (SC-007)', () => {
	test('qValue exactly at the threshold (0.15) is NOT suppressed', () => {
		const atThreshold = makeRecord({
			id: 'mem_at_threshold',
			metadata: { qValue: DEFAULT_QLEARNING_CONFIG.suppressionThreshold },
		});
		const request = makeRequest();

		const items = scoreMemoryRecords([atThreshold], request);
		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe('mem_at_threshold');

		const { diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[atThreshold],
			request,
		);
		expect(diagnostics.suppressedLowQCount).toBe(0);
	});

	test('qValue just below the threshold (0.149999) IS suppressed', () => {
		const justBelow = makeRecord({
			id: 'mem_just_below',
			metadata: {
				qValue: DEFAULT_QLEARNING_CONFIG.suppressionThreshold - 0.000001,
			},
		});
		const items = scoreMemoryRecords(
			[justBelow],
			makeRequest(),
			DETERMINISTIC_CONFIG,
		);
		expect(items).toHaveLength(0);
	});
});

describe('A.6 — suppression: neutral/absent q-value always survives', () => {
	test('absent qValue (falls back to 0.5) is returned by default', () => {
		const absent = makeRecord({ id: 'mem_absent_qvalue' }); // metadata: {}
		const items = scoreMemoryRecords([absent], makeRequest());
		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe('mem_absent_qvalue');
	});

	test('explicit qValue=0.5 is returned by default', () => {
		const neutral = makeRecord({
			id: 'mem_explicit_neutral',
			metadata: { qValue: 0.5 },
		});
		const items = scoreMemoryRecords([neutral], makeRequest());
		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe('mem_explicit_neutral');
	});
});

describe('A.6 — suppression: never mutates or tombstones the record', () => {
	test('a suppressed record is byte-identical (JSON) before and after scoring', () => {
		const record = makeRecord({
			id: 'mem_no_mutation',
			metadata: { qValue: 0.05 },
		});
		const before = JSON.stringify(record);

		const items = scoreMemoryRecords(
			[record],
			makeRequest(),
			DETERMINISTIC_CONFIG,
		);
		expect(items).toHaveLength(0); // sanity: this record IS suppressed

		const after = JSON.stringify(record);
		expect(after).toBe(before);
		// Specifically: no tombstone/deleted flag was ever added.
		expect(record.metadata.deleted).toBeUndefined();
		expect(record.supersededBy).toBeUndefined();
	});
});

describe('A.6 — suppression: diagnostics report suppressedLowQCount accurately', () => {
	test('counts exactly the below-threshold records, and 0 when opted in', () => {
		const low1 = makeRecord({ id: 'mem_diag_low_1', metadata: { qValue: 0 } });
		const low2 = makeRecord({
			id: 'mem_diag_low_2',
			metadata: { qValue: 0.14 },
		});
		const neutral = makeRecord({
			id: 'mem_diag_neutral',
			metadata: { qValue: 0.5 },
		});
		const records = [low1, low2, neutral];

		const { items, diagnostics } = scoreMemoryRecordsWithDiagnostics(
			records,
			makeRequest(),
			DETERMINISTIC_CONFIG,
		);
		expect(diagnostics.suppressedLowQCount).toBe(2);
		expect(items).toHaveLength(1);
		expect(items[0].record.id).toBe('mem_diag_neutral');

		const { items: itemsOptIn, diagnostics: diagnosticsOptIn } =
			scoreMemoryRecordsWithDiagnostics(
				records,
				makeRequest({ includeLowQ: true }),
			);
		expect(diagnosticsOptIn.suppressedLowQCount).toBe(0);
		expect(itemsOptIn).toHaveLength(3);
	});
});

describe('A.6 — suppression: threshold is config-driven, not hardcoded', () => {
	test('a custom suppressionThreshold=0.4 suppresses qValue=0.3 that the default (0.15) would keep', () => {
		const record = makeRecord({
			id: 'mem_custom_threshold',
			metadata: { qValue: 0.3 },
		});
		const request = makeRequest();

		// Default config (threshold 0.15): 0.3 is above threshold, kept.
		const defaultItems = scoreMemoryRecords(
			[record],
			request,
			DEFAULT_QLEARNING_CONFIG,
		);
		expect(defaultItems).toHaveLength(1);

		// Custom config (threshold 0.4): 0.3 is now below threshold, suppressed.
		// explorationRate: 0 pins this suite deterministic (see file-level note).
		const customConfig: QLearningConfig = {
			...DEFAULT_QLEARNING_CONFIG,
			suppressionThreshold: 0.4,
			explorationRate: 0,
		};
		const customItems = scoreMemoryRecords([record], request, customConfig);
		expect(customItems).toHaveLength(0);

		const { diagnostics } = scoreMemoryRecordsWithDiagnostics(
			[record],
			request,
			customConfig,
		);
		expect(diagnostics.suppressedLowQCount).toBe(1);
	});
});

// NOTE (finding-8 / gateway no_signal accuracy): `resolveInjectionSkipReason`
// in `src/memory/gateway.ts` is a module-private (non-exported) function, so
// the mixed suppressed+no-signal `'no_signal'` accuracy fix is not reachable
// from a pure scoring-level unit test without changing gateway.ts's exports
// (out of scope for this suite — see task constraints). Skipped per the
// task's "if not unit-reachable, skip and note it" instruction.

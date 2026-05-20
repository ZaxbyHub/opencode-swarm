/**
 * Direct unit tests for formatHiveEntry() encounter_score null-safety (Task 1.2)
 *
 * Tests that formatHiveEntry handles missing/invalid encounter_score values gracefully
 * instead of crashing with TypeError when calling .toFixed() on undefined/null.
 *
 * Uses the _test_exports seam to call formatHiveEntry directly — no mock.module,
 * no process.chdir, no tmpDir. Pure function testing.
 */

import { describe, expect, test } from 'bun:test';
import type { HiveKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { _test_exports } from '../../../src/tools/knowledge-query';

const { formatHiveEntry } = _test_exports;

// ============================================================================
// Helpers
// ============================================================================

/** Create a valid base HiveKnowledgeEntry with sensible defaults. */
function makeHiveEntry(
	overrides: Partial<HiveKnowledgeEntry> = {},
): HiveKnowledgeEntry {
	return {
		id: 'hive-test-entry',
		tier: 'hive',
		lesson: 'A test lesson for encounter score validation',
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2024-01-01T00:00:00Z',
		updated_at: '2024-01-01T00:00:00Z',
		source_project: 'test-project',
		encounter_score: 1.0,
		...overrides,
	} as HiveKnowledgeEntry;
}

// ============================================================================
// Test cases
// ============================================================================

describe('formatHiveEntry — encounter_score formatting', () => {
	test('encounter_score: 1.5 → displays "Encounter Score: 1.50"', () => {
		const entry = makeHiveEntry({ encounter_score: 1.5, id: 'hive-score-1' });
		const result = formatHiveEntry(entry);

		expect(result).toContain('Encounter Score: 1.50');
		expect(result).toContain('hive-score-1');
	});

	test('encounter_score: 0 → displays "Encounter Score: 0.00"', () => {
		const entry = makeHiveEntry({ encounter_score: 0 });
		const result = formatHiveEntry(entry);

		expect(result).toContain('Encounter Score: 0.00');
	});

	test('encounter_score: null → displays "Encounter Score: N/A" (null-safety fix)', () => {
		const entry = makeHiveEntry({
			encounter_score: null as unknown as number,
			id: 'hive-score-null',
		});
		const result = formatHiveEntry(entry);

		expect(result).toContain('Encounter Score: N/A');
		expect(result).toContain('hive-score-null');
	});

	test('encounter_score: NaN → displays "Encounter Score: NaN" (NaN.toFixed behavior)', () => {
		const entry = makeHiveEntry({ encounter_score: NaN, id: 'hive-score-nan' });
		const result = formatHiveEntry(entry);

		expect(result).toContain('Encounter Score: NaN');
		expect(result).toContain('hive-score-nan');
	});

	test('encounter_score: 10.999 → displays "Encounter Score: 11.00" (toFixed rounding)', () => {
		const entry = makeHiveEntry({ encounter_score: 10.999 });
		const result = formatHiveEntry(entry);

		expect(result).toContain('Encounter Score: 11.00');
	});

	test('encounter_score: undefined (field omitted) → displays "Encounter Score: N/A"', () => {
		const entryWithoutScore = {
			id: 'hive-score-missing',
			tier: 'hive' as const,
			lesson: 'Lesson with missing score field',
			category: 'process' as const,
			tags: [] as string[],
			scope: 'global' as const,
			confidence: 0.75,
			status: 'candidate' as const,
			confirmed_by: [] as unknown[],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 1,
			created_at: '2024-01-01T00:00:00Z',
			updated_at: '2024-01-01T00:00:00Z',
			source_project: 'legacy-project',
			// encounter_score intentionally omitted
		};
		const result = formatHiveEntry(
			entryWithoutScore as unknown as HiveKnowledgeEntry,
		);

		expect(result).toContain('Encounter Score: N/A');
		expect(result).toContain('hive-score-missing');
	});

	test('multiple entries with mixed scores → all format without crash', () => {
		const entries = [
			makeHiveEntry({
				id: 'hive-valid',
				encounter_score: 2.5,
			}),
			makeHiveEntry({
				id: 'hive-null-score',
				encounter_score: null as unknown as number,
			}),
			makeHiveEntry({
				id: 'hive-missing-score',
				encounter_score: undefined as unknown as number,
			}),
		];

		// All three should format without throwing
		const results = entries.map(formatHiveEntry);

		expect(results[0]).toContain('Encounter Score: 2.50');
		expect(results[0]).toContain('hive-valid');

		expect(results[1]).toContain('Encounter Score: N/A');
		expect(results[1]).toContain('hive-null-score');

		expect(results[2]).toContain('Encounter Score: N/A');
		expect(results[2]).toContain('hive-missing-score');
	});
});

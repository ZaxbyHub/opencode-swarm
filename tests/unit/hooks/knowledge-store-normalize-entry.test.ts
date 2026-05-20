/**
 * Tests for normalizeEntry() encounter_score backfill behavior.
 * Covers: FR-002, FR-004 null-safety fix for #914.
 *
 * Framework: bun:test (AGENTS.md invariant 7 — no vitest)
 * File: tests/unit/hooks/knowledge-store-normalize-entry.test.ts
 */

import { describe, expect, test } from 'bun:test';
import { normalizeEntry } from '../../../src/hooks/knowledge-store.js';
import type { HiveKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';

// Minimal valid RetrievalOutcome to construct full knowledge entries
const validRetrievalOutcomes = {
	shown_count: 0,
	acknowledged_count: 0,
	applied_explicit_count: 0,
	ignored_count: 0,
	violated_count: 0,
	succeeded_after_shown_count: 0,
	failed_after_shown_count: 0,
};

// Factory: builds a minimal HiveKnowledgeEntry with valid retrieval_outcomes
function makeHiveEntry(
	overrides: Partial<HiveKnowledgeEntry> = {},
): HiveKnowledgeEntry {
	return {
		id: '00000000-0000-0000-0000-000000000001',
		tier: 'hive',
		lesson: 'Test lesson with sufficient length for validation.',
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: { ...validRetrievalOutcomes },
		schema_version: 2,
		created_at: '2025-01-01T00:00:00.000Z',
		updated_at: '2025-01-01T00:00:00.000Z',
		encounter_score: 0,
		...overrides,
	};
}

describe('normalizeEntry — encounter_score backfill (FR-002, FR-004)', () => {
	// -------------------------------------------------------------------------
	// Test case 1: entry without encounter_score field → should get encounter_score: 0
	// -------------------------------------------------------------------------
	test('1. missing encounter_score → backfilled to 0', () => {
		// Cast to bypass TypeScript — simulate a legacy entry that never had the field
		const entry = makeHiveEntry() as Record<string, unknown>;
		delete entry.encounter_score;

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test case 2: entry with encounter_score: undefined → should get encounter_score: 0
	// -------------------------------------------------------------------------
	test('2. encounter_score: undefined → backfilled to 0', () => {
		const entry = makeHiveEntry({
			encounter_score: undefined as unknown as number,
		});

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test case 3: entry with encounter_score: null → should get encounter_score: 0
	// -------------------------------------------------------------------------
	test('3. encounter_score: null → backfilled to 0', () => {
		const entry = makeHiveEntry({ encounter_score: null as unknown as number });

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test case 4: entry with encounter_score: "not-a-number" (string) → should get encounter_score: 0
	// -------------------------------------------------------------------------
	test('4. encounter_score: string → backfilled to 0', () => {
		const entry = makeHiveEntry({
			encounter_score: 'not-a-number' as unknown as number,
		});

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test case 5: entry with encounter_score: NaN → should get encounter_score: 0
	// Note: typeof NaN === 'number', but NaN is not a valid score — backfill to 0
	// -------------------------------------------------------------------------
	test('5. encounter_score: NaN → backfilled to 0', () => {
		const entry = makeHiveEntry({ encounter_score: NaN });

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(0);
		// Confirm NaN check is necessary — typeof NaN is 'number'
		expect(typeof NaN).toBe('number');
	});

	// -------------------------------------------------------------------------
	// Test case 6: entry with encounter_score: 1.5 → should KEEP encounter_score: 1.5
	// -------------------------------------------------------------------------
	test('6. encounter_score: 1.5 → unchanged (no mutation)', () => {
		const entry = makeHiveEntry({ encounter_score: 1.5 });

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(1.5);
	});

	// -------------------------------------------------------------------------
	// Test case 7: entry with encounter_score: 0 → should KEEP encounter_score: 0
	// -------------------------------------------------------------------------
	test('7. encounter_score: 0 → unchanged (no mutation)', () => {
		const entry = makeHiveEntry({ encounter_score: 0 });

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Test case 8: entry without retrieval_outcomes → early return, NO encounter_score backfill
	// The backfill block is AFTER the retrieval_outcomes guard, so this case is untouched.
	// -------------------------------------------------------------------------
	test('8. no retrieval_outcomes → raw returned, no encounter_score backfill', () => {
		const entry = {
			id: '00000000-0000-0000-0000-000000000099',
			tier: 'hive',
			lesson: 'Entry without retrieval_outcomes field.',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.5,
			status: 'candidate',
			confirmed_by: [],
			schema_version: 2,
			created_at: '2025-01-01T00:00:00.000Z',
			updated_at: '2025-01-01T00:00:00.000Z',
			// No retrieval_outcomes — early return at line 121 of knowledge-store.ts
		} as Record<string, unknown>;

		const result = normalizeEntry(entry);

		// Early return means encounter_score is never set
		expect('encounter_score' in result).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Test case 9: hive entry with all fields present → should be unchanged
	// -------------------------------------------------------------------------
	test('9. complete hive entry → unchanged (no mutation)', () => {
		const entry = makeHiveEntry({
			encounter_score: 2.5,
			tags: ['tag1', 'tag2'],
			scope: 'stack:my-swarm',
		});

		const result = normalizeEntry(entry);

		expect(result.encounter_score).toBe(2.5);
		expect(result.tags).toEqual(['tag1', 'tag2']);
		expect(result.scope).toBe('stack:my-swarm');
	});
});

/**
 * Tests for filterHighConfidenceKnowledge. Split from
 * knowledge-application.test.ts to stay under the repo's 500-line test file
 * limit (AGENTS.md invariant 7).
 */

import { describe, expect, it } from 'bun:test';
import { filterHighConfidenceKnowledge } from '../../../src/hooks/knowledge-application.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';

function makeRankedEntry(
	id: string,
	lesson: string,
	confidence: number,
): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		relevanceScore: confidence,
		finalScore: confidence,
	};
}

describe('filterHighConfidenceKnowledge', () => {
	// Happy path: entries >= threshold are included, < threshold are excluded

	it('includes entries with confidence >= threshold', () => {
		const entries = [
			makeRankedEntry('id-1', 'Lesson one', 0.85),
			makeRankedEntry('id-2', 'Lesson two', 0.92),
			makeRankedEntry('id-3', 'Lesson three', 1.0),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(3);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-2', 'id-3']);
	});

	it('excludes entries with confidence < threshold', () => {
		const entries = [
			makeRankedEntry('id-1', 'High confidence', 0.9),
			makeRankedEntry('id-2', 'Low confidence', 0.5),
			makeRankedEntry('id-3', 'Another high', 0.85),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-3']);
	});

	// Default threshold: 0.8 when not provided

	it('uses default threshold of 0.8 when called with no threshold argument', () => {
		const entries = [
			makeRankedEntry('id-1', 'Exactly 0.8', 0.8), // >= 0.8 → included
			makeRankedEntry('id-2', 'Above 0.8', 0.81), // >= 0.8 → included
			makeRankedEntry('id-3', 'Below 0.8', 0.79), // < 0.8 → excluded
		];
		const result = filterHighConfidenceKnowledge(entries);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-2']);
	});

	// Custom threshold

	it('works with custom threshold of 0.9', () => {
		const entries = [
			makeRankedEntry('id-1', 'Confidence 0.9', 0.9), // >= 0.9 → included
			makeRankedEntry('id-2', 'Confidence 0.85', 0.85), // < 0.9 → excluded
			makeRankedEntry('id-3', 'Confidence 1.0', 1.0), // >= 0.9 → included
		];
		const result = filterHighConfidenceKnowledge(entries, 0.9);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-3']);
	});

	it('works with custom threshold of 0.5', () => {
		const entries = [
			makeRankedEntry('id-1', 'High', 0.9),
			makeRankedEntry('id-2', 'Mid', 0.6),
			makeRankedEntry('id-3', 'Low', 0.3),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.5);
		expect(result).toHaveLength(2);
		expect(result.map((e) => e.id)).toEqual(['id-1', 'id-2']);
	});

	it('works with custom threshold of 1.0 (only perfect confidence included)', () => {
		const entries = [
			makeRankedEntry('id-1', 'Perfect', 1.0),
			makeRankedEntry('id-2', 'Almost perfect', 0.99),
			makeRankedEntry('id-3', 'High', 0.95),
		];
		const result = filterHighConfidenceKnowledge(entries, 1.0);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('id-1');
	});

	it('works with custom threshold of 0.0 (all entries included)', () => {
		const entries = [
			makeRankedEntry('id-1', 'Zero confidence', 0.0),
			makeRankedEntry('id-2', 'Low confidence', 0.3),
			makeRankedEntry('id-3', 'Any confidence', 0.5),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.0);
		expect(result).toHaveLength(3);
	});

	// Empty input

	it('returns empty array for empty input', () => {
		const result = filterHighConfidenceKnowledge([]);
		expect(result).toEqual([]);
	});

	// Edge cases: boundary values

	it('exactly 0.8 threshold: entry with confidence 0.8 is included', () => {
		const entries = [makeRankedEntry('id-1', 'Exactly at threshold', 0.8)];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('id-1');
	});

	it('confidence 0.0 is excluded when threshold is 0.8', () => {
		const entries = [makeRankedEntry('id-1', 'Zero confidence', 0.0)];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).toHaveLength(0);
	});

	it('confidence 1.0 is always included with default threshold', () => {
		const entries = [makeRankedEntry('id-1', 'Perfect confidence', 1.0)];
		const result = filterHighConfidenceKnowledge(entries);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('id-1');
	});

	it('mixed boundary values with default threshold 0.8', () => {
		const entries = [
			makeRankedEntry('id-1', 'Just below', 0.79),
			makeRankedEntry('id-2', 'Exactly 0.8', 0.8),
			makeRankedEntry('id-3', 'Just above', 0.81),
			makeRankedEntry('id-4', 'Zero', 0.0),
			makeRankedEntry('id-5', 'Perfect', 1.0),
		];
		const result = filterHighConfidenceKnowledge(entries);
		expect(result).toHaveLength(3);
		expect(result.map((e) => e.id)).toEqual(['id-2', 'id-3', 'id-5']);
	});

	// Preserves input type / generic behavior

	it('preserves the type of entries (generic behavior)', () => {
		interface CustomEntry extends RankedEntry {
			customField?: string;
		}
		const entries: CustomEntry[] = [
			{ ...makeRankedEntry('id-1', 'Lesson', 0.9), customField: 'value1' },
			{ ...makeRankedEntry('id-2', 'Lesson', 0.7), customField: 'value2' },
		];
		const result = filterHighConfidenceKnowledge<CustomEntry>(entries, 0.8);
		expect(result).toHaveLength(1);
		expect(result[0].customField).toBe('value1');
	});

	it('returns new array, does not mutate original', () => {
		const entries = [
			makeRankedEntry('id-1', 'High', 0.9),
			makeRankedEntry('id-2', 'Low', 0.5),
		];
		const result = filterHighConfidenceKnowledge(entries, 0.8);
		expect(result).not.toBe(entries);
		expect(entries).toHaveLength(2); // original unchanged
	});
});

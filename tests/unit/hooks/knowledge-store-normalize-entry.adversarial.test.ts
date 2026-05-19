/**
 * Adversarial tests for normalizeEntry() encounter_score backfill.
 *
 * Attack vectors:
 * 1. encounter_score: Infinity (positive infinity) — should it be backfilled to 0 or kept?
 * 2. encounter_score: -Infinity (negative infinity) — boundary violation
 * 3. encounter_score: -1 (negative number, below valid range) — should this be caught?
 * 4. encounter_score: 999999 (extremely large number) — overflow concern for toFixed
 * 5. encounter_score: 0.0000001 (very small number) — precision edge case
 * 6. Entry with encounter_score as an object {value: 1} — type coercion attack
 * 7. Entry with encounter_score as an array [1, 2] — type coercion attack
 * 8. Entry where encounter_score getter throws — prototype pollution edge case
 * 9. Extremely large entry (10MB lesson text) with missing encounter_score — performance
 * 10. Entry with __proto__ pollution attempt via encounter_score field
 */

import { describe, expect, test } from 'bun:test';
import { normalizeEntry } from '../../../src/hooks/knowledge-store';

// Helper: build a minimal knowledge entry with retrieval_outcomes (triggers normalization path)
function makeEntry(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 'test-entry',
		lesson: 'Test lesson',
		category: 'process' as const,
		tags: [],
		scope: 'swarm' as const,
		status: 'candidate' as const,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		phases_alive: 0,
		retrieval_outcomes: {
			shown_count: 0,
			acknowledged_count: 0,
			applied_explicit_count: 0,
			ignored_count: 0,
			violated_count: 0,
			succeeded_after_shown_count: 0,
			failed_after_shown_count: 0,
		},
		...overrides,
	};
}

describe('normalizeEntry — encounter_score adversarial', () => {
	// -------------------------------------------------------------------------
	// Vector 1: encounter_score = +Infinity
	// Current behavior: typeof Infinity === 'number' → passes through as 0 backfill
	// Risk: Infinity stored in DB, may cause downstream NaN/Infinity in calculations
	// -------------------------------------------------------------------------
	test('1. Infinity is NOT backfilled — passes through as-is (typeof Infinity is number)', () => {
		const entry = makeEntry({ encounter_score: Infinity });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		// Infinity is a number in JS; current guard does NOT replace it
		expect(result.encounter_score).toBe(Infinity);
	});

	// -------------------------------------------------------------------------
	// Vector 2: encounter_score = -Infinity
	// Current behavior: typeof -Infinity === 'number' → passes through
	// Risk: negative infinity is nonsensical for a score; downstream sort/compare breaks
	// -------------------------------------------------------------------------
	test('2. -Infinity is NOT backfilled — passes through as-is (typeof -Infinity is number)', () => {
		const entry = makeEntry({ encounter_score: -Infinity });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(-Infinity);
	});

	// -------------------------------------------------------------------------
	// Vector 3: encounter_score = -1 (negative number)
	// Current behavior: typeof -1 === 'number' → passes through
	// Risk: negative score is invalid per FR-002; downstream sort/filter breaks
	// -------------------------------------------------------------------------
	test('3. Negative number -1 is NOT backfilled — passes through (out-of-range)', () => {
		const entry = makeEntry({ encounter_score: -1 });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(-1);
	});

	// -------------------------------------------------------------------------
	// Vector 4: encounter_score = 999999 (extremely large number)
	// Risk: toFixed(2) on downstream display would produce "1000000.00";
	//       no integer overflow in JS (IEEE 754 double), but still semantically wrong
	// -------------------------------------------------------------------------
	test('4. Extremely large number 999999 passes through — no overflow in JS', () => {
		const entry = makeEntry({ encounter_score: 999999 });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(999999);
		// toFixed(2) still works without overflow
		expect((999999).toFixed(2)).toBe('999999.00');
	});

	// -------------------------------------------------------------------------
	// Vector 5: encounter_score = 0.0000001 (very small positive number)
	// Risk: minimal precision entry; Jaccard sort weight near-zero is fine
	// -------------------------------------------------------------------------
	test('5. Very small number 0.0000001 passes through — reasonable precision floor', () => {
		const entry = makeEntry({ encounter_score: 0.0000001 });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(0.0000001);
	});

	// -------------------------------------------------------------------------
	// Vector 6: encounter_score as object {value: 1} — type coercion attack
	// typeof {} === 'object' → should trigger backfill to 0
	// -------------------------------------------------------------------------
	test('6. encounter_score as object {value: 1} triggers backfill to 0', () => {
		const entry = makeEntry({ encounter_score: { value: 1 } as unknown });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		// object is not a number → backfill
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Vector 7: encounter_score as array [1, 2] — type coercion attack
	// typeof [] === 'object' → should trigger backfill to 0
	// -------------------------------------------------------------------------
	test('7. encounter_score as array [1, 2] triggers backfill to 0', () => {
		const entry = makeEntry({ encounter_score: [1, 2] as unknown });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		// array is object, not number → backfill
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Vector 8: encounter_score getter throws — prototype pollution edge case
	// FIXED: typeof obj.encounter_score access used to THROW when a getter is
	// present, crashing normalizeEntry. Now guarded with try/catch — defaults
	// encounter_score to 0 instead of propagating the throw.
	// -------------------------------------------------------------------------
	test('8. does NOT crash on throwing getter — returns entry with encounter_score = 0', () => {
		const entry = makeEntry({});
		// Create a Proxy that throws on encounter_score access when it's not
		// an own property of the target (simulating a poisoned getter).
		// After normalizeEntry uses Object.defineProperty to set it, reads succeed.
		const throwingEntry = new Proxy(entry, {
			get(target, prop) {
				if (
					prop === 'encounter_score' &&
					!Object.hasOwn(target, 'encounter_score')
				) {
					throw new Error('Getter threw — prototype pollution simulation');
				}
				return Reflect.get(target, prop);
			},
			set(_target, prop, _value) {
				if (prop === 'encounter_score') {
					throw new Error('Setter threw — assignment blocked');
				}
				return Reflect.set(_target, prop, _value);
			},
		});

		// FIXED: try/catch + Object.defineProperty — no throw propagates
		const result = normalizeEntry(throwingEntry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Vector 9: 10MB lesson text with missing encounter_score — performance
	// normalizeEntry does a shallow pass; should backfill without OOM or stall
	// -------------------------------------------------------------------------
	test('9. 10MB lesson text with missing encounter_score backfills in bounded time', () => {
		const largeLesson = 'x'.repeat(10 * 1024 * 1024); // 10 MB
		const entry = makeEntry({ lesson: largeLesson });
		// No encounter_score set — the guard at line 150 checks typeof !== 'number'
		// which is 'undefined' → triggers backfill

		const start = Date.now();
		const result = normalizeEntry(entry) as Record<string, unknown>;
		const elapsed = Date.now() - start;

		expect(result.encounter_score).toBe(0);
		// Should complete well under 1 second even with 10MB string
		expect(elapsed).toBeLessThan(1000);
	});

	// -------------------------------------------------------------------------
	// Vector 10: __proto__ pollution attempt via encounter_score field
	// Setting __proto__ as a property (not the actual prototype) should not pollute
	// -------------------------------------------------------------------------
	test('10. __proto__ as encounter_score property does not pollute prototype', () => {
		const entry = makeEntry({ __proto__: { pollute: 'yes' } });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		// __proto__ set as own property — object still has default encounter_score 0
		expect(result.encounter_score).toBe(0);
		// Confirm actual prototype is untouched
		expect(Object.getPrototypeOf(result)).not.toHaveProperty('pollute');
	});

	// -------------------------------------------------------------------------
	// Additional boundary: encounter_score = NaN
	// Number.isNaN(NaN) === true → should trigger backfill to 0
	// -------------------------------------------------------------------------
	test('NaN encounter_score triggers backfill to 0 (Number.isNaN guard)', () => {
		const entry = makeEntry({ encounter_score: NaN });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Additional boundary: encounter_score = null
	// typeof null === 'object' → triggers backfill to 0
	// -------------------------------------------------------------------------
	test('null encounter_score triggers backfill to 0 (typeof null is object)', () => {
		const entry = makeEntry({ encounter_score: null });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Additional boundary: encounter_score = undefined (explicit)
	// typeof undefined !== 'number' → triggers backfill to 0
	// -------------------------------------------------------------------------
	test('undefined encounter_score triggers backfill to 0', () => {
		const entry = makeEntry({ encounter_score: undefined });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Sanity: valid encounter_score = 0 is unchanged
	// -------------------------------------------------------------------------
	test('valid encounter_score = 0 is preserved (not double-defaulted)', () => {
		const entry = makeEntry({ encounter_score: 0 });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(0);
	});

	// -------------------------------------------------------------------------
	// Sanity: valid encounter_score = 1.0 is preserved
	// -------------------------------------------------------------------------
	test('valid encounter_score = 1.0 is preserved', () => {
		const entry = makeEntry({ encounter_score: 1.0 });
		const result = normalizeEntry(entry) as Record<string, unknown>;
		expect(result.encounter_score).toBe(1.0);
	});
});

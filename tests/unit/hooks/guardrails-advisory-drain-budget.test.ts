/**
 * Tests for the drain-level advisory byte budget (issue #1976).
 *
 * The drain joins all pending advisories into a single [ADVISORIES] block
 * prepended to the architect's first system message. Without a bound that
 * block can flood the prompt (the PR_REVIEW banner failure). The budget keeps
 * the LATEST entries (drops oldest) because high-value advisories arrive late
 * in a turn, and discloses truncation in the block header.
 */

import { describe, expect, test } from 'bun:test';
import { boundAdvisoryBytes } from '../../../src/hooks/guardrails/messages-transform';

describe('boundAdvisoryBytes (drain byte budget)', () => {
	test('returns all entries when under budget', () => {
		const { kept, truncated } = boundAdvisoryBytes(['a', 'b', 'c'], 1000);
		expect(kept).toEqual(['a', 'b', 'c']);
		expect(truncated).toBe(false);
	});

	test('drops oldest entries (keep-latest) when over budget', () => {
		// Each entry is ~1000 bytes; budget 2500 keeps only the latest 2-3.
		const big = (label: string) => `${label}-${'x'.repeat(1000)}`;
		const { kept, truncated } = boundAdvisoryBytes(
			[big('oldest'), big('mid'), big('newest')],
			2500,
		);
		expect(truncated).toBe(true);
		// Oldest dropped; newest retained.
		expect(kept.some((m) => m.startsWith('newest'))).toBe(true);
		expect(kept.some((m) => m.startsWith('oldest'))).toBe(false);
	});

	test('never drops below a single entry (one oversized advisory kept verbatim)', () => {
		const huge = 'x'.repeat(100_000);
		const { kept, truncated } = boundAdvisoryBytes([huge], 100);
		expect(kept).toEqual([huge]);
		// A single entry is never "truncated" relative to itself.
		expect(truncated).toBe(false);
	});

	test('keep-latest is a priority-correct choice: late high-value retained over early low-value', () => {
		const earlyLowValue = `early-noise-${'.'.repeat(2000)}`;
		const lateHighValue = `LATE-CRITICAL: reviewer rejected-${'.'.repeat(2000)}`;
		const { kept } = boundAdvisoryBytes([earlyLowValue, lateHighValue], 3000);
		// Budget fits roughly one entry; the latest (high-value) wins.
		expect(kept.at(-1)).toBe(lateHighValue);
	});

	test('empty input returns empty, not truncated', () => {
		const { kept, truncated } = boundAdvisoryBytes([], 1000);
		expect(kept).toEqual([]);
		expect(truncated).toBe(false);
	});
});

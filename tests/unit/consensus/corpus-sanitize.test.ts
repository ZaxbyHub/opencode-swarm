/**
 * `sanitizeExcerpt` — the single choke point every free-text fragment passes
 * through before it can reach a signal, a statement, or an evidence ref.
 *
 * Split from `corpus.test.ts`. Merged they would be ~490 lines — under the
 * FR-006 500-line cap, but with ten lines of headroom, which is not enough for
 * the next sanitizer property anyone adds.
 * Three properties are load-bearing and each has a way of silently regressing:
 * redaction must run BEFORE the length bound (or a secret straddling the cut is
 * half-copied in the clear), whitespace must collapse (or one finding splits
 * into two signals), and control AND format characters must be removed (or a
 * bidi override makes a stored excerpt render as something the report does not
 * contain and its integrity hash does not cover).
 */

import { describe, expect, test } from 'bun:test';
import { sanitizeExcerpt } from '../../../src/consensus/corpus';

describe('sanitizeExcerpt', () => {
	test('redacts a planted secret before applying the length bound', async () => {
		// Redaction must run FIRST: a secret straddling the truncation point
		// would otherwise be half-copied into the report in the clear.
		const raw = `prefix ${'x'.repeat(20)} AKIAIOSFODNN7EXAMPLE tail`;
		const bounded = sanitizeExcerpt(raw, 40);
		expect(bounded).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(bounded.length).toBeLessThanOrEqual(40);
	});

	test('collapses newlines so one finding cannot split into two signals', () => {
		expect(sanitizeExcerpt('a\n\n  b\tc  ', 100)).toBe('a b c');
	});

	test('truncates to the configured bound', () => {
		expect(sanitizeExcerpt('y'.repeat(500), 10)).toHaveLength(10);
	});

	test.each([
		// A right-to-left override makes the retained text RENDER in a different
		// order than the bytes stored and hashed, so a persisted `llmSummary` can
		// read as something the report does not contain. `\p{Cc}` does not match
		// any of these; `\p{Cf}` does. Escaped rather than embedded literally so
		// this file stays plain text.
		['a right-to-left override (U+202E)', '\u202E'],
		['a left-to-right override (U+202D)', '\u202D'],
		['a first-strong isolate (U+2068)', '\u2068'],
		['a left-to-right isolate (U+2066)', '\u2066'],
		['a pop directional isolate (U+2069)', '\u2069'],
		['a zero-width joiner (U+200D)', '\u200D'],
		['a zero-width non-joiner (U+200C)', '\u200C'],
		['a zero-width space (U+200B)', '\u200B'],
		['a byte order mark (U+FEFF)', '\uFEFF'],
		['a soft hyphen (U+00AD)', '\u00AD'],
	])('strips %s — a format character must not reach disk', (_label, control) => {
		const sanitized = sanitizeExcerpt(`scoring${control}succeeded`, 100);
		expect(sanitized).not.toContain(control);
		expect(sanitized).toBe('scoring succeeded');
	});

	test('a bidi override cannot survive inside an otherwise clean excerpt', () => {
		const sanitized = sanitizeExcerpt(
			'gate\u202E denrut \u202Cprofile scored higher',
			200,
		);
		expect(/\p{Cf}/u.test(sanitized)).toBe(false);
	});
});

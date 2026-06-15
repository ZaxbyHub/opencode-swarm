import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Tests for the override justification minimum-length requirement in
 * phase-complete.ts (issue #1234 WP6-C).
 *
 * The validation in phase-complete.ts:
 *   1. Trims the incoming justification string.
 *   2. Rejects it if the trimmed length is < 10.
 *   3. Only applies the override when the trimmed length is >= 10.
 *
 * Rather than invoking the full phase_complete tool (which requires extensive
 * mocking of state, curator, knowledge, plan, and directive subsystems), we
 * replicate the exact validation logic as a focused helper and verify its
 * boundary behavior exhaustively. A source-code verification test confirms the
 * threshold constant has not silently regressed.
 */

// ---------------------------------------------------------------------------
// Helper — mirrors the validation extracted from phase-complete.ts lines ~514-548
// ---------------------------------------------------------------------------

/**
 * Replicates the justification validation performed inside phase_complete:
 *
 *   const justification =
 *     typeof args.acceptViolationsJustification === 'string'
 *       ? args.acceptViolationsJustification.trim()
 *       : '';
 *   ...
 *   if (requestedAccept.length > 0 && justification.length < 10) { ... block ... }
 *
 * Returns `true` when the justification is long enough to pass the gate.
 */
function validateJustification(justification: string): boolean {
	const trimmed = justification.trim();
	return trimmed.length >= 10;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase-complete override justification minimum length', () => {
	test('rejects empty string', () => {
		expect(validateJustification('')).toBe(false);
	});

	test('rejects whitespace-only string', () => {
		expect(validateJustification('   ')).toBe(false);
		expect(validateJustification('\t\n')).toBe(false);
	});

	test('rejects single character', () => {
		expect(validateJustification('a')).toBe(false);
	});

	test('rejects 9-character string (boundary - 1)', () => {
		// "too short" is exactly 9 characters
		const nineChars = 'too short';
		expect(nineChars.length).toBe(9);
		expect(validateJustification(nineChars)).toBe(false);
	});

	test('accepts exactly 10-character string (boundary)', () => {
		// "good reaso" is exactly 10 characters
		const tenChars = 'good reaso';
		expect(tenChars.length).toBe(10);
		expect(validateJustification(tenChars)).toBe(true);
	});

	test('accepts 11-character string (boundary + 1)', () => {
		const elevenChars = 'good reason';
		expect(elevenChars.length).toBe(11);
		expect(validateJustification(elevenChars)).toBe(true);
	});

	test('accepts substantive justification', () => {
		expect(
			validateJustification(
				"This directive conflicts with the project's testing strategy",
			),
		).toBe(true);
	});

	test('rejects padded short string (trims first, then checks length)', () => {
		// "  abc  " trims to "abc" (3 chars) — must be rejected
		expect(validateJustification('  abc  ')).toBe(false);
	});

	test('accepts padded long string (trims first, still >= 10)', () => {
		// "  good reason  " trims to "good reason" (11 chars) — must pass
		expect(validateJustification('  good reason  ')).toBe(true);
	});

	test('rejects string that is exactly 10 chars only because of padding', () => {
		// "   abcde  " is 10 chars total, but trims to "abcde" (5 chars)
		const padded = '   abcde  ';
		expect(padded.length).toBe(10);
		expect(validateJustification(padded)).toBe(false);
	});

	// ---------------------------------------------------------------------------
	// Source-code verification — confirm the threshold constant in the actual file
	// ---------------------------------------------------------------------------

	test('source code uses threshold of 10 for justification length', () => {
		const sourceFile = path.resolve(
			__dirname,
			'../../../src/tools/phase-complete.ts',
		);
		const source = fs.readFileSync(sourceFile, 'utf-8');

		// The blocking check: justification.length < 10
		expect(source).toContain('justification.length < 10');

		// The effective-accept gate: justification.length >= 10
		expect(source).toContain('justification.length >= 10');

		// The user-facing message mentions the minimum
		expect(source).toContain('minimum 10 characters');
	});
});

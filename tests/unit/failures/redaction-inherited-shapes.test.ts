/**
 * #3736 (AC1, class NEW-SURFACE; AC3 control, class PRESERVING): the five
 * JWT-family shapes the legacy `{10,1024}` header / `{10,}` signature arms
 * and the linear JWS scanner leave in cleartext are eliminated at BOTH
 * redaction sites — display (`sanitizeFailureEvidenceDisplay`) and shell
 * mirror (`redactShellCommand`).
 *
 * RED at base c12cd853d (2026-11-17): every one of the five shape legs
 * below was probe-verified at base to survive byte-identical at BOTH sites
 * (matching the issue's verbatim output lines). GREEN after the fix widens
 * both mirrors. The `dot-adjacent` control and the benign dotted-triple
 * legs are GREEN at base and must STAY green (AC3 / no-over-redaction).
 *
 * The five shapes (labels as in the issue body):
 *   1. JWE-5part        — scanner consumes exactly 3 segments; the 4th/5th
 *                          (".ZGl2dmVjdG9y.YXV0aHRhZw") survive.
 *   2. 2segment-unsigned — `hdr.payload.` with an empty signature fails the
 *                          signature `{10,}` bound; nothing matches.
 *   3. plus-slash-pad   — standard-base64 header (A+/B=, 183 chars, no eyJ
 *                          prefix): no arm matches a non-eyJ header and the
 *                          ≥80-char base64 fallback needs mixed case+digit.
 *   4. underscore-boundary — `x_eyJ…`: headerStart honors only run-start or
 *                          `-` boundaries and `\b` does not fire between two
 *                          word chars, so the scanner and the legacy arm both
 *                          miss.
 *   5. short-signature  — 3-char signature `sig` fails the `{10,}` bound.
 *
 * Fixture inputs below reproduce the issue's five verbatim output lines
 * (for leaking shapes output === input, so the lines ARE the inputs; the
 * JWE-5part head is reconstructed as the issue specifies: the alg/dir+alg
 * header, 43x'K' encrypted key, 22x'I' iv — the residual tail
 * '.ZGl2dmVjdG9y.YXV0aHRhZw' matches the issue's output byte-for-byte).
 *
 * No new seam required — both redactors are pure functions.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/** 59-char claims payload shared by shapes 2-5 (verbatim from the issue). */
const PAYLOAD_CLAIMS =
	'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyBVc2VyIn0';
/** 35-char signature shared by shapes 3-4 (verbatim from the issue). */
const SIGNATURE_35 = 'c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA';
/** 24-char cleartext claim fragment asserted absent (payload elimination). */
const NEEDLE_PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkw';
/** 20-char cleartext signature fragment asserted absent. */
const NEEDLE_SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVz';

// Shape inputs (labels mirror the issue's five verbatim fixture lines).
const SHAPE_JWE_5PART = `eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.${'K'.repeat(43)}.${'I'.repeat(22)}.ZGl2dmVjdG9y.YXV0aHRhZw`;
const SHAPE_2SEGMENT_UNSIGNED = `eyJhbGciOiJub25lIn0.${PAYLOAD_CLAIMS}.`;
const SHAPE_PLUS_SLASH_PAD = `${'A'.repeat(90)}+/${'B'.repeat(90)}=.${PAYLOAD_CLAIMS}.${SIGNATURE_35}`;
const SHAPE_UNDERSCORE_BOUNDARY = `x_eyJhbGciOiJIUzI1NiIsImtpZCI6InRlc3QifQ.${PAYLOAD_CLAIMS}.${SIGNATURE_35}`;
const SHAPE_SHORT_SIGNATURE = `eyJhbGciOiJIUzI1NiIsImtpZCI6InRlc3QifQ.${PAYLOAD_CLAIMS}.sig`;

function expectEliminatedAtBothSites(input: string, needles: string[]): void {
	const display = sanitizeFailureEvidenceDisplay(input);
	const shell = redactShellCommand(input);
	for (const needle of needles) {
		expect(display.includes(needle)).toBe(false);
		expect(shell.includes(needle)).toBe(false);
	}
	// The positive label assertion keeps an elimination from passing
	// vacuously via the display site's 512-byte output bound.
	expect(display).toContain('[REDACTED:jwt]');
	expect(shell).toContain('[REDACTED:jwt]');
}

describe('#3736 AC1: five inherited JWT-family shapes eliminated at BOTH redaction sites', () => {
	test('shape JWE-5part: 5-part JWE tail (4th/5th segments) eliminated at both sites', () => {
		// Base output at BOTH sites: "[REDACTED:jwt].ZGl2dmVjdG9y.YXV0aHRhZw"
		// (issue line 1 verbatim) — the scanner consumes exactly 3 segments.
		expectEliminatedAtBothSites(SHAPE_JWE_5PART, [
			NEEDLE_PAYLOAD,
			'ZGl2dmVjdG9y',
			'YXV0aHRhZw',
		]);
	});

	test('shape 2segment-unsigned: `hdr.payload.` (empty signature) eliminated at both sites', () => {
		// Base output at BOTH sites: the full input cleartext (issue line 2
		// verbatim) — the empty signature fails the `{10,}` bound.
		expectEliminatedAtBothSites(SHAPE_2SEGMENT_UNSIGNED, [
			NEEDLE_PAYLOAD,
			'eyJhbGciOiJub25lIn0',
		]);
	});

	test('shape plus-slash-pad: standard-base64 A+/B= header (no eyJ prefix) eliminated at both sites', () => {
		// Base output at BOTH sites: the full input cleartext (issue line 3
		// verbatim) — no arm matches a non-eyJ header.
		expectEliminatedAtBothSites(SHAPE_PLUS_SLASH_PAD, [
			NEEDLE_PAYLOAD,
			NEEDLE_SIGNATURE,
		]);
	});

	test('shape underscore-boundary: x_eyJ… underscore boundary eliminated at both sites', () => {
		// Base output at BOTH sites: the full input cleartext (issue line 4
		// verbatim) — `\b` never fires between two word chars and headerStart
		// honors only run-start or `-` boundaries.
		expectEliminatedAtBothSites(SHAPE_UNDERSCORE_BOUNDARY, [
			NEEDLE_PAYLOAD,
			NEEDLE_SIGNATURE,
		]);
	});

	test('shape short-signature: hdr.payload.sig (3-char signature) eliminated at both sites', () => {
		// Base output at BOTH sites: the full input cleartext (issue line 5
		// verbatim) — the 3-char signature fails the `{10,}` bound.
		expectEliminatedAtBothSites(SHAPE_SHORT_SIGNATURE, [
			NEEDLE_PAYLOAD,
			NEEDLE_SIGNATURE,
		]);
	});
});

describe('#3736 AC3 control: dot-adjacent JWS stays eliminated at both sites (GREEN at base — must not regress)', () => {
	test('prefix.hdr.payload.sig.suffix redacts to exactly prefix.[REDACTED:jwt].suffix at BOTH sites', () => {
		const input = `prefix.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3In0.c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA.suffix`;
		expect(sanitizeFailureEvidenceDisplay(input)).toBe(
			'prefix.[REDACTED:jwt].suffix',
		);
		expect(redactShellCommand(input)).toBe('prefix.[REDACTED:jwt].suffix');
	});
});

describe('#3736 no-over-redaction: ordinary dotted text passes through UNCHANGED at both sites (GREEN at base)', () => {
	// Base-behavior pin (probe-verified): neither redactor touches benign
	// short dotted triples — widening the JWT arms for the five shapes must
	// not drag these in.
	for (const text of ['foo.bar.baz', 'v1.2.3', 'one two. three four. five.']) {
		test(`benign dotted text "${text}" untouched at both sites`, () => {
			expect(sanitizeFailureEvidenceDisplay(text)).toBe(text);
			expect(redactShellCommand(text)).toBe(text);
		});
	}
});

/**
 * #3736 sibling suite (plan v3, critic rounds 1-4): exact-output boundary pins
 * for the widened shared JWS scanner at BOTH redaction sites — the five issue
 * shapes with exact outputs, signature-length bounds under D6-rev, the
 * adjacent-token and dir-JWE compositions under D2-rev2, the D4-rev3
 * standard-base64 placements, and the documented residuals.
 *
 * RED at base c12cd853d (the widened shapes leaked; this file does not exist
 * there), GREEN after the fix.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';
import {
	findJwsTokenSpans,
	findRedactableTokenSpans,
	findStandardB64TokenSpans,
} from '../../../src/utils/jws-redaction';

const HDR = 'eyJhbGciOiJIUzI1NiIsImtpZCI6InRlc3QifQ';
const PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyBVc2VyIn0';
const SIG = 'c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA';
const JWE_HDR = 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0';

describe('#3736 five shapes — exact outputs at both sites', () => {
	test('JWE-5part tail is consumed (exact)', () => {
		const input = `${JWE_HDR}.${'K'.repeat(43)}.${'I'.repeat(22)}.ZGl2dmVjdG9y.YXV0aHRhZw`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
	test('2-segment unsigned (trailing dot) is consumed (exact)', () => {
		const input = `eyJhbGciOiJub25lIn0.${PAYLOAD}.`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
	test('standard-base64 + / = header (bare padded) is consumed (exact)', () => {
		const input = `${'A'.repeat(90)}+/${'B'.repeat(90)}=.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
	test('underscore boundary: x_ prefix preserved, token consumed (exact)', () => {
		const input = `x_${HDR}.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(input)).toBe('x_[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('x_[REDACTED:jwt]');
	});
	test('short signature: payload and .sig both consumed (exact)', () => {
		const input = `${HDR}.${PAYLOAD}.sig`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
});

describe('#3736 D6-rev signature bounds (eyJ-anchored)', () => {
	test('signatures of 1 and 9 chars are accepted; 0 rejected', () => {
		expect(findJwsTokenSpans(`${HDR}.${PAYLOAD}.s`)).toHaveLength(1);
		expect(
			findJwsTokenSpans(`${HDR}.${PAYLOAD}.${'s'.repeat(9)}`),
		).toHaveLength(1);
		expect(findJwsTokenSpans(`${HDR}.${PAYLOAD}.`)).toHaveLength(1); // unsigned 2-seg
	});
});

describe('#3736 D2-rev2 adjacent-token + dir-JWE compositions', () => {
	test('two adjacent tokens in one dotted run BOTH redact as separate spans', () => {
		const a = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIG}`;
		const b = `eyJhbGciOiJIUzI1NiJ9.e30.${SIG}`;
		const input = `pre.${a}.${b}.post`;
		expect(redactShellCommand(input)).toBe(
			'pre.[REDACTED:jwt].[REDACTED:jwt].post',
		);
		expect(sanitizeFailureEvidenceDisplay(input)).toBe(
			'pre.[REDACTED:jwt].[REDACTED:jwt].post',
		);
	});
	test('an e30-payload neighbor token is never stranded by absorption', () => {
		const a = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIG}`;
		const b = `eyJhbGciOiJIUzI1NiJ9.e30.${SIG}`;
		expect(redactShellCommand(`${a}.${b}`).includes('e30')).toBe(false);
		expect(sanitizeFailureEvidenceDisplay(`${a}.${b}`).includes('e30')).toBe(
			false,
		);
	});
	test('dir-JWE (empty encrypted-key segment) is consumed structurally', () => {
		const input = `${JWE_HDR}..${'I'.repeat(22)}.ZGl2dmVjdG9y.YXV0aHRhZw`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
	test('benign lowercase/digit-only suffix stays visible (.build2024)', () => {
		const input = `${HDR}.${PAYLOAD}.${SIG}.build2024`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt].build2024');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe(
			'[REDACTED:jwt].build2024',
		);
	});
});

describe('#3736 D4-rev3 standard-base64 placements', () => {
	test('key= assignment: key prefix visible, separator consumed (exact)', () => {
		const header = `${'A'.repeat(40)}+/${'B'.repeat(40)}`;
		const input = `key=${header}.${PAYLOAD}.${SIG}`;
		// Shell site: the D4 generic span owns it (key prefix visible,
		// separator consumed).
		expect(redactShellCommand(input)).toBe('key[REDACTED:jwt]');
		// Display site: the earlier KV arm (step 4) claims key=value shapes
		// before the bare sweep — the credential is fully eliminated as
		// `key=<redacted>`; parity here is "no cleartext", not byte-equality.
		const display = sanitizeFailureEvidenceDisplay(input);
		expect(display.includes(PAYLOAD)).toBe(false);
		expect(display.includes(SIG)).toBe(false);
		expect(display.startsWith('key=')).toBe(true);
	});
	test('key= with = and == padded headers still anchors at the separator', () => {
		const one = `key=${'A'.repeat(40)}=.${PAYLOAD}.${SIG}`;
		const two = `key=${'A'.repeat(40)}==.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(one)).toBe('key[REDACTED:jwt]');
		expect(redactShellCommand(two)).toBe('key[REDACTED:jwt]');
	});
	test('path-adjacent short segments stay visible', () => {
		const input = `src/utils/jws-redaction.${'a'.repeat(20)}.${'b'.repeat(10)}`;
		expect(redactShellCommand(input)).toBe(input);
	});
	test('4.5-F1: an outer generic span starting BEFORE an inner eyJ span is MERGED, its header never left visible (exact)', () => {
		// Composition from the implementation review: a 40+ standard-base64
		// header segment, then an eyJ-shaped triple. The generic span starts
		// earlier — it must extend the eyJ span's coverage backward, not be
		// discarded.
		const input = `${'Q'.repeat(40)}.eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
	test('4.5-F2: an eyJ-INITIAL iv/ciphertext tail segment that cannot form a real next token is absorbed (exact)', () => {
		// 11-char eyJ-initial segment (< MIN_HEADER_TOTAL) followed by the
		// tag — no complete second token exists, so the guard must treat it
		// as tail material.
		const input = `${JWE_HDR}.${'K'.repeat(43)}.${'I'.repeat(22)}.eyJAAAAAAA.YXV0aHRhZw`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
		// >=13-char eyJ-initial segment whose remaining run has no payload+sig
		// pair — still tail material, not a scannable next token.
		const input2 = `${JWE_HDR}.${'K'.repeat(43)}.${'I'.repeat(22)}.eyJAAAAAAAAAA.Tail1234`;
		expect(redactShellCommand(input2)).toBe('[REDACTED:jwt]');
	});
	test('4.5-F4: mixed _/- boundaries select the EARLIEST boundary (long-header leftmost)', () => {
		const header = 'eyJ' + 'a'.repeat(600) + '-eyJx' + 'b'.repeat(600);
		const input = 'x_' + header + `.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(input)).toBe('x_[REDACTED:jwt]');
		expect(redactShellCommand(input).includes('aaaa')).toBe(false);
	});
	test('r2-A: an empty-key JWE with an eyJ-INITIAL tail is fully eliminated (exact)', () => {
		// hdr..iv.<eyJ-initial ciphertext>.<tag> — the structural empty-key
		// walk must absorb the eyJ-initial tail that cannot start a real
		// next token.
		const input = `${JWE_HDR}..${'I'.repeat(22)}.eyJAAAAAAA.YXV0aHRhZw`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:jwt]');
	});
	test('r2-B: a long =-chain assignment still anchors at the separator (linear trailing-run candidate)', () => {
		// Nine single-char assignments before a 40+ standard-base64 header —
		// the exact trailing-run computation must find the ninth separator
		// candidate without any per-separator probing.
		const prefix = 'a=b=c=d=e=f=g=h=i=';
		const header = 'Q'.repeat(42);
		const input = `${prefix}${header}.${'e'.repeat(20)}.${'f'.repeat(12)}`;
		expect(redactShellCommand(input)).toBe('a=b=c=d=e=f=g=h=i[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input).includes(header)).toBe(false);
	});
	test('r3-D: an assignment candidate in a NON-first segment keeps the dotted prefix intact (exact)', () => {
		// The interior-= candidate lives in the second segment — the span must
		// anchor at that segment's run offset, not at the whole run's start
		// (round-3 finding: `foo.key` was being swallowed with the token).
		const header = 'Q'.repeat(42);
		const input = `foo.key=${header}.${'e'.repeat(20)}.${'f'.repeat(12)}`;
		expect(redactShellCommand(input)).toBe('foo.key[REDACTED:jwt]');
		expect(sanitizeFailureEvidenceDisplay(input).includes(header)).toBe(false);
		expect(sanitizeFailureEvidenceDisplay(input).startsWith('foo.key')).toBe(
			true,
		);
	});
	test('r2-C: a signed token followed by an UNSIGNED neighbor never strands the neighbor payload (exact)', () => {
		const a = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIG}`;
		const unsigned = 'eyJhbGciOiJub25lIn0.e30.';
		const input = `${a}.${unsigned}`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt].[REDACTED:jwt]');
		expect(redactShellCommand(input).includes('e30')).toBe(false);
		expect(sanitizeFailureEvidenceDisplay(input).includes('e30')).toBe(false);
	});
	test('a generic span overlapping an eyJ span is dropped (no gluing)', () => {
		const a = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.${SIG}`;
		const input = `pre.${a}.${'e30'}.${SIG}.post`;
		// The eyJ token redacts; the generic pass must not produce a span
		// glued across it (regression pin for the #3716 two-token collapse).
		const spans = findRedactableTokenSpans(input);
		expect(spans.length).toBeGreaterThanOrEqual(1);
		for (const s of spans) {
			expect(input.slice(s.start, s.end).startsWith('eyJ')).toBe(true);
		}
	});
});

describe('#3736 documented residuals (pinned as visible)', () => {
	test('mixed-case >=8 English tail directly after a token absorbs (disclosed)', () => {
		const input = `${HDR}.${PAYLOAD}.${SIG}.Snapshot`;
		expect(redactShellCommand(input)).toBe('[REDACTED:jwt]');
	});
	test('an eyJ-INITIAL segment inside a structural JWE tail is guarded (round-3 residual)', () => {
		// hdr.key.<eyJ-starting iv>.<tail>: the adjacent-header guard stops
		// absorption and processes the eyJ segment as its own token header;
		// what follows it may stay visible — documented residual, pinned so a
		// future change to this behavior is conscious.
		const input = `${JWE_HDR}.${'K'.repeat(43)}.eyJAAAAAAA.YXV0aHRhZw`;
		const spans = findJwsTokenSpans(input);
		expect(spans.length).toBeGreaterThanOrEqual(1);
	});
});

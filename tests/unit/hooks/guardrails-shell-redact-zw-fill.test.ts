/**
 * #3730 (AC1, class DISCRIMINATING): a Cf/DI invisible byte (e.g. U+200B
 * ZERO WIDTH SPACE) inside ANY bare credential token must NOT split the
 * token past redaction at the shell-audit site (`redactShellCommand`) — the
 * shell mirror must apply the same condensed-view UNION semantics the
 * display site (`sanitizeFailureEvidenceDisplay`) already applies.
 *
 * RED at base c12cd853d (2026-11-17): the shell site runs the JWS pre-pass
 * (`redactJwsTokens`) and the sequential bare-token `.replace` chain on the
 * RAW text only — the run classes exclude Cf, so a zero-width byte inside a
 * token leaves every arm either under-length or without its `\b` anchor and
 * the token's tail survives in cleartext. Every family leg below was
 * probe-verified at base: the display site redacts each one with the family
 * placeholder while the shell site emits cleartext. GREEN after the fix
 * adds the shell-site fill-tolerance pass.
 *
 * Display-site parity notes pinned by the base probe (the implementer must
 * match these semantics, not invent new ones):
 *   - The condensed pass deletes Cf/DI only from the MATCHING view; mapped-
 *     back spans INCLUDE the invisible bytes that sat inside them. The
 *     display site's separate control-char strip (step 7) later turns a
 *     benign U+200B into a SPACE in its own OUTPUT ('hello\u200Bworld' ->
 *     'hello world'); the shell site has NO strip step, so its OUTPUT for
 *     benign zero-width text must stay byte-identical (pinned below).
 *   - An invisible byte BEFORE a token head ('x_\u200BeyJ…') keeps the
 *     uncondensed `\b` anchor and redacts at BOTH sites today; the union
 *     must not regress that head-dominance behavior (pinned below).
 *
 * No new seam required — `redactShellCommand` is a pure function.
 */
import { describe, expect, test } from 'bun:test';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

const ZW = '\u200B'; // Cf + Default_Ignorable — the issue's split byte
const SHY = '\u00AD'; // SOFT HYPHEN — Cf but a different code point class branch

const JWT_HEADER = 'eyJhbGciOiJIUzI1NiJ9';
const JWT_PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0';
const JWT_SIGNATURE = 'c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA';

describe('#3730 AC1: zero-width fill inside bare tokens is eliminated at the shell site (redactShellCommand)', () => {
	test('anthropic sk-ant- token with U+200B mid-body redacts fully', () => {
		// Base behavior: the sk-ant- arm stops at the ZW and the whole token
		// survives in cleartext at the shell site (display emits
		// [REDACTED:anthropic] on the identical input).
		const out = redactShellCommand(
			`rotate sk-ant-api03-abcdef${ZW}ghijklmnopqrstuv012345 now`,
		);
		expect(out).not.toContain('ghijklmnopqrstuv012345');
		expect(out).toContain('[REDACTED:anthropic]');
	});

	test('openai sk- token with U+200B mid-body redacts fully', () => {
		const out = redactShellCommand(
			`rotate sk-abcdefghij${ZW}0123456789klmnopqrst now`,
		);
		expect(out).not.toContain('0123456789klmnopqrst');
		expect(out).toContain('[REDACTED:openai]');
	});

	test('openai sk- token with U+00AD SOFT HYPHEN (Cf) mid-body redacts fully', () => {
		// A second Cf code point pins that the tolerance is class-based
		// (Cf/DI), not a U+200B literal special case.
		const out = redactShellCommand(
			`rotate sk-abcdefghij${SHY}0123456789klmnopqrst now`,
		);
		expect(out).not.toContain('0123456789klmnopqrst');
		expect(out).toContain('[REDACTED:openai]');
	});

	test('github ghp_ token with U+200B right after the prefix redacts fully', () => {
		const out = redactShellCommand(
			`push failed for ghp_${ZW}abcdefghij0123456789klmnopqrst end`,
		);
		expect(out).not.toContain('abcdefghij0123456789klmnopqrst');
		expect(out).toContain('[REDACTED:github]');
	});

	test('github ghp_ token with U+200B near the tail redacts fully', () => {
		const out = redactShellCommand(
			`push failed for ghp_abcdefghij01234567${ZW}8901klmnopqrstuv end`,
		);
		// Both split halves of the secret must be gone: the 22-char head
		// fragment and the 16-char tail fragment.
		expect(out).not.toContain('ghp_abcdefghij01234567');
		expect(out).not.toContain('8901klmnopqrstuv');
		expect(out).toContain('[REDACTED:github]');
	});

	test('slack xoxb- token with U+200B mid-body redacts fully', () => {
		const out = redactShellCommand(
			`notify slack with xoxb-12345${ZW}67890abcdefghijklmnopqrst`,
		);
		expect(out).not.toContain('67890abcdefghijklmnopqrst');
		expect(out).toContain('[REDACTED:slack]');
	});

	test('aws AKIA key with U+200B inside the body redacts fully', () => {
		const out = redactShellCommand(
			`the account AKIA${ZW}IOSFODNN7EXAMPLE is not authorized`,
		);
		// The AWS body is exactly 16 chars by the arm's own shape, so the
		// longest possible secret fragment is 'IOSFODNN7EXAMPLE' — asserting
		// the full body (not the whole fixture) is the strongest pin here.
		expect(out).not.toContain('IOSFODNN7EXAMPLE');
		expect(out).toContain('[REDACTED:aws]');
	});

	test('aws AKIA key with U+200B near the tail redacts fully', () => {
		const out = redactShellCommand(
			`the account AKIAIOSFODNN7EXA${ZW}MPLE is not authorized`,
		);
		expect(out).not.toContain('AKIAIOSFODNN7EXA');
		expect(out).toContain('[REDACTED:aws]');
	});

	test('jwt three-segment token with U+200B inside the signature redacts fully', () => {
		const out = redactShellCommand(
			`${JWT_HEADER}.${JWT_PAYLOAD}.c2ln${ZW}bmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA`,
		);
		expect(out).not.toContain(JWT_PAYLOAD);
		expect(out).not.toContain('bmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA');
		expect(out).toContain('[REDACTED:jwt]');
	});

	test('jwt three-segment token with U+200B inside the payload redacts fully', () => {
		const out = redactShellCommand(
			`${JWT_HEADER}.eyJzdWIiOiIxMjM0${ZW}NTY3ODkwIn0.${JWT_SIGNATURE}`,
		);
		expect(out).not.toContain('NTY3ODkwIn0');
		expect(out).not.toContain(JWT_SIGNATURE);
		expect(out).toContain('[REDACTED:jwt]');
	});

	test("#3730 probe shape verbatim: long-header JWS split by U+200B collapses to the display site's exact output", () => {
		// The issue's executed probe: the shell site returned the token
		// cleartext while the display site returned exactly
		// 'failed: [REDACTED:jwt]'. Parity is the contract — pin the exact
		// string, not just elimination.
		const input = `failed: eyJ${'h'.repeat(700)}${ZW}${'h'.repeat(800)}.cGF5bG9hZA.${'s'.repeat(40)}`;
		const out = redactShellCommand(input);
		expect(out).toBe('failed: [REDACTED:jwt]');
	});
});

describe('#3730 boundary compositions (already covered at both sites — must not regress)', () => {
	test('U+200B between an x_ prefix and the eyJ header keeps the token redacted', () => {
		// The invisible byte is itself the \b boundary provider here (it sits
		// before 'eyJ'), so the UNcondensed pass must keep head behavior —
		// base shell output is 'x_\u200B[REDACTED:jwt]'. A condensed-only
		// sweep would glue 'x_' to 'eyJ' and regress this to cleartext.
		const out = redactShellCommand(
			`x_${ZW}${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIGNATURE}`,
		);
		expect(out).toContain('[REDACTED:jwt]');
		expect(out).not.toContain(JWT_PAYLOAD);
		expect(out).not.toContain(JWT_SIGNATURE);
	});
});

describe('#3730 AC2 guard: benign zero-width text is not over-redacted at the shell site', () => {
	test('plain prose containing U+200B passes through byte-identical', () => {
		// Parity note (base probe): the DISPLAY site's control-char strip
		// turns this into 'hello world' in its own output; the shell site has
		// no strip step and must keep the invisible byte and both visible
		// words untouched. Deleting Cf bytes from the shell OUTPUT is NOT
		// sanctioned — only the matching view may be condensed.
		const input = `hello${ZW}world`;
		const out = redactShellCommand(input);
		expect(out).toBe(input);
		expect(out).not.toContain('[REDACTED');
	});

	test('a benign dotted path containing U+200B passes through byte-identical', () => {
		const input = `src.${ZW}utils/jws-redaction.ts`;
		const out = redactShellCommand(input);
		expect(out).toBe(input);
		expect(out).not.toContain('[REDACTED');
	});
});

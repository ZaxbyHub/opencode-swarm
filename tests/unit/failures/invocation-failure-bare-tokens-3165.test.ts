import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { readProviderMessageError } from '../../../src/failures/provider-message-error';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/**
 * #3165 F-1: bare well-known provider tokens are redacted wherever they
 * appear — prose placements with no adjacent key[:=]value span (the KV arms
 * cannot match those). RED at base (all leak samples shipped in cleartext),
 * GREEN after the BARE_TOKEN_VALUE_PATTERNS arm. The corpus mirrors the six
 * content-based shapes of src/hooks/guardrails/helpers.ts; the MIRROR PARITY
 * test pins both redactors against the same corpus (elimination + family
 * placeholders, NOT whole-string equality — the URL and display-bounding
 * policies legitimately differ between the two redactors).
 */

interface Sample {
	id: string;
	input: string;
	needle: string;
	family: string;
}

const CORPUS: Sample[] = [
	{
		id: 'openai-real-error',
		input:
			'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx. You can find your API key at https://platform.openai.com/account/api-keys.',
		needle: 'sk-proj-abcdefghijklmnopqrstuvwx',
		family: 'openai',
	},
	{
		id: 'openai-prose',
		input: 'rotate the expired key sk-abcdefghij0123456789klm now',
		needle: 'sk-abcdefghij0123456789klm',
		family: 'openai',
	},
	{
		id: 'github-pat',
		input: 'push failed for ghp_abcdefghij0123456789abcdefghij',
		needle: 'ghp_abcdefghij0123456789abcdefghij',
		family: 'github',
	},
	{
		id: 'github-fine-grained',
		input: 'auth header carried github_pat_abcdefghij0123456789AB',
		needle: 'github_pat_abcdefghij0123456789AB',
		family: 'github',
	},
	{
		id: 'aws-mid-sentence',
		input: 'the account AKIAIOSFODNN7EXAMPLE is not authorized',
		needle: 'AKIAIOSFODNN7EXAMPLE',
		family: 'aws',
	},
	{
		// Overlap geometry (closeout critic R1x): the slack body class has
		// no underscore, so the slack match stops at the underscore while the
		// inner ghp_ match starts inside it and ends later. Selection must
		// EXTEND the earlier span (keep last.start/family), not replace it —
		// a replace uncovered the slack prefix where head AND the mirror
		// redact both. The display emits the slack placeholder; the mirror
		// emits slack+github (both parity loops hold).
		id: 'overlap-xox-ghp',
		input: 'xoxb-abcdefghij-ghp_abcdefghij0123456789ABCD end',
		needle: 'ghp_abcdefghij0123456789ABCD',
		family: 'slack',
	},
	{
		id: 'overlap-xox-github-pat',
		input: 'xoxb-abcdefghij-github_pat_abcdefghij0123456789ABCD end',
		needle: 'github_pat_abcdefghij0123456789ABCD',
		family: 'slack',
	},
	{
		id: 'slack-bot',
		input: 'notify slack with xoxb-1234567890abcdefGHIJ',
		needle: 'xoxb-1234567890abcdefGHIJ',
		family: 'slack',
	},
	{
		// Closeout-critic probe: the invisible byte PROVIDES the \b anchor;
		// deleting it (the condensed view) glues word-char neighbours and
		// kills the leading boundary — this row proves the UNcondensed pass
		// keeps head-dominance (redacted at head; condensed-only sweeps
		// regress it to full cleartext).
		id: 'boundary-provider-left',
		input: 'axis\u200Bsk-abcdefghij0123456789klm now',
		needle: 'sk-abcdefghij0123456789klm',
		family: 'openai',
	},
	{
		// Mirror image: the invisible byte provides the AKIA arm's TRAILING
		// \b; the condensed view glues 'EXAMPLE' to 'now' and kills the
		// anchor. Head-dominance pass keeps it redacted.
		id: 'boundary-provider-right',
		input: 'rotate AKIAIOSFODNN7EXAMPLE\u200Bnow',
		needle: 'AKIAIOSFODNN7EXAMPLE',
		family: 'aws',
	},
	{
		id: 'google-api',
		input: 'quota exceeded on AIzaSyA1234567890abcdefghijklmnopqrstuv',
		needle: 'AIzaSyA1234567890abcdefghijklmnopqrstuv',
		family: 'google',
	},
];

describe('sanitizeFailureEvidenceDisplay bare-token redaction (#3165 F-1)', () => {
	for (const sample of CORPUS) {
		test(`redacts bare ${sample.id} token in prose`, () => {
			const out = sanitizeFailureEvidenceDisplay(sample.input);
			expect(out.includes(sample.needle)).toBe(false);
			expect(out).toContain(`[REDACTED:${sample.family}]`);
		});
	}

	test('redacts multiple tokens in one input', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'keys sk-abcdefghij0123456789klm and ghp_abcdefghij0123456789wxyz both expired',
		);
		expect(out).toContain('[REDACTED:openai]');
		expect(out).toContain('[REDACTED:github]');
		expect(out.includes('sk-abcdefghij0123456789klm')).toBe(false);
		expect(out.includes('ghp_abcdefghij0123456789wxyz')).toBe(false);
	});

	test('redaction survives adjacent punctuation', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'(see ghp_abcdefghij0123456789qrst).',
		);
		expect(out.includes('ghp_abcdefghij0123456789qrst')).toBe(false);
		expect(out).toContain('[REDACTED:github]');
	});

	test('near-miss shapes stay visible (no over-redaction)', () => {
		// "skateboard" contains "sk" but is not a token shape.
		expect(sanitizeFailureEvidenceDisplay('the skateboard trick')).toBe(
			'the skateboard trick',
		);
		// A 15-char sk- fragment is below the 20-char token bound.
		const short = 'sk-abc123def456';
		const out = sanitizeFailureEvidenceDisplay(`fragment ${short} stays`);
		expect(out).toContain(short);
		// Plain prose words stay verbatim.
		expect(sanitizeFailureEvidenceDisplay('token count exceeded')).toBe(
			'token count exceeded',
		);
	});

	test('boundary: near-miss token at input end stays visible', () => {
		// 19 chars — AKIA + 15 chars is NOT the AWS 16-char body shape, and
		// no credential morpheme word precedes it, so no arm fires.
		// Documented bound: the value shapes are exact-family, not fuzzy.
		const out = sanitizeFailureEvidenceDisplay(
			'truncated tail AKIAIOSFODNN7EXAMPL',
		);
		expect(out.includes('AKIAIOSFODNN7EXAMPL')).toBe(true);
	});
});

describe('zero-width fill inside bare tokens is consumed (#3165 F-1 / PR #3705 feedback)', () => {
	// PR #3705 review round 2: the bare arm has no pattern-level fill
	// tolerance, so the display redactor sweeps a Cf/DI-deletion condensed
	// view UNIONED with the uncondensed matches — an invisible byte can no
	// longer split a token past the arm byte-alone (previously a 30-char
	// tail stayed in cleartext), and when the byte was itself the \b
	// boundary provider the uncondensed pass keeps head behavior. The one
	// compound residual (inside-body fill + a word-char follower defeating
	// the trailing \b on both views) is disclosed in the source's
	// fill-posture note. Visible fill (whitespace/Cc) inside a bare token
	// remains the documented residual; the last row pins that boundary as
	// intended behavior, not an oversight.
	test('U+200B inside an sk- token redacts fully', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'rotate key sk-\u200Babcdefghij0123456789klm now',
		);
		expect(out.includes('abcdefghij0123456789klm')).toBe(false);
		expect(out).toContain('[REDACTED:openai]');
	});

	test('variation selector VS16 (U+FE0F) inside a github_pat_ token redacts fully', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'github_pat_\uFE0Fabcdefghij0123456789AB',
		);
		expect(out.includes('abcdefghij0123456789AB')).toBe(false);
		expect(out).toContain('[REDACTED:github]');
	});

	test('Hangul filler (DI) inside an AKIA body redacts fully', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'the account AKIA\u1160IOSFODNN7EXAMPLE is not authorized',
		);
		expect(out.includes('IOSFODNN7EXAMPLE')).toBe(false);
		expect(out).toContain('[REDACTED:aws]');
	});

	test('Cc split inside a bare token stays the documented residual (not tolerated)', () => {
		// Visible fill is NOT deleted: removing it could merge or reorder
		// what the reader sees (#2363). This row pins the boundary — a
		// \u0001-split token intentionally stays cleartext-by-design.
		const out = sanitizeFailureEvidenceDisplay(
			'rotate key sk-\u0001abcdefghij0123456789klm now',
		);
		expect(out).not.toContain('[REDACTED:');
	});

	test('a Cf-only (not Default_Ignorable) fill byte inside a token redacts fully', () => {
		// U+070F (Syriac abbreviation mark) is Cf but NOT Default_Ignorable —
		// this row pins the \p{Cf} alternation branch (a DI-only mutant
		// survives the U+200B row because U+200B belongs to both classes).
		const out = sanitizeFailureEvidenceDisplay(
			'rotate key sk-\u070Fabcdefghij0123456789klm now',
		);
		expect(out.includes('abcdefghij0123456789klm')).toBe(false);
		expect(out).toContain('[REDACTED:openai]');
	});

	test('an astral code point before a token does not shift the mapped span', () => {
		// Stage-B round: the condensed map is CODE-UNIT indexed; a kept
		// astral character before a match previously misaligned the span
		// (prefix 's' leaked, trailing space eaten).
		const out = sanitizeFailureEvidenceDisplay(
			'🎉 rotate key sk-abcdefghij0123456789klm now',
		);
		expect(out.includes('sk-abcdefghij0123456789klm')).toBe(false);
		expect(out).toContain('[REDACTED:openai]');
	});

	test('a token ending at input end after an astral code point redacts without cleartext append', () => {
		// Stage-B round regression pin: with a code-point-indexed map the
		// end offset went past the array (NaN end -> slice(NaN)) and the
		// WHOLE cleartext string was appended after the placeholder.
		const out = sanitizeFailureEvidenceDisplay('🎉 sk-abcdefghij0123456789klm');
		expect(out.includes('sk-abcdefghij0123456789klm')).toBe(false);
		expect(out).toBe('🎉 [REDACTED:openai]');
	});
});

describe('production seam: readProviderMessageError surfaces redacted evidence (#3165 F-1)', () => {
	test('a provider error carrying a bare token is redacted through the shared reader', () => {
		const read = readProviderMessageError({
			error: {
				name: 'InvalidApiKey',
				data: {
					message:
						'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx. You can find your API key at https://platform.openai.com/account/api-keys.',
					statusCode: 401,
				},
			},
		});
		expect(read).not.toBeNull();
		expect(read?.message.includes('sk-proj-abcdefghijklmnopqrstuvwx')).toBe(
			false,
		);
		expect(read?.message).toContain('[REDACTED:openai]');
		expect(read?.statusCode).toBe(401);
	});

	test('a Cf-split bare token inside a provider error is redacted through the shared reader', () => {
		const read = readProviderMessageError({
			error: {
				name: 'InvalidApiKey',
				data: {
					message:
						'Incorrect API key provided: sk-proj-abcdefghij\u200Bklmnopqrstuvwx. Retry with a valid key.',
					statusCode: 401,
				},
			},
		});
		expect(read).not.toBeNull();
		expect(
			read?.message.includes('sk-proj-abcdefghij\u200Bklmnopqrstuvwx'),
		).toBe(false);
		expect(read?.message).not.toContain('klmnopqrstuvwx');
		expect(read?.message).toContain('[REDACTED:openai]');
	});
});

describe('mirror parity: display redactor vs redactShellCommand (#3165 F-1)', () => {
	// Parity is on ELIMINATION (token body absent) and family placeholders —
	// not whole-string equality: redactShellCommand minimizes URL credentials
	// and home paths differently, and sanitizeFailureEvidenceDisplay applies
	// display bounding. Both redactors must mask the same token corpus.
	for (const sample of CORPUS) {
		test(`both redactors eliminate ${sample.id}`, () => {
			const display = sanitizeFailureEvidenceDisplay(sample.input);
			const shell = redactShellCommand(sample.input);
			expect(display.includes(sample.needle)).toBe(false);
			expect(shell.includes(sample.needle)).toBe(false);
		});
		test(`both redactors emit the ${sample.family} family placeholder for ${sample.id}`, () => {
			// Plan-critic r4: assert the family placeholder at BOTH sites, not
			// just elimination — the mirror cannot drift to a silent generic.
			const display = sanitizeFailureEvidenceDisplay(sample.input);
			const shell = redactShellCommand(sample.input);
			expect(display).toContain(`[REDACTED:${sample.family}]`);
			expect(shell).toContain(`[REDACTED:${sample.family}]`);
		});
	}
});

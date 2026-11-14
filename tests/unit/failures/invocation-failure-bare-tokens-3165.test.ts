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
		id: 'slack-bot',
		input: 'notify slack with xoxb-1234567890abcdefGHIJ',
		needle: 'xoxb-1234567890abcdefGHIJ',
		family: 'slack',
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
		// 23 chars — AKIA + 19 chars is NOT the AWS 16-char body shape, and no
		// credential morpheme word precedes it, so no arm fires. Documented
		// bound: the value shapes are exact-family, not fuzzy.
		const out = sanitizeFailureEvidenceDisplay(
			'truncated tail AKIAIOSFODNN7EXAMPL',
		);
		expect(out.includes('AKIAIOSFODNN7EXAMPL')).toBe(true);
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
	}
});

import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/**
 * #3710 D3/D4 — newly added redaction families, pinned at BOTH redactor
 * sites (the display sweep `sanitizeFailureEvidenceDisplay` in
 * src/failures/invocation-failure.ts and the shell mirror
 * `redactShellCommand` in src/hooks/guardrails/helpers.ts) against the same
 * corpus, mirroring the structure of
 * tests/unit/failures/invocation-failure-bare-tokens-3165.test.ts: prose
 * elimination, family placeholders, a multi-token row, and mirror-parity
 * loops (elimination + per-family placeholder at both sites — NOT
 * whole-string equality, since the two redactors legitimately differ on URL
 * and bounding policy).
 *
 * Families added by #3710: gsk_ (groq), GOCSPX-/ya29. (google), eyJ… (jwt),
 * sk-ant-api03-… (anthropic), sk-or-v1-… (openrouter), azure CONTEXTUAL
 * forms (AccountKey= connection-string material — bare 32-hex azure keys are
 * deliberately NOT patterned; hex digests must stay visible, pinned by
 * tests/unit/failures/display-base64-arm-3710.test.ts), and the >=80-char
 * mixed-class base64 arm at the DISPLAY site (the shell site already has
 * it).
 *
 * RED at base (groq/GOCSPX/ya29./JWT/base64-at-display shipped in cleartext;
 * sk-ant-/sk-or- resolved to the WRONG [REDACTED:openai] placeholder; azure
 * AccountKey material survived in cleartext at the shell site and as a
 * generic <redacted> with no azure family placeholder at the display site);
 * GREEN after the fix. Every token body below is synthetic.
 */

interface Sample {
	id: string;
	input: string;
	needle: string;
	family: string;
}

const LONG_MIXED_BASE64 = 'Ab1Cd2Ef3'.repeat(10);

const CORPUS: Sample[] = [
	{
		id: 'groq-gsk-prose',
		input:
			'quota exceeded for gsk_SynthQ7xK2mB4vNc9pRtW6yU3iO1aS5dF8gH0jLz, rotate now',
		needle: 'gsk_SynthQ7xK2mB4vNc9pRtW6yU3iO1aS5dF8gH0jLz',
		family: 'groq',
	},
	{
		id: 'google-oauth-gocspx',
		input:
			'oauth refresh failed for GOCSPX-synth0123456789QaZwSxEdCrVfTgBhN87654321',
		needle: 'GOCSPX-synth0123456789QaZwSxEdCrVfTgBhN87654321',
		family: 'google',
	},
	{
		id: 'google-ya29',
		input:
			'google auth ya29.a0SyntheticQ1wE2rT3yU4iO5pA6sD7fG8hJ9kL0zX expired',
		needle: 'ya29.a0SyntheticQ1wE2rT3yU4iO5pA6sD7fG8hJ9kL0zX',
		family: 'google',
	},
	{
		id: 'jwt-three-segment',
		input:
			'session rejected: eyJTh7xQm9Zb4Vc1NkS2wLp8RtY6uJ3hF5dA0gE9.eyJWq2Xr7Mz4NbVc1LsK0pT8YhU6jG3fD5aS2eH1oIw.Sk9PxQvT3wZr5mN7bC1dX2gH4jL6nK8pQ expired',
		needle:
			'eyJTh7xQm9Zb4Vc1NkS2wLp8RtY6uJ3hF5dA0gE9.eyJWq2Xr7Mz4NbVc1LsK0pT8YhU6jG3fD5aS2eH1oIw.Sk9PxQvT3wZr5mN7bC1dX2gH4jL6nK8pQ',
		family: 'jwt',
	},
	{
		// D4: at base this resolved to [REDACTED:openai]; after the fix the
		// anthropic family must win at BOTH sites (ordering pinned separately
		// in redaction-family-order-3710.test.ts).
		id: 'anthropic-sk-ant-api03',
		input:
			'key sk-ant-api03-synthAA11bb22cc33dd44ee55ff66gg77hh88ii99 rejected',
		needle: 'sk-ant-api03-synthAA11bb22cc33dd44ee55ff66gg77hh88ii99',
		family: 'anthropic',
	},
	{
		id: 'openrouter-sk-or-v1',
		input:
			'key sk-or-v1-synth0102030405060708090a0b0c0d0e0f1011121314 rejected',
		needle: 'sk-or-v1-synth0102030405060708090a0b0c0d0e0f1011121314',
		family: 'openrouter',
	},
	{
		// Azure CONTEXTUAL form: connection-string AccountKey= material. The
		// bare-32-hex azure key shape is deliberately NOT patterned
		// (indistinguishable from hex digests) — only the contextual form is.
		id: 'azure-account-key-contextual',
		input:
			'connect DefaultEndpointsProtocol=https;AccountName=synthstore42;AccountKey=c3luTHNvbWVLZXlWYWx1ZTEyMzQ1Njc4OWFiY2RlZg==;EndpointSuffix=core.windows.net failed',
		needle: 'c3luTHNvbWVLZXlWYWx1ZTEyMzQ1Njc4OWFiY2RlZg==',
		family: 'azure',
	},
	{
		// 90 chars, mixed case + digits: redacted by the shell arm at base;
		// the DISPLAY site lacks the arm at base (cleartext) — this row plus
		// the mirror loop pin the display-side gap.
		id: 'base64-wrapped-payload',
		input: `payload ${LONG_MIXED_BASE64} rejected`,
		needle: LONG_MIXED_BASE64,
		family: 'base64',
	},
];

describe('sanitizeFailureEvidenceDisplay new-family redaction (#3710)', () => {
	for (const sample of CORPUS) {
		test(`redacts bare ${sample.id} token in prose`, () => {
			const out = sanitizeFailureEvidenceDisplay(sample.input);
			expect(out.includes(sample.needle)).toBe(false);
			expect(out).toContain(`[REDACTED:${sample.family}]`);
		});
	}

	test('redacts multiple new-family tokens in one input', () => {
		const out = sanitizeFailureEvidenceDisplay(
			'keys gsk_SynthQ7xK2mB4vNc9pRtW6yU3iO1aS5dF8gH0jLz and GOCSPX-synth0123456789QaZwSxEdCrVfTgBhN87654321 and sk-ant-api03-synthAA11bb22cc33dd44ee55ff66gg77hh88ii99 expired',
		);
		expect(out).toContain('[REDACTED:groq]');
		expect(out).toContain('[REDACTED:google]');
		expect(out).toContain('[REDACTED:anthropic]');
		expect(out.includes('gsk_SynthQ7xK2mB4vNc9pRtW6yU3iO1aS5dF8gH0jLz')).toBe(
			false,
		);
		expect(
			out.includes('GOCSPX-synth0123456789QaZwSxEdCrVfTgBhN87654321'),
		).toBe(false);
		expect(
			out.includes('sk-ant-api03-synthAA11bb22cc33dd44ee55ff66gg77hh88ii99'),
		).toBe(false);
	});
});

describe('mirror parity: display redactor vs redactShellCommand (#3710)', () => {
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
			const display = sanitizeFailureEvidenceDisplay(sample.input);
			const shell = redactShellCommand(sample.input);
			expect(display).toContain(`[REDACTED:${sample.family}]`);
			expect(shell).toContain(`[REDACTED:${sample.family}]`);
		});
	}
});

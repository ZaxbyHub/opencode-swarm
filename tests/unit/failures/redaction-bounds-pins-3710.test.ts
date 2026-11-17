import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/**
 * #3710/#3712 review-round pins (implementation-review round 1).
 *
 * Two contracts that the frozen suites imply but did not discriminate:
 *
 * 1. DISPLAY-SITE BASE64 GUARD (mutation probe M-C6 survived the frozen C6
 *    suite): the frozen near-miss controls are all sub-80 characters
 *    (SHA-256 = 64, git sha = 40, uppercase-hex = 78, short mixed = 42), so
 *    the length bound alone kept them visible and disabling the mixed-class
 *    guard could not redden any row. These rows use ≥80-character hex-only
 *    runs so ONLY the class guard keeps them visible — the guard now bites.
 *
 * 2. HEADER-CONTEXT EXCLUSION (reviewer finding 1): credential tokens in
 *    Authorization/Bearer header placements are redacted by the PRE-EXISTING
 *    context arms (shell: the Bearer/Basic and -H header arms; display: the
 *    credential-KV arm) with their GENERIC placeholders. The per-family
 *    placeholder contract covers prose/bare placements (the frozen corpus
 *    shape); header placements carry scheme/key context, are consumed by the
 *    context arm first at BOTH sites, and byte-identically at base — an
 *    explicit, pinned exclusion, not an accidental gap. The token body never
 *    appears in cleartext in any placement.
 *
 * Synthetic tokens only.
 */

const UPPER_HEX_90 =
	'A1C3E5B7D9F0A2C4E6B8D0F2A4C6E8B0D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B0D2F4A6C8';
const LOWER_HEX_90 =
	'a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e6b0d2f4a6c8';
const MIXED_90 = 'Ab1Cd2Ef3'.repeat(10);
const SYNTH_ANTHROPIC = 'sk-ant-api03-synthAbCdEf123456789012345';

describe('display-site base64 class-guard pins (#3710 review round 1)', () => {
	test('a >=80-char uppercase-hex run stays visible at the display site (guard, not length, protects it)', () => {
		const out = sanitizeFailureEvidenceDisplay(`digest ${UPPER_HEX_90} end`);
		expect(out).toContain(UPPER_HEX_90);
		expect(out).not.toContain('[REDACTED:base64]');
	});

	test('a >=80-char lowercase-hex run stays visible at the display site', () => {
		const out = sanitizeFailureEvidenceDisplay(`digest ${LOWER_HEX_90} end`);
		expect(out).toContain(LOWER_HEX_90);
		expect(out).not.toContain('[REDACTED:base64]');
	});

	test('the >=80 mixed-class run is still redacted at the display site (control)', () => {
		const out = sanitizeFailureEvidenceDisplay(`payload ${MIXED_90} end`);
		expect(out).not.toContain(MIXED_90);
		expect(out).toContain('[REDACTED:base64]');
	});
});

describe('header-context family-label exclusion pins (#3710 review round 1)', () => {
	test('shell: Bearer header placement is redacted by the context arm with the generic placeholder — no cleartext, no family label (pre-existing at base)', () => {
		const out = redactShellCommand(
			`curl -H "Authorization: Bearer ${SYNTH_ANTHROPIC}" https://x/y`,
		);
		expect(out).not.toContain(SYNTH_ANTHROPIC);
		expect(out).toContain('Authorization: [REDACTED]');
		expect(out).not.toContain('[REDACTED:anthropic]');
	});

	test('display: Bearer header placement is redacted by the KV arm generically — no cleartext, no family label (pre-existing at base)', () => {
		const out = sanitizeFailureEvidenceDisplay(
			`auth failed: Authorization: Bearer ${SYNTH_ANTHROPIC}`,
		);
		expect(out).not.toContain(SYNTH_ANTHROPIC);
		expect(out).not.toContain('[REDACTED:anthropic]');
	});

	test('prose placement still carries the family placeholder at BOTH sites (the frozen contract)', () => {
		const prose = `key ${SYNTH_ANTHROPIC} rejected`;
		expect(sanitizeFailureEvidenceDisplay(prose)).toContain(
			'[REDACTED:anthropic]',
		);
		expect(redactShellCommand(prose)).toContain('[REDACTED:anthropic]');
	});
});

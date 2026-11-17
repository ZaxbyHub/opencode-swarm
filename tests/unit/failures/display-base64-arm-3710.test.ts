import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/**
 * #3710 D3 — the >=80-char mixed-class base64 arm at the DISPLAY site
 * (sanitizeFailureEvidenceDisplay), with near-miss controls.
 *
 * The shell mirror (redactShellCommand) already carries this arm
 * (src/hooks/guardrails/helpers.ts: long base64-like payload runs requiring
 * >=80 chars of base64 charset AND at least one uppercase, one lowercase,
 * and one digit); the display site lacks it at base. The redaction row is
 * RED at base (90-char mixed run ships in cleartext at the display site) and
 * GREEN after the fix; the named near-miss rows (hex-only SHA-256 digests,
 * short git-style shas, uppercase-hex runs with no lowercase class, and
 * sub-80 mixed runs) are PRESERVING — visible at base and they must STAY
 * visible, because bare hex digests are diagnostic evidence, not
 * credentials. The shell-parity anchor documents that the mirror already
 * redacts the long run. Synthetic payloads only.
 */

const SHA256_HEX =
	'f4a7c1e9b2d8306457a1f0e3c5b79d2846a0c3e1f7b2d9485c0a6e3f1b7d2490';
const GIT_SHA_HEX = '3f9c8e21a7b4d0e5f6a2b8c1d4e7f0a3b6c9d2e4';
const UPPER_HEX_RUN =
	'A1C3E5B7D9F0A2C4E6B8D0F2A4C6E8B0D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6';
const SHORT_MIXED_RUN = 'AbCdEf0123456789GhIjKl0123456789MnOpQrsT';
const LONG_MIXED_RUN = 'Ab1Cd2Ef3'.repeat(10);

describe('display-site base64 arm with near-miss controls (#3710 D3)', () => {
	test('sha256 hex digest stays VISIBLE at the display site (named near-miss)', () => {
		const out = sanitizeFailureEvidenceDisplay(
			`checksum sha256:${SHA256_HEX} ok`,
		);
		expect(out).toContain(SHA256_HEX);
		expect(out).not.toContain('[REDACTED:base64]');
	});

	test('git-style 40-hex sha stays VISIBLE at the display site (named near-miss)', () => {
		const out = sanitizeFailureEvidenceDisplay(`commit ${GIT_SHA_HEX} checked`);
		expect(out).toContain(GIT_SHA_HEX);
		expect(out).not.toContain('[REDACTED:base64]');
	});

	test('80+ uppercase-hex run stays VISIBLE at the display site (no lowercase class)', () => {
		const out = sanitizeFailureEvidenceDisplay(`run ${UPPER_HEX_RUN} visible`);
		expect(out).toContain(UPPER_HEX_RUN);
		expect(out).not.toContain('[REDACTED:base64]');
	});

	test('sub-80 mixed-class base64 run stays VISIBLE at the display site', () => {
		const out = sanitizeFailureEvidenceDisplay(
			`short ${SHORT_MIXED_RUN} stays`,
		);
		expect(out).toContain(SHORT_MIXED_RUN);
		expect(out).not.toContain('[REDACTED:base64]');
	});

	test('80+ char mixed-class base64 run is redacted at the display site', () => {
		const out = sanitizeFailureEvidenceDisplay(
			`payload ${LONG_MIXED_RUN} rejected`,
		);
		expect(out.includes(LONG_MIXED_RUN)).toBe(false);
		expect(out).toContain('[REDACTED:base64]');
	});

	test('shell mirror already redacts the same long run (parity anchor)', () => {
		const shell = redactShellCommand(`payload ${LONG_MIXED_RUN} rejected`);
		expect(shell.includes(LONG_MIXED_RUN)).toBe(false);
		expect(shell).toContain('[REDACTED:base64]');
	});
});

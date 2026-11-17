/**
 * #3730 sibling suite (plan v3, critic round 1): the ANY-family × invisible-
 * byte matrix for the shell audit site's condensed (fill-tolerance) union —
 * each family arm against Cf-only (U+070F), DI-only (U+1160, U+FE0F), and
 * Cf+DI (U+200B) fill at mid/near-tail positions, astral/input-end mapping
 * legs, and the glued family+JWT compositions under the decided display-union
 * semantics. The Cf-only vs DI-only pair kills a mutant that drops either
 * alternative of the fill class test.
 *
 * RED at base c12cd853d (the shell site had no condensed view; this file
 * does not exist there), GREEN after the fix.
 */
import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

const ZW = '​'; // U+200B ZERO WIDTH SPACE — Cf AND Default_Ignorable
const CF_ONLY = '܏'; // U+070F SYRIAC ABBREVIATION MARK — Cf only
const DI_ONLY_HANGUL = 'ᅠ'; // U+1160 HANGUL JUNGSEONG FILLER — DI only
const DI_ONLY_VS = '️'; // U+FE0F VARIATION SELECTOR-16 — DI only

const FAMILIES: ReadonlyArray<{ name: string; token: string; label: string }> =
	[
		{
			name: 'anthropic',
			token: `sk-ant-${'A'.repeat(24)}`,
			label: '[REDACTED:anthropic]',
		},
		{
			name: 'openai',
			token: `sk-${'A'.repeat(24)}`,
			label: '[REDACTED:openai]',
		},
		{
			name: 'github',
			token: `ghp_${'A'.repeat(30)}`,
			label: '[REDACTED:github]',
		},
		{ name: 'aws', token: `AKIA${'A'.repeat(15)}0`, label: '[REDACTED:aws]' }, // exactly 16 body chars, then the \b
		{
			name: 'slack',
			token: `xoxb-${'A'.repeat(20)}`,
			label: '[REDACTED:slack]',
		},
		{
			name: 'google',
			token: `AIza${'A'.repeat(30)}`,
			label: '[REDACTED:google]',
		},
		{ name: 'groq', token: `gsk_${'A'.repeat(24)}`, label: '[REDACTED:groq]' },
	];

const FILLERS: ReadonlyArray<{ name: string; char: string }> = [
	{ name: 'U+200B Cf+DI', char: ZW },
	{ name: 'U+070F Cf-only', char: CF_ONLY },
	{ name: 'U+1160 DI-only', char: DI_ONLY_HANGUL },
	{ name: 'U+FE0F DI-only', char: DI_ONLY_VS },
];

describe('#3730 shell condensed union — family × invisible-byte matrix', () => {
	for (const family of FAMILIES) {
		for (const filler of FILLERS) {
			test(`${family.name} split mid-token by ${filler.name} is fully eliminated at the shell site`, () => {
				const mid = family.token.length >> 1;
				const input =
					family.token.slice(0, mid) + filler.char + family.token.slice(mid);
				const out = redactShellCommand(input);
				// No 20+ char run of the secret body survives in any form
				expect(out.includes('A'.repeat(20))).toBe(false);
				expect(out.includes(family.label)).toBe(true);
			});
			test(`${family.name} split near-tail by ${filler.name} leaves no secret tail`, () => {
				const input =
					family.token.slice(0, -4) + filler.char + family.token.slice(-4);
				const out = redactShellCommand(input);
				// tail fragments may remain visible (sub-minimum), but no
				// long run of the secret body survives
				expect(out.includes('A'.repeat(20))).toBe(false);
			});
		}
	}
});

describe('#3730 mapping legs', () => {
	test('a fill byte between an astral char and a token maps correctly', () => {
		const input = `😀${ZW}sk-${'A'.repeat(24)}`;
		const out = redactShellCommand(input);
		expect(out.includes('A'.repeat(20))).toBe(false);
		expect(out.startsWith('😀')).toBe(true);
	});
	test('a token ending at input end with an inner fill byte is eliminated', () => {
		const input = `x sk-${'A'.repeat(12)}${ZW}${'B'.repeat(12)}`;
		const out = redactShellCommand(input);
		expect(out.includes('A'.repeat(10))).toBe(false);
		expect(out.includes('B'.repeat(10))).toBe(false);
	});
	test('benign text keeps its invisible bytes byte-identical at the shell site', () => {
		const input = `hello${ZW}world`;
		expect(redactShellCommand(input)).toBe(input);
	});
});

describe('#3730 glued compositions — decided display-union semantics (both sites)', () => {
	const HDR = 'eyJhbGciOiJIUzI1NiIsImtpZCI6InRlc3QifQ';
	const PAYLOAD = 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN5bnRoZXRpYyBVc2VyIn0';
	const SIG = 'c2lnbmF0dXJlLWJ5dGVzLTEyMzQ1Njc4OTA';

	test('sk-abc-<JWT>: leftmost-longest family span at BOTH sites (decided change)', () => {
		const input = `sk-abc-${HDR}.${PAYLOAD}.${SIG}`;
		expect(redactShellCommand(input)).toBe('[REDACTED:openai]');
		expect(sanitizeFailureEvidenceDisplay(input)).toBe('[REDACTED:openai]');
	});
	test('a zw-split glued composition is eliminated at both sites', () => {
		const input = `sk-${'A'.repeat(20)}${ZW}${HDR}.${PAYLOAD}.${SIG}`;
		const shell = redactShellCommand(input);
		const display = sanitizeFailureEvidenceDisplay(input);
		expect(shell.includes('A'.repeat(20))).toBe(false);
		expect(shell.includes(PAYLOAD)).toBe(false);
		expect(display.includes(PAYLOAD)).toBe(false);
	});
});

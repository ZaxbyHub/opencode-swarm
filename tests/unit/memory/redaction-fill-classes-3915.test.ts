/**
 * #3915 AC11 / F4 — the memory site's fill-class source is ONE module-level
 * constant, and the set is extended with \p{Mn} (combining marks) and U+2800
 * (the invisible Braille blank).
 *
 * Root cause (04-root-cause.md AC11): both sites defined the fill class as
 * `\p{Cf}|\p{Default_Ignorable_Code_Point}`; U+0301 (Mn) and U+2800 (Braille)
 * sat outside it, so a credential split by either survived the memory
 * scanner. The memory site additionally carried TWO copies of the class (the
 * named non-global constant for the fast paths AND a local global literal
 * inside condenseSecretView) — the unification makes extension reach both the
 * fast paths and the condensation.
 *
 * Every split leg asserts BOTH detection (containsSecret === true) AND
 * redaction (redactSecrets changed, the site placeholder present, the
 * condensed form of the SPECIFIC synthetic secret absent — fill code units
 * stripped from the output before the substring check, so the assertion tests
 * RE-LINKING, not raw byte survival). The preserving leg pins the
 * matching-only nature of the condensed view: benign combining accents must
 * survive VERBATIM in the output.
 *
 * RED at base (17ebef6c7), GREEN after F4. All tokens are synthetic; none are
 * real credentials. Fill characters are built with String.fromCharCode so no
 * invisible literal sits in source.
 */
import { describe, expect, test } from 'bun:test';
import {
	containsSecret,
	findSecrets,
	redactSecrets,
} from '../../../src/memory/redaction';

/** U+0301 COMBINING ACUTE ACCENT — an Mn mark, outside the pre-#3915 set. */
const COMBINING_ACUTE = String.fromCharCode(0x301);
/** U+2800 BRAILLE PATTERN BLANK — the invisible Braille blank. */
const BRAILLE_BLANK = String.fromCharCode(0x2800);
/** U+00E9 — precomposed e-acute, plain visible Latin-1 prose. */
const E_ACUTE = String.fromCharCode(0xe9);

/**
 * Fill code units stripped from BOTH the secret projection and the output
 * before substring checks (same methodology as the frozen check-ac11): the
 * assertion tests re-linking, not raw byte survival.
 */
const FILL = new RegExp(`[${COMBINING_ACUTE}${BRAILLE_BLANK}]`, 'gu');
const condensed = (s: string): string => s.replace(FILL, '');

/** [leg name, expected family type, split input, condensed secret] */
const SPLIT_CASES: Array<[string, string, string, string]> = [
	[
		'AKIA key split by U+0301 combining acute',
		'aws_access_key_id',
		`AKIA${COMBINING_ACUTE}ABCDEFGHIJKLMNOP`,
		'AKIAABCDEFGHIJKLMNOP',
	],
	[
		'ghp_ token split by U+2800 Braille blank',
		'github_token',
		`ghp${BRAILLE_BLANK}_${'A'.repeat(36)}`,
		`ghp_${'A'.repeat(36)}`,
	],
	// The pre-#3915 set (\p{Cf}|\p{Default_Ignorable_Code_Point}) already
	// linked ZWSP splits — keep one as a regression baseline for the unified
	// source (the F4 refactor must not regress the existing classes).
	[
		'sk- token split by U+200B ZWSP (pre-existing class baseline)',
		'openai_api_key',
		`sk-${'A'.repeat(10)}${String.fromCharCode(0x200b)}${'B'.repeat(12)}`,
		`sk-${'A'.repeat(22)}`,
	],
];

describe('#3915 AC11 — memory fill classes extended with Mn and U+2800 (F4)', () => {
	test.each(SPLIT_CASES)(
		'%s is detected after re-linking',
		(_name, type, split) => {
			const probe = `note ${split} end`;
			expect(containsSecret(probe)).toBe(true);
			expect(findSecrets(probe).map((f) => f.type)).toContain(type);
		},
		30_000,
	);

	test.each(SPLIT_CASES)(
		'%s is redacted after re-linking (condensed secret absent, placeholder present)',
		(_name, type, split, secret) => {
			const out = redactSecrets(`note ${split} end`);
			expect(out).toContain(`[REDACTED:${type}]`);
			expect(condensed(out)).not.toContain(secret);
		},
		30_000,
	);

	// Preserving leg (frozen check AC11): benign combining accents must
	// survive VERBATIM in the OUTPUT — the condensed view is for matching
	// only, never for rewriting. Byte identity is the strongest form.
	test('benign U+0301 accent prose survives redactSecrets byte-identical', () => {
		const benign = `caf${E_ACUTE} e${COMBINING_ACUTE} normal prose`;
		const out = redactSecrets(benign);
		expect(out).toBe(benign);
		expect(out).toContain(`e${COMBINING_ACUTE}`);
		expect(containsSecret(benign)).toBe(false);
	}, 30_000);

	// A combining mark BETWEEN a secret prefix and its body re-links (the
	// mapped-back condensed span INCLUDES the invisible bytes) but a mark in
	// unrelated prose never manufactures a finding on its own.
	test('a Mn mark alone never manufactures a finding', () => {
		const text = `resum${COMBINING_ACUTE} text with no credential anywhere at all`;
		expect(containsSecret(text)).toBe(false);
		expect(redactSecrets(text)).toBe(text);
	}, 30_000);
});

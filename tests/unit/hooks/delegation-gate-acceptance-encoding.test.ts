/**
 * Issue #1896 (sub-issue 1): the ACCEPTANCE coverage check gained (a) Unicode
 * encoding tolerance and (b) a bounded, diagnostic coverage-miss description.
 *
 * Background: a spec authored in a web editor saved the section sign U+00A7 as
 * mojibake -- either the Latin-1 "C-cedilla + section" byte pair or, when the
 * save DESTROYED the character, a literal "??". The old normalizer folded
 * neither, and the mismatch error was a bare pass/fail with no diff, so the
 * architect burned ~20+ turns hex-dumping spec.md to find the encoding fault.
 * This file locks:
 *   - NFC canonicalization + section-sign folding are symmetric and bypass-safe
 *     (they only reduce false-blocks);
 *   - a destroyed section sign (literal "??") still MISSES, but now returns a
 *     bounded diff with a corruption hint that names the encoding fault;
 *   - a genuinely-different ACCEPTANCE still MISSES (no bypass was opened).
 *
 * The non-ASCII fixtures below use literal characters (a UTF-8 source file). The
 * one case that MUST be byte-distinct to be meaningful — decomposed vs
 * precomposed accent — is guarded by an explicit `.not.toBe(...)` sanity assert
 * in the NFC test, which fails loudly if the two literals ever collapse to the
 * same bytes on disk (e.g. an editor NFC-normalizing the file).
 */

import { describe, expect, it } from 'bun:test';
import {
	checkAcceptanceCoversFrRefs,
	describeCoverageMiss,
	normalizeAcceptanceText,
} from '../../../src/hooks/delegation-gate';

const SECTION = '§'; // SECTION SIGN
const MOJIBAKE_SECTION = 'Â§'; // Latin-1 misread of the UTF-8 section bytes
const REPLACEMENT = '�'; // REPLACEMENT CHARACTER
const E_COMPOSED = 'é'; // precomposed e-acute
const E_DECOMPOSED = 'é'; // e + COMBINING ACUTE ACCENT

function specBullet(id: string, body: string): string {
	return ['# Fixture', '', `- **${id} - Ref.** ${body}`, ''].join('\n');
}

// ===========================================================================
// normalizeAcceptanceText -- encoding folds (#1896)
// ===========================================================================

describe('normalizeAcceptanceText -- Unicode encoding tolerance (#1896)', () => {
	it('folds the section sign, its Latin-1 mojibake, and the ASCII word to one token', () => {
		const viaSign = normalizeAcceptanceText(`See ${SECTION} 4.2 now`);
		const viaMojibake = normalizeAcceptanceText(
			`See ${MOJIBAKE_SECTION} 4.2 now`,
		);
		const viaWord = normalizeAcceptanceText('See section 4.2 now');
		expect(viaSign).toBe(viaWord);
		expect(viaMojibake).toBe(viaWord);
	});

	it('folds the NO-SPACE section form to match the spaced word form', () => {
		// A bare (unspaced) fold would yield `section4.2` and false-block this.
		expect(normalizeAcceptanceText(`See ${SECTION}4.2 now`)).toBe(
			normalizeAcceptanceText('See section 4.2 now'),
		);
	});

	it('NFC-canonicalizes: decomposed vs precomposed accents compare equal', () => {
		// Sanity: the two inputs really are byte-distinct before normalization.
		expect(`Caf${E_DECOMPOSED} mode`).not.toBe(`Caf${E_COMPOSED} mode`);
		expect(normalizeAcceptanceText(`Caf${E_DECOMPOSED} mode`)).toBe(
			normalizeAcceptanceText(`Caf${E_COMPOSED} mode`),
		);
	});

	it('does NOT recover a destroyed `??` (it is lossy, stays distinct)', () => {
		// `??` carries no information about the original section sign, so it must
		// NOT be folded into `section` (that would be a fabricated match).
		expect(normalizeAcceptanceText('See ?? 4.2 now')).not.toBe(
			normalizeAcceptanceText('See section 4.2 now'),
		);
	});

	it('does not strip `?` (no bypass): distinct bodies stay distinct', () => {
		expect(normalizeAcceptanceText('alpha beta gamma')).not.toBe(
			normalizeAcceptanceText('completely different text'),
		);
	});
});

// ===========================================================================
// checkAcceptanceCoversFrRefs -- encoding-tolerant coverage (#1896)
// ===========================================================================

describe('checkAcceptanceCoversFrRefs -- encoding tolerance (#1896)', () => {
	it('covers when spec has the section sign and ACCEPTANCE spells out "section"', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet('FR-001', `See ${SECTION} 4.2 of the policy.`),
			acceptanceText: 'ACCEPTANCE: See section 4.2 of the policy.',
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(true);
		expect(res.diagnostic).toBeUndefined();
	});

	it('covers the reverse: spec spells out "section", ACCEPTANCE uses the sign', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet('FR-001', 'See section 4.2 of the policy.'),
			acceptanceText: `ACCEPTANCE: See ${SECTION} 4.2 of the policy.`,
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(true);
	});

	it('covers the Latin-1 mojibake against a clean section-sign copy', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet('FR-001', `Ref ${MOJIBAKE_SECTION} 4.2 applies.`),
			acceptanceText: `ACCEPTANCE: Ref ${SECTION} 4.2 applies.`,
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(true);
	});

	it('covers a decomposed-vs-precomposed accent difference', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet('FR-001', `The caf${E_COMPOSED} mode is enabled.`),
			acceptanceText: `ACCEPTANCE: The caf${E_DECOMPOSED} mode is enabled.`,
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(true);
	});
});

// ===========================================================================
// checkAcceptanceCoversFrRefs -- diagnostic on the lossy `??` case (#1896)
// ===========================================================================

describe('checkAcceptanceCoversFrRefs -- coverage-miss diagnostic (#1896)', () => {
	it('MISSES a destroyed `??` spec body but returns a diagnostic with a `??` corruption hint', () => {
		const res = checkAcceptanceCoversFrRefs({
			// spec.md on disk lost the section sign to a `??` save
			specText: specBullet('FR-001', 'See ?? 4.2 of the policy.'),
			// architect copied the semantically-correct section sign
			acceptanceText: `ACCEPTANCE: See ${SECTION} 4.2 of the policy.`,
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		expect(res.missingId).toBe('FR-001');
		expect(res.diagnostic).toBeDefined();
		const diag = res.diagnostic!;
		// #2215: only "see " (4 chars) aligns as a PREFIX, but the body's 19-char
		// SUFFIX " 4.2 of the policy." is found as a substring of ACCEPTANCE — the
		// requirement text is genuinely PRESENT, just spec-side-corrupted near
		// (not at) the start, so the tail of it survives verbatim. This is
		// the diagnostic's own founding scenario (#1896), so it must render an
		// accurate divergence pointer, NOT the completely-missing fallback that
		// #2204's prefix-only threshold wrongly produced here.
		expect(diag.completelyMissing).toBeFalsy();
		// Nothing aligns from character 0, so the offset is legitimately 0 and the
		// renderer appends its "(no aligned prefix found)" qualifier.
		expect(diag.divergenceOffset).toBe(0);
		expect(diag.corruptionHint).toBeDefined();
		expect(diag.corruptionHint).toContain('??');
		// Both snippets bracket the mismatched HEAD region: the spec side shows the
		// corrupted token, the ACCEPTANCE side shows the text preceding the located
		// match (index 23 of "acceptance: see section 4.2 of the policy.").
		expect(diag.expectedSnippet).toBe('see ??');
		expect(diag.foundSnippet).toBe('acceptance: see section');
	});

	it('reports offset 0 and no alignment when nothing lines up', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet('FR-001', 'Zeta requirement body text here.'),
			acceptanceText: 'ACCEPTANCE: Wholly unrelated acceptance statement.',
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		expect(res.diagnostic?.divergenceOffset).toBe(0);
		// Neither probe finds anything: no prefix of the body occurs in ACCEPTANCE,
		// and the longest suffix of the body that occurs anywhere in it is the
		// single trailing "." (1 char) — both under COVERAGE_DIAG_MIN_PREFIX, so
		// this correctly stays the completely-missing fallback under #2215.
		expect(res.diagnostic?.completelyMissing).toBe(true);
		expect(res.diagnostic?.foundSnippet).toBe('');
	});

	it('does NOT report completely-missing when the body is present but shifted by a `- **FR-001**: ` glue (#2215)', () => {
		// `- **FR-001**: <body>` is one valid FR-bullet form (src/sdd/effective-spec.ts
		// documents the same explicit-id shape for its own, separate Spec-Kit parser).
		// extractSpecRequirementBodyById takes everything after the closing `**`, so
		// the body retains a leading `": "` glue. An architect who pastes that body
		// VERBATIM behind an id label ("FR-001 - <body>") misaligns by exactly two
		// characters, so the matched prefix is 2 — under the #2204 threshold. The
		// text is 100% present, and reporting it "completely missing" would send
		// the architect hunting for text that is right there.
		const body = 'the system shall do the thing with widgets.';
		const res = checkAcceptanceCoversFrRefs({
			specText: ['# Fixture', '', `- **FR-001**: ${body}`, ''].join('\n'),
			acceptanceText: `ACCEPTANCE: FR-001 - ${body}`,
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		const diag = res.diagnostic!;
		expect(diag.completelyMissing).toBeFalsy();
		// The body's 44-char suffix (everything after the glue colon) is found in
		// ACCEPTANCE at index 20, so the mismatched head is exactly the leading
		// glue colon on the spec side, and the ACCEPTANCE snippet is the 20 chars
		// preceding the located match — which names the real defect precisely.
		expect(diag.expectedSnippet).toBe(':');
		expect(diag.foundSnippet).toBe('acceptance: fr-001 -');
	});

	it('adversarial: encoding folds did NOT open a bypass -- a different body still MISSES', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet(
				'FR-001',
				`Render the ${SECTION} label exactly once on mount.`,
			),
			// same section sign, but the surrounding requirement is a different sentence
			acceptanceText: `ACCEPTANCE: Delete the ${SECTION} label on unmount.`,
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(false);
		expect(res.missingId).toBe('FR-001');
	});

	it('no diagnostic on a clean covered case', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet('FR-001', 'The widget renders the label once.'),
			acceptanceText: 'ACCEPTANCE: The widget renders the label once.',
			frRefs: ['FR-001'],
		});
		expect(res.covered).toBe(true);
		expect(res.diagnostic).toBeUndefined();
	});
});

// ===========================================================================
// describeCoverageMiss -- bounded snippets + corruption-marker detection
// ===========================================================================

describe('describeCoverageMiss (unit, #1896)', () => {
	it('caps both snippets so a huge body cannot blow up the error', () => {
		const huge = 'x'.repeat(5000);
		const diag = describeCoverageMiss({
			rawExpectedBody: huge,
			rawAcceptanceText: 'y'.repeat(5000),
			normalizedExpected: huge,
			normalizedAcceptance: 'y'.repeat(5000),
		});
		expect(diag.expectedSnippet.length).toBeLessThanOrEqual(80);
		expect(diag.foundSnippet.length).toBeLessThanOrEqual(80);
	});

	it('detects U+FFFD replacement-char corruption', () => {
		const diag = describeCoverageMiss({
			rawExpectedBody: `See ${REPLACEMENT} 4.2`,
			rawAcceptanceText: 'See section 4.2',
			normalizedExpected: `see ${REPLACEMENT} 4.2`,
			normalizedAcceptance: 'see section 4.2',
		});
		expect(diag.corruptionHint).toBeDefined();
		expect(diag.corruptionHint).toMatch(/U\+FFFD|replacement/i);
	});

	it('detects a `??` run', () => {
		const diag = describeCoverageMiss({
			rawExpectedBody: 'See ?? 4.2',
			rawAcceptanceText: 'See section 4.2',
			normalizedExpected: 'see ?? 4.2',
			normalizedAcceptance: 'see section 4.2',
		});
		expect(diag.corruptionHint).toContain('??');
	});

	it('treats a sub-threshold matched prefix as completely missing (#2204)', () => {
		const diag = describeCoverageMiss({
			rawExpectedBody: 'abcXYZ',
			rawAcceptanceText: 'abcQQQ',
			normalizedExpected: 'abcxyz',
			normalizedAcceptance: 'abcqqq',
		});
		// "abc" aligns (offset 3) but 3 < COVERAGE_DIAG_MIN_PREFIX (10), so the
		// match is coincidental noise → completely-missing fallback (#2204).
		// #2215: the symmetric suffix probe also finds nothing — not even the
		// single trailing "z" occurs anywhere in "abcqqq" (0 chars) — so this
		// fixture is genuinely absent and correctly keeps the fallback.
		expect(diag.completelyMissing).toBe(true);
		expect(diag.divergenceOffset).toBe(0);
		expect(diag.foundSnippet).toBe('');
		// The completely-missing branch snippets the body from character 0 (there
		// is no aligned prefix to slice past), so the operator sees the requirement
		// text they omitted — not a suffix of it.
		expect(diag.expectedSnippet).toBe('abcxyz');
	});

	it('reports a real divergence pointer when the aligned prefix meets the threshold (#2204)', () => {
		const shared = 'the login endpoint shall require ';
		const diag = describeCoverageMiss({
			rawExpectedBody: `${shared}multi-factor authentication.`,
			rawAcceptanceText: `${shared}a recovery code instead.`,
			normalizedExpected: `${shared}multi-factor authentication.`,
			normalizedAcceptance: `${shared}a recovery code instead.`,
		});
		// shared prefix is 33 chars ≥ 10 → meaningful divergence pointer.
		expect(diag.completelyMissing).toBeUndefined();
		expect(diag.divergenceOffset).toBe(shared.length);
		expect(diag.expectedSnippet.startsWith('multi-factor')).toBe(true);
		expect(diag.foundSnippet.startsWith('a recovery')).toBe(true);
	});

	it('flags an omitted requirement body whose only match is coincidental punctuation (#2204)', () => {
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet(
				'FR-007',
				'The login endpoint shall require multi-factor authentication.',
			),
			// The agent summarized the task instead of copying the body — exactly
			// the #2204 repro shape. The longest prefix of the body found here is
			// the single letter "t"; the #2215 suffix probe finds nothing at all
			// (the body's trailing "." does not occur anywhere in this text, which
			// has no period). Both are under the threshold, so this fixture stays
			// completely-missing. Note this is not a universal guarantee: the
			// suffix probe is position-independent, so a genuinely-omitted body
			// whose own trailing >=10 chars happen to recur elsewhere in the prompt
			// is NOT guaranteed to stay completely-missing (see the release note's
			// "Known limitation" section) — the rendering in that case is still a
			// strict accuracy improvement over #2204's original random-word
			// pointer, just not the same fallback message.
			acceptanceText: 'coder task: extract module logic from utils',
			frRefs: ['FR-007'],
		});
		expect(res.covered).toBe(false);
		expect(res.diagnostic?.completelyMissing).toBe(true);
		expect(res.diagnostic?.divergenceOffset).toBe(0);
	});

	it('a sub-threshold coincidental match MID-TEXT still reports completely-missing (#2204 intact for this shape)', () => {
		// The adversarial shape for #2215. Because the suffix probe now searches
		// the WHOLE acceptance text, a coincidental tail fragment can match in the
		// MIDDLE of it (here " mount." — 7 chars — inside "...touch mount. skills:
		// none", with trailing content after it). The 10-char threshold is what
		// keeps #2204 intact: 7 < 10, and the longest prefix found is "the " (4),
		// so the body is still correctly reported absent rather than pointing the
		// architect at an unrelated word.
		const res = checkAcceptanceCoversFrRefs({
			specText: specBullet(
				'FR-009',
				'The widget SHALL emit a telemetry ping on mount.',
			),
			acceptanceText:
				'coder task: rewrite the cache layer; do not touch mount. SKILLS: none',
			frRefs: ['FR-009'],
		});
		expect(res.covered).toBe(false);
		expect(res.diagnostic?.completelyMissing).toBe(true);
		expect(res.diagnostic?.foundSnippet).toBe('');
	});

	it('falls back to the start of ACCEPTANCE for foundSnippet when the matched suffix begins at index 0 (round-3 #2215)', () => {
		// This fixture is built so the matched SUFFIX region ("the quick brown fox
		// jumps over the lazy dog", 43 chars) sits at position 0 of
		// normalizedAcceptance — i.e. `foundIdx === 0` in `describeCoverageMiss` —
		// so nothing precedes the match. That is the previously-untested branch:
		// without it, foundSnippet would render as an empty, confusing string.
		const normalizedExpected = 'x the quick brown fox jumps over the lazy dog';
		const normalizedAcceptance =
			'the quick brown fox jumps over the lazy dog and more trailing stuff';
		const diag = describeCoverageMiss({
			rawExpectedBody: normalizedExpected,
			rawAcceptanceText: normalizedAcceptance,
			normalizedExpected,
			normalizedAcceptance,
		});
		// The body is present but shifted (a leading "x " glue that ACCEPTANCE
		// lacks), not genuinely absent.
		expect(diag.completelyMissing).toBeFalsy();
		// mismatchedHeadLen = normalizedExpected.length - suffixLen = 45 - 43 = 2,
		// so expectedSnippet is the first 2 chars of the body: "x ".
		expect(diag.expectedSnippet).toBe('x ');
		// foundIdx === 0, so foundSnippet falls back to
		// normalizedAcceptance.slice(0, min(length, CAP)); the acceptance text here
		// (67 chars) is shorter than COVERAGE_DIAG_SNIPPET_CAP (80), so the whole
		// string is returned rather than an empty snippet.
		expect(diag.foundSnippet).toBe(normalizedAcceptance);
		expect(diag.foundSnippet.length).toBeGreaterThan(0);
	});

	it('emits no corruption hint for clean ASCII text', () => {
		const diag = describeCoverageMiss({
			rawExpectedBody: 'alpha beta',
			rawAcceptanceText: 'gamma delta',
			normalizedExpected: 'alpha beta',
			normalizedAcceptance: 'gamma delta',
		});
		expect(diag.corruptionHint).toBeUndefined();
	});
});

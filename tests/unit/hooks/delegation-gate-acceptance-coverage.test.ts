/**
 * Issue #1687 (F-007): pre-dispatch ACCEPTANCE *coverage* enforcement for coder
 * and reviewer delegations. The existing gate only proves ACCEPTANCE is
 * non-empty (`validateCoderReviewerAcceptanceField`); this layer proves the
 * ACCEPTANCE text actually CONTAINS the verbatim requirement body for each spec
 * FR-###/SC-### the plan task maps to — so `ACCEPTANCE: lorem ipsum` on a mapped
 * task is now blocked, while every uncertainty stays FAIL-OPEN (a false-positive
 * BLOCK would halt a real swarm).
 *
 * The integration tests through the REAL `toolBefore` hook live in the sibling
 * `delegation-gate-acceptance-coverage-routing-fixtures.test.ts` file, keeping
 * this pure-helper suite below the repository's test-file size cap.
 */

import { describe, expect, it } from 'bun:test';
import {
	checkAcceptanceCoversFrRefs,
	extractSpecRequirementBodyById,
	normalizeAcceptanceText,
} from '../../../src/hooks/delegation-gate';

// ---------------------------------------------------------------------------
// Shared spec fixture (mirrors the real spec.md bullet format:
//   `- **FR-001 — Title.** body`  and  `- **SC-001 (FR-001).** body`).
// ---------------------------------------------------------------------------
const FR001_BODY =
	'The widget SHALL render the configured label exactly once on mount.';
const FR002_BODY =
	'The task SHALL carry all mapped requirements when it maps to more than one.';
const SC001_BODY =
	'Given a mounted widget, when the label is set, then it appears verbatim.';

const SPEC_MD = [
	'# Spec 1687 fixture',
	'',
	'## Functional Requirements',
	'',
	`- **FR-001 — Widget renders.** ${FR001_BODY}`,
	`- **FR-002 — Multi map.** ${FR002_BODY}`,
	'',
	'## Success Criteria',
	'',
	`- **SC-001 (FR-001).** ${SC001_BODY}`,
	'',
].join('\n');

// ===========================================================================
// Layer 1 — pure-unit tests of the exported helpers
// ===========================================================================

describe('extractSpecRequirementBodyById (unit)', () => {
	it('returns the body for an FR-### line (excludes the id/title prefix)', () => {
		const body = extractSpecRequirementBodyById(SPEC_MD, 'FR-001');
		expect(body).not.toBeNull();
		expect((body as string).trim()).toBe(FR001_BODY);
		// The `**FR-001 — Widget renders.**` prefix is NOT part of the body.
		expect(body).not.toContain('Widget renders');
	});

	it('returns the body for an SC-### line (excludes the (FR-###) prefix)', () => {
		const body = extractSpecRequirementBodyById(SPEC_MD, 'SC-001');
		expect(body).not.toBeNull();
		expect((body as string).trim()).toBe(SC001_BODY);
		expect(body).not.toContain('(FR-001)');
	});

	it('returns null for an id that is not present in the spec', () => {
		expect(extractSpecRequirementBodyById(SPEC_MD, 'FR-999')).toBeNull();
		expect(extractSpecRequirementBodyById(SPEC_MD, 'SC-042')).toBeNull();
	});

	it('does not match a longer id sharing a prefix (word boundary)', () => {
		const spec = '- **FR-0012 — Longer id.** Some other requirement body.';
		expect(extractSpecRequirementBodyById(spec, 'FR-001')).toBeNull();
	});

	it('does not treat an in-parenthetical id as its own bullet', () => {
		// FR-001 appears only inside SC-001's `(FR-001)` parenthetical here.
		const spec = `- **SC-001 (FR-001).** ${SC001_BODY}`;
		expect(extractSpecRequirementBodyById(spec, 'FR-001')).toBeNull();
	});

	it('returns null for an empty or whitespace-only id instead of matching the first bullet', () => {
		expect(extractSpecRequirementBodyById(SPEC_MD, '')).toBeNull();
		expect(extractSpecRequirementBodyById(SPEC_MD, '   ')).toBeNull();
	});
});

describe('normalizeAcceptanceText (unit)', () => {
	it('collapses whitespace/newlines, strips ** and backticks, lowercases', () => {
		const raw = '- **FR-001**  The `widget`\n   SHALL   render.';
		expect(normalizeAcceptanceText(raw)).toBe(
			'fr-001 the widget shall render.',
		);
	});

	it('is symmetric: same output for the same content with markup differences', () => {
		const a = normalizeAcceptanceText(`**FR-001 — X.** ${FR001_BODY}`);
		const b = normalizeAcceptanceText(
			`fr-001 — x.   ${FR001_BODY.toLowerCase()}`,
		);
		expect(a).toBe(b);
	});

	// Closeout finding (F-007): the architect's LLM "byte-for-byte" copy routinely
	// substitutes an em-dash `—` for `--` and curly quotes for straight ones. The
	// real spec bodies contain both (em-dashes and apostrophes), so the normalizer
	// MUST fold these symmetrically or a good-faith verbatim copy false-blocks and
	// halts the swarm.
	it('folds em/en dash and `--` to the same token', () => {
		expect(normalizeAcceptanceText('a — b')).toBe(
			normalizeAcceptanceText('a -- b'),
		);
		expect(normalizeAcceptanceText('a – b')).toBe(
			normalizeAcceptanceText('a - b'),
		);
	});

	it('folds curly quotes to straight (single and double)', () => {
		expect(normalizeAcceptanceText('the coder’s field')).toBe(
			normalizeAcceptanceText("the coder's field"),
		);
		expect(normalizeAcceptanceText('say “hi” now')).toBe(
			normalizeAcceptanceText('say "hi" now'),
		);
	});
});

describe('checkAcceptanceCoversFrRefs (unit)', () => {
	it('covered when ACCEPTANCE contains the verbatim body', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `TASK: x\nACCEPTANCE: ${FR001_BODY}`,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered when ACCEPTANCE also includes the **FR-001 — Title.** prefix', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: **FR-001 — Widget renders.** ${FR001_BODY}`,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('covered despite whitespace / markdown / case differences', () => {
		const noisy = `ACCEPTANCE:   the WIDGET shall   render\tthe **configured** label exactly once on mount.`;
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: noisy,
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('NOT covered for lorem ipsum — names the missing id', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: lorem ipsum dolor sit amet',
			frRefs: ['FR-001'],
			specText: SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-001' });
	});

	it('multi-FR: covered when both bodies present', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY} ${FR002_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('multi-FR: not-covered names the FIRST missing id', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: `ACCEPTANCE: ${FR001_BODY}`,
			frRefs: ['FR-001', 'FR-002'],
			specText: SPEC_MD,
		});
		expect(result).toMatchObject({ covered: false, missingId: 'FR-002' });
	});

	it('unknown id in frRefs is skipped (fail-open, covered:true)', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: totally unrelated text',
			frRefs: ['FR-999'],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	it('empty frRefs => covered:true', () => {
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: 'ACCEPTANCE: anything',
			frRefs: [],
			specText: SPEC_MD,
		});
		expect(result).toEqual({ covered: true });
	});

	// Closeout finding (F-007): spec body uses an em-dash and a curly apostrophe;
	// a good-faith copy that renders them as `--` / straight `'` must STILL be
	// covered (no false-block). This is the exact real-spec case (FR bodies in the
	// live spec.md carry em-dashes and apostrophes).
	it('covered when copy differs only by dash-width / curly-vs-straight quotes', () => {
		const punctSpec = [
			'## Functional Requirements',
			'',
			'- **FR-050 — Coder’s field.** The coder’s ACCEPTANCE — populated by the architect — SHALL match verbatim.',
			'',
		].join('\n');
		const goodFaithCopy =
			"ACCEPTANCE: The coder's ACCEPTANCE -- populated by the architect -- SHALL match verbatim.";
		const result = checkAcceptanceCoversFrRefs({
			acceptanceText: goodFaithCopy,
			frRefs: ['FR-050'],
			specText: punctSpec,
		});
		expect(result).toEqual({ covered: true });
	});
});

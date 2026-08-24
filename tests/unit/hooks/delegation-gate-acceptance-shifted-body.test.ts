/**
 * Issue #2215: a requirement body that IS present in the delegation prompt, but
 * not aligned at character 0 of the compared text, must render the divergence
 * pointer — NOT the "[Requirement text completely missing from prompt]"
 * fallback that #2204 introduced for genuinely-omitted bodies.
 *
 * Two shapes are locked here, both asserted on the REAL rendered error string
 * produced by the exact pair the throw site calls:
 * `checkAcceptanceCoversFrRefs` (extraction + normalization +
 * `describeCoverageMiss`) → `buildAcceptanceCoverageMismatchError` (rendering).
 *
 *  1. The id-label glue mismatch. `extractSpecRequirementBodyById` takes
 *     everything after the closing `**` of a `- **FR-050**: <body>` bullet, so
 *     the extracted body carries a leading `": "`. An architect who pastes it
 *     verbatim behind an id label (`ACCEPTANCE: FR-050 - <body>`) misaligns by
 *     two characters, which starves the prefix probe.
 *  2. A dispatch shape with content after ACCEPTANCE. The gate compares the
 *     WHOLE prompt blob (`prompt`/`description`/`task`/`input`/`message`
 *     concatenated), and a dispatch commonly has other fields (`SKILLS:`,
 *     `SKILLS_USED_BY_CODER:`, `OUTPUT:`, ...) after `ACCEPTANCE:` — so a
 *     correctly-pasted body can sit in the MIDDLE of the compared text, with
 *     fields before AND after it. A suffix check that compares the two
 *     strings' trailing characters finds nothing here and falsely reports a
 *     body that is right there in the prompt as missing; the probe must
 *     search the blob for the body's tail instead.
 *
 * Case 1 also proves the renderer's `divergenceOffset === 0` qualifier is
 * reachable in the non-`completelyMissing` branch: before #2215 the
 * sub-threshold-prefix early return always set `completelyMissing`, so that
 * ternary could never fire.
 *
 * Why NOT end-to-end through `toolBefore`: #2205 (already on main) injects the
 * verbatim spec.md body into ACCEPTANCE for every extractable mapped id BEFORE
 * the coverage recheck runs, using the same field list, id-resolution, and
 * normalization helpers — so the recheck always finds those ids covered and the
 * `ACCEPTANCE_FIELD_COVERAGE_MISMATCH` throw is structurally unreachable from
 * `toolBefore` today (see the `buildAcceptanceCoverageMismatchError` docblock in
 * src/hooks/delegation-gate.ts, which states the same). The diagnostic contract
 * is therefore asserted through the exported builder the throw site calls —
 * matching `delegation-gate-acceptance-remediation.test.ts` and
 * `delegation-gate-acceptance-coverage.test.ts`, which assert every other
 * coverage-mismatch message contract the same way. The end-to-end
 * post-injection behaviour (a summary/shifted ACCEPTANCE now DISPATCHES, with
 * the verbatim body appended to the mutated args) is covered by
 * `delegation-gate-acceptance-coverage.test.ts` and
 * `delegation-gate-acceptance-injection.test.ts`.
 *
 * These live in their own file rather than in
 * `delegation-gate-acceptance-remediation.test.ts` because that file has no
 * room left under the 500-line FR-006 cap.
 */

import { describe, expect, it } from 'bun:test';
import {
	buildAcceptanceCoverageMismatchError,
	checkAcceptanceCoversFrRefs,
} from '../../../src/hooks/delegation-gate';

describe('#2215: present-but-shifted body renders a divergence pointer, not the missing fallback', () => {
	const BODY = 'The service SHALL retry the upload three times before failing.';
	// Id-only bold span (no title): the body extracted from this bullet keeps the
	// leading `": "` glue that starves the prefix probe.
	const SPEC_MD = `- **FR-050**: ${BODY}\n`;

	function renderMismatch(acceptanceText: string): string {
		const res = checkAcceptanceCoversFrRefs({
			specText: SPEC_MD,
			acceptanceText,
			frRefs: ['FR-050'],
		});
		expect(res.covered).toBe(false);
		return buildAcceptanceCoverageMismatchError({
			targetAgent: 'coder',
			coverageTaskId: '1.1',
			coverageResult: res,
		}).message;
	}

	it('the id-label glue mismatch points at the mismatched head instead of claiming the text is absent', () => {
		const message = renderMismatch(
			`TASK: 1.1 implement it\nACCEPTANCE: FR-050 - ${BODY}`,
		);
		expect(message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		// The body IS in the prompt — claiming otherwise sends the architect
		// hunting for text that is right there (the #2215 regression).
		expect(message).not.toContain(
			'[Requirement text completely missing from prompt]',
		);
		// Nothing aligns from character 0, so the renderer's offset-0 qualifier
		// fires — live and correct only because of the suffix probe.
		expect(message).toContain(
			'first divergence at normalized offset 0 (no aligned prefix found)',
		);
		// The mismatched head on each side: the glue colon vs the id label.
		expect(message).toContain('spec requires here: ":"');
		expect(message).toContain(
			'ACCEPTANCE has here: "task: 1.1 implement it acceptance: fr-050 -"',
		);
	});

	it('the body is still found when a SKILLS line follows ACCEPTANCE in the dispatch', () => {
		// The regression a tail-position compare cannot see: the compared blob does
		// not END with the body when a dispatch has content after ACCEPTANCE (a
		// SKILLS line here, but any trailing field has the same effect).
		//
		// The `FILE:`/`SKILLS:` lines are inert PROMPT CONTENT for this assertion —
		// the coverage check receives one flat blob and never interprets them. Do
		// NOT re-plumb this case through `toolBefore`: there the `FILE:` path would
		// have to be covered by the plan task's `files_touched` or the later
		// `prepareCoderScope` preflight blocks the dispatch with SCOPE_CONFLICT
		// long before any of this is exercised.
		const message = renderMismatch(
			[
				'TASK: 1.1 implement it',
				'FILE: src/service/upload.ts',
				`ACCEPTANCE: FR-050 - ${BODY}`,
				'SKILLS: file:.claude/skills/engineering-conventions/SKILL.md',
			].join('\n'),
		);
		expect(message).toContain('ACCEPTANCE_FIELD_COVERAGE_MISMATCH');
		expect(message).not.toContain(
			'[Requirement text completely missing from prompt]',
		);
		expect(message).toContain(
			'first divergence at normalized offset 0 (no aligned prefix found)',
		);
		// The ACCEPTANCE snippet is the text preceding the LOCATED match, so it
		// stops at the id label and never bleeds into the trailing SKILLS line.
		expect(message).toContain('spec requires here: ":"');
		expect(message).toContain(
			'ACCEPTANCE has here: "task: 1.1 implement it file: src/service/upload.ts acceptance: fr-050 -"',
		);
	});
});

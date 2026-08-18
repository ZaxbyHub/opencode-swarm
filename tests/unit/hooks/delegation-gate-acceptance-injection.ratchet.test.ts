/**
 * Issue #2205: framework-side semantic injection of FR-###/SC-### requirement
 * text into the ACCEPTANCE field. See
 * `delegation-gate-acceptance-injection.test.ts` for the primary Layer 1/2
 * coverage — this file exists ONLY to keep that file under the FR-006
 * 500-line test-file cap (`scripts/check-test-file-cap.ts`). It holds two
 * regression-ratchet tests that were originally added to the primary file and
 * pushed it over cap:
 *  1. duplicate-id dedup in `frRefs`.
 *  2. the FB-003 closeout guard proving injected bodies are never truncated
 *     to `ACCEPTANCE_EXPECTED_BODY_CAP`.
 *
 * Kept deliberately minimal: its own small `SPEC_MD` fixture (FR-001 for the
 * dedup case, FR-003 with a long body for the uncapped-injection case), not
 * the full shared fixture from the primary file.
 */

import { describe, expect, it } from 'bun:test';
import {
	ACCEPTANCE_EXPECTED_BODY_CAP,
	checkAcceptanceCoversFrRefs,
	injectSpecRequirementsIntoAcceptance,
} from '../../../src/hooks/delegation-gate';

const FR001_BODY =
	'The widget SHALL render the configured label exactly once on mount.';
// Regression guard fixture (closeout FB-003): a body longer than
// ACCEPTANCE_EXPECTED_BODY_CAP. injectSpecRequirementsIntoAcceptance must
// inject this FULL, uncapped — a length cap here breaks the post-injection
// checkAcceptanceCoversFrRefs recheck, which requires the complete body to be
// a substring of the dispatched text.
const FR003_BODY = `The system SHALL preserve extremely long requirement bodies verbatim, without truncation, even when they exceed the ACCEPTANCE_EXPECTED_BODY_CAP remediation-message cap: ${'x'.repeat(2500)}`;

const SPEC_MD = [
	'# Spec 2205 ratchet fixture',
	'',
	'## Functional Requirements',
	'',
	`- **FR-001 — Widget renders.** ${FR001_BODY}`,
	`- **FR-003 — Long body.** ${FR003_BODY}`,
	'',
].join('\n');

describe('injectSpecRequirementsIntoAcceptance (unit, #2205 regression ratchet)', () => {
	it('dedupes a literal duplicate id in frRefs — injects exactly one copy', () => {
		const args: Record<string, unknown> = {
			prompt: 'TASK: 1.1 implement it\nACCEPTANCE: FR-001',
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-001', 'FR-001', 'FR-001'],
			specText: SPEC_MD,
		});
		expect(result?.injectedIds).toEqual(['FR-001']);
		expect(
			String(args.prompt).match(new RegExp(`FR-001: ${FR001_BODY}`, 'g'))
				?.length,
		).toBe(1);
	});

	// Regression guard (closeout FB-003): a prior round of #2205 shipped a
	// length cap on injected bodies that broke the post-injection coverage
	// recheck (which requires the FULL body as a substring). The cap was
	// removed; this test fails if it is ever reintroduced.
	it('injects the FULL body uncapped when longer than ACCEPTANCE_EXPECTED_BODY_CAP, and the coverage recheck passes', () => {
		expect(FR003_BODY.length).toBeGreaterThan(ACCEPTANCE_EXPECTED_BODY_CAP);
		const args: Record<string, unknown> = {
			prompt: 'TASK: 1.3 implement it\nACCEPTANCE: FR-003',
		};
		const result = injectSpecRequirementsIntoAcceptance({
			args,
			frRefs: ['FR-003'],
			specText: SPEC_MD,
		});
		expect(result?.injectedIds).toEqual(['FR-003']);
		const prompt = String(args.prompt);
		expect(prompt).toContain(`FR-003: ${FR003_BODY}`);
		// No truncation marker, and the injected body's length exactly matches
		// the source body — proves it was not cut down to the cap.
		expect(prompt).not.toContain('…[truncated');
		const injectedIdx = prompt.indexOf(`FR-003: ${FR003_BODY}`);
		expect(injectedIdx).toBeGreaterThanOrEqual(0);
		const injectedBody = prompt.slice(
			injectedIdx + 'FR-003: '.length,
			injectedIdx + 'FR-003: '.length + FR003_BODY.length,
		);
		expect(injectedBody).toBe(FR003_BODY);
		expect(injectedBody.length).toBe(FR003_BODY.length);

		const coverage = checkAcceptanceCoversFrRefs({
			acceptanceText: prompt,
			frRefs: ['FR-003'],
			specText: SPEC_MD,
		});
		expect(coverage).toEqual({ covered: true });
	});
});

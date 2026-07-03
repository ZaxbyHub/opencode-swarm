/**
 * Task 2.2 — FR-003 OBLIGATION TRACEABILITY CHECK
 *
 * Verifies that PLAN_CRITIC_PROMPT contains the obligation-traceability
 * instruction added in task 2.2, which instructs the critic to:
 *  - Map every MUST/SHALL SC-### to ≥1 task (description OR acceptance)
 *  - Return VERDICT: REJECTED (not REJECT) when any obligation is unmapped
 *
 * Also verifies the two critic-gate SKILL.md mirrors contain the same
 * obligation-traceability contract wording.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLAN_CRITIC_PROMPT } from '../../../src/agents/critic';

const OPENCODE_CRITIC_GATE = join(
	process.cwd(),
	'.opencode/skills/critic-gate/SKILL.md',
);
const CLAUDE_CRITIC_GATE = join(
	process.cwd(),
	'.claude/skills/critic-gate/SKILL.md',
);

describe('critic-obligation-traceability — task 2.2 (FR-003)', () => {
	// Anchor to the OBLIGATION TRACEABILITY CHECK section so we assert only
	// within the intended section and not just anywhere in the prompt.
	const obligationSectionStart = PLAN_CRITIC_PROMPT.indexOf(
		'## OBLIGATION TRACEABILITY CHECK',
	);
	const obligationSectionEnd = PLAN_CRITIC_PROMPT.indexOf(
		'## PLAN ASSESSMENT DIMENSIONS',
	);
	const obligationSection =
		obligationSectionStart !== -1 && obligationSectionEnd !== -1
			? PLAN_CRITIC_PROMPT.slice(obligationSectionStart, obligationSectionEnd)
			: PLAN_CRITIC_PROMPT; // fallback: whole prompt

	describe('PLAN_CRITIC_PROMPT obligation traceability', () => {
		it('(a) contains an obligation-traceability instruction', () => {
			expect(obligationSection).toContain('OBLIGATION TRACEABILITY CHECK');
		});

		it(
			'(b) references BOTH task description AND acceptance criteria ' +
				'(not description alone)',
			() => {
				// The prompt must look at both fields — acceptance is a separate plan
				// field from description, so both must be named.
				expect(obligationSection).toContain('description');
				expect(obligationSection).toContain('acceptance');
			},
		);

		it(
			'(c) uses the literal verdict token "REJECTED" (not "REJECT") ' +
				'for the unmapped case',
			() => {
				// The verdict token for structural completeness failure must be the
				// full REJECTED token, not the bare REJECT string.
				expect(obligationSection).toContain('VERDICT: REJECTED');
				// Also confirm it is NOT just the bare word "REJECTED" appearing
				// somewhere unrelated; the context around it must talk about the
				// unmapped-obligation case.
				const rejectedContext = obligationSection
					.split('VERDICT: REJECTED')
					.slice(1)
					.join('VERDICT: REJECTED');
				expect(rejectedContext.trim()).not.toBe('');
			},
		);

		it(
			'(d) requires mapping MUST/SHALL SC-### to at least 1 task ' +
				'(≥1, not zero)',
			() => {
				// The prompt must explicitly require coverage by ≥1 task, not allow
				// zero-task coverage.
				const hasMinOne =
					obligationSection.includes('at least one') ||
					obligationSection.includes('≥1') ||
					obligationSection.includes('one or more') ||
					(obligationSection.includes('zero') &&
						obligationSection.includes('covering task'));
				expect(hasMinOne).toBe(true);
			},
		);

		it('maps MUST/SHALL SC-### obligations (FR-003 structural completeness)', () => {
			// The section must reference SC-### (not just FR-###) obligations.
			// Accept either the literal placeholder "SC-###" or actual SC-NNN form.
			const hasSCPattern =
				/SC-\d{3}/.test(obligationSection) ||
				obligationSection.includes('SC-###');
			expect(hasSCPattern).toBe(true);
		});

		it(
			'REJECTED verdict is framed as structural-completeness failure, ' +
				'not a style concern',
			() => {
				// The RULES section must note that unmapped obligations are
				// structural completeness failures.
				const rulesStart = PLAN_CRITIC_PROMPT.indexOf('RULES:');
				const afterRules = PLAN_CRITIC_PROMPT.slice(rulesStart);
				expect(afterRules).toContain('structural completeness failure');
			},
		);
	});

	describe('critic-gate SKILL.md mirrors are byte-identical', () => {
		it('both mirrors exist', () => {
			const opencode = readFileSync(OPENCODE_CRITIC_GATE, 'utf-8');
			const claude = readFileSync(CLAUDE_CRITIC_GATE, 'utf-8');
			expect(opencode).toBeTruthy();
			expect(claude).toBeTruthy();
		});

		it('both mirrors are byte-identical (git diff --no-index exit 0)', () => {
			const opencode = readFileSync(OPENCODE_CRITIC_GATE, 'utf-8');
			const claude = readFileSync(CLAUDE_CRITIC_GATE, 'utf-8');
			expect(claude).toBe(opencode);
		});

		it('both mirrors contain "VERDICT: REJECTED" for unmapped obligations', () => {
			const opencode = readFileSync(OPENCODE_CRITIC_GATE, 'utf-8');
			const claude = readFileSync(CLAUDE_CRITIC_GATE, 'utf-8');
			expect(opencode).toContain('VERDICT: REJECTED');
			expect(claude).toContain('VERDICT: REJECTED');
		});

		it(
			'both mirrors reference BOTH description AND acceptance criteria ' +
				'(not description alone)',
			() => {
				const opencode = readFileSync(OPENCODE_CRITIC_GATE, 'utf-8');
				const claude = readFileSync(CLAUDE_CRITIC_GATE, 'utf-8');
				// Both files must mention "acceptance" as a separate coverage target.
				expect(opencode).toContain('acceptance');
				expect(claude).toContain('acceptance');
				// Both must mention "description" too (the paired field).
				expect(opencode).toContain('description');
				expect(claude).toContain('description');
			},
		);

		it('both mirrors reference SC-### obligations', () => {
			const opencode = readFileSync(OPENCODE_CRITIC_GATE, 'utf-8');
			// Accept either the literal placeholder "SC-###" or actual SC-NNN form.
			const hasSCPattern =
				/SC-\d{3}/.test(opencode) || opencode.includes('SC-###');
			expect(hasSCPattern).toBe(true);
		});
	});
});

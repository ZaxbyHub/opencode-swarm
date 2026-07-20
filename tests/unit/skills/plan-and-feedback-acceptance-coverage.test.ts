/**
 * Structural regression tests for ACCEPTANCE coverage in the PLAN and
 * SWARM-PR-FEEDBACK skills.
 *
 * Background: the final critic (Kimi K3) iteration 3 found two more gated
 * coder Task dispatch construction sites that were silent on ACCEPTANCE:
 *   - `plan/SKILL.md` save_plan-unavailable fallback coder delegation template
 *     (a literal TASK:/OUTPUT:/INPUT:/CONSTRAINT: block with no ACCEPTANCE:).
 *   - `swarm-pr-feedback/SKILL.md` direct-Task carve-out for 1-file feedback
 *     fixes (sanctions `Task(subagent_type="<coder>", ...)` with no ACCEPTANCE
 *     guidance).
 *
 * Both are gated at `src/hooks/delegation-gate.ts:2014` (the gate fires on
 * every canonical coder Task dispatch). These tests pin both sites.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLAN_PATH = join(process.cwd(), '.opencode/skills/plan/SKILL.md');
const planContent = readFileSync(PLAN_PATH, 'utf-8');

const FEEDBACK_PATH = join(
	process.cwd(),
	'.opencode/skills/swarm-pr-feedback/SKILL.md',
);
const feedbackContent = readFileSync(FEEDBACK_PATH, 'utf-8');

describe('.opencode/skills/plan/SKILL.md ACCEPTANCE coverage (issue: architect-acceptance-criteria)', () => {
	it('save_plan fallback coder delegation template carries an ACCEPTANCE line', () => {
		// The fallback template is a literal TASK:/OUTPUT:/INPUT:/CONSTRAINT:
		// block — a delegation-construction site gated by ACCEPTANCE_FIELD_REQUIRED.
		const idx = planContent.indexOf(
			"delegate plan writing to the active swarm's coder agent",
		);
		expect(idx).toBeGreaterThan(-1);
		// Slice to the next non-template block (TASK GRANULARITY RULES).
		const next = planContent.indexOf('TASK GRANULARITY RULES', idx);
		expect(next).toBeGreaterThan(idx);
		const block = planContent.slice(idx, next);
		expect(block).toMatch(/^ACCEPTANCE:/m);
		expect(block).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});
});

describe('.opencode/skills/swarm-pr-feedback/SKILL.md ACCEPTANCE coverage (issue: architect-acceptance-criteria)', () => {
	it('direct-Task coder carve-out carries an ACCEPTANCE reminder', () => {
		// The carve-out sanctions Task(subagent_type="<coder>", ...) without
		// declare_scope. The dispatch is still gated by ACCEPTANCE_FIELD_REQUIRED.
		const idx = feedbackContent.indexOf('Carve-out for direct Task delegation');
		expect(idx).toBeGreaterThan(-1);
		// Slice to the next `##` markdown header rather than a cosmetic bold
		// marker (e.g. `**Anti-pattern:**`) so the test is robust to harmless
		// rebolding of unrelated section labels.
		const next = feedbackContent.indexOf('\n## ', idx);
		expect(next).toBeGreaterThan(idx);
		const block = feedbackContent.slice(idx, next);
		expect(block).toContain(
			'direct Task dispatch MUST contain a literal `ACCEPTANCE:` line',
		);
		expect(block).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});
});

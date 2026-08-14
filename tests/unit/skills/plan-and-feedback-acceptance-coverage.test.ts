/**
 * Structural regression tests for PLAN fail-closed behavior and
 * SWARM-PR-FEEDBACK ACCEPTANCE coverage.
 *
 * Background: an earlier critic found two coder Task construction paths:
 *   - the legacy `plan/SKILL.md` save_plan-unavailable coder fallback, which is
 *     forbidden now that plan projections are ledger-derived.
 *   - `swarm-pr-feedback/SKILL.md` direct-Task carve-out for 1-file feedback
 *     fixes (sanctions `Task(subagent_type="<coder>", ...)` with no ACCEPTANCE
 *     guidance).
 *
 * These tests pin both contracts.
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

describe('.opencode/skills/plan/SKILL.md ledger-only plan writes', () => {
	it('save_plan unavailability fails closed without a coder fallback', () => {
		expect(planContent).toContain(
			'If the authoritative ledger-backed `save_plan` tool is unavailable, STOP',
		);
		expect(planContent).toContain('Never ask a coder to hand-write');
		expect(planContent).not.toContain(
			"delegate plan writing to the active swarm's coder agent",
		);
	});
});

describe('.opencode/skills/swarm-pr-feedback/SKILL.md ACCEPTANCE coverage (issue: architect-acceptance-criteria)', () => {
	it('dedicated feedback scope controller requires matching Task directives and acceptance', () => {
		const idx = feedbackContent.indexOf(
			"When the plugin's mechanical controller is available",
		);
		expect(idx).toBeGreaterThan(-1);
		const next = feedbackContent.indexOf('\n## ', idx);
		expect(next).toBeGreaterThan(idx);
		const block = feedbackContent.slice(idx, next);
		expect(block).toContain('prepare_pr_feedback_scope({ task_id, files })');
		expect(block).toContain('matching `FILE:` directives');
		expect(block).toContain('literal `ACCEPTANCE:` line');
		expect(block).toContain(
			'There is no one-file or single-function carve-out',
		);
	});
});

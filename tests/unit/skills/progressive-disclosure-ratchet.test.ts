/**
 * Progressive-disclosure ratchet (issue #2131 criterion G).
 *
 * The three largest operational entry skills exceed the ~500-line target with
 * a JUSTIFIED, DOCUMENTED exception: their contracts are byte-identical
 * mirrors enforced by drift-check, their exact wording is asserted by tests
 * (e.g. swarm-pr-review-dispatch-guidance.test.ts), and their checklists are
 * load-bearing controller contracts — a careless reduction risks silent
 * contract loss. The physical reduction to the ~500-line target (moving
 * schemas/parser examples/provider profiles into references/) remains tracked
 * on issue #2131 as the last open criterion-G item.
 *
 * Until then this ratchet makes the exception ONE-WAY: the entry skills may
 * never GROW past these baselines, and each must keep a references/ directory
 * so new detail lands in progressive disclosure instead of the entry file.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const ENTRY_SKILL_BASELINES: Record<string, number> = {
	// 1717 (was 1716): #3605 AC4 adds the Phase 9 cost/yield-ledger bullet
	// (paired cost+yield persistence + synthesis aggregate) with its detail in
	// references/lane-cost-recovery.md; binding-policy growth, same one-way
	// precedent as the 12ca05ef9 bump.
	'.opencode/skills/swarm-pr-review/SKILL.md': 1717,
	// 810 (was 797): the #1120 retro adds the recorded-fetch obligation to the
	// round-boundary bullet, the Stage B named-probe mandate, and the compact
	// Pre-flight: Restart Inventory section (binding policy; full protocols in
	// references/restart-inventory.md and references/intake-surfaces.md),
	// same one-way binding-policy precedent as the #3605/12ca05ef9 bumps.
	'.opencode/skills/swarm-pr-feedback/SKILL.md': 810,
	'.opencode/skills/writing-tests/SKILL.md': 424,
	// 202 (was 201): v3.0.3 adds Non-Negotiable Rules 13-14 (claim gate +
	// collision handling) and three phase-bullet pointers after the verified
	// 2026-11-11 zmem #455/#366 double-implementation; binding-policy growth,
	// same one-way-ratchet precedent as the 12ca05ef9 swarm-pr-review bump.
	// v3.0.3 adds the Phase 4.2 generate-recurrence-table.sh bullet (#3605 AC2);
	// the Phase 0 cluster-preflight clause and the gate-table cell are in-place
	// edits to existing lines (no line growth).
	'.opencode/skills/issue-tracer/SKILL.md': 202,
	'.claude/skills/graphify/SKILL.md': 420,
	'.claude/skills/commit-pr/SKILL.md': 478,
};

describe('progressive-disclosure ratchet (issue #2131 G)', () => {
	for (const [relative, baseline] of Object.entries(ENTRY_SKILL_BASELINES)) {
		test(`${relative} stays at or below its ${baseline}-line baseline`, () => {
			const content = readFileSync(join(ROOT, relative), 'utf-8');
			// trimEnd so a trailing newline doesn't count as an extra line
			// (keeps the baseline equal to `wc -l`).
			const lines = content.trimEnd().split(/\r?\n/).length;
			expect(lines).toBeLessThanOrEqual(baseline);
		});

		test(`${relative} keeps a references/ directory for progressive disclosure`, () => {
			expect(existsSync(join(ROOT, relative, '..', 'references'))).toBe(true);
		});
	}
});

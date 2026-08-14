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
	'.opencode/skills/swarm-pr-review/SKILL.md': 1941,
	'.opencode/skills/swarm-pr-feedback/SKILL.md': 933,
	'.opencode/skills/writing-tests/SKILL.md': 843,
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

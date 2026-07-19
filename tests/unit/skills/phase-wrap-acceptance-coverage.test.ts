/**
 * Structural regression tests for ACCEPTANCE coverage in the PHASE-WRAP skill.
 *
 * Background: the final critic (Kimi K3) on the architect-acceptance-criteria
 * trace found that the execute skill fix covered per-task council dispatch
 * (5j-COUNCIL) but the phase-wrap skill drives two additional council
 * dispatch paths that dispatch a gated reviewer member via the Task tool and
 * were silent on ACCEPTANCE: step 5.65 (phase council) and step 5.7 (final
 * council). Both are gated by ACCEPTANCE_FIELD_REQUIRED at
 * `src/hooks/delegation-gate.ts:2014` regardless of which mode initiated the
 * dispatch.
 *
 * These tests pin both sites so the silence cannot silently return.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_PATH = join(process.cwd(), '.opencode/skills/phase-wrap/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');

describe('.opencode/skills/phase-wrap/SKILL.md ACCEPTANCE coverage (issue: architect-acceptance-criteria)', () => {
	it('mentions ACCEPTANCE at least 2 times (phase council + final council reviewer dispatches)', () => {
		// Sanity floor only — catches a total wipe of ACCEPTANCE from the skill.
		// Does NOT pin each of the 2 sites individually: each reminder line
		// contributes ~3 ACCEPTANCE substrings, so a single remaining site
		// satisfies this floor. The per-site `it` blocks below (step 5.65 and
		// step 5.7) are the load-bearing guards.
		const matches = skillContent.match(/ACCEPTANCE/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(2);
	});

	it('step 5.65 phase council reviewer dispatch carries an ACCEPTANCE reminder', () => {
		const idx = skillContent.indexOf('5.65. **Phase Council');
		expect(idx).toBeGreaterThan(-1);
		// Slice to the next major step (5.7) to keep the assertion scoped.
		const next = skillContent.indexOf('5.7. **Final Council', idx);
		expect(next).toBeGreaterThan(idx);
		const section = skillContent.slice(idx, next);
		expect(section).toContain(
			'reviewer council member Task dispatch MUST contain a literal `ACCEPTANCE:` line',
		);
		expect(section).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('step 5.7 final council reviewer dispatch carries an ACCEPTANCE reminder', () => {
		const idx = skillContent.indexOf('5.7. **Final Council');
		expect(idx).toBeGreaterThan(-1);
		// Slice forward to the next numbered top-level step (6.).
		const next = skillContent.indexOf('\n6. ', idx);
		expect(next).toBeGreaterThan(idx);
		const section = skillContent.slice(idx, next);
		expect(section).toContain(
			'reviewer council member Task dispatch MUST contain a literal `ACCEPTANCE:` line',
		);
		expect(section).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});
});

/**
 * Structural regression test for ACCEPTANCE coverage in the BRAINSTORM skill.
 *
 * Background: the final critic (Kimi K3) iteration 2 found that brainstorm
 * Phase 5 dispatches the canonical reviewer agent for spec review, and the
 * delegation gate at `src/hooks/delegation-gate.ts:2014` fires on every
 * canonical reviewer Task dispatch — including pre-plan spec reviews. The
 * brainstorm skill had no ACCEPTANCE guidance at the reviewer delegation.
 *
 * This test pins the site so the silence cannot silently return.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_PATH = join(process.cwd(), '.opencode/skills/brainstorm/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');

describe('.opencode/skills/brainstorm/SKILL.md ACCEPTANCE coverage (issue: architect-acceptance-criteria)', () => {
	it('Phase 5 spec-review reviewer delegation carries an ACCEPTANCE reminder', () => {
		// Slice the Phase 5 block (Phase 5 to Phase 6) and require the reminder
		// to live inside it, near the reviewer delegation bullet.
		const idx = skillContent.indexOf('Phase 5: SPEC WRITE');
		expect(idx).toBeGreaterThan(-1);
		const next = skillContent.indexOf('Phase 6:', idx);
		expect(next).toBeGreaterThan(idx);
		const phase5 = skillContent.slice(idx, next);

		// The reviewer delegation bullet must be in Phase 5.
		expect(phase5).toContain(
			"Delegate to `the active swarm's reviewer agent` for an independent review of the draft spec",
		);
		// And the ACCEPTANCE reminder must be there too.
		expect(phase5).toContain(
			'reviewer Task dispatch MUST contain a literal `ACCEPTANCE:` line',
		);
		expect(phase5).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});
});

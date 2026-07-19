/**
 * Structural regression tests for ACCEPTANCE coverage in the EXECUTE skill.
 *
 * Background: issue traced under `.zcode/issue-traces/architect-acceptance-criteria/`.
 * #1687 added a blocking ACCEPTANCE_FIELD_REQUIRED gate but never updated the
 * EXECUTE skill (`MODE: EXECUTE` operational protocol the architect loads right
 * before delegating). The skill was silent on ACCEPTANCE at every delegation-
 * construction site, so the runtime architect LLM routinely omitted the line and
 * had its coder/reviewer/council dispatches blocked. These tests pin the four
 * sites so the silence cannot silently return.
 *
 * See: tests/unit/skills/execute-protocol.test.ts for the broader protocol suite.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_PATH = join(process.cwd(), '.opencode/skills/execute/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');

describe('.opencode/skills/execute/SKILL.md ACCEPTANCE coverage (issue: architect-acceptance-criteria)', () => {
	it('mentions ACCEPTANCE at least 5 times across the delegation-construction sites', () => {
		// Sanity floor only — catches a total wipe of ACCEPTANCE from the skill.
		// Does NOT pin each of the 5 sites individually: each reminder line
		// contributes 3-4 ACCEPTANCE substrings (ACCEPTANCE: + ACCEPTANCE FIELD
		// RESOLUTION + ACCEPTANCE_FIELD_REQUIRED), so this floor is satisfied by
		// ~2 of the 5 sites being present. The per-site `it` blocks below pin
		// each location (retry template, 5b, 5j-COUNCIL, 5j, 5k) and are the
		// load-bearing guards.
		const matches = skillContent.match(/ACCEPTANCE/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(5);
	});

	it('retry coder template carries a literal ACCEPTANCE: line in the delegation body', () => {
		// Slice the retry delegation block, then require an ACCEPTANCE: line inside it.
		// A bare `section.contains('ACCEPTANCE')` would false-pass on a stray mention
		// elsewhere; pinning the slice + a line-anchored regex closes that hole.
		const start = skillContent.indexOf(
			'CONSTRAINT: Fix ONLY the reported issue',
		);
		expect(start).toBeGreaterThan(-1);
		const end = skillContent.indexOf('✓ After coder returns', start);
		expect(end).toBeGreaterThan(start);
		const retryBlock = skillContent.slice(start, end);
		expect(retryBlock).toMatch(/^ACCEPTANCE:/m);
		expect(retryBlock).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});

	it('step 5b (coder) reminder is present and uses the REQUIRED continuation format', () => {
		const idx = skillContent.indexOf(
			"5b. the active swarm's coder agent - Implement",
		);
		expect(idx).toBeGreaterThan(-1);
		// Slice forward enough to capture the appended reminder without crossing
		// into the next step (5b-bis / 5c). The reminder is short.
		const section = skillContent.slice(idx, idx + 1200);
		expect(section).toContain('MUST contain a literal `ACCEPTANCE:` line');
		// Continuation-line format keeps `execute-protocol.test.ts` step-label
		// count assertions (`/^\s*5n\./gm` length 1) intact.
		expect(section).toMatch(/^\s*→ REQUIRED:/m);
	});

	it('step 5j (reviewer) reminder is present', () => {
		const idx = skillContent.indexOf(
			"5j. the active swarm's reviewer agent - General review",
		);
		expect(idx).toBeGreaterThan(-1);
		const section = skillContent.slice(idx, idx + 800);
		expect(section).toContain('MUST contain a literal `ACCEPTANCE:` line');
	});

	it('step 5j-COUNCIL covers the reviewer member', () => {
		const idx = skillContent.indexOf('5j-COUNCIL');
		expect(idx).toBeGreaterThan(-1);
		// The 5j-COUNCIL block has 5 numbered sub-steps; slice generously to
		// cover the whole block but stop well short of the standard 5j header.
		const section = skillContent.slice(idx, idx + 2000);
		expect(section).toContain(
			'MUST receive a Task prompt containing a literal `ACCEPTANCE:` line',
		);
		// Per critic I1: only the reviewer member is gated in the standard council.
		expect(section).toContain('reviewer member is gated');
	});

	it('step 5k (security-reviewer) reminder is present — security-only reviews are gated too', () => {
		// The delegation gate at delegation-gate.ts:2014 fires on every
		// canonical reviewer Task dispatch; it does not exempt security-only
		// reviews. A 5k dispatch without ACCEPTANCE is blocked identically.
		const idx = skillContent.indexOf('5k. Security gate');
		expect(idx).toBeGreaterThan(-1);
		const next = skillContent.indexOf('5l.', idx);
		expect(next).toBeGreaterThan(idx);
		const section = skillContent.slice(idx, next);
		expect(section).toContain(
			'security-reviewer Task dispatch MUST contain a literal `ACCEPTANCE:` line',
		);
		expect(section).toContain('ACCEPTANCE_FIELD_REQUIRED');
	});
});

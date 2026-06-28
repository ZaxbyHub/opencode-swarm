import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * PRE-PHASE BRIEFING verification.
 *
 * The architect prompt keeps only the mode dispatch stub. The full protocol
 * and codebase reality check live in .opencode/skills/pre-phase-briefing.
 */
describe('PRE-PHASE BRIEFING Verification (Task 2.5)', () => {
	const prompt = createArchitectAgent('test-model').config.prompt!;
	const skill = readFileSync(
		join(process.cwd(), '.opencode/skills/pre-phase-briefing/SKILL.md'),
		'utf-8',
	);

	test('1. ARCHITECT_PROMPT contains "PRE-PHASE BRIEFING" string', () => {
		expect(prompt).toContain('PRE-PHASE BRIEFING');
	});

	test('2. ARCHITECT_PROMPT contains "MODE: PRE-PHASE BRIEFING"', () => {
		expect(prompt).toContain('MODE: PRE-PHASE BRIEFING');
	});

	test('3. PRE-PHASE BRIEFING stub appears before COUNCIL modes', () => {
		const prePhaseBriefingIndex = prompt.indexOf(
			'### MODE: PRE-PHASE BRIEFING',
		);
		const councilIndex = prompt.indexOf('### MODE: COUNCIL');

		expect(prePhaseBriefingIndex).not.toBe(-1);
		expect(councilIndex).not.toBe(-1);
		expect(prePhaseBriefingIndex).toBeLessThan(councilIndex);
	});

	test('4. "PRE-PHASE BRIEFING" appears AFTER "MODE: CONSULT" (positional check)', () => {
		const consultIndex = prompt.indexOf('MODE: CONSULT');
		const prePhaseBriefingIndex = prompt.indexOf('MODE: PRE-PHASE BRIEFING');

		expect(consultIndex).not.toBe(-1);
		expect(prePhaseBriefingIndex).not.toBe(-1);
		expect(consultIndex).toBeLessThan(prePhaseBriefingIndex);
	});

	test('5. skill contains "retro-{N-1}" (Phase 2+ path references correct task ID pattern)', () => {
		expect(skill).toContain('retro-{N-1}');
	});

	test('6. skill contains "retro-*" (Phase 1 path references retro scan pattern)', () => {
		expect(skill).toContain('retro-*');
	});

	test('7. skill contains both Phase 2+ and Phase 1 briefing variants', () => {
		const hasPhase2PlusPath = skill.includes('retro-{N-1}');
		const hasPhase1Path = skill.includes('retro-*');

		expect(hasPhase2PlusPath).toBe(true);
		expect(hasPhase1Path).toBe(true);
	});

	test('8. skill contains BRIEFING acknowledgment format', () => {
		expect(skill).toContain('BRIEFING:');
	});

	test('9. "PRE-PHASE BRIEFING" section does NOT appear after "### MODE: EXECUTE" (placed correctly)', () => {
		const prePhaseBriefingIndex = prompt.indexOf('MODE: PRE-PHASE BRIEFING');
		const executeIndex = prompt.indexOf('### MODE: EXECUTE');

		expect(prePhaseBriefingIndex).not.toBe(-1);
		expect(executeIndex).not.toBe(-1);
		expect(prePhaseBriefingIndex).toBeLessThan(executeIndex);
	});

	test('10. Template literal double-brace vars preserved: prompt contains "{{AGENT_PREFIX}}" not single-brace', () => {
		expect(prompt).not.toMatch(/(?<!\{)\{AGENT_PREFIX\}(?!\})/);
		expect(prompt).toContain('{{AGENT_PREFIX}}');
	});

	test('11. Skill contains retro-* and loads as a string', () => {
		expect(skill).toMatch(/retro-\*/);
		expect(typeof skill).toBe('string');
	});

	test('12. "HARD REQUIREMENT" phrase present in PRE-PHASE BRIEFING skill', () => {
		expect(skill).toContain('HARD REQUIREMENT');
	});

	test('13. skill contains "user_directives" (Phase 1 path mentions user_directives)', () => {
		expect(skill).toContain('user_directives');
	});

	// --- Async + fan-out reality-check contract (issue: async-by-default reality report) ---

	test('14. reality check dispatches asynchronously via dispatch_lanes_async', () => {
		expect(skill).toContain('dispatch_lanes_async');
	});

	test('15. hard settlement gate joins on all_settled before downstream work', () => {
		expect(skill).toContain('collect_lane_results');
		expect(skill).toContain('all_settled');
		// The gate must explicitly block spec/plan/scope, not only implementation.
		expect(skill).toContain(
			'No spec finalization, plan generation, plan ingestion, `declare_scope`',
		);
		expect(skill).toMatch(/coder, reviewer, test-engineer/);
	});

	test('16. fan-out is complexity-scaled, not a fixed count, capped at the dispatch limit', () => {
		expect(skill).toContain('1 lane');
		expect(skill).toContain('2–4 lanes');
		expect(skill).toContain('8 lanes per batch');
	});

	test('17. lanes carry disjoint boundaries whose union covers every reference', () => {
		expect(skill).toContain('non-overlapping');
		expect(skill).toContain(
			'union of all lanes must cover every referenced item',
		);
	});

	test('18. async dispatch does not weaken the gate (explicit when-not-whether clause)', () => {
		expect(skill).toContain('not fire-and-forget');
		expect(skill).toMatch(
			/changes \*when\* the Architect waits, never \*whether\* the gate holds/,
		);
	});

	test('19. architect stub gate covers spec/plan/scope, not only implementation', () => {
		// Use .filter() + exact-count assertion instead of .find() so that
		// if the phrase is ever duplicated in a future mode stub, the test
		// fails loudly instead of silently checking the wrong line.
		const gateLines = prompt
			.split('\n')
			.filter((line) => line.includes('Complete the codebase reality report'));
		expect(gateLines.length).toBe(1);
		expect(gateLines[0]).toContain('spec finalization');
		expect(gateLines[0]).toContain('plan generation');
		expect(gateLines[0]).toContain('declare_scope');
	});

	test('20. reality-check rewrite introduces no stray template placeholders', () => {
		const realityCheckSection = skill.slice(
			skill.indexOf('### CODEBASE REALITY CHECK'),
		);
		expect(realityCheckSection).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
		expect(realityCheckSection).not.toContain('mega_explorer');
		expect(realityCheckSection).not.toContain('mega_sme');
	});

	test('21. each forbidden gate keyword is individually present (negative-path regression guard)', () => {
		// If someone later removes a single keyword (e.g. 'declare_scope') from
		// the gate line, test 19 might still pass if other keywords remain —
		// but this test fails on any individual keyword removal.
		const gateLines = prompt
			.split('\n')
			.filter((line) => line.includes('Complete the codebase reality report'));
		expect(gateLines.length).toBe(1);
		const gateLine = gateLines[0];
		for (const keyword of [
			'spec finalization',
			'plan generation',
			'plan ingestion',
			'declare_scope',
		]) {
			expect(gateLine).toContain(keyword);
		}
	});
});

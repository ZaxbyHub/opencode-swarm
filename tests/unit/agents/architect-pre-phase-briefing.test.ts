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

	test('3. PRE-PHASE BRIEFING stub appears before PLAN execution modes', () => {
		const prePhaseBriefingIndex = prompt.indexOf('MODE: PRE-PHASE BRIEFING');
		const planIndex = prompt.indexOf('MODE: PLAN');

		expect(prePhaseBriefingIndex).not.toBe(-1);
		expect(planIndex).not.toBe(-1);
		expect(prePhaseBriefingIndex).toBeLessThan(planIndex);
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
});

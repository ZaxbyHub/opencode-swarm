import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';
import { expectSkillConcept } from '../../helpers/skill-content-registry';

/**
 * MODE: SPECIFY step 5b - QA gate selection dialogue.
 *
 * The architect prompt now keeps only a mode stub; the full SPECIFY protocol
 * lives in .opencode/skills/specify/SKILL.md.
 */
describe('architect prompt - MODE: SPECIFY step 5b QA gate selection', () => {
	const prompt = createArchitectAgent('test-model').config.prompt!;
	const specifySkill = readFileSync(
		join(process.cwd(), '.opencode/skills/specify/SKILL.md'),
		'utf-8',
	);
	const planSkill = readFileSync(
		join(process.cwd(), '.opencode/skills/swarm-plan/SKILL.md'),
		'utf-8',
	);

	function getSpecifySection(): string {
		const start = specifySkill.indexOf('### MODE: SPECIFY');
		expect(start).toBeGreaterThan(-1);
		return specifySkill.substring(start);
	}

	test('SPECIFY block contains a step labeled "5b"', () => {
		expectSkillConcept(getSpecifySection(), 'specifyQaGateSelection');
	});

	test('SPECIFY defers execution choices until MODE: PLAN has an exact identity', () => {
		expectSkillConcept(getSpecifySection(), 'specifyQaGateSelection');
	});

	test('SPECIFY does not stage QA or execution choices in context.md', () => {
		const block = getSpecifySection();
		for (const legacy of [
			'Pending QA Gate Selection',
			'Pending Parallelization Config',
			'Task Completion Commit Policy',
		]) {
			expect(block).not.toContain(legacy);
		}
	});

	test('SPECIFY block does not leave {{QA_GATE_DIALOGUE_SPECIFY}} placeholder unexpanded', () => {
		const block = getSpecifySection();
		expect(block).not.toContain('{{QA_GATE_DIALOGUE_SPECIFY}}');
	});

	test('renumbered final step 7 (formerly step 6) reports a summary to the user', () => {
		const block = getSpecifySection();
		expect(block).toMatch(/7\.\s+Report a summary to the user/);
	});

	test('MODE: PLAN owns pre-save gate persistence', () => {
		expect(prompt).toContain('file:.swarm/bundled-skills/swarm-plan/SKILL.md');
		expect(planSkill).toContain('before first `save_plan`');
		const bootstrap = planSkill.slice(
			planSkill.indexOf('QA AND EXECUTION PROFILE BOOTSTRAP'),
			planSkill.indexOf('TRACEABILITY CHECK'),
		);
		expect(bootstrap.indexOf('set_qa_gates')).toBeLessThan(
			bootstrap.indexOf('\nsave_plan({'),
		);
	});

	test('MODE: PLAN inline path does not leave {{QA_GATE_DIALOGUE_PLAN}} placeholder unexpanded', () => {
		const planStart = prompt.indexOf('### MODE: PLAN');
		const after = prompt.indexOf('### MODE:', planStart + 1);
		const planBlock = prompt.substring(
			planStart,
			after === -1 ? prompt.length : after,
		);
		expect(planBlock).not.toContain('{{QA_GATE_DIALOGUE_PLAN}}');
	});
});

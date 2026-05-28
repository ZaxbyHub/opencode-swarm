import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

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
		join(process.cwd(), '.opencode/skills/plan/SKILL.md'),
		'utf-8',
	);

	function getSpecifySection(): string {
		const start = specifySkill.indexOf('### MODE: SPECIFY');
		expect(start).toBeGreaterThan(-1);
		return specifySkill.substring(start);
	}

	test('SPECIFY block contains a step labeled "5b"', () => {
		const block = getSpecifySection();
		expect(block).toMatch(/5b\.\s+\*\*QA GATE SELECTION/);
	});

	test('SPECIFY block references the "## Pending QA Gate Selection" section', () => {
		const block = getSpecifySection();
		expect(block).toContain('## Pending QA Gate Selection');
	});

	test('SPECIFY block explicitly says "Do NOT call `set_qa_gates` yet"', () => {
		const block = getSpecifySection();
		expect(block).toContain('Do NOT call `set_qa_gates` yet');
	});

	test('SPECIFY block lists all seven QA gate names in the dialogue text', () => {
		const block = getSpecifySection();
		expect(block).toContain('reviewer');
		expect(block).toContain('test_engineer');
		expect(block).toContain('sme_enabled');
		expect(block).toContain('critic_pre_plan');
		expect(block).toContain('sast_enabled');
		expect(block).toContain('council_mode');
		expect(block).toContain('hallucination_guard');
	});

	test('SPECIFY block instructs writing to .swarm/context.md', () => {
		const block = getSpecifySection();
		expect(block).toContain('.swarm/context.md');
	});

	test('SPECIFY block mentions persistence happens in MODE: PLAN', () => {
		const block = getSpecifySection();
		expect(block).toMatch(/MODE: PLAN.*set_qa_gates/s);
	});

	test('SPECIFY block does not leave {{QA_GATE_DIALOGUE_SPECIFY}} placeholder unexpanded', () => {
		const block = getSpecifySection();
		expect(block).not.toContain('{{QA_GATE_DIALOGUE_SPECIFY}}');
	});

	test('renumbered final step 7 (formerly step 6) reports a summary to the user', () => {
		const block = getSpecifySection();
		expect(block).toMatch(/7\.\s+Report a summary to the user/);
	});

	test('MODE: PLAN block contains POST-SAVE_PLAN gate application instructions', () => {
		expect(prompt).toContain('file:.opencode/skills/plan/SKILL.md');
		expect(planSkill).toContain('POST-SAVE_PLAN');
		expect(planSkill).toContain('## Pending QA Gate Selection');
		expect(planSkill).toContain('set_qa_gates');
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

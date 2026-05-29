import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../../src/agents/architect';

/**
 * MODE: BRAINSTORM Phase 6 - QA gate selection dialogue.
 *
 * The architect prompt now keeps only a mode stub; the full BRAINSTORM
 * protocol lives in .opencode/skills/brainstorm/SKILL.md.
 */
describe('architect prompt - MODE: BRAINSTORM Phase 6 QA gate selection', () => {
	const prompt = createArchitectAgent('test-model').config.prompt!;
	const skill = readFileSync(
		join(process.cwd(), '.opencode/skills/brainstorm/SKILL.md'),
		'utf-8',
	);

	function getPhase6Section(): string {
		const start = skill.indexOf('**Phase 6:');
		expect(start).toBeGreaterThan(-1);
		const after = skill.indexOf('**Phase 7:', start + 1);
		return skill.substring(start, after === -1 ? skill.length : after);
	}

	test('Phase 6 contains the user-facing dialogue lead-in', () => {
		const block = getPhase6Section();
		expect(block).toContain(
			'ask the user which QA gates to enable for this plan',
		);
		expect(block).toContain('do not select on their behalf');
	});

	test('Phase 6 lists all seven gate names as defaults', () => {
		const block = getPhase6Section();
		expect(block).toContain('reviewer');
		expect(block).toContain('test_engineer');
		expect(block).toContain('sme_enabled');
		expect(block).toContain('critic_pre_plan');
		expect(block).toContain('sast_enabled');
		expect(block).toContain('council_mode');
		expect(block).toContain('hallucination_guard');
	});

	test('Phase 6 says "One question, one message, defaults pre-stated"', () => {
		const block = getPhase6Section();
		expect(block).toContain('One question, one message, defaults pre-stated');
	});

	test('Phase 6 does NOT instruct calling set_qa_gates directly (defers to MODE: PLAN)', () => {
		const block = getPhase6Section();
		expect(block).toContain('Do NOT call `set_qa_gates` yet');
	});

	test('Phase 6 instructs writing to "## Pending QA Gate Selection" in context.md', () => {
		const block = getPhase6Section();
		expect(block).toContain('## Pending QA Gate Selection');
		expect(block).toContain('.swarm/context.md');
	});

	test('Phase 6 references MODE: PLAN for persistence after save_plan', () => {
		const block = getPhase6Section();
		expect(block).toMatch(/MODE: PLAN applies these after.*save_plan/);
	});

	test('Phase 6 does not leave the {{QA_GATE_DIALOGUE_BRAINSTORM}} placeholder unexpanded', () => {
		const block = getPhase6Section();
		expect(block).not.toContain('{{QA_GATE_DIALOGUE_BRAINSTORM}}');
	});

	test('BRAINSTORM RULES updated: gates persisted during MODE: PLAN are ratchet-tighter from that point', () => {
		expect(prompt).toContain('file:.opencode/skills/brainstorm/SKILL.md');
		expect(skill).toContain(
			'QA gates elected in Phase 6 are persisted during MODE: PLAN',
		);
		expect(skill).toContain('ratchet-tighter from that point');
		expect(skill).not.toContain('QA gates set in Phase 6 are ratchet-tighter');
	});
});

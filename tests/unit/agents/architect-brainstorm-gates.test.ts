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

	test('Phase 6 defers QA and execution choices to MODE: PLAN', () => {
		const block = getPhase6Section();
		expect(block).toContain('MODE: PLAN');
		expect(block).toContain('exact plan identity');
		for (const legacy of [
			'Pending QA Gate Selection',
			'Pending Parallelization Config',
			'Task Completion Commit Policy',
		]) {
			expect(block).not.toContain(legacy);
		}
	});

	test('Phase 6 does not leave the {{QA_GATE_DIALOGUE_BRAINSTORM}} placeholder unexpanded', () => {
		const block = getPhase6Section();
		expect(block).not.toContain('{{QA_GATE_DIALOGUE_BRAINSTORM}}');
	});

	test('BRAINSTORM rules leave persistence to MODE: PLAN', () => {
		expect(prompt).toContain('file:.swarm/bundled-skills/brainstorm/SKILL.md');
		expect(skill).toMatch(/MODE: PLAN[\s\S]*exact plan identity/i);
	});
});

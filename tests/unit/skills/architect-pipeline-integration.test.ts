/**
 * Integration tests for the architect PLAN→CRITIC-GATE→EXECUTE pipeline.
 * Validates correct mode sequencing in architect.ts stubs and critic agent
 * routing content in skill files.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CWD = process.cwd();

describe('architect PLAN→CRITIC-GATE→EXECUTE pipeline', () => {
	const prompt = readFileSync(join(CWD, 'src/agents/architect.ts'), 'utf-8');

	it('maintains correct MODE sequencing: PLAN before CRITIC-GATE before EXECUTE', () => {
		const planIndex = prompt.indexOf('### MODE: PLAN');
		const criticGateIndex = prompt.indexOf('### MODE: CRITIC-GATE');
		const executeIndex = prompt.indexOf('### MODE: EXECUTE');

		expect(planIndex).toBeGreaterThanOrEqual(0);
		expect(criticGateIndex).toBeGreaterThan(planIndex);
		expect(executeIndex).toBeGreaterThan(criticGateIndex);
	});

	it('architect.ts CRITIC-GATE stub mentions the critic for plan approval', () => {
		const idx = prompt.indexOf('### MODE: CRITIC-GATE');
		const end = prompt.indexOf('\n### MODE:', idx + 1);
		const stub = prompt.slice(idx, end === -1 ? undefined : end);

		expect(stub).toMatch(/critic\s+(agent|has|approved|review)/i);
	});

	it('critic-gate skill file contains explicit critic agent delegation', () => {
		const skill = readFileSync(
			join(CWD, '.opencode/skills/critic-gate/SKILL.md'),
			'utf-8',
		);

		expect(skill).toMatch(/the active swarm's critic agent/i);
	});
});

describe('PLAN→CRITIC-GATE transition in plan skill', () => {
	it('plan skill contains Transition to CRITIC-GATE section', () => {
		const planSkill = readFileSync(
			join(CWD, '.opencode/skills/plan/SKILL.md'),
			'utf-8',
		);

		expect(planSkill).toMatch(/Transition to CRITIC-GATE/i);
		expect(planSkill).toMatch(
			/transition to .*MODE: CRITIC-GATE|Transition to CRITIC-GATE/i,
		);
	});

	it('plan skill references critic review workflow', () => {
		const planSkill = readFileSync(
			join(CWD, '.opencode/skills/plan/SKILL.md'),
			'utf-8',
		);

		expect(planSkill).toMatch(/delegating.*full.*plan.*critic/i);
		expect(planSkill).toMatch(/critic.*approve|APPROVED.*proceed.*EXECUTE/i);
	});
});

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../src/agents/architect';
import { expectSkillConcept } from '../helpers/skill-content-registry';

describe('Profile-aware spec policy — integration', () => {
	// Extract PLAN protocol text from the extracted plan skill.
	const agent = createArchitectAgent('test-model');
	const prompt = agent.config.prompt!;
	const planSection = readFileSync(
		join(process.cwd(), '.opencode/skills/swarm-plan/SKILL.md'),
		'utf-8',
	);

	describe('Gate completeness (both branches present)', () => {
		it('SPEC POLICY presents both spec-absent and spec-present branches', () => {
			expectSkillConcept(planSection, 'softSpecGateBranches');
		});

		it('No-spec branch mentions spec creation option', () => {
			expectSkillConcept(planSection, 'softSpecGateNoSpecChoices');
		});

		it('No-spec branch mentions skip option', () => {
			expectSkillConcept(planSection, 'softSpecGateNoSpecChoices');
		});

		it('Spec-exists branch mentions FR-### cross-referencing', () => {
			expectSkillConcept(planSection, 'softSpecGateSpecAlignment');
		});

		it('Spec-exists branch flags gold-plating risk', () => {
			expectSkillConcept(planSection, 'softSpecGateSpecAlignment');
		});
	});

	describe('Gate coherence (non-contradictory)', () => {
		it('Gate does not promise to block planning when spec is absent', () => {
			expectSkillConcept(planSection, 'softSpecGateNonBlocking');
		});

		it('Skip path preserves exact existing planning steps', () => {
			expectSkillConcept(planSection, 'softSpecGateNonBlocking');
		});

		it('Gate instructions appear BEFORE the main planning steps', () => {
			const specGateIndex = planSection.indexOf('SPEC POLICY');
			const savePlanIndex = planSection.indexOf('\nsave_plan({');
			expect(specGateIndex).toBeGreaterThanOrEqual(0);
			expect(savePlanIndex).toBeGreaterThan(0);
			expect(specGateIndex).toBeLessThan(savePlanIndex);
		});
	});

	describe('Gate ordering (spec gate before plan steps)', () => {
		it('SPEC POLICY appears before save_plan tool usage in PLAN mode', () => {
			const specGateIndex = planSection.indexOf('SPEC POLICY');
			const savePlanIndex = planSection.indexOf('\nsave_plan({');
			expect(specGateIndex).toBeGreaterThanOrEqual(0);
			expect(savePlanIndex).toBeGreaterThan(0);
			expect(specGateIndex).toBeLessThan(savePlanIndex);
		});

		it('SPEC POLICY appears before task granularity rules', () => {
			const specGateIndex = planSection.indexOf('SPEC POLICY');
			const taskGranularityIndex = planSection.indexOf('TASK GRANULARITY');
			expect(specGateIndex).toBeGreaterThanOrEqual(0);
			expect(taskGranularityIndex).toBeGreaterThan(0);
			expect(specGateIndex).toBeLessThan(taskGranularityIndex);
		});
	});

	describe('Activation consistency', () => {
		it('MODE: SPECIFY and MODE: CLARIFY-SPEC exist in the same prompt as the spec gate', () => {
			expect(prompt).toContain('MODE: SPECIFY');
			expect(prompt).toContain('MODE: CLARIFY-SPEC');
		});

		it('Spec gate warning references critic verification', () => {
			expect(planSection).toContain('critic');
		});
	});
});

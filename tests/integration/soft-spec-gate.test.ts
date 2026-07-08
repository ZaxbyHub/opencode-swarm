import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArchitectAgent } from '../../src/agents/architect';

describe('Soft Spec Gate — integration (v6.15 Task 7.6)', () => {
	// Extract PLAN protocol text from the extracted plan skill.
	const agent = createArchitectAgent('test-model');
	const prompt = agent.config.prompt!;
	const planSection = readFileSync(
		join(process.cwd(), '.opencode/skills/plan/SKILL.md'),
		'utf-8',
	);

	describe('Gate completeness (both branches present)', () => {
		it('SPEC GATE presents exactly two branches: spec absent and spec present', () => {
			const hasNoSpecBranch = planSection.includes('NO effective spec');
			const hasSpecExistsBranch = planSection.includes('EXISTS');
			expect(hasNoSpecBranch).toBe(true);
			expect(hasSpecExistsBranch).toBe(true);
		});

		it('No-spec branch mentions spec creation option', () => {
			expect(planSection).toContain('Create a spec first');
		});

		it('No-spec branch mentions skip option', () => {
			expect(planSection).toContain('Skip and plan directly');
		});

		it('Spec-exists branch mentions FR-### cross-referencing', () => {
			expect(planSection).toContain('FR-###');
		});

		it('Spec-exists branch flags gold-plating risk', () => {
			expect(planSection).toContain('gold-plating');
		});
	});

	describe('Gate coherence (non-contradictory)', () => {
		it('Gate does not promise to block planning when spec is absent', () => {
			const blockingPhrases = [
				'cannot proceed',
				'must have spec',
				'planning is blocked',
				'blocked until',
			];
			const planSectionLower = planSection.toLowerCase();
			blockingPhrases.forEach((phrase) => {
				expect(planSectionLower).not.toContain(phrase);
			});
		});

		it('Skip path preserves exact existing planning steps', () => {
			const hasPreserveLanguage =
				planSection.includes('proceed to the steps below exactly as before') ||
				planSection.includes('do NOT modify any planning behavior');
			expect(hasPreserveLanguage).toBe(true);
		});

		it('Gate instructions appear BEFORE the main planning steps', () => {
			const specGateIndex = planSection.indexOf('SPEC GATE');
			const savePlanIndex = planSection.indexOf('save_plan');
			expect(specGateIndex).toBeGreaterThanOrEqual(0);
			expect(savePlanIndex).toBeGreaterThan(0);
			expect(specGateIndex).toBeLessThan(savePlanIndex);
		});
	});

	describe('Gate ordering (spec gate before plan steps)', () => {
		it('SPEC GATE appears before save_plan tool usage in PLAN mode', () => {
			const specGateIndex = planSection.indexOf('SPEC GATE');
			const savePlanIndex = planSection.indexOf('save_plan');
			expect(specGateIndex).toBeGreaterThanOrEqual(0);
			expect(savePlanIndex).toBeGreaterThan(0);
			expect(specGateIndex).toBeLessThan(savePlanIndex);
		});

		it('SPEC GATE appears before task granularity rules', () => {
			const specGateIndex = planSection.indexOf('SPEC GATE');
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

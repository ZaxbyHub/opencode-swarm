/**
 * Tests for Task 3.1 — Three-tier review structure verification
 *
 * Test Requirements:
 * 1. Intent reconstruction (Step 0)
 * 2. Complexity classification (Step 0a) with TRIVIAL/MODERATE/COMPLEX
 * 3. Three-tier structure (Tier 1/2/3)
 * 4. First-error focus in Tier 1
 * 5. Anti-rubber-stamp in Tier 2
 * 6. "APPROVED but" prohibited
 * 7. Verbosity control with token budget
 * 8. Token budget ≤800
 */

import { describe, expect, it } from 'bun:test';
import {
	createReviewerAgent,
	SECURITY_CATEGORIES,
} from '../src/agents/reviewer';

describe('Reviewer Agent - Three-Tier Review Structure (Task 3.1)', () => {
	describe('REVIEWER_PROMPT Structure Verification', () => {
		it('should contain Step 0: Intent Reconstruction', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('STEP 0: INTENT RECONSTRUCTION');
			expect(prompt).toContain('mandatory, before Tier 1');
			expect(prompt).toContain(
				'State in ONE sentence what the developer was trying to accomplish',
			);
			expect(prompt).toContain('reconstructed intent');
		});

		it('should contain Step 0a: Complexity Classification', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('STEP 0a: COMPLEXITY CLASSIFICATION');
			expect(prompt).toContain('Classify the change:');
		});

		it('should define TRIVIAL complexity level', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('TRIVIAL:');
			expect(prompt).toContain('rename, typo fix, config value, comment edit');
			expect(prompt).toContain('No logic change');
		});

		it('should define MODERATE complexity level', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('MODERATE:');
			expect(prompt).toContain('logic change in single file');
			expect(prompt).toContain('new function');
			expect(prompt).toContain('modified control flow');
		});

		it('should define COMPLEX complexity level', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('COMPLEX:');
			expect(prompt).toContain('multi-file change');
			expect(prompt).toContain('new behavior');
			expect(prompt).toContain('schema change');
			expect(prompt).toContain('cross-cutting concern');
		});

		it('should specify review depth scaling by complexity', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('TRIVIAL→Tier 1 only');
			expect(prompt).toContain('MODERATE→Tiers 1-2');
			expect(prompt).toContain('COMPLEX→all three tiers');
		});

		it('should define Tier 1: CORRECTNESS', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('TIER 1: CORRECTNESS');
			expect(prompt).toContain('mandatory, always run');
			expect(prompt).toContain(
				'Does the code do what the task acceptance criteria require?',
			);
		});

		it('should enforce first-error focus in Tier 1', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('First-error focus:');
			expect(prompt).toContain('if you find a correctness issue, stop');
			expect(prompt).toContain('Report it');
			expect(prompt).toContain(
				'Do not continue to style or optimization issues',
			);
		});

		it('should define Tier 2: SAFETY', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('TIER 2: SAFETY');
			expect(prompt).toContain('mandatory for MODERATE+');
			expect(prompt).toContain('always for COMPLEX');
		});

		it('should implement anti-rubber-stamp in Tier 2', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('Anti-rubber-stamp:');
			expect(prompt).toContain('"No issues found" requires evidence');
			expect(prompt).toContain('State what you checked');
		});

		it('should define Tier 3: QUALITY', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('TIER 3: QUALITY');
			expect(prompt).toContain('run only for COMPLEX');
			expect(prompt).toContain('only if Tiers 1-2 pass');
		});

		it('should specify Tier 3 is advisory and informational', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('This tier is advisory');
			expect(prompt).toContain('QUALITY findings do not block approval');
			expect(prompt).toContain('Approval requires: Tier 1 PASS + Tier 2 PASS');
		});

		it('should prohibit "APPROVED but" pattern', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('Do NOT approve with caveats');
			expect(prompt).toContain('"APPROVED but fix X later" is not valid');
			expect(prompt).toContain("Either it passes or it doesn't");
		});

		it('should enforce token budget ≤800', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('Token budget ≤800 tokens');
			expect(prompt).toContain('VERBOSITY CONTROL');
		});

		it('should scale verbosity by complexity', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('TRIVIAL APPROVED = 2-3 lines');
			expect(prompt).toContain('COMPLEX REJECTED = full output');
			expect(prompt).toContain('Scale response to complexity');
		});

		it('should specify APPROVED verdict format', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('APPROVED: Tier 1 PASS, Tier 2 PASS');
			expect(prompt).toContain('[, Tier 3 notes if any]');
		});

		it('should specify REJECTED verdict format', async () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('REJECTED: Tier [1|2] FAIL');
			expect(prompt).toContain('[first error description]');
			expect(prompt).toContain('[specific fix instruction]');
		});
	});

	describe('Agent Configuration', () => {
		it('should create reviewer agent with correct name', () => {
			const agent = createReviewerAgent('gpt-4');

			expect(agent.name).toBe('reviewer');
		});

		it('should create reviewer agent with appropriate description', () => {
			const agent = createReviewerAgent('gpt-4');

			expect(agent.description).toContain('Code reviewer');
			expect(agent.description).toContain('correctness');
			expect(agent.description).toContain('vulnerabilities');
		});

		it('should configure reviewer as read-only', () => {
			const agent = createReviewerAgent('gpt-4');

			expect(agent.config.tools?.write).toBe(false);
			expect(agent.config.tools?.edit).toBe(false);
			expect(agent.config.tools?.patch).toBe(false);
		});

		it('should set low temperature for deterministic reviews', () => {
			const agent = createReviewerAgent('gpt-4');

			expect(agent.config.temperature).toBe(0.1);
		});

		it('should use specified model', () => {
			const model = 'gpt-4-turbo';
			const agent = createReviewerAgent(model);

			expect(agent.config.model).toBe(model);
		});
	});

	describe('Custom Prompt Handling', () => {
		it('should use customPrompt when provided', () => {
			const customPrompt = 'Custom prompt for testing';
			const agent = createReviewerAgent('gpt-4', customPrompt);

			expect(agent.config.prompt).toBe(customPrompt);
		});

		it('should append customAppendPrompt to default prompt', () => {
			const customAppend = '\n\nAdditional rules for testing';
			const agent = createReviewerAgent('gpt-4', undefined, customAppend);

			expect(agent.config.prompt).toContain('THREE TIERS');
			expect(agent.config.prompt).toContain(customAppend);
		});

		it('should use default prompt when no customizations provided', () => {
			const agent = createReviewerAgent('gpt-4');

			const prompt = agent.config.prompt as string;
			expect(prompt).toContain('THREE TIERS');
			expect(prompt).toContain('VERDICT FORMAT');
		});
	});

	describe('Output Format Verification', () => {
		it('should specify VERDICT field', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('VERDICT: APPROVED | REJECTED');
		});

		it('should specify RISK field', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('RISK: LOW | MEDIUM | HIGH | CRITICAL');
		});

		it('should specify ISSUES field', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain(
				'ISSUES: list with line numbers, grouped by CHECK dimension',
			);
			expect(prompt).not.toContain('"findings": [{');
		});

		it('should specify FIXES field', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('FIXES: required changes if rejected');
		});
	});

	describe('Risk Levels Definition', () => {
		it('should define LOW risk level', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('LOW: Code smell');
		});

		it('should define MEDIUM risk level', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('MEDIUM: Edge case');
		});

		it('should define HIGH risk level', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('HIGH: Logic error');
		});

		it('should define CRITICAL risk level', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('CRITICAL: Will crash');
		});
	});

	describe('Security Categories', () => {
		it('should export SECURITY_CATEGORIES array', () => {
			expect(Array.isArray(SECURITY_CATEGORIES)).toBe(true);
			expect(SECURITY_CATEGORIES.length).toBeGreaterThan(0);
		});

		it('should include essential OWASP security categories', () => {
			expect(SECURITY_CATEGORIES).toContain('broken-access-control');
			expect(SECURITY_CATEGORIES).toContain('cryptographic-failures');
			expect(SECURITY_CATEGORIES).toContain('injection');
			expect(SECURITY_CATEGORIES).toContain('insecure-design');
			expect(SECURITY_CATEGORIES).toContain('security-misconfiguration');
			expect(SECURITY_CATEGORIES).toContain('vulnerable-components');
			expect(SECURITY_CATEGORIES).toContain('auth-failures');
			expect(SECURITY_CATEGORIES).toContain('data-integrity-failures');
			expect(SECURITY_CATEGORIES).toContain('logging-monitoring-failures');
			expect(SECURITY_CATEGORIES).toContain('ssrf');
		});

		it('should have read-only security categories array', () => {
			// Using readonly assertion from TypeScript
			const categories: readonly string[] = SECURITY_CATEGORIES;
			expect(categories.length).toBe(10);
		});
	});

	describe('Edge Cases and Error Handling', () => {
		it('should treat empty customPrompt as falsy and use default', () => {
			const agent = createReviewerAgent('gpt-4', '');
			const prompt = agent.config.prompt as string;
			// Empty string is falsy, should use default prompt
			expect(prompt).toContain('THREE TIERS');
		});

		it('should handle empty customAppendPrompt', () => {
			const agent = createReviewerAgent('gpt-4', undefined, '');
			const prompt = agent.config.prompt as string;
			// Should still include the default prompt structure
			expect(prompt).toContain('THREE TIERS');
		});

		it('should handle whitespace in customAppendPrompt', () => {
			const agent = createReviewerAgent('gpt-4', undefined, '   ');
			const prompt = agent.config.prompt as string;
			expect(prompt).toContain('THREE TIERS');
		});

		it('should handle both customPrompt and customAppendPrompt (customPrompt wins)', () => {
			const customPrompt = 'Primary prompt';
			const customAppend = 'Append text';
			const agent = createReviewerAgent('gpt-4', customPrompt, customAppend);

			expect(agent.config.prompt).toBe(customPrompt);
		});
	});

	describe('Integrated Three-Tier Workflow Verification', () => {
		it('should enforce sequential tier execution', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			// Verify the order mentions Step 0 before Tier 1
			const step0Index = prompt.indexOf('STEP 0:');
			const tier1Index = prompt.indexOf('TIER 1:');
			expect(step0Index).toBeLessThan(tier1Index);
		});

		it('should require Step 0a to determine which tiers to run', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			// Verify complexity classification maps to tier execution
			expect(prompt).toContain('TRIVIAL→Tier 1 only');
			expect(prompt).toContain('MODERATE→Tiers 1-2');
			expect(prompt).toContain('COMPLEX→all three tiers');
		});

		it('should prevent quality findings from blocking approval', () => {
			const agent = createReviewerAgent('gpt-4');
			const prompt = agent.config.prompt as string;

			expect(prompt).toContain('QUALITY findings do not block approval');
			expect(prompt).toContain('Approval requires: Tier 1 PASS + Tier 2 PASS');
		});
	});
});

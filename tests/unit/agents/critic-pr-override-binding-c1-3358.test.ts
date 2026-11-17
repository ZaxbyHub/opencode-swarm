// AC1 (trace 3358-3337-3341; #3358 AC1 + #3337 AC1 critic leg): the PR-review
// lane override must not be baked into the default plan-critic prompt.
//
// Pins:
// - The exported PLAN_CRITIC_PROMPT (src/agents/critic.ts) and the default
//   critic agent's system prompt (createCriticAgent('m').config.prompt) carry
//   NO PR-review lane override text: neither the "PR-REVIEW LANE OVERRIDE"
//   banner nor the literal marker phrase "CONTROLLER-BOUND PR WORKFLOW
//   CONTRACT" may appear anywhere in a non-PR critic's instructions. Because
//   the phrase is entirely absent, no plan text, spec, or custom instruction
//   that merely QUOTES the phrase can flip a non-PR critic run into the PR
//   lane output contract — a non-PR prompt has no phrase-triggered clause at
//   all. Override activation is scoped by an explicit controller-authored
//   signal instead.
// - The default "Begin directly with PLAN REVIEW" mandate survives the
//   restructuring (non-PR critic behavior is textually unchanged apart from
//   losing the override).
//
// RED at base, GREEN after the fix.
import { describe, expect, test } from 'bun:test';
import * as criticModule from '../../../src/agents/critic.js';

type CriticFactory = (
	model: string,
	customPrompt?: string,
) => { config?: { prompt?: string } };

const mod = criticModule as unknown as {
	PLAN_CRITIC_PROMPT?: string;
	createCriticAgent?: CriticFactory;
};

function exportedPlanCriticPrompt(): string {
	expect(typeof mod.PLAN_CRITIC_PROMPT).toBe('string');
	return mod.PLAN_CRITIC_PROMPT ?? '';
}

function defaultCriticPrompt(): string {
	expect(typeof mod.createCriticAgent).toBe('function');
	const agent = mod.createCriticAgent?.('m');
	const prompt = agent?.config?.prompt;
	expect(typeof prompt).toBe('string');
	expect((prompt ?? '').length).toBeGreaterThan(0);
	return prompt ?? '';
}

// A non-PR critic prompt must mention neither the override banner nor the
// controller marker phrase: any occurrence of the phrase — conditional or
// not — is a prose activation channel for whatever clause cites it.
function expectNoPrLaneOverrideText(prompt: string): void {
	expect(prompt).not.toContain('PR-REVIEW LANE OVERRIDE');
	expect(prompt).not.toContain('CONTROLLER-BOUND PR WORKFLOW CONTRACT');
}

describe('AC1 — default plan-critic prompt carries no PR-review lane override (#3358/#3337)', () => {
	test('seam: PLAN_CRITIC_PROMPT and createCriticAgent are exported', () => {
		expect(typeof mod.PLAN_CRITIC_PROMPT).toBe('string');
		expect(typeof mod.createCriticAgent).toBe('function');
	});

	test('exported PLAN_CRITIC_PROMPT carries no PR-review lane override text', () => {
		const prompt = exportedPlanCriticPrompt();
		expectNoPrLaneOverrideText(prompt);
	});

	test('default critic agent prompt (createCriticAgent) carries no PR-review lane override text', () => {
		const prompt = defaultCriticPrompt();
		expectNoPrLaneOverrideText(prompt);
	});

	test('non-PR critic prompt has no phrase-triggered clause: quoting the marker cannot change its instructions', () => {
		// The discriminating property of the defect: the override activated on
		// the model judging the literal phrase "CONTROLLER-BOUND PR WORKFLOW
		// CONTRACT" present in its prompt. A prompt that never contains the
		// phrase cannot contain a clause conditioned on it — so a plan document
		// quoting the phrase has nothing to trigger.
		const prompt = defaultCriticPrompt();
		expect(prompt).not.toMatch(
			/CONTROLLER-BOUND PR WORKFLOW CONTRACT|PR-REVIEW LANE OVERRIDE/i,
		);
		// No conditional suspension of the default structure may remain keyed
		// on prompt text at all.
		expect(prompt).not.toMatch(/when a [^\n]{0,120}block is present/i);
	});

	test('default PLAN REVIEW mandate is preserved (Begin directly with PLAN REVIEW)', () => {
		for (const prompt of [exportedPlanCriticPrompt(), defaultCriticPrompt()]) {
			expect(prompt).toContain('Begin directly with PLAN REVIEW');
		}
	});
});

import { describe, expect, it } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import {
	createArchitectAgent,
	MAX_ARCHITECT_PROMPT_CHARS,
} from '../../../src/agents/architect';
import type { PluginConfig } from '../../../src/config';

/**
 * PROMPT BUDGET regression guard (issue #1649).
 *
 * The existing architect prompt tests only assert LOWER bounds
 * (`toBeGreaterThan(100000)` in architect-adversarial.test.ts,
 * `toBeGreaterThan(90000)` in critic.adversarial.test.ts), so the built-in
 * prompt could grow indefinitely with no CI signal — it in fact grew ~25% in
 * the six weeks before this guard was introduced. These tests pin an UPPER
 * bound on every reachable built-in render so bulk growth fails CI.
 *
 * The ceiling applies ONLY to built-in prompt renders. User-supplied
 * customPrompt/customAppendPrompt values are intentionally exempt — the
 * adversarial suite (architect-adversarial.test.ts "Attack Vector 8")
 * asserts 100KB user prompts are accepted without truncation.
 *
 * Zero mocks: pure prompt-render assertions (Tier 0 pattern).
 */

const testModel = 'test-model';

const featureHeavyConfig: PluginConfig = {
	council: { enabled: true },
	ui_review: { enabled: true },
	design_docs: { enabled: true },
	architectural_supervision: { enabled: true },
	adversarial_testing: { enabled: true, scope: 'all' },
	memory: { enabled: true },
	external_skills: { curation_enabled: true },
	skills: { enabled: true },
	turbo: { enabled: true },
} as unknown as PluginConfig;

describe('architect prompt budget — regression: unbounded growth (F#1649)', () => {
	it('default built-in render stays under the documented ceiling', () => {
		// Before this guard there was no upper-bound assertion anywhere: a bulk
		// addition to ARCHITECT_PROMPT grew the system prompt with zero CI signal.
		const agent = createArchitectAgent(testModel);
		const len = agent.config.prompt?.length ?? 0;
		expect(
			len,
			`default architect prompt is ${len} chars, ceiling is ${MAX_ARCHITECT_PROMPT_CHARS}. ` +
				'Justify the growth and raise MAX_ARCHITECT_PROMPT_CHARS in src/agents/architect.ts, ' +
				'or trim hardening prose.',
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
	});

	it('maximal opt-in feature render stays under the ceiling', () => {
		// Every feature block (council, supervision, design docs, ui_review,
		// memory, external skills, turbo, skills, adversarial scope=all) is the
		// largest built-in render reachable — the ceiling must bound it, not
		// just the default.
		const agent = createArchitectAgent(
			testModel,
			undefined,
			undefined,
			{ enabled: true, scope: 'all' },
			{ enabled: true },
			{ enabled: true },
			true,
			{ enabled: true },
			true,
			true,
			true,
			true,
		);
		const len = agent.config.prompt?.length ?? 0;
		expect(
			len,
			`all-features architect prompt is ${len} chars, ceiling is ${MAX_ARCHITECT_PROMPT_CHARS}.`,
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
	});

	it('full init pipeline (getAgentConfigs, default config) stays under the ceiling', () => {
		// Chain B (src/agents/index.ts) substitutes SWARM_ID, AGENT_PREFIX,
		// project-context sentinels, and constraint blocks AFTER
		// createArchitectAgent returns — the shipped prompt is what the model
		// sees, so bound the post-pipeline size, not just the factory output.
		const configs = getAgentConfigs();
		const len = configs.architect?.prompt?.length ?? 0;
		expect(
			len,
			`pipeline default architect prompt is ${len} chars, ceiling is ${MAX_ARCHITECT_PROMPT_CHARS}.`,
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
	});

	it('full init pipeline with every opt-in feature stays under the ceiling', () => {
		const configs = getAgentConfigs(featureHeavyConfig);
		const len = configs.architect?.prompt?.length ?? 0;
		expect(
			len,
			`pipeline feature-heavy architect prompt is ${len} chars, ceiling is ${MAX_ARCHITECT_PROMPT_CHARS}.`,
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
	});

	it('prefixed non-default swarm render stays under the ceiling', () => {
		// {{AGENT_PREFIX}} resolves to "cloud_" here — a non-empty prefix
		// inflates every prefixed reference; bound that render too.
		const configs = getAgentConfigs({
			swarms: { cloud: { name: 'Cloud Swarm', agents: {} } },
			...featureHeavyConfig,
		} as unknown as PluginConfig);
		const len = configs.cloud_architect?.prompt?.length ?? 0;
		expect(
			len,
			`prefixed feature-heavy architect prompt is ${len} chars, ceiling is ${MAX_ARCHITECT_PROMPT_CHARS}.`,
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
	});

	it('adversarial scope variants stay under the ceiling', () => {
		// scope='security-only' and enabled=false each replace
		// {{ADVERSARIAL_TEST_STEP}} with different-length text — both must
		// stay bounded.
		const securityOnly = createArchitectAgent(testModel, undefined, undefined, {
			enabled: true,
			scope: 'security-only',
		});
		const disabled = createArchitectAgent(testModel, undefined, undefined, {
			enabled: false,
			scope: 'all',
		});
		expect(
			securityOnly.config.prompt?.length ?? 0,
			'security-only scope render exceeds ceiling',
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
		expect(
			disabled.config.prompt?.length ?? 0,
			'adversarial-disabled render exceeds ceiling',
		).toBeLessThan(MAX_ARCHITECT_PROMPT_CHARS);
	});
});

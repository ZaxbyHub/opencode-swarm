import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentConfigs } from '../../../src/agents';
import {
	ARCHITECT_PROMPT_BUDGET_CHARS,
	createArchitectAgent,
} from '../../../src/agents/architect';
import type { PluginConfig } from '../../../src/config';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
 * Environment isolation: `getAgentConfigs()` -> `createAgents()` ->
 * `loadAgentPrompt('architect')` (`src/config/loader.ts:875`) reads
 * `$XDG_CONFIG_HOME/opencode/opencode-swarm/{architect,architect_append}.md`.
 * Without isolation a developer who has a custom prompt in their config
 * directory silently shrinks the measured length, defeating growth detection.
 * We point XDG_CONFIG_HOME at an empty tempdir so the built-in prompt is the
 * one being measured — same pattern as `placeholder-safety-net.test.ts`.
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
	turbo: { enabled: true, strategy: 'standard' },
} as unknown as PluginConfig;

// Lower-bound baseline pin: caught the 104K -> 129K growth that #1649 was filed
// to prevent. If a PR adds bulk prose that drops the default below 100K chars
// (the floor previously asserted by architect-adversarial.test.ts), this
// guard fails. Combined with the ceiling, the render must stay within the
// documented window — silent growth is impossible and silent shrinkage is
// impossible.
const DEFAULT_FLOOR_CHARS = 100_000;
const FEATURE_HEAVY_FLOOR_CHARS = 140_000;

describe('architect prompt budget — regression: unbounded growth (F#1649)', () => {
	let prevXdg: string | undefined;
	let cfgDir: string;

	beforeEach(() => {
		prevXdg = process.env.XDG_CONFIG_HOME;
		// canonicalMkdtemp returns a realpath-resolved tempdir, closing the
		// macOS /var -> /private/var symlink gap (FR-011, issue #1737). The
		// loadAgentPrompt path resolves via getUserConfigDir() which uses
		// `process.env.XDG_CONFIG_HOME || ~/.config`, so any symlink in the
		// chain would silently route us to a different directory on macOS.
		cfgDir = canonicalMkdtemp('swarm-prompt-budget-');
		// loadAgentPrompt reads $XDG_CONFIG_HOME/opencode/opencode-swarm/<agent>.md
		mkdirSync(join(cfgDir, 'opencode', 'opencode-swarm'), { recursive: true });
		process.env.XDG_CONFIG_HOME = cfgDir;
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		rmSync(cfgDir, { recursive: true, force: true });
	});

	it('default built-in render stays under the documented ceiling', () => {
		// Before this guard there was no upper-bound assertion anywhere: a bulk
		// addition to ARCHITECT_PROMPT grew the system prompt with zero CI signal.
		const agent = createArchitectAgent(testModel);
		const len = agent.config.prompt?.length ?? 0;
		expect(
			len,
			`default architect prompt is ${len} chars, ceiling is ${ARCHITECT_PROMPT_BUDGET_CHARS}. ` +
				'Justify the growth and raise ARCHITECT_PROMPT_BUDGET_CHARS in src/agents/architect.ts, ' +
				'or trim hardening prose.',
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
		// Floor: catches silent shrinkage too (e.g. a refactor that drops a
		// hardening block). The documented baseline at introduction (~129K) must
		// remain above 100K — the existing floor in architect-adversarial.test.ts
		// pin is reproduced here so a regression that drops below the floor fails
		// both suites, not just one.
		expect(
			len,
			`default architect prompt is ${len} chars, floor is ${DEFAULT_FLOOR_CHARS}. ` +
				'Investigate the regression that shrunk the prompt below the documented floor.',
		).toBeGreaterThan(DEFAULT_FLOOR_CHARS);
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
			`all-features architect prompt is ${len} chars, ceiling is ${ARCHITECT_PROMPT_BUDGET_CHARS}.`,
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
		expect(
			len,
			`all-features architect prompt is ${len} chars, floor is ${FEATURE_HEAVY_FLOOR_CHARS}. ` +
				'All opt-in feature blocks must still be present.',
		).toBeGreaterThan(FEATURE_HEAVY_FLOOR_CHARS);
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
			`pipeline default architect prompt is ${len} chars, ceiling is ${ARCHITECT_PROMPT_BUDGET_CHARS}.`,
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
	});

	it('full init pipeline with every opt-in feature stays under the ceiling', () => {
		const configs = getAgentConfigs(featureHeavyConfig);
		const len = configs.architect?.prompt?.length ?? 0;
		expect(
			len,
			`pipeline feature-heavy architect prompt is ${len} chars, ceiling is ${ARCHITECT_PROMPT_BUDGET_CHARS}.`,
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
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
			`prefixed feature-heavy architect prompt is ${len} chars, ceiling is ${ARCHITECT_PROMPT_BUDGET_CHARS}.`,
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
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
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
		expect(
			disabled.config.prompt?.length ?? 0,
			'adversarial-disabled render exceeds ceiling',
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
	});

	it("adversarial default scope (enabled=true, scope='all') stays under the ceiling", () => {
		// PRR-007: when `adversarialTesting` is `{ enabled: true, scope: 'all' }`
		// — the Zod-schema-defaulted scope — the production code substitutes the
		// same template content as `scope: undefined`. The TS type asserts
		// `scope` is required, so the literal-default path is exercised here.
		const agent = createArchitectAgent(testModel, undefined, undefined, {
			enabled: true,
			scope: 'all',
		});
		expect(
			agent.config.prompt?.length ?? 0,
			'default-scope adversarial render exceeds ceiling',
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
	});

	it('multi-swarm prefix render stays under the ceiling', () => {
		// PRR-008: with two non-default swarms, both prefixed architects are
		// generated. A regression that, say, doubled prefix tokens would only
		// show up in the multi-swarm path.
		const configs = getAgentConfigs({
			swarms: {
				cloud: { name: 'Cloud Swarm', agents: {} },
				mega: { name: 'Mega Swarm', agents: {} },
			},
			...featureHeavyConfig,
		} as unknown as PluginConfig);
		expect(
			configs.cloud_architect?.prompt?.length ?? 0,
			'multi-swarm cloud_architect exceeds ceiling',
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
		expect(
			configs.mega_architect?.prompt?.length ?? 0,
			'multi-swarm mega_architect exceeds ceiling',
		).toBeLessThan(ARCHITECT_PROMPT_BUDGET_CHARS);
	});
});

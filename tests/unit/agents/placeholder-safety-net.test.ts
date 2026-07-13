import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentConfigs } from '../../../src/agents';
import { assertNoUnresolvedPlaceholders } from '../../../src/agents/template';
import type { PluginConfig } from '../../../src/config';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';

// M12 dead-safety-net fix: the hand-rolled `.replace()` chains that assemble
// each agent's final system prompt never validated for leftover `{{KEY}}`
// placeholders (renderPrompt's guard was dead). createSwarmAgents now asserts
// over every agent's FINAL prompt via assertNoUnresolvedPlaceholders. These
// tests lock in the reachable guard end-to-end and pin the no-false-throw
// behavior on the architect's `{{...}}` prose literal.

const minimalConfig = (partial: Partial<PluginConfig> = {}): PluginConfig =>
	partial as PluginConfig;

// Match the exact placeholder shape the production guard scans for.
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/;

describe('placeholder safety net — full init pipeline (M12)', () => {
	test('default config: no agent final prompt contains an unresolved {{KEY}}', () => {
		const configs = getAgentConfigs();
		const offenders: string[] = [];
		for (const [name, config] of Object.entries(configs)) {
			if (
				typeof config.prompt === 'string' &&
				PLACEHOLDER_RE.test(config.prompt)
			) {
				offenders.push(`${name}: ${config.prompt.match(PLACEHOLDER_RE)?.[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test('feature-heavy config (council + ui_review + design_docs + adversarial): still no leftover {{KEY}}', () => {
		// Enabling opt-in features exercises the substitution branches that
		// INJECT further `{{AGENT_PREFIX}}` tokens (e.g. adversarial-test step),
		// which Chain B must then resolve. If any branch leaks, the guard throws
		// during getAgentConfigs and this call rejects.
		const config = minimalConfig({
			council: { enabled: true } as PluginConfig['council'],
			ui_review: { enabled: true } as PluginConfig['ui_review'],
			design_docs: { enabled: true } as PluginConfig['design_docs'],
			architectural_supervision: {
				enabled: true,
			} as PluginConfig['architectural_supervision'],
			adversarial_testing: {
				enabled: true,
				scope: 'all',
			} as PluginConfig['adversarial_testing'],
		});
		let configs: ReturnType<typeof getAgentConfigs> | undefined;
		expect(() => {
			configs = getAgentConfigs(config);
		}).not.toThrow();
		for (const [name, agentConfig] of Object.entries(configs ?? {})) {
			if (typeof agentConfig.prompt === 'string') {
				expect(
					PLACEHOLDER_RE.test(agentConfig.prompt),
					`agent "${name}" leaked a placeholder`,
				).toBe(false);
			}
		}
	});

	test('prefixed (non-default) swarm architect resolves all {{KEY}} tokens', () => {
		// {{AGENT_PREFIX}} resolves to "cloud_" here (non-empty), exercising the
		// prefixed branch. A leak in the prefixed architect prompt would throw.
		let configs: ReturnType<typeof getAgentConfigs> | undefined;
		expect(() => {
			configs = getAgentConfigs(
				minimalConfig({
					swarms: { cloud: { name: 'Cloud Swarm', agents: {} } },
				}),
			);
		}).not.toThrow();
		const architect = configs?.['cloud_architect'];
		expect(architect).toBeDefined();
		expect(typeof architect?.prompt).toBe('string');
		expect(PLACEHOLDER_RE.test(architect?.prompt as string)).toBe(false);
	});
});

describe('placeholder safety net — architect prose literal no-false-throw (M12)', () => {
	test('architect final prompt contains the literal `{{...}}` teaching text', () => {
		const configs = getAgentConfigs();
		const architect = configs['architect'];
		expect(architect).toBeDefined();
		// architect.ts:100 teaches the model what an unresolved field looks like
		// with a literal `{{...}}`. It must survive substitution verbatim.
		expect(architect.prompt as string).toContain('{{...}}');
	});

	test('the guard does NOT throw on the architect prompt despite the `{{...}}` literal', () => {
		const configs = getAgentConfigs();
		const architect = configs['architect'];
		// `...` is not `[A-Z_]`, so the `[A-Z_]+` class never matches the prose
		// literal. Re-running the guard directly proves it (getAgentConfigs
		// already ran it once without throwing).
		expect(() =>
			assertNoUnresolvedPlaceholders(architect.prompt as string, 'architect'),
		).not.toThrow();
	});
});

describe('assertNoUnresolvedPlaceholders — unit behavior (M12)', () => {
	test('throws on an unresolved {{FOO_BAR}}, naming the key and the agent', () => {
		expect(() =>
			assertNoUnresolvedPlaceholders('prefix {{FOO_BAR}} suffix', 'coder'),
		).toThrow(/\{\{FOO_BAR\}\}/);
		expect(() =>
			assertNoUnresolvedPlaceholders('prefix {{FOO_BAR}} suffix', 'coder'),
		).toThrow(/coder/);
	});

	test('lists multiple distinct offenders once each', () => {
		let message = '';
		try {
			assertNoUnresolvedPlaceholders('{{ALPHA}} {{BETA}} {{ALPHA}}', 'sme');
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toContain('{{ALPHA}}');
		expect(message).toContain('{{BETA}}');
		// De-duplicated: {{ALPHA}} appears exactly once in the message list.
		expect(message.match(/\{\{ALPHA\}\}/g)?.length).toBe(1);
	});

	test('does NOT throw on the `{{...}}` prose literal (regex class is [A-Z_]+)', () => {
		expect(() =>
			assertNoUnresolvedPlaceholders(
				'If any field is `{{...}}` (unresolved): run MODE: DISCOVER',
				'architect',
			),
		).not.toThrow();
	});

	test('does NOT throw on ordinary curly-brace / JSON text', () => {
		expect(() =>
			assertNoUnresolvedPlaceholders(
				'Output: {"x": 1} and {{lowercase}}',
				'docs',
			),
		).not.toThrow();
	});

	test('does NOT throw on a fully-resolved prompt', () => {
		expect(() =>
			assertNoUnresolvedPlaceholders(
				'All resolved, no templates here.',
				'explorer',
			),
		).not.toThrow();
	});
});

describe('placeholder safety net — fail-open at init (F-001)', () => {
	let prevXdg: string | undefined;
	let cfgDir: string;

	beforeEach(() => {
		prevXdg = process.env.XDG_CONFIG_HOME;
		cfgDir = mkdtempSync(join(tmpdir(), 'swarm-f001-'));
		// loadAgentPrompt reads $XDG_CONFIG_HOME/opencode/opencode-swarm/<agent>.md
		mkdirSync(join(cfgDir, 'opencode', 'opencode-swarm'), { recursive: true });
		process.env.XDG_CONFIG_HOME = cfgDir;
		clearDeferredWarnings();
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		rmSync(cfgDir, { recursive: true, force: true });
		clearDeferredWarnings();
	});

	test('default (built-in) prompts produce NO placeholder warning — regression guard for our own prompts', () => {
		// No custom prompt files written → all agents use built-in prompts.
		clearDeferredWarnings();
		getAgentConfigs();
		const placeholderWarnings = getDeferredWarnings().filter((w) =>
			/unresolved placeholder/i.test(w),
		);
		expect(placeholderWarnings).toEqual([]);
	});

	test('a user custom prompt with a literal {{UPPER_KEY}} does NOT crash init — it warns and registers the agent anyway', () => {
		// A user-authored custom prompt is used verbatim (no substitution for
		// Type-A agents), so a literal {{WARNING}} in prose would reach the
		// assertion. Before the fail-open fix this threw out of getAgentConfigs →
		// initializeOpenCodeSwarm (fail-closed outer catch) → whole plugin dropped.
		writeFileSync(
			join(cfgDir, 'opencode', 'opencode-swarm', 'coder.md'),
			'You are the coder.\nNote: a field like {{WARNING}} is unresolved.\n',
			'utf8',
		);
		clearDeferredWarnings();

		let configs: ReturnType<typeof getAgentConfigs> | undefined;
		expect(() => {
			configs = getAgentConfigs();
		}).not.toThrow();

		// The coder agent is still registered (init not aborted).
		expect(configs?.coder).toBeDefined();

		// And the leftover placeholder surfaced as a deferred warning naming the
		// key and the agent.
		const warnings = getDeferredWarnings();
		expect(warnings.some((w) => /\{\{WARNING\}\}/.test(w))).toBe(true);
		expect(warnings.some((w) => /coder/.test(w))).toBe(true);
	});
});

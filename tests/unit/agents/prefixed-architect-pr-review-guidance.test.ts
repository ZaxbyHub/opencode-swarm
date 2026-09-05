/**
 * Prefixed agents carry the PR_REVIEW controller guidance (issue #2494, AC6).
 *
 * Registration tests assert mode/presence only; this test renders the ACTUAL
 * prompt of multi-swarm prefixed architects (local_architect, mega_architect)
 * and asserts the MODE: PR_REVIEW guidance, the bundled swarm-pr-review skill
 * load instruction, and the controller tools (dispatch_lanes_async,
 * complete_pr_workflow) in BOTH rendered availability lists (YOUR TOOLS and
 * Available Tools). This pins the rendered guidance/tool surface a prefixed
 * architect actually sees, without duplicating #2526's host message-converter
 * tests or #2529's task/Task normalization.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const minimalConfig = (partial: Partial<PluginConfig> = {}): PluginConfig =>
	partial as PluginConfig;

const multiSwarmConfig = (): PluginConfig =>
	minimalConfig({
		swarms: {
			local: {
				name: 'Local Swarm',
				agents: {},
			},
			mega: {
				name: 'Mega Swarm',
				agents: {},
			},
		},
	});

interface RenderedPrompt {
	mode: string | undefined;
	prompt: string;
	yourTools: string;
	availableTools: string;
}

function renderArchitect(
	configs: ReturnType<typeof getAgentConfigs>,
	name: string,
): RenderedPrompt {
	const agent = configs[name];
	expect(agent).toBeDefined();
	const prompt = agent.prompt ?? '';
	// The architect prompt renders exactly one "YOUR TOOLS: ..." line and one
	// "Available Tools: ..." line (src/agents/architect.ts buildYourToolsList /
	// buildAvailableToolsList substitute {{YOUR_TOOLS}} / {{AVAILABLE_TOOLS}}).
	const yourTools = prompt.match(/^YOUR TOOLS: (.+)$/m)?.[1] ?? '';
	const availableTools = prompt.match(/^Available Tools: (.+)$/m)?.[1] ?? '';
	return {
		mode: agent.mode,
		prompt,
		yourTools,
		availableTools,
	};
}

describe('prefixed architect PR_REVIEW guidance (issue #2494 AC6)', () => {
	let prevXdg: string | undefined;
	let cfgDir: string;

	beforeEach(() => {
		// Isolate XDG_CONFIG_HOME (architect-prompt-budget idiom): loadAgentPrompt
		// reads $XDG_CONFIG_HOME/opencode/opencode-swarm/architect.md and a
		// developer replacement prompt wholesale-replaces ARCHITECT_PROMPT, which
		// would make these content assertions fail on that machine while CI stays
		// green. canonicalMkdtemp is FR-011-compliant (realpath'd temp root).
		prevXdg = process.env.XDG_CONFIG_HOME;
		cfgDir = canonicalMkdtemp('swarm-prefixed-architect-');
		mkdirSync(join(cfgDir, 'opencode', 'opencode-swarm'), { recursive: true });
		process.env.XDG_CONFIG_HOME = cfgDir;
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		rmSync(cfgDir, { recursive: true, force: true });
	});

	test('local_architect renders MODE: PR_REVIEW guidance with controller tools', () => {
		const configs = getAgentConfigs(multiSwarmConfig());
		const local = renderArchitect(configs, 'local_architect');

		expect(local.mode).toBe('primary');

		// PR_REVIEW mode guidance is present in the rendered prompt. The '###'
		// section-header form is pinned specifically: a bare 'MODE: PR_REVIEW'
		// substring also occurs in the PR_FEEDBACK cross-reference, so the plain
		// toContain survives removal of the entire guidance section.
		expect(local.prompt).toContain('### MODE: PR_REVIEW');
		// The bundled swarm-pr-review skill load instruction is present.
		expect(local.prompt).toContain('swarm-pr-review/SKILL.md');
		// The PR_REVIEW guidance carries the terminal machine verdict surface
		// (report_verdict, the enum behind complete_pr_workflow).
		expect(local.prompt).toContain('report_verdict');

		// Controller tools appear in BOTH rendered availability lists.
		expect(local.yourTools).not.toBe('');
		expect(local.yourTools).toContain('dispatch_lanes_async');
		expect(local.yourTools).toContain('complete_pr_workflow');
		expect(local.availableTools).not.toBe('');
		expect(local.availableTools).toContain('dispatch_lanes_async');
		expect(local.availableTools).toContain('complete_pr_workflow');
	});

	test('mega_architect renders the same PR_REVIEW guidance with controller tools', () => {
		const configs = getAgentConfigs(multiSwarmConfig());
		const mega = renderArchitect(configs, 'mega_architect');

		expect(mega.mode).toBe('primary');
		expect(mega.prompt).toContain('MODE: PR_REVIEW');
		expect(mega.prompt).toContain('swarm-pr-review/SKILL.md');
		expect(mega.prompt).toContain('report_verdict');
		expect(mega.yourTools).not.toBe('');
		expect(mega.yourTools).toContain('dispatch_lanes_async');
		expect(mega.yourTools).toContain('complete_pr_workflow');
		expect(mega.availableTools).not.toBe('');
		expect(mega.availableTools).toContain('dispatch_lanes_async');
		expect(mega.availableTools).toContain('complete_pr_workflow');
	});

	test('both prefixed architects render identical PR_REVIEW tool availability', () => {
		const configs = getAgentConfigs(multiSwarmConfig());
		const local = renderArchitect(configs, 'local_architect');
		const mega = renderArchitect(configs, 'mega_architect');

		// Prefixed swarms differ in identity, not in capability surface: the
		// rendered controller-tool lists must be identical so no swarm prefix
		// silently loses PR_REVIEW executability.
		expect(local.yourTools).toBe(mega.yourTools);
		expect(local.availableTools).toBe(mega.availableTools);
	});
});

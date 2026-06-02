/**
 * Verifies the docs_design role variant of the docs agent (issue #1080):
 * - the 'design_docs' role produces a distinct name + design-doc prompt,
 * - both roles inherit the built-in write/edit tools (no `tools.write === false`),
 * - docs_design is wired into the canonical agent registries,
 * - docs_design registers ONLY when design_docs.enabled === true (opt-in).
 */

import { describe, expect, it } from 'bun:test';
import { getAgentConfigs } from '../../../src/agents';
import { createDocsAgent } from '../../../src/agents/docs';
import type { PluginConfig } from '../../../src/config';
import {
	AGENT_TOOL_MAP,
	ALL_AGENT_NAMES,
	ALL_SUBAGENT_NAMES,
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_MODELS,
} from '../../../src/config/constants';

describe('createDocsAgent role variants', () => {
	it('defaults to the standard docs synthesizer', () => {
		const def = createDocsAgent('opencode/big-pickle');
		expect(def.name).toBe('docs');
		expect(def.config.prompt).toMatch(/documentation synthesizer/i);
	});

	it('design_docs role yields name docs_design and a design-doc prompt', () => {
		const def = createDocsAgent(
			'opencode/big-pickle',
			undefined,
			undefined,
			'design_docs',
		);
		expect(def.name).toBe('docs_design');
		expect(def.config.prompt).toMatch(/Design-Doc Author/);
		expect(def.config.prompt).toMatch(/traceability\.json/);
		expect(def.config.prompt).toMatch(/language-agnostic/i);
		expect(def.config.prompt).toMatch(/behavior-spec\.md/);
	});

	it('both roles inherit write/edit (no tools block forcing them off)', () => {
		// The docs agent (both roles) must NOT set write/edit to false — that is
		// what lets it author documentation. Guards the load-bearing fact in #1080.
		const standard = createDocsAgent('m');
		const design = createDocsAgent('m', undefined, undefined, 'design_docs');
		const standardTools = (
			standard.config as { tools?: Record<string, unknown> }
		).tools;
		const designTools = (design.config as { tools?: Record<string, unknown> })
			.tools;
		expect(standardTools?.write).not.toBe(false);
		expect(standardTools?.edit).not.toBe(false);
		expect(designTools?.write).not.toBe(false);
		expect(designTools?.edit).not.toBe(false);
	});

	it('respects an independent model for the design role', () => {
		const def = createDocsAgent(
			'opencode/cheap',
			undefined,
			undefined,
			'design_docs',
		);
		expect(def.config.model).toBe('opencode/cheap');
	});
});

describe('docs_design registration in canonical registries', () => {
	it('is in ALL_AGENT_NAMES and ALL_SUBAGENT_NAMES', () => {
		expect(ALL_AGENT_NAMES).toContain('docs_design');
		expect(ALL_SUBAGENT_NAMES).toContain('docs_design');
	});

	it('has default model + agent config entries', () => {
		expect(DEFAULT_MODELS.docs_design).toBeDefined();
		expect(DEFAULT_AGENT_CONFIGS.docs_design).toBeDefined();
		expect(
			DEFAULT_AGENT_CONFIGS.docs_design.fallback_models.length,
		).toBeGreaterThan(0);
	});

	it('has a tool whitelist with doc indexing but no destructive plan tools', () => {
		const tools = AGENT_TOOL_MAP.docs_design;
		expect(tools).toContain('doc_scan');
		expect(tools).toContain('doc_extract');
		expect(tools).toContain('search');
		// write/edit are SDK built-ins, never swarm ToolNames in the map.
		expect(tools).not.toContain('write' as never);
		expect(tools).not.toContain('save_plan');
		expect(tools).not.toContain('phase_complete');
	});
});

describe('docs_design opt-in registration', () => {
	it('is registered only when design_docs.enabled === true', () => {
		const disabled = getAgentConfigs({} as unknown as PluginConfig);
		expect(disabled.docs_design).toBeUndefined();
		// The standard docs agent is always present (enabled by default).
		expect(disabled.docs).toBeDefined();

		const enabled = getAgentConfigs({
			design_docs: { enabled: true },
		} as unknown as PluginConfig);
		expect(enabled.docs_design).toBeDefined();
		expect(enabled.docs_design.mode).toBe('subagent');
	});
});

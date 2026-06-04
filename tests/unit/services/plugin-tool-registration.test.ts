import { describe, expect, test } from 'bun:test';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';

/**
 * Regression guard for the council-tools-missing-from-plugin bug.
 *
 * Commit 62faff3 ("feat(council): add Work Complete Council verification gate")
 * added submit_council_verdicts and declare_council_criteria to AGENT_TOOL_MAP.architect,
 * implemented the tool modules, and exported them — but forgot to wire them into
 * the plugin's tool object. Result: the architect system prompt told the model to
 * call tools that opencode had never registered, so no model could invoke them.
 *
 * As of #507 both AGENT_TOOL_MAP and the plugin tool object derive from the single
 * TOOL_MANIFEST, so this class of drift is structurally impossible. This test now
 * asserts that every tool referenced by any agent in AGENT_TOOL_MAP is present in
 * the REAL derived plugin tool object (buildPluginToolObject) — guarding the
 * derivation rather than parsing source text.
 */
describe('plugin tool registration alignment', () => {
	const registered = new Set(Object.keys(buildPluginToolObject({})));

	test('council tools are registered in plugin tool block', () => {
		expect(registered.has('submit_council_verdicts')).toBe(true);
		expect(registered.has('declare_council_criteria')).toBe(true);
	});

	test('swarm_command is registered in plugin tool block', () => {
		expect(registered.has('swarm_command')).toBe(true);
	});

	test('every AGENT_TOOL_MAP tool is registered in plugin tool block', () => {
		const missing: Array<{ agent: string; tool: string }> = [];
		for (const [agent, tools] of Object.entries(AGENT_TOOL_MAP)) {
			for (const tool of tools) {
				if (!registered.has(tool)) {
					missing.push({ agent, tool });
				}
			}
		}
		if (missing.length > 0) {
			const lines = missing
				.map(({ agent, tool }) => `  - ${agent}.${tool}`)
				.join('\n');
			throw new Error(
				`The following tools are declared in AGENT_TOOL_MAP but not registered in src/index.ts tool: { }:\n${lines}\n\nAdd them to the import block and to the plugin's tool registration object.`,
			);
		}
		expect(missing).toEqual([]);
	});
});

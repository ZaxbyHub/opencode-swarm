import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';

/**
 * Extracts the YOUR TOOLS list from the architect prompt.
 * The prompt contains a line like:
 * YOUR TOOLS: Task (delegation), checkpoint, check_gate_status, ...
 */
function extractPromptTools(prompt: string): string[] {
	const match = prompt.match(/YOUR TOOLS:\s*(.+?)(?:\n|$)/);
	if (!match) return [];
	return match[1]
		.replace(/\.$/, '') // Remove trailing period
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

describe('architect prompt tool alignment', () => {
	test('YOUR TOOLS with both councils enabled matches full AGENT_TOOL_MAP architect entry', () => {
		// Both council.enabled=true AND council.general.enabled=true expose the
		// full AGENT_TOOL_MAP.architect surface (submit_council_verdicts,
		// declare_council_criteria, convene_general_council). This is the only
		// configuration where YOUR TOOLS matches the map exactly.
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true, general: { enabled: true } },
		);
		const prompt =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		const promptTools = extractPromptTools(prompt);
		const mapTools = [...AGENT_TOOL_MAP.architect].sort();

		// Remove 'Task (delegation)' from prompt tools — it's the built-in delegation tool, not in AGENT_TOOL_MAP
		const promptToolsWithoutTask = promptTools
			.filter((t) => t !== 'Task (delegation)')
			.sort();

		expect(promptToolsWithoutTask).toEqual(mapTools);
	});

	test('YOUR TOOLS with all councils disabled (default) excludes the three council tools', () => {
		// Default no-arg call: council is undefined, which the prompt builder
		// treats as disabled. submit_council_verdicts, declare_council_criteria,
		// submit_phase_council_verdicts, and convene_general_council must all be
		// filtered out so the model is not shown phantom tools the runtime gates would reject.
		const agent = createArchitectAgent('test-model');
		const prompt =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		const promptTools = extractPromptTools(prompt);
		const expected = [...AGENT_TOOL_MAP.architect]
			.filter(
				(t) =>
					t !== 'submit_council_verdicts' &&
					t !== 'declare_council_criteria' &&
					t !== 'submit_phase_council_verdicts' &&
					t !== 'convene_general_council',
			)
			.sort();

		const promptToolsWithoutTask = promptTools
			.filter((t) => t !== 'Task (delegation)')
			.sort();

		expect(promptToolsWithoutTask).toEqual(expected);
		expect(promptToolsWithoutTask).not.toContain('submit_council_verdicts');
		expect(promptToolsWithoutTask).not.toContain('declare_council_criteria');
		expect(promptToolsWithoutTask).not.toContain(
			'submit_phase_council_verdicts',
		);
		expect(promptToolsWithoutTask).not.toContain('convene_general_council');
	});

	test('YOUR TOOLS with QA council on but general off includes QA tools, excludes general', () => {
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true },
		);
		const prompt =
			((agent.config as Record<string, unknown>).prompt as string) ?? '';

		const promptTools = extractPromptTools(prompt);
		expect(promptTools).toContain('submit_council_verdicts');
		expect(promptTools).toContain('declare_council_criteria');
		expect(promptTools).not.toContain('convene_general_council');
	});
});

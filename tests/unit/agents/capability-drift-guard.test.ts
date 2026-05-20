import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import {
	AGENT_TOOL_MAP,
	type AgentName,
	ALL_SUBAGENT_NAMES,
	ORCHESTRATOR_NAME,
	TOOL_DESCRIPTIONS,
	WRITE_TOOL_NAMES,
} from '../../../src/config/constants';

/**
 * Drift guard tests for prompt/config capability alignment.
 * These CI guard tests fail if capability surfaces drift from their shared sources.
 * Pure in-memory checks — no I/O.
 */

// ---------------------------------------------------------------------------
// Helper: extract YOUR TOOLS tool names from resolved prompt
// ---------------------------------------------------------------------------
function extractYourToolsNames(prompt: string): string[] {
	// Find line like: "YOUR TOOLS: Task (delegation), tool1, tool2, ..."
	const match = prompt.match(/^YOUR TOOLS:\s*(.+?)$/m);
	if (!match) return [];

	// Strip "Task (delegation)," prefix, then parse comma-separated names
	return match[1]
		.replace(/^Task\s*\(delegation\),\s*/, '')
		.replace(/\.\s*$/, '') // trailing period
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Helper: extract Available Tools tool names from resolved prompt
// ---------------------------------------------------------------------------
function extractAvailableToolsNames(prompt: string): string[] {
	// Find line like: "Available Tools: tool1 (desc), tool2 (desc), ..."
	const match = prompt.match(/^Available Tools:\s*(.+?)$/m);
	if (!match) return [];

	const line = match[1];
	const segments: string[] = [];
	let current = '';
	let depth = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			segments.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) segments.push(current.trim());

	return segments
		.map((seg) => seg.match(/^(\w+)/)?.[1])
		.filter(Boolean) as string[];
}

// ---------------------------------------------------------------------------
// Shared setup: resolved architect prompt
// ---------------------------------------------------------------------------
const ARCHITECT_TOOL_COUNT = AGENT_TOOL_MAP.architect.length;

// Render with both councils enabled so the full AGENT_TOOL_MAP.architect
// surface (including `submit_council_verdicts`, `declare_council_criteria`, AND
// `convene_general_council`) appears in YOUR TOOLS and Available Tools.
// Without council/general enabled, those tools are filtered out — see
// architect-tool-visibility-council.test.ts and architect-tool-alignment.test.ts
// for the council-off behavior.
const resolvedPrompt = (() => {
	const agent = createArchitectAgent(
		'test-model',
		undefined,
		undefined,
		undefined,
		{ enabled: true, general: { enabled: true } },
	);
	return agent.config.prompt ?? '';
})();

// ---------------------------------------------------------------------------
// GROUP 1: YOUR TOOLS prompt list matches AGENT_TOOL_MAP.architect
// ---------------------------------------------------------------------------
describe('YOUR TOOLS prompt list matches AGENT_TOOL_MAP.architect', () => {
	test('every tool in AGENT_TOOL_MAP.architect appears in YOUR TOOLS line', () => {
		const yourTools = extractYourToolsNames(resolvedPrompt);
		for (const tool of AGENT_TOOL_MAP.architect) {
			expect(yourTools).toContain(tool);
		}
	});

	test('no tool appears in YOUR TOOLS that is NOT in AGENT_TOOL_MAP.architect (except Task delegation)', () => {
		const yourTools = extractYourToolsNames(resolvedPrompt);
		const mapSet = new Set<string>(AGENT_TOOL_MAP.architect);
		for (const tool of yourTools) {
			expect(
				mapSet.has(tool),
				`"${tool}" in prompt but not in AGENT_TOOL_MAP.architect`,
			).toBe(true);
		}
	});

	test('count of tools in YOUR TOOLS matches AGENT_TOOL_MAP.architect.length', () => {
		const yourTools = extractYourToolsNames(resolvedPrompt);
		expect(yourTools.length).toBe(ARCHITECT_TOOL_COUNT);
	});
});

// ---------------------------------------------------------------------------
// GROUP 2: Available Tools prompt list matches AGENT_TOOL_MAP.architect
// ---------------------------------------------------------------------------
describe('Available Tools prompt list matches AGENT_TOOL_MAP.architect', () => {
	test('every tool in AGENT_TOOL_MAP.architect appears in Available Tools section', () => {
		const availableTools = extractAvailableToolsNames(resolvedPrompt);
		for (const tool of AGENT_TOOL_MAP.architect) {
			expect(availableTools).toContain(tool);
		}
	});

	test('count of tools in Available Tools matches AGENT_TOOL_MAP.architect.length', () => {
		const availableTools = extractAvailableToolsNames(resolvedPrompt);
		expect(availableTools.length).toBe(ARCHITECT_TOOL_COUNT);
	});
});

// ---------------------------------------------------------------------------
// GROUP 3: TOOL_DESCRIPTIONS coverage for AGENT_TOOL_MAP.architect
// ---------------------------------------------------------------------------
describe('TOOL_DESCRIPTIONS coverage for AGENT_TOOL_MAP.architect', () => {
	test('every tool in AGENT_TOOL_MAP.architect has a non-empty TOOL_DESCRIPTIONS entry', () => {
		for (const tool of AGENT_TOOL_MAP.architect) {
			const desc = TOOL_DESCRIPTIONS[tool];
			expect(
				desc,
				`TOOL_DESCRIPTIONS["${tool}"] should be defined`,
			).toBeTruthy();
			expect(typeof desc).toBe('string');
			expect((desc as string).length).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// GROUP 4: WRITE_TOOL_NAMES is the canonical write-tool set
// ---------------------------------------------------------------------------
describe('WRITE_TOOL_NAMES is the canonical write-tool set', () => {
	test('WRITE_TOOL_NAMES has no duplicates', () => {
		const seen = new Set<string>();
		for (const tool of WRITE_TOOL_NAMES) {
			expect(seen.has(tool), `duplicate tool: ${tool}`).toBe(false);
			seen.add(tool);
		}
	});

	test('WRITE_TOOL_NAMES.length is 9 (canonical count)', () => {
		expect(WRITE_TOOL_NAMES.length).toBe(9);
	});

	test('WRITE_TOOL_NAMES contains the 4 core write tools', () => {
		const coreWriteTools = ['write', 'edit', 'patch', 'apply_patch'] as const;
		for (const tool of coreWriteTools) {
			expect(WRITE_TOOL_NAMES).toContain(tool);
		}
	});

	test('WRITE_TOOL_NAMES does NOT contain read-only tools (bash, read)', () => {
		expect(WRITE_TOOL_NAMES).not.toContain('bash');
		expect(WRITE_TOOL_NAMES).not.toContain('read');
	});
});

// ---------------------------------------------------------------------------
// GROUP 5: Architectural boundary — WRITE_TOOL_NAMES are coder tools, not architect
// ---------------------------------------------------------------------------
describe('WRITE_TOOL_NAMES are coder tools, not architect tools', () => {
	test('no WRITE_TOOL_NAMES tool appears in AGENT_TOOL_MAP.architect', () => {
		const architectTools = new Set<string>(AGENT_TOOL_MAP.architect);
		for (const tool of WRITE_TOOL_NAMES) {
			expect(
				architectTools.has(tool),
				`write tool "${tool}" should NOT be in AGENT_TOOL_MAP.architect`,
			).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// GROUP 6: No unknown agents in AGENT_TOOL_MAP
// ---------------------------------------------------------------------------
describe('No unknown agents in AGENT_TOOL_MAP', () => {
	test('every key in AGENT_TOOL_MAP is a known agent name', () => {
		const allKnownAgents = new Set<AgentName>([
			ORCHESTRATOR_NAME,
			...ALL_SUBAGENT_NAMES,
		]);
		for (const agentName of Object.keys(AGENT_TOOL_MAP)) {
			expect(
				allKnownAgents.has(agentName as AgentName),
				`unknown agent in AGENT_TOOL_MAP: "${agentName}"`,
			).toBe(true);
		}
	});

	test('ORCHESTRATOR_NAME (architect) is in AGENT_TOOL_MAP', () => {
		expect(AGENT_TOOL_MAP).toHaveProperty(ORCHESTRATOR_NAME);
	});

	test('every ALL_SUBAGENT_NAMES entry that has a tool map entry has at least 1 tool (except synthesis-only agents)', () => {
		// Allow-list: agents whose role is pure deliberation on already-gathered
		// content do not need tools. The three General Council agents are the
		// canonical examples — they receive a RESEARCH CONTEXT block from the
		// architect and reason from it; web_search / file tools are intentionally
		// absent (the architect owns all searches pre-dispatch).
		const ALLOWED_TOOLLESS = new Set<string>([
			'council_generalist',
			'council_skeptic',
			'council_domain_expert',
		]);

		for (const subagent of ALL_SUBAGENT_NAMES) {
			if (subagent in AGENT_TOOL_MAP) {
				const tools = AGENT_TOOL_MAP[subagent as keyof typeof AGENT_TOOL_MAP];
				if (ALLOWED_TOOLLESS.has(subagent)) continue;
				expect(
					tools.length,
					`"${subagent}" has ${tools.length} tools, expected >= 1`,
				).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

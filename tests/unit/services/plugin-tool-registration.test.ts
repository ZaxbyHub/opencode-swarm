import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';

/**
 * Regression guard for the council-tools-missing-from-plugin bug.
 *
 * Commit 62faff3 ("feat(council): add Work Complete Council verification gate")
 * added submit_council_verdicts and declare_council_criteria to AGENT_TOOL_MAP.architect,
 * implemented the tool modules, and exported them from src/tools/index.ts — but
 * forgot to import them in src/index.ts and register them in the plugin's
 * `tool: { … }` block. Result: the architect system prompt told the model to
 * call tools that opencode had never registered, so no model could invoke them.
 *
 * This test parses src/index.ts and asserts that every tool referenced by any
 * agent in AGENT_TOOL_MAP is actually registered in the plugin's exported
 * `tool: {}` block. That makes the regression a failing test at build time,
 * not a silent warning from tool-doctor that only runs on user-invoked
 * diagnostics.
 */
describe('plugin tool registration alignment', () => {
	const indexPath = path.join(process.cwd(), 'src', 'index.ts');
	const source = fs.readFileSync(indexPath, 'utf-8');

	// Extract the plugin's `tool: { … }` block. Find the `return {` containing
	// `name: 'opencode-swarm'` and then the first `tool: {` nested inside.
	function extractRegisteredToolKeys(src: string): Set<string> {
		const startMarker = src.indexOf("name: 'opencode-swarm'");
		if (startMarker === -1) {
			throw new Error('Could not locate opencode-swarm plugin return object');
		}
		const toolStart = src.indexOf('tool: {', startMarker);
		if (toolStart === -1) {
			throw new Error('Could not locate tool: { block in plugin return');
		}
		// Walk brace depth from the opening { of tool: {
		const openBrace = src.indexOf('{', toolStart);
		let depth = 0;
		let endIdx = -1;
		for (let i = openBrace; i < src.length; i++) {
			const ch = src[i];
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) {
					endIdx = i;
					break;
				}
			}
		}
		if (endIdx === -1) {
			throw new Error('Unterminated tool: { block');
		}
		const block = src.slice(openBrace + 1, endIdx);
		const keys = new Set<string>();
		// Match shorthand keys (`foo,` or `foo\n`) and renamed keys (`foo: bar,`).
		// Lookahead on the trailing delimiter so consecutive keys on the same line
		// (`foo, bar,`) are all captured — a plain `[:,}\n]` consumes the comma
		// and leaves the next key without a valid leading delimiter.
		const keyRe = /(?:^|[,{\n])\s*([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*[:,}\n])/g;
		for (const m of block.matchAll(keyRe)) {
			keys.add(m[1]);
		}
		return keys;
	}

	const registered = extractRegisteredToolKeys(source);

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

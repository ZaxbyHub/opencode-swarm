/**
 * Issue #3659 acceptance checks — memory-tool gating in the main-session
 * plugin tool object.
 *
 * At base, buildPluginToolObject registers swarm_memory_recall/propose/outcome
 * unconditionally: only knowledge tools were config-gated, while memory.enabled
 * is opt-in (schema default false) and subagents already hide the memory tools
 * unless enabled. The main-session tool object must match that boundary.
 *
 * RED at base, GREEN after the fix: the two exclusion checks (memory disabled,
 * undefined memory config). GREEN at base and must stay GREEN (preserving):
 * the memory-enabled check.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { buildPluginToolObject } from '../../../src/tools/plugin-registration';

const MEMORY_TOOL_NAMES = [
	'swarm_memory_recall',
	'swarm_memory_propose',
	'swarm_memory_outcome',
] as const;

describe('plugin registration memory gating (issue #3659)', () => {
	test('memory disabled excludes swarm_memory tools from main session', () => {
		const tools = buildPluginToolObject({}, {
			memory: { enabled: false },
		} as PluginConfig);
		for (const name of MEMORY_TOOL_NAMES) {
			expect(name in tools).toBe(false);
		}
	});

	test('undefined memory config excludes swarm_memory tools from main session', () => {
		const tools = buildPluginToolObject({}, {} as PluginConfig);
		for (const name of MEMORY_TOOL_NAMES) {
			expect(name in tools).toBe(false);
		}
	});

	test('memory enabled registers all three swarm_memory tools', () => {
		const tools = buildPluginToolObject({}, {
			memory: { enabled: true },
		} as PluginConfig);
		for (const name of MEMORY_TOOL_NAMES) {
			expect(name in tools).toBe(true);
		}
	});
});

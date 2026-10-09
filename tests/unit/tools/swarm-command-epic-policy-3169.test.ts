/**
 * epic command tool-policy tests (issue #3169 Phase 0 item 4 / Phase 1).
 *
 * On hosts where /swarm slash routing is unavailable (OpenCode 2 headless),
 * the model relays to `swarm_command`; `epic` was Zod-rejected there because
 * toolPolicy 'none' kept it out of SWARM_COMMAND_TOOL_COMMANDS. The fix makes
 * `epic` human-only: schema-visible with an ask-the-user refusal, never
 * agent-callable. Fakes only; no mock.module, no clock reads.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { resolveCommand } from '../../../src/commands/registry';
import {
	classifySwarmCommandToolUse,
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from '../../../src/commands/tool-policy';

describe('swarm-command epic tool policy (3169)', () => {
	test('epic is schema-visible in SWARM_COMMAND_TOOL_COMMANDS', () => {
		expect(
			(SWARM_COMMAND_TOOL_COMMANDS as readonly string[]).includes('epic'),
		).toBe(true);
	});

	test('epic is NOT agent-callable (absent from the agent allowlist)', () => {
		expect(SWARM_COMMAND_TOOL_ALLOWLIST.has('epic')).toBe(false);
	});

	test('epic is human-only (HUMAN_ONLY_SWARM_COMMANDS)', () => {
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('epic')).toBe(true);
	});

	test('classifySwarmCommandToolUse: epic start returns the human-only refusal', () => {
		const resolved = resolveCommand(['epic', 'start']);
		expect(resolved).not.toBeNull();
		const result = classifySwarmCommandToolUse(resolved!);
		expect(result.allowed).toBe(false);
		if (result.allowed === false) {
			expect(result.message).toContain('human-only');
			expect(result.message).toContain('/swarm epic');
		}
	});

	test('the swarm_command zod enum accepts command "epic"', () => {
		// The tool builds its input schema inline (src/tools/swarm-command.ts
		// z.enum(SWARM_COMMAND_TOOL_COMMANDS)); rebuild the same shape here to
		// pin that a model-relayed `swarm_command({command:'epic'})` call now
		// parses instead of dying in schema validation.
		const schema = z.object({
			command: z.enum(SWARM_COMMAND_TOOL_COMMANDS),
			args: z.array(z.string()).optional(),
		});
		const parsed = schema.safeParse({ command: 'epic', args: ['start'] });
		expect(parsed.success).toBe(true);
	});
});

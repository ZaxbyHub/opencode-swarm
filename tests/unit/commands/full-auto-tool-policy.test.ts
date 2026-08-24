import { describe, expect, test } from 'bun:test';
import { resolveCommand } from '../../../src/commands/registry';
import {
	classifySwarmCommandToolUse,
	SWARM_COMMAND_TOOL_COMMANDS,
} from '../../../src/commands/tool-policy';

describe('full-auto swarm_command policy', () => {
	test('full-auto is exposed through swarm_command', () => {
		expect(
			(SWARM_COMMAND_TOOL_COMMANDS as readonly string[]).includes('full-auto'),
		).toBe(true);
	});

	test('allows exact recovery grammar and rejects broad toggle form', () => {
		const retryVerdict = classifySwarmCommandToolUse(
			resolveCommand(['full-auto', 'retry-oversight'])!,
		);
		expect(retryVerdict.allowed).toBe(true);

		const toggleVerdict = classifySwarmCommandToolUse(
			resolveCommand(['full-auto'])!,
		);
		expect(toggleVerdict.allowed).toBe(false);
		expect(toggleVerdict.message).toContain('Usage through swarm_command');
	});
});

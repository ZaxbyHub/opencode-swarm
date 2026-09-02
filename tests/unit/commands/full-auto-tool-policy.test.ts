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

	test('refuses Full-Auto control to an agent so it cannot disarm oversight', () => {
		const verdict = classifySwarmCommandToolUse(
			resolveCommand(['full-auto', 'off'])!,
		);
		expect(verdict.allowed).toBe(false);
		expect(verdict.message).toContain('human-only');
	});

	test('keeps all Full-Auto controls outside agent tool access', () => {
		const retryVerdict = classifySwarmCommandToolUse(
			resolveCommand(['full-auto', 'retry-oversight'])!,
		);
		expect(retryVerdict.allowed).toBe(false);
		expect(retryVerdict.message).toContain('human-only');

		const toggleVerdict = classifySwarmCommandToolUse(
			resolveCommand(['full-auto'])!,
		);
		expect(toggleVerdict.allowed).toBe(false);
		expect(toggleVerdict.message).toContain('human-only');
	});
});

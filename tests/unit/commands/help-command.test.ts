import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CommandContext } from '../../../src/commands/registry.js';
import {
	COMMAND_REGISTRY,
	handleHelpCommand,
	resolveCommand,
	VALID_COMMANDS,
} from '../../../src/commands/registry.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const mockAgents = {} as Record<
	string,
	import('../../../src/agents/index.js').AgentDefinition
>;
const baseCtx: CommandContext = {
	directory: '/fake/project',
	args: [],
	sessionID: 'test-session-001',
	agents: mockAgents,
};

describe('handleHelpCommand() — Task 2.3 changes', () => {
	// -------------------------------------------------------------------------
	// TEST FOCUS 1: Verify /swarm help returns full help (no args)
	// -------------------------------------------------------------------------
	describe('full help — no arguments', () => {
		test('returns full help text when args is empty', async () => {
			const ctx: CommandContext = { ...baseCtx, args: [] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## Swarm Commands');
		});

		test('returns full help text when args is empty array', async () => {
			const ctx: CommandContext = { ...baseCtx, args: [] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('### Core');
			expect(result).toContain('### Agent');
			expect(result).toContain('### Config');
			expect(result).toContain('### Diagnostics');
			expect(result).toContain('### Utility');
		});

		test('returns full help with deep-dive in Agent category', async () => {
			const ctx: CommandContext = { ...baseCtx, args: [] };
			const result = await handleHelpCommand(ctx);
			// deep-dive should appear in the Agent section
			expect(result).toContain('/swarm deep-dive');
		});

		test('returns full help with all top-level commands listed', async () => {
			const ctx: CommandContext = { ...baseCtx, args: [] };
			const result = await handleHelpCommand(ctx);
			// Core commands should appear
			expect(result).toContain('/swarm status');
			expect(result).toContain('/swarm plan');
			expect(result).toContain('/swarm agents');
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 2: Verify /swarm help <command> returns detailed help
	// -------------------------------------------------------------------------
	describe('detailed help — specific command', () => {
		test('returns detailed help for "status" command', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['status'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm status');
			expect(result).toContain('**Usage:**');
			expect(result).toContain('**Args:**');
			expect(result).toContain('**Description:**');
			expect(result).toContain('Show current swarm state');
		});

		test('returns detailed help for single-token commands like "plan"', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['plan'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm plan');
			expect(result).toContain('Show plan');
		});

		test('returns detailed help for "agents" command', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['agents'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm agents');
			expect(result).toContain('List registered agents');
		});

		test('returns detailed help for "brainstorm" which has details field', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['brainstorm'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm brainstorm');
			expect(result).toContain('**Usage:**');
			expect(result).toContain(
				'Triggers the architect to run the brainstorm workflow',
			);
		});

		test('returns detailed help for "council" which has extensive details', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['council'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm council');
			expect(result).toContain('**Usage:**');
			expect(result).toContain('**Description:**');
			expect(result).toContain('Enter architect MODE: COUNCIL');
		});

		test('detailed help for command with no args shows "None"', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['status'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('**Args:** None');
		});

		test('detailed help for command with args shows args', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['benchmark'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('**Args:**');
			expect(result).toContain('--cumulative');
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 3: Verify unknown command suggestions work
	// -------------------------------------------------------------------------
	describe('unknown command — suggestions', () => {
		test('shows "not found" message for completely unknown command', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['xyznonexistent'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain("Command '/swarm xyznonexistent' not found");
			expect(result).toContain('Showing full help:');
			expect(result).toContain('## Swarm Commands');
		});

		test('shows "not found" for typo "sttaus"', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['sttaus'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain("Command '/swarm sttaus' not found");
		});

		test('shows "not found" for typo "confg"', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['confg'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain("Command '/swarm confg' not found");
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 4: Verify help command is in registry
	// -------------------------------------------------------------------------
	describe('help command registration', () => {
		test('"help" is a key in COMMAND_REGISTRY', () => {
			expect(Object.hasOwn(COMMAND_REGISTRY, 'help')).toBe(true);
		});

		test('"help" is in VALID_COMMANDS', () => {
			expect(VALID_COMMANDS).toContain('help');
		});

		test('help entry has correct handler type', () => {
			const helpEntry =
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY];
			expect(typeof helpEntry.handler).toBe('function');
		});

		test('help entry has description', () => {
			const helpEntry =
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY];
			expect(helpEntry.description).toBe('Show help for swarm commands');
		});

		test('help entry has category "core"', () => {
			const helpEntry =
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY];
			expect(helpEntry.category).toBe('core');
		});

		test('help entry documents [command] argument', () => {
			const helpEntry =
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY];
			expect(helpEntry.args).toBe('[command]');
		});

		test('help entry has details explaining behavior', () => {
			const helpEntry =
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY];
			expect(helpEntry.details).toContain('Without argument');
			expect(helpEntry.details).toContain('With argument');
		});

		test('resolveCommand can resolve "help" alone', () => {
			const result = resolveCommand(['help']);
			expect(result).not.toBeNull();
			expect(result!.entry).toBe(
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY],
			);
		});

		test('help handler returns a Promise<string>', async () => {
			const helpEntry =
				COMMAND_REGISTRY['help' as keyof typeof COMMAND_REGISTRY];
			const ctx: CommandContext = { ...baseCtx, args: [] };
			const result = helpEntry.handler(ctx);
			expect(result).toBeInstanceOf(Promise);
			const text = await result;
			expect(typeof text).toBe('string');
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------
	describe('edge cases', () => {
		test('handles empty string as single arg', async () => {
			const ctx: CommandContext = { ...baseCtx, args: [''] };
			const result = await handleHelpCommand(ctx);
			// Empty string should result in full help
			expect(result).toContain('## Swarm Commands');
		});

		test('handles whitespace-only args', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['   '] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## Swarm Commands');
		});

		test('handles multiple args gracefully (uses only first)', async () => {
			const ctx: CommandContext = {
				...baseCtx,
				args: ['status', 'extra', 'args'],
			};
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm status');
		});

		test('handles command with dashes in name', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['dark-matter'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm dark-matter');
		});

		test('handles command with numbers in name', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['qa-gates'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm qa-gates');
		});

		test('handles command "simulate" correctly', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['simulate'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm simulate');
			expect(result).toContain('Dry-run hidden coupling analysis');
		});

		test('handles "checkpoint" command correctly', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['checkpoint'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm checkpoint');
			expect(result).toContain('Manage project checkpoints');
		});
	});
});

describe('buildDetailedHelp() — via handleHelpCommand for single-token commands', () => {
	test('generates proper detailed help header format', async () => {
		const ctx: CommandContext = { ...baseCtx, args: ['diagnose'] };
		const result = await handleHelpCommand(ctx);
		expect(result).toContain('## /swarm diagnose');
	});

	test('shows description for diagnose', async () => {
		const ctx: CommandContext = { ...baseCtx, args: ['diagnose'] };
		const result = await handleHelpCommand(ctx);
		expect(result).toContain('Run health check on swarm state');
	});

	test('shows args specification when present', async () => {
		const ctx: CommandContext = { ...baseCtx, args: ['pr-review'] };
		const result = await handleHelpCommand(ctx);
		expect(result).toContain('**Args:**');
		expect(result).toContain('<pr-url|owner/repo#N|N>');
	});
});

describe('handleHelpCommand — integration with createSwarmCommandHandler patterns', () => {
	test('help command is accessible via resolveCommand with single token', () => {
		const result = resolveCommand(['help']);
		expect(result).not.toBeNull();
		expect(result!.entry).toBe(COMMAND_REGISTRY['help']);
		expect(result!.remainingArgs).toEqual([]);
	});

	test('help with args preserves remaining args in resolveCommand', () => {
		// This tests resolveCommand behavior, not handleHelpCommand directly
		// When user types "/swarm help status extra", tokens = ['help', 'status', 'extra']
		const result = resolveCommand(['help', 'status', 'extra']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['status', 'extra']);
	});
});

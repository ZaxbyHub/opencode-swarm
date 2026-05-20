/**
 * Focused test for Task 2.3 changes:
 * 1. Compound command support in handleHelpCommand()
 * 2. resolveCommand() returns key
 *
 * Verifies:
 * - /swarm help config doctor works
 * - /swarm help evidence summary works
 * - Canonical names displayed correctly
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../../src/commands/registry.js';
import {
	COMMAND_REGISTRY,
	handleHelpCommand,
	resolveCommand,
} from '../../../src/commands/registry.js';

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

describe('Task 2.3: Compound command support in handleHelpCommand()', () => {
	describe('resolveCommand returns key property', () => {
		test('resolveCommand returns key for single-token command', () => {
			const result = resolveCommand(['status']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('status');
			expect(typeof result!.key).toBe('string');
		});

		test('resolveCommand returns key for compound command "config doctor"', () => {
			const result = resolveCommand(['config', 'doctor']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('config doctor');
		});

		test('resolveCommand returns key for compound command "evidence summary"', () => {
			const result = resolveCommand(['evidence', 'summary']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('evidence summary');
		});

		test('resolveCommand returns key with trailing args preserved', () => {
			const result = resolveCommand(['evidence', 'summary', 'task-1']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('evidence summary');
			expect(result!.remainingArgs).toEqual(['task-1']);
		});
	});

	describe('handleHelpCommand with compound commands', () => {
		test('help for "config doctor" shows canonical name', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['config', 'doctor'] };
			const result = await handleHelpCommand(ctx);
			// Must show canonical name "config doctor" not "config-doctor"
			expect(result).toContain('## /swarm config doctor');
			expect(result).toContain('Run config doctor checks');
		});

		test('help for "evidence summary" shows canonical name', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['evidence', 'summary'] };
			const result = await handleHelpCommand(ctx);
			// Must show canonical name "evidence summary"
			expect(result).toContain('## /swarm evidence summary');
			expect(result).toContain(
				'Generate evidence summary with completion ratio and blockers',
			);
		});

		test('help for "config doctor" Usage line shows canonical name', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['config', 'doctor'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('**Usage:** `/swarm config doctor`');
		});

		test('help for "evidence summary" Usage line shows canonical name', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['evidence', 'summary'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('**Usage:** `/swarm evidence summary`');
		});

		test('help for "config doctor" shows args specification', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['config', 'doctor'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('**Args:**');
		});

		test('help for "evidence summary" shows description', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['evidence', 'summary'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain(
				'Generate evidence summary with completion ratio and blockers',
			);
		});
	});

	describe('canonical name display - verify no dash variants shown', () => {
		test('help for "config doctor" does NOT contain "config-doctor" in header', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['config', 'doctor'] };
			const result = await handleHelpCommand(ctx);
			// The header should be "## /swarm config doctor" not "## /swarm config-doctor"
			expect(result).toContain('## /swarm config doctor');
			expect(result).not.toContain('## /swarm config-doctor');
		});

		test('help for "evidence summary" does NOT contain "evidence-summary" in header', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['evidence', 'summary'] };
			const result = await handleHelpCommand(ctx);
			// The header should be "## /swarm evidence summary" not "## /swarm evidence-summary"
			expect(result).toContain('## /swarm evidence summary');
			expect(result).not.toContain('## /swarm evidence-summary');
		});
	});

	describe('other compound commands work correctly', () => {
		test('help for "knowledge migrate" works', async () => {
			const ctx: CommandContext = {
				...baseCtx,
				args: ['knowledge', 'migrate'],
			};
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm knowledge migrate');
			expect(result).toContain('Migrate knowledge entries');
		});

		test('help for "knowledge quarantine" works', async () => {
			const ctx: CommandContext = {
				...baseCtx,
				args: ['knowledge', 'quarantine'],
			};
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm knowledge quarantine');
		});

		test('help for "doctor tools" works', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['doctor', 'tools'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm doctor tools');
		});
	});

	describe('no regressions - existing functionality preserved', () => {
		test('help for single-token "status" still works', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['status'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm status');
			expect(result).toContain('Show current swarm state');
		});

		test('help for single-token "plan" still works', async () => {
			const ctx: CommandContext = { ...baseCtx, args: ['plan'] };
			const result = await handleHelpCommand(ctx);
			expect(result).toContain('## /swarm plan');
		});

		test('resolveCommand still works for single-token commands', () => {
			const result = resolveCommand(['agents']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('agents');
		});

		test('resolveCommand compound with remaining args works', () => {
			const result = resolveCommand(['dark-matter', '--threshold', '0.5']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('dark-matter');
			expect(result!.remainingArgs).toEqual(['--threshold', '0.5']);
		});
	});
});

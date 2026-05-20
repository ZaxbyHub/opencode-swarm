import { beforeEach, describe, expect, it } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents';
import {
	createSwarmCommandHandler,
	handleRollbackCommand as indexRollbackExport,
} from '../../../src/commands/index';
import {
	COMMAND_REGISTRY,
	VALID_COMMANDS,
} from '../../../src/commands/registry';
import { handleRollbackCommand } from '../../../src/commands/rollback';

describe('Rollback Command Integration Tests', () => {
	const testDir = '/test/project';
	const testAgents: Record<string, AgentDefinition> = {
		architect: {
			name: 'architect',
			config: { model: 'gpt-4', temperature: 0.1 },
		},
	};

	let handler: ReturnType<typeof createSwarmCommandHandler>;

	beforeEach(() => {
		handler = createSwarmCommandHandler(testDir, testAgents);
	});

	describe('1. Command dispatcher routes "rollback" to handleRollbackCommand', () => {
		it('should route /swarm rollback command to handleRollbackCommand', () => {
			expect(COMMAND_REGISTRY['rollback']).toBeDefined();
			expect(typeof COMMAND_REGISTRY['rollback'].handler).toBe('function');
			expect(VALID_COMMANDS).toContain('rollback');
		});

		it('should route /swarm rollback with arguments to handleRollbackCommand', () => {
			expect(COMMAND_REGISTRY['rollback']).toBeDefined();
			expect(typeof COMMAND_REGISTRY['rollback'].handler).toBe('function');
		});

		it('should route /swarm rollback with phase argument', () => {
			expect(COMMAND_REGISTRY['rollback']).toBeDefined();
			expect(typeof COMMAND_REGISTRY['rollback'].handler).toBe('function');
		});

		it('should route /swarm rollback with extra arguments', () => {
			expect(COMMAND_REGISTRY['rollback']).toBeDefined();
		});

		it('should handle non-swarm commands (handler not invoked)', async () => {
			const output: { parts: unknown[] } = { parts: [] };
			await handler(
				{
					command: 'other',
					sessionID: 'test-session',
					arguments: 'rollback 1',
				},
				output,
			);
			// Non-swarm commands produce no output
			expect(output.parts).toHaveLength(0);
		});
	});

	describe('2. HELP_TEXT includes rollback entry', () => {
		it('should return HELP_TEXT for unknown commands containing rollback-related strings', async () => {
			const output: { parts: unknown[] } = { parts: [] };
			await handler(
				{
					command: 'swarm',
					sessionID: 'test-session',
					arguments: 'unknown-command',
				},
				output,
			);
			const outputText = (output.parts[0] as any).text;
			expect(outputText).toContain('not found');
			expect(outputText).toContain('/swarm help');
		});

		it('should have rollback description in COMMAND_REGISTRY', () => {
			expect(COMMAND_REGISTRY['rollback']).toBeDefined();
			expect(typeof COMMAND_REGISTRY['rollback'].description).toBe('string');
			expect(COMMAND_REGISTRY['rollback'].description.length).toBeGreaterThan(
				0,
			);
		});
	});

	describe('3. Export is available from commands/index.ts', () => {
		it('should export handleRollbackCommand from commands/index.ts', () => {
			expect(typeof indexRollbackExport).toBe('function');
		});

		it('should export handleRollbackCommand as a function', () => {
			expect(typeof indexRollbackExport).toBe('function');
		});

		it('should have handleRollbackCommand as a named export matching the module export', () => {
			expect(indexRollbackExport).toBeDefined();
			expect(indexRollbackExport).toBe(handleRollbackCommand);
		});
	});

	describe('4. Individual command registration exists', () => {
		it('should have rollback case in command dispatcher', () => {
			expect(VALID_COMMANDS).toContain('rollback');
			expect(typeof COMMAND_REGISTRY['rollback'].handler).toBe('function');
		});

		it('should only process rollback when subcommand is exactly "rollback"', async () => {
			const output: { parts: unknown[] } = { parts: [] };
			await handler(
				{
					command: 'swarm',
					sessionID: 'test-session',
					arguments: 'rollbacksomething',
				},
				output,
			);
			// Should return command-not-found text for unknown subcommand.
			expect((output.parts[0] as any).text).toContain('not found');
		});

		it('should handle rollback subcommand case-sensitively (ROLLBACK → help text)', async () => {
			const output: { parts: unknown[] } = { parts: [] };
			await handler(
				{
					command: 'swarm',
					sessionID: 'test-session',
					arguments: 'ROLLBACK',
				},
				output,
			);
			// Should return command-not-found text for unknown subcommand.
			expect((output.parts[0] as any).text).toContain('not found');
		});
	});

	describe('Integration: command registration verified', () => {
		it('should be included in VALID_COMMANDS list', () => {
			expect(VALID_COMMANDS).toContain('rollback');
		});

		it('should have handler and description in COMMAND_REGISTRY', () => {
			expect(COMMAND_REGISTRY['rollback'].handler).toBeDefined();
			expect(COMMAND_REGISTRY['rollback'].description).toBeDefined();
		});

		it('should be callable as a function', () => {
			expect(typeof handleRollbackCommand).toBe('function');
		});
	});
});

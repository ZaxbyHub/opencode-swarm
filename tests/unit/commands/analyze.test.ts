import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents';
import { handleAnalyzeCommand } from '../../../src/commands/analyze';
import { createSwarmCommandHandler } from '../../../src/commands/index';

describe('handleAnalyzeCommand', () => {
	test('returns [MODE: ANALYZE] <description> when args are provided', async () => {
		const result = await handleAnalyzeCommand('/test/dir', [
			'Analyze',
			'the',
			'API',
			'spec',
		]);
		expect(result).toBe('[MODE: ANALYZE] Analyze the API spec');
	});

	test('returns the default message when args is empty array', async () => {
		const result = await handleAnalyzeCommand('/test/dir', []);
		expect(result).toContain(
			'[MODE: ANALYZE] Please analyze the spec against the plan using MODE: ANALYZE.',
		);
	});

	test('returns the default message when args contains only whitespace', async () => {
		const result = await handleAnalyzeCommand('/test/dir', ['   ', '\t', '\n']);
		expect(result).toContain(
			'[MODE: ANALYZE] Please analyze the spec against the plan using MODE: ANALYZE.',
		);
	});

	test('multiple args are joined with space in the output', async () => {
		const result = await handleAnalyzeCommand('/test/dir', [
			'Review',
			'user',
			'authentication',
			'flow',
		]);
		expect(result).toBe('[MODE: ANALYZE] Review user authentication flow');
	});

	test('the default message contains "ANALYZE"', async () => {
		const result = await handleAnalyzeCommand('/test/dir', []);
		expect(result).toContain('ANALYZE');
	});

	test('handleAnalyzeCommand is exported from src/commands/index.ts', () => {
		const {
			handleAnalyzeCommand: exportedHandler,
		} = require('../../../src/commands/index');
		expect(exportedHandler).toBeDefined();
		expect(typeof exportedHandler).toBe('function');
	});

	test('/swarm analyze appears in the HELP_TEXT', async () => {
		const testAgents: Record<string, AgentDefinition> = {
			architect: { name: 'architect', config: { model: 'gpt-4' } },
		};
		const handler = createSwarmCommandHandler('/test/dir', testAgents);
		const output = { parts: [] as unknown[] };

		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);

		const helpText = (output.parts[0] as { type: string; text: string }).text;
		expect(helpText).toContain('/swarm analyze');
	});
});

describe('handleAnalyzeCommand — adversarial', () => {
	test('does NOT return [MODE: SPECIFY] (wrong mode tag must never be emitted)', async () => {
		const result = await handleAnalyzeCommand('/test/dir', [
			'test description',
		]);
		expect(result).not.toContain('[MODE: SPECIFY]');
		expect(result).toContain('[MODE: ANALYZE]');
	});

	test('whitespace-only args do NOT appear in the output (trimming works)', async () => {
		const result = await handleAnalyzeCommand('/test/dir', ['   ']);
		expect(result).not.toMatch(/\[MODE: ANALYZE\]\s*$/);
		expect(result).toContain(
			'[MODE: ANALYZE] Please analyze the spec against the plan using MODE: ANALYZE.',
		);
	});

	test('args with multiple spaces are joined but not normalized (join uses single space between args)', async () => {
		const result = await handleAnalyzeCommand('/test/dir', [
			'test',
			'   ',
			'multiple',
			'\t',
			'spaces',
		]);
		// args.join(' ') joins with single space, but args themselves preserve their whitespace
		expect(result).toContain('[MODE: ANALYZE]');
		expect(result).toContain('test');
		expect(result).toContain('multiple');
		expect(result).toContain('spaces');
		// The actual implementation doesn't normalize internal whitespace
		expect(result).toContain('\t'); // tabs within args are preserved
	});

	test('empty string arg returns default message, not an empty mode tag like [MODE: ANALYZE] ', async () => {
		const result = await handleAnalyzeCommand('/test/dir', ['']);
		expect(result).not.toBe('[MODE: ANALYZE] ');
		expect(result).not.toBe('[MODE: ANALYZE]');
		expect(result).toContain(
			'[MODE: ANALYZE] Please analyze the spec against the plan using MODE: ANALYZE.',
		);
	});

	test('does NOT include directory in returned string', async () => {
		const result = await handleAnalyzeCommand('/some/test/directory', [
			'test description',
		]);
		expect(result).not.toContain('/some/test/directory');
		expect(result).not.toContain('/test/dir');
		expect(result).not.toContain('/some');
	});
});

describe('handleAnalyzeCommand index registration — adversarial', () => {
	test('the switch-case for "analyze" routes to handleAnalyzeCommand, not a different handler', async () => {
		const testAgents: Record<string, AgentDefinition> = {
			architect: { name: 'architect', config: { model: 'gpt-4' } },
		};
		const handler = createSwarmCommandHandler('/test/dir', testAgents);
		const output = { parts: [] as unknown[] };

		// Call /swarm analyze with arguments
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'analyze test spec' },
			output,
		);

		const result = (output.parts[0] as { type: string; text: string }).text;

		// Verify it uses handleAnalyzeCommand (returns MODE: ANALYZE)
		expect(result).toContain('[MODE: ANALYZE]');
		expect(result).toContain('test spec');

		// Verify it does NOT use handleSpecifyCommand (would return MODE: SPECIFY)
		expect(result).not.toContain('[MODE: SPECIFY]');

		// Verify it does NOT use handleStatusCommand (would return different format)
		expect(result).not.toContain('## Swarm Plan');
	});

	test('the "analyze" case does NOT fall through to "specify" case (properly broken)', async () => {
		const testAgents: Record<string, AgentDefinition> = {
			architect: { name: 'architect', config: { model: 'gpt-4' } },
		};
		const handler = createSwarmCommandHandler('/test/dir', testAgents);
		const output = { parts: [] as unknown[] };

		// Call /swarm analyze without args
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'analyze' },
			output,
		);

		const result = (output.parts[0] as { type: string; text: string }).text;

		// Verify it returns analyze's default message, not specify's
		expect(result).toContain(
			'[MODE: ANALYZE] Please analyze the spec against the plan using MODE: ANALYZE.',
		);

		// Verify it does NOT contain specify mode tag
		expect(result).not.toContain('[MODE: SPECIFY]');
	});

	test('unknown subcommands fall through to default HELP_TEXT (regression check)', async () => {
		const testAgents: Record<string, AgentDefinition> = {
			architect: { name: 'architect', config: { model: 'gpt-4' } },
		};
		const handler = createSwarmCommandHandler('/test/dir', testAgents);
		const output = { parts: [] as unknown[] };

		// Call with unknown subcommand
		await handler(
			{ command: 'swarm', sessionID: 's1', arguments: 'unknown-cmd test args' },
			output,
		);

		const result = (output.parts[0] as { type: string; text: string }).text;

		// Verify it returns the bounded command-not-found UX.
		expect(result).toContain('not found');
		expect(result).toContain('/swarm help');

		// Verify it does NOT contain any mode tag
		expect(result).not.toContain('[MODE:');
	});
});

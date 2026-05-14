import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents';
import { handleClarifyCommand } from '../../../src/commands/clarify';
import { createSwarmCommandHandler } from '../../../src/commands/index';

describe('handleClarifyCommand', () => {
	test('returns [MODE: CLARIFY-SPEC] <description> when args are provided', async () => {
		const result = await handleClarifyCommand('/test/dir', [
			'Clarify',
			'the',
			'API',
			'spec',
		]);
		expect(result).toBe('[MODE: CLARIFY-SPEC] Clarify the API spec');
	});

	test('returns the default message when args is empty array', async () => {
		const result = await handleClarifyCommand('/test/dir', []);
		expect(result).toBe(
			'[MODE: CLARIFY-SPEC] Please enter MODE: CLARIFY-SPEC and clarify the existing spec.',
		);
	});

	test('returns the default message when args contains only whitespace', async () => {
		const result = await handleClarifyCommand('/test/dir', ['   ', '\t', '\n']);
		expect(result).toBe(
			'[MODE: CLARIFY-SPEC] Please enter MODE: CLARIFY-SPEC and clarify the existing spec.',
		);
	});

	test('multiple args are joined with space in the output', async () => {
		const result = await handleClarifyCommand('/test/dir', [
			'Review',
			'user',
			'authentication',
			'flow',
		]);
		expect(result).toBe('[MODE: CLARIFY-SPEC] Review user authentication flow');
	});

	test('the default message contains "CLARIFY-SPEC"', async () => {
		const result = await handleClarifyCommand('/test/dir', []);
		expect(result).toContain('CLARIFY-SPEC');
	});

	test('handleClarifyCommand is exported from src/commands/index.ts', () => {
		const {
			handleClarifyCommand: exportedHandler,
		} = require('../../../src/commands/index');
		expect(exportedHandler).toBeDefined();
		expect(typeof exportedHandler).toBe('function');
	});

	test('/swarm clarify appears in the HELP_TEXT', async () => {
		const testAgents: Record<string, AgentDefinition> = {
			architect: { name: 'architect', config: { model: 'gpt-4' } },
		};
		const handler = createSwarmCommandHandler('/test/dir', testAgents);
		const output = { parts: [] as unknown[] };

		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);

		const helpText = (output.parts[0] as { type: string; text: string }).text;
		expect(helpText).toContain('/swarm clarify');
	});
});

describe('handleClarifyCommand — adversarial', () => {
	test('does NOT return [MODE: SPECIFY] (wrong mode tag must never be emitted)', async () => {
		const result = await handleClarifyCommand('/test/dir', [
			'test description',
		]);
		expect(result).not.toContain('[MODE: SPECIFY]');
		expect(result).toContain('[MODE: CLARIFY-SPEC]');
	});

	test('whitespace-only args do NOT appear in the output (trimming works)', async () => {
		const result = await handleClarifyCommand('/test/dir', ['   ']);
		expect(result).not.toMatch(/\[MODE: CLARIFY-SPEC\]\s*$/);
		expect(result).toBe(
			'[MODE: CLARIFY-SPEC] Please enter MODE: CLARIFY-SPEC and clarify the existing spec.',
		);
	});

	test('args with multiple spaces are joined but not normalized (join uses single space between args)', async () => {
		const result = await handleClarifyCommand('/test/dir', [
			'test',
			'   ',
			'multiple',
			'\t',
			'spaces',
		]);
		// args.join(' ') joins with single space, but args themselves preserve their whitespace
		expect(result).toContain('[MODE: CLARIFY-SPEC]');
		expect(result).toContain('test');
		expect(result).toContain('multiple');
		expect(result).toContain('spaces');
		// The actual implementation doesn't normalize internal whitespace
		expect(result).toContain('\t'); // tabs within args are preserved
	});

	test('empty string arg returns default message, not an empty mode tag like [MODE: CLARIFY-SPEC] ', async () => {
		const result = await handleClarifyCommand('/test/dir', ['']);
		expect(result).not.toBe('[MODE: CLARIFY-SPEC] ');
		expect(result).not.toBe('[MODE: CLARIFY-SPEC]');
		expect(result).toBe(
			'[MODE: CLARIFY-SPEC] Please enter MODE: CLARIFY-SPEC and clarify the existing spec.',
		);
	});

	test('very long description (500+ chars) is passed through without truncation (no silent cutting)', async () => {
		const longDescription = 'A'.repeat(500);
		const result = await handleClarifyCommand('/test/dir', [longDescription]);
		expect(result).toBeTypeOf('string');
		expect(result).toContain('[MODE: CLARIFY-SPEC]');
		expect(result.length).toBeGreaterThan(500); // Should be > 500 due to prefix
		expect(result).toContain(longDescription); // Full description should be present
	});
});

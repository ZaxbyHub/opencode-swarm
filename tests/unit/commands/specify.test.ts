import { describe, expect, test } from 'bun:test';
import type { AgentDefinition } from '../../../src/agents';
import { createSwarmCommandHandler } from '../../../src/commands/index';
import { handleSpecifyCommand } from '../../../src/commands/specify';

describe('handleSpecifyCommand', () => {
	test('returns correct format with description args', async () => {
		const result = await handleSpecifyCommand('/test/dir', [
			'Add',
			'feature',
			'X',
		]);
		expect(result).toBe('[MODE: SPECIFY] Add feature X');
	});

	test('returns fallback with [MODE: SPECIFY] prefix when no args provided', async () => {
		const result = await handleSpecifyCommand('/test/dir', []);
		expect(result).toBe(
			'[MODE: SPECIFY] Please enter MODE: SPECIFY and generate a spec for this project.',
		);
	});

	test('returns fallback with [MODE: SPECIFY] prefix for whitespace-only args', async () => {
		const result = await handleSpecifyCommand('/test/dir', ['   ', '\t']);
		expect(result).toBe(
			'[MODE: SPECIFY] Please enter MODE: SPECIFY and generate a spec for this project.',
		);
	});

	test('joins multiple words correctly', async () => {
		const result = await handleSpecifyCommand('/test/dir', [
			'Create',
			'a',
			'new',
			'user',
			'management',
			'system',
		]);
		expect(result).toBe('[MODE: SPECIFY] Create a new user management system');
	});

	test('handles single word description', async () => {
		const result = await handleSpecifyCommand('/test/dir', ['authentication']);
		expect(result).toBe('[MODE: SPECIFY] authentication');
	});

	test('trims leading and trailing whitespace from description', async () => {
		const result = await handleSpecifyCommand('/test/dir', ['  Build API  ']);
		expect(result).toBe('[MODE: SPECIFY] Build API');
	});

	test('handles empty array element', async () => {
		const result = await handleSpecifyCommand('/test/dir', ['']);
		expect(result).toBe(
			'[MODE: SPECIFY] Please enter MODE: SPECIFY and generate a spec for this project.',
		);
	});
});

describe('handleSpecifyCommand — adversarial', () => {
	test('very long description (1000+ characters) — should not throw, should return string', async () => {
		const longDescription = 'A'.repeat(1000);
		const result = await handleSpecifyCommand('/test/dir', [longDescription]);
		expect(result).toBeTypeOf('string');
		expect(result).toContain('[MODE: SPECIFY]');
		expect(result.length).toBeGreaterThan(1000);
	});

	test('special characters in description (backticks, brackets, markdown) — should be included verbatim', async () => {
		const specialChars =
			'Test `code` with [brackets] and {braces} and <angles> and markdown **bold** and _italic_';
		const result = await handleSpecifyCommand('/test/dir', [specialChars]);
		expect(result).toBeTypeOf('string');
		expect(result).toContain('[MODE: SPECIFY]');
		expect(result).toContain('`code`');
		expect(result).toContain('[brackets]');
		expect(result).toContain('{braces}');
		expect(result).toContain('<angles>');
		expect(result).toContain('**bold**');
		expect(result).toContain('_italic_');
	});

	test('newlines in args — args.join(" ") joins with spaces, but preserves newlines as actual newline chars', async () => {
		const result = await handleSpecifyCommand('/test/dir', [
			'line1',
			'\n',
			'line2',
		]);
		// args.join(' ') will join with spaces, but \n becomes a literal newline character
		expect(result).toBeTypeOf('string');
		expect(result).toContain('[MODE: SPECIFY]');
		expect(result).toContain('line1');
		expect(result).toContain('\n'); // actual newline character
		expect(result).toContain('line2');
	});

	test('null/undefined-like values: args = [""] should behave like empty (fallback)', async () => {
		const result = await handleSpecifyCommand('/test/dir', ['']);
		expect(result).toBe(
			'[MODE: SPECIFY] Please enter MODE: SPECIFY and generate a spec for this project.',
		);
	});

	test('many args (50 words) — should join correctly without truncation', async () => {
		const manyArgs = Array.from({ length: 50 }, (_, i) => `word${i + 1}`);
		const result = await handleSpecifyCommand('/test/dir', manyArgs);
		expect(result).toBeTypeOf('string');
		expect(result).toContain('[MODE: SPECIFY]');
		// Verify all words are present
		for (let i = 0; i < 50; i++) {
			expect(result).toContain(`word${i + 1}`);
		}
		expect(result).toMatch(/word\d+(\s+word\d+){49}/);
	});
});

describe('index.ts exports and HELP_TEXT', () => {
	test('HELP_TEXT contains "/swarm specify"', async () => {
		const testAgents: Record<string, AgentDefinition> = {
			architect: { name: 'architect', config: { model: 'gpt-4' } },
		};
		const handler = createSwarmCommandHandler('/test/dir', testAgents);
		const output = { parts: [] as unknown[] };

		await handler({ command: 'swarm', sessionID: 's1', arguments: '' }, output);

		const helpText = (output.parts[0] as { type: string; text: string }).text;
		expect(helpText).toContain('/swarm specify');
	});

	test('index.ts exports handleSpecifyCommand', () => {
		// Re-import to verify the export
		const { handleSpecifyCommand: exportedHandler } =
			require('../../../src/commands/index');
		expect(exportedHandler).toBeDefined();
		expect(typeof exportedHandler).toBe('function');
	});
});

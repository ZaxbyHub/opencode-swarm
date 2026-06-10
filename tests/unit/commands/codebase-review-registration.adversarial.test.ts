import { describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	type RegisteredCommand,
	resolveCommand,
	VALID_COMMANDS,
	validateAliases,
} from '../../../src/commands/registry.js';

describe('resolveCommand - codebase-review registration integrity', () => {
	test('codebase-review preserves trailing args', () => {
		const args = ['src/auth', '--mode', 'security', '--json'];
		const result = resolveCommand(['codebase-review', ...args]);

		expect(result).not.toBeNull();
		expect(result!.key).toBe('codebase-review');
		expect(result!.remainingArgs).toEqual(args);
	});

	test('codebase review compound alias preserves trailing args', () => {
		const args = ['frontend', '--mode', 'ui'];
		const result = resolveCommand(['codebase', 'review', ...args]);

		expect(result).not.toBeNull();
		expect(result!.key).toBe('codebase review');
		expect(result!.entry.aliasOf).toBe('codebase-review');
		expect(result!.remainingArgs).toEqual(args);
	});

	test('codebase alone does not resolve as a command', () => {
		expect(resolveCommand(['codebase'])).toBeNull();
	});

	test('codebase-review-swarm does not resolve as a command alias', () => {
		expect(resolveCommand(['codebase-review-swarm'])).toBeNull();
	});
});

describe('COMMAND_REGISTRY["codebase-review"] structural invariants', () => {
	test('canonical entry has non-empty details and is not deprecated', () => {
		const entry = COMMAND_REGISTRY[
			'codebase-review' as RegisteredCommand
		] as CommandEntry;

		expect(entry.details).toContain('coverage closure');
		expect(entry.details).toContain('critic challenge');
		expect(entry.aliasOf).toBeUndefined();
		expect(entry.deprecated).toBeUndefined();
	});

	test('aliases point to the canonical entry and validateAliases passes', () => {
		for (const alias of ['codebase review']) {
			const entry = COMMAND_REGISTRY[
				alias as RegisteredCommand
			] as CommandEntry;
			expect(entry.aliasOf).toBe('codebase-review');
		}

		const result = validateAliases();
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('canonical command is in VALID_COMMANDS', () => {
		expect(VALID_COMMANDS).toContain('codebase-review');
	});
});

describe('swarm-codebase-review command template in index.ts', () => {
	test('shortcut template exists in plugin commands config', () => {
		const indexContent = require('fs').readFileSync(
			require('path').resolve(__dirname, '../../../src/index.ts'),
			'utf-8',
		);

		expect(indexContent).toContain("'swarm-codebase-review'");
		expect(indexContent).toContain("'/swarm codebase-review $ARGUMENTS'");
	});
});

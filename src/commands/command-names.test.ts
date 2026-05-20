import { describe, expect, test } from 'bun:test';
import { COMMAND_NAME_SET, COMMAND_NAMES } from './command-names';
import { COMMAND_REGISTRY } from './registry';

describe('command-names registry', () => {
	test('derives command names from COMMAND_REGISTRY', () => {
		expect(COMMAND_NAMES.length).toBe(Object.keys(COMMAND_REGISTRY).length);
		expect(COMMAND_NAMES).toContain('show-plan');
		expect(COMMAND_NAMES).toContain('finalize');
		expect(COMMAND_NAMES).toContain('deep-dive');
	});

	test('COMMAND_NAME_SET stays in sync with COMMAND_NAMES', () => {
		expect(COMMAND_NAME_SET.has('show-plan')).toBe(true);
		expect(COMMAND_NAME_SET.has('finalize')).toBe(true);
		expect(COMMAND_NAME_SET.has('deep-dive')).toBe(true);
		expect(COMMAND_NAME_SET.size).toBe(COMMAND_NAMES.length);
	});
});

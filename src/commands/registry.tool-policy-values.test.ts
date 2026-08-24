import { describe, expect, test } from 'bun:test';
import { COMMAND_REGISTRY, type CommandEntry } from './registry.js';

describe('toolPolicy field values are valid', () => {
	test('uses a supported literal when present', () => {
		const valid = new Set(['agent', 'human-only', 'restricted', 'none']);
		for (const entry of Object.values(COMMAND_REGISTRY)) {
			const command = entry as CommandEntry;
			if (command.toolPolicy !== undefined) {
				expect(valid.has(command.toolPolicy)).toBe(true);
			}
		}
	});
});

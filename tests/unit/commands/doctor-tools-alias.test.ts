import { describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	resolveCommand,
	validateAliases,
} from '../../../src/commands/registry.js';

// Regression: '/swarm doctor-tools' (hyphenated) previously returned
// "command not found" because only 'doctor tools' (space) was registered.
// resolveCommand uses the entry's OWN handler — aliasOf is warning text only —
// so the hyphenated entry must carry its own handler, not just aliasOf.
describe('doctor-tools alias', () => {
	test('resolves the hyphenated form to its own entry', () => {
		const resolved = resolveCommand(['doctor-tools']);
		expect(resolved).not.toBeNull();
		expect(resolved?.key).toBe('doctor-tools');
	});

	test('the hyphenated entry has its own handler (aliasOf does not redirect)', () => {
		const entry = COMMAND_REGISTRY['doctor-tools'] as CommandEntry;
		expect(typeof entry.handler).toBe('function');
		expect(entry.aliasOf).toBe('doctor tools');
		expect(entry.deprecated).toBe(true);
	});

	test('emits a deprecation warning pointing at the canonical form', () => {
		const resolved = resolveCommand(['doctor-tools']);
		expect(resolved?.warning).toContain('doctor tools');
	});

	test('canonical "doctor tools" still resolves', () => {
		expect(resolveCommand(['doctor', 'tools'])?.key).toBe('doctor tools');
	});

	test('alias target exists and is non-circular', () => {
		// validateAliases reports any aliasOf pointing to a missing/circular target
		const result = validateAliases();
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

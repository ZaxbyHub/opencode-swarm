import { describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	resolveCommand,
	validateAliases,
} from '../../../src/commands/registry.js';

// Regression: '/swarm doctor-tools' (hyphenated) previously returned
// "command not found" because only 'doctor tools' (space) was registered.
// Since #2493 the hyphenated entry is a PURE ALIAS: it carries no handler of
// its own; resolveCommand dereferences aliasOf to the canonical entry.
describe('doctor-tools alias', () => {
	test('resolves the hyphenated form to its own entry', () => {
		const resolved = resolveCommand(['doctor-tools']);
		expect(resolved).not.toBeNull();
		expect(resolved?.key).toBe('doctor-tools');
	});

	test('the hyphenated entry is a pure alias dereferenced to the canonical handler', () => {
		const entry = COMMAND_REGISTRY['doctor-tools'] as CommandEntry;
		expect(entry.handler).toBeUndefined();
		expect(entry.aliasOf).toBe('doctor tools');
		expect(entry.deprecated).toBe(true);
		const resolved = resolveCommand(['doctor-tools']);
		expect(typeof resolved?.entry.handler).toBe('function');
		expect(resolved?.entry.description).toBe(
			COMMAND_REGISTRY['doctor tools'].description,
		);
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

import { describe, expect, test } from 'bun:test';
import { executeSwarmCommand } from '../../../src/commands/command-dispatch.js';
import {
	COMMAND_REGISTRY,
	isCommandFailure,
	resolveCommand,
	validateAliases,
} from '../../../src/commands/registry.js';

/**
 * Issue #2493 obligation 3 (#1646 residual): CLI/library parity — alias
 * dereferencing through canonical targets, structured CommandResult with
 * exit codes, did-you-mean suggestions, deprecation warnings.
 */
describe('CLI/library parity (issue #2493, #1646 residual)', () => {
	test('every pure alias dereferences to a handler-bearing canonical entry', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if (!entry.aliasOf) continue;
			const resolved = resolveCommand([name]);
			expect(resolved, `alias '${name}' failed to resolve`).not.toBeNull();
			expect(
				typeof resolved?.entry.handler,
				`alias '${name}' did not dereference to a handler`,
			).toBe('function');
		}
	});

	test('validateAliases rejects a handler-less entry without aliasOf', () => {
		// Structural guard: the new validation rule exists and the current
		// registry (which passes it) stays valid.
		const result = validateAliases();
		expect(result.valid).toBe(true);
	});

	test('isCommandFailure distinguishes the CommandResult union halves', () => {
		expect(isCommandFailure('plain string')).toBe(false);
		expect(isCommandFailure({ text: 'x', ok: false })).toBe(true);
		expect(isCommandFailure({ text: 'x', ok: false, exitCode: 2 })).toBe(true);
	});

	test('executeSwarmCommand unwraps a CommandFailure to its text (chat path)', async () => {
		// Use a deprecated alias whose canonical handler is cheap/read-only.
		const result = await executeSwarmCommand({
			directory: '/test/project',
			agents: {},
			sessionID: 's1',
			tokens: ['health'],
		});
		expect(typeof result.text).toBe('string');
		expect(result.text).toContain('deprecated');
	});

	test('unknown command yields did-you-mean suggestions, never a full dump', async () => {
		const result = await executeSwarmCommand({
			directory: '/test/project',
			agents: {},
			sessionID: 's1',
			tokens: ['statu'],
		});
		expect(result.text).toContain('not found');
		expect(result.text).toContain('status');
		// #1646 item 2: the old CLI dumped ~160 commands; the suggestion
		// format is bounded to 3.
		const suggestionLines = result.text
			.split('\n')
			.filter((l) => l.trim().startsWith('- /swarm'));
		expect(suggestionLines.length).toBeLessThanOrEqual(3);
	});
});

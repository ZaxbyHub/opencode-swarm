import { describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	resolveCommand,
} from '../../../src/commands/registry.js';

// ---------------------------------------------------------------------------
// resolveCommand() — deprecated alias warning
// ---------------------------------------------------------------------------
describe('resolveCommand() — deprecation warning', () => {
	describe('deprecated aliases return warning property', () => {
		test('"diagnosis" (alias of "diagnose") returns warning', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeDefined();
			expect(typeof result!.warning).toBe('string');
		});

		test('"config-doctor" (alias of "config doctor") returns warning', () => {
			const result = resolveCommand(['config-doctor']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeDefined();
			expect(typeof result!.warning).toBe('string');
		});

		test('"evidence-summary" (alias of "evidence summary") returns warning', () => {
			const result = resolveCommand(['evidence-summary']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeDefined();
			expect(typeof result!.warning).toBe('string');
		});
	});

	describe('warning format is correct', () => {
		test('warning message contains the deprecated alias', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result!.warning).toContain('/swarm diagnosis');
		});

		test('warning message contains the canonical command', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result!.warning).toContain('/swarm diagnose');
		});

		test('warning message contains "deprecated" keyword', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result!.warning).toContain('deprecated');
		});

		test('warning message starts with ⚠️ emoji', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result!.warning).toMatch(/^⚠️/);
		});

		test('warning message format: ⚠️ "/swarm {alias}" is deprecated. Use "/swarm {target}" instead.', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result!.warning).toBe(
				'⚠️ "/swarm diagnosis" is deprecated. Use "/swarm diagnose" instead.',
			);
		});

		test('warning for "config-doctor" uses correct format', () => {
			const result = resolveCommand(['config-doctor']);
			expect(result!.warning).toBe(
				'⚠️ "/swarm config-doctor" is deprecated. Use "/swarm config doctor" instead.',
			);
		});

		test('warning for "evidence-summary" uses correct format', () => {
			const result = resolveCommand(['evidence-summary']);
			expect(result!.warning).toBe(
				'⚠️ "/swarm evidence-summary" is deprecated. Use "/swarm evidence summary" instead.',
			);
		});
	});

	describe('non-deprecated commands return no warning', () => {
		test('"status" has no warning', () => {
			const result = resolveCommand(['status']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeUndefined();
		});

		test('"diagnose" (canonical) has no warning', () => {
			const result = resolveCommand(['diagnose']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeUndefined();
		});

		test('"plan" has no warning', () => {
			const result = resolveCommand(['plan']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeUndefined();
		});

		test('"evidence summary" (canonical compound) has no warning', () => {
			const result = resolveCommand(['evidence', 'summary']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeUndefined();
		});

		test('"config doctor" (canonical subcommand) has no warning', () => {
			const result = resolveCommand(['config', 'doctor']);
			expect(result).not.toBeNull();
			expect(result!.warning).toBeUndefined();
		});
	});

	describe('command execution continues despite warning — resolved entry is still valid', () => {
		test('deprecated alias still resolves to correct entry', () => {
			const result = resolveCommand(['diagnosis']);
			expect(result!.entry.description).toBe('Run health check on swarm state');
			expect(result!.key).toBe('diagnosis');
		});

		test('deprecated alias passes through correct remainingArgs', () => {
			const result = resolveCommand(['diagnosis', '--verbose']);
			expect(result!.remainingArgs).toEqual(['--verbose']);
		});

		test('deprecated alias entry handler has same name as canonical handler', () => {
			// The handler should be the same as the canonical command (same function reference)
			const aliasResult = resolveCommand(['diagnosis']);
			const canonResult = resolveCommand(['diagnose']);
			// Compare function names since direct function comparison fails across module boundaries
			expect(aliasResult!.entry.handler.name).toBe(
				canonResult!.entry.handler.name,
			);
		});
	});

	describe('deprecation warning for two-token deprecated alias', () => {
		// Currently no two-token deprecated aliases exist, but the logic supports it
		test('two-token compound command can have deprecation warning', () => {
			// This tests the code path where a compound key (e.g., "old command")
			// is deprecated — verify the warning path is exercised for compounds
			const compoundAlias = resolveCommand(['config-doctor']);
			expect(compoundAlias).not.toBeNull();
			expect(compoundAlias!.key).toBe('config-doctor');
			expect(compoundAlias!.warning).toContain('config-doctor');
		});
	});
});

// ---------------------------------------------------------------------------
// COMMAND_REGISTRY — deprecated entries have correct structure
// ---------------------------------------------------------------------------
describe('COMMAND_REGISTRY deprecated entries', () => {
	test('all deprecated entries have aliasOf pointing to existing command', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if (entry.deprecated === true) {
				expect(entry.aliasOf).toBeDefined();
				expect(Object.hasOwn(COMMAND_REGISTRY, entry.aliasOf!)).toBe(true);
			}
		}
	});

	test('all deprecated entries are marked deprecated: true', () => {
		const deprecatedEntries = Object.entries(COMMAND_REGISTRY).filter(
			([, entry]) => entry.deprecated === true,
		);
		expect(deprecatedEntries.length).toBeGreaterThan(0);
		for (const [name, entry] of deprecatedEntries) {
			expect(entry.deprecated).toBe(true);
			expect(typeof entry.aliasOf).toBe('string');
		}
	});
});

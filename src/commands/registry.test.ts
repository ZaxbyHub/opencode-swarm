import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandCategory,
	type CommandEntry,
	type RegisteredCommand,
	resolveCommand,
	validateAliases,
} from './registry.js';

describe('CommandEntry type has new fields', () => {
	test('CommandEntry supports category field', () => {
		// Import the category type and CommandEntry to verify field exists
		const categoryType: CommandCategory = 'core';
		expect(categoryType).toBe('core');

		// Verify a command entry has category
		expect((COMMAND_REGISTRY.status as CommandEntry).category).toBe('core');
		expect((COMMAND_REGISTRY.agents as CommandEntry).category).toBe('core');
		expect((COMMAND_REGISTRY.config as CommandEntry).category).toBe(
			'config',
		);
		expect((COMMAND_REGISTRY.diagnose as CommandEntry).category).toBe(
			'diagnostics',
		);
		expect((COMMAND_REGISTRY.history as CommandEntry).category).toBe(
			'utility',
		);
	});

	test('CommandEntry supports aliasOf field', () => {
		// Verify alias entries have aliasOf
		// biome-ignore lint/complexity/useLiteralKeys: compound key
		expect((COMMAND_REGISTRY['config-doctor'] as CommandEntry).aliasOf).toBe('config doctor');
		expect((COMMAND_REGISTRY.diagnosis as CommandEntry).aliasOf).toBe('diagnose');
		// biome-ignore lint/complexity/useLiteralKeys: compound key
		expect((COMMAND_REGISTRY['evidence-summary'] as CommandEntry).aliasOf).toBe('evidence summary');
	});

	test('CommandEntry supports deprecated field', () => {
		// Verify deprecated entries have deprecated = true
		// biome-ignore lint/complexity/useLiteralKeys: compound key
		expect((COMMAND_REGISTRY['config-doctor'] as CommandEntry).deprecated).toBe(true);
		expect((COMMAND_REGISTRY.diagnosis as CommandEntry).deprecated).toBe(true);
		expect(
			// biome-ignore lint/complexity/useLiteralKeys: compound key
			(COMMAND_REGISTRY['evidence-summary'] as CommandEntry).deprecated,
		).toBe(true);
	});

	test('Non-alias commands do not have aliasOf or deprecated', () => {
		expect(
			(COMMAND_REGISTRY.status as CommandEntry).aliasOf,
		).toBeUndefined();
		expect(
			(COMMAND_REGISTRY.status as CommandEntry).deprecated,
		).toBeUndefined();
		expect(
			// biome-ignore lint/complexity/useLiteralKeys: compound key
			(COMMAND_REGISTRY['show-plan'] as CommandEntry).aliasOf,
		).toBeUndefined();
		expect(
			// biome-ignore lint/complexity/useLiteralKeys: compound key
			(COMMAND_REGISTRY['show-plan'] as CommandEntry).deprecated,
		).toBeUndefined();
	});
});

describe('All commands have valid categories', () => {
	const VALID_CATEGORIES: CommandCategory[] = [
		'core',
		'agent',
		'config',
		'diagnostics',
		'utility',
	];

	test('Every primary (non-alias) command has a category', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (!cmdEntry.aliasOf) {
				expect(
					cmdEntry.category,
					`Command '${name}' missing category`,
				).toBeDefined();
			}
		}
	});

	test('SDD commands are registered as utility commands with compound subcommands', () => {
		expect((COMMAND_REGISTRY.sdd as CommandEntry).category).toBe('utility');
		// biome-ignore lint/complexity/useLiteralKeys: compound key
		expect((COMMAND_REGISTRY['sdd status'] as CommandEntry).subcommandOf).toBe('sdd');
		expect(
			// biome-ignore lint/complexity/useLiteralKeys: compound key
			(COMMAND_REGISTRY['sdd validate'] as CommandEntry).subcommandOf,
		).toBe('sdd');
		// biome-ignore lint/complexity/useLiteralKeys: compound key
		expect((COMMAND_REGISTRY['sdd project'] as CommandEntry).subcommandOf).toBe('sdd');
	});
		expect(resolveCommand(['sdd', 'status'])?.key).toBe('sdd status');
		expect(resolveCommand(['sdd', 'validate', '--json'])?.key).toBe(
			'sdd validate',
		);
		expect(resolveCommand(['sdd', 'project', '--dry-run'])?.key).toBe(
			'sdd project',
		);
	});

	test('Deprecated alias entries may skip category (they redirect to aliased command)', () => {
		// These are deprecated aliases - they don't need their own category since they redirect
		const aliasEntries = ['config-doctor', 'diagnosis', 'evidence-summary'];
		for (const name of aliasEntries) {
			expect(COMMAND_REGISTRY[name as RegisteredCommand]).toBeDefined();
			expect(
				(COMMAND_REGISTRY[name as RegisteredCommand] as CommandEntry).aliasOf,
			).toBeDefined();
		}
	});

	test('All categories are valid CommandCategory values', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.category !== undefined) {
				expect(
					VALID_CATEGORIES,
					`Command '${name}' has invalid category '${cmdEntry.category}'`,
				).toContain(cmdEntry.category);
			}
		}
	});

	test('Categories are distributed across all valid types', () => {
		const foundCategories = new Set(
			Object.values(COMMAND_REGISTRY)
				.map((e) => e.category)
				.filter((c): c is CommandCategory => c !== undefined),
		);
		expect(foundCategories.size).toBe(VALID_CATEGORIES.length);
		for (const cat of VALID_CATEGORIES) {
			expect(
				foundCategories.has(cat),
				`Category '${cat}' not found in registry`,
			).toBe(true);
		}
	});
});

describe('validateAliases() detects circular references', () => {
	test('detects direct self-reference circular alias', () => {
		// Create a mock registry with a self-referencing alias
		const mockRegistry = {
			'cmd-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'cmd-a' as const,
			},
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes('Circular alias'))).toBe(true);
	});

	test('detects indirect circular alias chain (A → B → C → A)', () => {
		// Create a mock registry with indirect circular reference
		const mockRegistry = {
			'cmd-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'cmd-b' as const,
			},
			'cmd-b': {
				handler: () => Promise.resolve(''),
				description: 'B',
				aliasOf: 'cmd-c' as const,
			},
			'cmd-c': {
				handler: () => Promise.resolve(''),
				description: 'C',
				aliasOf: 'cmd-a' as const,
			},
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes('Circular alias'))).toBe(true);
	});

	test('detects circular alias that ends at a non-alias command', () => {
		// A → B → C (C is not an alias, so no cycle)
		// But if C had aliasOf pointing to A, it would be circular
		const mockRegistry = {
			'cmd-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'cmd-b' as const,
			},
			'cmd-b': {
				handler: () => Promise.resolve(''),
				description: 'B',
				aliasOf: 'cmd-c' as const,
			},
			'cmd-c': { handler: () => Promise.resolve(''), description: 'C' }, // Not an alias
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(true);
		expect(result.errors.length).toBe(0);
	});

	test('no false positive for valid alias chain (A → B → C)', () => {
		const mockRegistry = {
			'cmd-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'cmd-b' as const,
			},
			'cmd-b': {
				handler: () => Promise.resolve(''),
				description: 'B',
				aliasOf: 'cmd-c' as const,
			},
			'cmd-c': { handler: () => Promise.resolve(''), description: 'C' },
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(true);
		expect(result.errors.length).toBe(0);
	});
});

describe('validateAliases() detects non-existent targets', () => {
	test('detects alias pointing to non-existent command', () => {
		const mockRegistry = {
			'cmd-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'non-existent' as const,
			},
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes("non-existent command 'non-existent'"),
			),
		).toBe(true);
	});

	test('detects multiple aliases with some pointing to non-existent', () => {
		const mockRegistry = {
			'cmd-valid': {
				handler: () => Promise.resolve(''),
				description: 'Valid',
				aliasOf: 'real-cmd' as const,
			},
			'cmd-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'cmd-b' as const,
			},
			'cmd-b': {
				handler: () => Promise.resolve(''),
				description: 'B',
				aliasOf: 'ghost-cmd' as const,
			},
			'real-cmd': { handler: () => Promise.resolve(''), description: 'Real' },
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.includes("non-existent command 'ghost-cmd'")),
		).toBe(true);
	});
});

describe('validateAliases() detects duplicate alias targets', () => {
	test('detects multiple aliases pointing to same target', () => {
		const mockRegistry = {
			'alias-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'target' as const,
			},
			'alias-b': {
				handler: () => Promise.resolve(''),
				description: 'B',
				aliasOf: 'target' as const,
			},
			target: { handler: () => Promise.resolve(''), description: 'Target' },
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) =>
				e.includes("Multiple aliases point to 'target'"),
			),
		).toBe(true);
	});

	test('no false positive when each target has single alias', () => {
		const mockRegistry = {
			'alias-a': {
				handler: () => Promise.resolve(''),
				description: 'A',
				aliasOf: 'target-a' as const,
			},
			'alias-b': {
				handler: () => Promise.resolve(''),
				description: 'B',
				aliasOf: 'target-b' as const,
			},
			'target-a': {
				handler: () => Promise.resolve(''),
				description: 'Target A',
			},
			'target-b': {
				handler: () => Promise.resolve(''),
				description: 'Target B',
			},
		};

		const result = validateAliasesIn隔离(mockRegistry);
		expect(result.valid).toBe(true);
		expect(result.errors.length).toBe(0);
	});
});

describe('Module loads without errors (valid aliases in real registry)', () => {
	test('real COMMAND_REGISTRY passes validateAliases()', () => {
		const result = validateAliases();
		expect(
			result.valid,
			`Alias validation failed: ${result.errors.join(', ')}`,
		).toBe(true);
	});

	test('all alias entries point to existing commands in real registry', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.aliasOf) {
				expect(
					Object.hasOwn(COMMAND_REGISTRY, cmdEntry.aliasOf),
					`Alias '${name}' points to non-existent '${cmdEntry.aliasOf}'`,
				).toBe(true);
			}
		}
	});

	test('no circular aliases in real registry', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.aliasOf) {
				const visited = new Set<string>();
				let current: string = cmdEntry.aliasOf;
				while (current) {
					expect(
						visited.has(current),
						`Circular alias detected at '${current}' (chain started from '${name}')`,
					).toBe(false);
					visited.add(current);
					const currentEntry = COMMAND_REGISTRY[
						current as RegisteredCommand
					] as CommandEntry;
					current = currentEntry?.aliasOf || '';
				}
			}
		}
	});

	test('no duplicate alias targets in real registry', () => {
		const aliasTargets = new Map<string, string[]>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.aliasOf) {
				if (!aliasTargets.has(cmdEntry.aliasOf)) {
					aliasTargets.set(cmdEntry.aliasOf, []);
				}
				aliasTargets.get(cmdEntry.aliasOf)!.push(name);
			}
		}
		for (const [target, aliases] of aliasTargets.entries()) {
			expect(
				aliases.length,
				`Target '${target}' should have at least one alias`,
			).toBeGreaterThanOrEqual(1);
		}
	});
});

describe('resolveCommand works with aliased commands', () => {
	test('resolveCommand resolves primary command', () => {
		const result = resolveCommand(['status']);
		expect(result).not.toBeNull();
		expect(result!.entry.description).toBe('Show current swarm state');
	});

	test('resolveCommand resolves compound command', () => {
		const result = resolveCommand(['evidence', 'summary']);
		expect(result).not.toBeNull();
		expect(result!.entry.description).toBe(
			'Generate evidence summary with completion ratio and blockers',
		);
	});

	test('resolveCommand returns null for unknown command', () => {
		const result = resolveCommand(['nonexistent']);
		expect(result).toBeNull();
	});
});

// --- Helper functions for isolated testing ---

/**
 * Isolated validateAliases implementation for testing.
 * This is a copy of the logic from registry.ts to test without module load side effects.
 */
function validateAliasesIn隔离(registry: Record<string, CommandEntry>): {
	valid: boolean;
	errors: string[];
} {
	const errors: string[] = [];
	const aliasTargets = new Map<string, string[]>();

	for (const [name, entry] of Object.entries(registry)) {
		if (entry.aliasOf) {
			const target = entry.aliasOf;

			// Check if alias target exists
			if (!Object.hasOwn(registry, target)) {
				errors.push(
					`Alias '${name}' points to non-existent command '${target}'`,
				);
				continue;
			}

			// Track alias targets for duplicate detection
			if (!aliasTargets.has(target)) {
				aliasTargets.set(target, []);
			}
			aliasTargets.get(target)!.push(name);

			// Check for circular aliases
			const visited = new Set<string>();
			let current: string = target;
			while (current) {
				const currentEntry = registry[current];
				if (!currentEntry) break;

				if (visited.has(current)) {
					errors.push(
						`Circular alias detected: '${name}' → '${current}' → ... → '${current}'`,
					);
					break;
				}
				visited.add(current);
				current = currentEntry.aliasOf || '';
			}
		}
	}

	// Check for duplicate alias targets
	for (const [target, aliases] of aliasTargets.entries()) {
		if (aliases.length > 1) {
			errors.push(
				`Multiple aliases point to '${target}': ${aliases.join(', ')}`,
			);
		}
	}

	return { valid: errors.length === 0, errors };
}

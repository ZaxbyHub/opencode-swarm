import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	type RegisteredCommand,
	resolveCommand,
	VALID_COMMANDS,
	validateAliases,
} from '../../../src/commands/registry.js';

// ---------------------------------------------------------------------------
// Test fixtures — fresh CommandContext for resolveCommand tests
// ---------------------------------------------------------------------------
const mockAgents = {} as Record<
	string,
	import('../../../src/agents/index.js').AgentDefinition
>;
const mockCtx = {
	directory: '/fake/project',
	args: [],
	sessionID: 'test-session-001',
	agents: mockAgents,
};

describe('CommandRegistry types and structure', () => {
	test('VALID_COMMANDS is a non-empty array of registered command names', () => {
		expect(Array.isArray(VALID_COMMANDS)).toBe(true);
		expect(VALID_COMMANDS.length).toBeGreaterThan(0);
	});

	test('every VALID_COMMANDS entry exists as a key in COMMAND_REGISTRY', () => {
		for (const name of VALID_COMMANDS) {
			expect(Object.hasOwn(COMMAND_REGISTRY, name)).toBe(true);
		}
	});

	test('every COMMAND_REGISTRY entry has a handler function', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			expect(typeof entry.handler, `Command '${name}' missing handler`).toBe(
				'function',
			);
		}
	});

	test('every COMMAND_REGISTRY entry has a non-empty description', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			expect(
				typeof entry.description,
				`Command '${name}' missing description`,
			).toBe('string');
			expect(
				entry.description.length,
				`Command '${name}' has empty description`,
			).toBeGreaterThan(0);
		}
	});

	test('entries with subcommandOf are subcommands', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.subcommandOf) {
				expect(typeof cmdEntry.subcommandOf).toBe('string');
				// subcommandOf must point to a parent that exists in the registry
				expect(Object.hasOwn(COMMAND_REGISTRY, cmdEntry.subcommandOf)).toBe(
					true,
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// CommandEntry fields: category, aliasOf, deprecated
// ---------------------------------------------------------------------------
describe('CommandEntry — category field', () => {
	const VALID_CATEGORIES = [
		'core',
		'agent',
		'config',
		'diagnostics',
		'utility',
	] as const;

	test('category is always one of the defined CommandCategory values', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.category !== undefined) {
				expect(VALID_CATEGORIES).toContain(cmdEntry.category);
			}
		}
	});

	test('core commands have category "core"', () => {
		const coreCommands = ['status', 'plan', 'agents', 'handoff', 'close'];
		for (const name of coreCommands) {
			const entry = COMMAND_REGISTRY[name as RegisteredCommand];
			expect(entry?.category).toBe('core');
		}
	});

	test('agent commands have category "agent"', () => {
		const agentCommands = [
			'analyze',
			'clarify',
			'specify',
			'brainstorm',
			'council',
			'pr-review',
			'pr-feedback',
			'issue',
			'deep-dive',
			'codebase-review',
		];
		for (const name of agentCommands) {
			const entry = COMMAND_REGISTRY[name as RegisteredCommand];
			expect(entry?.category).toBe('agent');
		}
	});

	test('diagnostics commands have category "diagnostics"', () => {
		const diagCommands = [
			'diagnose',
			'preflight',
			'benchmark',
			'dark-matter',
			'simulate',
			'doctor tools',
		];
		for (const name of diagCommands) {
			const entry = COMMAND_REGISTRY[name as RegisteredCommand];
			expect(entry?.category).toBe('diagnostics');
		}
	});
});

describe('CommandEntry — aliasOf field', () => {
	test('aliasOf always points to an existing command in the registry', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.aliasOf) {
				expect(Object.hasOwn(COMMAND_REGISTRY, cmdEntry.aliasOf)).toBe(true);
			}
		}
	});

	test('alias entries redirect to their canonical command', () => {
		// 'diagnosis' is an alias of 'diagnose'
		const diagnosis = COMMAND_REGISTRY[
			'diagnosis' as RegisteredCommand
		] as CommandEntry;
		expect(diagnosis?.aliasOf).toBe('diagnose');

		// 'config-doctor' is an alias of 'config doctor'
		const configDoctor = COMMAND_REGISTRY[
			'config-doctor' as RegisteredCommand
		] as CommandEntry;
		expect(configDoctor?.aliasOf).toBe('config doctor');

		// 'evidence-summary' is an alias of 'evidence summary'
		const evidenceSummary = COMMAND_REGISTRY[
			'evidence-summary' as RegisteredCommand
		] as CommandEntry;
		expect(evidenceSummary?.aliasOf).toBe('evidence summary');

		// 'deep dive' is an alias of 'deep-dive'
		const deepDiveAlias = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(deepDiveAlias?.aliasOf).toBe('deep-dive');

		// 'codebase review' is an alias of 'codebase-review'
		const codebaseReviewAlias = COMMAND_REGISTRY[
			'codebase review' as RegisteredCommand
		] as CommandEntry;
		expect(codebaseReviewAlias?.aliasOf).toBe('codebase-review');
	});
});

describe('CommandEntry — deprecated field', () => {
	test('deprecated entries also have aliasOf set', () => {
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (cmdEntry.deprecated === true) {
				expect(
					typeof cmdEntry.aliasOf,
					`Deprecated command '${name}' must have aliasOf`,
				).toBe('string');
			}
		}
	});

	test('deprecated commands are marked deprecated: true', () => {
		const deprecatedCommands = [
			'diagnosis',
			'config-doctor',
			'evidence-summary',
		];
		for (const name of deprecatedCommands) {
			const entry = COMMAND_REGISTRY[name as RegisteredCommand];
			expect(entry?.deprecated).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// validateAliases()
// ---------------------------------------------------------------------------
describe('validateAliases()', () => {
	test('returns valid: true when registry has no alias errors', () => {
		const result = validateAliases();
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('module-level validation throws on load if aliases are invalid', () => {
		// This is implicitly tested — the module loaded successfully above,
		// which means no Error was thrown from the module-level validation.
		// We verify the actual registry is valid.
		expect(validateAliases().valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resolveCommand()
// ---------------------------------------------------------------------------
describe('resolveCommand()', () => {
	describe('happy path — existing commands', () => {
		test('resolves single-token command "status"', () => {
			const result = resolveCommand(['status']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe('Show current swarm state');
			expect(result!.remainingArgs).toEqual([]);
		});

		test('resolves single-token command with trailing args', () => {
			const result = resolveCommand(['plan', '2']);
			expect(result).not.toBeNull();
			expect(result!.remainingArgs).toEqual(['2']);
		});

		test('resolves consolidate command with flags', () => {
			const result = resolveCommand(['consolidate', '--respect-interval']);
			expect(result).not.toBeNull();
			expect(result!.key).toBe('consolidate');
			expect(result!.remainingArgs).toEqual(['--respect-interval']);
		});

		test('resolves two-token compound "evidence summary"', () => {
			const result = resolveCommand(['evidence', 'summary']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				'Generate evidence summary with completion ratio and blockers',
			);
			expect(result!.remainingArgs).toEqual([]);
		});

		test('resolves two-token compound with trailing args', () => {
			const result = resolveCommand(['evidence', 'summary', 'task-1']);
			expect(result).not.toBeNull();
			expect(result!.remainingArgs).toEqual(['task-1']);
		});

		test('resolves "config doctor" (subcommand)', () => {
			const result = resolveCommand(['config', 'doctor']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe('Run config doctor checks');
		});

		test('resolves "knowledge migrate" (subcommand)', () => {
			const result = resolveCommand(['knowledge', 'migrate']);
			expect(result).not.toBeNull();
			expect(result!.entry.subcommandOf).toBe('knowledge');
		});

		test('resolves memory subcommands', () => {
			for (const subcommand of [
				'status',
				'pending',
				'recall-log',
				'compact',
				'stale',
				'export',
				'import',
				'migrate',
			]) {
				const result = resolveCommand(['memory', subcommand]);
				expect(result).not.toBeNull();
				expect(result!.entry.subcommandOf).toBe('memory');
				expect(result!.remainingArgs).toEqual([]);
			}
		});

		test('resolves alias "diagnosis" → same category and aliasOf target as "diagnose"', () => {
			const diagnoseResult = resolveCommand(['diagnose']);
			const diagnosisResult = resolveCommand(['diagnosis']);
			expect(diagnoseResult).not.toBeNull();
			expect(diagnosisResult).not.toBeNull();
			// Both should have same category
			expect(diagnosisResult!.entry.category).toBe(
				diagnoseResult!.entry.category,
			);
			// diagnosis is an alias of diagnose
			expect((COMMAND_REGISTRY.diagnosis as CommandEntry).aliasOf).toBe(
				'diagnose',
			);
		});
	});

	describe('edge cases — empty / missing inputs', () => {
		test('returns null for empty token array', () => {
			expect(resolveCommand([])).toBeNull();
		});

		test('returns null for completely unknown single token', () => {
			expect(resolveCommand(['nonexistent-command'])).toBeNull();
		});

		test('returns null for unknown two-token compound, then falls back to first token as single', () => {
			// "foo bar" doesn't exist, so it should NOT fall back to "foo" alone
			// (two-token compounds that don't exist return null, not fallback)
			expect(resolveCommand(['foo', 'bar'])).toBeNull();
		});

		test('returns null for first token matching, second token unknown (no compound match)', () => {
			// "plan xyz" doesn't exist as a compound key, and since "plan" is a real
			// command, should it fall back? The spec says try compound first, then single.
			// So "plan xyz" tries "plan xyz" (fails) then "plan" (succeeds).
			const result = resolveCommand(['plan', 'xyz']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				'Show current plan (deprecated alias for /swarm show-plan)',
			);
			expect(result!.remainingArgs).toEqual(['xyz']);
		});
	});

	describe('state mutation — remainingArgs slicing', () => {
		test('three-token input with two-token compound yields correct remainingArgs', () => {
			const result = resolveCommand([
				'evidence',
				'summary',
				'task-3',
				'--verbose',
			]);
			expect(result).not.toBeNull();
			expect(result!.remainingArgs).toEqual(['task-3', '--verbose']);
		});

		test('single-token with multiple args preserves all after first', () => {
			const result = resolveCommand(['archive', '--dry-run', '--confirm']);
			expect(result).not.toBeNull();
			expect(result!.remainingArgs).toEqual(['--dry-run', '--confirm']);
		});
	});
});

// ---------------------------------------------------------------------------
// Property-based / invariant tests
// ---------------------------------------------------------------------------
describe('resolveCommand() — invariants', () => {
	test('IDEMPOTENCY: resolveCommand returns the same entry for the same input', () => {
		const input = ['pr-review', 'owner/repo#42', '--council'];
		const first = resolveCommand(input);
		const second = resolveCommand(input);
		expect(first).toEqual(second);
	});

	test('ROUND-TRIP: resolveCommand entry is always found in COMMAND_REGISTRY', () => {
		const testCases = [
			['status'],
			['plan'],
			['agents'],
			['config', 'doctor'],
			['evidence', 'summary'],
			['knowledge', 'migrate'],
			['memory', 'status'],
			['dark-matter'],
			['council'],
			['checkpoint', 'list'],
		];
		for (const tokens of testCases) {
			const result = resolveCommand(tokens);
			if (result) {
				const found = Object.values(COMMAND_REGISTRY).includes(result.entry);
				expect(found).toBe(true);
			}
		}
	});

	test('MONOTONICITY: resolveCommand never modifies tokens — only slices remainingArgs', () => {
		// For single-token commands, adding more args simply appends them to remainingArgs.
		// Two-token compound commands take two tokens; trailing args follow.
		const r1 = resolveCommand(['status']);
		const r2 = resolveCommand(['status', 'extra1']);
		const r3 = resolveCommand(['status', 'extra1', 'extra2']);
		expect(r1!.remainingArgs).toEqual([]);
		expect(r2!.remainingArgs).toEqual(['extra1']);
		expect(r3!.remainingArgs).toEqual(['extra1', 'extra2']);

		// Compound command case
		const c1 = resolveCommand(['evidence', 'summary']);
		const c2 = resolveCommand(['evidence', 'summary', 'task-3']);
		expect(c1!.remainingArgs).toEqual([]);
		expect(c2!.remainingArgs).toEqual(['task-3']);
	});
});

// ---------------------------------------------------------------------------
// Adversarial / security boundary tests
// ---------------------------------------------------------------------------
describe('resolveCommand() — adversarial inputs', () => {
	test('__proto__ key is safely handled (no prototype pollution)', () => {
		// Object.hasOwn is used in resolveCommand, so __proto__ should return null
		const result = resolveCommand(['__proto__', 'polluted']);
		expect(result).toBeNull();
	});

	test('constructor key is safely handled', () => {
		const result = resolveCommand(['constructor', 'alert']);
		expect(result).toBeNull();
	});

	test('very long token array does not cause issues', () => {
		const longArgs = Array(100).fill('arg');
		const result = resolveCommand(['status', ...longArgs]);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(longArgs);
	});

	test('unicode tokens are handled gracefully', () => {
		const result = resolveCommand(['stâtus', '😀']);
		// These are not valid commands, so should return null
		expect(result).toBeNull();
	});

	test('empty string token in array is handled', () => {
		// eslint-disable-next-line no-sparse-arrays
		const result = resolveCommand(['status', '', 'extra']);
		expect(result).not.toBeNull();
		expect(result!.remainingArgs).toEqual(['', 'extra']);
	});
});

// ---------------------------------------------------------------------------
// Task 3.1: New alias coverage — doctor, info, list-agents, health, check, clear
// ---------------------------------------------------------------------------
describe('Task 3.1 — New alias entries (doctor, info, list-agents, health, check, clear)', () => {
	// 1. Verify all 6 aliases exist in registry
	test('all 6 new aliases exist as keys in COMMAND_REGISTRY', () => {
		const newAliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		for (const alias of newAliases) {
			expect(
				Object.hasOwn(COMMAND_REGISTRY, alias),
				`Alias '${alias}' should exist in COMMAND_REGISTRY`,
			).toBe(true);
		}
	});

	// 2. Verify aliases have correct fields (handler, description, category, aliasOf, deprecated)
	test('each new alias has a handler function', () => {
		const newAliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		for (const alias of newAliases) {
			const entry = COMMAND_REGISTRY[alias as RegisteredCommand];
			expect(
				typeof entry.handler,
				`Alias '${alias}' should have a handler function`,
			).toBe('function');
		}
	});

	test('each new alias has a non-empty description', () => {
		const newAliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		for (const alias of newAliases) {
			const entry = COMMAND_REGISTRY[alias as RegisteredCommand];
			expect(typeof entry.description).toBe('string');
			expect(
				entry.description.length,
				`Alias '${alias}' should have a non-empty description`,
			).toBeGreaterThan(0);
		}
	});

	test('each new alias has a category field', () => {
		const newAliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		const VALID_CATEGORIES = [
			'core',
			'agent',
			'config',
			'diagnostics',
			'utility',
		] as const;
		for (const alias of newAliases) {
			const entry = COMMAND_REGISTRY[
				alias as RegisteredCommand
			] as CommandEntry;
			expect(
				VALID_CATEGORIES,
				`Alias '${alias}' should have a valid category`,
			).toContain(entry.category);
		}
	});

	test('each new alias has aliasOf pointing to an existing command', () => {
		const newAliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		for (const alias of newAliases) {
			const entry = COMMAND_REGISTRY[
				alias as RegisteredCommand
			] as CommandEntry;
			expect(
				typeof entry.aliasOf,
				`Alias '${alias}' should have aliasOf field`,
			).toBe('string');
			expect(
				Object.hasOwn(COMMAND_REGISTRY, entry.aliasOf!),
				`Alias '${alias}' aliasOf target '${entry.aliasOf}' should exist in registry`,
			).toBe(true);
		}
	});

	test('each new alias is marked deprecated: true', () => {
		const newAliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		for (const alias of newAliases) {
			const entry = COMMAND_REGISTRY[
				alias as RegisteredCommand
			] as CommandEntry;
			expect(
				entry.deprecated,
				`Alias '${alias}' should be marked deprecated: true`,
			).toBe(true);
		}
	});

	// 3. Verify aliases resolve to canonical commands via resolveCommand()
	test('resolveCommand() resolves each alias to its canonical command', () => {
		// doctor → config doctor
		const doctorResult = resolveCommand(['doctor']);
		expect(doctorResult).not.toBeNull();
		expect(doctorResult!.key).toBe('doctor');
		expect(doctorResult!.entry.aliasOf).toBe('config doctor');

		// info → status
		const infoResult = resolveCommand(['info']);
		expect(infoResult).not.toBeNull();
		expect(infoResult!.key).toBe('info');
		expect(infoResult!.entry.aliasOf).toBe('status');

		// list-agents → agents
		const listAgentsResult = resolveCommand(['list-agents']);
		expect(listAgentsResult).not.toBeNull();
		expect(listAgentsResult!.key).toBe('list-agents');
		expect(listAgentsResult!.entry.aliasOf).toBe('agents');

		// health → diagnose
		const healthResult = resolveCommand(['health']);
		expect(healthResult).not.toBeNull();
		expect(healthResult!.key).toBe('health');
		expect(healthResult!.entry.aliasOf).toBe('diagnose');

		// check → preflight
		const checkResult = resolveCommand(['check']);
		expect(checkResult).not.toBeNull();
		expect(checkResult!.key).toBe('check');
		expect(checkResult!.entry.aliasOf).toBe('preflight');

		// clear → reset-session
		const clearResult = resolveCommand(['clear']);
		expect(clearResult).not.toBeNull();
		expect(clearResult!.key).toBe('clear');
		expect(clearResult!.entry.aliasOf).toBe('reset-session');
	});

	// 4. Verify deprecation warnings work
	test('resolveCommand() returns deprecation warning for each new alias', () => {
		const aliases = [
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];
		const expectedWarnings = [
			'config doctor',
			'status',
			'agents',
			'diagnose',
			'preflight',
			'reset-session',
		];

		for (let i = 0; i < aliases.length; i++) {
			const result = resolveCommand([aliases[i]]);
			expect(result).not.toBeNull();
			expect(
				result!.warning,
				`Alias '${aliases[i]}' should produce a deprecation warning`,
			).toBeDefined();
			expect(
				result!.warning,
				`Warning for '${aliases[i]}' should suggest '${expectedWarnings[i]}'`,
			).toContain(expectedWarnings[i]);
			expect(
				result!.warning,
				`Warning for '${aliases[i]}' should mention deprecated`,
			).toContain('deprecated');
		}
	});

	// 5. Verify validateAliases() passes
	test('validateAliases() returns valid: true with no errors', () => {
		const result = validateAliases();
		expect(
			result.valid,
			`validateAliases should pass. Errors: ${result.errors.join(', ')}`,
		).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('validateAliases() produces no alias errors for new aliases', () => {
		const result = validateAliases();
		for (const error of result.errors) {
			expect(error).not.toContain('doctor');
			expect(error).not.toContain('info');
			expect(error).not.toContain('list-agents');
			expect(error).not.toContain('health');
			expect(error).not.toContain('check');
			expect(error).not.toContain('clear');
		}
	});
});

// ---------------------------------------------------------------------------
// Alias coverage verification
// ---------------------------------------------------------------------------
describe('COMMAND_REGISTRY alias entries — completeness', () => {
	test('known aliases are present in registry', () => {
		const knownAliases = [
			'diagnosis',
			'config-doctor',
			'evidence-summary',
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
			'deep dive',
			'codebase review',
		];
		for (const alias of knownAliases) {
			expect(Object.hasOwn(COMMAND_REGISTRY, alias)).toBe(true);
		}
	});

	test('alias entries have correct category inherited from target', () => {
		// 'diagnosis' inherits 'diagnostics' category from 'diagnose'
		const diagnosis = COMMAND_REGISTRY[
			'diagnosis' as RegisteredCommand
		] as CommandEntry;
		const diagnose = COMMAND_REGISTRY[
			'diagnose' as RegisteredCommand
		] as CommandEntry;
		expect(diagnosis.category).toBe(diagnose.category);
	});

	test('new aliases inherit category from their canonical targets', () => {
		// doctor → config doctor (diagnostics)
		const doctorEntry = COMMAND_REGISTRY[
			'doctor' as RegisteredCommand
		] as CommandEntry;
		const configDoctorEntry = COMMAND_REGISTRY['config doctor'] as CommandEntry;
		expect(doctorEntry.category).toBe(configDoctorEntry.category);

		// info → status (core)
		const infoEntry = COMMAND_REGISTRY[
			'info' as RegisteredCommand
		] as CommandEntry;
		const statusEntry = COMMAND_REGISTRY.status as CommandEntry;
		expect(infoEntry.category).toBe(statusEntry.category);

		// list-agents → agents (core)
		const listAgentsEntry = COMMAND_REGISTRY[
			'list-agents' as RegisteredCommand
		] as CommandEntry;
		const agentsEntry = COMMAND_REGISTRY.agents as CommandEntry;
		expect(listAgentsEntry.category).toBe(agentsEntry.category);

		// health → diagnose (diagnostics)
		const healthEntry = COMMAND_REGISTRY[
			'health' as RegisteredCommand
		] as CommandEntry;
		const diagnoseEntry = COMMAND_REGISTRY.diagnose as CommandEntry;
		expect(healthEntry.category).toBe(diagnoseEntry.category);

		// check → preflight (diagnostics)
		const checkEntry = COMMAND_REGISTRY[
			'check' as RegisteredCommand
		] as CommandEntry;
		const preflightEntry = COMMAND_REGISTRY.preflight as CommandEntry;
		expect(checkEntry.category).toBe(preflightEntry.category);

		// clear → reset-session (utility)
		const clearEntry = COMMAND_REGISTRY[
			'clear' as RegisteredCommand
		] as CommandEntry;
		const resetSessionEntry = COMMAND_REGISTRY['reset-session'] as CommandEntry;
		expect(clearEntry.category).toBe(resetSessionEntry.category);
	});
});

// ---------------------------------------------------------------------------
// deep-dive command — FR-025 through FR-028 registration verification
// ---------------------------------------------------------------------------
describe('deep-dive command registration (FR-025 through FR-028)', () => {
	test('deep-dive entry exists in COMMAND_REGISTRY', () => {
		expect(Object.hasOwn(COMMAND_REGISTRY, 'deep-dive')).toBe(true);
	});

	test('deep-dive entry has a handler function', () => {
		const entry = COMMAND_REGISTRY['deep-dive' as RegisteredCommand];
		expect(typeof entry.handler).toBe('function');
	});

	test('deep-dive entry has non-empty description', () => {
		const entry = COMMAND_REGISTRY['deep-dive' as RegisteredCommand];
		expect(typeof entry.description).toBe('string');
		expect(entry.description.length).toBeGreaterThan(0);
	});

	test('deep-dive entry has args field', () => {
		const entry = COMMAND_REGISTRY['deep-dive' as RegisteredCommand];
		expect(entry.args).toBe(
			'<scope> [--profile standard|security|ux|architecture|full] [--max-explorers 1..8] [--json] [--skip-update] [--allow-dirty]',
		);
	});

	test('deep-dive entry has details field', () => {
		const entry = COMMAND_REGISTRY['deep-dive' as RegisteredCommand];
		expect(entry.details).toContain('parallel explorer waves');
		expect(entry.details).toContain('always 2 parallel reviewers');
		expect(entry.details).toContain('critic challenge');
	});

	test('deep-dive entry has category "agent"', () => {
		const entry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.category).toBe('agent');
	});

	test('deep dive alias entry exists in COMMAND_REGISTRY', () => {
		expect(Object.hasOwn(COMMAND_REGISTRY, 'deep dive')).toBe(true);
	});

	test('deep dive alias has aliasOf pointing to deep-dive', () => {
		const entry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(entry.aliasOf).toBe('deep-dive');
	});

	test('deep dive alias inherits category from deep-dive', () => {
		const deepDiveEntry = COMMAND_REGISTRY[
			'deep-dive' as RegisteredCommand
		] as CommandEntry;
		const deepDiveAliasEntry = COMMAND_REGISTRY[
			'deep dive' as RegisteredCommand
		] as CommandEntry;
		expect(deepDiveAliasEntry.category).toBe(deepDiveEntry.category);
	});

	test('resolveCommand resolves deep-dive correctly', () => {
		const result = resolveCommand(['deep-dive']);
		expect(result).not.toBeNull();
		expect(result!.key).toBe('deep-dive');
		expect(result!.entry.category).toBe('agent');
	});

	test('resolveCommand resolves deep dive alias to deep-dive handler', () => {
		const result = resolveCommand(['deep', 'dive']);
		expect(result).not.toBeNull();
		expect(result!.key).toBe('deep dive');
		expect(result!.entry.aliasOf).toBe('deep-dive');
	});
});

import { describe, expect, it } from 'bun:test';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	resolveCommand,
	VALID_COMMANDS,
} from './registry';

describe('CommandEntry type', () => {
	describe('backward compatibility - entries without details/args', () => {
		it('should accept a minimal CommandEntry without optional fields', () => {
			const minimalEntry: CommandEntry = {
				handler: async () => 'ok',
				description: 'A test command',
			};

			expect(minimalEntry.description).toBe('A test command');
			expect(minimalEntry.details).toBeUndefined();
			expect(minimalEntry.args).toBeUndefined();
		});

		it('should accept entries with subcommandOf but no details/args', () => {
			const subcommandEntry: CommandEntry = {
				handler: async () => 'ok',
				description: 'A subcommand',
				subcommandOf: 'parent',
			};

			expect(subcommandEntry.subcommandOf).toBe('parent');
			expect(subcommandEntry.details).toBeUndefined();
			expect(subcommandEntry.args).toBeUndefined();
		});

		it('medium-complexity commands have args set', () => {
			// MEDIUM-complexity commands added args (empty string '' counts as having args)
			const MEDIUM_COMPLEXITY_COMMANDS = [
				'turbo',
				'full-auto',
				'simulate',
				'dark-matter',
				'benchmark',
				'export',
				'evidence',
				'evidence summary',
				'evidence-summary',
				'handoff',
				'specify',
				'clarify',
				'analyze',
				'acknowledge-spec-drift',
				'sync-plan',
				'curate',
				'retrieve',
			] as const;
			for (const name of MEDIUM_COMPLEXITY_COMMANDS) {
				const entry = COMMAND_REGISTRY[name] as CommandEntry;
				expect(entry).toBeDefined();
				expect(typeof entry.args).toBe('string');
				expect(entry.args!.length).toBeGreaterThanOrEqual(0);
			}
		});

		it('commands expected to have details actually do', () => {
			// Commands that should have both details AND args (evidence-summary alias has no details)
			const COMMANDS_WITH_DETAILS = [
				'export',
				'evidence',
				'evidence summary',
				'handoff',
				'retrieve',
			] as const;
			for (const name of COMMANDS_WITH_DETAILS) {
				const entry = COMMAND_REGISTRY[name] as CommandEntry;
				expect(entry).toBeDefined();
				expect(typeof entry.details).toBe('string');
				expect(entry.details!.length).toBeGreaterThan(0);
			}
		});

		it('simple commands have no details/args', () => {
			// Simple observation commands that need no args or details
			const SIMPLE_COMMANDS = [
				'status',
				'plan',
				'agents',
				'history',
				'config',
				'config doctor',
				'config-doctor',
				'doctor tools',
				'diagnose',
				'preflight',
				'knowledge',
			] as const;
			for (const name of SIMPLE_COMMANDS) {
				const entry = COMMAND_REGISTRY[name] as CommandEntry;
				expect(entry).toBeDefined();
				expect(entry.details).toBeUndefined();
				expect(entry.args).toBeUndefined();
			}
		});
	});

	describe('forward compatibility - entries with details/args', () => {
		it('should accept a CommandEntry with only details field', () => {
			const withDetails: CommandEntry = {
				handler: async () => 'ok',
				description: 'A test command',
				details: 'This command does X then Y. Side effect: writes to disk.',
			};

			expect(withDetails.details).toBe(
				'This command does X then Y. Side effect: writes to disk.',
			);
			expect(withDetails.args).toBeUndefined();
		});

		it('should accept a CommandEntry with only args field', () => {
			const withArgs: CommandEntry = {
				handler: async () => 'ok',
				description: 'A test command',
				args: '--dry-run, --confirm, <phase-number>',
			};

			expect(withArgs.args).toBe('--dry-run, --confirm, <phase-number>');
			expect(withArgs.details).toBeUndefined();
		});

		it('should accept a CommandEntry with both details and args', () => {
			const fullEntry: CommandEntry = {
				handler: async () => 'ok',
				description: 'A test command',
				details: 'Step 1: Do X. Step 2: Do Y. Safe: read-only operation.',
				args: '--verbose, <target>',
			};

			expect(fullEntry.details).toBe(
				'Step 1: Do X. Step 2: Do Y. Safe: read-only operation.',
			);
			expect(fullEntry.args).toBe('--verbose, <target>');
		});

		it('should accept a CommandEntry with all fields including subcommandOf', () => {
			const completeEntry: CommandEntry = {
				handler: async () => 'ok',
				description: 'A subcommand',
				subcommandOf: 'parent',
				details: 'Handles the subcommand flow.',
				args: '--force, <id>',
			};

			expect(completeEntry.subcommandOf).toBe('parent');
			expect(completeEntry.details).toBe('Handles the subcommand flow.');
			expect(completeEntry.args).toBe('--force, <id>');
		});
	});

	describe('COMMAND_REGISTRY integrity', () => {
		it('VALID_COMMANDS should match registry keys', () => {
			const registryKeys = Object.keys(COMMAND_REGISTRY).sort();
			const validCommands = [...VALID_COMMANDS].sort();

			expect(validCommands as string[]).toEqual(registryKeys);
		});

		it('should have at least 30 commands registered', () => {
			expect(Object.keys(COMMAND_REGISTRY).length).toBeGreaterThanOrEqual(30);
		});

		it('all registry entries should have required fields (handler and description)', () => {
			for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
				expect(entry, `Command "${name}" should have a handler`).toBeDefined();
				expect(
					typeof entry.handler === 'function' ||
						typeof entry.aliasOf === 'string',
					`Command "${name}" should have a handler or an aliasOf target (#2493)`,
				).toBe(true);
				expect(
					typeof entry.description,
					`Command "${name}" should have a description string`,
				).toBe('string');
				expect(
					entry.description.length,
					`Command "${name}" description should not be empty`,
				).toBeGreaterThan(0);
			}
		});

		it('resolveCommand should find known commands', () => {
			const result = resolveCommand(['status']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				'Show current swarm state (plus background-work health when hooks.background_subagents is enabled)',
			);
		});

		it('resolveCommand should find compound commands', () => {
			const result = resolveCommand(['evidence', 'summary']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				'Generate evidence summary with completion ratio and blockers',
			);
		});

		it('resolveCommand should return null for unknown commands', () => {
			const result = resolveCommand(['nonexistent']);
			expect(result).toBeNull();
		});
	});

	describe('high-complexity command documentation', () => {
		// Commands that have non-trivial behavior, side effects, or complex arguments
		const HIGH_COMPLEXITY_COMMANDS = [
			'close',
			'reset',
			'reset-session',
			'checkpoint',
			'rollback',
			'archive',
			'write-retro',
			'promote',
			'knowledge quarantine',
			'knowledge restore',
			'knowledge migrate',
		] as const;

		// reset-session takes no arguments (clears only session state.json)
		const NO_ARG_COMMANDS = new Set(['reset-session']);

		it('all 11 high-complexity commands have non-empty details field', () => {
			for (const name of HIGH_COMPLEXITY_COMMANDS) {
				const entry = COMMAND_REGISTRY[name];
				expect(entry).toBeDefined();
				expect(typeof entry.details).toBe('string');
				expect(entry.details!.length).toBeGreaterThan(0);
			}
		});

		it('all 11 high-complexity commands have args field (empty string is valid for no-arg commands)', () => {
			for (const name of HIGH_COMPLEXITY_COMMANDS) {
				const entry = COMMAND_REGISTRY[name];
				expect(entry).toBeDefined();
				expect(typeof entry.args).toBe('string');
				// reset-session has no args — empty string is correct
				if (!NO_ARG_COMMANDS.has(name)) {
					expect(entry.args!.length).toBeGreaterThan(0);
				}
			}
		});

		it('all details strings are under 500 characters', () => {
			for (const name of HIGH_COMPLEXITY_COMMANDS) {
				const entry = COMMAND_REGISTRY[name];
				expect(entry.details!.length).toBeLessThan(500);
			}
		});

		it('all args strings follow format convention (contain -- flags or < positional args)', () => {
			for (const name of HIGH_COMPLEXITY_COMMANDS) {
				const entry = COMMAND_REGISTRY[name];
				const args = entry.args!;
				// reset-session has no args — empty string skips this check
				if (args.length === 0) continue;
				const hasFlags = args.includes('--');
				const hasPositional = args.includes('<');
				expect(hasFlags || hasPositional).toBe(true);
			}
		});
	});
});

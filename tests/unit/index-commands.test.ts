import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'bun:test';
import {
	COMMAND_REGISTRY,
	VALID_COMMANDS,
} from '../../src/commands/registry.js';
import OpenCodeSwarm from '../../src/index';
import {
	createIndexCommandsIsolation,
	createIndexCommandsModuleGuards,
	createMockPluginInput,
} from '../helpers/index-commands-shared.js';

// Minimal @opencode-ai/plugin input — the command registration path only reads
// `directory`/`worktree`, which the isolation helper repoints per test.
const mockPluginInput = createMockPluginInput();
const isolation = createIndexCommandsIsolation(mockPluginInput);
// File-scoped, NOT per-test: see `createIndexCommandsModuleGuards` for why the
// background-task override must be installed/restored around the whole file
// (PR #2173 F-006).
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
beforeEach(isolation.setUp);
afterEach(isolation.tearDown);
afterAll(moduleGuards.tearDownAll);

describe('Swarm subcommand registration', () => {
	it('should initialize plugin successfully', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		expect(plugin).toBeDefined();
		// Plugin returns Hooks interface, which includes optional config function
		expect(plugin).toHaveProperty('config');
		expect(typeof plugin.config).toBe('function');
	});

	it('should register individual subcommands plus catch-all', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		expect(commands).toBeDefined();
		const commandKeys = Object.keys(commands);

		// Catch-all plus the current command registry entries. This includes the
		// evaluation gate commands, main's CI-monitor command, the context-map
		// stats command (issue #1672), and the swarm-skill-opt shortcut (issue #1822).
		expect(commandKeys.length).toBe(83);

		expect(commands.swarm).toBeDefined();
	});

	it('should have catch-all swarm command with correct template', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		expect(commands.swarm).toBeDefined();
		expect(commands.swarm.template).toBe('/swarm $ARGUMENTS');
		expect(commands.swarm.description).toMatch(
			/^Swarm management commands: \/swarm \[.+\]$/,
		);

		// Verify the description contains every standalone (non-alias, non-deprecated, non-subcommand) command.
		const standaloneCommands = VALID_COMMANDS.filter((cmd) => {
			const entry = COMMAND_REGISTRY[cmd as keyof typeof COMMAND_REGISTRY];
			return !entry.aliasOf && !entry.deprecated && !entry.subcommandOf;
		});
		for (const cmd of standaloneCommands) {
			expect(commands.swarm.description).toContain(
				cmd,
				`standalone command "${cmd}" should appear in swarm description`,
			);
		}
	});

	it('should register all individual subcommands with correct keys', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		const expectedSubcommands = [
			'swarm-status',
			'swarm-show-plan',
			'swarm-plan',
			'swarm-agents',
			'swarm-history',
			'swarm-config',
			'swarm-deep-dive',
			'swarm-evidence',
			'swarm-handoff',
			'swarm-archive',
			'swarm-diagnose',
			'swarm-preflight',
			'swarm-sync-plan',
			'swarm-benchmark',
			'swarm-gate-audit',
			'swarm-gate-stats',
			'swarm-review',
			'swarm-costs',
			'swarm-export',
			'swarm-reset',
			'swarm-rollback',
			'swarm-retrieve',
			'swarm-clarify',
			'swarm-analyze',
			'swarm-specify',
			'swarm-sdd',
			'swarm-sdd-status',
			'swarm-sdd-validate',
			'swarm-sdd-project',
			'swarm-brainstorm',
			'swarm-loop',
			'swarm-council',
			'swarm-pr-review',
			'swarm-pr-feedback',
			'swarm-abort-pr-workflow',
			'swarm-approve-plan-critic',
			'swarm-pr-subscribe',
			'swarm-pr-unsubscribe',
			'swarm-pr-status',
			'swarm-learning',
			'swarm-link',
			'swarm-post-mortem',
			'swarm-codebase-review',
			'swarm-deep-research',
			'swarm-design-docs',
			'swarm-issue',
			'swarm-qa-gates',
			'swarm-dark-matter',
			'swarm-knowledge',
			'swarm-memory',
			'swarm-memory-status',
			'swarm-memory-export',
			'swarm-memory-import',
			'swarm-memory-migrate',
			'swarm-curate',
			'swarm-consolidate',
			'swarm-concurrency',
			'swarm-turbo',
			'swarm-epic',
			'swarm-coupling',
			'swarm-lanes',
			'swarm-guardrail-explain',
			'swarm-guardrail-log',
			'swarm-unlink',
			'swarm-full-auto',
			'swarm-auto-proceed',
			'swarm-write-retro',
			'swarm-reset-session',
			'swarm-simulate',
			'swarm-promote',
			'swarm-checkpoint',
			'swarm-config-doctor',
			'swarm-evidence-summary',
			'swarm-acknowledge-spec-drift',
			'swarm-doctor-tools',
			'swarm-finalize',
			'swarm-close',
			'swarm-diagnosis',
			'swarm-ci-simulate',
			'swarm-ci-monitor',
			'swarm-context-map-stats',
			'swarm-skill-opt',
		];

		for (const subcommand of expectedSubcommands) {
			expect(
				commands[subcommand],
				`${subcommand} should be registered`,
			).toBeDefined();
		}

		// Verify no extra swarm- commands beyond expected ones
		const swarmCommands = Object.keys(commands).filter((key) =>
			key.startsWith('swarm-'),
		);
		expect(swarmCommands.sort()).toEqual(expectedSubcommands.sort());
	});

	it('should have all subcommand templates starting with /swarm', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		const swarmCommands = Object.keys(commands).filter((key) =>
			key.startsWith('swarm-'),
		);

		for (const commandKey of swarmCommands) {
			const cmd = commands[commandKey];
			expect(cmd.template).toMatch(
				/^\/swarm/,
				`${commandKey} template should start with /swarm`,
			);
		}
	});

	it('should have non-empty descriptions for all subcommands', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Check catch-all command
		expect(commands.swarm.description).toBeTruthy();
		expect(commands.swarm.description.length).toBeGreaterThan(0);

		// Check all swarm- subcommands
		const swarmCommands = Object.keys(commands).filter((key) =>
			key.startsWith('swarm-'),
		);

		for (const commandKey of swarmCommands) {
			const cmd = commands[commandKey];
			expect(
				cmd.description,
				`${commandKey} should have description`,
			).toBeTruthy();
			expect(
				cmd.description.length,
				`${commandKey} description should not be empty`,
			).toBeGreaterThan(0);
		}
	});

	it('should have one-line descriptions for subcommands', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		const swarmCommands = Object.keys(commands).filter((key) =>
			key.startsWith('swarm-'),
		);

		for (const commandKey of swarmCommands) {
			const cmd = commands[commandKey];
			// One-line descriptions should not contain newlines
			expect(cmd.description).not.toContain(
				'\n',
				`${commandKey} description should be one-line`,
			);
		}
	});

	it('should register simulate command', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// This command should be registered
		expect(commands['swarm-simulate']).toBeDefined();
	});

	it('should register ci-simulate command', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		expect(commands['swarm-ci-simulate']).toBeDefined();
		expect(commands['swarm-ci-simulate'].template).toBe(
			'/swarm ci-simulate $ARGUMENTS',
		);
	});

	it('should have correct templates for specific subcommands', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Test a few specific templates
		expect(commands['swarm-status'].template).toBe('/swarm status');
		expect(commands['swarm-plan'].template).toBe('/swarm plan $ARGUMENTS');
		expect(commands['swarm-agents'].template).toBe('/swarm agents');
		expect(commands['swarm-reset'].template).toBe('/swarm reset --confirm');
		expect(commands['swark-knowledge']).toBeUndefined(); // Typos should not exist
	});

	it('should have descriptions matching expected values', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Verify some specific descriptions
		expect(commands['swarm-status'].description).toBe(
			'Use /swarm status to show current swarm status and active phase',
		);
		expect(commands['swarm-plan'].description).toBe(
			'Deprecated alias for /swarm show-plan',
		);
		expect(commands['swarm-agents'].description).toBe(
			'Use /swarm agents to list registered swarm agents',
		);
		expect(commands['swarm-reset'].description).toBe(
			'Use /swarm reset --confirm to clear swarm state (requires --confirm)',
		);
	});

	it('new shortcut descriptions derive from the registry', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		const checks: Array<[string, string]> = [
			['swarm-pr-subscribe', 'pr subscribe'],
			['swarm-pr-unsubscribe', 'pr unsubscribe'],
			['swarm-pr-status', 'pr status'],
			['swarm-learning', 'learning'],
			['swarm-post-mortem', 'post-mortem'],
		];
		for (const [shortcutKey, cmd] of checks) {
			const entry = COMMAND_REGISTRY[cmd as keyof typeof COMMAND_REGISTRY] as {
				description: string;
			};
			const shortcut = (commands as Record<string, { description: string }>)[
				shortcutKey
			];
			expect(shortcut.description).toContain('Use /swarm');
			expect(shortcut.description.toLowerCase()).toContain(
				entry.description.toLowerCase(),
			);
		}
	});

	it('should preserve existing commands when merging', async () => {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {
			command: {
				existing: {
					template: '/existing',
					description: 'Existing command',
				},
			},
		};

		await plugin.config?.(mockConfig);
		const commands = mockConfig.command as Record<
			string,
			{ template: string; description: string }
		>;

		// Existing command should still be present
		expect(commands.existing).toBeDefined();
		expect(commands.existing.template).toBe('/existing');

		// Swarm commands should be added
		expect(commands.swarm).toBeDefined();
	});
});

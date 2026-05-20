import { describe, expect, it } from 'bun:test';
import { COMMAND_REGISTRY } from '../commands/registry';
import type { CommandEntry } from '../commands/registry.js';
import { createArchitectAgent } from './architect';

/**
 * Tests for Task 3.2: SKIP_ALIASES now generated dynamically from COMMAND_REGISTRY
 *
 * Changes verified:
 * 1. SKIP_ALIASES is dynamically generated from registry entries with aliasOf
 * 2. buildSlashCommandsList() filters aliases correctly
 * 3. No regressions in architect functionality
 */
describe('Task 3.2: Dynamic SKIP_ALIASES from COMMAND_REGISTRY', () => {
	const agent = createArchitectAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	// Extract just the slash commands section from the prompt
	const slashCommandsSection = extractSlashCommandsSection(prompt);

	function extractSlashCommandsSection(text: string): string {
		const start = text.indexOf('**Session Lifecycle**');
		if (start === -1) return '';
		const nextPlaceholder = text.indexOf('{{', start);
		const nextAgentsHeader = text.indexOf('## AGENTS', start);
		const endMarkers = [nextPlaceholder, nextAgentsHeader].filter(
			(x) => x !== -1,
		);
		const end = endMarkers.length > 0 ? Math.min(...endMarkers) : text.length;
		return text.slice(start, end);
	}

	// Helper: check if a command appears in slash command format
	function commandAppears(commandName: string): boolean {
		return slashCommandsSection.includes(`\`/swarm ${commandName}\``);
	}

	// ============ 1. SKIP_ALIASES DYNAMIC GENERATION ============

	it('SKIP_ALIASES includes ALL commands with aliasOf from registry', () => {
		// Collect all alias names from registry
		const registryAliases: string[] = [];
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).aliasOf) {
				registryAliases.push(name);
			}
		}

		// Verify we found at least the known aliases
		expect(
			registryAliases.length,
			'Should have found aliases in registry',
		).toBeGreaterThan(0);

		// Verify each alias does NOT appear as a command in the output
		for (const alias of registryAliases) {
			const entry = COMMAND_REGISTRY[
				alias as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			expect(entry.aliasOf).toBeTruthy();

			// The alias should NOT appear in slash commands output as `/swarm alias`
			expect(
				commandAppears(alias),
				`Alias "${alias}" (aliasOf: "${entry.aliasOf}") should not appear in output`,
			).toBe(false);
		}
	});

	it('SKIP_ALIASES set size matches registry alias count', () => {
		// Count aliases in registry
		const registryAliasCount = Object.values(COMMAND_REGISTRY).filter(
			(entry) => (entry as CommandEntry).aliasOf,
		).length;

		// Extract all command names from output
		const outputCommandMatches =
			slashCommandsSection.matchAll(/`\/swarm ([^`]+)`/g);
		const outputCommands = new Set([...outputCommandMatches].map((m) => m[1]));

		// Count how many registry aliases are missing from output (should equal registryAliasCount)
		let missingFromOutput = 0;
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).aliasOf && !outputCommands.has(name)) {
				missingFromOutput++;
			}
		}

		expect(
			missingFromOutput,
			'All registry aliases should be filtered from output',
		).toBe(registryAliasCount);
	});

	// ============ 2. ALIAS FILTERING CORRECTNESS ============

	it('known aliases do NOT appear as commands', () => {
		// These are aliases that should be filtered - check they don't appear as `/swarm alias`
		const knownAliases = [
			'plan',
			'config-doctor',
			'close',
			'diagnosis',
			'evidence-summary',
			'doctor',
			'info',
			'list-agents',
			'health',
			'check',
			'clear',
		];

		for (const alias of knownAliases) {
			expect(
				commandAppears(alias),
				`Alias "${alias}" should not appear as /swarm command`,
			).toBe(false);
		}
	});

	it('non-alias commands still appear correctly', () => {
		// These are NOT aliases and should appear
		expect(commandAppears('finalize')).toBe(true);
		expect(commandAppears('status')).toBe(true);
		expect(commandAppears('show-plan')).toBe(true);
		expect(commandAppears('diagnose')).toBe(true);
		expect(commandAppears('config doctor')).toBe(true);
	});

	// ============ 3. REGRESSION TESTS ============

	it('all 7 category headers are present', () => {
		const categories = [
			'**Session Lifecycle**',
			'**Planning**',
			'**Execution Modes**',
			'**Observation**',
			'**Knowledge**',
			'**State Management**',
			'**Diagnostics**',
		];
		for (const category of categories) {
			expect(prompt).toContain(category);
		}
	});

	it('read-only observation commands show only description without details', () => {
		// "status" is in READ_ONLY_OBSERVATION set, should NOT have extra details
		const statusIndex = prompt.indexOf('`/swarm status`');
		const snippet = prompt.slice(statusIndex, statusIndex + 200);
		expect(snippet).toContain('Show current swarm state');
		const statusSection = snippet.split('\n').slice(0, 3).join('\n');
		expect(statusSection).not.toContain('Idempotent');
	});

	it('side-effect commands include details and args', () => {
		// "close" command has details
		expect(prompt).toContain('Idempotent 4-stage terminal finalization');
		// Commands with args
		expect(prompt).toContain('checkpoint');
		expect(prompt).toContain('Args:');
	});

	it('knowledge subcommands appear correctly', () => {
		expect(prompt).toContain('`/swarm knowledge migrate`');
		expect(prompt).toContain('`/swarm knowledge quarantine`');
		expect(prompt).toContain('`/swarm knowledge restore`');
	});

	it('no placeholder remnants in prompt', () => {
		expect(prompt).not.toContain('{{SLASH_COMMANDS}}');
	});

	it('prompt does not end with bare period after commands', () => {
		const trimmed = slashCommandsSection.trim();
		const lines = trimmed.split('\n');
		const lastLine = lines[lines.length - 1]?.trim() ?? '';
		expect(lastLine).not.toBe('.');
	});

	// ============ 4. INTEGRATION: SUBCOMMAND STRUCTURE ============

	it('subcommands appear under their parent commands', () => {
		// Knowledge is a parent with migrate/quarantine/restore as subcommands
		const knowledgeIndex = prompt.indexOf('`/swarm knowledge`');
		const migrateIndex = prompt.indexOf('`/swarm knowledge migrate`');
		expect(knowledgeIndex).toBeLessThan(migrateIndex);
		expect(knowledgeIndex).not.toBe(-1);
		expect(migrateIndex).not.toBe(-1);
	});

	// ============ 5. EDGE CASE: NEW ALIASES IN REGISTRY ============

	it('any future aliases added to registry will be automatically excluded', () => {
		// This test verifies the filtering mechanism, not specific aliases
		// It extracts all command names from output and verifies they don't have aliasOf
		const commandMatches = slashCommandsSection.matchAll(/`\/swarm ([^`]+)`/g);
		const outputCommands: string[] = [];
		for (const match of commandMatches) {
			outputCommands.push(match[1]);
		}

		// Verify no output command has aliasOf
		for (const cmd of outputCommands) {
			const entry = COMMAND_REGISTRY[
				cmd as keyof typeof COMMAND_REGISTRY
			] as CommandEntry;
			expect(
				entry?.aliasOf,
				`Command "${cmd}" appears in output but has aliasOf: "${entry?.aliasOf}"`,
			).toBeUndefined();
		}
	});

	// ============ 6. SPECIFIC ALIAS TARGET VALIDATION ============

	it('aliased commands are replaced by their targets in the same category', () => {
		// config-doctor -> config doctor, so "config doctor" should appear
		expect(commandAppears('config doctor')).toBe(true);

		// diagnosis -> diagnose, so "diagnose" should appear
		expect(commandAppears('diagnose')).toBe(true);

		// evidence-summary -> evidence summary, so "evidence summary" should appear
		expect(commandAppears('evidence summary')).toBe(true);
	});
});

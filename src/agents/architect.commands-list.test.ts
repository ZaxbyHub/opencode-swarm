import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from './architect';

describe('buildSlashCommandsList (via createArchitectAgent)', () => {
	const agent = createArchitectAgent('test-model');
	const prompt = agent.config.prompt ?? '';

	// ============ CATEGORY HEADERS ============

	it('contains "**Session Lifecycle**" category header', () => {
		expect(prompt).toContain('**Session Lifecycle**');
	});

	it('contains "**Planning**" category header', () => {
		expect(prompt).toContain('**Planning**');
	});

	it('contains all 7 category headers', () => {
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

	// ============ COMMAND FORMAT ============

	it('commands appear in /swarm <name> format with description', () => {
		// Check a known command appears in proper format
		expect(prompt).toContain('`/swarm finalize`');
		expect(prompt).toContain('`/swarm status`');
		expect(prompt).toContain('`/swarm show-plan`');
	});

	// ============ SIDE-EFFECT vs READ-ONLY ============

	it('side-effect command "finalize" includes details text', () => {
		// The "finalize" command has details about its 4-stage terminal finalization
		expect(prompt).toContain('Idempotent 4-stage terminal finalization');
	});

	it('read-only command "status" shows only description (no details text)', () => {
		// "status" is in READ_ONLY_OBSERVATION set, should NOT have extra details
		const statusIndex = prompt.indexOf('`/swarm status`');
		// Find the next few lines after /swarm status
		const snippet = prompt.slice(statusIndex, statusIndex + 200);
		// Should only have the description, not additional details block
		expect(snippet).toContain('Show current swarm state');
		// Should NOT contain a details line for status (which is read-only)
		const statusSection = snippet.split('\n').slice(0, 3).join('\n');
		expect(statusSection).not.toContain('Idempotent');
		expect(statusSection).not.toContain('DELETES');
	});

	// ============ OLD FORMAT REGRESSION ============

	it('does NOT match the old bare-name comma-separated format', () => {
		// The old format was something like: "close, reset, reset-session, handoff, ..."
		// New format should NOT be comma-separated list ending with period
		const lines = prompt.split('\n');
		const slashCommandsLine = lines.find((l) =>
			l.includes('{{SLASH_COMMANDS}}'),
		);
		expect(slashCommandsLine).toBeUndefined(); // Should be replaced
		// Should NOT contain bare comma-separated commands
		expect(prompt).not.toMatch(/^\/swarm \w+(, \/swarm \w+)+ *\.$/m);
	});

	// ============ ALIAS FILTERING ============

	it('alias "config-doctor" does NOT appear in output', () => {
		// config-doctor is an alias (SKIP_ALIASES), should not appear
		expect(prompt).not.toContain('config-doctor');
	});

	it('alias "evidence-summary" does NOT appear in output', () => {
		// evidence-summary is an alias (SKIP_ALIASES), should not appear
		expect(prompt).not.toContain('evidence-summary');
	});

	// ============ ARGS FORMAT ============

	it('commands with args have "Args:" in their line', () => {
		// simulate has args: --threshold <number>, --min-commits <number>
		expect(prompt).toContain(
			'Args: --threshold <number>, --min-commits <number>',
		);
		// checkpoint has args: <save|restore|delete|list> <label>
		expect(prompt).toContain('Args: <save|restore|delete|list> <label>');
	});

	// ============ KNOWLEDGE SUBCOMMANDS ============

	it('knowledge subcommand "migrate" appears in output', () => {
		expect(prompt).toContain('`/swarm knowledge migrate`');
		expect(prompt).toContain('One-time migration');
	});

	it('knowledge subcommand "quarantine" appears in output', () => {
		expect(prompt).toContain('`/swarm knowledge quarantine`');
		expect(prompt).toContain('Moves a knowledge entry to quarantine');
	});

	it('knowledge subcommand "restore" appears in output', () => {
		expect(prompt).toContain('`/swarm knowledge restore`');
		expect(prompt).toContain('Restores a quarantined knowledge entry');
	});

	// ============ SUBCOMMAND PARENT ENTRY ============

	// ============ REUSE_RE_VERIFICATION IN ANTI-EXEMPTION ============

	it('contains REUSE_RE_VERIFICATION check in ANTI-RATIONALIZATION GATE', () => {
		expect(prompt).toContain(
			"Reviewer APPROVED so I'll skip checking the REUSE_RE_VERIFICATION field",
		);
		expect(prompt).toContain(
			"I verified that the reviewer's verdict includes REUSE_RE_VERIFICATION before accepting the APPROVED",
		);
	});

	it('contains REUSE_RE_VERIFICATION required field note in Stage B', () => {
		// Verify the Stage B sentence specifically, not just a generic substring
		expect(prompt).toContain(
			"reviewer's verdict MUST include a REUSE_RE_VERIFICATION field",
		);
	});

	it('contains REUSE_RE_VERIFICATION required field note in Stage B', () => {
		expect(prompt).toContain('REUSE_RE_VERIFICATION field');
	});

	it('knowledge parent command appears before subcommands', () => {
		const knowledgeIndex = prompt.indexOf('`/swarm knowledge`');
		const migrateIndex = prompt.indexOf('`/swarm knowledge migrate`');
		expect(knowledgeIndex).toBeLessThan(migrateIndex);
	});
});

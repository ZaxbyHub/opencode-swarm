import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { buildHelpText } from '../../../src/commands/index.js';
import {
	COMMAND_REGISTRY,
	VALID_COMMANDS,
} from '../../../src/commands/registry.js';

describe('buildHelpText() — Task 2.2 changes', () => {
	let helpText: string;

	beforeEach(() => {
		// Force fresh help text on each test
		helpText = buildHelpText();
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 1: Verify help output contains category headers
	// -------------------------------------------------------------------------
	describe('category grouping', () => {
		test('contains "Core" category header', () => {
			expect(helpText).toContain('### Core');
		});

		test('contains "Agent" category header', () => {
			expect(helpText).toContain('### Agent');
		});

		test('contains "Config" category header', () => {
			expect(helpText).toContain('### Config');
		});

		test('contains "Diagnostics" category header', () => {
			expect(helpText).toContain('### Diagnostics');
		});

		test('contains "Utility" category header', () => {
			expect(helpText).toContain('### Utility');
		});

		test('category headers appear in correct order', () => {
			const coreIdx = helpText.indexOf('### Core');
			const agentIdx = helpText.indexOf('### Agent');
			const configIdx = helpText.indexOf('### Config');
			const diagnosticsIdx = helpText.indexOf('### Diagnostics');
			const utilityIdx = helpText.indexOf('### Utility');

			expect(coreIdx).toBeLessThan(agentIdx);
			expect(agentIdx).toBeLessThan(configIdx);
			expect(configIdx).toBeLessThan(diagnosticsIdx);
			expect(diagnosticsIdx).toBeLessThan(utilityIdx);
		});

		test('commands in Core category appear under ### Core header', () => {
			// status, show-plan, agents, finalize, handoff are core commands
			const coreSection = helpText.split('### Core')[1].split('###')[0];
			expect(coreSection).toContain('/swarm status');
			expect(coreSection).toContain('/swarm show-plan');
			expect(coreSection).toContain('/swarm agents');
			expect(coreSection).toContain('/swarm finalize');
			expect(coreSection).toContain('/swarm handoff');
		});

		test('consolidate appears in Utility category', () => {
			const utilitySection = helpText.split('### Utility')[1].split('###')[0];
			expect(utilitySection).toContain('/swarm consolidate');
		});

		test('commands in Diagnostics category appear under ### Diagnostics header', () => {
			// diagnose, preflight, benchmark, dark-matter, simulate are diagnostics commands
			// note: "doctor tools" is a compound command shown in second pass (after Utility)
			const diagnosticsSection = helpText
				.split('### Diagnostics')[1]
				.split('###')[0];
			expect(diagnosticsSection).toContain('/swarm diagnose');
			expect(diagnosticsSection).toContain('/swarm preflight');
			expect(diagnosticsSection).toContain('/swarm benchmark');
			expect(diagnosticsSection).toContain('/swarm dark-matter');
			expect(diagnosticsSection).toContain('/swarm simulate');
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 2: Verify aliases are in deprecated section
	// -------------------------------------------------------------------------
	describe('deprecated aliases section', () => {
		test('contains "Deprecated Commands" header', () => {
			expect(helpText).toContain('### Deprecated Commands');
		});

		test('shows "config-doctor" as deprecated alias pointing to "config doctor"', () => {
			expect(helpText).toContain('/swarm config-doctor');
			expect(helpText).toContain('Use `/swarm config doctor`');
		});

		test('shows "diagnosis" as deprecated alias pointing to "diagnose"', () => {
			expect(helpText).toContain('/swarm diagnosis');
			expect(helpText).toContain('Use `/swarm diagnose`');
		});

		test('shows "evidence-summary" as deprecated alias pointing to "evidence summary"', () => {
			expect(helpText).toContain('/swarm evidence-summary');
			expect(helpText).toContain('Use `/swarm evidence summary`');
		});

		test('deprecated aliases do NOT appear in main listing as standalone commands', () => {
			// The aliases should only appear in the deprecated section, not in categories
			// Split by sections and check deprecated commands aren't double-listed
			const deprecatedSection = helpText.split('### Deprecated Commands')[1];

			// Count how many times each alias appears
			const configDoctorCount = (helpText.match(/\/swarm config-doctor/g) || [])
				.length;
			const diagnosisCount = (helpText.match(/\/swarm diagnosis/g) || [])
				.length;
			const evidenceSummaryCount = (
				helpText.match(/\/swarm evidence-summary/g) || []
			).length;

			// Each alias should appear exactly once (in the deprecated section)
			expect(configDoctorCount).toBe(1);
			expect(diagnosisCount).toBe(1);
			expect(evidenceSummaryCount).toBe(1);
		});

		test('non-aliased commands do NOT appear as alias entries in deprecated section', () => {
			const deprecatedSection = helpText.split('### Deprecated Commands')[1];
			// These commands appear in deprecated section ONLY as redirect targets for aliases
			// (e.g., "diagnose" appears in the redirect message for "diagnosis" alias)
			// But the actual alias entries should NOT be these commands themselves
			// status, config, evidence, knowledge are not deprecated aliases themselves
			// Check they don't appear as standalone deprecated entries
			const deprecatedLines = deprecatedSection
				.split('\n')
				.filter((line) => line.includes('→ Use `/swarm'));
			const deprecatedCommandNames = deprecatedLines
				.map((line) => {
					const match = line.match(/\/swarm (\S+)` → Use/);
					return match ? match[1] : null;
				})
				.filter(Boolean);

			// The deprecated command names themselves should not include status, config, etc
			expect(deprecatedCommandNames).not.toContain('status');
			expect(deprecatedCommandNames).not.toContain('config');
			expect(deprecatedCommandNames).not.toContain('evidence');
			expect(deprecatedCommandNames).not.toContain('knowledge');
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 3: Verify subcommands are under parent commands
	// -------------------------------------------------------------------------
	describe('subcommand grouping', () => {
		test('"config doctor" appears indented under "config" parent', () => {
			// The subcommand should appear with indentation (two spaces before the dash)
			const configSection = helpText.split('### Config')[1].split('###')[0];
			expect(configSection).toContain('/swarm config');
			// Subcommand is indented with "  - " (two spaces before the dash)
			expect(configSection).toContain('  - `doctor`');
		});

		test('"evidence summary" appears indented under "evidence" parent', () => {
			const utilitySection = helpText.split('### Utility')[1].split('###')[0];
			expect(utilitySection).toContain('/swarm evidence');
			expect(utilitySection).toContain('  - `summary`');
		});

		test('knowledge subcommands (migrate, quarantine, restore) appear under "knowledge" parent', () => {
			const utilitySection = helpText.split('### Utility')[1].split('###')[0];
			expect(utilitySection).toContain('/swarm knowledge');
			expect(utilitySection).toContain('  - `migrate`');
			expect(utilitySection).toContain('  - `quarantine`');
			expect(utilitySection).toContain('  - `restore`');
		});

		test('subcommands do NOT appear as standalone top-level commands', () => {
			// These are subcommands - they should NOT appear at the top level
			// Split the help text to only check the non-deprecated sections
			const deprecatedIdx = helpText.indexOf('### Deprecated Commands');
			const mainContent = helpText.slice(0, deprecatedIdx);

			// Subcommands with spaces should not appear as top-level /swarm X commands
			// They should only appear as indented sub-items
			expect(mainContent).not.toContain('  - `doctor tools`');
			// Note: "doctor tools" doesn't have a parent "doctor" so it may appear differently
		});

		test('"doctor tools" is shown as a top-level compound command (after utility section)', () => {
			// "doctor tools" has no subcommandOf, so it appears in the "second pass" section
			// at the end of help text, before ### Deprecated Commands
			const deprecatedIdx = helpText.indexOf('### Deprecated Commands');
			const secondPassSection = helpText.slice(0, deprecatedIdx);
			expect(secondPassSection).toContain('/swarm doctor tools');
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 4: Verify all commands appear somewhere in help
	// -------------------------------------------------------------------------
	describe('command completeness', () => {
		test('all top-level commands appear in help text', () => {
			const topLevelCommands = VALID_COMMANDS.filter((cmd) => {
				const entry = COMMAND_REGISTRY[cmd];
				return !entry.aliasOf && !entry.subcommandOf && !cmd.includes(' ');
			});

			for (const cmd of topLevelCommands) {
				expect(helpText).toContain(
					`/swarm ${cmd}`,
					`${cmd} should appear in help`,
				);
			}
		});

		test('all compound commands (with spaces) that are not aliases appear somewhere', () => {
			const compoundCommands = VALID_COMMANDS.filter((cmd) => {
				const entry = COMMAND_REGISTRY[cmd];
				return cmd.includes(' ') && !entry.aliasOf && !entry.subcommandOf;
			});

			for (const cmd of compoundCommands) {
				expect(helpText).toContain(
					`/swarm ${cmd}`,
					`${cmd} should appear in help`,
				);
			}
		});

		test('all deprecated aliases appear in deprecated section', () => {
			const deprecatedCommands = VALID_COMMANDS.filter((cmd) => {
				const entry = COMMAND_REGISTRY[cmd];
				return entry.aliasOf;
			});

			for (const cmd of deprecatedCommands) {
				expect(helpText).toContain(
					`/swarm ${cmd}`,
					`${cmd} should appear in deprecated section`,
				);
			}
		});

		test('help text starts with "## Swarm Commands" header', () => {
			expect(helpText).toStartWith('## Swarm Commands');
		});

		test('help text includes the tool-mediated chat routing note', () => {
			expect(helpText).toContain('Chat routing note');
			expect(helpText).toContain('swarm_command');
			expect(helpText).toContain('bunx opencode-swarm run <subcommand>');
		});
	});

	// -------------------------------------------------------------------------
	// TEST FOCUS 5: Verify backward compatibility
	// -------------------------------------------------------------------------
	describe('backward compatibility', () => {
		test('each command entry has description after the command path', () => {
			// Every command should have format: `/swarm <cmd>` followed by `— <description>`
			const commandPattern = /\/swarm (\S+)[^—]*— (.+)/g;
			const matches = helpText.match(commandPattern);
			expect(matches).not.toBeNull();
			expect(matches!.length).toBeGreaterThan(0);
		});

		test('command descriptions are preserved', () => {
			// Core commands should have their descriptions
			expect(helpText).toContain('Show current swarm state'); // status
			expect(helpText).toContain('Show current plan'); // show-plan
			expect(helpText).toContain('List registered agents'); // agents
			expect(helpText).toContain('Show current resolved configuration'); // config
			expect(helpText).toContain('Run health check on swarm state'); // diagnose
		});

		test('commands with args show the Args: line', () => {
			// Commands with args should show the Args: specification
			// e.g., benchmark has args: '--cumulative, --ci-gate'
			expect(helpText).toContain('Args:');
		});

		test('help text is a non-empty string', () => {
			expect(typeof helpText).toBe('string');
			expect(helpText.length).toBeGreaterThan(100);
		});

		test('help text is a well-formed string', () => {
			expect(typeof helpText).toBe('string');
			expect(helpText.length).toBeGreaterThan(100);
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------
	describe('edge cases', () => {
		test('returns consistent output on multiple calls', () => {
			const first = buildHelpText();
			const second = buildHelpText();
			expect(first).toBe(second);
		});

		test('no orphaned subcommand entries (subcommands only appear under parents)', () => {
			// knowledge migrate, quarantine, restore should only appear under knowledge
			// They should NOT appear as standalone `/swarm <subcommand>` entries
			// They should appear as indented sub-items: "  - `migrate`"
			const topLevel = helpText.split('### Deprecated Commands')[0];

			// These subcommands should NOT appear as `/swarm knowledge migrate` pattern
			// They should appear as indented sub-items like "  - `migrate`"
			const migratePattern = /\/swarm knowledge migrate(?!\s)/g;
			const quarantinePattern = /\/swarm knowledge quarantine(?!\s)/g;
			const restorePattern = /\/swarm knowledge restore(?!\s)/g;

			// The pattern with negative lookahead should not match
			// (since "migrate" appears after a space but not as a continuous command)
			expect(topLevel.match(migratePattern)).toBeNull();
			expect(topLevel.match(quarantinePattern)).toBeNull();
			expect(topLevel.match(restorePattern)).toBeNull();
		});

		test('commands with details show the details line', () => {
			// e.g., brainstorm has details about the workflow
			expect(helpText).toContain('brainstorm');
			expect(helpText).toContain(
				'Triggers the architect to run the brainstorm workflow',
			);
		});
	});
});

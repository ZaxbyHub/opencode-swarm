/**
 * Task 1.3: clashesWithNativeCcCommand field + buildHelpText() conflict warnings
 * Structural tests verifying:
 * 1. CommandEntry type accepts the new optional field
 * 2. All 9 conflicting commands have the field set correctly
 * 3. buildHelpText() outputs conflict warnings for CRITICAL commands
 * 4. buildHelpText() does NOT output false conflict warnings
 * 5. doctor deprecated alias has clashesWithNativeCcCommand: '/doctor'
 */

import { describe, expect, test } from 'bun:test';
import { buildHelpText } from './index';
import type { CommandEntry } from './registry';
import { COMMAND_REGISTRY } from './registry';

// Expected 9 conflicting commands and their CC command values
const EXPECTED_CONFLICTS: Record<string, string> = {
	plan: '/plan',
	reset: '/reset',
	checkpoint: '/checkpoint',
	status: '/status',
	agents: '/agents',
	config: '/config',
	export: '/export',
	doctor: '/doctor', // deprecated alias for 'config doctor'
	history: '/history',
};

describe('Task 1.3: clashesWithNativeCcCommand field', () => {
	describe('1. CommandEntry type accepts the new optional field', () => {
		test('typed variable with clashesWithNativeCcCommand compiles without error', () => {
			// Compile-time check: if this type annotation is valid, the field exists
			const entry: CommandEntry = {
				handler: async () => '',
				description: 'test',
				clashesWithNativeCcCommand: '/test',
			};
			expect(entry.clashesWithNativeCcCommand).toBe('/test');
		});

		test('typed variable without clashesWithNativeCcCommand compiles without error', () => {
			// Verify the field is truly optional
			const entry: CommandEntry = {
				handler: async () => '',
				description: 'test',
			};
			expect(entry.clashesWithNativeCcCommand).toBeUndefined();
		});
	});

	describe('2. All 9 conflicting commands have clashesWithNativeCcCommand set correctly', () => {
		for (const [cmd, expectedCcCommand] of Object.entries(EXPECTED_CONFLICTS)) {
			test(`'${cmd}' has clashesWithNativeCcCommand: '${expectedCcCommand}'`, () => {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				expect(entry).toBeDefined();
				expect(entry.clashesWithNativeCcCommand).toBe(expectedCcCommand);
			});
		}

		test('no other commands have clashesWithNativeCcCommand set', () => {
			const allCommands = Object.keys(
				COMMAND_REGISTRY,
			) as (keyof typeof COMMAND_REGISTRY)[];
			const conflictingCommands = new Set(Object.keys(EXPECTED_CONFLICTS));

			for (const cmd of allCommands) {
				const entry = COMMAND_REGISTRY[cmd] as CommandEntry;
				if (conflictingCommands.has(cmd)) {
					continue; // Skip - already tested above
				}
				expect(
					entry.clashesWithNativeCcCommand,
					`Command '${cmd}' should NOT have clashesWithNativeCcCommand set`,
				).toBeUndefined();
			}
		});
	});

	describe('3. buildHelpText() outputs conflict warnings for CRITICAL commands', () => {
		const helpText = buildHelpText();

		for (const cmd of ['plan', 'reset', 'checkpoint']) {
			const ccCommand = EXPECTED_CONFLICTS[cmd];
			test(`'${cmd}' warning appears in help text with correct CC command`, () => {
				const warningPattern = `⚠️ Name conflicts with CC built-in \`${ccCommand}\` — always use \`/swarm ${cmd}\``;
				expect(helpText).toContain(warningPattern);
			});
		}

		// Also verify the warning format is correct (should contain "always use /swarm {cmd}")
		test('all CRITICAL warnings contain "always use /swarm" instruction', () => {
			for (const cmd of ['plan', 'reset', 'checkpoint']) {
				const ccCommand = EXPECTED_CONFLICTS[cmd];
				const lines = helpText.split('\n');
				const foundWarning = lines.some(
					(line) =>
						line.includes(`\`${ccCommand}\``) &&
						line.includes(`always use \`/swarm ${cmd}\``),
				);
				expect(
					foundWarning,
					`CRITICAL command '${cmd}' should have proper disambiguation`,
				).toBe(true);
			}
		});
	});

	describe('4. buildHelpText() does NOT output false conflict warnings', () => {
		const helpText = buildHelpText();

		// Commands that should NOT have conflict warnings
		const nonConflictingCommands = [
			'close',
			'handoff',
			'turbo',
			'full-auto',
			'brainstorm',
			'council',
			'pr-review',
			'issue',
		];

		for (const cmd of nonConflictingCommands) {
			test(`'${cmd}' does NOT have a conflict warning in help text`, () => {
				const warningPattern = `Name conflicts with CC built-in`;
				// Look for the warning in context of this command
				const cmdIndex = helpText.indexOf(`/swarm ${cmd}`);
				if (cmdIndex === -1) {
					// Command not in help text at all - skip
					return;
				}
				// Check the next 200 characters after the command mention
				const contextAfter = helpText.slice(cmdIndex, cmdIndex + 500);
				const hasFalseWarning = contextAfter.includes(warningPattern);
				expect(
					hasFalseWarning,
					`Command '${cmd}' should NOT have a conflict warning`,
				).toBe(false);
			});
		}
	});

	describe('5. doctor deprecated alias has clashesWithNativeCcCommand: "/doctor"', () => {
		test("'doctor' entry has clashesWithNativeCcCommand: '/doctor'", () => {
			const doctorEntry = COMMAND_REGISTRY.doctor as CommandEntry;
			expect(doctorEntry).toBeDefined();
			expect(doctorEntry.clashesWithNativeCcCommand).toBe('/doctor');
		});

		test("'doctor' entry is marked as deprecated", () => {
			const doctorEntry = COMMAND_REGISTRY.doctor as CommandEntry;
			expect(doctorEntry.deprecated).toBe(true);
		});

		test("'doctor' entry aliases to 'config doctor'", () => {
			const doctorEntry = COMMAND_REGISTRY.doctor as CommandEntry;
			expect(doctorEntry.aliasOf).toBe('config doctor');
		});

		test("buildHelpText() shows 'doctor' in Deprecated section with its clash warning", () => {
			const helpText = buildHelpText();
			// The doctor command should appear in the Deprecated section
			expect(helpText).toContain('### Deprecated Commands');
			expect(helpText).toContain('`/swarm doctor`');
			expect(helpText).toContain('/swarm config doctor'); // the replacement command
			// And the deprecation warning should include the clash warning
			expect(helpText).toContain('⚠️');
			expect(helpText).toContain('/doctor'); // the CC built-in
		});
	});
});

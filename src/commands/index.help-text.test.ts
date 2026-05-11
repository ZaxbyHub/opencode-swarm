import { describe, expect, test } from 'bun:test';
import { buildHelpText } from './index';
import type { CommandEntry, RegisteredCommand } from './registry';
import { COMMAND_REGISTRY, VALID_COMMANDS } from './registry';

// Re-export buildHelpText for testing - it's a private function but we need to test it
// This is intentional test instrumentation, not production code

describe('buildHelpText()', () => {
	const helpText = buildHelpText();

	describe('header', () => {
		test('starts with "## Swarm Commands"', () => {
			expect(helpText.startsWith('## Swarm Commands')).toBe(true);
		});
	});

	describe('command entries', () => {
		test('contains /swarm status with its description', () => {
			const statusEntry = COMMAND_REGISTRY.status;
			expect(helpText).toContain(`/swarm status`);
			expect(helpText).toContain(statusEntry.description);
		});

		test('contains /swarm finalize with its description', () => {
			const finalizeEntry = COMMAND_REGISTRY.finalize;
			expect(helpText).toContain(`/swarm finalize`);
			expect(helpText).toContain(finalizeEntry.description);
		});
	});

	describe('Args: for commands with args', () => {
		test('finalize command includes Args: with close flags', () => {
			const finalizeEntry = COMMAND_REGISTRY.finalize;
			expect(finalizeEntry.args).toBe('--prune-branches, --skill-review');
			// The help text should have Args: indented under the finalize command
			expect(helpText).toContain('Args: `--prune-branches, --skill-review`');
		});

		test('benchmark command includes Args:', () => {
			const benchmarkEntry = COMMAND_REGISTRY.benchmark;
			expect(benchmarkEntry.args).toBe('--cumulative, --ci-gate');
			expect(helpText).toContain(`Args: \`${benchmarkEntry.args}\``);
		});
	});

	describe('details text for commands with details', () => {
		test('finalize command includes "Idempotent 4-stage" details', () => {
			const finalizeEntry = COMMAND_REGISTRY.finalize;
			expect(finalizeEntry.details).toContain('Idempotent 4-stage');
			expect(helpText).toContain('Idempotent 4-stage');
		});

		test('export command includes details text', () => {
			const exportEntry = COMMAND_REGISTRY.export;
			expect(exportEntry.details).toBeDefined();
			expect(helpText).toContain(exportEntry.details!);
		});
	});

	describe('subcommand grouping', () => {
		test('knowledge parent command is shown', () => {
			expect(helpText).toContain('/swarm knowledge');
		});

		test('knowledge subcommands (migrate, quarantine, restore) are listed under knowledge', () => {
			// Get the position of the knowledge parent entry
			const knowledgeIndex = helpText.indexOf('/swarm knowledge');
			expect(knowledgeIndex).toBeGreaterThan(-1);

			// Check that subcommands appear after the parent
			const afterKnowledge = helpText.slice(knowledgeIndex);
			const migrateIndex = afterKnowledge.indexOf('`migrate`');
			const quarantineIndex = afterKnowledge.indexOf('`quarantine`');
			const restoreIndex = afterKnowledge.indexOf('`restore`');

			expect(migrateIndex).toBeGreaterThan(-1);
			expect(quarantineIndex).toBeGreaterThan(-1);
			expect(restoreIndex).toBeGreaterThan(-1);
		});

		test('evidence subcommands are grouped under evidence', () => {
			const evidenceIndex = helpText.indexOf('/swarm evidence');
			expect(evidenceIndex).toBeGreaterThan(-1);

			const afterEvidence = helpText.slice(evidenceIndex);
			const summaryIndex = afterEvidence.indexOf('`summary`');

			expect(summaryIndex).toBeGreaterThan(-1);
		});
	});

	describe('subcommand short name format', () => {
		test('subcommands use short name (e.g. "migrate" not "knowledge migrate")', () => {
			// The subcommand should appear as just "migrate" not "knowledge migrate"
			// We check this by ensuring "/swarm knowledge migrate" does NOT appear
			// but "`migrate`" does appear as a subcommand entry
			const knowledgeParentIndex = helpText.indexOf('/swarm knowledge');
			expect(knowledgeParentIndex).toBeGreaterThan(-1);

			// Extract section under knowledge and check for short name format
			const sectionAfterKnowledge = helpText.slice(knowledgeParentIndex);
			// Find the next top-level command to bound the section
			const nextCommandMatch = sectionAfterKnowledge
				.slice(1)
				.match(/^\/swarm /m);
			const knowledgeSection = nextCommandMatch
				? sectionAfterKnowledge.slice(
						0,
						sectionAfterKnowledge.indexOf(nextCommandMatch[0], 1),
					)
				: sectionAfterKnowledge;

			// Should contain short name migrate
			expect(knowledgeSection).toContain('`migrate`');
			// Should NOT contain full name "knowledge migrate" as a subcommand entry
			expect(knowledgeSection.match(/`knowledge migrate`/)).toBeNull();
		});
	});

	describe('all commands appear in help text', () => {
		test('every command in VALID_COMMANDS appears in HELP_TEXT', () => {
			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[cmd as keyof typeof COMMAND_REGISTRY];
				expect(entry).toBeDefined();

				// For compound commands with parents in VALID_COMMANDS, they appear as subcommands
				// not as top-level /swarm <cmd> entries
				const isSubcommandOfParent =
					(entry as CommandEntry).subcommandOf &&
					VALID_COMMANDS.includes(
						(entry as CommandEntry).subcommandOf as RegisteredCommand,
					);

				if (isSubcommandOfParent) {
					// Skip - these appear as indented subcommands, not top-level
					continue;
				}

				// Top-level commands should appear as /swarm <cmd>
				expect(
					helpText,
					`Command "${cmd}" should appear in help text`,
				).toContain(`/swarm ${cmd}`);
			}
		});

		test('no top-level entry for compound commands that have a non-alias parent in VALID_COMMANDS', () => {
			// Commands like "knowledge migrate" should NOT appear as top-level
			// They should appear as subcommands under "knowledge"
			// But if the parent is an alias (like "doctor" which is aliasOf: 'config doctor'),
			// the compound command HAS no parent to appear under, so it CAN appear as top-level
			const compoundWithNonAliasParent = VALID_COMMANDS.filter((cmd) => {
				if (!cmd.includes(' ')) return false;
				const parentKey = cmd.split(' ')[0];
				if (!VALID_COMMANDS.includes(parentKey as RegisteredCommand))
					return false;
				const parentEntry = (COMMAND_REGISTRY as Record<string, CommandEntry>)[
					parentKey
				];
				const parentIsAlias = parentEntry?.aliasOf !== undefined;
				return !parentIsAlias;
			});

			for (const cmd of compoundWithNonAliasParent) {
				// The compound command should NOT appear as a top-level entry
				const topLevelPattern = new RegExp(
					`^- \`/swarm ${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``,
					'm',
				);
				expect(
					helpText.match(topLevelPattern),
					`Compound command "${cmd}" should not appear as top-level entry`,
				).toBeNull();
			}
		});
	});

	describe('command ordering', () => {
		test('parent commands appear before their subcommands', () => {
			// Find positions of key commands
			const commands = [
				'/swarm knowledge',
				'`migrate`',
				'/swarm evidence',
				'`summary`',
				'/swarm config',
				'`doctor`',
			];

			const positions = commands.map((cmd) => helpText.indexOf(cmd));

			// All should be found
			positions.forEach((pos, i) => {
				expect(pos, `Command "${commands[i]}" should be found`).toBeGreaterThan(
					-1,
				);
			});

			// Parent commands should appear before their subcommands
			expect(positions[0]).toBeLessThan(positions[1]); // knowledge < migrate
			expect(positions[2]).toBeLessThan(positions[3]); // evidence < summary
			expect(positions[4]).toBeLessThan(positions[5]); // config < doctor
		});
	});
});

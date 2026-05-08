import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry';

/**
 * Note: This test verifies shortcut KEY registration only.
 * Template content correctness is validated separately.
 *
 * Commands that intentionally lack shortcuts (exempt from parity check).
 * Each exemption must be documented with a reason.
 *
 * 'help' — routes via the parent 'swarm' command; individual command
 * shortcuts are not needed because the parent shortcut covers all subcommands.
 */
const EXEMPT_FROM_SHORTCUT: string[] = ['help'];

describe('Command registration parity', () => {
	describe('every non-deprecated, non-subcommand registry entry has a matching shortcut', () => {
		it('no shortcut gaps for eligible registry entries', async () => {
			// Read src/index.ts to scan for shortcut key patterns
			const indexPath = path.join(import.meta.dir, '../index.ts');
			const indexSource = await fs.readFile(indexPath, 'utf-8');

			const gaps: string[] = [];

			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;

				// Skip deprecated aliases — they point to another command and do not need shortcuts
				if (entry.aliasOf) continue;

				// Skip subcommands — they are accessed via their parent command
				if (entry.subcommandOf) continue;

				// Skip exempt commands
				if (EXEMPT_FROM_SHORTCUT.includes(cmd)) continue;

				// Compute expected shortcut key:
				// - spaces become dashes: 'config doctor' -> 'swarm-config-doctor'
				// - already-dashed stay as-is: 'pr-review' -> 'swarm-pr-review'
				const expectedShortcut = `swarm-${cmd.replace(/ /g, '-')}`;

				// Search for the shortcut as an object key: 'swarm-foo' or "swarm-foo" with optional whitespace before colon
				// The shortcut keys in index.ts appear as:   'swarm-status': { ... }
				const shortcutPattern = new RegExp(`['"]${expectedShortcut}['"]\\s*:`);
				if (!shortcutPattern.test(indexSource)) {
					gaps.push(
						`Command '${cmd}' expects shortcut '${expectedShortcut}' but it is not registered in opencodeConfig.command`,
					);
				}
			}

			expect(
				gaps,
				`Shortcut gaps found:\n${gaps.map((g) => `  - ${g}`).join('\n')}`,
			).toHaveLength(0);
		});
	});

	describe('exemption list has not grown stale', () => {
		it('every exempt command still exists in the registry', () => {
			for (const cmd of EXEMPT_FROM_SHORTCUT) {
				expect(
					VALID_COMMANDS.includes(cmd as any),
					`Exempt command '${cmd}' is no longer in VALID_COMMANDS — remove it from EXEMPT_FROM_SHORTCUT or restore the registry entry`,
				).toBe(true);
			}
		});

		it('every exempt command is actually non-deprecated and non-subcommand (justification check)', () => {
			for (const cmd of EXEMPT_FROM_SHORTCUT) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				expect(
					entry,
					`Exempt command '${cmd}' not found in COMMAND_REGISTRY`,
				).toBeDefined();
				expect(
					entry.aliasOf,
					`Exempt command '${cmd}' is an aliasOf — it should have been skipped by the parity check already`,
				).toBeUndefined();
				expect(
					entry.subcommandOf,
					`Exempt command '${cmd}' is a subcommandOf — it should have been skipped by the parity check already`,
				).toBeUndefined();
			}
		});
	});
});

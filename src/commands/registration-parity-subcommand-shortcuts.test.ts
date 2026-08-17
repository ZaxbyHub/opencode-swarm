import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry';
import {
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
} from './tool-policy';

// ── Helpers ──────────────────────────────────────────────────────────
//
// Deliberately duplicated from registration-parity.test.ts: these are trivial,
// dependency-free string helpers, and the repo's test-file-split protocol
// prefers duplicating them over creating a shared test-helper module for three
// one-line functions.

async function getIndexSource(): Promise<string> {
	const indexPath = path.join(import.meta.dir, '../index.ts');
	return fs.readFile(indexPath, 'utf-8');
}

function expectedShortcutFor(cmd: string): string {
	return `swarm-${cmd.replace(/ /g, '-')}`;
}

function hasShortcutKey(indexSource: string, cmd: string): boolean {
	const shortcut = expectedShortcutFor(cmd);
	const escaped = shortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const pattern = new RegExp(`['"]${escaped}['"]\\s*:`);
	return pattern.test(indexSource);
}

describe('Command registration parity — subcommand shortcuts', () => {
	// ── FIX 2: subcommand TUI shortcut verification (bidirectional allowlist) ──
	//
	// The description string is STANDALONE-ONLY by design — subcommands are filtered
	// out. We do NOT check subcommands against the description.
	// Not all subcommands have individual TUI shortcuts; some are accessed via their
	// parent (e.g. `memory pending`, `memory recall-log`, `memory stale`).
	// This test uses an explicit bidirectional allowlist: every entry must have a
	// shortcut in index.ts, and every subcommand shortcut in index.ts must be listed
	// here. If either direction drifts, the test fails.

	/**
	 * Subcommands that have individual TUI shortcut keys in src/index.ts.
	 * Other subcommands (memory pending, memory recall-log, memory stale,
	 * knowledge migrate, knowledge quarantine, knowledge restore,
	 * knowledge unactionable, knowledge retry-hardening, etc.) are accessed via
	 * their parent command and intentionally lack shortcuts.
	 *
	 * Bidirectional invariant:
	 *   - Forward: every entry below must have a `swarm-<cmd>` key in index.ts.
	 *   - Reverse: every subcommand shortcut in index.ts must be listed here.
	 *
	 * Derived by scanning src/index.ts for `swarm-*` keys whose dash-converted
	 * form maps back to a `subcommandOf` registry entry.
	 */
	const SUBCOMMANDS_WITH_SHORTCUTS = new Set([
		'config doctor',
		'doctor tools',
		'evidence summary',
		'memory status',
		'memory export',
		'memory import',
		'memory migrate',
		'sdd status',
		'sdd validate',
		'sdd project',
	]);

	describe('subcommand TUI shortcuts are complete and correctly keyed (bidirectional)', () => {
		it('subcommand shortcuts are complete and no phantom shortcuts exist', async () => {
			const indexSource = await getIndexSource();

			// Forward check: every subcommand in the allowlist has a correctly
			// dash-converted shortcut key in src/index.ts.
			const missing: string[] = [];
			for (const cmd of SUBCOMMANDS_WITH_SHORTCUTS) {
				const expectedKey = expectedShortcutFor(cmd);
				if (!hasShortcutKey(indexSource, cmd)) {
					missing.push(
						`${cmd} (expected key '${expectedKey}' missing from src/index.ts)`,
					);
				}
			}
			expect(
				missing,
				`Subcommands missing TUI shortcuts in src/index.ts:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
			).toHaveLength(0);

			// Reverse check: every subcommand shortcut key found in index.ts is in
			// the allowlist. (Catches phantom shortcuts for subcommands not listed.)
			const allSubcommands = VALID_COMMANDS.filter((cmd) => {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				return !!entry.subcommandOf && !entry.aliasOf;
			});
			const phantom: string[] = [];
			for (const cmd of allSubcommands) {
				const expectedKey = expectedShortcutFor(cmd);
				if (
					hasShortcutKey(indexSource, cmd) &&
					!SUBCOMMANDS_WITH_SHORTCUTS.has(cmd)
				) {
					phantom.push(
						`${cmd} (has shortcut '${expectedKey}' but is not in SUBCOMMANDS_WITH_SHORTCUTS)`,
					);
				}
			}
			expect(
				phantom,
				`Phantom subcommand shortcuts not in SUBCOMMANDS_WITH_SHORTCUTS:\n${phantom.map((p) => `  - ${p}`).join('\n')}`,
			).toHaveLength(0);
		});
	});

	// ── FIX 3: subcommand toolPolicy validation ───────────────────────

	describe('subcommand toolPolicy validation', () => {
		it('every subcommand with a toolPolicy has a valid value', () => {
			const invalid: string[] = [];
			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (!entry.subcommandOf) continue;
				if (entry.toolPolicy === undefined) continue;
				if (
					!['agent', 'human-only', 'restricted', 'none'].includes(
						entry.toolPolicy,
					)
				) {
					invalid.push(`${cmd}: toolPolicy='${entry.toolPolicy}'`);
				}
			}
			expect(
				invalid,
				`Subcommands with invalid toolPolicy values:\n${invalid.map((i) => `  - ${i}`).join('\n')}`,
			).toHaveLength(0);
		});

		it('subcommands in the allowlist/human-only have matching toolPolicy', () => {
			const mismatches: string[] = [];
			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (!entry.subcommandOf) continue;
				if (entry.toolPolicy === undefined) continue;
				const inAllowlist = SWARM_COMMAND_TOOL_ALLOWLIST.has(cmd);
				const inHumanOnly = HUMAN_ONLY_SWARM_COMMANDS.has(cmd);
				if (!inAllowlist && !inHumanOnly) continue;
				if (inAllowlist && entry.toolPolicy !== 'agent') {
					mismatches.push(
						`${cmd}: in allowlist but toolPolicy='${entry.toolPolicy}'`,
					);
				}
				if (
					inHumanOnly &&
					entry.toolPolicy !== 'agent' &&
					entry.toolPolicy !== 'human-only'
				) {
					mismatches.push(
						`${cmd}: in human-only but toolPolicy='${entry.toolPolicy}'`,
					);
				}
			}
			expect(
				mismatches,
				`Subcommands with toolPolicy mismatching their classification:\n${mismatches.map((m) => `  - ${m}`).join('\n')}`,
			).toHaveLength(0);
		});
	});
});

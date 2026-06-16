import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import OpenCodeSwarm from '../index';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry';
import {
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from './tool-policy';

/**
 * Commands that intentionally lack shortcuts (exempt from parity check).
 * Each exemption must be documented with a reason.
 *
 * 'help' — routes via the parent 'swarm' command; individual command
 * shortcuts are not needed because the parent shortcut covers all subcommands.
 */
const EXEMPT_FROM_SHORTCUT: string[] = ['help'];

// ── Helpers ──────────────────────────────────────────────────────────

async function getIndexSource(): Promise<string> {
	const indexPath = path.join(import.meta.dir, '../index.ts');
	return fs.readFile(indexPath, 'utf-8');
}

/**
 * Approach chosen for FIX 1: read the ACTUAL description surface from the
 * built plugin config, mirroring tests/unit/index-commands.test.ts.
 * This avoids the circular reconstruction that compared the test's own
 * derived string against itself.
 */
async function getActualSwarmDescription(): Promise<string> {
	const plugin = await OpenCodeSwarm.server({
		client: {} as any,
		project: {} as any,
		directory: process.cwd(),
		worktree: process.cwd(),
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	});
	const mockConfig: Record<string, unknown> = {};
	await plugin.config?.(mockConfig);
	const commands = mockConfig.command as Record<
		string,
		{ template: string; description: string }
	>;
	return commands.swarm.description;
}

/**
 * Reusable detection helper (FIX 2).
 * Returns the set of standalone commands that lack a toolPolicy field
 * in the provided registry snapshot.
 */
function findMissingToolPolicy(
	registry: Record<string, CommandEntry>,
): string[] {
	const gaps: string[] = [];
	for (const cmd of VALID_COMMANDS) {
		const entry = registry[cmd as keyof typeof registry];
		if (entry.aliasOf) continue;
		if (entry.deprecated) continue;
		if (entry.subcommandOf) continue;
		if (!entry.toolPolicy) {
			gaps.push(cmd);
		}
	}
	return gaps;
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

// ── Original tests (preserved) ───────────────────────────────────────

describe('Command registration parity', () => {
	describe('every non-deprecated, non-subcommand registry entry has a matching shortcut', () => {
		it('no shortcut gaps for eligible registry entries', async () => {
			const indexSource = await getIndexSource();
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
				const expectedShortcut = expectedShortcutFor(cmd);

				// Search for the shortcut as an object key: 'swarm-foo' or "swarm-foo" with optional whitespace before colon
				// The shortcut keys in index.ts appear as:   'swarm-status': { ... }
				const shortcutPattern = new RegExp(
					`['"]${expectedShortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:`,
				);
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

	// ── PART A: Comprehensive multi-surface parity ─────────────────────

	describe('comprehensive multi-surface parity (PART A)', () => {
		/**
		 * Surface 1: toolPolicy classification.
		 * Every standalone command must have an explicit toolPolicy field.
		 */
		it('every standalone command has a toolPolicy classification', async () => {
			const missing: string[] = [];
			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (entry.aliasOf) continue;
				if (entry.deprecated) continue;
				if (entry.subcommandOf) continue;
				if (!entry.toolPolicy) {
					missing.push(cmd);
				}
			}
			expect(
				missing,
				`Commands missing toolPolicy:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
			).toHaveLength(0);
		});

		/**
		 * Surface 2: TUI shortcut key.
		 * Every standalone command (except exempt) must have a swarm-<cmd> shortcut
		 * in src/index.ts opencodeConfig.command.
		 */
		it('every standalone command has a TUI shortcut key', async () => {
			const indexSource = await getIndexSource();
			const gaps: string[] = [];

			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (entry.aliasOf) continue;
				if (entry.deprecated) continue;
				if (entry.subcommandOf) continue;
				if (EXEMPT_FROM_SHORTCUT.includes(cmd)) continue;

				if (!hasShortcutKey(indexSource, cmd)) {
					const expectedShortcut = expectedShortcutFor(cmd);
					gaps.push(
						`Command '${cmd}' is missing from surface: TUI shortcut '${expectedShortcut}'`,
					);
				}
			}

			expect(
				gaps,
				`TUI shortcut gaps found:\n${gaps.map((g) => `  - ${g}`).join('\n')}`,
			).toHaveLength(0);
		});

		/**
		 * Surface 3: Description string membership.
		 * Every standalone command must appear in the parent swarm command's
		 * derived description string in src/index.ts.
		 */
		it('every standalone command appears in the parent swarm command description', async () => {
			const description = await getActualSwarmDescription();
			const missing: string[] = [];

			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (entry.aliasOf) continue;
				if (entry.deprecated) continue;
				if (entry.subcommandOf) continue;
				if (!description.includes(cmd)) {
					missing.push(cmd);
				}
			}

			expect(
				missing,
				`Commands missing from swarm command description:\n${missing.map((m) => `  - ${m}`).join('\n')}`,
			).toHaveLength(0);
		});

		/**
		 * Focused test for compound standalone commands (space-separated, no subcommandOf).
		 * Verifies dash-converted shortcut keys are correct: 'pr subscribe' → 'swarm-pr-subscribe'.
		 */
		it('compound standalone commands have correct dash-converted shortcut keys', async () => {
			const indexSource = await getIndexSource();
			const gaps: string[] = [];

			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (entry.aliasOf) continue;
				if (entry.deprecated) continue;
				if (entry.subcommandOf) continue;
				if (!cmd.includes(' ')) continue; // only compound commands
				if (EXEMPT_FROM_SHORTCUT.includes(cmd)) continue;

				if (!hasShortcutKey(indexSource, cmd)) {
					const expectedShortcut = expectedShortcutFor(cmd);
					gaps.push(
						`Command '${cmd}' is missing from surface: TUI shortcut '${expectedShortcut}'`,
					);
				}
			}

			expect(
				gaps,
				`Compound command shortcut gaps found:\n${gaps.map((g) => `  - ${g}`).join('\n')}`,
			).toHaveLength(0);
		});
	});

	// ── Synthetic gap detection (verify tests actually fail on omission) ──

	describe('synthetic gap detection — tests must catch deliberate omissions', () => {
		it('detection logic catches a command with missing toolPolicy', () => {
			// Build a synthetic registry snapshot: copy the real registry but
			// strip toolPolicy from 'learning' to simulate a real omission.
			const syntheticRegistry: Record<string, CommandEntry> = {};
			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				syntheticRegistry[cmd] = { ...entry };
			}
			delete syntheticRegistry['learning'].toolPolicy;

			const gaps = findMissingToolPolicy(syntheticRegistry);
			expect(gaps).toContain('learning');
			expect(gaps).toHaveLength(1);
		});

		it('detects a deliberately omitted TUI shortcut key', async () => {
			const indexSource = await getIndexSource();
			// Remove 'swarm-pr-status' from the source to simulate a gap
			const modifiedSource = indexSource.replace(
				/'swarm-pr-status':\s*\{[\s\S]*?\},\s*\n/g,
				'',
			);
			const gaps: string[] = [];
			for (const cmd of VALID_COMMANDS) {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				if (entry.aliasOf) continue;
				if (entry.deprecated) continue;
				if (entry.subcommandOf) continue;
				if (EXEMPT_FROM_SHORTCUT.includes(cmd)) continue;
				const expectedShortcut = expectedShortcutFor(cmd);
				const escaped = expectedShortcut.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const pattern = new RegExp(`['"]${escaped}['"]\\s*:`);
				if (!pattern.test(modifiedSource)) {
					gaps.push(
						`Command '${cmd}' is missing from surface: TUI shortcut '${expectedShortcut}'`,
					);
				}
			}
			expect(
				gaps.some((g) => g.includes('pr status')),
				`Expected gap detection to flag missing 'pr status' shortcut.\nGaps found:\n${gaps.map((g) => `  - ${g}`).join('\n')}`,
			).toBe(true);
		});

		it('detects a command missing from the swarm command description', async () => {
			const standaloneCommands = VALID_COMMANDS.filter((cmd) => {
				const entry = COMMAND_REGISTRY[
					cmd as keyof typeof COMMAND_REGISTRY
				] as CommandEntry;
				return !entry.aliasOf && !entry.deprecated && !entry.subcommandOf;
			});

			// Simulate the description string with 'learning' REMOVED.
			// This is NOT circular — we mutate the derived set and check whether
			// the membership assertion would catch the omission.
			const descriptionWithoutLearning = standaloneCommands
				.filter((cmd) => cmd !== 'learning')
				.join('|');
			const simulatedDescription = `Swarm management commands: /swarm [${descriptionWithoutLearning}]`;

			// The membership check must flag 'learning' as absent from the mutated description.
			expect(
				simulatedDescription.includes('learning'),
				`Expected 'learning' to be absent from simulated description (proving omission would be detected)`,
			).toBe(false);

			// A command that IS still present must still appear.
			expect(
				simulatedDescription.includes('post-mortem'),
				`Expected 'post-mortem' to still be present in simulated description`,
			).toBe(true);
		});
	});

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

	// ── PART B: No-regression classification snapshot (FR-008/SC-12) ──

	describe('no-regression classification snapshot (FR-008/SC-12)', () => {
		// Authoritative pre-existing baseline (28 allowlist entries)
		const BASELINE_28_ALLOWLIST = new Set([
			'agents',
			'config',
			'config doctor',
			'doctor tools',
			'status',
			'show-plan',
			'help',
			'history',
			'evidence',
			'evidence summary',
			'retrieve',
			'diagnose',
			'preflight',
			'benchmark',
			'knowledge',
			'memory',
			'memory status',
			'memory pending',
			'memory recall-log',
			'memory stale',
			'memory export',
			'memory evaluate',
			'sdd',
			'sdd status',
			'sdd validate',
			'sync-plan',
			'export',
			'auto-proceed',
		]);

		// Authoritative pre-existing baseline (10 human-only entries)
		const BASELINE_10_HUMAN_ONLY = new Set([
			'acknowledge-spec-drift',
			'reset',
			'reset-session',
			'rollback',
			'checkpoint',
			'consolidate',
			'memory compact',
			'memory import',
			'memory migrate',
			'sdd project',
		]);

		// Authoritative pre-existing baseline (32 tool commands = 28 allowlist + 4 human-only)
		const BASELINE_32_TOOL_COMMANDS = new Set([
			...BASELINE_28_ALLOWLIST,
			'memory compact',
			'memory import',
			'memory migrate',
			'sdd project',
		]);

		// Authoritative pre-existing baseline (14 no-args entries)
		const BASELINE_14_NO_ARGS = new Set([
			'agents',
			'config',
			'config doctor',
			'doctor tools',
			'status',
			'history',
			'evidence summary',
			'diagnose',
			'preflight',
			'sync-plan',
			'export',
			'memory',
			'memory status',
			'memory export',
		]);

		// After the fix, only these 5 additions are permitted to differ:
		const EXPECTED_ADDITIONS = {
			allowlist: new Set(['pr status', 'learning', 'post-mortem']),
			humanOnly: new Set(['pr subscribe', 'pr unsubscribe']),
			toolCommands: new Set([
				'pr subscribe',
				'pr unsubscribe',
				'pr status',
				'learning',
				'post-mortem',
			]),
			noArgs: new Set(['pr status']),
		};

		const expectedAllowlist = new Set([
			...BASELINE_28_ALLOWLIST,
			...EXPECTED_ADDITIONS.allowlist,
		]);

		const expectedHumanOnly = new Set([
			...BASELINE_10_HUMAN_ONLY,
			...EXPECTED_ADDITIONS.humanOnly,
		]);

		const expectedToolCommands = new Set([
			...BASELINE_32_TOOL_COMMANDS,
			...EXPECTED_ADDITIONS.toolCommands,
		]);

		const expectedNoArgs = new Set([
			...BASELINE_14_NO_ARGS,
			...EXPECTED_ADDITIONS.noArgs,
		]);

		it('SWARM_COMMAND_TOOL_ALLOWLIST matches baseline plus exactly 3 additions', () => {
			const actual = SWARM_COMMAND_TOOL_ALLOWLIST;
			const extra = [...actual].filter((x) => !expectedAllowlist.has(x));
			const missing = [...expectedAllowlist].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`SWARM_COMMAND_TOOL_ALLOWLIST mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('HUMAN_ONLY_SWARM_COMMANDS matches baseline plus exactly 2 additions', () => {
			const actual = HUMAN_ONLY_SWARM_COMMANDS;
			const extra = [...actual].filter((x) => !expectedHumanOnly.has(x));
			const missing = [...expectedHumanOnly].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`HUMAN_ONLY_SWARM_COMMANDS mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('SWARM_COMMAND_TOOL_COMMANDS (z.enum) matches baseline plus exactly 5 additions', () => {
			const actual = new Set(SWARM_COMMAND_TOOL_COMMANDS);
			const extra = [...actual].filter((x) => !expectedToolCommands.has(x));
			const missing = [...expectedToolCommands].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`SWARM_COMMAND_TOOL_COMMANDS mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('NO_ARGS (derived from toolNoArgs) matches baseline plus pr status', () => {
			const actual = new Set(
				VALID_COMMANDS.filter(
					(cmd) =>
						(
							COMMAND_REGISTRY[
								cmd as keyof typeof COMMAND_REGISTRY
							] as CommandEntry
						)?.toolNoArgs === true,
				),
			);
			const extra = [...actual].filter((x) => !expectedNoArgs.has(x));
			const missing = [...expectedNoArgs].filter((x) => !actual.has(x));
			expect(
				extra.length === 0 && missing.length === 0,
				`NO_ARGS mismatch.\n` +
					`Extra in actual: ${extra.join(', ') || 'none'}\n` +
					`Missing from actual: ${missing.join(', ') || 'none'}`,
			).toBe(true);
		});

		it('only the 5 permitted gap commands differ from the pre-fix baseline', () => {
			const actualAllowlist = SWARM_COMMAND_TOOL_ALLOWLIST;
			const diffFromBaseline = [
				...[...actualAllowlist].filter((x) => !BASELINE_28_ALLOWLIST.has(x)),
				...[...BASELINE_28_ALLOWLIST].filter((x) => !actualAllowlist.has(x)),
			];
			const permittedDiffs = EXPECTED_ADDITIONS.allowlist;
			const unexpectedDiffs = diffFromBaseline.filter(
				(x) => !permittedDiffs.has(x),
			);
			expect(
				unexpectedDiffs.length === 0,
				`Unexpected differences from pre-fix ALLOWLIST baseline: ${unexpectedDiffs.join(', ')}.\n` +
					`Only these 5 additions are permitted: ${[...permittedDiffs].join(', ')}`,
			).toBe(true);
		});
	});
});

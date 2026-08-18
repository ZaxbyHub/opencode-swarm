import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createIsolatedTestEnv } from '../../tests/helpers/isolated-test-env.js';
import { createSafeTestDir } from '../../tests/helpers/safe-test-dir.js';
import {
	captureFileBytes,
	expectFileBytesUnchanged,
	runWithCleanup,
} from '../../tests/helpers/test-isolation.js';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../index';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry';

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
const trackedConfigPath = path.join(
	import.meta.dir,
	'../../.opencode/opencode-swarm.json',
);
let trackedProjectConfigBefore: Buffer | null = null;
let restoreIndexInternals: () => void = () => {};

beforeAll(() => {
	// `OpenCodeSwarm.server()` queues its post-resolution work on an unref'd
	// `setTimeout(0)`, so those tasks fire AFTER this file's synchronous
	// cleanup has already removed the temp dir — and then recreate it, leaving
	// a permanent orphan under /tmp (PR #2173 F-006). Dropping the queue is
	// safe here because these tests only assert the command-registration
	// surface, which `plugin.config()` builds from the static COMMAND_REGISTRY;
	// nothing they observe comes from the deferred tasks.
	restoreIndexInternals = overrideIndexInternalsForTest({
		schedulePostResolutionTasks: () => {},
	});
	trackedProjectConfigBefore = captureFileBytes(trackedConfigPath);
});

afterAll(() => {
	// Restore FIRST so the seam is reset even if the byte assertion throws.
	restoreIndexInternals();
	restoreIndexInternals = () => {};
	expectFileBytesUnchanged(trackedConfigPath, trackedProjectConfigBefore);
});

async function getActualSwarmDescription(): Promise<string> {
	let safeDir: ReturnType<typeof createSafeTestDir> | undefined;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	return runWithCleanup(
		async () => {
			safeDir = createSafeTestDir();
			isolatedEnv = createIsolatedTestEnv();
			const plugin = await OpenCodeSwarm.server({
				client: {} as any,
				project: {} as any,
				directory: safeDir.dir,
				worktree: safeDir.dir,
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
		},
		// Read the `let`s lazily so a throw from createIsolatedTestEnv() still
		// tears down the already-created safeDir.
		() => isolatedEnv?.cleanup(),
		() => safeDir?.cleanup(),
	);
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
});

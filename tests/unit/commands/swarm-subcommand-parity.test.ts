import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
} from '../../../src/commands/registry.js';

// Absolute path to the skill file (project root is the workspace root)
const SKILL_PATH = path.resolve(
	process.cwd(),
	'.claude',
	'skills',
	'swarm',
	'SKILL.md',
);

/**
 * Known space-separated command variants that the skill documents explicitly
 * alongside their hyphenated canonical forms (e.g., "deep dive" alongside
 * "deep-dive"). These are registered in COMMAND_REGISTRY as deprecated aliases,
 * but the skill documents them as explicitly maintained entries (not deprecated
 * in the skill's own words).
 *
 * This map is used in the coverage check: the hyphenated (normalized) form is
 * added to the expected set so it can be matched against skillNormalizedSet.
 */
const SKILL_DOCUMENTED_SPACE_VARIANTS: Record<string, string> = {
	'deep dive': 'deep-dive',
	'deep research': 'deep-research',
	'codebase review': 'codebase-review',
	'design docs': 'design-docs',
};

/**
 * Commands that exist in COMMAND_REGISTRY but are intentionally excluded from
 * the skill's "known plugin subcommands" list. These are internal evaluation
 * and diagnostic commands (gate-audit, gate-stats) that are not surfaced as
 * user-facing slash commands in the skill prose. They have `toolPolicy:
 * 'agent'` but so do many user-facing commands, so toolPolicy alone cannot
 * be used as the exclusion criterion.
 *
 * SC-013 exception: these commands are non-deprecated but intentionally
 * undocumented because they are evaluation/diagnostic infrastructure, not
 * workflow commands a user would invoke.
 *
 * If a new command is added that should also be excluded, add it here with
 * a justification comment. If a command is removed from this set, the test
 * will correctly fail, signaling the skill needs updating.
 */
const REGISTRY_INTENTIONALLY_UNDOCUMENTED: Set<string> = new Set([
	'gate-audit', // Evaluation gate matrix — internal diagnostic
	'gate-stats', // Offline gate statistics — internal diagnostic
]);

describe('swarm-subcommand-parity', () => {
	// -------------------------------------------------------------------------
	// Helper: derive the expected set from COMMAND_REGISTRY
	// -------------------------------------------------------------------------

	/**
	 * Returns the set of non-deprecated command keys from COMMAND_REGISTRY,
	 * plus any space-separated variants that the skill explicitly documents
	 * (even if deprecated in the registry).
	 *
	 * Commands with `deprecated: true` are normally excluded because they are
	 * aliases that route to canonical commands — the skill documents the
	 * canonical forms directly. However, the skill explicitly maintains some
	 * space-separated aliases (e.g., "deep dive") alongside their hyphenated
	 * canonical counterparts ("deep-dive"). These are included here so the
	 * coverage check is accurate.
	 */
	function getExpectedCommands(): Set<string> {
		const result = new Set<string>();

		// Add all non-deprecated registry commands, excluding intentionally
		// undocumented ones and known space-variant aliases (handled below
		// via SKILL_DOCUMENTED_SPACE_VARIANTS as their canonical hyphenated forms).
		// All other multi-word commands (e.g., "config doctor", "evidence summary",
		// "memory status") are included directly as canonical commands.
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			const cmdEntry = entry as CommandEntry;
			if (
				!cmdEntry.deprecated &&
				!REGISTRY_INTENTIONALLY_UNDOCUMENTED.has(name) &&
				!(name in SKILL_DOCUMENTED_SPACE_VARIANTS)
			) {
				result.add(name);
			}
		}

		// Add skill-documented deprecated space-separated variants (as normalized
		// hyphenated form) so they match against skillNormalizedSet.
		for (const [, normalized] of Object.entries(
			SKILL_DOCUMENTED_SPACE_VARIANTS,
		)) {
			result.add(normalized);
		}

		return result;
	}

	// -------------------------------------------------------------------------
	// Helper: parse documented commands from the skill file
	// -------------------------------------------------------------------------

	/**
	 * Extracts every `/swarm <command>` command reference from the skill file
	 * and returns the raw command name (everything after `/swarm `).
	 *
	 * Matches markdown list items of the form:
	 *   - `/swarm status` — description
	 *   - `/swarm evidence-summary` — deprecated alias for ...
	 *   - `/swarm evidence summary` — description
	 *   - `/swarm deep-dive` / `/swarm deep dive` — two commands on one line;
	 *     both are extracted by splitting on ` / `
	 *
	 * The regex anchors to the `- `/swarm ` prefix (markdown list item) to avoid
	 * false matches from prose mentions or table cells.
	 */
	function extractSkillCommands(skillContent: string): string[] {
		const results: string[] = [];

		// Match markdown list items with `/swarm <command>` in backticks.
		// The capturing group stops at the first backtick (closing code fence).
		const regex = /- `\/swarm\s+([^`]+)`/g;

		for (const match of skillContent.matchAll(regex)) {
			const raw = match[1]; // e.g. "deep-dive` / `/swarm deep dive`"

			// Handle lines with multiple commands separated by " / "
			// e.g. "deep-dive` / `/swarm deep dive`" → ["deep-dive", "deep dive"]
			const parts = raw.split(/`\s*\/\s*`/);

			for (const part of parts) {
				// Strip any trailing backtick from the part
				const cmd = part.replace(/`+$/, '').trim();
				if (cmd.length > 0) {
					results.push(cmd);
				}
			}
		}

		return results;
	}

	/**
	 * Returns command names explicitly marked as deprecated aliases in the
	 * skill prose. These are skipped when comparing because the skill may list
	 * a deprecated alias alongside (or instead of) its canonical form.
	 *
	 * Detects patterns like:
	 *   - "`<cmd>` — deprecated alias for `/swarm <canonical>`"
	 *   - "`<cmd>` is a deprecated alias"
	 */
	function extractSkillDeprecatedAliases(skillContent: string): Set<string> {
		const deprecated = new Set<string>();

		// Match: "`<cmd>` — deprecated alias for `/swarm <canonical>`"
		for (const match of skillContent.matchAll(
			/`\/swarm\s+([^\s`]+)`\s*—?\s*deprecated alias for `/gi,
		)) {
			deprecated.add(match[1]);
		}

		// Match: "`<cmd>` is a deprecated alias"
		for (const match of skillContent.matchAll(
			/`\/swarm\s+([^\s`]+)`(?:\s+is)?\s*(?:\s+is)?\s*deprecated alias/gi,
		)) {
			deprecated.add(match[1]);
		}

		// Match: "(deprecated alias)" inline annotations
		for (const match of skillContent.matchAll(
			/\/swarm\s+([^\s`]+)\s*\([^)]*deprecated alias[^)]*\)/gi,
		)) {
			deprecated.add(match[1]);
		}

		return deprecated;
	}

	// -------------------------------------------------------------------------
	// Helper: normalize a skill command name to its registry-equivalent form
	// -------------------------------------------------------------------------

	/**
	 * Normalizes a skill command name to the format used in COMMAND_REGISTRY.
	 *
	 * Handles:
	 * 1. Known space-separated variants (e.g., "deep dive" → "deep-dive")
	 * 2. Direct registry key matches
	 * 3. Deprecated aliases from the skill (returned as-is for separate handling)
	 *
	 * Returns the registry key if it exists or can be mapped, otherwise returns
	 * the input unchanged so the stale-entry assertion can report it clearly.
	 */
	function toRegistryKey(
		cmd: string,
		skillDeprecatedAliases: Set<string>,
	): string {
		// If explicitly marked deprecated in skill prose, skip it
		if (skillDeprecatedAliases.has(cmd)) {
			return cmd;
		}

		// Direct match
		if (Object.hasOwn(COMMAND_REGISTRY, cmd)) {
			return cmd;
		}

		// Known space-separated variant
		if (Object.hasOwn(SKILL_DOCUMENTED_SPACE_VARIANTS, cmd)) {
			const normalized = SKILL_DOCUMENTED_SPACE_VARIANTS[cmd]!;
			if (Object.hasOwn(COMMAND_REGISTRY, normalized)) {
				return normalized;
			}
		}

		// Not found — return as-is so the stale-entry test can report it
		return cmd;
	}

	/**
	 * Returns true if the given text looks like a real command name rather
	 * than a task description captured from the Examples section.
	 *
	 * The skill's Examples section uses the same `- `/swarm <text>` —` format
	 * as the command list, but with full task descriptions as the "command".
	 * Examples are long, contain mixed case, and read like natural language.
	 */
	function looksLikeRealCommand(text: string): boolean {
		// Commands are all-lowercase and reasonably short
		if (text.length > 40) return false;
		if (/[A-Z]/.test(text)) return false;
		return true;
	}

	// -------------------------------------------------------------------------
	// Test data extraction
	// -------------------------------------------------------------------------

	const skillContent = (() => {
		try {
			return fs.readFileSync(SKILL_PATH, 'utf-8');
		} catch {
			// Return empty string so tests fail with a clear message
			return '';
		}
	})();

	const expectedCommands = getExpectedCommands();
	const skillRawCommands = extractSkillCommands(skillContent);
	const skillDeprecatedAliases = extractSkillDeprecatedAliases(skillContent);

	// Map each skill command to its registry-equivalent key
	const skillToRegistryKey = skillRawCommands.map((cmd) =>
		toRegistryKey(cmd, skillDeprecatedAliases),
	);

	// Build a set of normalized skill commands that exist in COMMAND_REGISTRY
	const skillNormalizedSet = new Set(
		skillToRegistryKey.filter((key) => Object.hasOwn(COMMAND_REGISTRY, key)),
	);

	// -------------------------------------------------------------------------
	// Assertion 1: every expected command is documented in the skill
	// -------------------------------------------------------------------------
	test('COMMAND_REGISTRY coverage — every expected command is documented in the skill', () => {
		const missingFromSkill: string[] = [];

		for (const cmd of [...expectedCommands].sort()) {
			if (!skillNormalizedSet.has(cmd)) {
				missingFromSkill.push(cmd);
			}
		}

		expect(missingFromSkill, () =>
			[
				`The following ${missingFromSkill.length} expected commands are missing from .claude/skills/swarm/SKILL.md:`,
				...missingFromSkill.map((c) => `  - ${c}`),
				'',
				'Add them to the appropriate section of the skill file.',
			].join('\n'),
		).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Assertion 2: every documented skill command exists in COMMAND_REGISTRY
	// -------------------------------------------------------------------------
	test('skill documentation fidelity — every documented skill command exists in COMMAND_REGISTRY', () => {
		const notInRegistry: string[] = [];

		for (const cmd of skillRawCommands) {
			const key = toRegistryKey(cmd, skillDeprecatedAliases);
			if (!Object.hasOwn(COMMAND_REGISTRY, key)) {
				// Filter out false positives from the Examples section
				// (lines like "/swarm implement OAuth login..." — task descriptions,
				// not actual commands)
				if (!looksLikeRealCommand(cmd)) {
					continue;
				}
				notInRegistry.push(cmd);
			}
		}

		// Deduplicate
		const unique = [...new Set(notInRegistry)];

		expect(unique, () =>
			[
				`The following ${unique.length} documented skill commands have no corresponding entry in COMMAND_REGISTRY:`,
				...unique.map((c) => `  - ${c}`),
				'',
				'Either add the command to COMMAND_REGISTRY, or remove the stale entry from the skill.',
			].join('\n'),
		).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Metadata assertions
	// -------------------------------------------------------------------------

	test('skill file exists and is non-empty', () => {
		expect(
			skillContent.length,
			'SKILL.md not found or is empty',
		).toBeGreaterThan(0);
	});

	test('COMMAND_REGISTRY is non-empty', () => {
		expect(
			Object.keys(COMMAND_REGISTRY).length,
			'COMMAND_REGISTRY should not be empty',
		).toBeGreaterThan(0);
	});

	test('expected command set is non-empty', () => {
		expect(
			expectedCommands.size,
			'expected commands should not be empty',
		).toBeGreaterThan(0);
	});

	test('skill extracts a non-empty command list', () => {
		expect(
			skillRawCommands.length,
			'No /swarm commands found in skill',
		).toBeGreaterThan(0);
	});

	test('informational: counts and drift summary', () => {
		console.info(
			`[swarm-subcommand-parity] expected commands: ${expectedCommands.size}`,
		);

		// Pin the expected command count to prevent silent shrinkage.
		// If commands are added to or removed from COMMAND_REGISTRY, update this number
		// after verifying the skill's subcommand list is updated to match.
		expect(expectedCommands.size).toBe(89);

		console.info(
			`[swarm-subcommand-parity] skill documented commands (raw): ${skillRawCommands.length}`,
		);
		console.info(
			`[swarm-subcommand-parity] skill normalized commands in registry: ${skillNormalizedSet.size}`,
		);
		console.info(
			`[swarm-subcommand-parity] skill deprecated aliases: ${[...skillDeprecatedAliases].join(', ')}`,
		);

		// Compute and display what's missing and what's stale
		const missing: string[] = [];
		for (const cmd of [...expectedCommands].sort()) {
			if (!skillNormalizedSet.has(cmd)) missing.push(cmd);
		}
		const stale: string[] = [];
		for (const cmd of skillRawCommands) {
			const key = toRegistryKey(cmd, skillDeprecatedAliases);
			if (!Object.hasOwn(COMMAND_REGISTRY, key) && looksLikeRealCommand(cmd)) {
				stale.push(cmd);
			}
		}
		if (missing.length > 0) {
			console.info(
				`[swarm-subcommand-parity] MISSING FROM SKILL: ${missing.join(', ')}`,
			);
		}
		if (stale.length > 0) {
			console.info(
				`[swarm-subcommand-parity] STALE IN SKILL: ${[...new Set(stale)].join(', ')}`,
			);
		}
	});
});
